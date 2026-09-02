/* =============================================================================
   /api/consultation
       GET                                    ->  { requests }
       POST { repId, note }                   ->  { request }   customer asks
       POST { id, action: 'accept' }          ->  { message }   representative agrees
       POST { id, action: 'decline', reason } ->  { message }   representative declines
       POST { id, action: 'withdraw' }        ->  { message }   customer changes their mind

   "Please be my financial representative."
   -----------------------------------------------------------------------------
   Ported from php/api/consultation.php.

   =============================================================================
   WHY THIS IS A REQUEST AND NOT AN ASSIGNMENT
   =============================================================================

   The tempting shortcut is to set the customer's rep_id the moment they choose
   somebody. It is one UPDATE and the screen can say "done".

   It is also wrong. A representative can switch off "accepting new customers",
   and if choosing them assigned them anyway then that switch was never a rule -
   it was a suggestion. Representatives would find customers in their list without
   being asked, which is exactly what the availability setting exists to prevent.

   So nothing moves until the representative accepts. Until then the customer has
   NO representative at all - rep_id is NULL from signup - and the accept branch
   below is the only code in the app that fills it in.

   While they wait they are not stranded: PRUWise answers questions from the first
   minute, and js/app.js keeps them on the screens that work.

   =============================================================================
   WHAT THE REPRESENTATIVE RECEIVES
   =============================================================================

   The whole assessment: the derived profile, the policies we suggested, and the
   answers question by question. That is the point of the feature - when the
   consultation starts, the representative already knows what this person came for.

   They see it only for a request addressed to them. The query below goes through
   consultation_requests.rep_person_id, so there is no way to ask for somebody
   else's assessment: it is not that the request would be refused, it is that
   there is no parameter for it.
   ============================================================================= */

import { assessmentForAccount, assessmentJson } from '../_lib/assessment.js';
import { audit, requireLogin } from '../_lib/auth.js';
import { all, column, one, q, toIso, type Row } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { financesNeeds } from '../_lib/finances.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';

/* How many pending requests one customer may have at a time.

   ONE. Choosing a representative is a decision, not a broadcast - asking four
   people at once and taking whoever replies first is not how this should work,
   and it would leave three of them doing preparation for nothing. */
const MAX_PENDING = 1;

const REQUEST_SELECT = `
    SELECT r.*, c.name AS customer_name, c.first_name AS customer_first_name,
           c.email AS customer_email, rep.name AS rep_name
      FROM consultation_requests r
      JOIN people c   ON c.id = r.customer_person_id
      JOIN people rep ON rep.id = r.rep_person_id
`;


/* One request, shaped for whoever is reading it.

   withAssessment is only ever true for the representative the request was sent
   to. A customer already has their own assessment from /api/assessment and does
   not need it repeated inside every request. */
async function consultJson(row: Row, withAssessment = false): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {
        id: Number(row.id),
        status: row.status,
        note: row.note,
        declineReason: row.decline_reason,
        createdAt: toIso(row.created_at),
        resolvedAt: toIso(row.resolved_at),

        customerPersonId: row.customer_person_id,
        customerName: row.customer_name ?? null,

        repPersonId: row.rep_person_id,
        repName: row.rep_name ?? null
    };

    if (withAssessment && row.assessment_id) {
        /* Loaded per request rather than joined, because assessments.answers and
           .profile are JSONB columns and joining them onto a list means shipping
           the same blob repeatedly if a customer appears twice. A representative
           has a handful of pending requests, so a handful of small lookups is the
           cheaper and clearer option. */
        const assessment = await one('SELECT * FROM assessments WHERE id = ?',
            [Number(row.assessment_id)]);

        /* withAnswers: true - the point of the feature. See the header note. */
        out.assessment = assessmentJson(assessment, true);
    }

    return out;
}


