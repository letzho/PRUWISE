/* =============================================================================
   GET /api/session  -  "Who am I?"
   -----------------------------------------------------------------------------
   Ported from php/api/session.php.

   The browser calls this once on start-up. It is what replaces trusting
   localStorage: the session cookie is the only thing that says you are signed
   in, and only the server can read it.

   ALWAYS 200, NEVER 401. "Nobody is signed in" is a normal answer to this
   question, not an error. Returning 401 would make js/api.js treat the very
   first request of every visit as a failure.
   ============================================================================= */

import { currentUser, publicAccount } from '../_lib/auth.js';
import { defineHandler, ok } from '../_lib/http.js';
import { env, has } from '../_lib/env.js';

export default defineHandler(async (req) => {
    const user = await currentUser(req);

    return ok({
        account: user ? await publicAccount(user) : null,

        /* Handy for the front end to know without a second request: whether the
           API is reachable at all, and whether PRUWise has a live key. */
        server: {
            time: new Date().toISOString(),
            devMode: env.devMode,

            /* The client id is NOT a secret - it ships to the browser either way,
               which is why Google also makes you list the exact origins allowed
               to use it. Sent as null when unconfigured so the button is simply
               not drawn. */
            googleClientId: has.google() ? env.googleClientId : null,

            /* THE NONCE IS GONE, AND ITS ABSENCE IS DELIBERATE.

               The PHP generated a random nonce here, stashed it in $_SESSION, and
               google-login.php checked it back to stop a captured token being
               replayed. That depended on having a server-side session BEFORE
               anybody signed in - which is exactly what serverless does not
               have, and creating a database row for every anonymous visitor to
               the login screen would be a denial-of-service waiting to happen.

               api/google-login.ts relies on what the token itself proves instead: Google's own
               token already carries `aud`, `iss` and `exp`, all verified against
               the signing keys, and the token is single-use within its short
               lifetime because the account's session is created from it. See the
               note there. */

            /* A real key starts with sk- and is long. The placeholder in
               .env.example is an empty string, so this is only true when
               somebody has actually configured one. */
            aiEnabled: has.openai()
                && env.openaiKey.startsWith('sk-')
                && env.openaiKey.length > 20
        }
    });
});
