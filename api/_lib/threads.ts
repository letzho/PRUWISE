/* =============================================================================
   threads.ts - conversations and messages
   -----------------------------------------------------------------------------
   Ported from php/lib/threads.php.

   Two kinds of conversation, and the difference matters:

     kind='human'  one row shared by a representative and a customer. Both open
                   the same row and see the same messages, which is what makes
                   chat actually work across two accounts.

     kind='ai'     one row per account, private. A PRUWise conversation is
                   nobody else's business.
   ============================================================================= */

import { all, column, one, q, toIso, type Row } from './db.js';
import { fail } from './http.js';
import type { User } from './auth.js';

export interface Thread extends Row {
    id: number;
    kind: 'human' | 'ai';
    fr_person_id: string | null;
    customer_person_id: string | null;
    owner_account_id: number | null;
    last_message_at: unknown;
}


/* =============================================================================
   WHO MAY SEE WHAT

   Membership, not role. A representative is not entitled to a conversation just
   for being staff - they have to be one of the two people in it.
   ============================================================================= */
export function canSeeThread(user: User, thread: Thread | null): boolean {
    if (!thread) { return false; }

    if (thread.kind === 'ai') {
        return thread.owner_account_id === user.id;
    }

    return thread.fr_person_id === user.person_id
        || thread.customer_person_id === user.person_id;
}

/* 404 rather than 403 for somebody else's conversation, so "not yours" and "not
   real" look identical from outside. */
export async function requireThread(user: User, threadId: number): Promise<Thread> {
    const thread = await one<Thread>('SELECT * FROM threads WHERE id = ?', [threadId]);

    if (!canSeeThread(user, thread)) {
        fail(404, 'That conversation does not exist.');
    }
    return thread as Thread;
}


/* =============================================================================
   FINDING AND CREATING

   ON CONFLICT DO NOTHING then re-select, which is the Postgres form of the PHP's
   INSERT IGNORE + re-select. Two requests arriving together cannot create two
   threads for the same pair.

   The uniqueness this relies on now actually works. Under MySQL the unique key
   on (kind, fr_person_id, customer_person_id, owner_account_id) did not apply to
   ai threads, because fr_person_id is NULL there and MySQL treats NULLs as
   distinct - so duplicate PRUWise threads were possible and the INSERT IGNORE
   was doing nothing. db/schema.sql declares that constraint NULLS NOT DISTINCT,
   which is what it was always meant to say.
   ============================================================================= */

/* The one PRUWise conversation belonging to this account.

   ONE PER ACCOUNT, not one per customer. A representative talks to PRUWise about
   whoever they are currently looking at, and the transcript records when the
   subject changed - which is how a real assistant conversation reads. One thread
   per customer would fragment it into a dozen half-conversations. */
export async function aiThread(accountId: number): Promise<Thread | null> {
    const existing = await one<Thread>(
        `SELECT * FROM threads WHERE kind = 'ai' AND owner_account_id = ?`,
        [accountId]
    );
    if (existing) { return existing; }

    await q(
        `INSERT INTO threads (kind, owner_account_id, last_message_at)
         VALUES ('ai', ?, now())
         ON CONFLICT DO NOTHING`,
        [accountId]
    );

    return one<Thread>(
        `SELECT * FROM threads WHERE kind = 'ai' AND owner_account_id = ?`,
        [accountId]
    );
}

/* The conversation between a representative and a customer, created on first
   use. Either party can open it, so either party can be the one who creates it. */
export async function humanThread(
    frPersonId: string,
    customerPersonId: string
): Promise<Thread | null> {
    const existing = await one<Thread>(
        `SELECT * FROM threads
          WHERE kind = 'human' AND fr_person_id = ? AND customer_person_id = ?`,
        [frPersonId, customerPersonId]
    );
    if (existing) { return existing; }

    await q(
        `INSERT INTO threads (kind, fr_person_id, customer_person_id, last_message_at)
         VALUES ('human', ?, ?, now())
         ON CONFLICT DO NOTHING`,
        [frPersonId, customerPersonId]
    );

    return one<Thread>(
        `SELECT * FROM threads
          WHERE kind = 'human' AND fr_person_id = ? AND customer_person_id = ?`,
        [frPersonId, customerPersonId]
    );
}