/* =============================================================================
   THE REPRESENTATIVE'S REAL CUSTOMERS

   Everybody whose people.rep_id is this representative - which, for a
   self-registered customer, only ever happens through the accept branch below.

   The protection gap comes along, because it is what the list is sorted by and
   what makes the list useful rather than a phone book. It is calculated by
   financesNeeds(), the same function the customer's own dashboard uses, so the
   figure in the list is the figure on the profile is the figure the customer sees.

   ONE QUERY FOR ALL THE FINANCIAL RECORDS, not one per customer. Calling
   financesFor() in the loop would have been shorter to write and would have turned
   a list of twelve customers into thirteen queries.
   ============================================================================= */

interface CustomerListEntry {
    personId: string;
    name: string;
    firstName: string;
    segment: unknown;
    status: unknown;
    clientSince: unknown;
    hasAssessment: boolean;
    hasFinances: boolean;
    gap: number | null;
    ratio: number | null;
}

async function consultCustomers(repPersonId: string): Promise<CustomerListEntry[]> {
    const rows = await all(
        `SELECT p.id, p.name, p.first_name, p.segment, p.client_since, p.status,
                a.id AS account_id,
                (SELECT COUNT(*) FROM assessments s WHERE s.account_id = a.id) AS assessments
           FROM people p
           LEFT JOIN accounts a ON a.person_id = p.id
          WHERE p.kind = 'customer' AND p.rep_id = ?
          ORDER BY p.name`,
        [repPersonId]
    );

    if (rows.length === 0) { return []; }

    /* The financial records, in ONE query, selected by the same rule rather than
       by a list of ids.

       The PHP built `IN (?,?,?)` from the row count. That works, but the query
       text then changes shape with the data, and it needs the placeholder count
       and the parameter count to agree - which is exactly the arithmetic that goes
       wrong quietly. Joining back to people asks the same question with one
       parameter and no generated SQL. */
    const byPerson = new Map<string, Row>();

    const financeRows = await all(
        `SELECT f.* FROM customer_finances f
           JOIN people p ON p.id = f.person_id
          WHERE p.kind = 'customer' AND p.rep_id = ?`,
        [repPersonId]
    );

    for (const finances of financeRows) {
        byPerson.set(String(finances.person_id), finances);
    }

    const out: CustomerListEntry[] = rows.map(row => {
        const finances = byPerson.get(String(row.id)) ?? null;
        const needs = financesNeeds(finances);

        return {
            personId: String(row.id),
            name: String(row.name),
            firstName: String(row.first_name || row.name),
            segment: row.segment,
            status: row.status,
            clientSince: row.client_since,
            hasAssessment: Number(row.assessments) > 0,
            hasFinances: finances !== null,

            /* null, not 0, when there is nothing to calculate from. A list that
               shows "$0 gap" for somebody who has told us nothing invites the
               wrong conclusion. */
            gap: needs ? Number(needs.gap) : null,
            ratio: needs ? Number(needs.ratio) : null
        };
    });

    /* Biggest shortfall first, unknowns last: the same order the demo list uses,
       because it puts the most useful conversation at the top. */
    out.sort((a, b) => {
        if (a.gap === null && b.gap === null) { return a.name.localeCompare(b.name); }
        if (a.gap === null) { return 1; }
        if (b.gap === null) { return -1; }
        if (a.gap === b.gap) { return a.name.localeCompare(b.name); }
        return b.gap - a.gap;
    });

    return out;
}


