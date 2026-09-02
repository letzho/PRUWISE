/* =============================================================================
   notify.ts - the bell, and the log behind it
   -----------------------------------------------------------------------------
   One function that other code calls when something has happened that a person
   should be told about, and the queries the bell reads.

   =============================================================================
   WHAT MAKES THIS WORTH A TABLE RATHER THAN A COUNT
   =============================================================================

   The bell used to add up two things: a hard-coded activity feed in js/data.js
   and the number of appointments waiting to be accepted. So the assistant could
   read a call, work out that somebody's income had changed and that they wanted a
   meeting, write both to ai_insights - and the bell kept showing a number about
   sample data. The one control a person presses to ask "has anything happened"
   knew nothing about the most important thing that had.

   =============================================================================
   THREE RULES, AND THEY ARE THE WHOLE DESIGN
   =============================================================================

   EVERY NOTIFICATION CARRIES A LINK. A notification you cannot act on is a nag.
   If there is nowhere to send somebody, there is nothing worth telling them.

   ONE ROW PER PERSON WHO NEEDS TELLING. When a meeting is agreed both sides are
   notified, so that is two rows with two separate read_at columns. A single row
   with a list of recipients means "have you read this" lives somewhere else.

   NOTHING SENSITIVE IN THE TITLE. A notification is the one piece of text that
   shows up out of context, in a list, possibly on a lock screen one day. "PRUWise
   noticed something in your call" is a notification. "Sarah's income is now
   $95,000" is a leak wearing a bell icon.
   ============================================================================= */

import { all, column, one, q, type Row } from './db.js';

export interface NotifyInput {
    accountId: number;
    kind: 'insight' | 'meeting' | 'finance' | 'policy' | 'message' | 'system';
    title: string;
    body?: string | null;

    /* A hash route inside this single-page app - '#/fr/customer/cus-001'. Not a
       full URL: storing one would bake the deployment's hostname into the row. */
    link?: string | null;

    insightId?: number | null;

    /* Set this when the same observation may be noticed repeatedly. A growing call
       transcript is re-read every ninety seconds, and without a dedupe key one
       mention of a new salary would ring the bell on every pass.

       Leave it undefined for real events. Two meetings booked really are two
       notifications. */
    dedupe?: string | null;
}

/* Write one. Returns the id, or null when it was a duplicate.

   NEVER THROWS. Every caller is doing something else that has already succeeded -
   a message was sent, an appointment was created, a transcript was read - and
   failing that because the bell could not be rung would be the tail wagging the
   dog. A missing notification is a missing notification; a 500 on a booked meeting
   is a lost meeting. */
export async function notify(input: NotifyInput): Promise<number | null> {
    try {
        const row = await one<{ id: string }>(
            `INSERT INTO notifications
                 (account_id, kind, title, body, link, insight_id, dedupe)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (account_id, dedupe) DO NOTHING
             RETURNING id`,
            [
                input.accountId,
                input.kind,
                input.title.slice(0, 190),
                input.body ? input.body.slice(0, 2000) : null,
                input.link ? input.link.slice(0, 190) : null,
                input.insightId ?? null,
                input.dedupe ? input.dedupe.slice(0, 64) : null
            ]
        );

        return row ? Number(row.id) : null;

    } catch {
        return null;
    }
}

/* The account behind a person id, because most callers know who somebody IS and
   not which login belongs to them.

   Returns null for a person with no account - a seeded representative profile, or
   a customer record created before they registered. That is a normal state, not an
   error: there is nobody to notify. */
export async function accountForPerson(personId: string): Promise<number | null> {
    const id = await column<number>(
        'SELECT id FROM accounts WHERE person_id = ? ORDER BY id LIMIT 1',
        [personId]
    );

    return id === null ? null : Number(id);
}

/* Notify a person rather than an account. Silently does nothing if they have no
   login, for the reason above. */
export async function notifyPerson(
    personId: string,
    input: Omit<NotifyInput, 'accountId'>
): Promise<number | null> {
    const accountId = await accountForPerson(personId);
    if (accountId === null) { return null; }

    return notify({ ...input, accountId });
}


/* ---------------------------------------------------------------- reading */

export interface NotificationView {
    id: number;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    insightId: number | null;
    read: boolean;
    at: unknown;
}

function view(row: Row): NotificationView {
    return {
        id: Number(row.id),
        kind: String(row.kind),
        title: String(row.title),
        body: row.body === null ? null : String(row.body),
        link: row.link === null ? null : String(row.link),
        insightId: row.insight_id === null || row.insight_id === undefined
            ? null : Number(row.insight_id),
        read: row.read_at !== null && row.read_at !== undefined,
        at: row.created_at
    };
}

export async function listNotifications(
    accountId: number,
    limit = 40
): Promise<NotificationView[]> {
    const rows = await all(
        `SELECT * FROM notifications
          WHERE account_id = ?
          ORDER BY created_at DESC
          LIMIT ${Math.min(100, Math.max(1, Math.trunc(limit)))}`,
        [accountId]
    );

    return rows.map(view);
}

export async function unreadNotifications(accountId: number): Promise<number> {
    const n = await column<string>(
        'SELECT COUNT(*) FROM notifications WHERE account_id = ? AND read_at IS NULL',
        [accountId]
    );

    return Number(n ?? 0);
}

/* Mark one, or all of them. Scoped by account_id in the WHERE, so an id belonging
   to somebody else matches nothing rather than being checked and refused - there is
   no way to learn that another person's notification exists. */
export async function markRead(accountId: number, id: number | null): Promise<void> {
    if (id === null) {
        await q(
            'UPDATE notifications SET read_at = now() WHERE account_id = ? AND read_at IS NULL',
            [accountId]
        );
        return;
    }

    await q(
        'UPDATE notifications SET read_at = now() WHERE account_id = ? AND id = ?',
        [accountId, id]
    );
}
