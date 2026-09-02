/* =============================================================================
   appointments.ts - booking, moving, cancelling, and iCalendar
   -----------------------------------------------------------------------------
   Ported from php/lib/appointments.php.

   =============================================================================
   EVERY TIME IN HERE IS AN INSTANT, NOT A CLOCK READING
   =============================================================================

   start_at is TIMESTAMPTZ. The API only ever sends and receives ISO 8601 strings
   with an offset, and the browser formats them for whoever is looking.

   That is not fussiness. Store a bare "2pm" with no zone and you cannot tell whose
   2pm it was, and the answer changes twice a year when the clocks move. Store the
   instant, display it locally, and both people see the same moment even from
   different countries.

   THE PORT MADE THIS STRICTER. MySQL DATETIME held no zone at all and the whole
   thing worked because the connection was pinned to UTC - correct, but by
   convention rather than by type. TIMESTAMPTZ records the instant itself, so a
   connection with a different time zone setting cannot silently reinterpret it.

   =============================================================================
   WHO MAY DO WHAT
   =============================================================================

   Two people share an appointment: a representative and one of their customers.
   Either may propose one, and the rule for confirming is deliberately simple:

       THE PERSON WHO DID NOT CREATE IT IS THE ONE WHO CONFIRMS IT.

   So a customer requesting a meeting cannot also mark it as agreed, and neither
   can a representative. Anything else would make "confirmed" meaningless.

   Either side may cancel, and either side may mark a meeting done once it has
   started - it was their meeting, and both of them know whether it happened.

   =============================================================================
   HOW SOMETHING GETS MARKED DONE
   =============================================================================

   Two ways, kept apart on purpose:

     manually      somebody pressed the button  -> completed_by_account is set
     automatically its end time passed          -> completed_by_account is NULL

   The automatic one is a GUESS. The meeting might have been a no-show, or run
   over, or never happened. So the screen says "closed automatically because the
   time passed" rather than pretending somebody confirmed it, and it can be
   reopened afterwards.

   The sweep is lazy - it runs when somebody looks at their calendar. No cron job,
   nothing to install, and it cannot drift out of date because the only moment it
   matters is the moment you are reading the screen. That mattered on shared
   hosting with no cron; it matters just as much here, where the free plan's cron
   runs once a day.
   ============================================================================= */

import { randomUUID } from 'node:crypto';
import { all, column, one, q, toIso, type Param, type Row } from './db.js';
import { fail } from './http.js';
import { audit, newToken, type User } from './auth.js';

/* Sensible bounds for a meeting. Not business rules so much as guards against
   nonsense - a 0-minute or 3-day "appointment" is a mistake, not a choice. */
const MIN_MINUTES = 15;
const MAX_MINUTES = 240;

/* How far ahead somebody may book. Two years is generous and still finite. */
const MAX_DAYS_AHEAD = 730;

/* Grace period before the automatic sweep closes a meeting. One that ended four
   minutes ago is probably still happening - people run over. */
const SWEEP_GRACE_MINUTES = 30;


/* =============================================================================
   READING
   ============================================================================= */

/* The one column that decides what somebody can see.

   A representative sees their own diary; a customer sees their own appointments.
   Returned as a column/value pair so every query filters the same way rather than
   each one inventing its own rule.

   THE COLUMN NAME IS CHOSEN HERE FROM A FIXED PAIR OF LITERALS and interpolated
   into SQL. That is safe precisely because it is not derived from input - a column
   name cannot be a bound parameter, so the alternative would be two copies of
   every query. */
function scopeOf(user: { role: string; person_id: string }): { column: string; value: string } {
    return user.role === 'fr'
        ? { column: 'a.rep_person_id', value: user.person_id }
        : { column: 'a.customer_person_id', value: user.person_id };
}

/* The SELECT every read shares, so the joined names are always there. */
const APPT_SELECT = `
    SELECT a.*, c.name AS customer_name, r.name AS rep_name
      FROM appointments a
      JOIN people c ON c.id = a.customer_person_id
      JOIN people r ON r.id = a.rep_person_id
`;


