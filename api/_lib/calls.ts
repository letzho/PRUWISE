/* =============================================================================
   calls.ts - which room two people share, who may be in it, and who is still there
   -----------------------------------------------------------------------------
   Ported from php/lib/calls.php.

   =============================================================================
   THE MODEL, IN ONE PARAGRAPH
   =============================================================================

   A call is always between exactly two people: one representative and one of their
   customers. There is no "room" anybody can invent or guess at - THE PAIR IS THE
   ROOM. Ask to join a call with somebody and you either get the room the two of you
   share or a refusal, and the only way to be in a room is to be one of its two
   people. That is checked on every request, in here, once.

   WHY THE ROOM CODE IS RANDOM WHEN THE PAIR ALREADY IDENTIFIES IT. Because the room
   code appears in the signalling rows, and a predictable code would let somebody
   guess at the mailbox of a call they are not in. They would still be refused -
   every endpoint loads the session and checks membership - but a random code means
   there is nothing to guess at in the first place.

   =============================================================================
   PRESENCE: JOINED IS A MOMENT, SEEN IS A HEARTBEAT
   =============================================================================

   A browser that crashes never says "I left". It just stops talking. So each side
   re-stamps its seen_at on every poll, about once a second, and the other side
   treats "seen within PRESENCE_SECONDS" as present.

   That heartbeat is also what decides WHEN to place the call. There is no point
   sending a WebRTC offer into an empty room, so the representative waits until
   presence says the customer is actually there.
   ============================================================================= */

import { all, column, one, q, toIso, type Row } from './db.js';
import { fail } from './http.js';
import { newToken, type User } from './auth.js';

/* How recently the other side must have polled to count as "on the line". Long
   enough to survive one dropped request at a one-second poll, short enough that a
   closed laptop is noticed while somebody is still looking at the screen. */
export const PRESENCE_SECONDS = 6;

/* A call nobody has polled for this long is over, whatever its status says. Rooms
   are reused per pair, so without this a session left behind by a crashed browser
   would be picked up as "active" by the next call between the same two people, and
   the new call would inherit the old transcript. */
const STALE_MINUTES = 3;

export type CallRole = 'fr' | 'customer';


/* =============================================================================
   WHO IS THE CALLER, IN CALL TERMS

   The signalling mailbox addresses messages by ROLE rather than by account id,
   because a room only ever has two sides and "the other role" is then simply the
   one this person is not.
   ============================================================================= */

export function callRole(user: { role: string }): CallRole {
    return user.role === 'fr' ? 'fr' : 'customer';
}

export function otherRole(role: CallRole): CallRole {
    return role === 'fr' ? 'customer' : 'fr';
}


/* =============================================================================
   FINDING THE ROOM
   ============================================================================= */

/* The live call between these two people, or null.

   Reuses a 'waiting' or 'active' row so both sides land in the same room whatever
   order they arrive in, and however many times they reload. Anything older than
   STALE_MINUTES with no heartbeat is treated as finished - see the note at the top
   for why that matters.

   THE STALENESS TEST IS NOW IN SQL. The PHP compared three timestamps in PHP
   because "GREATEST ignores NULLs badly in MySQL" - it returns NULL if any argument
   is NULL, so GREATEST(seen, seen, created) was NULL whenever nobody had polled.
   Postgres's GREATEST skips NULLs, so the intent can be written where it belongs. */
export async function findLiveCall(
    frPersonId: string,
    customerPersonId: string
): Promise<Row | null> {
    const row = await one(
        `SELECT * FROM call_sessions
          WHERE fr_person_id = ? AND customer_person_id = ?
            AND status IN ('waiting','active')
          ORDER BY id DESC LIMIT 1`,
        [frPersonId, customerPersonId]
    );

    if (!row) { return null; }

    const closed = await q(
        `UPDATE call_sessions
            SET status = 'ended', ended_at = now()
          WHERE id = ?
            AND GREATEST(fr_seen_at, customer_seen_at, created_at)
                < now() - INTERVAL '${STALE_MINUTES} minutes'`,
        [Number(row.id)]
    );

    return closed.rowCount > 0 ? null : row;
}

