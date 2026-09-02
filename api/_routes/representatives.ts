/* =============================================================================
   /api/representatives
       GET                     ->  { reps, matched }   who we suggest
       GET ?id=fr-001          ->  { rep }             one profile
       GET ?me=1               ->  { rep }             a rep's own settings
       POST { ...settings }    ->  { rep }             a rep editing them
   -----------------------------------------------------------------------------
   Ported from php/api/representatives.php.

   =============================================================================
   THE ONE RULE THIS FILE EXISTS TO ENFORCE
   =============================================================================

   A representative who has switched off "accepting new customers" is not offered
   to anybody. Not ranked last, not greyed out - absent.

   That is the whole point of the setting. Offering somebody who has said no
   produces the worst possible outcome for a customer: they choose, they wait, and
   nobody comes. The filtering lives in matchReps() so that this endpoint and any
   future caller cannot disagree about it.

   Capacity is treated identically. Being available is not the same as having
   room, and a representative with 40 customers who forgot to switch the flag off
   is still not able to take a 41st properly.
   ============================================================================= */

import {
    assessmentForAccount, assessmentJson, matchReps,
    repProfileJson, type Profile
} from '../_lib/assessment.js';
import { audit, requireLogin } from '../_lib/auth.js';
import { one, q, type Row } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

/* Everything either audience needs about one representative, in one query.

   customer_count is a subquery rather than a GROUP BY join because there is a
   WHERE on the outer table: counting with a LEFT JOIN and then grouping works,
   but it reads as though the count could be affected by the filter, and the next
   person to touch it has to prove to themselves that it is not. */
async function repRow(personId: string): Promise<Row | null> {
    return one(
        `SELECT p.id, p.name, p.email,
                rp.accepting_customers, rp.headline, rp.bio,
                rp.specialisations, rp.languages, rp.years_experience, rp.max_customers,
                (SELECT COUNT(*) FROM people c
                  WHERE c.rep_id = p.id AND c.kind = 'customer') AS customer_count
           FROM people p
           LEFT JOIN rep_profiles rp ON rp.person_id = p.id
          WHERE p.id = ? AND p.kind = 'fr'`,
        [personId]
    );
}

/* Specialisations and languages arrive as arrays of short strings. One helper so
   both are treated the same way and the rules are stated once. */
function cleanTagList(
    value: unknown,
    label: string,
    field: string,
    maxItems = 8,
    maxLength = 60
): string[] {
    /* A comma-separated string is what a plain text input gives you, and it is a
       reasonable thing to send. */
    if (typeof value === 'string') { value = value.split(','); }

    if (!Array.isArray(value)) {
        fail(400, `Send ${label} as a list.`, field);
    }

    const clean: string[] = [];

    for (const item of value) {
        if (typeof item !== 'string') { continue; }

        const trimmed = item.trim();
        if (trimmed === '') { continue; }

        if (trimmed.length > maxLength) {
            fail(400, `Each entry in ${label} should be ${maxLength} characters or fewer.`, field);
        }

        /* Case-insensitive duplicate check, so "Retirement" and "retirement" are
           one entry rather than two. */
        const lower = trimmed.toLowerCase();
        if (!clean.some(existing => existing.toLowerCase() === lower)) {
            clean.push(trimmed);
        }
    }

    if (clean.length > maxItems) {
        fail(400, `Please list at most ${maxItems} ${label}.`, field);
    }

    return clean;
}


