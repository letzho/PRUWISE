/* =============================================================================
   POST /api/confirm-email  {  token  }
   -----------------------------------------------------------------------------
   Ported from php/api/confirm-email.php.

   Finishes the job started by /api/register (welcome email) or by
   /api/update-profile (email change). Both write a row to email_change_requests,
   so one endpoint handles both.

   NO LOGIN REQUIRED. The person clicking the link is coming from their email
   client, quite possibly on a different device, and demanding they sign in first
   is how confirmation links get abandoned. Holding the token is the proof.

   The address might have been claimed by somebody else between the email going out
   and the link being clicked, so uniqueness is checked again here rather than
   trusted from earlier.
   ============================================================================= */

import { audit, hashToken } from '../_lib/auth.js';
import { batch, column, one, q } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { looksLikeToken } from '../_lib/validate.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const token = req.field('token', '');

    if (!looksLikeToken(token)) {
        fail(400, 'That confirmation link is not valid.', 'token');
    }

    const request = await one<{
        id: number;
        account_id: number;
        new_email: string;
        username: string;
        current_email: string;
        person_id: string;
    }>(
        `SELECT c.id, c.account_id, c.new_email,
                a.username, a.email AS current_email, a.person_id
           FROM email_change_requests c
           JOIN accounts a ON a.id = c.account_id
          WHERE c.token_hash = ?
            AND c.used_at IS NULL
            AND c.expires_at > now()`,
        [hashToken(token)]
    );

    if (!request) {
        fail(410,
            'This confirmation link has expired or has already been used. ' +
            'You can request a new one from your account settings.',
            'token');
    }

    /* Taken by somebody else in the meantime? Burn the link either way - it names
       an address this account is not going to get, so leaving it live would only
       let the same disappointment happen twice. */
    const taken = await column('SELECT 1 FROM accounts WHERE email = ? AND id <> ?',
        [request.new_email, request.account_id]);

    if (taken) {
        await q('UPDATE email_change_requests SET used_at = now() WHERE id = ?',
            [request.id]);

        fail(409, 'That email address is now in use by another account.');
    }

    try {
        await batch(sqlt => [
            sqlt`UPDATE accounts
                    SET email = ${request.new_email}, email_verified = true
                  WHERE id = ${request.account_id}`,

            /* Keep the people row in step. Two copies of an email address is a bad
               idea, but the person row is what appointments and the calendar feed
               read, so they have to agree. */
            sqlt`UPDATE people SET email = ${request.new_email}
                  WHERE id = ${request.person_id}`,

            sqlt`UPDATE email_change_requests SET used_at = now()
                  WHERE id = ${request.id}`
        ]);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Email confirm failed:', error);

        fail(500, env.devMode
            ? `Could not confirm the address: ${message}`
            : 'Could not confirm that address right now. Please try again shortly.');
    }

    /* The address itself IS written to the audit log here, unlike everywhere else.
       Deliberate: "which address did this account move to, and when" is the exact
       question an account-recovery dispute turns on, and the value is already
       sitting in accounts.email where the same people can read it. */
    await audit(request.account_id, 'email_confirmed', request.new_email, req.ip);

    const wasChange =
        request.current_email.toLowerCase() !== request.new_email.toLowerCase();

    return ok({
        email: request.new_email,
        username: request.username,
        message: wasChange
            ? `Your email address is now ${request.new_email}.`
            : 'Thank you, your email address is confirmed.'
    });
});
