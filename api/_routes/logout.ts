/* =============================================================================
   POST /api/logout
       {}                      end this session
       { everywhere: true }    end every session on every device
   -----------------------------------------------------------------------------
   Ported from php/api/logout.php.

   POST rather than GET on purpose: a GET could be triggered by an <img> tag on
   another site and sign people out for fun.

   ALWAYS SUCCEEDS, even when there was nothing to sign out of. The caller's
   intent is "I want to be signed out", and they are - so reporting an error
   because no session existed would be answering a question nobody asked.
   ============================================================================= */

import { audit, currentUser, endSession, revokeAllSessions } from '../_lib/auth.js';
import { defineHandler, ok } from '../_lib/http.js';

export default defineHandler(async (req, res) => {
    req.requirePost();

    const user = await currentUser(req);

    if (user && req.field('everywhere', false) === true) {
        /* Two things, and both are needed.

           Bumping session_epoch invalidates any session row that might exist on
           another device, because currentUser() requires the epoch to match.
           Deleting the rows then cleans up rather than leaving dead ones behind.

           The epoch is what makes this reliable: if a row were somehow missed,
           it still cannot be used. */
        await revokeAllSessions(user.id);
        await audit(user.id, 'logout_everywhere', null, req.ip);

    } else if (user) {
        await audit(user.id, 'logout', null, req.ip);
    }

    /* Clears the cookie and deletes this one session row. Called even when there
       was no user, so a stale or forged cookie is cleared rather than left to be
       re-sent on every request. */
    await endSession(req, res);

    return ok({ loggedOut: true });
});
