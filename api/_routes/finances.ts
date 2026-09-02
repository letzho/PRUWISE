/* =============================================================================
   /api/finances
       GET                 ->  my own record and the needs calculation on it
       GET ?personId=x     ->  a customer's record, for THEIR representative only
       POST { ...fields }  ->  save my own record
   -----------------------------------------------------------------------------
   Ported from php/api/finances.php.

   =============================================================================
   WHO MAY READ WHAT
   =============================================================================

   This is the most sensitive endpoint in the project. It holds somebody's income,
   savings, CPF balance and mortgage - the exact set of numbers a stranger would
   most like to have. So the rules are short and enforced here, not in the browser:

     A CUSTOMER reads and writes their own record. There is no parameter that lets
     them name anybody else - a customer's personId comes from their session and
     the ?personId= argument is IGNORED ENTIRELY for them. Not refused: ignored,
     so there is nothing to probe.

     A REPRESENTATIVE reads the record of a customer whose people.rep_id is them,
     and writes nothing. Ever. These are the customer's own figures and a
     representative editing them would make the record worthless as a statement of
     what the customer actually said.

     AN ADMIN gets nothing. Administrators manage accounts, they are not in the
     advisory relationship, and there is no reason for a support function to read
     somebody's savings.

   A REQUEST FOR SOMEBODY ELSE'S CUSTOMER RETURNS 404, NOT 403. A 403 would
   confirm the person exists. From outside, "not yours" and "not real" must look
   the same.
   ============================================================================= */