/* Find the room for this pair, creating it if there is not one.

   THE INSERT CAN LOSE A RACE: both sides pressing "join" in the same instant would
   each find nothing and each create a room, and the two people would then be
   sitting in different rooms waiting for each other. So after inserting we
   re-select the OLDEST live row for the pair and everybody agrees on that one. The
   loser's row is closed rather than left lying around. */
export async function openRoom(
    frPersonId: string,
    customerPersonId: string,
    appointmentId: string | null = null
): Promise<Row> {
    const existing = await findLiveCall(frPersonId, customerPersonId);
    if (existing) { return existing; }

    await q(
        `INSERT INTO call_sessions
             (room_code, appointment_id, fr_person_id, customer_person_id, status)
         VALUES (?, ?, ?, ?, 'waiting')`,
        [
            newToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, '0'),
            appointmentId, frPersonId, customerPersonId
        ]
    );

    const rows = await all(
        `SELECT * FROM call_sessions
          WHERE fr_person_id = ? AND customer_person_id = ?
            AND status IN ('waiting','active')
          ORDER BY id`,
        [frPersonId, customerPersonId]
    );

    const winner = rows[0];

    if (!winner) {
        fail(500, 'That call room could not be opened. Please try again.');
    }

    /* Close any duplicate created by a simultaneous join. */
    for (const row of rows) {
        if (Number(row.id) !== Number(winner.id)) {
            await q(
                `UPDATE call_sessions SET status = 'ended', ended_at = now() WHERE id = ?`,
                [Number(row.id)]
            );
        }
    }

    return winner;
}

export async function reloadCall(callId: number): Promise<Row> {
    const row = await one('SELECT * FROM call_sessions WHERE id = ?', [callId]);

    if (!row) {
        fail(404, 'That call does not exist.');
    }
    return row;
}


/* =============================================================================
   ACCESS

   The single check. Every call endpoint goes through loadCall(), and none of them
   decides for itself who is allowed in.
   ============================================================================= */

export function canSeeCall(user: { person_id: string }, session: Row | null): boolean {
    if (!session) { return false; }

    return session.fr_person_id === user.person_id
        || session.customer_person_id === user.person_id;
}

/* Load a room by its code and refuse if it is not theirs.

   404 rather than 403, the same as conversations: answering "you may not join room
   7" confirms room 7 exists. From outside, a call you are not part of and a call
   that never happened should look identical. */
export async function loadCall(user: { person_id: string }, roomCode: unknown): Promise<Row> {
    const session = await one('SELECT * FROM call_sessions WHERE room_code = ?',
        [String(roomCode ?? '')]);

    if (!canSeeCall(user, session)) {
        fail(404, 'That call does not exist.');
    }
    return session as Row;
}

/* Work out who the caller wants to talk to, and refuse anything that is not a
   representative-and-their-own-customer pair.

   A representative may only call a customer ASSIGNED TO THEM, and a customer may
   only call the representative they are actually assigned to. Both directions are
   checked against people.rep_id rather than trusted from the request, so naming
   somebody else's customer gets a refusal rather than a room. */
export async function resolvePair(
    user: User,
    withPersonId: unknown
): Promise<{ fr: string; customer: string }> {
    if (user.role === 'customer') {
        /* A customer never chooses. They have exactly one representative, and it is
           on their own record - so the request does not even get a say. */
        if (!user.rep_id) {
            fail(409,
                'You do not have a representative assigned yet, so there is nobody to call.');
        }
        return { fr: user.rep_id, customer: user.person_id };
    }

    if (user.role !== 'fr') {
        fail(403, 'Administrators do not take calls.');
    }

    const other = String(withPersonId ?? '').trim();

    if (other === '') {
        fail(400, 'Say which customer you are calling.');
    }

    const row = await one<{ id: string; kind: string; rep_id: string | null }>(
        'SELECT id, kind, rep_id FROM people WHERE id = ?', [other]);

    if (!row || row.kind !== 'customer') {
        fail(404, 'That customer does not exist.');
    }
    if (row.rep_id !== user.person_id) {
        fail(403, 'That customer is not one of yours.');
    }

    return { fr: user.person_id, customer: row.id };
}


/* =============================================================================
   PRESENCE
   ============================================================================= */

