/* =============================================================================
   /api/assessment
       GET                          ->  { questions, assessment, requests,
                                          finances, needs, onboardingSeen }
       POST { answers: { ... } }     ->  { assessment, reps, onboardingSeen }
       POST { action: 'dismiss' }    ->  { onboardingSeen: true }
   -----------------------------------------------------------------------------
   Ported from php/api/assessment.php.

   =============================================================================
   WHY THE ANSWERS COME BACK SCORED IN THE SAME RESPONSE
   =============================================================================

   The obvious design is POST the answers, then GET the result. That is one extra
   round trip at the exact moment somebody is waiting to see what we made of them
   - and worse, it invites a second scoring run, so the screen could show
   something subtly different from what was saved. Save once, return what was
   saved.

   The matched representatives ride along for the same reason: the flow goes
   straight from the results to choosing somebody, every time.

   WHY CUSTOMERS ONLY. A representative has no needs assessment, and an
   administrator is not a customer of the business. Letting either POST here would
   create rows nothing knows how to display. A 403 rather than a quiet no-op,
   because a request that cannot succeed should say so.
   ============================================================================= */

import {
    assessmentForAccount, assessmentJson, assessmentSave,
    cleanAnswers, matchReps, QUESTIONS, type Profile
} from '../_lib/assessment.js';
import { audit, requireLogin } from '../_lib/auth.js';
import { all, q, toIso } from '../_lib/db.js';
import { financesFor, financesJson } from '../_lib/finances.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role !== 'customer') {
        fail(403, 'The needs assessment is for customers.');
    }

    /* =====================================================================
       GET - the questions, and whatever they have already answered

       Both in one response, because the screen needs both to decide what to
       draw: no assessment means start at question one, an existing one means
       offer the result with the option to retake.

       The questions are sent even when an assessment exists. A retake starts
       from a blank form ON PURPOSE - pre-filling a year-old answer invites
       people to click through without reading, and the whole point of retaking
       is that something changed.
       ===================================================================== */
    if (req.method === 'GET') {
        const existing = await assessmentForAccount(user.id);

        /* THE CONSULTATION REQUESTS ARE BUNDLED, and so is the financial record.

           The customer dashboard needs all of it - the assessment to show the
           profile, the request status to answer "what happens now", and the
           figures for the protection analysis. As separate endpoints that was
           three round trips on the slowest screen in the app. They are always
           wanted together, so they travel together.

           Kept short deliberately: the newest few, not a history. */
        const requestRows = await all<Record<string, unknown>>(
            `SELECT r.id, r.status, r.decline_reason, r.created_at,
                    r.rep_person_id, rep.name AS rep_name
               FROM consultation_requests r
               JOIN people rep ON rep.id = r.rep_person_id
              WHERE r.customer_person_id = ?
              ORDER BY (r.status = 'pending') DESC, r.created_at DESC
              LIMIT 5`,
            [user.person_id]
        );

        const requests = requestRows.map(row => ({
            id: Number(row.id),
            status: row.status,
            declineReason: row.decline_reason,
            repPersonId: row.rep_person_id,
            repName: row.rep_name,
            createdAt: toIso(row.created_at)
        }));

        /* `needs` is the protection analysis calculated by the same function the
           representative's view of this customer calls, so the two screens can
           never show different numbers for the same person. */
        const shaped = financesJson(await financesFor(user.person_id));

        return ok({
            questions: QUESTIONS,

            /* Their own assessment, so answers are included - it is their own
               data, and the "you told us" summary reads it. */
            assessment: assessmentJson(existing, true),

            requests,
            finances: shaped.finances,
            needs: shaped.needs,

            onboardingSeen: user.onboarding_seen === true
        });
    }

    req.requirePost();

    /* =====================================================================
       POST { action: 'dismiss' } - "Skip for now"

       All this does is stop the full-screen welcome coming back. It deliberately
       does NOT record a refusal: the dashboard still offers the assessment,
       quietly, and somebody who skipped on Monday can take it on Friday without
       anything having to be undone.

       Checked BEFORE the answers branch, because a dismiss carries no answers
       and falling through to validation would reject it for the wrong reason.
       ===================================================================== */
    if (req.field('action', '') === 'dismiss') {
        await q('UPDATE accounts SET onboarding_seen = true WHERE id = ?', [user.id]);

        return ok({ onboardingSeen: true });
    }

    /* =====================================================================
       POST { answers } - score it and store it
       ===================================================================== */
    const submitted = req.field<unknown>('answers', null);

    /* One function decides whether this is acceptable, and it is the same
       function that knows what the questions are: anything not asked for is
       dropped, and anything not offered is refused.

       The `field` in the failure names the question that was wrong, so the form
       can jump back to it rather than showing a message at the top of a
       seven-step wizard with no clue which step to fix. */
    const checked = cleanAnswers(submitted);

    if (checked.error) {
        fail(400, checked.error, checked.field ?? null);
    }

    const answers = checked.answers!;

    /* The person id is passed so the scoring can prefer the premium budget they
       saved in Settings over the bracket they just ticked. */
    const row = await assessmentSave(user.id, answers, user.person_id);

    if (!row) {
        fail(500, 'The assessment was scored but could not be saved. Please try again.');
    }

    /* Finishing the assessment also means the welcome screen has done its job.
       Without this, somebody who completed it would be greeted as brand new the
       next time they signed in. */
    await q('UPDATE accounts SET onboarding_seen = true WHERE id = ?', [user.id]);

    await audit(user.id, 'assessment_completed',
        `goal=${String(answers.goal)} risk=${String(answers.risk)} cover=${String(answers.cover)}`,
        req.ip);

    const assessment = assessmentJson(row, true);

    return ok({
        assessment,

        /* Who we would put in front of them, already filtered by who is actually
           accepting new customers - availability is a rule in matchReps(), not a
           badge. */
        reps: await matchReps(assessment?.profile as Profile),

        onboardingSeen: true
    });
});
