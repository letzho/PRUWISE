/* =============================================================================
   GET /api/thread
       ?threadId=12
       ?kind=ai
       ?withPerson=cus-001
       ?threadId=12&since=87      only what is newer than message 87
       ?threadId=12&since=87&read=1
   -----------------------------------------------------------------------------
   Ported from php/api/thread.php.

   Opening a conversation, and then keeping it up to date.

   =============================================================================
   HOW THE OTHER PERSON'S MESSAGES ARRIVE
   =============================================================================

   The browser asks again every couple of seconds with since= set to the highest id
   it already has. Almost every one of those returns an empty list, which is one
   indexed lookup.

   A WebSocket would be tidier and instant, and it is no more available here than
   it was on shared PHP hosting - a serverless function cannot hold a connection
   open between invocations. Two seconds of delay on a chat message is the trade.

   =============================================================================
   MARKING AS READ
   =============================================================================

   A full load always marks the other side's messages read - you cannot open a
   conversation without looking at it. A POLL only does so when it passes read=1,
   which the browser sends only while its window has focus. Otherwise a tab left
   open behind three others would quietly clear somebody's unread badge, and the
   sender would see a double tick that was not true.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { column, one } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    latestMessageId, markThreadRead, resolveThread, threadChanges, threadMessages
} from '../_lib/threads.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not have conversations.');
    }

    const threadIdParam = req.query('threadId');

    const thread = await resolveThread(user, {
        threadId: threadIdParam === '' ? null : Number(threadIdParam),
        kind: req.query('kind') || null,
        withPerson: req.query('withPerson') || null
    });

    const since = Number(req.query('since', '0')) || 0;
    const isPoll = since > 0;

    const messages = await threadMessages(thread.id, user.id, since);

    const wantsRead = req.query('read') === '1';

    if (!isPoll || wantsRead) {
        await markThreadRead(thread.id, user.id);
    }

    /* Who is on the other side. For the PRUWise thread there is nobody, so the
       browser uses its own branding instead. */
    let other: Record<string, unknown> | null = null;

    if (thread.kind === 'human') {
        const otherId = thread.fr_person_id === user.person_id
            ? thread.customer_person_id
            : thread.fr_person_id;

        const row = await one<{
            id: string; name: string; kind: string; segment: string | null;
        }>('SELECT id, name, kind, segment FROM people WHERE id = ?', [otherId]);

        if (row) {
            /* segment is only set for customers. For a representative the job title
               lives in js/data.js, so the browser fills that in - the database has
               no business holding marketing copy. */
            other = {
                personId: row.id,
                name: row.name,
                kind: row.kind,
                sub: row.segment
            };
        }
    }

    /* =====================================================================
       READ RECEIPTS, WITHOUT RESENDING THE CONVERSATION

       The poller asks for messages newer than what it has. Somebody READING your
       message does not create a new message, so a poll would never notice it and
       your ticks would stay grey until the next full reload.

       So the highest id among MY OWN messages that the other side has read comes
       back too. The browser ticks everything up to that number. One indexed
       lookup, and the double tick appears on its own the way people expect.
       ===================================================================== */
    const readUpTo = Number(await column(
        `SELECT COALESCE(MAX(id), 0) FROM messages
          WHERE thread_id = ? AND sender_account_id = ? AND read_at IS NOT NULL`,
        [thread.id, user.id]
    ) ?? 0);

    /* =====================================================================
       EDITS AND DELETIONS, WHICH ALSO NEED THEIR OWN CHANNEL

       Same shape of problem as read receipts above, and it took the same shape of
       answer. An edited message keeps its id, so a poller asking for "anything
       newer than 87" will never be handed it - the other person would go on
       reading the original wording until they reloaded the page, which makes
       "visible to both parties" untrue in the one direction that matters.

       ?changedSince= is the `serverTime` from the caller's own previous response,
       handed straight back. Using the server's clock rather than a fixed window
       matters: a window is a guess, and a tab that slept for longer than the guess
       misses the change permanently.

       Absent on a first load, and correctly so - the message list itself already
       reflects every edit and deletion made before it was built.
       ===================================================================== */
    const changedSince = req.query('changedSince');

    const changed = changedSince === ''
        ? []
        : await threadChanges(thread.id, user.id, changedSince);

    return ok({
        threadId: thread.id,
        kind: thread.kind,
        other,
        messages,
        changed,

        /* Handed back on the next poll as changedSince. The server's clock, so the
           two ends do not have to agree about what time it is. */
        serverTime: new Date().toISOString(),

        latestId: await latestMessageId(thread.id),
        readUpTo,
        poll: isPoll
    });
});