import { assessmentForAccount, assessmentSave } from '../_lib/assessment.js';
import { audit, requireLogin } from '../_lib/auth.js';
import { one } from '../_lib/db.js';
import {
    FIELDS, financeChanges, financesFor, financesJson, financesNeeds, financesSave
} from '../_lib/finances.js';
import { notifyPerson } from '../_lib/notify.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, "Administrators do not have access to customers' financial records.");
    }

    /* ===================================================================== GET */
    if (req.method === 'GET') {

        /* ------------------------------------------- a customer, themselves

           ?personId is not consulted at all. Reading it and comparing would be a
           second place for the rule to live, and one day the comparison would be
           the wrong way round. */
        if (user.role === 'customer') {
            const shaped = financesJson(await financesFor(user.person_id));

            /* THE CHANGE LOG COMES WITH THE RECORD.

               Not a separate endpoint. The log is only ever read next to the
               figures it describes - "why does this say ninety-five thousand" is a
               question asked while looking at the number - and a second request
               would mean the two could be a moment out of step with each other.

               THE CUSTOMER READS THEIR OWN. There is no version of this where the
               person whose money it is is the party not allowed to see who changed
               it. */
            return ok({
                ...shaped,
                editable: true,
                whose: 'self',
                changes: await financeChanges(user.person_id)
            });
        }

        /* --------------------------- a representative, one of their customers */
        const personId = req.query('personId');

        if (personId === '') {
            fail(400, 'Say which customer you mean.', 'personId');
        }

        /* ONE QUERY does the existence check AND the ownership check together, so
           there is no window between them and no way to tell the two failures
           apart. kind = 'customer' is in there as well: a representative has no
           business reading another representative's record through this route. */
        const customer = await one<{ id: string; name: string; first_name: string | null }>(
            `SELECT id, name, first_name FROM people
              WHERE id = ? AND kind = 'customer' AND rep_id = ?`,
            [personId, user.person_id]
        );

        if (!customer) {
            fail(404, 'That customer could not be found.');
        }

        const shaped = financesJson(await financesFor(personId));

        /* Read-only, and the browser is told so it can render the panel without an
           edit button rather than offering one that would be refused. The refusal
           below is what actually enforces it. */
        return ok({
            ...shaped,
            editable: false,
            whose: 'customer',
            customerName: customer.name,
            firstName: customer.first_name ?? customer.name,

            /* The representative sees the log too, for a client of theirs. They are
               one of the three parties who can move these figures, so "when did
               this change and was it me" is a question they will have - and an
               'ai' entry they confirmed themselves is the one they are most likely
               to be asked about. */
            changes: await financeChanges(personId)
        });
    }

    /* =====================================================================
       POST - the customer updating their own figures
       ===================================================================== */
    req.requirePost();

    if (user.role !== 'customer') {
        fail(403,
            'Only the customer can change their own financial details. If something here is ' +
            'wrong, ask them to correct it in their settings - a record you edited would no ' +
            'longer be a statement of what they told you.');
    }

    /* Accept either { finances: {...} } or the fields at the top level. Two
       shapes, one handler, and neither is wrong. */
    let payload = req.field<Record<string, unknown> | null>('finances', null);

    if (typeof payload !== 'object' || payload === null) {
        payload = {};

        for (const key of Object.keys(FIELDS)) {
            if (req.has(key)) { payload[key] = req.body[key]; }
        }
    }

    if (Object.keys(payload).length === 0) {
        fail(400, 'No figures were received.');
    }

    /* SIGNED, so the change log can say who and how. 'self' is the customer
       editing their own record, which is the only route this endpoint allows -
       see the refusal above. */
    const problem = await financesSave(user.person_id, payload,
        { accountId: user.id, source: 'self' });

    if (problem !== null) {
        fail(400, problem);
    }

    /* Audited WITHOUT the values. That somebody updated their financial record is
       worth knowing; writing their income into the audit log would put it
       somewhere with different access rules from the table that is supposed to
       hold it. */
    await audit(user.id, 'finances_updated', `${Object.keys(payload).length} field(s)`, req.ip);

    /* =====================================================================
       THE RECOMMENDATIONS ARE READY THE MOMENT THE FIGURES ARE IN

       "Give recommendations right after the client submits their financial
       details" was the ask, and this is where it happens - but it happens by
       TELLING THE REPRESENTATIVE, not by putting a product in front of the client.

       ==================================================================
       WHY THE CLIENT IS NOT THE ONE NOTIFIED
       ==================================================================

       The shortlist is COMPUTED - fit scores, gap arithmetic, comparisons. A
       computed recommendation reaching a client unreviewed would be a machine
       advising on insurance in a licensed person's name, which is the one rule this
       whole application is built around: the representative vetoes and decides,
       and /api/recommendations enforces it on the server.

       So the client's act of filling in the form now produces something
       immediately: their representative is told, with a link that opens their
       shortlist, so nothing waits for the representative to happen to look. The
       delay this removes was never computation - it was somebody noticing.

       ONLY WHEN THERE IS ENOUGH TO WORK FROM. Every line of the needs calculation
       derives from income, so without one there is no shortlist and a notification
       would be an invitation to look at nothing. financesNeeds() returning null is
       exactly that test, in the same function every screen uses.
       ===================================================================== */
    if (user.rep_id) {
        const needs = financesNeeds(await financesFor(user.person_id));

        if (needs) {
            const firstName = String(user.name ?? '').split(' ')[0] || 'Your client';

            await notifyPerson(user.rep_id, {
                kind: 'insight',
                title: `${firstName} has filled in their financial details`,
                body: 'Their protection gap has been calculated and a shortlist is ready to ' +
                      'review. Nothing has been shown to them.',
                link: `#/fr/recommendations?person=${user.person_id}`,

                /* ONE NOTIFICATION PER PERSON, NOT PER SAVE. Somebody working
                   through fourteen boxes may press Save four times, and four
                   identical rows in the bell is the behaviour that teaches people
                   to ignore it. A dedupe key with no timestamp in it means the
                   second save is silent - which is right, because "their figures
                   are in" only becomes true once. */
                dedupe: `finances-ready:${user.person_id}`
            });
        }
    }

    /* =====================================================================
       RE-SCORE THE ASSESSMENT WHEN THE BUDGET CHANGES

       assessmentBudget() prefers the premium budget typed here over the bracket
       ticked in the questionnaire, and the scored profile is STORED - it is not
       recalculated every time it is read. So changing this figure and doing
       nothing else would leave the recommendations arguing with the record they
       came from: "$120 a month" in Settings, next to a plan chosen for somebody
       with $400.

       Only when premiumBudget was actually part of this save, and only when there
       is an assessment to re-score. The ANSWERS ARE UNCHANGED - they are read back
       and fed in again - so this cannot alter what the customer said, only what we
       concluded from it.
       ===================================================================== */
    if (Object.prototype.hasOwnProperty.call(payload, 'premiumBudget')) {
        const existing = await assessmentForAccount(user.id);

        if (existing) {
            const stored = existing.answers;

            const answers = typeof stored === 'string'
                ? (() => { try { return JSON.parse(stored); } catch { return null; } })()
                : stored;

            /* If the stored answers cannot be read there is nothing safe to
               re-score from, and inventing answers would be worse than a stale
               profile. Left alone deliberately. */
            if (answers && typeof answers === 'object' && Object.keys(answers).length > 0) {
                await assessmentSave(user.id, answers as Record<string, string | string[]>,
                    user.person_id);
            }
        }
    }

    const shaped = financesJson(await financesFor(user.person_id));

    return ok({
        ...shaped,
        editable: true,
        whose: 'self',
        message: 'Saved. Your protection figures have been recalculated.'
    });
});