/* =============================================================================
   MESSAGES
   ============================================================================= */

export interface AddMessageOptions {
    senderAccountId?: number | null;
    senderKind?: 'account' | 'ai' | 'system';
    body?: string | null;
    payload?: unknown;

    /* Generated by the browser before sending. If the connection drops and it
       retries, the unique constraint rejects the second attempt rather than
       posting the message twice.

       Also used server-side for announcements that must not double up - the
       policy-issued notice uses 'policy-issued-<id>', so a double tap cannot
       post it again. */
    clientRef?: string | null;
}

/* Insert, and bump the thread's last_message_at so the conversation list sorts
   correctly. Returns the new message id, or null when a client_ref collided -
   which is a successful no-op, not a failure.

   ONE STATEMENT, not two.

   The PHP inserted, called lastInsertId(), then ran a separate UPDATE on
   threads. Postgres can do both in one round trip with a CTE, which matters on a
   platform billing by the millisecond and removes the window where a message
   exists but the thread has not been touched. */
export async function addMessage(
    threadId: number,
    options: AddMessageOptions
): Promise<number | null> {
    const payload = options.payload ? JSON.stringify(options.payload) : null;

    const row = await one<{ id: number }>(
        `WITH inserted AS (
             INSERT INTO messages
                 (thread_id, sender_account_id, sender_kind, body, payload, client_ref)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (client_ref) DO NOTHING
             RETURNING id, thread_id
         ), touched AS (
             UPDATE threads SET last_message_at = now()
              WHERE id IN (SELECT thread_id FROM inserted)
         )
         SELECT id FROM inserted`,
        [
            threadId,
            options.senderAccountId ?? null,
            options.senderKind ?? 'account',
            options.body ?? null,
            payload,
            options.clientRef ?? null
        ]
    );

    /* Number(), even though db.ts now parses int8 for us. messages.id is BIGINT
       and this value goes straight out to the browser as messageId, where the
       browser compares it against message ids that came back through a different
       path. Two representations of the same id is how that comparison silently
       stops matching - see the long note in db.ts. */
    return row ? Number(row.id) : null;
}

/* Mark everything the OTHER side sent as read.

   Never our own messages. A read receipt on your own message is meaningless, and
   writing one would overwrite the real receipt when it arrives. */
export async function markThreadRead(threadId: number, viewerAccountId: number): Promise<void> {
    await q(
        `UPDATE messages SET read_at = now()
          WHERE thread_id = ?
            AND read_at IS NULL
            AND (sender_account_id IS NULL OR sender_account_id <> ?)`,
        [threadId, viewerAccountId]
    );
}

export async function unreadCount(threadId: number, viewerAccountId: number): Promise<number> {
    const rows = await all<{ n: string }>(
        `SELECT COUNT(*) AS n FROM messages
          WHERE thread_id = ?
            AND read_at IS NULL
            AND (sender_account_id IS NULL OR sender_account_id <> ?)`,
        [threadId, viewerAccountId]
    );

    return Number(rows[0]?.n ?? 0);
}

/* The shape the browser expects for one message. Matches what
   php/api/thread.php returned, so js/messages.js needs no changes. */
export function messageJson(row: Row): Record<string, unknown> {
    return {
        id: Number(row.id),
        threadId: Number(row.thread_id),
        senderAccountId: row.sender_account_id === null ? null : Number(row.sender_account_id),
        senderKind: row.sender_kind,
        body: row.body,

        /* JSONB comes back already parsed, unlike MySQL's JSON which arrived as a
           string the PHP had to json_decode. Guarded anyway because a legacy row
           could hold text. */
        payload: typeof row.payload === 'string'
            ? safeParse(row.payload)
            : (row.payload ?? null),

        clientRef: row.client_ref,
        createdAt: toIso(row.created_at),
        readAt: toIso(row.read_at)
    };
}

function safeParse(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
}