/* One row, as the browser wants it.

   Note what is worked out here rather than stored: the end time (start + minutes),
   and whether the viewer is allowed to press each button. Sending "canConfirm"
   beats making the browser re-implement the rules and get them subtly different -
   and the endpoints check again anyway, because a hidden button is a convenience,
   not a control. */
export function appointmentJson(row: Row, user: { id: number; role: string }): Record<string, unknown> {
    const startMs = new Date(String(toIso(row.start_at))).getTime();
    const minutes = Number(row.minutes);
    const mine = Number(row.created_by_account) === user.id;

    /* agenda is JSONB and may be null. ALWAYS hand back an array - the browser
       should never have to null-check a list, and js/pages-calendar.js does not. */
    let agenda: unknown[] = [];
    const stored = typeof row.agenda === 'string' ? safeParse(row.agenda) : row.agenda;
    if (Array.isArray(stored)) { agenda = stored; }

    const isPast = startMs < Date.now();
    const open = row.status === 'pending' || row.status === 'confirmed';

    return {
        id: row.id,
        title: row.title,
        type: row.type,
        mode: row.mode,
        start: toIso(row.start_at),
        end: new Date(startMs + minutes * 60_000).toISOString(),
        minutes,
        location: row.location,
        status: row.status,
        agenda,
        notes: row.notes,
        preparedBy: row.prepared_by,

        customerPersonId: row.customer_person_id,
        repPersonId: row.rep_person_id,

        /* Who the OTHER person is, from the viewer's side. Saves the browser
           joining mock data to work out a name it should have been told. */
        withName: user.role === 'fr'
            ? (row.customer_name ?? '')
            : (row.rep_name ?? ''),

        createdByMe: mine,
        completedAt: toIso(row.completed_at),

        /* THE HONEST BIT. completed with nobody named means the sweep closed it
           because the time passed, which is a guess rather than a fact. */
        autoCompleted: row.status === 'completed' && row.completed_by_account === null,

        can: {
            confirm: open && row.status === 'pending' && !mine && !isPast,
            cancel: open,
            complete: open && isPast,
            reschedule: open,
            join: row.mode === 'video' && open
        }
    };
}

function safeParse(text: string): unknown {
    try { return JSON.parse(text); } catch { return null; }
}


/* Close anything whose time has clearly passed.

   Runs on every read, which sounds wasteful and is not: one UPDATE against an
   indexed range that almost always matches nothing.

   completed_by_account is deliberately left NULL - see the header comment. */
export async function sweepAppointments(user: { role: string; person_id: string }): Promise<void> {
    const scope = scopeOf(user);

    await q(
        `UPDATE appointments a
            SET status = 'completed', completed_at = now()
          WHERE ${scope.column} = ?
            AND a.status IN ('pending', 'confirmed')
            AND a.start_at + (a.minutes + ${SWEEP_GRACE_MINUTES}) * INTERVAL '1 minute' < now()`,
        [scope.value]
    );
}

/* Everything visible to this person between two dates.

   Both are plain YYYY-MM-DD and the range includes both days, which is what
   somebody looking at a month grid means by "March".

   THE DATES ARE COMPARED AS TIMESTAMPTZ, so `::date` casts do the work rather
   than string concatenation - the PHP built '2026-03-01 00:00:00' by hand, which
   only worked because the connection was pinned to UTC. */
export async function listAppointments(
    user: { id: number; role: string; person_id: string },
    fromDate: string,
    toDate: string
): Promise<Array<Record<string, unknown>>> {
    await sweepAppointments(user);

    const scope = scopeOf(user);

    const rows = await all(
        `${APPT_SELECT}
          WHERE ${scope.column} = ?
            AND a.start_at >= ?::date
            AND a.start_at <  (?::date + INTERVAL '1 day')
          ORDER BY a.start_at`,
        [scope.value, fromDate, toDate]
    );

    return rows.map(row => appointmentJson(row, user));
}

