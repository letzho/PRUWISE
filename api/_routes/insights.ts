/* =============================================================================
   GET  /api/insights?person=cus-001[&status=open]
        ->  { insights: [...] }

   POST /api/insights
        { person, source:'chat'|'call'|'meeting', threadId?, roomCode?, text }
        ->  { found: [...], engine, keyPoints, skipped? }

   POST /api/insights
        { id, action: 'confirm' | 'dismiss' | 'done' }
        ->  { insight, applied? }
   -----------------------------------------------------------------------------
   New. What the assistant noticed in a conversation, and what a human decided
   about it.

   =============================================================================
   THE ASSISTANT PROPOSES. THE REPRESENTATIVE DECIDES. ALWAYS.
   =============================================================================

   Analysing writes rows with status 'open' and changes NOTHING else. A proposed
   detail change only reaches customer_finances or people when somebody confirms
   it, and only a representative can confirm.

   The reason is speech recognition, and it is not hypothetical: "ninety five
   thousand" and "nineteen five thousand" differ by one syllable. An income
   silently rewritten from a mishearing would flow into the needs calculation, the
   shortfall, and every recommendation drawn from it. A wrong figure nobody chose
   is far worse than a proposal nobody actioned.

   =============================================================================
   A CLIENT NEVER SEES THE 'support' ROWS
   =============================================================================

   "This person may be under financial pressure" is a note for the human advising
   them. Showing it to the person it is about would be a different product and a
   worse one. Enforced here rather than in the interface, because an interface is
   not a permission.

   A client CAN see their own detail proposals and follow-ups - those are about
   facts they told somebody, and letting them correct their own record is the
   point of task 19.
   ============================================================================= */

import { audit, requireLogin, type User } from '../_lib/auth.js';
import { all, column, one, q, type Row } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { notify, notifyPerson } from '../_lib/notify.js';
import { createAppointment } from '../_lib/appointments.js';
import {
    fingerprintOf, findByRules, keyPoints, polish, worthAnalysing
} from '../_lib/insights.js';

interface InsightRow extends Row {
    id: number;
    customer_person_id: string;
    kind: string;
    source: string;
    thread_id: number | null;
    room_code: string | null;
    field: string | null;
    old_value: string | null;
    new_value: string | null;
    note: string;
    quote: string | null;
    engine: string;
    status: string;
    decided_by: number | null;
    decided_at: unknown;
    created_at: unknown;
}

function view(row: InsightRow) {
    return {
        id: Number(row.id),
        kind: row.kind,
        source: row.source,
        threadId: row.thread_id === null ? null : Number(row.thread_id),
        field: row.field,
        oldValue: row.old_value,
        newValue: row.new_value,
        note: row.note,
        quote: row.quote,
        engine: row.engine,
        status: row.status,
        at: row.created_at
    };
}

/* Which fields a confirmed proposal is allowed to write, and where.

   AN ALLOW-LIST, not a lookup by name. Without it, `field` arrives from a rule in
   _lib/insights.ts and is interpolated into an UPDATE - and the day somebody adds
   a rule with a typo, or a field that happens to name a column nobody meant to be
   writable, that becomes a way to edit the wrong thing. Everything not listed here
   is a note for a human and is never applied automatically. */
const APPLY: Record<string, { column: string }> = {
    annual_income:    { column: 'annual_income' },
    monthly_expenses: { column: 'monthly_expenses' }
};

/* WHAT IS DELIBERATELY NOT IN THAT LIST, and it is most things.

   The rules in _lib/insights.ts also spot a new dependant, a change of employer
   and a change of marital status. None of those is applied automatically, for two
   different reasons:

     THERE IS NO COLUMN FOR SOME OF THEM. people has no marital_status and no
     employer; that information lives in the sample data, not the database. An
     entry here naming a column that does not exist would fail at the moment
     somebody pressed Confirm, which is the worst possible time to find out.

     AND THE REST ARE NOT A SINGLE VALUE. "A new dependant" is not one number - it
     changes the dependant count, probably the cover a household needs, and
     possibly who the beneficiary should be. Writing one field and calling it done
     would leave the record half-right, which is harder to spot than a record
     nobody touched.

   So they are raised as notes, a representative reads the quote, and they open the
   form. Confirming those marks the note handled without pretending the record
   updated itself - see `applied` in the response. */