/* =============================================================================
   FINDING THE THREAD SOMEBODY MEANT

   Three ways to name a conversation, because the three screens that open one know
   three different things:

       threadId      the conversation list, which already has ids
       kind: 'ai'    the PRUWise button, which does not
       withPerson    a representative clicking a customer's name

   The third is what lets a conversation start without anybody having to create it
   first. Note that it only ever pairs THE CALLER with the other person - there is
   no form of this that asks for a conversation between two other people.
   ============================================================================= */

export interface ThreadSpec {
    threadId?: number | null;
    kind?: string | null;
    withPerson?: string | null;
}

/* By id, with the membership check. 404 for somebody else's, same as
   requireThread. */
export async function loadThread(user: User, threadId: number): Promise<Thread> {
    return requireThread(user, threadId);
}

export async function resolveThread(user: User, spec: ThreadSpec): Promise<Thread> {
    if (spec.threadId) {
        return loadThread(user, Number(spec.threadId));
    }

    if (spec.kind === 'ai') {
        const thread = await aiThread(user.id);

        if (!thread) {
            fail(500, 'Your PRUWise conversation could not be opened. Please try again.');
        }
        return thread;
    }

    if (spec.withPerson) {
        const otherId = String(spec.withPerson);

        const other = await one<{ id: string; kind: string }>(
            'SELECT id, kind FROM people WHERE id = ?', [otherId]
        );

        if (!other) {
            fail(404, 'That person does not exist.');
        }

        let thread: Thread | null = null;

        if (user.role === 'fr' && other.kind === 'customer') {
            thread = await humanThread(user.person_id, otherId);

        } else if (user.role === 'customer' && other.kind === 'fr') {
            thread = await humanThread(otherId, user.person_id);

        } else {
            fail(403, 'You cannot start a conversation with that person.');
        }

        if (!thread) {
            fail(500, 'That conversation could not be opened. Please try again.');
        }
        return thread;
    }

    fail(400, 'Say which conversation you mean.');
}


/* =============================================================================
   READING MESSAGES OUT

   payload holds the parts of a PRUWise answer plain text cannot carry: bullets,
   chips, callouts, a glossary term, a recommendation id, follow-up questions. The
   browser already has a message object with those exact fields, so the JSON is
   stored and handed straight back rather than inventing a second shape for the
   same thing.
   ============================================================================= */

export interface AttachmentJson {
    id: number;
    name: string;
    type: string;
    size: number;
    isImage: boolean;
    url: string;
}

/* Attachments for a set of messages, in ONE query rather than one per message.

   The id list is built from numbers this code cast itself, never from raw input,
   so the generated placeholder line has nothing injectable in it. */
export async function attachmentsFor(
    messageIds: number[]
): Promise<Map<number, AttachmentJson[]>> {
    const grouped = new Map<number, AttachmentJson[]>();

    if (messageIds.length === 0) { return grouped; }

    const placeholders = messageIds.map(() => '?').join(',');

    const rows = await all<{
        id: number; message_id: number; original_name: string;
        mime: string; size_bytes: number; is_image: boolean;
    }>(
        `SELECT id, message_id, original_name, mime, size_bytes, is_image
           FROM attachments
          WHERE message_id IN (${placeholders})
          ORDER BY id`,
        messageIds
    );

    for (const row of rows) {
        const key = Number(row.message_id);
        const list = grouped.get(key) ?? [];

        list.push({
            id: Number(row.id),
            name: row.original_name,
            type: row.mime,
            size: Number(row.size_bytes),
            isImage: row.is_image === true,

            /* Served through /api/file, never as a direct path. That endpoint checks
               the reader is in the conversation before sending a byte.

               CHANGED FROM THE PHP, which wrote 'php/api/file.php?id=N'. Absolute
               now, because the page can be at any hash route and a relative URL
               would resolve against whatever the browser thinks the directory is. */
            url: `/api/file?id=${Number(row.id)}`
        });

        grouped.set(key, list);
    }

    return grouped;
}

/* One message, from the READER's point of view.

   The same row is 'me' to one person and 'them' to the other - that is the whole
   point of storing it once. */
