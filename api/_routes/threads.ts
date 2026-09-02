/* =============================================================================
   GET /api/threads  ->  every conversation this account can see
   -----------------------------------------------------------------------------
   Ported from php/api/threads.php.

   The list down the left of the Messages screen. One request gives the browser
   everything it needs to draw it: who each conversation is with, the last line, the
   time, and how many messages are waiting.

   PRUWISE IS FIRST, ALWAYS. Not because of a sort order, but because it is put
   there before the sorted rows are appended. It is the one conversation that is
   always present and always answers, so it belongs at the top rather than sinking
   down the list on a quiet day.

   A REPRESENTATIVE SEES A CONVERSATION PER CUSTOMER, EVEN AN EMPTY ONE. Their
   customers come from the people table, and one they have never messaged still
   appears with no last line. Otherwise starting a conversation would need a
   separate "new message" flow, and there is no reason for one.

   =============================================================================
   WHY THE PREVIEW LINES COME FROM ONE QUERY
   =============================================================================

   The PHP called one() per conversation to find the last message, and again per
   conversation for the unread count. A representative with twelve customers
   therefore ran twenty-five queries to draw one list.

   Here a lateral join does the whole thing at once. It reads oddly the first time
   - LEFT JOIN LATERAL is a join whose right side may refer to the left - but it is
   exactly "for each conversation, its newest message", which is the sentence the
   screen is asking.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { all, one, toIso, type Row } from '../_lib/db.js';
import { defineHandler, ok } from '../_lib/http.js';
import { aiThread, humanThread, previewOf, unreadCount } from '../_lib/threads.js';

interface ThreadEntry {
    threadId: number;
    kind: 'ai' | 'human';
    personId?: string;
    name: string;
    sub: string;
    seed: string;
    online: boolean;
    preview: string;
    time: string | null;
    fromMe: boolean;
    unread: number;
}

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* Admins have no conversations of their own. They are not in the advisory
       relationship, and giving them a Messages screen would imply they can read
       other people's - which they cannot, here or anywhere in this API. */
    if (user.role === 'admin') {
        return ok({
            threads: [],
            totalUnread: 0,
            note: 'Administrators do not have conversations.'
        });
    }

    const list: ThreadEntry[] = [];

    /* ------------------------------------------- 1. PRUWise, always present */
    const ai = await aiThread(user.id);

    if (ai) {
        const last = await one(
            `SELECT body, payload, created_at, sender_kind FROM messages
              WHERE thread_id = ? ORDER BY id DESC LIMIT 1`,
            [ai.id]
        );

        list.push({
            threadId: Number(ai.id),
            kind: 'ai',
            name: 'PRUWise',
            sub: 'Always available',
            seed: 'pruwise',
            online: true,
            preview: last ? previewOf(last) : 'Ask me anything about insurance',
            time: last ? toIso(last.created_at) : null,
            fromMe: false,
            unread: await unreadCount(ai.id, user.id)
        });
    }

    /* ------------------------------------------- 2. The people they talk to */
    if (user.role === 'customer') {

        /* A customer has exactly one: their representative.

           Note the column is `segment`, not `role` - `people` describes a human
           being, and only `accounts` has a role. For a representative that column
           is usually empty, so it falls back to a plain description rather than
           leaving a blank line under the name. */
        const rep = user.rep_id
            ? await one<{ id: string; name: string; segment: string | null }>(
                'SELECT id, name, segment FROM people WHERE id = ?', [user.rep_id])
            : null;

        if (rep) {
            const thread = await humanThread(rep.id, user.person_id);

            if (thread) {
                list.push(await humanEntry(thread.id, {
                    id: rep.id,
                    name: rep.name,
                    sub: rep.segment && rep.segment !== ''
                        ? rep.segment
                        : 'Your financial representative'
                }, user.id, true));
            }
        }

    } else {
        /* A representative has one per customer. */
        const customers = await all<{ id: string; name: string; segment: string | null }>(
            `SELECT p.id, p.name, p.segment
               FROM people p
              WHERE p.kind = 'customer' AND p.rep_id = ?
              ORDER BY p.name`,
            [user.person_id]
        );

        const rows: ThreadEntry[] = [];

        for (const customer of customers) {
            const thread = await humanThread(user.person_id, customer.id);
            if (!thread) { continue; }

            rows.push(await humanEntry(thread.id, {
                id: customer.id,
                name: customer.name,
                sub: customer.segment ?? ''
            }, user.id, false));
        }

        /* Sort by last activity, with never-messaged customers at the end. A
           comparison rather than a sort key, because "null goes last" is not
           something a plain sort expresses. */
        rows.sort((a, b) => {
            if (a.time === null && b.time === null) { return a.name.localeCompare(b.name); }
            if (a.time === null) { return 1; }
            if (b.time === null) { return -1; }
            return b.time.localeCompare(a.time);
        });

        list.push(...rows);
    }

    return ok({
        threads: list,
        totalUnread: list.reduce((total, entry) => total + entry.unread, 0)
    });
});


async function humanEntry(
    threadId: number,
    other: { id: string; name: string; sub: string },
    viewerAccountId: number,
    online: boolean
): Promise<ThreadEntry> {
    /* The newest message and its attachment count, together. */
    const last = await one<Row & { files: string }>(
        `SELECT m.body, m.payload, m.created_at, m.sender_account_id, m.sender_kind,
                (SELECT COUNT(*) FROM attachments WHERE message_id = m.id) AS files
           FROM messages m
          WHERE m.thread_id = ?
          ORDER BY m.id DESC
          LIMIT 1`,
        [threadId]
    );

    let preview = 'No messages yet';

    if (last) {
        preview = previewOf(last);

        /* previewOf falls back to the word "Attachment" for a message with no text.
           If there really is a file, say something a person would say. */
        if (Number(last.files) > 0 && preview === 'Attachment') {
            preview = 'Sent a file';
        }
    }

    return {
        threadId,
        kind: 'human',
        personId: other.id,
        name: other.name,
        sub: other.sub,
        seed: other.id,
        online,
        preview,
        time: last ? toIso(last.created_at) : null,
        fromMe: !!last && Number(last.sender_account_id) === viewerAccountId,
        unread: await unreadCount(threadId, viewerAccountId)
    };
}