/* "I am still here." Called on every poll. Also promotes the room to 'active' and
   stamps started_at the first time both sides have been seen, which is what makes
   the duration in the end-of-call summary the real talking time rather than the
   time since somebody opened the page.

   ONE STATEMENT, NOT TWO. The PHP ran an UPDATE for the heartbeat and a second one
   for the promotion. At one poll per second per participant that is twice the
   round trips for the busiest query in the project, so the promotion is folded into
   the same statement: the CASE only fires when this touch is the one that completes
   the pair.

   THE COLUMN NAMES ARE CHOSEN FROM FIXED LITERALS by role. A column name cannot be
   a bound parameter, and the alternative is two near-identical copies of this. */
export async function touchCall(session: Row, role: CallRole): Promise<void> {
    const seen = role === 'fr' ? 'fr_seen_at' : 'customer_seen_at';
    const joined = role === 'fr' ? 'fr_joined_at' : 'customer_joined_at';
    const otherJoined = role === 'fr' ? 'customer_joined_at' : 'fr_joined_at';

    /* COALESCE on the join stamp means the first touch records the join and every
       later one leaves it alone, without needing to read it back first. */
    await q(
        `UPDATE call_sessions
            SET ${seen} = now(),
                ${joined} = COALESCE(${joined}, now()),

                status = CASE
                    WHEN status = 'waiting' AND ${otherJoined} IS NOT NULL
                    THEN 'active' ELSE status END,

                started_at = CASE
                    WHEN status = 'waiting' AND ${otherJoined} IS NOT NULL
                    THEN COALESCE(started_at, now()) ELSE started_at END
          WHERE id = ?`,
        [Number(session.id)]
    );
}

/* Has the OTHER side polled recently enough to count as on the line? */
export function peerPresent(session: Row, myRole: CallRole): boolean {
    const stamp = myRole === 'fr' ? session.customer_seen_at : session.fr_seen_at;

    if (!stamp) { return false; }

    const seenMs = new Date(String(toIso(stamp))).getTime();

    return seenMs >= Date.now() - PRESENCE_SECONDS * 1000;
}

/* The person on the other end, for the name under their video tile. */
export async function callPeer(
    user: { person_id: string },
    session: Row
): Promise<Record<string, unknown> | null> {
    const otherId = String(session.fr_person_id === user.person_id
        ? session.customer_person_id
        : session.fr_person_id);

    const row = await one<{ id: string; name: string; kind: string; segment: string | null }>(
        'SELECT id, name, kind, segment FROM people WHERE id = ?', [otherId]);

    if (!row) { return null; }

    return { personId: row.id, name: row.name, kind: row.kind, sub: row.segment };
}


/* =============================================================================
   SIGNALLING - the mailbox

   WebRTC sends the video straight between the two browsers, but first the two sides
   have to swap an offer, an answer, and a list of possible network routes called
   ICE candidates. Passing those back and forth is called signalling, and it
   normally uses a WebSocket.

   A SERVERLESS FUNCTION CANNOT HOLD A CONNECTION OPEN between invocations, which is
   the same constraint cheap PHP hosting had for a different reason. So this is a
   mailbox instead. Each side posts its messages in and asks on every poll whether
   anything has arrived. A second or two slower to connect; and the video itself is
   still direct peer-to-peer at full speed once it is up.
   ============================================================================= */

/* 'pin' is not a WebRTC signal. It is the policy snapshot drawer: the
   representative pins two or three policies and the customer's screen shows the
   same ones, so nobody has to say "open the plans page and scroll down".

   WHY IT TRAVELS ON THIS CHANNEL rather than in a table of its own: this mailbox
   already exists, already runs at one delivery per second, and already drains
   itself. A pinned list is an EVENT - "these are the policies now" - which is
   exactly the shape the mailbox is good at.

   The payload carries the WHOLE list rather than a change, so any single delivered
   message fully syncs the other side. That matters because a missed delta would
   leave the two screens permanently disagreeing, and there is no reconciliation
   step to catch it. */
const SIGNAL_KINDS = ['offer', 'answer', 'candidate', 'bye', 'pin'];

const MAX_SIGNAL_BYTES = 64_000;