/* The next few that have not happened yet. For dashboards, which want "what is
   coming up" rather than a month. */
export async function upcomingAppointments(
    user: { id: number; role: string; person_id: string },
    limit = 5
): Promise<Array<Record<string, unknown>>> {
    await sweepAppointments(user);

    const scope = scopeOf(user);
    const capped = Math.max(1, Math.min(50, Math.trunc(limit) || 5));

    const rows = await all(
        `${APPT_SELECT}
          WHERE ${scope.column} = ?
            AND a.status IN ('pending', 'confirmed')
          ORDER BY a.start_at
          LIMIT ${capped}`,
        [scope.value]
    );

    return rows.map(row => appointmentJson(row, user));
}

/* Load one and refuse if it is not theirs.

   404 rather than 403, the same as conversations and calls: answering "you may not
   see appointment X" confirms that appointment X exists. From outside, one that is
   not yours and one that never existed must look identical. */
export async function loadAppointment(
    user: { person_id: string },
    id: unknown
): Promise<Row> {
    const row = await one(`${APPT_SELECT} WHERE a.id = ?`, [String(id ?? '')]);

    if (!row) {
        fail(404, 'That appointment does not exist.');
    }

    const isMine = row.customer_person_id === user.person_id
        || row.rep_person_id === user.person_id;

    if (!isMine) {
        fail(404, 'That appointment does not exist.');
    }

    return row;
}


/* =============================================================================
   WRITING
   ============================================================================= */

/* Validate a proposed time. Returns an ISO string, or fails the request.

   DELIBERATELY NOT ENFORCING OFFICE HOURS. Whose office hours - the customer is in
   one time zone and the representative may be in another, and an evening slot is a
   perfectly normal thing for somebody who works during the day. The bounds here
   catch mistakes rather than choices. */
function checkTime(isoStart: unknown, minutes: number): string {
    const startMs = new Date(String(isoStart ?? '')).getTime();

    if (Number.isNaN(startMs)) {
        fail(400, 'That does not look like a valid date and time.', 'start');
    }

    if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
        fail(400,
            `A meeting has to be between ${MIN_MINUTES} and ${MAX_MINUTES} minutes long.`,
            'minutes');
    }

    /* Five minutes of slack, so somebody picking "in a moment" is not refused
       because the request took a second to arrive. */
    if (startMs < Date.now() - 300_000) {
        fail(400, 'That time has already passed. Please pick a time in the future.', 'start');
    }

    if (startMs > Date.now() + MAX_DAYS_AHEAD * 86_400_000) {
        fail(400, 'That is too far ahead to book.', 'start');
    }

    return new Date(startMs).toISOString();
}

/* Is the representative already busy then?

   THE OVERLAP TEST. Two meetings clash when each starts before the other ends. The
   tempting version - comparing only the start times - misses the case where a
   90-minute meeting swallows a later 30-minute one whole.

   Only the REPRESENTATIVE's diary is checked. They are the one who cannot be in
   two places at once; a customer has exactly one representative and would have to
   be double-booking themselves on purpose. */
async function findClash(
    repPersonId: string,
    startAt: string,
    minutes: number,
    excludeId: string | null = null
): Promise<Row | null> {
    const params: Param[] = [repPersonId, startAt, minutes, startAt];

    let sql = `
        SELECT a.id, a.title, a.start_at, a.minutes
          FROM appointments a
         WHERE a.rep_person_id = ?
           AND a.status IN ('pending', 'confirmed')
           AND a.start_at < (?::timestamptz + ? * INTERVAL '1 minute')
           AND (a.start_at + a.minutes * INTERVAL '1 minute') > ?::timestamptz`;

    if (excludeId !== null) {
        sql += ' AND a.id <> ?';
        params.push(excludeId);
    }

    return one(`${sql} LIMIT 1`, params);
}

/* The clash message, which says different things to different people.

   NAME THE TIME, NOT THE OTHER CUSTOMER. A customer must not be able to learn who
   else their representative is seeing by probing for clashes - so they get "not
   free then" while the representative, whose diary it is, gets the detail. */
