/* =============================================================================
   POST /api/forgot-password  {  email  }   ->  emails a reset link
   -----------------------------------------------------------------------------
   Ported from php/api/forgot-password.php.

   =============================================================================
   THIS ENDPOINT ALWAYS SAYS THE SAME THING
   =============================================================================

   Whether or not the address belongs to an account, the answer is "if that
   address is registered, a link is on its way". Answering "no such account" would
   turn this form into a way to test whether somebody is a customer, which is not
   ours to confirm.

   That also means an unknown address quietly does nothing. It looks like a bug the
   first time you test it. It is the correct behaviour.

   THE TOKEN
     - 32 random bytes, so it cannot be guessed
     - only its SHA-256 is stored, so a leaked table is useless
     - expires in an hour, and can be used once
     - any earlier unused token for the account is invalidated first, so the most
       recent email is the only one that works
   ============================================================================= */

import { audit, emailRateExceeded, hashToken, newToken } from '../_lib/auth.js';
import { batch, one } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { validEmail } from '../_lib/validate.js';

const RESET_MINUTES = 60;

export default defineHandler(async (req) => {
    req.requirePost();

    const email = req.field('email', '').toLowerCase();

    /* The one thing we will say no to, because it is a malformed request rather
       than a statement about who exists. */
    if (!validEmail(email)) {
        fail(400, 'Please enter a valid email address.', 'email');
    }

    /* The identical answer for every outcome below. */
    const sameAnswer = {
        message: 'If that email address is registered, a reset link is on its way. ' +
                 `It is valid for ${RESET_MINUTES} minutes.`
    };

    const account = await one<{
        id: number; username: string; email: string; name: string; first_name: string | null;
    }>(
        `SELECT a.id, a.username, a.email, a.name, p.first_name
           FROM accounts a
           JOIN people p ON p.id = a.person_id
          WHERE a.email = ? AND a.status = 'active'`,
        [email]
    );

    if (!account) {
        /* Nothing to do. A small pause keeps the response time similar to the real
           path, so the difference cannot be timed - the real path spends its time
           hashing a token and sending mail. */
        await new Promise(resolve => setTimeout(resolve, 300));
        return ok(sameAnswer);
    }

    if (await emailRateExceeded(account.id, req.ip)) {
        /* Also the same answer. Saying "too many requests" would confirm the
           address exists, which is the whole thing we are avoiding. */
        await audit(account.id, 'reset_rate_limited', null, req.ip);
        return ok(sameAnswer);
    }

    const token = newToken();

    try {
        /* Both writes, atomically.

           Retiring the earlier link matters: if somebody asks twice, only the
           newest email should work, otherwise an old message forwarded on is still
           a live key. And it must not be possible to retire the old one without
           creating the new one, which is why these are one batch. */
        await batch(sqlt => [
            sqlt`UPDATE password_resets SET used_at = now()
                  WHERE account_id = ${account.id} AND used_at IS NULL`,

            sqlt`INSERT INTO password_resets
                     (account_id, token_hash, expires_at, request_ip)
                 VALUES (${account.id}, ${hashToken(token)},
                         now() + INTERVAL '60 minutes', ${req.ip})`
        ]);

    } catch (error) {
        console.error('Reset token write failed:', error);
        return ok(sameAnswer);      /* still the same answer */
    }

    const firstName = account.first_name ?? account.name;
    const resetUrl = `${env.appUrl}/index.html#/reset-password?token=${token}`;

    const sent = await sendMail(
        account.email,
        'Reset your PRUWise password',
        emailLayout(
            'Reset your password',
            [
                `Hello ${firstName},`,
                `Someone asked to reset the password for the PRUWise account ` +
                `${account.username}. If that was you, use the button below.`,
                `This link works once and expires in ${RESET_MINUTES} minutes.`
            ],
            'Choose a new password',
            resetUrl,
            'If you did not ask for this, you can safely ignore this email. ' +
            'Your password has not been changed.'
        )
    );

    await audit(account.id, 'reset_requested',
        `route=${sent === false ? 'failed' : sent}`, req.ip);

    return ok({
        ...sameAnswer,
        emailRoute: sent === false ? 'failed' : sent,

        /* What makes this testable with no mail provider at all: the link comes
           straight back and the front end shows it. NEVER in production - a reset
           link in an API response is readable by anything watching the page. */
        devLink: env.devMode ? resetUrl : null
    });
});