export async function sendSignal(
    session: Row,
    fromRole: CallRole,
    kind: string,
    payload: unknown
): Promise<void> {
    if (!SIGNAL_KINDS.includes(kind)) {
        fail(400, 'Unknown signal type.');
    }

    /* The payload is opaque to us - an SDP blob or an ICE candidate, generated by
       one browser's WebRTC stack and handed to the other's. Stored as text and
       never parsed. A size cap so a loop cannot fill the table. */
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');

    if (Buffer.byteLength(text, 'utf8') > MAX_SIGNAL_BYTES) {
        fail(400, 'That signal is too large.');
    }

    /* A NEW OFFER SUPERSEDES EVERYTHING STILL WAITING FOR THE PEER.

       ICE candidates describe network routes to one particular peer connection. If
       the call is being re-attempted, the candidates queued from the last try point
       at a connection that no longer exists, and handing them to the new one wastes
       time failing. Cleared here rather than at the call site so it cannot be
       forgotten. */
    if (kind === 'offer') {
        await clearSignals(session, otherRole(fromRole));
    }

    await q(
        `INSERT INTO call_signals (room_code, to_role, from_role, kind, payload)
         VALUES (?, ?, ?, ?, ?)`,
        [String(session.room_code), otherRole(fromRole), fromRole, kind, text]
    );
}

/* Everything addressed to me that I have not been given yet, marked delivered as it
   goes out.

   ONE STATEMENT. The PHP selected the rows, built an id list, and ran a second
   UPDATE. Postgres does both at once with a data-modifying CTE, which also closes
   the window where two overlapping polls could each collect the same candidate.

   Delivering the same candidate twice would be harmless - WebRTC ignores a repeat -
   but marking them means the mailbox DRAINS instead of growing. */
export async function callInbox(
    session: Row,
    myRole: CallRole
): Promise<Array<Record<string, unknown>>> {
    const rows = await all(
        `WITH mine AS (
             SELECT id FROM call_signals
              WHERE room_code = ? AND to_role = ? AND delivered_at IS NULL
              ORDER BY id
              LIMIT 100
         ), taken AS (
             UPDATE call_signals SET delivered_at = now()
              WHERE id IN (SELECT id FROM mine)
          RETURNING id, kind, payload, from_role
         )
         SELECT * FROM taken ORDER BY id`,
        [String(session.room_code), myRole]
    );

    return rows.map(row => ({
        id: Number(row.id),
        kind: row.kind,
        from: row.from_role,
        payload: row.payload
    }));
}

/* Throw away the mailbox for this room.

   PINS SURVIVE THIS. A pinned policy list is not part of the WebRTC handshake - it
   is something the representative put on screen for the customer to read. If the
   connection drops and re-offers, the video should renegotiate and the reading
   material should stay exactly where it was.

   Without this exclusion there is a nasty intermittent bug: pin a policy, hit a
   reconnect a second later, and the pin vanishes before it was ever delivered.
   Which looks like the button not working. */
export async function clearSignals(session: Row, toRole: CallRole | null = null): Promise<void> {
    if (toRole) {
        await q(
            `DELETE FROM call_signals
              WHERE room_code = ? AND to_role = ? AND kind <> 'pin'`,
            [String(session.room_code), toRole]
        );
        return;
    }

    await q(`DELETE FROM call_signals WHERE room_code = ? AND kind <> 'pin'`,
        [String(session.room_code)]);
}


/* =============================================================================
   THE TRANSCRIPT
   ============================================================================= */

/* Add one spoken line.

   `who` is 'person' or 'pruwise'. account_id is always the caller, which is what
   makes the speaker attribution honest: each browser transcribes only its own
   microphone, so whoever sent the line is whoever said it. Nothing is guessed from
   a mixed audio stream.

   Returns the new row id, or the existing one if this client_ref has already been
   stored - which is what makes a retry safe.

   ONE STATEMENT for the insert-or-return-existing, using ON CONFLICT on the unique
   client_ref. The PHP read first and then inserted, which two simultaneous retries
   could both pass. */
