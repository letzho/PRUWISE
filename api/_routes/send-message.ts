/* =============================================================================
   POST /api/send-message
       { threadId | kind:'ai' | withPerson, text, attachmentIds?, clientRef? }
   -----------------------------------------------------------------------------
   Ported from php/api/send-message.php.

   Sends one message.

   =============================================================================
   WHERE THE PRUWISE ANSWER COMES FROM
   =============================================================================

   Not from here. The browser works it out with AI.reply() and then stores it
   through /api/store-ai-message.

   That looks backwards for about a second, then makes sense: the answer logic is a
   few hundred lines of keyword rules over the customer record that already exist,
   are already tested, and run instantly with no key. A second implementation would
   be free to drift from the first.

   =============================================================================
   clientRef STOPS DOUBLE POSTS
   =============================================================================

   The browser generates a random id before sending. If the connection drops and it
   retries, the unique constraint on messages.client_ref rejects the second copy and
   the first one is returned instead of the same line appearing twice.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { one, q } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    addMessage, latestMessageId, resolveThread, threadMessages
} from '../_lib/threads.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not have conversations.');
    }

    /* The thread spec comes from the body here rather than the query string, which
       is the one difference from /api/thread. Same three forms. */
    const thread = await resolveThread(user, {
        threadId: req.has('threadId') ? Number(req.body.threadId) : null,
        kind: req.has('kind') ? String(req.body.kind) : null,
        withPerson: req.has('withPerson') ? String(req.body.withPerson) : null
    });

    const text = req.field('text', '');
    const clientRef = req.field('clientRef', '');

    const rawIds = req.body.attachmentIds;
    const attachmentIds = Array.isArray(rawIds)
        ? rawIds.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)
        : [];

    if (text === '' && attachmentIds.length === 0) {
        fail(400, 'Write something, or attach a file.');
    }
    if (text.length > 4000) {
        fail(400, 'That message is too long. Please shorten it.');
    }

    /* ---------------------------------------------------------------------
       Already sent? Hand back the original rather than posting it again.
       --------------------------------------------------------------------- */
    if (clientRef !== '') {
        const existing = await one<{ id: number; thread_id: number }>(
            'SELECT id, thread_id FROM messages WHERE client_ref = ?', [clientRef]
        );

        if (existing) {
            return ok({
                duplicate: true,
                messageId: Number(existing.id),
                messages: await threadMessages(thread.id, user.id, Number(existing.id) - 1),
                latestId: await latestMessageId(thread.id)
            });
        }
    }

    /* --------------------------------------------------------- write it */
    const messageId = await addMessage(thread.id, {
        senderAccountId: user.id,
        senderKind: 'account',
        body: text === '' ? null : text,
        clientRef: clientRef === '' ? null : clientRef
    });

    if (messageId === null) {
        /* addMessage returns null when a client_ref collided, which the check above
           should have caught - so reaching here means two copies of the same
           request arrived at the same instant and the constraint settled it. That
           is a success, not a failure: the message exists. */
        const raced = await one<{ id: number }>(
            'SELECT id FROM messages WHERE client_ref = ?', [clientRef]);

        if (raced) {
            return ok({
                duplicate: true,
                messageId: Number(raced.id),
                messages: await threadMessages(thread.id, user.id, Number(raced.id) - 1),
                latestId: await latestMessageId(thread.id)
            });
        }

        fail(500, 'That message could not be sent. Please try again.');
    }

    /* ---------------------------------------------------------------------
       Attach any files uploaded a moment ago.

       THE OWNERSHIP CHECK IS THE POINT. Without `uploaded_by = ?`, somebody could
       quote another person's attachment id and staple that file to their own
       message - which is a way to read a file you were never sent. message_id IS
       NULL matters too: an attachment already on a message must not be moved to
       another one.
       --------------------------------------------------------------------- */
    let attached = 0;

    for (const attachmentId of attachmentIds) {
        const moved = await q(
            `UPDATE attachments SET message_id = ?
              WHERE id = ? AND message_id IS NULL AND uploaded_by = ?`,
            [messageId, attachmentId, user.id]
        );

        attached += moved.rowCount;
    }

    /* Everything from this message onwards. Returning it saves the browser a second
       request just to see what it sent, and gives it the real database id. */
    return ok({
        messageId,
        attached,
        messages: await threadMessages(thread.id, user.id, messageId - 1),
        latestId: await latestMessageId(thread.id)
    });
});