function clashMessage(clash: Row, role: string): string {
    if (role !== 'fr') {
        return 'Your representative is not free then. Please pick another time.';
    }

    const at = String(toIso(clash.start_at) ?? '').slice(11, 16);
    return `That clashes with "${String(clash.title)}" at ${at} UTC.`;
}

/* A readable id, in the same style as the seeded ones. Random rather than
   sequential so nobody can guess the id of somebody else's meeting - the
   membership check would refuse them anyway, but there is no reason to hand out a
   list of valid ids. */
async function newAppointmentId(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = `apt-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

        if (!await column('SELECT 1 FROM appointments WHERE id = ?', [candidate])) {
            return candidate;
        }
    }
    fail(500, 'Could not create an appointment reference. Please try again.');
}

/* Agenda comes from a textarea, one line per point. Cap the count and the length
   so a paste of an entire document does not end up in a JSONB column. */
export function cleanAgenda(input: unknown): string[] {
    let lines: unknown[];

    if (typeof input === 'string') { lines = input.split(/\r\n|\r|\n/); }
    else if (Array.isArray(input)) { lines = input; }
    else { return []; }

    const out: string[] = [];

    for (const line of lines) {
        const clean = String(line ?? '').trim();

        if (clean === '') { continue; }

        out.push(clean.slice(0, 200));

        if (out.length >= 10) { break; }
    }
    return out;
}


/* Book one.

   Status always starts at 'pending', whoever created it. The other side confirms -
   see the header comment for why that rule is worth having. */
export async function createAppointment(
    user: User,
    data: Record<string, unknown>
): Promise<string> {
    let customerId: string;
    let repId: string;

    /* Who is it with? A CUSTOMER NEVER CHOOSES: they have one representative and
       the server reads it off their own record, so there is nothing to get wrong
       and nothing to spoof. A representative must name a customer of theirs. */
    if (user.role === 'customer') {
        if (!user.rep_id) {
            fail(409,
                'You do not have a representative assigned yet, so there is nobody to meet.');
        }
        customerId = user.person_id;
        repId = user.rep_id;

    } else if (user.role === 'fr') {
        const withPerson = String(data.withPerson ?? '').trim();

        if (withPerson === '') {
            fail(400, 'Say which customer the meeting is with.', 'withPerson');
        }

        const other = await one<{ id: string; kind: string; rep_id: string | null }>(
            'SELECT id, kind, rep_id FROM people WHERE id = ?', [withPerson]);

        if (!other || other.kind !== 'customer') {
            fail(404, 'That customer does not exist.', 'withPerson');
        }
        if (other.rep_id !== user.person_id) {
            fail(403, 'That customer is not one of yours.', 'withPerson');
        }

        customerId = other.id;
        repId = user.person_id;

    } else {
        fail(403, 'Administrators do not hold appointments.');
    }

    let title = String(data.title ?? '').trim();

    if (title === '') {
        fail(400, 'Please give the meeting a title.', 'title');
    }
    title = title.slice(0, 190);

    const mode = String(data.mode ?? 'video');

    if (!['video', 'in-person', 'phone'].includes(mode)) {
        fail(400, 'Pick video, in person, or phone.', 'mode');
    }

    const minutes = Math.trunc(Number(data.minutes ?? 30)) || 30;
    const startAt = checkTime(data.start, minutes);

    const clash = await findClash(repId, startAt, minutes);

    if (clash) {
        fail(409, clashMessage(clash, user.role), 'start');
    }

    /* The label under the title, derived from the mode unless one was given. */
    const typeDefaults: Record<string, string> = {
        video: 'Video call', 'in-person': 'In-person meeting', phone: 'Phone call'
    };
    const locationDefaults: Record<string, string> = {
        video: 'PRUWise video room', 'in-person': 'To be confirmed', phone: 'Phone'
    };

    const type = String(data.type ?? '').trim() || typeDefaults[mode] as string;
    const location = String(data.location ?? '').trim() || locationDefaults[mode] as string;

    const agenda = cleanAgenda(data.agenda);
    const notes = String(data.notes ?? '').trim().slice(0, 2000);

    const id = await newAppointmentId();

    /* ics_uid IS THE PERMANENT IDENTITY of this event for calendar apps, and it
       must never change. When the meeting moves we reissue the .ics with the same
       uid and a higher sequence, and Google Calendar or Apple Calendar updates the
       entry that is already there. Change the uid and you get a SECOND event
       instead - the classic calendar-integration bug.

       MySQL's UUID() became randomUUID() rather than Postgres's gen_random_uuid(),
       which needs the pgcrypto extension enabled. One less thing for the schema to
       depend on. */
    await q(
        `INSERT INTO appointments
             (id, customer_person_id, rep_person_id, title, type, mode, start_at, minutes,
              location, status, agenda, prepared_by, notes, ics_uid, created_by_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?::jsonb, ?, ?, ?, ?)`,
        [
            id, customerId, repId, title, type, mode, startAt, minutes,
            location,
            agenda.length > 0 ? JSON.stringify(agenda) : null,
            user.name,
            notes === '' ? null : notes,
            randomUUID(),
            user.id
        ]
    );

    await audit(user.id, 'appointment.create', `${id} at ${startAt}`);

    return id;
}

/* Move one.

   ics_sequence goes up by one. That number is how a calendar app decides whether
   an .ics it has just been handed is newer than the copy it already holds - so
   without bumping it, the update is ignored and the old time stays on somebody's
   phone. */
export async function rescheduleAppointment(
    user: User,
    row: Row,
    isoStart: unknown,
    minutesInput: unknown
): Promise<void> {
    if (row.status === 'completed' || row.status === 'cancelled') {
        fail(409, `That meeting is already ${String(row.status)}, so it cannot be moved.`);
    }

    const minutes = Math.trunc(Number(minutesInput)) || Number(row.minutes);
    const startAt = checkTime(isoStart, minutes);

    const clash = await findClash(String(row.rep_person_id), startAt, minutes, String(row.id));

    if (clash) {
        fail(409, clashMessage(clash, user.role), 'start');
    }

    /* Back to 'pending', because MOVING A MEETING UN-AGREES IT. The other side has
       to say yes to the new time, which is the whole point of confirming - and
       created_by_account moves to whoever did the moving, so the "you cannot
       confirm your own proposal" rule still points at the right person. */
    await q(
        `UPDATE appointments
            SET start_at = ?, minutes = ?, status = 'pending',
                ics_sequence = ics_sequence + 1,
                completed_at = NULL, completed_by_account = NULL,
                created_by_account = ?
          WHERE id = ?`,
        [startAt, minutes, user.id, String(row.id)]
    );

    await audit(user.id, 'appointment.reschedule', `${String(row.id)} -> ${startAt}`);
}

/* Confirm, cancel, mark done, or reopen. One function, because the permission
   rules are easier to read side by side than spread over four. */
export async function setAppointmentStatus(
    user: User,
    row: Row,
    action: string
): Promise<void> {
    const startMs = new Date(String(toIso(row.start_at))).getTime();
    const isPast = startMs < Date.now();
    const open = row.status === 'pending' || row.status === 'confirmed';
    const createdByMe = Number(row.created_by_account) === user.id;
    const id = String(row.id);

    if (action === 'confirm') {
        if (row.status !== 'pending') {
            fail(409, 'That meeting is not waiting to be confirmed.');
        }

        /* THE ONE RULE WORTH REPEATING: you cannot confirm your own request.
           Otherwise "confirmed" would mean nothing more than "somebody typed it
           in", and the other person would never have agreed to anything. */
        if (createdByMe) {
            fail(403, 'You proposed this time, so the other person confirms it. ' +
                'They will see the request on their calendar.');
        }

        await q(
            `UPDATE appointments SET status = 'confirmed', ics_sequence = ics_sequence + 1
              WHERE id = ?`, [id]);

        await audit(user.id, 'appointment.confirm', id);
        return;
    }

    if (action === 'cancel') {
        if (!open) {
            fail(409, `That meeting is already ${String(row.status)}.`);
        }

        await q(
            `UPDATE appointments SET status = 'cancelled', ics_sequence = ics_sequence + 1
              WHERE id = ?`, [id]);

        await audit(user.id, 'appointment.cancel', id);
        return;
    }

    if (action === 'complete') {
        if (!open) {
            fail(409, `That meeting is already ${String(row.status)}.`);
        }

        /* You cannot mark a meeting done before it has started. It plainly has not
           happened yet, and allowing it would make the history meaningless. */
        if (!isPast) {
            fail(409, 'That meeting has not started yet.');
        }

        /* completed_by_account NAMES WHO SAID SO. That is what separates this from
           the automatic sweep, which leaves it null - so the screen can tell
           "Kristin marked this done" from "the time simply passed". */
        await q(
            `UPDATE appointments
                SET status = 'completed', completed_at = now(), completed_by_account = ?
              WHERE id = ?`,
            [user.id, id]);

        await audit(user.id, 'appointment.complete', id);
        return;
    }

    if (action === 'reopen') {
        if (row.status !== 'completed' && row.status !== 'cancelled') {
            fail(409, 'That meeting is still open.');
        }

        /* Undo. Needed because the automatic sweep is a guess - a meeting closed
           because the time passed might not have happened, and there has to be a
           way to say so. */
        await q(
            `UPDATE appointments
                SET status = 'confirmed', completed_at = NULL, completed_by_account = NULL,
                    ics_sequence = ics_sequence + 1
              WHERE id = ?`, [id]);

        await audit(user.id, 'appointment.reopen', id);
        return;
    }

    fail(400, 'Unknown action.');
}


/* =============================================================================
   LINKING TO A REAL CALENDAR APP

   Three ways, because they suit different habits and cost nothing to offer
   together:

     1. AN "ADD TO GOOGLE CALENDAR" LINK. One click, no download, no setup. It
        COPIES the event across - so a later change here does NOT follow it.

     2. A .ics FILE. The standard format every calendar app understands, including
        Outlook and Apple Calendar. Also a copy, with the same caveat.

     3. A SUBSCRIBED FEED. The calendar app re-reads a URL every few hours, so
        changes and cancellations DO follow. This is the one worth using, and it is
        why calendar_feeds exists.

   The uid/sequence pair is what makes 1 and 2 update rather than duplicate on a
   second import.

   =============================================================================
   THIS IS THE FEATURE THAT WAS BROKEN BEFORE AND WORKS NOW
   =============================================================================

   The feed URL used to be app_url('/php/api/calendar.php?feed=...'). On the old
   free host that address had to be reachable by Google's and Apple's servers over
   plain HTTP with no session - which it was, but the host also injected an
   advertising frame into responses, and a calendar app handed HTML instead of
   iCalendar simply gives up silently. Here the response is exactly what was
   written, so a subscription actually holds.
   ============================================================================= */

/* ICS wants times as 20260315T140000Z - no dashes, no colons, Z for UTC. */
function icsTime(value: unknown): string {
    const iso = toIso(value) ?? new Date().toISOString();
    return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/* Escaping for ICS text values. Commas, semicolons and backslashes are all syntax
   in this format, and a newline has to become a literal backslash-n. Get this
   wrong and one comma in a customer's address silently truncates the event. */
function icsEscape(text: unknown): string {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/([,;])/g, '\\$1')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/* ICS lines must be at most 75 octets, continued by starting the next line with a
   single space. Long titles and descriptions hit this constantly, and some parsers
   genuinely reject over-length lines rather than coping.

   MEASURED IN BYTES, NOT CHARACTERS. The spec counts octets, and a customer's name
   with an accent in it is two bytes for one character - so a length check on the
   string would let an over-length line through. */
function icsFold(line: string): string {
    const bytes = Buffer.from(line, 'utf8');

    if (bytes.length <= 73) { return line; }

    const parts: string[] = [Buffer.from(bytes.subarray(0, 73)).toString('utf8')];
    let offset = 73;

    while (offset < bytes.length) {
        parts.push(Buffer.from(bytes.subarray(offset, offset + 72)).toString('utf8'));
        offset += 72;
    }

    return parts.join('\r\n ');
}

const ICS_STATUS: Record<string, string> = {
    pending: 'TENTATIVE',
    confirmed: 'CONFIRMED',
    completed: 'CONFIRMED',
    cancelled: 'CANCELLED'
};

/* The description lines an event carries, shared by the .ics and the Google link
   so the two never disagree about what a meeting is about. */
function describeAppointment(row: Row): string[] {
    const lines: string[] = [];

    if (row.type) { lines.push(String(row.type)); }

    const agenda = typeof row.agenda === 'string' ? safeParse(row.agenda) : row.agenda;

    if (Array.isArray(agenda) && agenda.length > 0) {
        lines.push('', 'Agenda:');
        for (const item of agenda) { lines.push(`- ${String(item)}`); }
    }

    if (row.notes) { lines.push('', String(row.notes)); }

    return lines;
}

export interface IcsOptions {
    name?: string;
    cancelledToo?: boolean;
}

export function buildIcs(rows: Row[], options: IcsOptions = {}): string {
    const name = options.name ?? 'PRUWise appointments';

    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',

        /* PRODID identifies what wrote the file. Required, and free-form. */
        'PRODID:-//PRUWise//Insurance Navigator//EN',
        'CALSCALE:GREGORIAN',

        /* PUBLISH means "here is information", as opposed to REQUEST, which asks
           the recipient to reply yes or no. We are not running a meeting
           invitation system, so PUBLISH is the honest one. */
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape(name)}`,
        'X-WR-TIMEZONE:UTC',

        /* How often a subscribed app should come back. A hint, not a rule - most
           apps refresh a few times a day whatever this says. */
        'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
        'X-PUBLISHED-TTL:PT2H'
    ];

    const stamp = icsTime(new Date().toISOString());

    for (const row of rows) {
        if (row.status === 'cancelled' && !options.cancelledToo) { continue; }

        const startMs = new Date(String(toIso(row.start_at))).getTime();
        const endIso = new Date(startMs + Number(row.minutes) * 60_000).toISOString();

        const description = [...describeAppointment(row), '', 'Booked through PRUWise.'];

        lines.push('BEGIN:VEVENT');

        /* The permanent identity. Same uid + higher sequence = "update this one". */
        lines.push(`UID:${String(row.ics_uid)}`);
        lines.push(`SEQUENCE:${Number(row.ics_sequence)}`);

        /* DTSTAMP is when this description of the event was generated. */
        lines.push(`DTSTAMP:${stamp}`);
        lines.push(`DTSTART:${icsTime(row.start_at)}`);
        lines.push(`DTEND:${icsTime(endIso)}`);
        lines.push(icsFold(`SUMMARY:${icsEscape(row.title)}`));

        if (row.location) {
            lines.push(icsFold(`LOCATION:${icsEscape(row.location)}`));
        }

        lines.push(icsFold(`DESCRIPTION:${icsEscape(description.join('\n'))}`));

        /* STATUS is a real ICS field, and CANCELLED is how a subscribed calendar
           learns to strike an event through rather than silently keeping it. */
        lines.push(`STATUS:${ICS_STATUS[String(row.status)] ?? 'CONFIRMED'}`);

        /* A reminder 30 minutes before, which is what most people would set. */
        if (row.status === 'pending' || row.status === 'confirmed') {
            lines.push('BEGIN:VALARM');
            lines.push('ACTION:DISPLAY');
            lines.push(icsFold(`DESCRIPTION:${icsEscape(row.title)}`));
            lines.push('TRIGGER:-PT30M');
            lines.push('END:VALARM');
        }

        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    /* CRLF between lines, and a trailing one. The spec requires it, and Outlook in
       particular is unforgiving about a bare newline. */
    return `${lines.join('\r\n')}\r\n`;
}