export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* ===================================================================== GET */
    if (req.method === 'GET') {

        /* ------------------------------------------------------------- ?me=1

           A representative's own settings, including the things nobody else
           sees: how many customers they have, and what their own limit is. */
        if (req.query('me') !== '') {
            if (user.role !== 'fr') {
                fail(403, 'Only a financial representative has a representative profile.');
            }

            const row = await repRow(user.person_id);

            if (!row) {
                fail(404, 'Your representative record could not be found.');
            }

            return ok({ rep: repProfileJson(row) });
        }

        /* --------------------------------------------------------------- ?id=

           One profile, for the "View Profile" panel.

           AVAILABILITY IS NOT HIDDEN HERE, unlike in the list. A customer who
           already has this representative, or who followed a link, should see the
           honest answer - including "not currently accepting new customers". The
           list is a recommendation and must not include them; a page asked for by
           name is information, and pretending the person does not exist would be
           worse. */
        const id = req.query('id');

        if (id !== '') {
            const row = await repRow(id);

            if (!row) {
                fail(404, 'No representative with that id.');
            }

            return ok({ rep: repProfileJson(row) });
        }

        /* ------------------------------------------------- the matched list */
        if (user.role !== 'customer') {
            fail(403, 'Only a customer is matched with a representative.');
        }

        const existing = await assessmentForAccount(user.id);

        if (existing) {
            const assessment = assessmentJson(existing);

            return ok({
                reps: await matchReps(assessment?.profile as Profile),
                matched: true
            });
        }

        /* No assessment yet, and THIS IS NOT AN ERROR: somebody who pressed
           "Skip for now" may still want to see who is available, and a customer
           whose representative is unavailable needs a list whether or not they
           ever answered seven questions.

           So: the same list, unranked, with a flag saying it was not
           personalised. A neutral profile is used rather than a special code
           path, because then the availability and capacity rules are applied by
           exactly the same function as everywhere else. */
        const neutral = {
            primaryGoal: 'protection',
            protectionNeed: 'medium',
            riskLevel: 'moderate',
            experience: 'beginner',
            concern: ''
        } as unknown as Profile;

        return ok({
            reps: await matchReps(neutral, 8),
            matched: false
        });
    }

    /* =====================================================================
       POST - a representative editing their own profile

       THERE IS NO ID IN THIS REQUEST, AND THAT IS DELIBERATE. The row written is
       always the caller's own, taken from the session. An endpoint that accepted
       "which profile to edit" would need a permission check to stop a
       representative editing a colleague's availability, and the safest
       permission check is not having the parameter at all.
       ===================================================================== */
    req.requirePost();

    if (user.role !== 'fr') {
        fail(403, 'Only a financial representative can edit a representative profile.');
    }

    /* Availability. field() with a boolean fallback coerces true / "true" / 1 /
       "1", and anything else is false. Defaulting an unrecognised value to
       "accepting" would be the wrong way round: if we cannot tell what somebody
       meant, do not start sending them customers. */
    const accepting = req.field('acceptingCustomers', false);

    const headline = req.field('headline', '');
    const bio = req.field('bio', '');

    /* Length limits match the columns - headline is VARCHAR(160), so 160 is the
       honest limit rather than a number invented here. */
    if (headline.length > 160) {
        fail(400, 'Keep the headline to 160 characters or fewer.', 'headline');
    }
    if (bio.length > 2000) {
        fail(400, 'That description is too long. Keep it under 2000 characters.', 'bio');
    }

    /* Years of experience. Bounded here as well as in the column, because the
       column would otherwise enforce it with an error nobody can read. */
    const yearsRaw = req.field<unknown>('yearsExperience', null);
    let years: number | null = null;

    if (yearsRaw !== null && yearsRaw !== '') {
        years = Math.round(Number(yearsRaw));

        if (!Number.isFinite(years) || years < 0 || years > 60) {
            fail(400, 'Years of experience should be between 0 and 60.', 'yearsExperience');
        }
    }

    /* Capacity. Blank means NO LIMIT, which is why null and 0 have to be told
       apart: a limit of 0 would mean "never offer me to anybody", which is what
       the availability switch is for. */
    const maxRaw = req.field<unknown>('maxCustomers', null);
    let max: number | null = null;

    if (maxRaw !== null && maxRaw !== '') {
        max = Math.round(Number(maxRaw));

        if (!Number.isFinite(max) || max < 1 || max > 999) {
            fail(400,
                'A customer limit should be between 1 and 999, or left blank for no limit.',
                'maxCustomers');
        }
    }

    /* Not sent at all means "leave it alone". An empty array means "clear it",
       which is a real and different choice. */
    const specialisations = req.has('specialisations')
        ? cleanTagList(req.body.specialisations, 'specialisations', 'specialisations')
        : null;

    const languages = req.has('languages')
        ? cleanTagList(req.body.languages, 'languages', 'languages')
        : null;

    /* ON CONFLICT DO UPDATE, because a representative created by an administrator
       has no rep_profiles row until the first time they save one. A plain UPDATE
       would silently affect nothing and report success, which is the most annoying
       kind of bug: the form says saved, the profile stays empty.

       COALESCE on the two list columns keeps whatever is already stored when the
       field was not sent at all. That lets the availability switch be saved on its
       own without wiping the specialisations. */
    await q(
        `INSERT INTO rep_profiles
             (person_id, accepting_customers, headline, bio, specialisations,
              languages, years_experience, max_customers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (person_id) DO UPDATE
            SET accepting_customers = EXCLUDED.accepting_customers,
                headline            = EXCLUDED.headline,
                bio                 = EXCLUDED.bio,
                specialisations     = COALESCE(EXCLUDED.specialisations, rep_profiles.specialisations),
                languages           = COALESCE(EXCLUDED.languages, rep_profiles.languages),
                years_experience    = EXCLUDED.years_experience,
                max_customers       = EXCLUDED.max_customers`,
        [
            user.person_id,
            accepting,
            headline === '' ? null : headline,
            bio === '' ? null : bio,
            specialisations === null ? null : JSON.stringify(specialisations),
            languages === null ? null : JSON.stringify(languages),
            years,
            max
        ]
    );

    /* Worth an audit entry. Availability decides whether new customers are routed
       to this person, so "why did I stop getting requests" needs an answer. */
    await audit(user.id, 'rep_profile_saved',
        `accepting=${accepting ? 1 : 0}${max === null ? '' : ` max=${max}`}`, req.ip);

    const saved = await repRow(user.person_id);

    return ok({
        rep: saved ? repProfileJson(saved) : null,
        message: accepting
            ? 'Saved. You are shown to new customers looking for a representative.'
            : 'Saved. You will not be offered to new customers until you switch this back on.'
    });
});
