/* =============================================================================
   POST /api/store-ai-message  {  payload: {...}, clientRef?  }
   -----------------------------------------------------------------------------
   Ported from php/api/store-ai-message.php.

   Saves a PRUWise answer into the caller's own AI conversation, so it is still
   there after a refresh.

   =============================================================================
   WHY IT IS SAFE FOR THE BROWSER TO SUPPLY THE CONTENT
   =============================================================================

   Because it can only ever write into aiThread(user.id) - the caller's own private
   PRUWise conversation, which nobody else can read. There is no thread id in the
   request and no way to name one. The worst somebody can do by tampering is write
   nonsense into their own chat history, which is the same as typing nonsense into
   it.

   What they cannot do is write into a conversation with another person: that is
   /api/send-message, and there the sender comes from the session, never from the
   request.

   Nothing here is trusted as HTML either. The payload is stored as JSON and the
   browser escapes every string when it renders, exactly as it does for a message
   that came from another person.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { one, q } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { addMessage, aiThread, latestMessageId } from '../_lib/threads.js';

/* Keep only the fields a message is allowed to carry. A WHITELIST rather than a
   blacklist, so a future addition to the browser's message object cannot quietly
   start being stored without somebody deciding it should be. */
const ALLOWED_KEYS = [
    'paragraphs', 'bullets', 'chips', 'callouts', 'term', 'recId',
    'actions', 'followups', 'disclaimer'
] as const;

/* A hard size limit. Without one, a loop in the browser could fill the messages
   table with a single enormous row. */
const MAX_PAYLOAD_BYTES = 24_000;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not have conversations.');
    }

    const payload = req.body.payload;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        fail(400, 'Expected a payload object.');
    }

    const source = payload as Record<string, unknown>;
    const clean: Record<string, unknown> = {};

    for (const key of ALLOWED_KEYS) {
        if (source[key] !== undefined && source[key] !== null) {
            clean[key] = source[key];
        }
    }

    if (Object.keys(clean).length === 0) {
        fail(400, 'That payload has nothing in it.');
    }

    if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_PAYLOAD_BYTES) {
        fail(400, 'That answer is too large to store.');
    }

    const thread = await aiThread(user.id);

    if (!thread) {
        fail(500, 'Your PRUWise conversation could not be opened. Please try again.');
    }

    const clientRef = req.field('clientRef', '');

    /* Same retry protection as a normal message. */
    if (clientRef !== '') {
        const existing = await one<{ id: number }>(
            'SELECT id FROM messages WHERE client_ref = ?', [clientRef]);

        if (existing) {
            return ok({ duplicate: true, messageId: Number(existing.id) });
        }
    }

    const messageId = await addMessage(thread.id, {
        senderAccountId: null,
        senderKind: 'ai',
        payload: clean,
        clientRef: clientRef === '' ? null : clientRef
    });

    if (messageId === null) {
        const raced = await one<{ id: number }>(
            'SELECT id FROM messages WHERE client_ref = ?', [clientRef]);

        if (raced) {
            return ok({ duplicate: true, messageId: Number(raced.id) });
        }
        fail(500, 'That answer could not be stored.');
    }

    /* An AI answer in your own thread is read the moment it appears - you are
       looking at it. Leaving it unread would put a permanent badge on PRUWise. */
    await q('UPDATE messages SET read_at = now() WHERE id = ?', [messageId]);

    return ok({
        messageId,
        latestId: await latestMessageId(thread.id)
    });
});