export async function addLine(
    session: Row,
    accountId: number,
    who: string,
    text: string,
    clientRef: string | null = null
): Promise<number> {
    const clean = String(text ?? '').trim().slice(0, 1000);

    if (clean === '') { return 0; }

    const kind = who === 'pruwise' ? 'pruwise' : 'person';

    if (clientRef) {
        const row = await one<{ id: number }>(
            `WITH inserted AS (
                 INSERT INTO call_transcripts (call_id, account_id, who, text, client_ref)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (client_ref) DO NOTHING
              RETURNING id
             )
             SELECT id FROM inserted
             UNION ALL
             SELECT id FROM call_transcripts WHERE client_ref = ?
             LIMIT 1`,
            [Number(session.id), accountId, kind, clean, clientRef, clientRef]
        );

        return row ? Number(row.id) : 0;
    }

    const row = await one<{ id: number }>(
        `INSERT INTO call_transcripts (call_id, account_id, who, text, client_ref)
         VALUES (?, ?, ?, ?, NULL)
         RETURNING id`,
        [Number(session.id), accountId, kind, clean]
    );

    return row ? Number(row.id) : 0;
}

/* The shared log, newer than sinceId.

   THE ONE PRIVACY RULE IN HERE: a 'pruwise' line is returned only to the account it
   was shown to. The assistant's nudges are written for one side of the conversation
   - "slow down, you are pushing her" is not something the customer should be
   reading - so they are stored against the account that received them and filtered
   here. Spoken lines are shared, because they were said out loud to both people. */
export async function callTranscript(
    session: Row,
    viewerAccountId: number,
    sinceId = 0,
    limit = 400
): Promise<Array<Record<string, unknown>>> {
    const rows = await all(
        `SELECT t.id, t.who, t.text, t.said_at, t.client_ref, t.account_id,
                a.name AS speaker_name, a.role AS speaker_role
           FROM call_transcripts t
           LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.call_id = ?
            AND t.id > ?
            AND (t.who = 'person' OR t.account_id = ?)
          ORDER BY t.id
          LIMIT ${Number(limit)}`,
        [Number(session.id), Number(sinceId), viewerAccountId]
    );

    return rows.map(row => {
        const mine = Number(row.account_id) === viewerAccountId;

        return {
            id: Number(row.id),
            who: row.who,
            ref: row.client_ref,

            /* The name to print against the line. PRUWise lines are labelled as
               PRUWise however they were stored, and your own words say "You" -
               reading your own name back at you is odd. */
            name: row.who === 'pruwise'
                ? 'PRUWise'
                : (mine ? 'You' : (row.speaker_name ?? 'Someone')),

            mine,
            role: row.speaker_role,
            text: row.text,
            at: toIso(row.said_at)
        };
    });
}

export async function latestLineId(callId: number): Promise<number> {
    return Number(await column(
        'SELECT COALESCE(MAX(id), 0) FROM call_transcripts WHERE call_id = ?', [callId]) ?? 0);
}


/* =============================================================================
   ENDING
   ============================================================================= */

export async function finishCall(session: Row): Promise<void> {
    await q(
        `UPDATE call_sessions
            SET status = 'ended', ended_at = COALESCE(ended_at, now())
          WHERE id = ?`,
        [Number(session.id)]
    );

    /* The mailbox is worthless once the call is over, and it is the biggest thing a
       call leaves behind. The transcript is kept - that is the record. */
    await clearSignals(session);
}

/* How long the two of them were actually connected, in seconds. Worked out from the
   timestamps rather than trusted from the browser, so the summary cannot be made up
   by whoever is holding the keyboard. */
export function callDuration(session: Row): number {
    if (!session.started_at) { return 0; }

    const startMs = new Date(String(toIso(session.started_at))).getTime();
    const endMs = session.ended_at
        ? new Date(String(toIso(session.ended_at))).getTime()
        : Date.now();

    return Math.max(0, Math.round((endMs - startMs) / 1000));
}

/* "4m 12s", or "48s". Minutes and seconds rather than a bare count, because "252"
   means nothing at a glance. */
export function spokenLength(seconds: number): string {
    const total = Math.trunc(seconds);

    if (total < 60) { return `${total}s`; }

    const minutes = Math.floor(total / 60);
    const rest = total % 60;

    return `${minutes}m${rest ? ` ${rest}s` : ''}`;
}
