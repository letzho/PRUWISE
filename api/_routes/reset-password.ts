/* =============================================================================
   POST /api/reset-password
       { token, check: true }   ->  is this link still good?
       { token, password }      ->  set the new password
   -----------------------------------------------------------------------------
   Ported from php/api/reset-password.php.

   The browser calls it once with check:true when the reset page opens, so an
   expired link says so immediately instead of after somebody has typed a new
   password twice.

   WHAT HAPPENS ON SUCCESS
     1. the password is replaced
     2. the token is marked used, so the link is dead
     3. session_epoch is bumped AND the session rows are deleted, which signs out
        every device

   Step 3 is the one people forget. If the account was taken over, the attacker
   still has a live session, and changing the password alone does not remove it.

   THAT STEP IS STRONGER HERE THAN IT WAS IN PHP. Sessions used to live in files on
   the server and only the epoch could invalidate them - the files themselves sat
   there until PHP got round to collecting them. Sessions are rows now, so they can
   actually be deleted, and the epoch bump is the belt to that braces.
   ============================================================================= */

import { audit, hashPassword, hashToken } from '../_lib/auth.js';
import { batch, one, toIso } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { looksLikeToken, passwordProblem } from '../_lib/validate.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const token = req.field('token', '');

    if (!looksLikeToken(token)) {
        fail(400, 'That reset link is not valid. Please request a new one.', 'token');
    }

    /* Look the token up by its hash. The row is only useful if it is unused AND
       unexpired - both checked in SQL, so there is no window between reading and
       deciding. */
    const reset = await one<{
        id: number;
        account_id: number;
        expires_at: unknown;
        username: string;
        email: string;
        name: string;
        first_name: string | null;
    }>(
        `SELECT r.id, r.account_id, r.expires_at,
                a.username, a.email, a.name, p.first_name
           FROM password_resets r
           JOIN accounts a ON a.id = r.account_id
           JOIN people p   ON p.id = a.person_id
          WHERE r.token_hash = ?
            AND r.used_at IS NULL
            AND r.expires_at > now()`,
        [hashToken(token)]
    );

    if (!reset) {
        fail(410,
            'This reset link has expired or has already been used. Please request a new one.',
            'token');
    }

    const firstName = reset.first_name ?? reset.name;

    /* The "is it still good?" call. Returning the username lets the reset page say
       who it is for, which reassures somebody that they opened the right link. */
    if (req.field('check', false) === true) {
        return ok({
            valid: true,
            username: reset.username,
            name: firstName,
            expiresAt: toIso(reset.expires_at)
        });
    }

    const password = req.field('password', '');

    const issue = passwordProblem(password);
    if (issue !== null) {
        fail(400, issue, 'password');
    }

    const passwordHash = await hashPassword(password);

    try {
        /* All four writes, atomically. Half of this applying would be the worst
           outcome available: a used token with the old password still in place
           locks somebody out of their own account with no way back. */
        await batch(sqlt => [
            sqlt`UPDATE accounts
                    SET password_hash = ${passwordHash},
                        session_epoch = session_epoch + 1
                  WHERE id = ${reset.account_id}`,

            /* Every device signed out. The epoch bump alone would do it, but
               deleting the rows means a stolen cookie stops matching anything at
               all rather than matching a row we then reject. */
            sqlt`DELETE FROM sessions WHERE account_id = ${reset.account_id}`,

            sqlt`UPDATE password_resets SET used_at = now() WHERE id = ${reset.id}`,

            /* A successful reset also clears the failed-login count. Otherwise
               somebody who forgot their password, got locked out, and then reset it
               would still be locked out - a maddening way to end a support call. */
            sqlt`DELETE FROM login_attempts
                  WHERE username = ${reset.username} AND succeeded = false`
        ]);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Password reset failed:', error);

        fail(500, env.devMode
            ? `Could not update the password: ${message}`
            : 'Could not update your password right now. Please try again shortly.');
    }

    await audit(reset.account_id, 'password_reset', null, req.ip);

    /* Tell them it happened. If it was not them, this email is the warning that
       something is wrong - and it is the only chance to give it. */
    await sendMail(
        reset.email,
        'Your PRUWise password was changed',
        emailLayout(
            'Your password was changed',
            [
                `Hello ${firstName},`,
                `The password for your PRUWise account (${reset.username}) was just ` +
                'changed, and you have been signed out on every device.',
                'If this was you, there is nothing more to do.'
            ],
            null, null,
            'If this was NOT you, reset your password immediately and contact client care.'
        )
    );

    /* Deliberately not signed in here. Making them sign in proves the new password
       works, and it is the moment a password manager offers to save it. */
    return ok({
        message: 'Your password has been changed. You can now log in.',
        username: reset.username
    });
});