export function messageForViewer(
    row: Row,
    viewerAccountId: number,
    attachments: Map<number, AttachmentJson[]>
): Record<string, unknown> {
    const isMine = row.sender_account_id !== null
        && Number(row.sender_account_id) === viewerAccountId;

    let role = 'them';
    if (isMine) { role = 'me'; }
    else if (row.sender_kind === 'system') { role = 'system'; }

    /* =====================================================================
       A DELETED MESSAGE IS A TOMBSTONE, NOT AN ABSENCE

       The row is still here with body NULL and deleted_at set, and BOTH sides get
       this object. Dropping it from the list instead would rewrite history for the
       person who already read it - and in a two-person advisory conversation,
       being able to make something you said stop having been said is a serious
       thing to hand out quietly.

       No attachments come back with a deleted message either. Deleting the words
       and leaving the photo would be the wrong half.
       ===================================================================== */
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
        return {
            id: Number(row.id),
            role,
            senderKind: row.sender_kind,
            senderName: row.sender_name ?? null,
            time: toIso(row.created_at),
            read: row.read_at !== null,
            deleted: true,
            deletedByMe: row.deleted_by !== null
                && Number(row.deleted_by) === viewerAccountId,
            paragraphs: [] as unknown[],
            files: []
        };
    }

    const message: Record<string, unknown> = {
        id: Number(row.id),
        role,
        senderKind: row.sender_kind,
        senderName: row.sender_name ?? null,
        time: toIso(row.created_at),
        read: row.read_at !== null,

        /* Non-null once, non-null forever. The interface says "edited" from it,
           because a silently altered message is the same problem as a silently
           deleted one in a smaller size. */
        editedAt: toIso(row.edited_at) ?? null,

        /* WHETHER THE READER MAY EDIT OR DELETE IT. Computed here, so one rule
           produces both the buttons and the server's answer.

           Only your own text, and only while it is still an ordinary message - a
           PRUWise answer or a system note has no author to be editing it. The
           endpoint checks again anyway; a hidden button is a convenience, not a
           control. */
        canEdit: isMine && row.sender_kind === 'account',

        paragraphs: [] as unknown[],
        files: attachments.get(Number(row.id)) ?? []
    };

    /* A rich PRUWise answer: unpack the stored object over the defaults. */
    const payload = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload;

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        /* NEVER let stored JSON override who sent it or when. Those five come from
           the row, and a payload that could rewrite them would let somebody put
           words in another person's mouth in their own chat history. */
        const protected_ = new Set(['id', 'role', 'time', 'read', 'senderKind']);

        for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
            if (protected_.has(key)) { continue; }
            message[key] = value;
        }
    }

    /* body is the plain text, and wins for anything that has one. */
    if (row.body !== null && row.body !== undefined && row.body !== '') {
        message.paragraphs = [row.body];
    }

    return message;
}

/* The messages in a thread. sinceId lets the poller ask for "anything newer than
   what I already have", which is one indexed lookup rather than resending the
   whole conversation every two seconds. */
export async function threadMessages(
    threadId: number,
    viewerAccountId: number,
    sinceId = 0,
    limit = 200
): Promise<Array<Record<string, unknown>>> {
    const rows = await all(
        `SELECT m.*, a.name AS sender_name
           FROM messages m
           LEFT JOIN accounts a ON a.id = m.sender_account_id
          WHERE m.thread_id = ? AND m.id > ?
          ORDER BY m.id
          LIMIT ${Number(limit)}`,
        [threadId, Number(sinceId)]
    );

    const ids = rows.map(row => Number(row.id));
    const attachments = await attachmentsFor(ids);

    return rows.map(row => messageForViewer(row, viewerAccountId, attachments));
}

/* =============================================================================
   MESSAGES THAT CHANGED WITHOUT BEING NEW

   The poller asks for "anything with an id above what I hold", which is fast and
   correct for arrivals and BLIND to everything else. Editing or deleting a message
   does not change its id, so without this the other person would go on reading the
   original wording until they next reloaded the page - which is the same class of
   bug as read receipts needing their own channel, and was solved the same way.

   sinceIso is the `serverTime` from the caller's PREVIOUS response, handed back.
   Not a fixed window like "anything in the last two minutes": a window has to be
   guessed, and a tab that was asleep for longer than the guess silently misses the
   change. Using the server's own clock, echoed back, cannot miss one.
   ============================================================================= */