/* Only a representative may act on a proposal, and only for their own client. */
async function requireOwnClient(user: User, personId: string): Promise<void> {
    if (user.role !== 'fr') {
        fail(403,
            'Only your representative can confirm a change picked up from a ' +
            'conversation. It is shown to you so you can tell them if it is wrong.');
    }

    const mine = await column<number>(
        `SELECT 1 FROM people WHERE id = ? AND kind = 'customer' AND rep_id = ?`,
        [personId, user.person_id]
    );

    if (mine === null) { fail(404, 'That client could not be found.'); }
}


export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not review client conversations.');
    }

    const method = req.raw.method ?? 'GET';

    /* ---------------------------------------------------------------- reading */
    if (method === 'GET') {
        const asked = req.query('person');
        const personId = asked === '' ? user.person_id : asked;

        if (personId !== user.person_id) {
            const mine = user.role === 'fr' && await column<number>(
                'SELECT 1 FROM people WHERE id = ? AND rep_id = ?',
                [personId, user.person_id]
            ) !== null;

            if (!mine) { fail(404, 'There is nothing to show for that person.'); }
        }

        const status = req.query('status') || 'open';

        /* THE 'support' KINDS ARE FILTERED OUT FOR A CLIENT. See the header. */
        const rows = user.role === 'fr'
            ? await all<InsightRow>(
                `SELECT * FROM ai_insights
                  WHERE customer_person_id = ?
                    AND (? = 'all' OR status = ?)
                  ORDER BY created_at DESC
                  LIMIT 100`,
                [personId, status, status])

            : await all<InsightRow>(
                `SELECT * FROM ai_insights
                  WHERE customer_person_id = ?
                    AND kind <> 'support'
                    AND (? = 'all' OR status = ?)
                  ORDER BY created_at DESC
                  LIMIT 100`,
                [personId, status, status]);

        return ok({ personId, insights: rows.map(view) });
    }

    if (method !== 'POST') {
        fail(405, 'Use GET to read what was noticed, or POST to analyse or decide.');
    }

    /* ------------------------------------------------- deciding on a proposal */
    const action = String(req.body.action ?? '').trim();

    if (action !== '') {
        const id = Math.trunc(Number(req.body.id)) || 0;
        if (!id) { fail(400, 'Say which one.', 'id'); }

        const row = await one<InsightRow>('SELECT * FROM ai_insights WHERE id = ?', [id]);
        if (!row) { fail(404, 'That note could not be found.'); }

        await requireOwnClient(user, row.customer_person_id);

        if (!['confirm', 'dismiss', 'done', 'book'].includes(action)) {
            fail(400, 'A note can be confirmed, dismissed, booked or marked done.');
        }

        /* Booking marks it done, because the loose end it represented is tied off
           the moment the meeting exists. */
        const status = action === 'confirm' ? 'confirmed'
            : (action === 'dismiss' ? 'dismissed' : 'done');

        let applied: string | null = null;
        let booked: string | null = null;

        /* =====================================================================
           BOOKING THE MEETING SOMEBODY ASKED FOR

           The rules read a day and a time out of what was actually said - see
           whenFrom() in _lib/insights.ts - and this is where that becomes a row in
           the appointments table.

           =================================================================
           IT IS ONE CLICK, NOT ZERO, AND THAT IS THE DESIGN
           =================================================================

           "Auto-schedule when a meeting is mentioned" could mean the appointment
           appears with nobody pressing anything. It deliberately does not, and the
           reason is not caution for its own sake:

             SPEECH RECOGNITION MISHEARS DAYS as readily as it mishears numbers, and
             "no, not Tuesday" is a sentence people say in the middle of agreeing a
             time. A meeting that books itself off a half-finished negotiation puts
             a wrong entry in TWO diaries and sends the other person a notification
             about it.

             AND A MEETING IS A COMMITMENT MADE BY A LICENSED PERSON. The same rule
             as everything else here: the assistant does the work, the human makes
             the commitment.

           So PRUWise finds the slot, works out the time, fills in the title and
           the length, and a representative presses one button. That is the whole
           of the labour saved and none of the responsibility.

           createAppointment() writes it as 'pending', which means THE CLIENT STILL
           HAS TO ACCEPT - so nothing is agreed by one side alone even now.
           ===================================================================== */
        if (action === 'book') {
            if (row.kind !== 'meeting') {
                fail(400, 'Only a meeting can be booked.');
            }

            if (row.new_value === null) {
                fail(400,
                    'No day or time was mentioned, so there is nothing to book. Open the ' +
                    'calendar and choose one.');
            }

            const person = await one<{ first_name: string | null; name: string }>(
                'SELECT first_name, name FROM people WHERE id = ?', [row.customer_person_id]);

            const theirName = person ? (person.first_name ?? person.name) : 'your client';

            /* createAppointment() does its own validation: a time in the past, a
               clash in the representative's diary, a customer who is not theirs. It
               fails the request with a message the interface already shows, and
               because it throws BEFORE the status update below, the proposal stays
               open so another time can be tried. */
            const appointmentId = await createAppointment(user, {
                withPerson: row.customer_person_id,
                title: 'Meeting with ' + theirName,
                mode: 'video',
                minutes: 30,
                start: row.new_value,

                /* The words that caused it, on the appointment itself. Both people
                   see the agenda, so both can see why this time was suggested -
                   which is what stops it looking like it appeared from nowhere. */
                agenda: row.quote ? ['Discussed in your ' + row.source + ': "' + row.quote + '"'] : [],
                notes: 'Suggested by PRUWise from your ' + row.source + '.'
            });

            booked = appointmentId;

            /* ---------------------------------------------------------------
               BOTH PARTIES ARE TOLD, which was the explicit ask.

               Two rows rather than one, because "have you read this" has to be
               answered separately for each of them - see _lib/notify.ts.

               The wording differs by side, and not just for politeness. The client
               is being asked to DO something (accept it); the representative is
               being told something is DONE (they pressed the button). The same
               sentence for both would leave one of them unsure whose move it is. */
            await notify({
                accountId: user.id,
                kind: 'meeting',
                title: 'Meeting with ' + theirName + ' put in your diary',
                body: 'From what was said in your ' + row.source + '. ' + theirName +
                      ' has been asked to accept the time.',
                link: '#/fr/calendar'
            });

            await notifyPerson(row.customer_person_id, {
                kind: 'meeting',
                title: 'A meeting time has been suggested for you',
                body: 'From what you discussed with your representative. Open your calendar ' +
                      'to accept it or suggest another time.',
                link: '#/me/calendar'
            });
        }

        /* ---- CONFIRMING A DETAIL IS THE ONLY THING THAT WRITES TO THE RECORD ---- */
        if (action === 'confirm' && row.kind === 'detail' && row.field !== null) {
            const target = APPLY[row.field];

            if (target && row.new_value !== null) {
                const value = Number(row.new_value);

                if (!Number.isFinite(value) || value < 0) {
                    fail(400, 'That figure does not look right, so it was not saved.');
                }

                /* The row may not exist yet - a client who has never filled the
                   form in. Insert or update in one statement rather than checking
                   first.

                   target.column comes from the allow-list above and never from the
                   request, which is why it can be interpolated. */
                await q(
                    `INSERT INTO customer_finances (person_id, ${target.column})
                     VALUES (?, ?)
                     ON CONFLICT (person_id) DO UPDATE
                        SET ${target.column} = EXCLUDED.${target.column}`,
                    [row.customer_person_id, Math.round(value)]
                );

                applied = target.column;

                /* ---------------------------------------------------------
                   WRITE IT DOWN, WITH THE EVIDENCE

                   customer_finances holds only the CURRENT value. Without this
                   row, the answer to "why does it say ninety-five thousand when I
                   told you a hundred and ten" is that nobody knows - and there are
                   now three legitimate ways for that number to move, which is
                   exactly why the record has to say which one it was.

                   The QUOTE goes in. An entry saying "your representative changed
                   this from your call" that cannot show the words is not much
                   better than no entry. --------------------------------------- */
                await q(
                    `INSERT INTO finance_changes
                         (person_id, field, old_value, new_value, source, changed_by, quote)
                     VALUES (?, ?, ?, ?, 'ai', ?, ?)`,
                    [
                        row.customer_person_id,
                        target.column,
                        row.old_value,
                        String(Math.round(value)),
                        user.id,
                        row.quote
                    ]
                );

                /* ---------------------------------------------------------
                   AND TELL THE PERSON WHOSE RECORD IT IS

                   This is their money. A figure on their own record moving because
                   of something they said on a call, without them being told, is the
                   version of this feature that would rightly make somebody
                   uncomfortable - and it is the one the client cannot check,
                   because they were not the one who pressed Confirm.

                   The FIELD is named and the VALUE is not. A notification shows up
                   out of context in a list; "your annual income was updated" is
                   enough to act on and gives nothing away. --------------------- */
                await notifyPerson(row.customer_person_id, {
                    kind: 'finance',
                    title: 'A financial detail on your record was updated',
                    body: 'Your ' + target.column.replace(/_/g, ' ') +
                          ' was updated from something you discussed with your ' +
                          'representative. Open your details to check it, and correct it ' +
                          'yourself if it is wrong.',
                    link: '#/settings'
                });
            }
        }

        const updated = await one<InsightRow>(
            `UPDATE ai_insights
                SET status = ?, decided_by = ?, decided_at = now()
              WHERE id = ?
              RETURNING *`,
            [status, user.id, id]
        );

        await audit(user.id, 'insight_' + status,
            `person=${row.customer_person_id} kind=${row.kind} ` +
            `field=${row.field ?? '-'}${applied ? ' applied=' + applied : ''}`,
            req.ip);

        return ok({
            insight: view(updated ?? row),

            /* Named so the interface can say what actually changed, rather than
               claiming a record was updated when the field was not applicable. */
            applied,

            /* The appointment id, when one was created. The interface uses it to
               say "it is in the calendar" rather than only "noted". */
            booked
        });
    }

    /* -------------------------------------------------------------- analysing */
    const personId = String(req.body.person ?? '').trim();
    const source = String(req.body.source ?? 'chat').trim();
    const text = String(req.body.text ?? '');

    if (personId === '') { fail(400, 'Say which client.', 'person'); }

    if (!['chat', 'call', 'meeting'].includes(source)) {
        fail(400, 'A conversation is a chat, a call or a meeting.', 'source');
    }

    /* Either side may ask for the analysis of their own conversation - a client
       running it on their own chat is how their proposals get raised at all. */
    if (personId !== user.person_id) { await requireOwnClient(user, personId); }

    /* THE RELEVANCE GATE. Small talk produces nothing, with no model call and no
       rows written. This is what stops the assistant volunteering a recommendation
       in the middle of a conversation about the weather. */
    if (!worthAnalysing(text)) {
        return ok({ found: [], engine: 'rules', keyPoints: [], skipped: 'nothing-relevant' });
    }

    const findings = findByRules(text);
    const points = keyPoints(text);

    if (findings.length === 0) {
        return ok({ found: [], engine: 'rules', keyPoints: points });
    }

    const person = await one<{ first_name: string | null; name: string }>(
        'SELECT first_name, name FROM people WHERE id = ?', [personId]);

    const firstName = person ? (person.first_name ?? String(person.name).split(' ')[0]) : 'them';

    const polished = await polish(user.id, findings, firstName ?? 'them');

    /* What the record currently says, so a proposal can show the change rather
       than just the new value. Read once for all the detail findings. */
    const current = await one<{ annual_income: string | null; monthly_expenses: string | null }>(
        'SELECT annual_income, monthly_expenses FROM customer_finances WHERE person_id = ?',
        [personId]
    );

    const currentOf = (field: string): string | null => {
        if (field === 'annual_income') { return current?.annual_income ?? null; }
        if (field === 'monthly_expenses') { return current?.monthly_expenses ?? null; }
        return null;
    };

    const threadId = Math.trunc(Number(req.body.threadId)) || null;
    const roomCode = String(req.body.roomCode ?? '').slice(0, 12) || null;
    const scope = roomCode ?? String(threadId ?? 'none');

    const saved: ReturnType<typeof view>[] = [];

    for (const finding of polished.findings) {
        const oldValue = finding.field ? currentOf(finding.field) : null;

        /* NOTHING CHANGED, NOTHING TO PROPOSE. If the record already says what was
           heard, a proposal would be busywork for whoever has to read it. */
        if (finding.field && finding.newValue !== undefined && oldValue !== null
            && String(oldValue) === String(finding.newValue)) {
            continue;
        }

        const row = await one<InsightRow>(
            `INSERT INTO ai_insights
                 (customer_person_id, kind, source, thread_id, room_code,
                  field, old_value, new_value, note, quote, engine, fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (customer_person_id, fingerprint) DO UPDATE
                SET note   = EXCLUDED.note,
                    quote  = EXCLUDED.quote,
                    engine = EXCLUDED.engine
             RETURNING *`,
            [personId, finding.kind, source, threadId, roomCode,
                finding.field ?? null,
                oldValue === null ? null : String(oldValue).slice(0, 200),
                finding.newValue ?? null,
                finding.note.slice(0, 2000),
                finding.quote.slice(0, 2000),
                polished.engine,
                fingerprintOf(finding, scope)]
        );

        if (row) { saved.push(view(row)); }
    }

    /* =========================================================================
       AND NOW TELL SOMEBODY

       This is the half that was missing. The rows above were written correctly and
       then sat there: the only way to discover them was to open the client's
       profile, which nobody does speculatively. The bell - the one control a person
       presses to ask "has anything happened" - was counting a hard-coded activity
       feed and knew nothing about any of it.

       ONE NOTIFICATION FOR THE WHOLE PASS, NOT ONE PER FINDING. A call in which
       four things came up should ring the bell once and say "four things", not
       four times. A bell that fires per row trains people to ignore it.

       THE REPRESENTATIVE IS THE ONE TOLD. They are who decides - see the header.
       The client is deliberately NOT notified here: a message saying "a machine
       read your call and has proposals about your income" arriving before their
       representative has even looked at it would be alarming rather than useful,
       and the support rows are not theirs to see at all.

       NOTHING SENSITIVE IN THE TITLE. It says how many and whose conversation. Not
       what the figure was - a notification is the one piece of text that shows up
       out of context, in a list, and one day on a lock screen.

       `dedupe` KEYS ON THE CONVERSATION AND THE COUNT, so re-reading a growing
       transcript that turns up nothing new is silent, while a fifth finding
       appearing later legitimately rings again.
       ========================================================================= */
    if (saved.length > 0 && user.role === 'fr') {
        const firstNameSafe = firstName ?? 'your client';

        await notify({
            accountId: user.id,
            kind: 'insight',
            title: saved.length === 1
                ? `PRUWise noticed something in your ${source} with ${firstNameSafe}`
                : `PRUWise noticed ${saved.length} things in your ${source} with ${firstNameSafe}`,
            body: 'Nothing has changed on their record. Open their profile to confirm or ' +
                  'dismiss each one.',
            link: `#/fr/customer/${personId}`,
            insightId: saved[0]?.id ?? null,
            dedupe: `insight:${scope}:${saved.length}`
        });
    }

    return ok({ found: saved, engine: polished.engine, keyPoints: points });
});
