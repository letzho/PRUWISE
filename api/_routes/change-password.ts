/* =============================================================================
   POST /api/change-password  {  currentPassword, newPassword, signOutEverywhere?  }
   -----------------------------------------------------------------------------
   Ported from php/api/change-password.php.

   Changing a password from inside the account requires the CURRENT one. That is
   the whole point of this endpoint existing separately from the reset flow: a
   logged-in session is not proof of identity if somebody walked away from an
   unlocked laptop.

   The new password must also be different from the old one. Otherwise "change your
   password" can be satisfied without changing anything, which quietly defeats the
   reason somebody was asked to do it.

   =============================================================================
   KEEPING THIS SESSION ALIVE WHILE ENDING THE OTHERS
   =============================================================================

   Bumping session_epoch invalidates every session for the account - including the
   one making this request, which would sign the user out of the page they are
   standing on and make a successful password change look like an error.

   The PHP fixed that by writing the new epoch into $_SESSION. Sessions are rows
   now, so the fix is: delete every session row EXCEPT this one, then move this one
   up to the new epoch. Both by token hash, so "this one" is identified by the
   cookie actually presented rather than by anything guessable.
   ============================================================================= */

import {
    audit, hashPassword, hashToken, recordAttempt, requireLogin,
    verifyPassword, SESSION_COOKIE
} from '../_lib/auth.js';
import { one, q } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { passwordProblem } from '../_lib/validate.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    const current = req.field('currentPassword', '');
    const next = req.field('newPassword', '');

    if (current === '') {
        fail(400, 'Please enter your current password.', 'currentPassword');
    }

    /* The check that matters. Same constant-time comparison as login, and the
       failure is recorded - somebody trying passwords against a session they found
       is exactly the case this catches. */
    if (!await verifyPassword(current, user.password_hash)) {
        await recordAttempt(user.username, req.ip, false);
        await audit(user.id, 'password_change_failed', 'wrong current password', req.ip);

        fail(403, 'That is not your current password.', 'currentPassword');
    }

    const issue = passwordProblem(next);
    if (issue !== null) {
        fail(400, issue, 'newPassword');
    }

    if (await verifyPassword(next, user.password_hash)) {
        fail(400, 'Your new password needs to be different from your current one.',
            'newPassword');
    }

    /* Signing out other devices is the safe default, and the request has to ask for
       it to be skipped. Someone changing their password because they think another
       person has it should not have to know to tick a box.

       Note the comparison: anything other than an explicit false means yes, so an
       absent field is treated as "sign them out". */
    const signOutOthers = req.body.signOutEverywhere !== false;

    const passwordHash = await hashPassword(next);
    const thisToken = req.cookie(SESSION_COOKIE);

    if (signOutOthers) {
        const bumped = await one<{ session_epoch: number }>(
            `UPDATE accounts
                SET password_hash = ?, session_epoch = session_epoch + 1
              WHERE id = ?
          RETURNING session_epoch`,
            [passwordHash, user.id]
        );

        if (thisToken) {
            const thisHash = hashToken(thisToken);

            /* Every other device gone. Order matters only in that this must not
               delete the row it is about to update. */
            await q('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?',
                [user.id, thisHash]);

            /* And this session moved up, so the very next request still matches. */
            await q('UPDATE sessions SET session_epoch = ? WHERE token_hash = ?',
                [bumped ? Number(bumped.session_epoch) : 0, thisHash]);
        }

    } else {
        await q('UPDATE accounts SET password_hash = ? WHERE id = ?',
            [passwordHash, user.id]);
    }

    await q('DELETE FROM login_attempts WHERE username = ? AND succeeded = false',
        [user.username]);

    await audit(user.id, 'password_changed',
        signOutOthers ? 'other sessions ended' : 'this session only', req.ip);

    await sendMail(
        user.email,
        'Your PRUWise password was changed',
        emailLayout(
            'Your password was changed',
            [
                `The password for your PRUWise account (${user.username}) was just ` +
                'changed from inside your account.',
                signOutOthers
                    ? 'Any other devices that were signed in have been signed out.'
                    : 'Other devices that were already signed in are still signed in.'
            ],
            null, null,
            'If this was not you, reset your password immediately and contact client care.'
        )
    );

    return ok({
        message: signOutOthers
            ? 'Password changed. Any other devices have been signed out.'
            : 'Password changed.'
    });
});
