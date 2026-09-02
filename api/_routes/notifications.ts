/* =============================================================================
   GET  /api/notifications          ->  { notifications: [...], unread }
   POST /api/notifications { id }   ->  mark one read
   POST /api/notifications { all }  ->  mark them all read
   -----------------------------------------------------------------------------
   What the bell shows.

   =============================================================================
   WHAT THIS REPLACED
   =============================================================================

   The bell counted a hard-coded activity feed in js/data.js plus the number of
   appointments waiting to be accepted. Both of those are still worth showing, and
   the appointments half was real - but between them they meant the bell could not
   report the one class of thing the application had just learned how to notice.

   PRUWise reads a call transcript, works out that somebody's income has changed
   and that they asked for a meeting, and writes both to ai_insights. The bell knew
   nothing about it. This endpoint is how it finds out.

   =============================================================================
   YOU CAN ONLY EVER SEE YOUR OWN
   =============================================================================

   account_id comes from the session and appears in the WHERE of every statement,
   including the update. So an id belonging to somebody else MATCHES NOTHING rather
   than being found and refused - which means there is no way to discover that
   another person's notification exists by watching which ids give a different
   error.

   Administrators are allowed here, unlike most of this API. A notification is
   about the account reading it and nobody else, so there is nothing to withhold -
   and an admin whose bell 403s would be told the feature is broken.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { listNotifications, markRead, unreadNotifications } from '../_lib/notify.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* ---------------------------------------------------------------- reading */
    if ((req.raw.method ?? 'GET') === 'GET') {
        const limit = Math.trunc(Number(req.query('limit'))) || 40;

        const [notifications, unread] = await Promise.all([
            listNotifications(user.id, limit),
            unreadNotifications(user.id)
        ]);

        return ok({ notifications, unread });
    }

    req.requirePost();

    /* --------------------------------------------------------------- marking */

    /* `all` first, because the header button that clears the list is the common
       case and an id of 0 must not be mistaken for it. */
    if (req.field('all', false) === true) {
        await markRead(user.id, null);

        return ok({ unread: 0, message: 'All caught up.' });
    }

    const id = Math.trunc(Number(req.body.id)) || 0;

    if (!id) {
        fail(400, 'Say which notification, or pass all: true.', 'id');
    }

    await markRead(user.id, id);

    return ok({ unread: await unreadNotifications(user.id) });
});
