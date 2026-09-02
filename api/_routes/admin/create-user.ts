/* =============================================================================
   POST /api/admin/create-user  {  role, name, email, username, title?, phone?  }
   -----------------------------------------------------------------------------
   Ported from php/api/admin/create-user.php.

   THIS is where representative and administrator accounts come from. The public
   /api/register cannot make them at all - it hard-codes 'customer' - so this
   endpoint behind requireAdmin() is the only route.

   =============================================================================
   NO PASSWORD IS SET HERE
   =============================================================================

   The new account is created with an unusable password hash and the person is
   emailed a link to choose their own. So:

     - the admin never knows the new user's password
     - no password is typed into a form, sent over the wire, or read off a screen
     - the account cannot be signed into until the real owner sets it up

   An admin who could set the password could sign in as a representative and act on
   customers' behalf. NOT OFFERING IT IS THE POINT, not an omission.
   ============================================================================= */

import {
    audit, hashPassword, hashToken, newPersonId, newToken, requireAdmin
} from '../../_lib/auth.js';
import { batch, column } from '../../_lib/db.js';
import { env } from '../../_lib/env.js';
import { defineHandler, fail, ok } from '../../_lib/http.js';
import { emailLayout, sendMail } from '../../_lib/mail.js';
import { firstNameOf, validEmail, validUsername } from '../../_lib/validate.js';

export default defineHandler(async (req) => {
    const admin = await requireAdmin(req);
    req.requirePost();

    const role = req.field('role', '');
    const name = req.field('name', '');
    const email = req.field('email', '').toLowerCase();
    const username = req.field('username', '').toLowerCase();
    const phone = req.field('phone', '');

    /* ------------------------------------------------------------ validate */
    if (!['fr', 'admin'].includes(role)) {
        fail(400,
            'Choose either a representative or an administrator. Customers register themselves.',
            'role');
    }
    if (name.length < 2) { fail(400, 'Please enter their full name.', 'name'); }
    if (name.length > 120) { fail(400, 'That name is too long.', 'name'); }
    if (!validEmail(email)) { fail(400, 'Please enter a valid email address.', 'email'); }

    if (!validUsername(username)) {
        fail(400,
            'Usernames are 4 to 40 characters, using lowercase letters, numbers and dots.',
            'username');
    }
    if (await column('SELECT 1 FROM accounts WHERE username = ?', [username])) {
        fail(409, 'That username is already taken.', 'username');
    }
    if (await column('SELECT 1 FROM accounts WHERE email = ?', [email])) {
        fail(409, 'There is already an account with that email address.', 'email');
    }

    if (phone !== '') {
        const digits = phone.replace(/\D/g, '');

        if (digits.length < 7 || digits.length > 15) {
            fail(400, 'Please enter a valid phone number, or leave it blank.', 'phone');
        }
    }

    /* --------------------------------------------------------------------
       Create the person, the account, its preferences and the invitation -
       all or nothing.
       -------------------------------------------------------------------- */
    const personId = await newPersonId(role === 'admin' ? 'adm' : 'fr');
    const firstName = firstNameOf(name);
    const label = role === 'admin' ? 'Administrator' : 'Financial Representative';

    /* A HASH OF A LONG RANDOM STRING NOBODY HAS.

       It is a real bcrypt hash, so verifyPassword() runs normally and simply never
       matches - rather than a marker value that some future code path might treat as
       "no password needed". Failing closed by construction.

       Deliberately NOT the 'NEEDS_SETUP' sentinel that a Google-only account gets.
       That sentinel means "this person signs in another way"; this means "nobody can
       sign in yet". publicAccount() reads the sentinel to decide whether to offer a
       password box, and a colleague who has not accepted their invitation is not a
       Google user. */
    const unusable = await hashPassword(newToken(48));

    /* The invitation is a password reset token. Same mechanism, longer life, because
       a new colleague might not read their email today. */
    const token = newToken();

    try {
        await batch(sqlt => [
            sqlt`INSERT INTO people (id, kind, name, first_name, email, phone, status)
                 VALUES (${personId}, ${role === 'admin' ? 'admin' : 'fr'}, ${name},
                         ${firstName}, ${email}, ${phone === '' ? null : phone}, 'active')`,

            sqlt`INSERT INTO accounts
                     (person_id, role, username, email, password_hash, name, label,
                      note, email_verified)
                 VALUES (${personId}, ${role}, ${username}, ${email}, ${unusable},
                         ${name}, ${label}, ${`Created by ${admin.username}`}, false)`,

            /* These two find the account by username rather than by a returned id.
               Inside one transaction the row is already visible, and username is
               UNIQUE, so this is exact - and it avoids depending on the driver's
               batch result shape. Same approach as /api/register. */
            sqlt`INSERT INTO account_prefs (account_id)
                 SELECT id FROM accounts WHERE username = ${username}`,

            sqlt`INSERT INTO password_resets (account_id, token_hash, expires_at, request_ip)
                 SELECT id, ${hashToken(token)}, now() + INTERVAL '7 days', ${req.ip}
                   FROM accounts WHERE username = ${username}`
        ]);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('duplicate key') || message.includes('23505')) {
            fail(409, 'That username or email was just taken. Please try again.', 'username');
        }

        console.error('create-user failed:', error);

        fail(500, env.devMode
            ? `Could not create the account: ${message}`
            : 'Could not create the account right now. Please try again.');
    }

    const accountId = Number(await column(
        'SELECT id FROM accounts WHERE username = ?', [username]) ?? 0);

    if (!accountId) {
        fail(500, 'The account was created but could not be read back. Please reload.');
    }

    /* ---------------------------------------------------------- invite them */
    const inviteUrl = `${env.appUrl}/index.html#/reset-password?token=${token}`;

    const route = await sendMail(
        email,
        'Your PRUWise account is ready',
        emailLayout(
            `Welcome to PRUWise, ${firstName}`,
            [
                role === 'admin'
                    ? 'An administrator account has been created for you.'
                    : 'A financial representative account has been created for you.',
                `Your username is ${username}. Choose your own password using the button ` +
                'below - nobody else knows it, and nobody else can see it.',
                'This invitation is valid for 7 days.'
            ],
            'Set my password',
            inviteUrl,
            'If you were not expecting this email, please contact your administrator.'
        )
    );

    await audit(admin.id, 'admin_created_user',
        `${role} ${username} route=${route === false ? 'failed' : route}`, req.ip);

    return ok({
        message: route === 'log'
            ? `${name} was created. No mail provider is configured, so the invitation was ` +
              'written to the function log.'
            : `${name} was created and invited by email at ${email}.`,
        accountId,
        personId,
        username,
        emailRoute: route === false ? 'failed' : route,
        devLink: env.devMode ? inviteUrl : null
    });
});