/* An "add to Google Calendar" link.

   Google takes the whole event in the query string, so this needs no API, no key
   and no permission from the user - which is why it is worth offering even though
   a subscribed feed is better. */
export function googleCalendarUrl(row: Row): string {
    const startMs = new Date(String(toIso(row.start_at))).getTime();
    const endIso = new Date(startMs + Number(row.minutes) * 60_000).toISOString();

    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: String(row.title ?? ''),

        /* Google's format is the same as ICS: start/end joined by a slash. */
        dates: `${icsTime(row.start_at)}/${icsTime(endIso)}`,
        details: describeAppointment(row).join('\n'),
        location: String(row.location ?? ''),
        ctz: 'UTC'
    });

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}


/* =============================================================================
   THE SUBSCRIBABLE FEED

   A URL a calendar app re-reads on its own. Anybody holding it can read that
   person's appointments, so:

     - the token is random and per account, NEVER the account id. An id in the URL
       would let anybody read anybody's diary by counting.
     - it can be regenerated, which instantly breaks every copy of the old URL.
       That is the only way to undo having shared one by accident.
     - the feed is read-only and returns nothing but appointments.
   ============================================================================= */

/* 40 hex characters, matching the column width and the length check below. */
function newFeedToken(): string {
    return newToken(20).replace(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(40, '0');
}

export async function feedToken(accountId: number): Promise<string> {
    const existing = await column<string>(
        'SELECT token FROM calendar_feeds WHERE account_id = ?', [accountId]);

    if (existing) { return existing; }

    const token = newFeedToken();

    /* ON CONFLICT rather than MySQL's ON DUPLICATE KEY UPDATE. DO NOTHING, not
       DO UPDATE: two requests arriving together must settle on ONE token, and
       overwriting would hand the loser a token the winner has already sent to a
       calendar app. The re-read below is what makes that safe. */
    await q(
        `INSERT INTO calendar_feeds (account_id, token) VALUES (?, ?)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId, token]
    );

    const settled = await column<string>(
        'SELECT token FROM calendar_feeds WHERE account_id = ?', [accountId]);

    return settled ?? token;
}

export async function regenerateFeedToken(accountId: number): Promise<string> {
    const token = newFeedToken();

    await q(
        `INSERT INTO calendar_feeds (account_id, token) VALUES (?, ?)
         ON CONFLICT (account_id) DO UPDATE SET token = EXCLUDED.token, created_at = now()`,
        [accountId, token]
    );

    await audit(accountId, 'calendar.feed.regenerate', 'old calendar links stopped working');

    return token;
}

/* The account a feed token belongs to, or null.

   DELIBERATELY THE ONLY WAY IN - the feed endpoint has no session, so this lookup
   IS the authentication. */
export async function feedOwner(token: unknown): Promise<Row | null> {
    const value = String(token ?? '');

    /* Wrong shape cannot be a real token, so do not even ask the database. */
    if (value.length !== 40 || !/^[A-Za-z0-9]+$/.test(value)) { return null; }

    return one(
        `SELECT a.*, p.name AS person_name, p.rep_id, p.kind
           FROM calendar_feeds f
           JOIN accounts a ON a.id = f.account_id
           JOIN people p   ON p.id = a.person_id
          WHERE f.token = ?`,
        [value]
    );
}

/* The window a subscribed calendar gets: a year back and everything ahead.

   Calendar apps only display a range anyway, and a year of history is plenty for a
   diary while keeping the file small enough to re-fetch every couple of hours. */
export async function feedRows(user: { role: string; person_id: string }): Promise<Row[]> {
    const scope = scopeOf(user);

    return all(
        `${APPT_SELECT}
          WHERE ${scope.column} = ?
            AND a.start_at > now() - INTERVAL '1 year'
          ORDER BY a.start_at`,
        [scope.value]
    );
}