export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not hold consultations. Use the requests queue.');
    }

    /* =====================================================================
       GET - the list, from whichever side is asking
       ===================================================================== */
    if (req.method === 'GET') {

        if (user.role === 'fr') {
            /* A representative's inbox. Pending first, then whatever they have
               already dealt with, newest first within each group.

               WHY RESOLVED ONES ARE STILL SENT: a dashboard that empties itself
               the moment you press Accept gives no confirmation that anything
               happened. A short tail of recent decisions is the receipt. */
            const rows = await all(
                `${REQUEST_SELECT}
                  WHERE r.rep_person_id = ?
                  ORDER BY (r.status = 'pending') DESC, r.created_at DESC
                  LIMIT 50`,
                [user.person_id]
            );

            const requests = [];
            for (const row of rows) {
                requests.push(await consultJson(row, true));
            }

            return ok({
                requests,
                pendingCount: Number(await column(
                    `SELECT COUNT(*) FROM consultation_requests
                      WHERE rep_person_id = ? AND status = 'pending'`,
                    [user.person_id]
                ) ?? 0),

                /* WHO IS ACTUALLY ON THEIR LIST, sent with the inbox rather than
                   from a separate endpoint.

                   The reason it belongs here: accepting a request is the ONLY
                   thing that adds somebody to a representative's list, and that
                   happens on this screen. Sending the new list back with the inbox
                   means the list is right immediately after an accept, with
                   nothing to invalidate and no second request to forget. */
                customers: await consultCustomers(user.person_id)
            });
        }

        /* A customer's own history. Short, because there is at most one pending
           and the rest is "what happened last time". */
        const rows = await all(
            `${REQUEST_SELECT}
              WHERE r.customer_person_id = ?
              ORDER BY r.created_at DESC
              LIMIT 20`,
            [user.person_id]
        );

        const requests = [];
        for (const row of rows) {
            requests.push(await consultJson(row));
        }

        return ok({
            requests,

            /* Who they are with right now, which is a different question from what
               they have asked for. The confirmation screen needs both. */
            currentRepId: user.rep_id
        });
    }

    /* ==================================================================== POST */
    req.requirePost();

    const action = req.field('action', '');


    /* =====================================================================
       A customer asking
       ===================================================================== */
    if (action === '' || action === 'request') {

        if (user.role !== 'customer') {
            fail(403, 'Only a customer can request a consultation.');
        }

        const repId = req.field('repId', '');

        if (repId === '') {
            fail(400, 'Choose a representative first.', 'repId');
        }

        /* The assessment is required, and not for bureaucratic reasons: the whole
           value of the request to the representative is the assessment attached
           to it. Without one this is just an unexplained approach. */
        const assessment = await assessmentForAccount(user.id);

        if (!assessment) {
            fail(400,
                'Please complete the Financial Needs Assessment first - it is what your ' +
                'representative reads before your first conversation.');
        }

        /* Re-check availability at the moment of the request, not just when the
           list was drawn. The list may be minutes old and the representative may
           have switched off in between - and if we skipped this, the availability
           rule would hold only for people who did not leave the tab open. */
        const rep = await one<{
            id: string;
            name: string;
            email: string | null;
            first_name: string | null;
            accepting_customers: boolean | null;
            max_customers: number | null;
            customer_count: string;
        }>(
            `SELECT p.id, p.name, p.email, p.first_name,
                    rp.accepting_customers, rp.max_customers,
                    (SELECT COUNT(*) FROM people c
                      WHERE c.rep_id = p.id AND c.kind = 'customer') AS customer_count
               FROM people p
               LEFT JOIN rep_profiles rp ON rp.person_id = p.id
              WHERE p.id = ? AND p.kind = 'fr' AND p.status = 'active'`,
            [repId]
        );

        if (!rep) {
            fail(404, 'That representative could not be found.', 'repId');
        }

        /* NULL means no preferences saved yet, which counts as available. */
        const accepting = rep.accepting_customers === null || rep.accepting_customers === true;

        if (!accepting) {
            fail(409, `${rep.name} is not accepting new customers at the moment. ` +
                'Please choose somebody else from the list.', 'repId');
        }

        if (rep.max_customers !== null
            && Number(rep.customer_count) >= Number(rep.max_customers)) {
            fail(409, `${rep.name} has reached their customer limit. ` +
                'Please choose somebody else from the list.', 'repId');
        }

        /* One at a time. See MAX_PENDING. */
        const pending = Number(await column(
            `SELECT COUNT(*) FROM consultation_requests
              WHERE customer_person_id = ? AND status = 'pending'`,
            [user.person_id]
        ) ?? 0);

        if (pending >= MAX_PENDING) {
            fail(409,
                'You already have a request waiting for a reply. Withdraw it first if you ' +
                'would rather ask somebody else.');
        }

        /* An optional line from the customer. Capped to match the column, and
           trimmed by field() - a note of forty spaces is not a note. */
        const note = req.field('note', '');

        if (note.length > 500) {
            fail(400, 'Please keep your note under 500 characters.', 'note');
        }

        /* RETURNING, so there is no lastInsertId() and no window between the
           insert and reading back what it made. */
        const created = await one<{ id: number }>(
            `INSERT INTO consultation_requests
                 (customer_person_id, rep_person_id, assessment_id, note)
             VALUES (?, ?, ?, ?)
             RETURNING id`,
            [user.person_id, repId, Number(assessment.id), note === '' ? null : note]
        );

        if (!created) {
            fail(500, 'That request could not be saved. Please try again.');
        }

        const id = Number(created.id);

        await audit(user.id, 'consultation_requested', `rep=${repId}`, req.ip);

        /* Tell the representative. An email rather than only a dashboard badge,
           because a request nobody notices for a week is the same as a decline,
           and this is somebody's first impression of PRUWise.

           Failure to send is not failure to request: the row is already committed
           and the dashboard will show it either way, so the return value is
           deliberately not checked. */
        const customerName = user.person_name || user.name;

        if (rep.email) {
            await sendMail(
                rep.email,
                `New customer request from ${customerName}`,
                emailLayout(
                    'A new customer would like to work with you',
                    [
                        `Hello ${rep.first_name ?? rep.name},`,
                        `${customerName} has completed the Financial Needs Assessment and ` +
                        'chosen you as their preferred financial representative.',
                        'Their assessment - what they are aiming for, how they feel about ' +
                        'risk, and the policies PRUWise suggested - is waiting on your ' +
                        'dashboard, so you can prepare before you speak.',
                        note === ''
                            ? 'They did not leave a note.'
                            : `They wrote: "${note}"`
                    ],
                    'Open your dashboard', `${env.appUrl}/index.html`,
                    'Nothing changes for this customer until you accept.'
                )
            );
        }

        const fresh = await one(`${REQUEST_SELECT} WHERE r.id = ?`, [id]);

        return ok({
            request: fresh ? await consultJson(fresh) : null,
            message: `Sent. ${rep.name} will see your assessment and get back to you.`
        });
    }


    /* =====================================================================
       Resolving one. Everything below needs the request, and needs to know it
       is still open.
       ===================================================================== */

    const id = req.field('id', 0);

    const request = await one(`${REQUEST_SELECT} WHERE r.id = ?`, [id]);

    if (!request) {
        fail(404, 'No request with that id.');
    }

    /* Already dealt with? Say which way it went. Two people looking at the same
       dashboard, or one person with two tabs, is normal - and "that was already
       accepted" is a far better answer than silently doing it twice. */
    if (request.status !== 'pending') {
        fail(409, `That request was already ${String(request.status)}.`);
    }

    const customerPersonId = String(request.customer_person_id);
    const customerName = String(request.customer_name);
    const customerFirstName = String(request.customer_first_name || request.customer_name);


    /* ------------------------------------------------------------- withdraw */
    if (action === 'withdraw') {

        if (user.person_id !== request.customer_person_id) {
            fail(403, 'That is not your request.');
        }

        const done = await q(
            `UPDATE consultation_requests
                SET status = 'withdrawn', resolved_at = now()
              WHERE id = ? AND status = 'pending'`,
            [id]
        );

        if (done.rowCount === 0) {
            fail(409, 'That request has just been dealt with somewhere else.');
        }

        await audit(user.id, 'consultation_withdrawn',
            `rep=${String(request.rep_person_id)}`, req.ip);

        return ok({ message: 'Withdrawn. You can choose a different representative now.' });
    }


    /* The two remaining actions belong to the representative the request was sent
       to - not to representatives in general. */
    if (user.role !== 'fr' || user.person_id !== request.rep_person_id) {
        fail(403, 'That request was not sent to you.');
    }


    /* --------------------------------------------------------------- accept */
    if (action === 'accept') {

        /* Capacity is checked here too, and for a reason that is easy to miss: a
           representative can be sent several requests while under their limit,
           then accept them one at a time. The limit has to hold at the moment of
           acceptance, not only at the moment of asking. */
        const profile = await one<{ accepting_customers: boolean; max_customers: number | null }>(
            'SELECT accepting_customers, max_customers FROM rep_profiles WHERE person_id = ?',
            [user.person_id]
        );

        if (profile && profile.max_customers !== null) {
            const count = Number(await column(
                `SELECT COUNT(*) FROM people WHERE rep_id = ? AND kind = 'customer'`,
                [user.person_id]
            ) ?? 0);

            if (count >= Number(profile.max_customers)) {
                fail(409,
                    `You are at your customer limit of ${Number(profile.max_customers)}. ` +
                    'Raise it in your profile settings, or decline this request.');
            }
        }

        /* Resolve the request FIRST, and let the WHERE clause do the locking. If
           two accepts arrive together, only one of them updates a row - the
           second sees rowCount 0 and stops before anything is moved. A
           read-then-write check could let both through. */
        const resolved = await q(
            `UPDATE consultation_requests
                SET status = 'accepted', resolved_at = now()
              WHERE id = ? AND status = 'pending'`,
            [id]
        );

        if (resolved.rowCount === 0) {
            fail(409, 'That request has just been dealt with somewhere else.');
        }

        /* =================================================================
           MOVING THE CUSTOMER: ONE STATEMENT, NOT A TRANSACTION

           The PHP opened a transaction here because it needed to read the
           customer's current rep_id, decide whether to move them, write the
           history row using the OLD value, and create the thread - four steps
           that must not half-apply.

           Postgres does all four in one statement. The CTEs share a single
           snapshot, so `prev` sees the rep_id from BEFORE the UPDATE in the same
           statement - which is exactly the old value the history row needs, and
           the reason no separate read is required.

             prev    the rep_id they had, read pre-update
             moved   the move itself, skipped when they are already with this
                     representative - which happens when somebody who changed
                     their mind twice ends up back where they started. Accepting
                     is still meaningful there (it confirms the relationship), but
                     an assignment from somebody to themselves would be noise.
             logged  the history row, written only if `moved` actually moved them.

                     request_id IS DELIBERATELY NULL. That column has a foreign key
                     to rep_change_requests, a different table with its own id
                     sequence. Putting a consultation_requests id in it would
                     either be rejected or, far worse, accepted while pointing at
                     an unrelated row.

             thread  a conversation to arrive into. ON CONFLICT DO NOTHING because
                     one may already exist; the unique key on the pair is what
                     makes this safe to call without checking first.

           The final SELECT reports the pre-update rep_id and the thread id, which
           is everything the code after it needs. COALESCE covers both cases: the
           thread we just made, or the one that was already there.
           ================================================================= */
        const outcome = await one<{
            from_rep_id: string | null;
            moved: string;
            thread_id: number | null;
        }>(
            `WITH prev AS (
                 SELECT rep_id AS from_rep_id FROM people WHERE id = ?
             ), moved AS (
                 UPDATE people SET rep_id = ?
                  WHERE id = ? AND rep_id IS DISTINCT FROM ?
              RETURNING id
             ), logged AS (
                 INSERT INTO rep_assignments
                     (customer_person_id, from_rep_id, to_rep_id, request_id)
                 SELECT ?::varchar, prev.from_rep_id, ?::varchar, NULL
                   FROM prev
                  WHERE EXISTS (SELECT 1 FROM moved)
              RETURNING id
             ), fresh_thread AS (
                 INSERT INTO threads
                     (kind, fr_person_id, customer_person_id, last_message_at)
                 VALUES ('human', ?, ?, now())
                 ON CONFLICT DO NOTHING
              RETURNING id
             )
             SELECT prev.from_rep_id,
                    (SELECT COUNT(*) FROM moved)  AS moved,
                    (SELECT COUNT(*) FROM logged) AS logged,
                    COALESCE(
                        (SELECT id FROM fresh_thread),
                        (SELECT id FROM threads
                          WHERE kind = 'human'
                            AND fr_person_id = ?
                            AND customer_person_id = ?)
                    ) AS thread_id
               FROM prev`,
            [
                customerPersonId,                       /* prev */
                user.person_id, customerPersonId, user.person_id,   /* moved */
                customerPersonId, user.person_id,       /* logged */
                user.person_id, customerPersonId,       /* fresh_thread */
                user.person_id, customerPersonId        /* the COALESCE fallback */
            ]
        );

        /* No row from `prev` means the customer disappeared between the two
           statements - a deleted account, which cascades. The request is already
           marked accepted and there is nobody to assign, so say so plainly rather
           than reporting a success that did not happen. */
        if (!outcome) {
            fail(409, 'That customer no longer exists.');
        }

        /* The line that announces the relationship. This used to be written at
           signup, where it was simply untrue - it named a representative the
           customer had never chosen. Here it is true by construction.

           Only on a FIRST assignment. A customer moving between representatives
           gets the thread but not a "welcome to PRUWise" they have already read. */
        if (outcome.from_rep_id === null && outcome.thread_id !== null) {
            await q(
                `INSERT INTO messages (thread_id, sender_kind, body)
                 VALUES (?, 'system', ?)`,
                [
                    Number(outcome.thread_id),
                    `${user.person_name} is now your financial representative. ` +
                    'They have read your Financial Needs Assessment, so you can start from ' +
                    'where you actually are. Ask them anything here.'
                ]
            );
        }

        await audit(user.id, 'consultation_accepted', `customer=${customerPersonId}`, req.ip);

        if (request.customer_email) {
            await sendMail(
                String(request.customer_email),
                `${user.person_name} has accepted your consultation request`,
                emailLayout(
                    'You have a financial representative',
                    [
                        `Hello ${customerFirstName},`,
                        `${user.person_name} has accepted your request and is now your ` +
                        'financial representative.',
                        'They have already read your Financial Needs Assessment, so your ' +
                        'first conversation can start from where you actually are rather ' +
                        'than from the beginning.',
                        'You can message them, book an appointment or start a video ' +
                        'consultation from PRUWise whenever you are ready.'
                    ],
                    'Open PRUWise', `${env.appUrl}/index.html`,
                    'Recommendations in PRUWise are a starting point for a conversation, ' +
                    'not financial advice.'
                )
            );
        }

        return ok({
            message: `Accepted. ${customerName} is now one of your customers.`
        });
    }


    /* -------------------------------------------------------------- decline */
    if (action === 'decline') {

        const reason = req.field('reason', '');

        /* A reason is required, and it is shown to the customer.

           Same rule the admin queue uses for a declined change request, for the
           same reason: a silent no is the single most frustrating outcome, and ten
           characters is a low bar for basic courtesy. */
        if (reason.length < 10) {
            fail(400,
                'Please give a short reason - at least 10 characters. The customer sees it.',
                'reason');
        }

        if (reason.length > 200) {
            fail(400, 'Please keep the reason under 200 characters.', 'reason');
        }

        const done = await q(
            `UPDATE consultation_requests
                SET status = 'declined', decline_reason = ?, resolved_at = now()
              WHERE id = ? AND status = 'pending'`,
            [reason, id]
        );

        if (done.rowCount === 0) {
            fail(409, 'That request has just been dealt with somewhere else.');
        }

        await audit(user.id, 'consultation_declined', `customer=${customerPersonId}`, req.ip);

        if (request.customer_email) {
            await sendMail(
                String(request.customer_email),
                'About your consultation request',
                emailLayout(
                    'Your request could not be taken up',
                    [
                        `Hello ${customerFirstName},`,
                        `${user.person_name} is not able to take on your request at the moment.`,
                        `Reason given: ${reason}`,
                        'Your assessment is saved, so choosing somebody else takes one click - ' +
                        'you will not have to answer anything again. Your existing ' +
                        'representative continues to look after you in the meantime.'
                    ],
                    'Choose another representative', `${env.appUrl}/index.html`,
                    'Nothing about your cover or premiums is affected.'
                )
            );
        }

        return ok({
            message: `Declined, and ${customerName} has been told why.`
        });
    }

    fail(400, `Unknown action "${action}".`);
});