export async function threadChanges(
    threadId: number,
    viewerAccountId: number,
    sinceIso: string
): Promise<Array<Record<string, unknown>>> {
    const when = new Date(sinceIso);

    if (Number.isNaN(when.getTime())) { return []; }

    const rows = await all(
        `SELECT m.*, a.name AS sender_name
           FROM messages m
           LEFT JOIN accounts a ON a.id = m.sender_account_id
          WHERE m.thread_id = ?
            AND (m.edited_at > ?::timestamptz OR m.deleted_at > ?::timestamptz)
          ORDER BY m.id
          LIMIT 100`,
        [threadId, when.toISOString(), when.toISOString()]
    );

    if (rows.length === 0) { return []; }

    const attachments = await attachmentsFor(rows.map(row => Number(row.id)));

    return rows.map(row => messageForViewer(row, viewerAccountId, attachments));
}


/* One line of preview text for the conversation list. An attachment with no
   message shows something rather than an empty row. */
export function previewOf(row: Row | null): string {
    if (!row) { return 'No messages yet'; }

    if (row.body !== null && row.body !== undefined && row.body !== '') {
        return String(row.body);
    }

    const payload = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload;

    if (payload && typeof payload === 'object') {
        const paragraphs = (payload as { paragraphs?: unknown }).paragraphs;

        if (Array.isArray(paragraphs) && typeof paragraphs[0] === 'string' && paragraphs[0]) {
            return paragraphs[0];
        }
    }

    return 'Attachment';
}

/* The highest message id in a thread, so a poller knows what to ask for next time
   even when this response was empty. */
export async function latestMessageId(threadId: number): Promise<number> {
    return Number(await column('SELECT COALESCE(MAX(id), 0) FROM messages WHERE thread_id = ?',
        [threadId]) ?? 0);
}

/* =============================================================================
   WHAT THE CLIENT THEMSELVES HAS WRITTEN, AS PLAIN TEXT

   For the call co-pilot, which until now could only read the sentence being
   spoken. A client who typed "we are expecting in March" last Tuesday had already
   told their representative the single most important thing about their financial
   position, and the co-pilot was deaf to it because it only ever saw the live
   microphone.

   -----------------------------------------------------------------------------
   ONLY THEIR OWN WORDS, AND THAT IS DELIBERATE
   -----------------------------------------------------------------------------
   The rules in _lib/copilot.ts detect LIFE EVENTS, and a life event is a fact
   about the client. Scanning the representative's own messages would fire on
   their sales language: a rep who wrote "shall we look at an education plan"
   would trigger the education rule, and the card would tell them to do the thing
   they had already suggested. The live path makes the same choice - see the
   `!row.mine` test in js/call.js - so this is the same rule applied to a second
   source rather than a new policy.

   sender_kind = 'account' excludes system notices and PRUWise's own answers. A
   PRUWise message summarising a product would otherwise make the assistant read
   its own words back and treat them as the client's.

   Deleted messages are excluded. Somebody who deleted a message has asked for it
   not to be part of the conversation any more, and quietly feeding it to a
   suggestion engine would make that deletion a lie.

   NEWEST FIRST in SQL so the limit takes the most recent, then reversed so the
   caller reads them in the order they were written.
   ============================================================================= */
export async function clientWords(
    threadId: number,
    customerPersonId: string,
    limit = 40
): Promise<string[]> {
    const rows = await all<{ body: string | null }>(
        `SELECT m.body
           FROM messages m
           JOIN accounts a ON a.id = m.sender_account_id
          WHERE m.thread_id = ?
            AND a.person_id = ?
            AND m.sender_kind = 'account'
            AND m.deleted_at IS NULL
            AND m.body IS NOT NULL
            AND m.body <> ''
          ORDER BY m.id DESC
          LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
        [threadId, customerPersonId]
    );

    return rows
        .map(row => String(row.body ?? '').trim())
        .filter(text => text !== '')
        .reverse();
}
