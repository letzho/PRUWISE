/* =============================================================================
   POST /api/message  { id, action: 'edit', body }   ->  { message }
   POST /api/message  { id, action: 'delete' }       ->  { message }
   -----------------------------------------------------------------------------
   Changing something you already said.

   =============================================================================
   ONLY YOUR OWN WORDS, AND ONLY YOUR OWN WORDS
   =============================================================================

   The one rule, and it is checked against sender_account_id from the row rather
   than anything in the request. Not "a message in a conversation you are in":
   being in a conversation lets you READ what the other person said, and nothing
   more. A representative who could edit their client's messages could rewrite what
   the client asked for, in the client's own name, in the record of the advice they
   were given. That is the single worst thing this endpoint could be allowed to do,
   so it is the first thing it refuses.

   A PRUWise answer and a system note are also refused - sender_kind must be
   'account'. Neither has a human author to be the one editing it, and letting
   somebody rewrite the assistant's words in their own transcript would make the
   transcript worthless as a record of what was offered.

   =============================================================================
   DELETING SETS body TO NULL. IT DOES NOT REMOVE THE ROW.
   =============================================================================

   The row survives with deleted_at set, and both sides then see "This message was
   deleted". Two reasons, and the first is the important one:

     REMOVING IT WOULD REWRITE HISTORY FOR THE OTHER PERSON. They read it. They may
     have replied to it. A conversation in which either side can silently make
     things they said stop having been said is not a record of anything.

     AND THE TOMBSTONE IS ITSELF TRUE AND USEFUL. "Something was withdrawn here" is
     what every messenger people already use shows, so it needs no explaining.

   THE WORDS REALLY ARE GONE, though - body is set to NULL, not hidden behind a
   flag. Somebody who deletes a message containing their account number has to be
   able to rely on that. Attachments go with it, because deleting the caption and
   leaving the photograph is the wrong half of the job.

   =============================================================================
   THERE IS NO TIME LIMIT, AND THAT IS DELIBERATE
   =============================================================================

   Most messengers stop you editing after a few minutes, on the reasoning that a
   late edit is dishonest. The opposite applies here: the most valuable correction
   is the one somebody makes on Thursday to a figure they mistyped on Monday, and
   refusing it would leave the wrong number in the record with no way to fix it.
   `edited` is shown permanently instead, which is what makes a late edit safe.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { one, q } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { attachmentsFor, messageForViewer } from '../_lib/threads.js';

const MAX_BODY = 4000;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not have conversations.');
    }

    const id = Math.trunc(Number(req.body.id)) || 0;
    const action = String(req.body.action ?? '').trim();

    if (!id) { fail(400, 'Say which message.', 'id'); }

    if (action !== 'edit' && action !== 'delete') {
        fail(400, 'A message can be edited or deleted.', 'action');
    }

    /* ONE QUERY DOES THE EXISTENCE CHECK AND THE OWNERSHIP CHECK TOGETHER, so
       there is no window between them and no way to tell the two failures apart.

       404 for both, never 403. A 403 would confirm that message 812 exists and
       belongs to somebody - which turns this into a way of counting other people's
       conversations one id at a time. From outside, "not yours" and "not real" have
       to look identical. */
    const row = await one(
        `SELECT * FROM messages
          WHERE id = ? AND sender_account_id = ? AND sender_kind = 'account'`,
        [id, user.id]
    );

    if (!row) { fail(404, 'That message could not be found.'); }

    if (row.deleted_at !== null && row.deleted_at !== undefined) {
        fail(409, 'That message has already been deleted.');
    }

    /* --------------------------------------------------------------- deleting */
    if (action === 'delete') {
        /* The attachment rows go first. attachments.message_id is ON DELETE
           CASCADE from messages, but the message is NOT being deleted - so nothing
           would remove them, and /api/file would happily keep serving the photo
           attached to a message that says it was withdrawn. */
        await q('DELETE FROM attachments WHERE message_id = ?', [id]);

        await q(
            `UPDATE messages
                SET body = NULL, payload = NULL, deleted_at = now(), deleted_by = ?
              WHERE id = ?`,
            [user.id, id]
        );

        await audit(user.id, 'message.delete', `message=${id}`, req.ip);

    } else {
        /* ----------------------------------------------------------- editing */
        const body = String(req.body.body ?? '').trim();

        if (body === '') {
            fail(400,
                'An edit cannot be empty. Delete the message instead if you want it ' +
                'gone - that leaves a mark saying so, which an empty message would not.',
                'body');
        }

        if (body.length > MAX_BODY) {
            fail(400, `A message can be up to ${MAX_BODY} characters.`, 'body');
        }

        /* NO-OP EDITS ARE NOT RECORDED. Pressing save without changing anything
           should not stamp "edited" on a message forever - that would be telling
           the other person something happened when nothing did. */
        if (String(row.body ?? '') === body) {
            const unchanged = await one(
                `SELECT m.*, a.name AS sender_name
                   FROM messages m LEFT JOIN accounts a ON a.id = m.sender_account_id
                  WHERE m.id = ?`, [id]);

            return ok({
                message: messageForViewer(
                    unchanged ?? row, user.id, await attachmentsFor([id])),
                changed: false
            });
        }

        await q(
            'UPDATE messages SET body = ?, edited_at = now() WHERE id = ?',
            [body, id]
        );

        /* The old wording is NOT kept anywhere. Deliberate: an edit history would
           be a second copy of text somebody has just decided they did not want to
           have sent, and this endpoint exists so that decision means something. */
        await audit(user.id, 'message.edit', `message=${id}`, req.ip);
    }

    const updated = await one(
        `SELECT m.*, a.name AS sender_name
           FROM messages m LEFT JOIN accounts a ON a.id = m.sender_account_id
          WHERE m.id = ?`,
        [id]
    );

    if (!updated) { fail(404, 'That message could not be found.'); }

    return ok({
        message: messageForViewer(updated, user.id, await attachmentsFor([id])),
        changed: true
    });
});
