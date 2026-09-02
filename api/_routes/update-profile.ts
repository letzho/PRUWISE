/* =============================================================================
   POST /api/update-profile  {  name?, phone?, email?, currentPassword?, prefs?  }
   -----------------------------------------------------------------------------
   Ported from php/api/update-profile.php.

   ONLY SEND WHAT CHANGED. Anything absent is left alone, so the settings page can
   save one section without having to resubmit the rest. This is why the code below
   checks req.has(...) rather than reading a value and comparing it to '' - "not
   sent" and "sent as empty" are two different instructions and must not collapse
   into one.

   =============================================================================
   EMAIL IS DIFFERENT FROM THE REST
   =============================================================================

   A name or a phone number is changed immediately. An email address is not, because
   it is the thing a password reset is sent to. Change it on the spot and a typo
   locks the owner out of their own account permanently.

   So instead: we email the NEW address a confirmation link, and the address only
   moves across when that link is used - in /api/confirm-email. Until then the old
   one still works, which is exactly the property you want.

   We also tell the OLD address that a change was requested. If somebody else is in
   the account, that email is the only warning the real owner gets.
   ============================================================================= */

import {
    audit, ensurePrefs, hashToken, newToken, publicAccount,
    recordAttempt, requireLogin, verifyPassword, type User
} from '../_lib/auth.js';
import { column, one, q, type Param } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { firstNameOf, validEmail } from '../_lib/validate.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    /* What we actually did, reported back so the toast can be specific. */
    const changed: string[] = [];

    /* Set only if an email confirmation is on its way. */
    let pending: { email: string; emailRoute: string; devLink: string | null } | null = null;


    /* --------------------------------------------------------------- name */
    if (req.has('name')) {
        const name = req.field('name', '');

        if (name.length < 2) { fail(400, 'Please enter your full name.', 'name'); }
        if (name.length > 120) { fail(400, 'That name is too long.', 'name'); }

        if (name !== user.name) {
            const firstName = firstNameOf(name);

            await q('UPDATE accounts SET name = ? WHERE id = ?', [name, user.id]);
            await q('UPDATE people SET name = ?, first_name = ? WHERE id = ?',
                [name, firstName, user.person_id]);

            changed.push('name');
            await audit(user.id, 'name_changed', null, req.ip);
        }
    }


    /* -------------------------------------------------------------- phone

       Stored as typed rather than reformatted. People recognise their own number
       in their own layout, and a "helpful" reformat that mangles an international
       number is worse than none. We only check it could plausibly be a number. */
    if (req.has('phone')) {
        const phone = req.field('phone', '');

        if (phone !== '') {
            const digits = phone.replace(/\D/g, '');

            if (digits.length < 7 || digits.length > 15) {
                fail(400,
                    'Please enter a valid phone number, including the country code.',
                    'phone');
            }
            if (!/^[0-9+()\s-]{7,32}$/.test(phone)) {
                fail(400, 'A phone number can only contain digits, spaces, and + ( ) -',
                    'phone');
            }
        }

        const currentPhone = user.person_phone ?? '';

        if (phone !== currentPhone) {
            await q('UPDATE people SET phone = ? WHERE id = ?',
                [phone === '' ? null : phone, user.person_id]);

            changed.push('phone');
            await audit(user.id, 'phone_changed', null, req.ip);
        }
    }


    /* -------------------------------------------------- preferences

       No verification needed - these are switches, not identity. */
    const prefsRaw = req.body.prefs;

    if (typeof prefsRaw === 'object' && prefsRaw !== null && !Array.isArray(prefsRaw)) {
        const prefs = prefsRaw as Record<string, unknown>;

        await ensurePrefs(user.id);

        const sets: string[] = [];
        const args: Param[] = [];
        const given = (key: string) =>
            Object.prototype.hasOwnProperty.call(prefs, key);

        if (typeof prefs.theme === 'string'
            && ['light', 'dark', 'system'].includes(prefs.theme)) {
            sets.push('theme = ?'); args.push(prefs.theme);
        }
        if (given('emailNotifications')) {
            sets.push('email_notifications = ?'); args.push(!!prefs.emailNotifications);
        }
        if (given('smsNotifications')) {
            sets.push('sms_notifications = ?'); args.push(!!prefs.smsNotifications);
        }
        if (given('speechEnabled')) {
            sets.push('speech_enabled = ?'); args.push(!!prefs.speechEnabled);
        }
        if (given('speechVoice')) {
            sets.push('speech_voice = ?');
            args.push(prefs.speechVoice ? String(prefs.speechVoice).slice(0, 120) : null);
        }

        if (sets.length > 0) {
            args.push(user.id);

            /* The column list is assembled from the fixed strings above, never from
               anything in the request, and every value is still a bound parameter.
               toPositional() in db.ts numbers the placeholders, so the count cannot
               drift from the argument list without it saying so. */
            await q(`UPDATE account_prefs SET ${sets.join(', ')} WHERE account_id = ?`, args);
            changed.push('preferences');
        }
    }


    /* --------------------------------------------- email: requested, not applied */
    if (req.has('email')) {
        const email = req.field('email', '').toLowerCase();

        if (!validEmail(email)) {
            fail(400, 'Please enter a valid email address.', 'email');
        }

        if (email !== user.email.toLowerCase()) {

            /* Somebody else already has it? Say so plainly; they own that address,
               and there is nothing to hide - the sign-up form says the same. */
            if (await column('SELECT 1 FROM accounts WHERE email = ? AND id <> ?',
                [email, user.id])) {
                fail(409, 'There is already an account using that email address.', 'email');
            }

            /* Changing an email is a security action, so it needs the password.
               Without this, a borrowed laptop is enough to move the account's
               recovery address somewhere else. */
            const confirmPassword = req.field('currentPassword', '');

            if (confirmPassword === '') {
                fail(403,
                    'Please enter your password to change your email address.',
                    'currentPassword');
            }
            if (!await verifyPassword(confirmPassword, user.password_hash)) {
                await recordAttempt(user.username, req.ip, false);
                fail(403, 'That password is not correct.', 'currentPassword');
            }

            const token = newToken();

            /* Only the newest request should work. */
            await q(
                `UPDATE email_change_requests SET used_at = now()
                  WHERE account_id = ? AND used_at IS NULL`,
                [user.id]
            );

            await q(
                `INSERT INTO email_change_requests
                     (account_id, new_email, token_hash, expires_at)
                 VALUES (?, ?, ?, now() + INTERVAL '24 hours')`,
                [user.id, email, hashToken(token)]
            );

            const confirmUrl = `${env.appUrl}/index.html#/confirm-email?token=${token}`;

            const route = await sendMail(
                email,
                'Confirm your new PRUWise email address',
                emailLayout(
                    'Confirm your new email address',
                    [
                        'You asked to use this address for your PRUWise account ' +
                        `(${user.username}).`,
                        'Click below to confirm it. Until you do, your old address stays ' +
                        'in use.',
                        'This link expires in 24 hours.'
                    ],
                    'Confirm this address',
                    confirmUrl,
                    'If you did not ask for this, you can ignore this email.'
                )
            );

            /* And warn the address currently on the account. */
            await sendMail(
                user.email,
                'An email change was requested on your PRUWise account',
                emailLayout(
                    'Someone asked to change your email address',
                    [
                        'A request was made to change the email address on your PRUWise ' +
                        `account (${user.username}) to ${email}.`,
                        'Nothing has changed yet. The new address has to be confirmed ' +
                        'first, and this address stays in use until then.'
                    ],
                    null, null,
                    'If this was not you, change your password now - somebody may have ' +
                    'access to your account.'
                )
            );

            await audit(user.id, 'email_change_requested', `to ${email}`, req.ip);

            pending = {
                email,
                emailRoute: route === false ? 'failed' : route,
                devLink: env.devMode ? confirmUrl : null
            };
        }
    }


    /* -------------------------------------------------------------------------
       Send back the account as it now stands, so the browser can replace its copy
       rather than trying to patch it and drift out of step.
       ------------------------------------------------------------------------- */
    const fresh = await one<User>(
        `SELECT a.*, p.name AS person_name, p.rep_id, p.phone AS person_phone, p.kind
           FROM accounts a
           JOIN people p ON p.id = a.person_id
          WHERE a.id = ?`,
        [user.id]
    );

    if (!fresh) {
        fail(500, 'Your account could not be read back. Please reload.');
    }

    let message = 'Nothing needed changing.';

    if (changed.length > 0 && pending) {
        message = `Saved. Check ${pending.email} to confirm your new email address.`;
    } else if (changed.length > 0) {
        message = `Your ${changed.join(' and ')} has been updated.`;
    } else if (pending) {
        message = `Almost there. Check ${pending.email} to confirm your new email address.`;
    }

    return ok({
        account: await publicAccount(fresh),
        changed,
        pendingEmail: pending,
        message
    });
});
