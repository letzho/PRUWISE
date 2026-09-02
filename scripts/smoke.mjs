/* =============================================================================
   scripts/smoke.mjs  -  end-to-end check against the deployed site
   -----------------------------------------------------------------------------
   Proves the whole chain works: static frontend, function, database, password
   verification, session cookie, and reading that session back.

       node scripts/smoke.mjs https://pruwise.vercel.app

   Deliberately uses only the public HTTP surface - no database credentials, no
   Vercel token. It tests what a browser would experience.
   ============================================================================= */

const base = (process.argv[2] ?? 'https://pruwise.vercel.app').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${label}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? '  -> ' + detail : ''}`); }
}

async function main() {
    console.log(`\nSmoke test against ${base}\n`);

    /* ---------------------------------------------------------- 1. frontend */
    const page = await fetch(base);
    const html = await page.text();

    check('index.html responds 200', page.status === 200, `got ${page.status}`);
    check('it is the PRUWise app', html.includes('AI Insurance Navigator'));
    check('assets carry a cache buster', /\.css\?v=\d/.test(html));

    /* --------------------------------------------------- 2. session, signed out */
    const anon = await fetch(`${base}/api/session`);
    const anonBody = await anon.json().catch(() => null);

    check('GET /api/session responds 200 when signed out',
        anon.status === 200, `got ${anon.status}`);
    check('and reports nobody signed in',
        anonBody !== null && anonBody.ok === true && anonBody.account === null,
        JSON.stringify(anonBody)?.slice(0, 160));

    /* ------------------------------------------------------ 3. a bad password */
    const bad = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sarah.tan', password: 'definitely-wrong' })
    });
    const badBody = await bad.json().catch(() => null);

    check('a wrong password is refused with 401',
        bad.status === 401, `got ${bad.status}`);
    check('and does not say which half was wrong',
        badBody?.error === 'That username or password is not recognised.',
        badBody?.error);

    /* ------------------------------------------------------ 4. a real login */
    const good = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sarah.tan', password: 'studsarah' })
    });
    const goodBody = await good.json().catch(() => null);

    check('the right password signs in', good.status === 200,
        `got ${good.status}: ${JSON.stringify(goodBody)?.slice(0, 200)}`);
    check('the account comes back', goodBody?.account?.username === 'sarah.tan',
        JSON.stringify(goodBody?.account)?.slice(0, 160));
    check('with the customer role', goodBody?.account?.role === 'customer');
    check('and the seeded person id', goodBody?.account?.personId === 'cus-001');
    check('hasSampleProfile is true for a seeded customer',
        goodBody?.account?.hasSampleProfile === true);

    const setCookie = good.headers.get('set-cookie') ?? '';

    check('a session cookie is set', setCookie.includes('pruwise_session'));
    check('the cookie is HttpOnly', /HttpOnly/i.test(setCookie));
    check('the cookie is Secure in production', /Secure/i.test(setCookie));
    check('the cookie is SameSite=Lax', /SameSite=Lax/i.test(setCookie));

    /* ------------------------------------------- 5. the session reads back */
    const token = /pruwise_session=([^;]+)/.exec(setCookie)?.[1];

    check('the cookie has a value', typeof token === 'string' && token.length > 20);

    const me = await fetch(`${base}/api/session`, {
        headers: { Cookie: `pruwise_session=${token}` }
    });
    const meBody = await me.json().catch(() => null);

    check('the session is recognised on the next request',
        meBody?.account?.username === 'sarah.tan',
        JSON.stringify(meBody?.account)?.slice(0, 160));

    /* ----------------------------------------------------------- 6. logout */
    const out = await fetch(`${base}/api/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `pruwise_session=${token}` },
        body: '{}'
    });

    check('logout responds 200', out.status === 200, `got ${out.status}`);

    const after = await fetch(`${base}/api/session`, {
        headers: { Cookie: `pruwise_session=${token}` }
    });
    const afterBody = await after.json().catch(() => null);

    check('and the session is dead afterwards', afterBody?.account === null,
        JSON.stringify(afterBody?.account)?.slice(0, 120));

    /* --------------------------------------------------- 7. setup is guarded

       TWO ACCEPTABLE ANSWERS, and both mean "you cannot run setup":

           403  SETUP_TOKEN is configured and the one given is wrong
           503  SETUP_TOKEN is not configured at all

       503 is the normal state. The token is added only for the moment a migration
       is applied and deleted straight afterwards, so no long-lived door exists. */
    const guard = await fetch(`${base}/api/setup?token=wrong`);
    check('setup cannot be run without the right token',
        guard.status === 403 || guard.status === 503, `got ${guard.status}`);

    /* =====================================================================
       8. THE DOMAIN ENDPOINTS, as a signed-in customer

       A fresh login, because logout above killed the first session.
       ===================================================================== */
    const login2 = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sarah.tan', password: 'studsarah' })
    });
    const jar = /pruwise_session=([^;]+)/.exec(login2.headers.get('set-cookie') ?? '')?.[1];
    const auth = { Cookie: `pruwise_session=${jar}`, 'Content-Type': 'application/json' };

    check('signed in again for the domain checks', typeof jar === 'string');

    /* ---- the assessment questionnaire ---- */
    const ass = await fetch(`${base}/api/assessment`, { headers: auth });
    const assBody = await ass.json().catch(() => null);

    check('GET /api/assessment responds 200', ass.status === 200,
        `got ${ass.status}: ${JSON.stringify(assBody)?.slice(0, 200)}`);
    check('it returns seven questions', assBody?.questions?.length === 7,
        `got ${assBody?.questions?.length}`);
    check('question one is the goal question', assBody?.questions?.[0]?.id === 'goal');
    check('every question has options',
        Array.isArray(assBody?.questions) &&
        assBody.questions.every(q => Array.isArray(q.options) && q.options.length > 0));
    check('the consultation requests are bundled', Array.isArray(assBody?.requests));
    check('the financial record is bundled', 'finances' in (assBody ?? {}));
    check('the needs analysis is bundled', 'needs' in (assBody ?? {}));

    /* ---- submitting answers, which exercises the whole scoring engine ---- */
    const answers = {
        goal: 'protection', age: '35to44', dependants: 'children',
        budget: '150to400', risk: 'moderate', cover: 'employer', concern: 'illness'
    };

    const scored = await fetch(`${base}/api/assessment`, {
        method: 'POST', headers: auth, body: JSON.stringify({ answers })
    });
    const scoredBody = await scored.json().catch(() => null);

    check('POST /api/assessment scores and saves', scored.status === 200,
        `got ${scored.status}: ${JSON.stringify(scoredBody)?.slice(0, 240)}`);

    const profile = scoredBody?.assessment?.profile;

    check('a profile came back', !!profile);
    check('the goal label is derived', profile?.primaryGoalLabel === 'Family protection',
        profile?.primaryGoalLabel);
    check('protection need is high for children + employer-only cover',
        profile?.protectionNeed === 'high', profile?.protectionNeed);
    check('risk is not bolder than what was stated',
        profile?.riskLevel === 'moderate' || profile?.riskLevel === 'conservative',
        profile?.riskLevel);
    check('horizon years computed from the age band', profile?.horizonYears === 25,
        String(profile?.horizonYears));
    check('signals explain the reasoning',
        Array.isArray(profile?.signals) && profile.signals.length >= 3,
        String(profile?.signals?.length));

    const recs = scoredBody?.assessment?.recommended;

    check('between two and four products recommended',
        Array.isArray(recs) && recs.length >= 2 && recs.length <= 4,
        String(recs?.length));
    check('every recommendation has at least one reason',
        Array.isArray(recs) && recs.every(r => Array.isArray(r.reasons) && r.reasons.length > 0));
    check('every recommendation has a real product name',
        Array.isArray(recs) && recs.every(r => typeof r.name === 'string' && r.name.startsWith('PRU')));
    check('fit scores are in the 55-97 band',
        Array.isArray(recs) && recs.every(r => r.fit >= 55 && r.fit <= 97));
    check('answer lines are readable pairs',
        Array.isArray(scoredBody?.assessment?.answerLines) &&
        scoredBody.assessment.answerLines.length === 7);

    /* ---- representative matching ---- */
    const reps = scoredBody?.reps;

    check('representatives were matched', Array.isArray(reps) && reps.length > 0,
        String(reps?.length));
    check('nobody who switched off availability is offered',
        Array.isArray(reps) && reps.every(r => r.acceptingCustomers === true));
    check('nobody at capacity is offered',
        Array.isArray(reps) && reps.every(r => r.atCapacity === false));
    check('fr-006 is excluded (not accepting)',
        Array.isArray(reps) && !reps.some(r => r.id === 'fr-006'));
    check('fr-007 is excluded (full at 12 of 12)',
        Array.isArray(reps) && !reps.some(r => r.id === 'fr-007'));
    check('each match explains itself',
        Array.isArray(reps) && reps.every(r => Array.isArray(r.whyMatched) && r.whyMatched.length > 0));
    check('fit scores are in the 62-97 band',
        Array.isArray(reps) && reps.every(r => r.fit >= 62 && r.fit <= 97));
    check('specialisations decoded to arrays, not JSON strings',
        Array.isArray(reps) && reps.every(r => Array.isArray(r.specialisations)));

    /* ---- the representatives endpoint ---- */
    const repList = await fetch(`${base}/api/representatives`, { headers: auth });
    const repListBody = await repList.json().catch(() => null);

    check('GET /api/representatives responds 200', repList.status === 200,
        `got ${repList.status}: ${JSON.stringify(repListBody)?.slice(0, 200)}`);
    check('and reports it was personalised', repListBody?.matched === true);

    const oneRep = await fetch(`${base}/api/representatives?id=fr-001`, { headers: auth });
    const oneRepBody = await oneRep.json().catch(() => null);

    check('GET ?id= returns one profile', oneRepBody?.rep?.id === 'fr-001',
        JSON.stringify(oneRepBody)?.slice(0, 160));
    check('an unavailable rep is still readable by id',
        (await (await fetch(`${base}/api/representatives?id=fr-006`, { headers: auth })).json())
            ?.rep?.acceptingCustomers === false);
    check('an unknown rep id is 404',
        (await fetch(`${base}/api/representatives?id=nope`, { headers: auth })).status === 404);
    check('a customer cannot read ?me=1',
        (await fetch(`${base}/api/representatives?me=1`, { headers: auth })).status === 403);

    /* ---- finances ---- */
    const fin = await fetch(`${base}/api/finances`, { headers: auth });
    const finBody = await fin.json().catch(() => null);

    check('GET /api/finances responds 200', fin.status === 200,
        `got ${fin.status}: ${JSON.stringify(finBody)?.slice(0, 200)}`);
    check('and is editable by its owner', finBody?.editable === true);

    const saveFin = await fetch(`${base}/api/finances`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ finances: {
            annualIncome: 132000, monthlyIncome: 11000, monthlyExpenses: 6000,
            savings: 40000, cpf: 90000, mortgage: 385000, dependants: 2,
            premiumBudget: 420, existingLifeCover: 400000, existingCiCover: 100000
        } })
    });
    const saveFinBody = await saveFin.json().catch(() => null);

    check('POST /api/finances saves', saveFin.status === 200,
        `got ${saveFin.status}: ${JSON.stringify(saveFinBody)?.slice(0, 240)}`);

    const needs = saveFinBody?.needs;

    check('the needs analysis is calculated', !!needs);
    check('four coverage lines', needs?.lines?.length === 4, String(needs?.lines?.length));
    check('11 years of income for 2 dependants', needs?.yearsOfIncome === 11,
        String(needs?.yearsOfIncome));
    check('the gap is a positive number', typeof needs?.gap === 'number' && needs.gap > 0,
        String(needs?.gap));
    check('the ratio is a percentage', needs?.ratio >= 0 && needs?.ratio <= 100,
        String(needs?.ratio));
    check('the emergency fund is assessed', !!needs?.emergency);
    check('affordability is assessed', !!needs?.affordability);
    check('CPF counts for death but not disability',
        needs?.lines?.find(l => l.key === 'tpd')?.why?.includes('CPF is not counted'));

    /* The typed budget should now out-rank the ticked bracket. */
    const reread = await fetch(`${base}/api/assessment`, { headers: auth });
    const rereadBody = await reread.json().catch(() => null);

    check('the saved budget figure out-ranks the ticked bracket',
        rereadBody?.assessment?.profile?.budgetSource === 'figures',
        rereadBody?.assessment?.profile?.budgetSource);
    check('and the amount is the one that was typed',
        rereadBody?.assessment?.profile?.budgetAmount === 420,
        String(rereadBody?.assessment?.profile?.budgetAmount));

    /* ---- a bad answer is refused, naming the question ---- */
    const badAnswers = await fetch(`${base}/api/assessment`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ answers: { ...answers, goal: 'buying-a-yacht' } })
    });
    const badAnswersBody = await badAnswers.json().catch(() => null);

    check('an answer outside the options is refused', badAnswers.status === 400,
        `got ${badAnswers.status}`);
    check('and the refusal names the question', badAnswersBody?.field === 'goal',
        badAnswersBody?.field);

    /* =====================================================================
       9. CONSULTATION REQUESTS

       cus-001 is seeded already working with fr-001, so accepting exercises the
       "already with this representative" branch: the request resolves, but nobody
       is moved and no assignment history is written.
       ===================================================================== */

    const consultGet = await fetch(`${base}/api/consultation`, { headers: auth });
    const consultBody = await consultGet.json().catch(() => null);

    check('GET /api/consultation responds 200', consultGet.status === 200,
        `got ${consultGet.status}: ${JSON.stringify(consultBody)?.slice(0, 200)}`);
    check('the customer gets a request list', Array.isArray(consultBody?.requests));
    check('and is told who they are with now', consultBody?.currentRepId === 'fr-001',
        String(consultBody?.currentRepId));

    /* Clear anything a previous run left pending, so the one-at-a-time rule is
       being tested rather than tripped over. */
    for (const request of consultBody?.requests ?? []) {
        if (request.status === 'pending') {
            await fetch(`${base}/api/consultation`, {
                method: 'POST', headers: auth,
                body: JSON.stringify({ id: request.id, action: 'withdraw' })
            });
        }
    }

    const asked = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ repId: 'fr-001', note: 'Smoke test request.' })
    });
    const askedBody = await asked.json().catch(() => null);

    check('a customer can request a consultation', asked.status === 200,
        `got ${asked.status}: ${JSON.stringify(askedBody)?.slice(0, 240)}`);
    check('the new request comes back pending', askedBody?.request?.status === 'pending',
        askedBody?.request?.status);

    const requestId = askedBody?.request?.id;

    check('with an id', typeof requestId === 'number');

    const second = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ repId: 'fr-002' })
    });

    check('a second pending request is refused with 409', second.status === 409,
        `got ${second.status}`);

    check('a representative who is not accepting is refused',
        (await (await fetch(`${base}/api/consultation`, {
            method: 'POST', headers: auth, body: JSON.stringify({ repId: 'fr-006' })
        })).json())?.error?.includes('not accepting') === true);

    check('an unknown representative id is 404',
        (await fetch(`${base}/api/consultation`, {
            method: 'POST', headers: auth, body: JSON.stringify({ repId: 'fr-999' })
        })).status === 404);

    /* ---- the representative's side ---- */
    const repLogin = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'kristin.henessy', password: 'studkris' })
    });
    const repLoginBody = await repLogin.json().catch(() => null);
    const repJar = /pruwise_session=([^;]+)/.exec(repLogin.headers.get('set-cookie') ?? '')?.[1];
    const repAuth = { Cookie: `pruwise_session=${repJar}`, 'Content-Type': 'application/json' };

    check('the representative can sign in', repLogin.status === 200,
        `got ${repLogin.status}: ${JSON.stringify(repLoginBody)?.slice(0, 200)}`);
    check('with the fr role', repLoginBody?.account?.role === 'fr');
    check('and the seeded person id', repLoginBody?.account?.personId === 'fr-001');

    const consultInbox = await fetch(`${base}/api/consultation`, { headers: repAuth });
    const consultInboxBody = await consultInbox.json().catch(() => null);

    check('GET /api/consultation gives the rep an inbox', consultInbox.status === 200,
        `got ${consultInbox.status}: ${JSON.stringify(consultInboxBody)?.slice(0, 200)}`);
    check('the pending count is at least one', Number(consultInboxBody?.pendingCount) >= 1,
        String(consultInboxBody?.pendingCount));
    check('the request is in the inbox',
        (consultInboxBody?.requests ?? []).some(r => r.id === requestId));
    check('and carries the customer assessment',
        (consultInboxBody?.requests ?? []).find(r => r.id === requestId)?.assessment?.profile
            ?.primaryGoalLabel === 'Family protection');
    check('with the answers, question by question',
        ((consultInboxBody?.requests ?? []).find(r => r.id === requestId)
            ?.assessment?.answerLines ?? []).length === 7);

    const book = consultInboxBody?.customers;

    check('the customer list comes with the inbox', Array.isArray(book) && book.length >= 5,
        String(book?.length));
    check('it holds only this representative\'s customers',
        Array.isArray(book) && book.some(c => c.personId === 'cus-001')
                            && !book.some(c => c.personId === 'cus-005'));
    check('the protection gap is calculated for cus-001',
        typeof book?.find(c => c.personId === 'cus-001')?.gap === 'number',
        String(book?.find(c => c.personId === 'cus-001')?.gap));
    check('customers with no financial record report a null gap, not zero',
        Array.isArray(book) &&
        book.filter(c => !c.hasFinances).every(c => c.gap === null));
    check('the list is sorted biggest shortfall first, unknowns last', (() => {
        const known = (book ?? []).filter(c => c.gap !== null).map(c => c.gap);
        const firstNull = (book ?? []).findIndex(c => c.gap === null);
        const inOrder = known.every((g, i) => i === 0 || known[i - 1] >= g);
        return inOrder && (firstNull === -1 || firstNull === known.length);
    })());

    /* ---- a customer cannot accept their own request ---- */
    check('a customer cannot accept a request sent to a representative',
        (await fetch(`${base}/api/consultation`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({ id: requestId, action: 'accept' })
        })).status === 403);

    /* ---- a decline needs a real reason ---- */
    const shortReason = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ id: requestId, action: 'decline', reason: 'no' })
    });
    const shortReasonBody = await shortReason.json().catch(() => null);

    check('a one-word decline reason is refused', shortReason.status === 400,
        `got ${shortReason.status}`);
    check('and the refusal names the reason field', shortReasonBody?.field === 'reason');

    /* ---- accept ---- */
    const accepted = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ id: requestId, action: 'accept' })
    });
    const acceptedBody = await accepted.json().catch(() => null);

    check('the representative can accept', accepted.status === 200,
        `got ${accepted.status}: ${JSON.stringify(acceptedBody)?.slice(0, 240)}`);
    check('and is told who joined them',
        acceptedBody?.message?.includes('Sarah Tan') === true, acceptedBody?.message);

    const acceptAgain = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ id: requestId, action: 'accept' })
    });
    const acceptAgainBody = await acceptAgain.json().catch(() => null);

    check('accepting twice is refused with 409', acceptAgain.status === 409,
        `got ${acceptAgain.status}`);
    check('and says which way it already went',
        acceptAgainBody?.error?.includes('already accepted') === true,
        acceptAgainBody?.error);

    /* =====================================================================
       10. POLICIES - the full application lifecycle

       Applies for two plans: one gets issued, one gets declined, so both
       branches are exercised in a single run.

       ---------------------------------------------------------------------
       WHY THE MUTATING HALF RUNS ON A THROWAWAY ACCOUNT
       ---------------------------------------------------------------------
       IT USED TO RUN ON sarah.tan AND IT BROKE HER SCREEN.

       This section issues a policy and declines an application every time it
       runs, and nothing ever removed them. Sixteen runs later the seeded demo
       customer held SIXTEEN identical PRUActive Protect policies, sixteen
       identical declined applications sat on her "My plans" page, and the
       premium total on it read $3,600 a month. That was reported as a bug in
       the app. It was a bug in this file.

       A test that leaves rows behind in the data somebody demonstrates is not
       a passing test. So the lifecycle now runs against a customer registered
       at the top of the section and DELETED at the bottom: DELETE FROM people
       cascades through policies and policy_applications - see the foreign keys
       in db/schema.sql - so the run ends with the database as it started.

       The READ-ONLY assertions still use sarah.tan, because "a representative
       can read their own customer" and "somebody else's customer is 404" need
       a real seeded relationship and neither of them writes anything.
       ===================================================================== */

    const mine = await fetch(`${base}/api/policies`, { headers: auth });
    const mineBody = await mine.json().catch(() => null);

    check('GET /api/policies responds 200 for a customer', mine.status === 200,
        `got ${mine.status}: ${JSON.stringify(mineBody)?.slice(0, 200)}`);
    check('it answers about themselves', mineBody?.whose === 'self', mineBody?.whose);
    check('and says they may apply, having a representative',
        mineBody?.canApply === true);
    check('policies and applications are both arrays',
        Array.isArray(mineBody?.policies) && Array.isArray(mineBody?.applications));

    /* ---- one active policy per product, checked against real held cover ----

       The rule that stops the pile-up described above. Derived from whatever the
       seeded customer actually holds rather than hard-coded, because the product
       she holds is a consequence of history and this check should follow it.

       It is READ-ONLY in effect: the whole point is that the request is refused,
       so nothing is created. */
    const heldReal = (mineBody?.policies ?? []).find(p => p.isReal && p.status === 'active');

    if (heldReal) {
        const again = await fetch(`${base}/api/policies`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({
                action: 'apply', productId: heldReal.productId, premium: 200
            })
        });
        const againBody = await again.json().catch(() => null);

        check('a plan the customer already holds cannot be applied for twice',
            again.status === 409, `got ${again.status}: ${JSON.stringify(againBody)?.slice(0, 200)}`);
        check('  and the refusal names the policy they hold',
            againBody?.error?.includes(heldReal.number) === true, againBody?.error);
        check('  and points them at their representative rather than dead-ending',
            againBody?.error?.includes('representative') === true);
    } else {
        console.log('  ..   sarah.tan holds no issued policy, so the ' +
                    'already-held check has nothing to bite on this run');
    }

    /* =================================================================
       THE THROWAWAY CUSTOMER

       Registered with no representative, given fr-001 through the real
       consultation flow, then deleted at the end of the section.
       ================================================================= */
    const polStamp = Math.random().toString(36).slice(2, 10);
    const polUser  = `policy.${polStamp}`;
    const polPass  = 'policy-smoke-password';

    const polSignUp = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Policy Smoke', email: `policy.${polStamp}@example.com`,
            username: polUser, password: polPass, terms: true
        })
    });
    const polSignUpBody = await polSignUp.json().catch(() => null);

    check('a throwaway customer registers for the policy lifecycle',
        polSignUp.status === 200,
        `got ${polSignUp.status}: ${JSON.stringify(polSignUpBody)?.slice(0, 240)}`);

    const polPerson = polSignUpBody?.account?.personId;
    const polJar = /pruwise_session=([^;]+)/
        .exec(polSignUp.headers.get('set-cookie') ?? '')?.[1];
    const polAuth = { Cookie: `pruwise_session=${polJar}`, 'Content-Type': 'application/json' };

    check('  with a person id to hang policies off', typeof polPerson === 'string',
        String(polPerson));

    /* A brand new customer's plans screen. Worth asserting because it is the
       first thing a real new account sees, and because it proves the rows this
       section is about to create were not there already. */
    const polEmpty = await fetch(`${base}/api/policies`, { headers: polAuth });
    const polEmptyBody = await polEmpty.json().catch(() => null);

    check('a new customer holds nothing and has nothing pending',
        (polEmptyBody?.policies ?? []).length === 0 &&
        (polEmptyBody?.applications ?? []).length === 0,
        `${(polEmptyBody?.policies ?? []).length} policies, ` +
        `${(polEmptyBody?.applications ?? []).length} applications`);
    check('  and is told they cannot apply yet, having no representative',
        polEmptyBody?.canApply === false, String(polEmptyBody?.canApply));

    check('applying without a representative is refused with 409',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({ action: 'apply', productId: 'prd-active', premium: 210 })
        })).status === 409);

    /* ---- give them a representative, through the real flow ----

       THE ASSESSMENT COMES FIRST, and not because this test is being thorough:
       /api/consultation refuses a request from anybody who has not completed it,
       on the grounds that it is what the representative reads before the first
       conversation. Discovered by this section failing with exactly that
       sentence, which is a good sign about the error message. */
    const polAssessed = await fetch(`${base}/api/assessment`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({
            answers: {
                goal: 'protection', age: '35to44', dependants: 'children',
                budget: '150to400', risk: 'moderate', cover: 'employer',
                concern: 'illness'
            }
        })
    });

    check('the throwaway customer can complete the assessment',
        polAssessed.status === 200, `got ${polAssessed.status}`);

    const polAsk = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({ repId: 'fr-001', note: 'Policy lifecycle smoke test.' })
    });
    const polAskBody = await polAsk.json().catch(() => null);

    check('the throwaway customer can request a representative',
        polAsk.status === 200,
        `got ${polAsk.status}: ${JSON.stringify(polAskBody)?.slice(0, 200)}`);

    const polAccepted = await fetch(`${base}/api/consultation`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ id: polAskBody?.request?.id, action: 'accept' })
    });

    check('and the representative can accept it', polAccepted.status === 200,
        `got ${polAccepted.status}`);

    check('accepting assigns the representative, so applying is now allowed',
        (await (await fetch(`${base}/api/policies`, { headers: polAuth })).json())
            ?.canApply === true);

    check('an unknown product cannot be applied for',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({ action: 'apply', productId: 'prd-yacht', premium: 100 })
        })).status === 400);

    const applied = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({
            action: 'apply', productId: 'prd-active',
            cover: 500000, ciCover: 150000, premium: 210, termYears: 25,
            note: 'Smoke test application.'
        })
    });
    const appliedBody = await applied.json().catch(() => null);

    check('a customer can apply for cover', applied.status === 200,
        `got ${applied.status}: ${JSON.stringify(appliedBody)?.slice(0, 240)}`);
    check('the application comes back submitted',
        appliedBody?.application?.status === 'submitted', appliedBody?.application?.status);
    check('with the product named', appliedBody?.application?.name === 'PRUActive Protect',
        appliedBody?.application?.name);
    check('and the figures preserved',
        appliedBody?.application?.cover === 500000 &&
        appliedBody?.application?.premium === 210);
    check('the message says nothing is in force yet',
        appliedBody?.message?.includes('Nothing is in force yet') === true);

    const applicationId = appliedBody?.application?.id;

    check('applying twice for the same product is refused with 409',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({ action: 'apply', productId: 'prd-active', premium: 210 })
        })).status === 409);

    check('a negative premium is refused',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({ action: 'apply', productId: 'prd-ci', premium: -5 })
        })).status === 400);

    check('an absurd cover figure is refused',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({
                action: 'apply', productId: 'prd-ci', premium: 90, cover: 999999999999
            })
        })).status === 400);

    /* A second application, for the decline path. */
    const applied2 = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({ action: 'apply', productId: 'prd-shield', premium: 55 })
    });
    const applied2Body = await applied2.json().catch(() => null);

    check('a second application for a different product is allowed',
        applied2.status === 200,
        `got ${applied2.status}: ${JSON.stringify(applied2Body)?.slice(0, 200)}`);

    const applicationId2 = applied2Body?.application?.id;

    /* ---- a customer cannot issue ---- */
    check('a customer cannot issue their own policy',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: polAuth,
            body: JSON.stringify({ action: 'issue', id: applicationId })
        })).status === 403);

    /* ---- the representative's queue ---- */
    const queue = await fetch(`${base}/api/policies`, { headers: repAuth });
    const queueBody = await queue.json().catch(() => null);

    check('a representative sees a queue', queueBody?.whose === 'queue', queueBody?.whose);
    check('the new application is in it',
        (queueBody?.applications ?? []).some(a => a.id === applicationId));
    check('undecided applications sort ahead of resolved ones', (() => {
        const list = queueBody?.applications ?? [];
        const open = a => a.status === 'submitted' || a.status === 'under_review';
        const lastOpen = list.reduce((acc, a, i) => open(a) ? i : acc, -1);
        return list.every((a, i) => i > lastOpen || open(a));
    })());

    const asCustomer = await fetch(`${base}/api/policies?personId=cus-001`, { headers: repAuth });
    const asCustomerBody = await asCustomer.json().catch(() => null);

    check('a representative can read their own customer\'s policies',
        asCustomer.status === 200, `got ${asCustomer.status}`);
    check('and is told it is read-only', asCustomerBody?.canApply === false);
    check('with the customer named', asCustomerBody?.customerName === 'Sarah Tan',
        asCustomerBody?.customerName);
    check('somebody else\'s customer is 404, not 403',
        (await fetch(`${base}/api/policies?personId=cus-005`, { headers: repAuth })).status === 404);

    /* The same read for the customer this section actually created, which is the
       one the representative would open to decide the application. */
    const asNew = await fetch(`${base}/api/policies?personId=${polPerson}`, { headers: repAuth });
    const asNewBody = await asNew.json().catch(() => null);

    check('a customer who joined a moment ago reads the same way',
        asNew.status === 200 && asNewBody?.customerName === 'Policy Smoke',
        `got ${asNew.status}: ${asNewBody?.customerName}`);
    check('  with the application the representative has to decide',
        (asNewBody?.applications ?? []).some(a => a.id === applicationId));

    /* ---- review ---- */
    const reviewed = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ action: 'review', id: applicationId })
    });
    const reviewedBody = await reviewed.json().catch(() => null);

    check('the representative can mark it under review', reviewed.status === 200,
        `got ${reviewed.status}: ${JSON.stringify(reviewedBody)?.slice(0, 240)}`);
    check('and the status moved', reviewedBody?.application?.status === 'under_review',
        reviewedBody?.application?.status);
    check('reviewing twice is refused with 409',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: repAuth,
            body: JSON.stringify({ action: 'review', id: applicationId })
        })).status === 409);

    /* ---- issue ---- */
    const issued = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({ action: 'issue', id: applicationId, premium: 225 })
    });
    const issuedBody = await issued.json().catch(() => null);

    check('the representative can issue the policy', issued.status === 200,
        `got ${issued.status}: ${JSON.stringify(issuedBody)?.slice(0, 300)}`);
    check('the application is now issued', issuedBody?.application?.status === 'issued',
        issuedBody?.application?.status);
    check('a policy number was allocated',
        /^PA-\d{4}-\d{4}$/.test(issuedBody?.policy?.number ?? ''),
        issuedBody?.policy?.number);
    check('the premium override was taken', issuedBody?.policy?.premium?.amount === 225,
        String(issuedBody?.policy?.premium?.amount));
    check('the cover figure came from the application',
        issuedBody?.policy?.sumAssured === 500000, String(issuedBody?.policy?.sumAssured));
    check('the cover is described in words',
        issuedBody?.policy?.coverText === '$500,000 death benefit',
        issuedBody?.policy?.coverText);
    check('benefits are an array the card can render',
        Array.isArray(issuedBody?.policy?.benefits) && issuedBody.policy.benefits.length > 0);
    check('riders and exclusions are arrays, never undefined',
        Array.isArray(issuedBody?.policy?.riders) &&
        Array.isArray(issuedBody?.policy?.exclusions));
    check('renewal is a year out and not due yet',
        issuedBody?.policy?.daysToRenewal > 300, String(issuedBody?.policy?.daysToRenewal));
    check('a 25-year term produced a maturity date',
        typeof issuedBody?.policy?.maturity === 'string', String(issuedBody?.policy?.maturity));
    check('issuing twice is refused with 409',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: repAuth,
            body: JSON.stringify({ action: 'issue', id: applicationId })
        })).status === 409);

    /* ---- decline the other one ---- */
    const declined = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: repAuth,
        body: JSON.stringify({
            action: 'decline', id: applicationId2,
            reason: 'Let us look at your hospital plan together first.'
        })
    });
    const declinedBody = await declined.json().catch(() => null);

    check('the representative can decline', declined.status === 200,
        `got ${declined.status}: ${JSON.stringify(declinedBody)?.slice(0, 240)}`);
    check('the application is now declined', declinedBody?.application?.status === 'declined',
        declinedBody?.application?.status);
    check('the reason is kept and shown',
        declinedBody?.application?.declineReason?.startsWith('Let us look') === true);
    check('a decline reason under ten characters is refused',
        (await fetch(`${base}/api/policies`, {
            method: 'POST', headers: repAuth,
            body: JSON.stringify({ action: 'decline', id: applicationId2, reason: 'nope' })
        })).status === 400);

    /* ---- the customer sees the result ---- */
    const after2 = await fetch(`${base}/api/policies`, { headers: polAuth });
    const after2Body = await after2.json().catch(() => null);

    check('the customer now holds the policy',
        (after2Body?.policies ?? []).some(p => p.number === issuedBody?.policy?.number));
    check('it reads as real, not demo content',
        (after2Body?.policies ?? []).find(p => p.number === issuedBody?.policy?.number)
            ?.isReal === true);
    check('and the declined application is visible with its reason',
        (after2Body?.applications ?? []).find(a => a.id === applicationId2)
            ?.declineReason?.startsWith('Let us look') === true);

    check('holding exactly one of that plan, not two',
        (after2Body?.policies ?? [])
            .filter(p => p.productId === 'prd-active').length === 1,
        String((after2Body?.policies ?? []).filter(p => p.productId === 'prd-active').length));

    /* THE RULE THAT WOULD HAVE PREVENTED THE ORIGINAL BUG, proved on cover that
       was issued seconds ago rather than on seeded history. */
    const holdAgain = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({ action: 'apply', productId: 'prd-active', premium: 210 })
    });
    const holdAgainBody = await holdAgain.json().catch(() => null);

    check('applying for a plan just issued to them is refused with 409',
        holdAgain.status === 409,
        `got ${holdAgain.status}: ${JSON.stringify(holdAgainBody)?.slice(0, 200)}`);
    check('  and the refusal quotes the policy number they now hold',
        holdAgainBody?.error?.includes(issuedBody?.policy?.number ?? 'x') === true,
        holdAgainBody?.error);

    /* A DECLINED application can still be resubmitted - that is the normal way a
       decline gets resolved after a conversation - so the rule really is about
       cover in force and not about ever having asked. */
    const afterDecline = await fetch(`${base}/api/policies`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({ action: 'apply', productId: 'prd-shield', premium: 55 })
    });

    check('a declined plan CAN be applied for again', afterDecline.status === 200,
        `got ${afterDecline.status}`);

    /* =================================================================
       CLEANING UP AFTER OURSELVES

       One delete. policies.person_id and policy_applications.customer_person_id
       both cascade from people, so the policy issued above, both applications
       and the consultation request all go with it.

       THEN IT IS CHECKED. A cleanup nobody verifies is how the original bug
       survived sixteen runs.
       ================================================================= */
    const polGone = await fetch(`${base}/api/delete-account`, {
        method: 'POST', headers: polAuth,
        body: JSON.stringify({ password: polPass, confirm: 'DELETE' })
    });

    check('the throwaway customer can be deleted', polGone.status === 200,
        `got ${polGone.status}`);

    const queueAfter = await fetch(`${base}/api/policies`, { headers: repAuth });
    const queueAfterBody = await queueAfter.json().catch(() => null);

    check('THE ROWS THIS SECTION CREATED ARE GONE, not left on a demo screen',
        !(queueAfterBody?.applications ?? [])
            .some(a => a.id === applicationId || a.id === applicationId2),
        `${(queueAfterBody?.applications ?? []).length} applications left in the queue`);

    check('and the representative cannot read a customer who no longer exists',
        (await fetch(`${base}/api/policies?personId=${polPerson}`, { headers: repAuth }))
            .status === 404);

    /* ---- an admin is kept out of both ---- */
    const adminLogin = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'studadmin' })
    });
    const adminJar = /pruwise_session=([^;]+)/.exec(adminLogin.headers.get('set-cookie') ?? '')?.[1];
    const adminAuth = { Cookie: `pruwise_session=${adminJar}`, 'Content-Type': 'application/json' };

    check('the admin can sign in', adminLogin.status === 200, `got ${adminLogin.status}`);
    check('an admin cannot read policies',
        (await fetch(`${base}/api/policies`, { headers: adminAuth })).status === 403);
    check('an admin cannot read consultations',
        (await fetch(`${base}/api/consultation`, { headers: adminAuth })).status === 403);

    /* ---- and neither endpoint answers anonymously ---- */
    check('/api/policies needs a session',
        (await fetch(`${base}/api/policies`)).status === 401);
    check('/api/consultation needs a session',
        (await fetch(`${base}/api/consultation`)).status === 401);

    /* =====================================================================
       11. THE ACCOUNT ENDPOINTS

       Run against a THROWAWAY ACCOUNT registered here and deleted at the end, so
       the flow is exercised for real without touching the demo logins. A failed
       password change on sarah.tan would break every other check in this file and
       the demo itself.

       WHAT CANNOT BE TESTED FROM OUTSIDE: the reset and confirmation links
       themselves. Their tokens only ever leave the server by email, and devLink is
       null unless DEV_MODE is on - which is the whole point of it. So the refusal
       paths are checked here and the happy path needs a mail provider configured.
       ===================================================================== */

    const stamp = Math.random().toString(36).slice(2, 10);
    const tempUser = `smoke.${stamp}`;
    const tempEmail = `smoke.${stamp}@example.com`;
    const tempPass = 'smoke-test-password';

    const signUp = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Smoke Test', email: tempEmail,
            username: tempUser, password: tempPass, terms: true
        })
    });
    const signUpBody = await signUp.json().catch(() => null);

    check('a throwaway account can register', signUp.status === 200,
        `got ${signUp.status}: ${JSON.stringify(signUpBody)?.slice(0, 240)}`);
    check('it starts with no representative', signUpBody?.account?.repId === null,
        String(signUpBody?.account?.repId));
    check('and with an unconfirmed email', signUpBody?.account?.emailVerified === false);
    check('the reset link is NOT handed back in production',
        signUpBody?.devLink === null, String(signUpBody?.devLink));

    const tempJar = /pruwise_session=([^;]+)/
        .exec(signUp.headers.get('set-cookie') ?? '')?.[1];
    let tempAuth = { Cookie: `pruwise_session=${tempJar}`, 'Content-Type': 'application/json' };

    check('registering signs you straight in', typeof tempJar === 'string');

    /* ---- resend-confirmation ---- */
    const resend = await fetch(`${base}/api/resend-confirmation`, {
        method: 'POST', headers: tempAuth, body: '{}'
    });
    const resendBody = await resend.json().catch(() => null);

    check('POST /api/resend-confirmation works for an unconfirmed address',
        resend.status === 200, `got ${resend.status}: ${JSON.stringify(resendBody)?.slice(0, 200)}`);
    check('and does not leak the link in production', resendBody?.devLink === null);
    check('resend-confirmation needs a session',
        (await fetch(`${base}/api/resend-confirmation`, { method: 'POST', body: '{}' }))
            .status === 401);
    check('an already-confirmed account is told so',
        (await fetch(`${base}/api/resend-confirmation`, {
            method: 'POST', headers: auth, body: '{}'
        })).status === 400);

    /* ---- update-profile ---- */
    const renamed = await fetch(`${base}/api/update-profile`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ name: 'Smoke Tester', phone: '+65 9000 1234' })
    });
    const renamedBody = await renamed.json().catch(() => null);

    check('POST /api/update-profile saves a name and phone', renamed.status === 200,
        `got ${renamed.status}: ${JSON.stringify(renamedBody)?.slice(0, 240)}`);
    check('it reports exactly what changed',
        JSON.stringify(renamedBody?.changed) === JSON.stringify(['name', 'phone']),
        JSON.stringify(renamedBody?.changed));
    check('and returns the account as it now stands',
        renamedBody?.account?.name === 'Smoke Tester' &&
        renamedBody?.account?.phone === '+65 9000 1234');

    const noop = await fetch(`${base}/api/update-profile`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ name: 'Smoke Tester' })
    });
    const noopBody = await noop.json().catch(() => null);

    check('sending an unchanged value changes nothing',
        Array.isArray(noopBody?.changed) && noopBody.changed.length === 0,
        JSON.stringify(noopBody?.changed));
    check('and says so rather than claiming a save',
        noopBody?.message === 'Nothing needed changing.', noopBody?.message);

    check('a two-character name is refused',
        (await fetch(`${base}/api/update-profile`, {
            method: 'POST', headers: tempAuth, body: JSON.stringify({ name: 'X' })
        })).status === 400);
    check('a nonsense phone number is refused',
        (await fetch(`${base}/api/update-profile`, {
            method: 'POST', headers: tempAuth, body: JSON.stringify({ phone: '12' })
        })).status === 400);

    const prefsSaved = await fetch(`${base}/api/update-profile`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ prefs: { theme: 'dark', emailNotifications: false } })
    });
    const prefsBody = await prefsSaved.json().catch(() => null);

    check('preferences save', prefsSaved.status === 200, `got ${prefsSaved.status}`);
    check('the theme came back', prefsBody?.account?.prefs?.theme === 'dark',
        prefsBody?.account?.prefs?.theme);
    check('and a switch turned off stayed off',
        prefsBody?.account?.prefs?.emailNotifications === false);

    /* An email change is a security action, so it needs the password. */
    const emailNoPass = await fetch(`${base}/api/update-profile`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ email: `moved.${stamp}@example.com` })
    });
    const emailNoPassBody = await emailNoPass.json().catch(() => null);

    check('changing an email without the password is refused',
        emailNoPass.status === 403, `got ${emailNoPass.status}`);
    check('and the refusal names the password field',
        emailNoPassBody?.field === 'currentPassword');

    const emailAsked = await fetch(`${base}/api/update-profile`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({
            email: `moved.${stamp}@example.com`, currentPassword: tempPass
        })
    });
    const emailAskedBody = await emailAsked.json().catch(() => null);

    check('with the password it is accepted as a REQUEST', emailAsked.status === 200,
        `got ${emailAsked.status}: ${JSON.stringify(emailAskedBody)?.slice(0, 240)}`);
    check('a confirmation is reported pending',
        emailAskedBody?.pendingEmail?.email === `moved.${stamp}@example.com`,
        JSON.stringify(emailAskedBody?.pendingEmail));
    check('but the address has NOT moved yet',
        emailAskedBody?.account?.email === tempEmail, emailAskedBody?.account?.email);
    check('an email already in use is refused',
        (await fetch(`${base}/api/update-profile`, {
            method: 'POST', headers: tempAuth,
            body: JSON.stringify({
                email: 'sarah.tan@example.sg', currentPassword: tempPass
            })
        })).status === 409);

    /* ---- confirm-email refusals ---- */
    check('a malformed confirmation token is refused with 400',
        (await fetch(`${base}/api/confirm-email`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'not a token!!' })
        })).status === 400);
    check('a well-formed but unknown confirmation token is 410',
        (await fetch(`${base}/api/confirm-email`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'a'.repeat(43) })
        })).status === 410);

    /* ---- forgot-password: the same answer, always ---- */
    const forgotReal = await fetch(`${base}/api/forgot-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: tempEmail })
    });
    const forgotRealBody = await forgotReal.json().catch(() => null);

    const forgotFake = await fetch(`${base}/api/forgot-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nobody.${stamp}@example.com` })
    });
    const forgotFakeBody = await forgotFake.json().catch(() => null);

    check('POST /api/forgot-password responds 200 for a real address',
        forgotReal.status === 200, `got ${forgotReal.status}`);
    check('and 200 for an address that does not exist',
        forgotFake.status === 200, `got ${forgotFake.status}`);
    check('THE ANSWER IS IDENTICAL either way, so the form cannot be used to ' +
          'test who has an account',
        forgotRealBody?.message === forgotFakeBody?.message,
        `${forgotRealBody?.message} vs ${forgotFakeBody?.message}`);
    check('the unknown address is given no emailRoute to compare',
        forgotFakeBody?.emailRoute === undefined);
    check('a malformed address IS refused, being a bad request not a hint',
        (await fetch(`${base}/api/forgot-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'not-an-email' })
        })).status === 400);
    check('no reset link is handed back in production',
        forgotRealBody?.devLink === null, String(forgotRealBody?.devLink));

    /* ---- reset-password refusals ---- */
    check('a malformed reset token is refused with 400',
        (await fetch(`${base}/api/reset-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: '../etc/passwd', check: true })
        })).status === 400);
    check('a well-formed but unknown reset token is 410',
        (await fetch(`${base}/api/reset-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'b'.repeat(43), check: true })
        })).status === 410);

    /* ---- change-password, for real ---- */
    check('change-password needs a session',
        (await fetch(`${base}/api/change-password`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' })
        })).status === 401);

    const wrongCurrent = await fetch(`${base}/api/change-password`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ currentPassword: 'not-it', newPassword: 'a-new-password' })
    });

    check('the wrong current password is refused with 403',
        wrongCurrent.status === 403, `got ${wrongCurrent.status}`);

    const sameAgain = await fetch(`${base}/api/change-password`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ currentPassword: tempPass, newPassword: tempPass })
    });
    const sameAgainBody = await sameAgain.json().catch(() => null);

    check('reusing the same password is refused', sameAgain.status === 400,
        `got ${sameAgain.status}`);
    check('and the refusal names the new-password field',
        sameAgainBody?.field === 'newPassword');
    check('a short new password is refused',
        (await fetch(`${base}/api/change-password`, {
            method: 'POST', headers: tempAuth,
            body: JSON.stringify({ currentPassword: tempPass, newPassword: 'short' })
        })).status === 400);

    const newPass = `${tempPass}-changed`;

    const changed = await fetch(`${base}/api/change-password`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ currentPassword: tempPass, newPassword: newPass })
    });
    const changedBody = await changed.json().catch(() => null);

    check('the password can actually be changed', changed.status === 200,
        `got ${changed.status}: ${JSON.stringify(changedBody)?.slice(0, 240)}`);
    check('and other devices are signed out by default',
        changedBody?.message?.includes('other devices have been signed out') === true,
        changedBody?.message);

    /* THE CHECK THAT MATTERS MOST HERE: bumping session_epoch invalidates every
       session for the account, and this one has to survive it. If it does not, a
       successful password change looks like being kicked out. */
    const stillIn = await fetch(`${base}/api/session`, { headers: tempAuth });
    const stillInBody = await stillIn.json().catch(() => null);

    check('THE SESSION THAT CHANGED THE PASSWORD IS STILL VALID',
        stillInBody?.account?.username === tempUser,
        JSON.stringify(stillInBody?.account)?.slice(0, 160));

    check('the old password no longer works',
        (await fetch(`${base}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: tempUser, password: tempPass })
        })).status === 401);

    const reLogin = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: tempUser, password: newPass })
    });

    check('and the new one does', reLogin.status === 200, `got ${reLogin.status}`);

    /* Carry on with the newest session - the one above is the survivor, but using
       the fresh cookie proves the login actually produced a working one. */
    tempAuth = {
        Cookie: `pruwise_session=${/pruwise_session=([^;]+)/
            .exec(reLogin.headers.get('set-cookie') ?? '')?.[1]}`,
        'Content-Type': 'application/json'
    };

    /* ---- delete-account, which also cleans up after this whole section ---- */
    check('deleting without typing DELETE is refused',
        (await fetch(`${base}/api/delete-account`, {
            method: 'POST', headers: tempAuth,
            body: JSON.stringify({ password: newPass, confirm: 'yes' })
        })).status === 400);
    check('deleting with the wrong password is refused',
        (await fetch(`${base}/api/delete-account`, {
            method: 'POST', headers: tempAuth,
            body: JSON.stringify({ password: 'nope', confirm: 'DELETE' })
        })).status === 401);
    check('an admin cannot delete their own account',
        (await fetch(`${base}/api/delete-account`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ password: 'studadmin', confirm: 'DELETE' })
        })).status === 403);

    const deleted = await fetch(`${base}/api/delete-account`, {
        method: 'POST', headers: tempAuth,
        body: JSON.stringify({ password: newPass, confirm: 'DELETE' })
    });
    const deletedBody = await deleted.json().catch(() => null);

    check('the throwaway account can be deleted', deleted.status === 200,
        `got ${deleted.status}: ${JSON.stringify(deletedBody)?.slice(0, 240)}`);
    check('the session is dead afterwards',
        (await (await fetch(`${base}/api/session`, { headers: tempAuth })).json())
            ?.account === null);
    check('and the username cannot be signed into any more',
        (await fetch(`${base}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: tempUser, password: newPass })
        })).status === 401);
    check('the username is free to register again, so the rows really went',
        (await fetch(`${base}/api/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Second Smoke', email: tempEmail,
                username: tempUser, password: tempPass, terms: true
            })
        })).status === 200);

    /* Registered again to prove the cascade worked - now take it away again. */
    const secondLogin = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: tempUser, password: tempPass })
    });
    const secondJar = /pruwise_session=([^;]+)/
        .exec(secondLogin.headers.get('set-cookie') ?? '')?.[1];

    const cleaned = await fetch(`${base}/api/delete-account`, {
        method: 'POST',
        headers: { Cookie: `pruwise_session=${secondJar}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: tempPass, confirm: 'DELETE' })
    });

    check('and the second throwaway is cleaned up too', cleaned.status === 200,
        `got ${cleaned.status}`);

    /* =====================================================================
       12. CONVERSATIONS, MESSAGES AND FILES

       Both sides of a real conversation: sarah.tan (cus-001) and her
       representative kristin.henessy (fr-001), who were paired by the accept in
       section 9.
       ===================================================================== */

    /* Sign back in as the customer - section 11 finished as an admin. */
    const cLogin = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sarah.tan', password: 'studsarah' })
    });
    const cJar = /pruwise_session=([^;]+)/.exec(cLogin.headers.get('set-cookie') ?? '')?.[1];
    const cAuth = { Cookie: `pruwise_session=${cJar}`, 'Content-Type': 'application/json' };

    check('signed in as the customer for the messaging checks', cLogin.status === 200,
        `got ${cLogin.status}`);

    const list = await fetch(`${base}/api/threads`, { headers: cAuth });
    const listBody = await list.json().catch(() => null);

    check('GET /api/threads responds 200', list.status === 200,
        `got ${list.status}: ${JSON.stringify(listBody)?.slice(0, 200)}`);
    check('PRUWise is the first conversation',
        listBody?.threads?.[0]?.kind === 'ai' && listBody.threads[0].name === 'PRUWise',
        JSON.stringify(listBody?.threads?.[0])?.slice(0, 160));
    check('the customer also sees their representative',
        (listBody?.threads ?? []).some(t => t.kind === 'human' && t.personId === 'fr-001'),
        JSON.stringify((listBody?.threads ?? []).map(t => t.personId)));
    check('and only that one human conversation',
        (listBody?.threads ?? []).filter(t => t.kind === 'human').length === 1);
    check('a total unread count comes back', typeof listBody?.totalUnread === 'number');
    check('every conversation carries an avatar seed',
        (listBody?.threads ?? []).every(t => typeof t.seed === 'string' && t.seed !== ''));

    const humanThreadId = (listBody?.threads ?? [])
        .find(t => t.kind === 'human')?.threadId;

    check('the human conversation has an id', typeof humanThreadId === 'number');

    /* ---- the representative's side of the same list ---- */
    const rLogin = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'kristin.henessy', password: 'studkris' })
    });
    const rJar = /pruwise_session=([^;]+)/.exec(rLogin.headers.get('set-cookie') ?? '')?.[1];
    const rAuth = { Cookie: `pruwise_session=${rJar}`, 'Content-Type': 'application/json' };

    const rList = await fetch(`${base}/api/threads`, { headers: rAuth });
    const rListBody = await rList.json().catch(() => null);

    check('a representative sees one conversation per customer',
        (rListBody?.threads ?? []).filter(t => t.kind === 'human').length >= 5,
        String((rListBody?.threads ?? []).filter(t => t.kind === 'human').length));
    check('including customers never messaged, with no last line',
        (rListBody?.threads ?? []).some(t => t.kind === 'human' && t.time === null));
    check('conversations with activity sort ahead of silent ones', (() => {
        const human = (rListBody?.threads ?? []).filter(t => t.kind === 'human');
        const firstNull = human.findIndex(t => t.time === null);
        const withTime = human.filter(t => t.time !== null).length;
        return firstNull === -1 || firstNull === withTime;
    })());
    check('and both sides agree on the thread id',
        (rListBody?.threads ?? []).some(t => t.threadId === humanThreadId));

    check('an admin gets an empty conversation list, not a 403',
        (await (await fetch(`${base}/api/threads`, { headers: adminAuth })).json())
            ?.threads?.length === 0);

    /* ---- opening a conversation ---- */
    const opened = await fetch(`${base}/api/thread?threadId=${humanThreadId}`, { headers: cAuth });
    const openedBody = await opened.json().catch(() => null);

    check('GET /api/thread opens it', opened.status === 200,
        `got ${opened.status}: ${JSON.stringify(openedBody)?.slice(0, 200)}`);
    check('it names who is on the other side',
        openedBody?.other?.personId === 'fr-001', JSON.stringify(openedBody?.other));
    check('the system message from the accept is there',
        (openedBody?.messages ?? []).some(m => m.senderKind === 'system'));
    check('and the policy notices from section 10 too',
        (openedBody?.messages ?? []).some(m =>
            m.senderKind === 'system' &&
            (m.paragraphs?.[0] ?? '').includes('now in force')));
    check('every message reports a role the bubbles can use',
        (openedBody?.messages ?? []).every(m => ['me', 'them', 'system'].includes(m.role)));
    check('every message has a files array, never undefined',
        (openedBody?.messages ?? []).every(m => Array.isArray(m.files)));
    check('a latest id comes back for the poller',
        typeof openedBody?.latestId === 'number' && openedBody.latestId > 0);
    check('opening is not reported as a poll', openedBody?.poll === false);

    check('?kind=ai opens the private PRUWise conversation',
        (await (await fetch(`${base}/api/thread?kind=ai`, { headers: cAuth })).json())
            ?.kind === 'ai');
    check('a customer can open ?withPerson= their representative',
        (await (await fetch(`${base}/api/thread?withPerson=fr-001`, { headers: cAuth })).json())
            ?.threadId === humanThreadId);
    check('but not a conversation with another customer',
        (await fetch(`${base}/api/thread?withPerson=cus-002`, { headers: cAuth })).status === 403);
    check('somebody else\'s thread id is 404, not 403',
        (await fetch(`${base}/api/thread?threadId=999999`, { headers: cAuth })).status === 404);
    check('naming no conversation at all is 400',
        (await fetch(`${base}/api/thread`, { headers: cAuth })).status === 400);

    /* ---- sending ---- */
    const stamp2 = Math.random().toString(36).slice(2, 10);
    const ref = `smoke-${stamp2}`;

    const sent = await fetch(`${base}/api/send-message`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            threadId: humanThreadId,
            text: `Smoke test message ${stamp2}`,
            clientRef: ref
        })
    });
    const sentBody = await sent.json().catch(() => null);

    check('POST /api/send-message sends', sent.status === 200,
        `got ${sent.status}: ${JSON.stringify(sentBody)?.slice(0, 240)}`);
    check('a real database id comes back', typeof sentBody?.messageId === 'number');
    check('and the message itself, so the browser need not ask again',
        (sentBody?.messages ?? []).some(m => m.id === sentBody.messageId));
    check('it reads as mine from my own side',
        (sentBody?.messages ?? []).find(m => m.id === sentBody.messageId)?.role === 'me');

    const resent = await fetch(`${base}/api/send-message`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            threadId: humanThreadId, text: 'a retry of the same thing', clientRef: ref
        })
    });
    const resentBody = await resent.json().catch(() => null);

    check('THE SAME clientRef DOES NOT POST TWICE', resentBody?.duplicate === true,
        JSON.stringify(resentBody)?.slice(0, 200));
    check('and it hands back the original id',
        resentBody?.messageId === sentBody?.messageId);

    check('an empty message with no file is refused',
        (await fetch(`${base}/api/send-message`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ threadId: humanThreadId, text: '   ' })
        })).status === 400);
    check('a message over 4000 characters is refused',
        (await fetch(`${base}/api/send-message`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ threadId: humanThreadId, text: 'x'.repeat(4001) })
        })).status === 400);

    /* ---- the other side sees it, and the poll works ---- */
    const poll = await fetch(
        `${base}/api/thread?threadId=${humanThreadId}&since=${sentBody.messageId - 1}&read=1`,
        { headers: rAuth });
    const pollBody = await poll.json().catch(() => null);

    check('the representative polls and sees it', poll.status === 200 &&
        (pollBody?.messages ?? []).some(m => m.id === sentBody.messageId),
        JSON.stringify(pollBody?.messages)?.slice(0, 200));
    check('it reads as theirs from the other side',
        (pollBody?.messages ?? []).find(m => m.id === sentBody.messageId)?.role === 'them');
    check('the poll is reported as a poll', pollBody?.poll === true);

    const emptyPoll = await fetch(
        `${base}/api/thread?threadId=${humanThreadId}&since=${pollBody.latestId}`,
        { headers: rAuth });
    const emptyPollBody = await emptyPoll.json().catch(() => null);

    check('a poll with nothing new returns an empty list, not an error',
        emptyPollBody?.messages?.length === 0);
    check('and still reports the latest id so the poller keeps its place',
        emptyPollBody?.latestId === pollBody.latestId);

    /* read=1 above marked it read, so the sender's tick should now be up to date */
    const ticks = await fetch(`${base}/api/thread?threadId=${humanThreadId}`, { headers: cAuth });
    const ticksBody = await ticks.json().catch(() => null);

    check('READ RECEIPTS COME BACK WITHOUT RESENDING THE CONVERSATION',
        ticksBody?.readUpTo >= sentBody.messageId,
        `readUpTo=${ticksBody?.readUpTo} messageId=${sentBody?.messageId}`);

    /* ---- the PRUWise conversation ---- */
    const aiRef = `smoke-ai-${stamp2}`;

    const stored = await fetch(`${base}/api/store-ai-message`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            clientRef: aiRef,
            payload: {
                paragraphs: ['A stored PRUWise answer.'],
                bullets: ['one', 'two'],
                senderKind: 'account',
                role: 'me',
                somethingInvented: 'should be dropped'
            }
        })
    });
    const storedBody = await stored.json().catch(() => null);

    check('POST /api/store-ai-message stores an answer', stored.status === 200,
        `got ${stored.status}: ${JSON.stringify(storedBody)?.slice(0, 240)}`);

    const aiThread = await fetch(`${base}/api/thread?kind=ai`, { headers: cAuth });
    const aiBody = await aiThread.json().catch(() => null);
    const aiMessage = (aiBody?.messages ?? []).find(m => m.id === storedBody?.messageId);

    check('it lands in the private PRUWise conversation', !!aiMessage);
    check('the rich parts survive', JSON.stringify(aiMessage?.bullets) ===
        JSON.stringify(['one', 'two']), JSON.stringify(aiMessage?.bullets));
    check('A PAYLOAD CANNOT CLAIM TO BE FROM SOMEBODY ELSE',
        aiMessage?.senderKind === 'ai' && aiMessage?.role === 'them',
        `senderKind=${aiMessage?.senderKind} role=${aiMessage?.role}`);
    check('and keys outside the whitelist are dropped',
        aiMessage?.somethingInvented === undefined);
    check('it is already read, so PRUWise carries no permanent badge',
        aiMessage?.read === true);
    check('the same clientRef does not store twice',
        (await (await fetch(`${base}/api/store-ai-message`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ clientRef: aiRef, payload: { paragraphs: ['again'] } })
        })).json())?.duplicate === true);
    check('an empty payload is refused',
        (await fetch(`${base}/api/store-ai-message`, {
            method: 'POST', headers: cAuth, body: JSON.stringify({ payload: {} })
        })).status === 400);

    /* =====================================================================
       FILES

       A real upload, a real read back, and the permission rules around it.
       ===================================================================== */

    /* A tiny valid PNG - an 8-bit 1x1. Built as bytes rather than base64 of
       something opaque, so the signature check is being tested against a real
       file rather than a blob nobody can inspect. */
    const png = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c63f8ffff3f0005fe02fea735a3250000' +
        '000049454e44ae426082', 'hex');

    const up = await fetch(`${base}/api/upload?name=smoke.png&type=image%2Fpng`, {
        method: 'POST',
        headers: { Cookie: `pruwise_session=${cJar}`, 'Content-Type': 'image/png' },
        body: png
    });
    const upBody = await up.json().catch(() => null);

    check('POST /api/upload accepts a PNG', up.status === 200,
        `got ${up.status}: ${JSON.stringify(upBody)?.slice(0, 300)}`);
    check('an attachment id comes back', typeof upBody?.attachmentId === 'number');
    check('the sniffed type is image/png', upBody?.type === 'image/png', upBody?.type);
    check('it is recognised as an image', upBody?.isImage === true);
    check('the size matches what was sent', upBody?.size === png.length,
        `${upBody?.size} vs ${png.length}`);
    check('the url points at /api/file, never at storage',
        upBody?.url === `/api/file?id=${upBody?.attachmentId}`, upBody?.url);

    /* THE TYPE IS SNIFFED, NOT ASKED: a text file claiming to be a PNG must be
       caught by its bytes. */
    const liar = await fetch(`${base}/api/upload?name=evil.png&type=image%2Fpng`, {
        method: 'POST',
        headers: { Cookie: `pruwise_session=${cJar}`, 'Content-Type': 'image/png' },
        body: Buffer.from('<?php system($_GET["c"]); ?>', 'utf8')
    });

    check('A FILE LYING ABOUT ITS TYPE IS JUDGED BY ITS BYTES',
        liar.status === 400 || liar.status === 200, `got ${liar.status}`);

    const liarBody = await liar.json().catch(() => null);

    check('and PHP source is stored as text, never as an image',
        liar.status === 400 || liarBody?.type === 'text/plain',
        `${liar.status} ${liarBody?.type}`);

    check('an executable is refused outright',
        (await fetch(`${base}/api/upload?name=x.exe&type=application%2Foctet-stream`, {
            method: 'POST',
            headers: { Cookie: `pruwise_session=${cJar}`, 'Content-Type': 'application/octet-stream' },
            body: Buffer.from('4d5a90000300000004000000ffff0000', 'hex')
        })).status === 400);

    check('an empty upload is refused',
        (await fetch(`${base}/api/upload?name=empty.png&type=image%2Fpng`, {
            method: 'POST',
            headers: { Cookie: `pruwise_session=${cJar}`, 'Content-Type': 'image/png' },
            body: Buffer.alloc(0)
        })).status === 400);

    check('uploading needs a session',
        (await fetch(`${base}/api/upload?name=x.png&type=image%2Fpng`, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png
        })).status === 401);

    /* ---- reading it back ---- */
    const fileRead = await fetch(`${base}/api/file?id=${upBody.attachmentId}`, {
        headers: { Cookie: `pruwise_session=${cJar}` }
    });
    const fileBytes = Buffer.from(await fileRead.arrayBuffer());

    check('GET /api/file returns the file to its uploader', fileRead.status === 200,
        `got ${fileRead.status}`);
    check('THE BYTES COME BACK EXACTLY AS THEY WENT IN', fileBytes.equals(png),
        `${fileBytes.length} bytes vs ${png.length}`);
    check('with the right content type',
        fileRead.headers.get('content-type') === 'image/png',
        fileRead.headers.get('content-type'));
    check('an image is served inline so it previews in the chat',
        (fileRead.headers.get('content-disposition') ?? '').startsWith('inline'),
        fileRead.headers.get('content-disposition'));
    check('nosniff is set, so a browser cannot decide it is HTML',
        fileRead.headers.get('x-content-type-options') === 'nosniff');
    check('and no shared cache may keep a copy',
        (fileRead.headers.get('cache-control') ?? '').includes('private'),
        fileRead.headers.get('cache-control'));

    check('an unsent attachment is NOT readable by anybody else',
        (await fetch(`${base}/api/file?id=${upBody.attachmentId}`,
            { headers: { Cookie: `pruwise_session=${rJar}` } })).status === 404);
    check('reading a file needs a session',
        (await fetch(`${base}/api/file?id=${upBody.attachmentId}`)).status === 401);
    check('an unknown attachment id is 404',
        (await fetch(`${base}/api/file?id=999999`,
            { headers: { Cookie: `pruwise_session=${cJar}` } })).status === 404);

    /* ---- attaching it to a message ---- */
    const withFile = await fetch(`${base}/api/send-message`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            threadId: humanThreadId,
            text: 'Here is the document.',
            attachmentIds: [upBody.attachmentId]
        })
    });
    const withFileBody = await withFile.json().catch(() => null);

    check('a file can be attached to a message', withFile.status === 200,
        `got ${withFile.status}: ${JSON.stringify(withFileBody)?.slice(0, 240)}`);
    check('and it reports one attachment moved', withFileBody?.attached === 1,
        String(withFileBody?.attached));

    const withFileMessage = (withFileBody?.messages ?? [])
        .find(m => m.id === withFileBody.messageId);

    check('the message carries the file', withFileMessage?.files?.length === 1,
        JSON.stringify(withFileMessage?.files));
    check('with the name the sender chose',
        withFileMessage?.files?.[0]?.name === 'smoke.png');

    check('NOW THE REPRESENTATIVE CAN READ IT, BEING IN THE CONVERSATION',
        (await fetch(`${base}/api/file?id=${upBody.attachmentId}`,
            { headers: { Cookie: `pruwise_session=${rJar}` } })).status === 200);
    check('but a customer outside the conversation still cannot',
        (await fetch(`${base}/api/file?id=${upBody.attachmentId}`,
            { headers: { Cookie: `pruwise_session=${adminJar}` } })).status === 404);

    /* SOMEBODY ELSE'S ATTACHMENT ID CANNOT BE STAPLED TO YOUR OWN MESSAGE. */
    const stolen = await fetch(`${base}/api/upload?name=theirs.png&type=image%2Fpng`, {
        method: 'POST',
        headers: { Cookie: `pruwise_session=${rJar}`, 'Content-Type': 'image/png' },
        body: png
    });
    const stolenBody = await stolen.json().catch(() => null);

    const theft = await fetch(`${base}/api/send-message`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            threadId: humanThreadId,
            text: 'Quoting an id that is not mine.',
            attachmentIds: [stolenBody?.attachmentId]
        })
    });
    const theftBody = await theft.json().catch(() => null);

    check('QUOTING ANOTHER PERSON\'S ATTACHMENT ID ATTACHES NOTHING',
        theft.status === 200 && theftBody?.attached === 0,
        `${theft.status} attached=${theftBody?.attached}`);
    check('and the message goes out without it',
        (theftBody?.messages ?? []).find(m => m.id === theftBody.messageId)
            ?.files?.length === 0);

    /* =====================================================================
       13. APPOINTMENTS AND THE CALENDAR FEED

       The whole lifecycle between sarah.tan and kristin.henessy: propose, refuse
       to self-confirm, confirm from the other side, reschedule, cancel. Then the
       .ics download and the subscribable feed.
       ===================================================================== */

    const cal = await fetch(`${base}/api/appointments`, { headers: cAuth });
    const calBody = await cal.json().catch(() => null);

    check('GET /api/appointments responds 200', cal.status === 200,
        `got ${cal.status}: ${JSON.stringify(calBody)?.slice(0, 200)}`);
    check('appointments come back as an array', Array.isArray(calBody?.appointments));
    check('a customer is told who they can book with',
        (calBody?.people ?? []).some(p => p.personId === 'fr-001'),
        JSON.stringify(calBody?.people));
    check('and only their own representative',
        (calBody?.people ?? []).length === 1);
    check('a subscribable feed url comes back',
        typeof calBody?.feedUrl === 'string' && calBody.feedUrl.includes('/api/calendar?feed='),
        calBody?.feedUrl);
    check('the feed token is not the account id',
        !/feed=\d+$/.test(calBody?.feedUrl ?? ''), calBody?.feedUrl);
    check('a webcal:// form is offered too',
        (calBody?.webcalUrl ?? '').startsWith('webcal://'), calBody?.webcalUrl);
    check('server time is sent so the browser agrees about "today"',
        typeof calBody?.serverTime === 'string' &&
        !Number.isNaN(Date.parse(calBody.serverTime)));

    const feedUrl = calBody.feedUrl;

    check('a representative is told all their own customers',
        ((await (await fetch(`${base}/api/appointments`, { headers: rAuth })).json())
            ?.people ?? []).length >= 5);
    check('an admin cannot read appointments',
        (await fetch(`${base}/api/appointments`, { headers: adminAuth })).status === 403);
    check('a malformed date range is refused',
        (await fetch(`${base}/api/appointments?from=last-tuesday&to=2026-04-01`,
            { headers: cAuth })).status === 400);
    check('an end date before the start is refused',
        (await fetch(`${base}/api/appointments?from=2026-04-01&to=2026-03-01`,
            { headers: cAuth })).status === 400);
    check('a ten-year range is refused',
        (await fetch(`${base}/api/appointments?from=2026-01-01&to=2036-01-01`,
            { headers: cAuth })).status === 400);
    check('?upcoming= is accepted as the other shape',
        (await fetch(`${base}/api/appointments?upcoming=3`, { headers: cAuth })).status === 200);

    /* CLEAR ANYTHING A PREVIOUS RUN LEFT BEHIND.

       This section books a meeting and then moves it four hours later, which is a
       clash test waiting to happen: the run before last left a CONFIRMED appointment
       sitting in exactly the slot this run reschedules into, and six checks failed
       on a 409 that was entirely correct.

       So the test tidies up first. Cancelling rather than deleting, because there is
       no delete endpoint and there should not be one - a cancelled meeting is part of
       the record, and the feed has to keep reporting it. */
    const windowFrom = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const windowTo = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    const existing = await fetch(
        `${base}/api/appointments?from=${windowFrom}&to=${windowTo}`, { headers: cAuth });
    const existingBody = await existing.json().catch(() => null);

    let tidied = 0;

    for (const appointment of existingBody?.appointments ?? []) {
        if (!String(appointment.title).startsWith('Smoke test')) { continue; }
        if (appointment.status !== 'pending' && appointment.status !== 'confirmed') { continue; }

        const gone = await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ action: 'cancel', id: appointment.id })
        });

        if (gone.status === 200) { tidied++; }
    }

    check('leftovers from a previous run were cleared', true, `cancelled ${tidied}`);

    /* ---- the customer proposes a meeting ---- */
    const soon = new Date(Date.now() + 3 * 86400000);
    soon.setUTCHours(9, 0, 0, 0);

    const booked = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            action: 'create',
            title: `Smoke test review ${stamp2}`,
            mode: 'video',
            start: soon.toISOString(),
            minutes: 45,
            agenda: 'Check my cover\nTalk about the hospital plan\n\n   ',
            notes: 'Booked by the smoke test.'
        })
    });
    const bookedBody = await booked.json().catch(() => null);

    check('a customer can propose a meeting', booked.status === 200,
        `got ${booked.status}: ${JSON.stringify(bookedBody)?.slice(0, 300)}`);
    check('it starts as pending, not confirmed',
        bookedBody?.appointment?.status === 'pending', bookedBody?.appointment?.status);
    check('the customer never chooses who it is with - the server does',
        bookedBody?.appointment?.repPersonId === 'fr-001' &&
        bookedBody?.appointment?.customerPersonId === 'cus-001');
    check('the end time is derived from start + minutes',
        bookedBody?.appointment?.end ===
            new Date(soon.getTime() + 45 * 60000).toISOString(),
        bookedBody?.appointment?.end);
    check('blank agenda lines are dropped',
        JSON.stringify(bookedBody?.appointment?.agenda) ===
            JSON.stringify(['Check my cover', 'Talk about the hospital plan']),
        JSON.stringify(bookedBody?.appointment?.agenda));
    check('a default type is derived from the mode',
        bookedBody?.appointment?.type === 'Video call', bookedBody?.appointment?.type);
    check('and a default location',
        bookedBody?.appointment?.location === 'PRUWise video room');
    check('the message says the other side has to confirm',
        (bookedBody?.message ?? '').includes('confirm'), bookedBody?.message);
    check('an add-to-Google link is built server-side',
        (bookedBody?.googleUrl ?? '').startsWith('https://calendar.google.com/'),
        bookedBody?.googleUrl);
    check('and an .ics download link',
        (bookedBody?.icsUrl ?? '').includes('/api/calendar?id='), bookedBody?.icsUrl);

    const aptId = bookedBody?.appointment?.id;

    check('the appointment has a random id, not a guessable one',
        /^apt-[0-9a-f]{8}$/.test(aptId ?? ''), aptId);
    check('CREATING IT DOES NOT LET THE CREATOR CONFIRM IT',
        bookedBody?.appointment?.can?.confirm === false);
    check('but they may cancel or move it',
        bookedBody?.appointment?.can?.cancel === true &&
        bookedBody?.appointment?.can?.reschedule === true);
    check('and it cannot be completed before it has started',
        bookedBody?.appointment?.can?.complete === false);

    check('a time in the past is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({
                action: 'create', title: 'Yesterday', mode: 'phone',
                start: new Date(Date.now() - 86400000).toISOString(), minutes: 30
            })
        })).status === 400);
    check('a five-minute meeting is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({
                action: 'create', title: 'Too short', mode: 'phone',
                start: new Date(Date.now() + 86400000).toISOString(), minutes: 5
            })
        })).status === 400);
    check('a meeting three years out is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({
                action: 'create', title: 'Far future', mode: 'phone',
                start: new Date(Date.now() + 1200 * 86400000).toISOString(), minutes: 30
            })
        })).status === 400);
    check('a meeting with no title is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({
                action: 'create', title: '  ', mode: 'video',
                start: new Date(Date.now() + 86400000).toISOString(), minutes: 30
            })
        })).status === 400);
    check('an invented mode is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({
                action: 'create', title: 'Telepathy', mode: 'telepathy',
                start: new Date(Date.now() + 86400000).toISOString(), minutes: 30
            })
        })).status === 400);

    /* THE OVERLAP TEST: a second meeting inside the first one's 45 minutes. */
    const overlap = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            action: 'create', title: 'Clashing', mode: 'phone',
            start: new Date(soon.getTime() + 15 * 60000).toISOString(), minutes: 15
        })
    });
    const overlapBody = await overlap.json().catch(() => null);

    check('A MEETING SWALLOWED BY AN EXISTING ONE IS REFUSED',
        overlap.status === 409, `got ${overlap.status}`);
    check('and the customer is NOT told who else the rep is seeing',
        (overlapBody?.error ?? '').includes('not free then') &&
        !(overlapBody?.error ?? '').includes('Smoke test review'),
        overlapBody?.error);

    /* ---- the creator cannot confirm their own proposal ---- */
    const selfConfirm = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ action: 'confirm', id: aptId })
    });
    const selfConfirmBody = await selfConfirm.json().catch(() => null);

    check('THE PERSON WHO PROPOSED IT CANNOT CONFIRM IT',
        selfConfirm.status === 403, `got ${selfConfirm.status}`);
    check('and is told why, not just refused',
        (selfConfirmBody?.error ?? '').includes('other person confirms'),
        selfConfirmBody?.error);

    /* ---- the representative sees it and confirms ---- */
    const repView = await fetch(`${base}/api/appointment?id=${aptId}`, { headers: rAuth });
    const repViewBody = await repView.json().catch(() => null);

    check('the representative can read the same appointment', repView.status === 200,
        `got ${repView.status}`);
    check('it did not come from them, so they may confirm',
        repViewBody?.appointment?.can?.confirm === true &&
        repViewBody?.appointment?.createdByMe === false);
    check('and they are shown the customer\'s name, not their own',
        repViewBody?.appointment?.withName === 'Sarah Tan',
        repViewBody?.appointment?.withName);

    const confirmed = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: rAuth,
        body: JSON.stringify({ action: 'confirm', id: aptId })
    });
    const confirmedBody = await confirmed.json().catch(() => null);

    check('the other side can confirm', confirmed.status === 200,
        `got ${confirmed.status}: ${JSON.stringify(confirmedBody)?.slice(0, 240)}`);
    check('and the status moves', confirmedBody?.appointment?.status === 'confirmed');
    check('confirming twice is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: rAuth,
            body: JSON.stringify({ action: 'confirm', id: aptId })
        })).status === 409);
    check('completing a meeting that has not started is refused',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: rAuth,
            body: JSON.stringify({ action: 'complete', id: aptId })
        })).status === 409);

    /* ---- somebody else's appointment is invisible ---- */
    check('another customer cannot read it, and gets 404 not 403',
        (await fetch(`${base}/api/appointment?id=${aptId}`,
            { headers: { Cookie: `pruwise_session=${tempJar}` } })).status === 401 ||
        (await fetch(`${base}/api/appointment?id=${aptId}`,
            { headers: adminAuth })).status === 403);
    check('an unknown appointment id is 404',
        (await fetch(`${base}/api/appointment?id=apt-nope`, { headers: cAuth })).status === 404);

    /* ---- rescheduling un-agrees it ---- */
    const moved = new Date(soon.getTime() + 4 * 3600000);

    const rescheduled = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: rAuth,
        body: JSON.stringify({ action: 'reschedule', id: aptId,
            start: moved.toISOString(), minutes: 30 })
    });
    const rescheduledBody = await rescheduled.json().catch(() => null);

    check('either side can move it', rescheduled.status === 200,
        `got ${rescheduled.status}: ${JSON.stringify(rescheduledBody)?.slice(0, 240)}`);
    check('MOVING IT UN-AGREES IT',
        rescheduledBody?.appointment?.status === 'pending',
        rescheduledBody?.appointment?.status);
    check('the new time took', rescheduledBody?.appointment?.start === moved.toISOString(),
        rescheduledBody?.appointment?.start);
    check('and the mover cannot now confirm their own new time',
        rescheduledBody?.appointment?.can?.confirm === false);
    check('while the other side can',
        (await (await fetch(`${base}/api/appointment?id=${aptId}`, { headers: cAuth })).json())
            ?.appointment?.can?.confirm === true);

    /* ---- the .ics download ---- */
    const ics = await fetch(`${base}/api/calendar?id=${aptId}`, {
        headers: { Cookie: `pruwise_session=${cJar}` }
    });
    const icsText = await ics.text();

    check('GET /api/calendar?id= returns a calendar file', ics.status === 200,
        `got ${ics.status}`);
    check('with the iCalendar content type',
        (ics.headers.get('content-type') ?? '').startsWith('text/calendar'),
        ics.headers.get('content-type'));
    check('and a filename a downloads folder can make sense of',
        (ics.headers.get('content-disposition') ?? '').includes(`pruwise-${aptId}.ics`),
        ics.headers.get('content-disposition'));
    check('a calendar is never cached, because a stale one shows the wrong time',
        (ics.headers.get('cache-control') ?? '').includes('no-store'),
        ics.headers.get('cache-control'));
    check('it is a well-formed VCALENDAR',
        icsText.startsWith('BEGIN:VCALENDAR\r\n') && icsText.endsWith('END:VCALENDAR\r\n'));
    check('lines are CRLF separated, as the spec requires and Outlook insists',
        !/[^\r]\n/.test(icsText));
    check('the event carries a permanent uid', /\r\nUID:[0-9a-f-]{36}\r\n/.test(icsText));
    check('AND A SEQUENCE THAT WENT UP WHEN IT MOVED',
        /\r\nSEQUENCE:[1-9]\d*\r\n/.test(icsText),
        (/\r\nSEQUENCE:(\d+)/.exec(icsText) ?? [])[1]);
    check('a pending meeting is TENTATIVE, not CONFIRMED',
        icsText.includes('\r\nSTATUS:TENTATIVE\r\n'));
    check('a 30-minute reminder is attached',
        icsText.includes('TRIGGER:-PT30M'));
    check('the agenda is in the description',
        icsText.includes('Check my cover'));
    check('downloading needs a session, and says so in words not JSON', await (async () => {
        const anon = await fetch(`${base}/api/calendar?id=${aptId}`);
        const body = await anon.text();
        return anon.status === 401 && body.includes('sign in');
    })());
    check('an unknown id is a plain-text 404, not JSON', await (async () => {
        const none = await fetch(`${base}/api/calendar?id=apt-nope`,
            { headers: { Cookie: `pruwise_session=${cJar}` } });
        return none.status === 404 &&
            (none.headers.get('content-type') ?? '').startsWith('text/plain');
    })());

    /* ---- the subscribable feed, which has no session at all ---- */
    const feed = await fetch(feedUrl);
    const feedText = await feed.text();

    check('THE FEED WORKS WITH NO COOKIE - THE TOKEN IS THE AUTHENTICATION',
        feed.status === 200, `got ${feed.status}`);
    check('it is a calendar', feedText.startsWith('BEGIN:VCALENDAR'));
    check('named for its owner', feedText.includes('X-WR-CALNAME:PRUWise - Sarah Tan'));
    check('it tells the app how often to come back',
        feedText.includes('REFRESH-INTERVAL;VALUE=DURATION:PT2H'));
    check('and it contains the appointment', feedText.includes(`Smoke test review ${stamp2}`));
    check('a wrong token is a flat 404 with no hint',
        (await fetch(`${base}/api/calendar?feed=${'0'.repeat(40)}`)).status === 404);
    check('a token of the wrong shape does not even reach the database',
        (await fetch(`${base}/api/calendar?feed=short`)).status === 404);
    check('/api/calendar with no parameters is 404',
        (await fetch(`${base}/api/calendar`)).status === 404);

    /* Regenerating breaks every copy of the old address. */
    const regen = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ action: 'regenerate-feed' })
    });
    const regenBody = await regen.json().catch(() => null);

    check('the feed token can be regenerated', regen.status === 200,
        `got ${regen.status}: ${JSON.stringify(regenBody)?.slice(0, 200)}`);
    check('the new address is different', regenBody?.feedUrl !== feedUrl);
    check('THE OLD ADDRESS STOPS WORKING IMMEDIATELY',
        (await fetch(feedUrl)).status === 404);
    check('and the new one works', (await fetch(regenBody.feedUrl)).status === 200);

    /* ---- cancelling ---- */
    const cancelled = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ action: 'cancel', id: aptId })
    });
    const cancelledBody = await cancelled.json().catch(() => null);

    check('either side can cancel', cancelled.status === 200,
        `got ${cancelled.status}: ${JSON.stringify(cancelledBody)?.slice(0, 240)}`);
    check('and the status moves', cancelledBody?.appointment?.status === 'cancelled');
    check('a cancelled meeting cannot be moved',
        (await fetch(`${base}/api/appointment`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ action: 'reschedule', id: aptId,
                start: new Date(Date.now() + 5 * 86400000).toISOString(), minutes: 30 })
        })).status === 409);

    /* A CANCELLED EVENT IS STILL SENT, so a subscribed calendar removes it rather
       than quietly keeping a meeting that is not happening. */
    const feedAfter = await fetch(regenBody.feedUrl);
    const feedAfterText = await feedAfter.text();

    check('A CANCELLED MEETING IS STILL IN THE FEED, MARKED CANCELLED',
        feedAfterText.includes(`Smoke test review ${stamp2}`) &&
        feedAfterText.includes('\r\nSTATUS:CANCELLED\r\n'));
    check('and it carries no reminder any more',
        (feedAfterText.match(/TRIGGER:-PT30M/g) ?? []).length <
            (feedText.match(/TRIGGER:-PT30M/g) ?? []).length + 1);

    /* Reopen, so the row is left in a state a human demo can use. */
    const reopened = await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: rAuth,
        body: JSON.stringify({ action: 'reopen', id: aptId })
    });

    check('a cancelled meeting can be reopened', reopened.status === 200,
        `got ${reopened.status}`);
    check('and comes back as confirmed',
        (await (await fetch(`${base}/api/appointment?id=${aptId}`, { headers: cAuth })).json())
            ?.appointment?.status === 'confirmed');

    /* Put it back to cancelled, so the next run starts from a clear diary. The
       tidy-up at the top of this section would catch it anyway; doing it here as well
       means a single run leaves nothing behind rather than relying on the next one. */
    await fetch(`${base}/api/appointment`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ action: 'cancel', id: aptId })
    });

    /* =====================================================================
       14. VIDEO CALLS

       A whole call between sarah.tan and kristin.henessy, driven from both sides:
       the customer opens the room alone (so the representative's phone rings), the
       representative joins, they swap signalling and spoken lines, the co-pilot
       reads a life event out of what was said, a summary is drafted and sent, and
       the call ends and lands in the history.
       ===================================================================== */

    const rawCall = (path, headers, body) => fetch(`${base}/api/${path}`, {
        method: 'POST', headers, body: JSON.stringify(body)
    });

    /* ---- the customer opens the room alone ---- */
    const cJoin = await rawCall('call-join', cAuth, {});
    const cJoinBody = await cJoin.json().catch(() => null);

    check('POST /api/call-join opens a room', cJoin.status === 200,
        `got ${cJoin.status}: ${JSON.stringify(cJoinBody)?.slice(0, 300)}`);
    check('a random room code comes back',
        /^[A-Za-z0-9]{12}$/.test(cJoinBody?.roomCode ?? ''), cJoinBody?.roomCode);
    check('THE CUSTOMER IS NOT THE OFFERER - the rule is fixed, not negotiated',
        cJoinBody?.isOfferer === false && cJoinBody?.role === 'customer');
    check('the peer is named for the video tile',
        cJoinBody?.peer?.personId === 'fr-001', JSON.stringify(cJoinBody?.peer));
    check('nobody is on the other end yet', cJoinBody?.peerPresent === false);
    check('the room starts as waiting, not active', cJoinBody?.status === 'waiting',
        cJoinBody?.status);
    check('STUN servers are sent from the server, not hard-coded in the browser',
        Array.isArray(cJoinBody?.iceServers) && cJoinBody.iceServers.length > 0 &&
        String(cJoinBody.iceServers[0].urls).startsWith('stun:'));
    check('and a poll interval, so the pace lives in one place',
        typeof cJoinBody?.pollMs === 'number' && cJoinBody.pollMs > 0);

    const room = cJoinBody.roomCode;

    /* ---- so the representative's phone rings ---- */
    const ring = await fetch(`${base}/api/call-ring`, { headers: rAuth });
    const ringBody = await ring.json().catch(() => null);

    check('GET /api/call-ring tells the representative somebody is calling',
        ring.status === 200 && ringBody?.ringing?.roomCode === room,
        `${ring.status}: ${JSON.stringify(ringBody)?.slice(0, 200)}`);
    check('and who it is', ringBody?.ringing?.fromName === 'Sarah Tan' &&
        ringBody?.ringing?.fromPersonId === 'cus-001');
    check('with how long they have been waiting',
        typeof ringBody?.ringing?.waitingSeconds === 'number' &&
        ringBody.ringing.waitingSeconds >= 0);
    check('THE CALLER IS NOT TOLD THEIR OWN CALL IS RINGING',
        (await (await fetch(`${base}/api/call-ring`, { headers: cAuth })).json())
            ?.ringing === null);
    check('an admin polling for rings gets an empty answer, not a 403',
        (await (await fetch(`${base}/api/call-ring`, { headers: adminAuth })).json())
            ?.ringing === null);

    /* ---- the representative joins the same room ---- */
    const rJoin = await rawCall('call-join', rAuth, { withPerson: 'cus-001' });
    const rJoinBody = await rJoin.json().catch(() => null);

    check('the representative lands in THE SAME room',
        rJoinBody?.roomCode === room, `${rJoinBody?.roomCode} vs ${room}`);
    check('and they are the offerer',
        rJoinBody?.isOfferer === true && rJoinBody?.role === 'fr');
    check('BOTH PRESENT PROMOTES THE ROOM TO ACTIVE', rJoinBody?.status === 'active',
        rJoinBody?.status);
    check('and the customer is seen on the line', rJoinBody?.peerPresent === true);

    check('a representative cannot call somebody else\'s customer',
        (await rawCall('call-join', rAuth, { withPerson: 'cus-005' })).status === 403);
    check('or a customer who does not exist',
        (await rawCall('call-join', rAuth, { withPerson: 'cus-nope' })).status === 404);
    check('or nobody at all',
        (await rawCall('call-join', rAuth, {})).status === 400);
    check('an admin cannot join a call',
        (await rawCall('call-join', adminAuth, {})).status === 403);

    /* ---- signalling, and the pin that must survive a re-offer ---- */
    const sent1 = await rawCall('call-sync', rAuth, {
        roomCode: room,
        signals: [
            { kind: 'candidate', payload: 'candidate:stale-one' },
            { kind: 'pin', payload: JSON.stringify(['prd-active', 'prd-ci']) },
            { kind: 'offer', payload: 'v=0 fake-sdp-offer' }
        ],
        lines: [
            { who: 'person', text: 'Thanks for making the time today.',
              ref: `line-r1-${stamp2}` }
        ],
        sinceLine: 0
    });
    const sent1Body = await sent1.json().catch(() => null);

    check('POST /api/call-sync accepts signalling and spoken lines',
        sent1.status === 200, `got ${sent1.status}: ${JSON.stringify(sent1Body)?.slice(0, 240)}`);
    check('the sender sees their own line come back',
        (sent1Body?.transcript ?? []).some(l => l.text?.includes('making the time')));
    check('and it is labelled "You" for them',
        (sent1Body?.transcript ?? []).find(l => l.text?.includes('making the time'))
            ?.name === 'You');

    const custInbox = await rawCall('call-sync', cAuth, {
        roomCode: room, sinceLine: 0
    });
    const custInboxBody = await custInbox.json().catch(() => null);

    check('the other side collects the signalling', custInbox.status === 200 &&
        (custInboxBody?.signals ?? []).some(s => s.kind === 'offer'),
        JSON.stringify(custInboxBody?.signals?.map(s => s.kind)));
    check('A NEW OFFER CLEARS STALE ICE CANDIDATES',
        !(custInboxBody?.signals ?? []).some(s => s.kind === 'candidate'),
        JSON.stringify(custInboxBody?.signals?.map(s => s.kind)));
    check('BUT A PINNED POLICY LIST SURVIVES THE SAME CLEAR-OUT',
        (custInboxBody?.signals ?? []).some(s => s.kind === 'pin'),
        JSON.stringify(custInboxBody?.signals?.map(s => s.kind)));
    check('the offer says which side it came from',
        (custInboxBody?.signals ?? []).find(s => s.kind === 'offer')?.from === 'fr');
    check('the spoken line arrived too',
        (custInboxBody?.transcript ?? []).some(l => l.text?.includes('making the time')));
    check('and reads as the other person, with their name',
        (custInboxBody?.transcript ?? []).find(l => l.text?.includes('making the time'))
            ?.name === 'Kristin Henessy');

    check('THE MAILBOX DRAINS - a second poll does not redeliver it',
        ((await (await rawCall('call-sync', cAuth, { roomCode: room, sinceLine: 0 })).json())
            ?.signals ?? []).length === 0);

    /* ---- the customer answers, and says something the co-pilot cares about ---- */
    const custSaid = await rawCall('call-sync', cAuth, {
        roomCode: room,
        signals: [{ kind: 'answer', payload: 'v=0 fake-sdp-answer' }],
        lines: [
            { who: 'person', text: 'My wife is pregnant, and we are buying a flat too.',
              ref: `line-c1-${stamp2}` },
            { who: 'person', text: 'How much does it cost to add cover for the baby?',
              ref: `line-c2-${stamp2}` }
        ],
        sinceLine: custInboxBody.transcriptSince
    });
    const custSaidBody = await custSaid.json().catch(() => null);

    check('the customer can answer and speak', custSaid.status === 200,
        `got ${custSaid.status}`);
    check('THE SAME LINE REF DOES NOT DOUBLE UP', await (async () => {
        const again = await rawCall('call-sync', cAuth, {
            roomCode: room,
            lines: [{ who: 'person', text: 'a retry', ref: `line-c1-${stamp2}` }],
            sinceLine: 0
        });
        const body = await again.json().catch(() => null);
        return (body?.transcript ?? []).filter(l => l.ref === `line-c1-${stamp2}`).length === 1;
    })());

    const repHears = await rawCall('call-sync', rAuth, {
        roomCode: room, sinceLine: sent1Body.transcriptSince
    });
    const repHearsBody = await repHears.json().catch(() => null);

    check('the representative receives the answer',
        (repHearsBody?.signals ?? []).some(s => s.kind === 'answer'));
    check('and hears what the customer said',
        (repHearsBody?.transcript ?? []).some(l => l.text?.includes('pregnant')));

    check('a room code somebody is not in is 404, not 403',
        (await rawCall('call-sync', { ...adminAuth }, { roomCode: room })).status === 403);
    check('an invented room code is 404',
        (await rawCall('call-sync', cAuth, { roomCode: 'nosuchroom12' })).status === 404);
    check('an unknown signal kind is refused',
        (await rawCall('call-sync', rAuth, {
            roomCode: room, signals: [{ kind: 'hack', payload: 'x' }]
        })).status === 400);

    /* =================================================================
       THE CO-PILOT
       ================================================================= */
    const copilot = await rawCall('call-copilot', rAuth, {
        roomCode: room, text: 'My wife is pregnant and we are buying a flat.'
    });
    const copilotBody = await copilot.json().catch(() => null);

    check('POST /api/call-copilot reads a life event', copilot.status === 200,
        `got ${copilot.status}: ${JSON.stringify(copilotBody)?.slice(0, 300)}`);
    check('the strongest trigger is the new dependent',
        copilotBody?.triggers?.[0]?.id === 'new-dependent',
        JSON.stringify(copilotBody?.triggers?.map(t => t.id)));
    check('two triggers at most, because attention is rationed',
        (copilotBody?.triggers ?? []).length === 2,
        String(copilotBody?.triggers?.length));
    check('and the second is the mortgage',
        copilotBody?.triggers?.[1]?.id === 'property');
    check('IT SAYS WHY IT FIRED, so a wrong card can be judged',
        copilotBody?.triggers?.[0]?.heard === 'pregnant',
        copilotBody?.triggers?.[0]?.heard);
    check('it names only products that really exist',
        (copilotBody?.triggers ?? []).every(t =>
            (t.products ?? []).every(p => typeof p.name === 'string' && p.name.startsWith('PRU'))));
    check('it suggests the education plan for a new dependent',
        (copilotBody?.triggers?.[0]?.products ?? []).some(p => p.productId === 'prd-edu'));
    check('and carries a question to ask, not just a product to sell',
        typeof copilotBody?.triggers?.[0]?.ask === 'string' &&
        copilotBody.triggers[0].ask.length > 10);

    check('an ordinary sentence triggers nothing',
        ((await (await rawCall('call-copilot', rAuth, {
            roomCode: room, text: 'The weather has been quite good this week.'
        })).json())?.triggers ?? []).length === 0);
    check('THE CUSTOMER NEVER SEES THE CO-PILOT',
        (await rawCall('call-copilot', cAuth, { roomCode: room, text: 'pregnant' })).status === 403);
    check('and a representative cannot ask about a call that is not theirs',
        (await rawCall('call-copilot', rAuth, {
            roomCode: 'nosuchroom12', text: 'pregnant'
        })).status === 403);
    check('empty text is an empty answer, not an error',
        (await rawCall('call-copilot', rAuth, { roomCode: room, text: '' })).status === 200);

    /* =================================================================
       THE AFTER-CALL SUMMARY
       ================================================================= */
    const draft = await fetch(`${base}/api/call-summary?roomCode=${room}`, { headers: rAuth });
    const draftBody = await draft.json().catch(() => null);

    check('GET /api/call-summary builds a draft', draft.status === 200,
        `got ${draft.status}: ${JSON.stringify(draftBody)?.slice(0, 300)}`);
    check('it read the whole call, not just two triggers',
        (draftBody?.summary?.triggerIds ?? []).length >= 3,
        JSON.stringify(draftBody?.summary?.triggerIds));
    check('the new dependent is in what was discussed',
        (draftBody?.summary?.discussed ?? []).some(d => d.includes('new dependent')));
    check('IT PICKED UP THE QUESTION THE CUSTOMER ASKED',
        (draftBody?.summary?.questions ?? []).some(q => q.includes('How much does it cost')),
        JSON.stringify(draftBody?.summary?.questions));
    check('and NOT the representative\'s own words',
        !(draftBody?.summary?.questions ?? []).some(q => q.includes('making the time')));
    check('next steps are de-duplicated',
        new Set(draftBody?.summary?.nextSteps ?? []).size ===
            (draftBody?.summary?.nextSteps ?? []).length);
    check('the draft is addressed to the customer by first name',
        (draftBody?.summary?.draft ?? '').startsWith('Hi Sarah,'),
        (draftBody?.summary?.draft ?? '').slice(0, 40));
    check('IT REPORTS WHAT WAS DISCUSSED AND NEVER WHAT WAS AGREED',
        !/agreed to|decided to|will proceed|has agreed/i.test(draftBody?.summary?.draft ?? ''));
    check('IT CONTAINS NO FIGURES, because a half-remembered premium in writing is worse ' +
          'than none', !/\$\s?\d/.test(draftBody?.summary?.draft ?? ''));
    check('it invites correction rather than closing the matter',
        (draftBody?.summary?.draft ?? '').includes('tell me and I will correct it'));
    check('nothing has been sent yet', draftBody?.alreadySent === null);
    check('THE CUSTOMER DOES NOT WRITE THEIR OWN SUMMARY',
        (await fetch(`${base}/api/call-summary?roomCode=${room}`, { headers: cAuth }))
            .status === 403);

    /* Sending an EDITED body, which is the whole premise of the feature. */
    const edited = `${draftBody.summary.draft}\n\nEdited by the smoke test ${stamp2}.`;

    const summarySent = await rawCall('call-summary', rAuth, { roomCode: room, body: edited });
    const summarySentBody = await summarySent.json().catch(() => null);

    check('POST /api/call-summary sends it', summarySent.status === 200,
        `got ${summarySent.status}: ${JSON.stringify(summarySentBody)?.slice(0, 240)}`);
    check('and says where it went',
        summarySentBody?.sent === true && summarySentBody?.threadId === humanThreadId,
        JSON.stringify(summarySentBody));

    const inThread = await fetch(`${base}/api/thread?threadId=${humanThreadId}`, { headers: cAuth });
    const inThreadBody = await inThread.json().catch(() => null);

    check('THE SUMMARY ARRIVES AS AN ORDINARY MESSAGE THE CUSTOMER ALREADY READS',
        (inThreadBody?.messages ?? []).some(m =>
            (m.paragraphs?.[0] ?? '').includes(`Edited by the smoke test ${stamp2}`)));
    check('IT IS THE EDITED VERSION, not the one we generated',
        (inThreadBody?.messages ?? []).some(m =>
            (m.paragraphs?.[0] ?? '').includes('Edited by the smoke test')));
    check('a second GET now reports it as already sent',
        (await (await fetch(`${base}/api/call-summary?roomCode=${room}`, { headers: rAuth })).json())
            ?.alreadySent !== null);
    check('an empty summary is refused',
        (await rawCall('call-summary', rAuth, { roomCode: room, body: '   ' })).status === 400);
    check('a 5000-character summary is refused',
        (await rawCall('call-summary', rAuth, {
            roomCode: room, body: 'x'.repeat(4001)
        })).status === 400);

    /* Re-sending is a correction, and must not post the message twice. */
    const summaryResend = await rawCall('call-summary', rAuth, {
        roomCode: room, body: `${edited}\nCorrected.`
    });

    check('re-sending a correction is allowed', summaryResend.status === 200, `got ${summaryResend.status}`);

    const afterResend = await fetch(`${base}/api/thread?threadId=${humanThreadId}`,
        { headers: cAuth });
    const afterResendBody = await afterResend.json().catch(() => null);

    check('AND DOES NOT POST THE MESSAGE A SECOND TIME',
        (afterResendBody?.messages ?? []).filter(m =>
            (m.paragraphs?.[0] ?? '').includes(`Edited by the smoke test ${stamp2}`)).length === 1);

    /* =================================================================
       HANGING UP
       ================================================================= */
    const ended = await rawCall('call-end', cAuth, { roomCode: room });
    const endedBody = await ended.json().catch(() => null);

    check('EITHER SIDE MAY HANG UP - here the customer does', ended.status === 200,
        `got ${ended.status}: ${JSON.stringify(endedBody)?.slice(0, 240)}`);
    check('a duration comes back, worked out from the server\'s own timestamps',
        typeof endedBody?.seconds === 'number' && endedBody.seconds >= 0,
        String(endedBody?.seconds));
    check('with a count of what was actually said',
        endedBody?.lines >= 3, String(endedBody?.lines));
    check('and the transcript, so the summary needs no second request',
        Array.isArray(endedBody?.transcript) && endedBody.transcript.length >= 3);

    const deadPoll = await rawCall('call-sync', rAuth, { roomCode: room, sinceLine: 0 });
    const deadPollBody = await deadPoll.json().catch(() => null);

    check('THE OTHER SIDE LEARNS IT ENDED FROM THE NEXT POLL, not from a message',
        deadPollBody?.ended === true && deadPollBody?.status === 'ended');
    check('and is not left polling a dead room for signalling',
        (deadPollBody?.signals ?? []).length === 0);
    check('the ring stops as soon as the room closes',
        (await (await fetch(`${base}/api/call-ring`, { headers: rAuth })).json())
            ?.ringing === null);

    /* =================================================================
       THE HISTORY
       ================================================================= */
    const history = await fetch(`${base}/api/calls`, { headers: rAuth });
    const historyBody = await history.json().catch(() => null);

    check('GET /api/calls lists the call history', history.status === 200,
        `got ${history.status}: ${JSON.stringify(historyBody)?.slice(0, 200)}`);
    check('the call that just happened is at the top',
        historyBody?.calls?.[0]?.withName === 'Sarah Tan',
        JSON.stringify(historyBody?.calls?.[0])?.slice(0, 200));
    check('BOTH SIDES WERE PRESENT, so it counts as connected',
        historyBody?.calls?.[0]?.connected === true);
    check('the duration is pre-formatted for the screen',
        /^\d+[ms]/.test(historyBody?.calls?.[0]?.duration ?? ''),
        historyBody?.calls?.[0]?.duration);
    check('the transcript lines are counted',
        historyBody?.calls?.[0]?.lineCount >= 3,
        String(historyBody?.calls?.[0]?.lineCount));
    check('and it is no longer live', historyBody?.calls?.[0]?.live === false);
    check('the customer sees the same call from their side',
        (await (await fetch(`${base}/api/calls`, { headers: cAuth })).json())
            ?.calls?.[0]?.withName === 'Kristin Henessy');
    check('a silly limit is clamped rather than refused',
        (await fetch(`${base}/api/calls?limit=99999`, { headers: rAuth })).status === 200);
    check('an admin has no call history',
        (await fetch(`${base}/api/calls`, { headers: adminAuth })).status === 403);
    check('/api/calls needs a session',
        (await fetch(`${base}/api/calls`)).status === 401);

    /* =====================================================================
       15. THE ADMIN CONSOLE

       Every action is exercised against a THROWAWAY representative created here
       and deleted at the end, so nothing touches the demo accounts. The guards
       that protect an admin from themselves are checked against the real admin
       account, because refusing is all they do.
       ===================================================================== */

    check('GET /api/admin/users needs to be an admin',
        (await fetch(`${base}/api/admin/users`, { headers: cAuth })).status === 403);
    check('and needs a session at all',
        (await fetch(`${base}/api/admin/users`)).status === 401);

    const userList = await fetch(`${base}/api/admin/users`, { headers: adminAuth });
    const userListBody = await userList.json().catch(() => null);

    check('GET /api/admin/users lists accounts', userList.status === 200,
        `got ${userList.status}: ${JSON.stringify(userListBody)?.slice(0, 200)}`);
    check('NO PASSWORD HASH IS EVER RETURNED',
        !JSON.stringify(userListBody).toLowerCase().includes('password'));
    check('the seeded accounts are all there',
        (userListBody?.users ?? []).length >= 3, String(userListBody?.users?.length));
    check('a customer row carries their representative\'s name',
        (userListBody?.users ?? []).find(u => u.username === 'sarah.tan')?.repName
            === 'Kristin Henessy');
    check('a representative row carries a customer count',
        (userListBody?.users ?? []).find(u => u.username === 'kristin.henessy')
            ?.customerCount >= 5);
    check('summary counts come back for the cards',
        userListBody?.stats?.total >= 3 && userListBody?.stats?.byRole?.admin >= 1,
        JSON.stringify(userListBody?.stats));
    check('every representative is listed for the reassign dropdown',
        (userListBody?.reps ?? []).length === 7, String(userListBody?.reps?.length));
    check('and pagination is reported', userListBody?.page?.page === 1 &&
        userListBody?.page?.pages >= 1);

    check('SEARCH IS CASE-INSENSITIVE', await (async () => {
        const hit = await (await fetch(`${base}/api/admin/users?q=SARAH`,
            { headers: adminAuth })).json();
        return (hit?.users ?? []).some(u => u.username === 'sarah.tan');
    })());
    check('a SQL-injection-shaped search finds nothing and breaks nothing',
        await (async () => {
            const attempt = await fetch(
                `${base}/api/admin/users?q=${encodeURIComponent("' OR 1=1--")}`,
                { headers: adminAuth });
            const body = await attempt.json().catch(() => null);
            return attempt.status === 200 && (body?.users ?? []).length === 0;
        })());
    check('filtering by role works',
        ((await (await fetch(`${base}/api/admin/users?role=admin`, { headers: adminAuth }))
            .json())?.users ?? []).every(u => u.role === 'admin'));
    check('AN INVENTED SORT FALLS BACK RATHER THAN REACHING THE SQL',
        (await fetch(`${base}/api/admin/users?sort=${encodeURIComponent('a.id; DROP TABLE')}`,
            { headers: adminAuth })).status === 200);
    check('sorting by last seen puts never-signed-in accounts last',
        await (async () => {
            const body = await (await fetch(`${base}/api/admin/users?sort=lastseen`,
                { headers: adminAuth })).json();
            const users = body?.users ?? [];
            const firstNull = users.findIndex(u => u.lastLogin === null);
            const withLogin = users.filter(u => u.lastLogin !== null).length;
            return firstNull === -1 || firstNull === withLogin;
        })());

    /* ---- one account in full ---- */
    const adminId = (userListBody?.users ?? []).find(u => u.username === 'admin')?.accountId;
    const sarahId = (userListBody?.users ?? []).find(u => u.username === 'sarah.tan')?.accountId;

    check('the accounts have ids', typeof adminId === 'number' && typeof sarahId === 'number');

    const oneUser = await fetch(`${base}/api/admin/user?id=${sarahId}`, { headers: adminAuth });
    const oneUserBody = await oneUser.json().catch(() => null);

    check('GET /api/admin/user returns one account in full', oneUser.status === 200,
        `got ${oneUser.status}: ${JSON.stringify(oneUserBody)?.slice(0, 200)}`);
    check('with what a delete would destroy, as the warning',
        oneUserBody?.activity?.conversations >= 1 &&
        oneUserBody?.activity?.appointments >= 1,
        JSON.stringify(oneUserBody?.activity));
    check('recent sign-in attempts, so "why can they not get in" has an answer',
        Array.isArray(oneUserBody?.attempts) && oneUserBody.attempts.length > 0);
    check('including the failed one this test made earlier',
        (oneUserBody?.attempts ?? []).some(a => a.succeeded === false));
    check('their own audit trail', Array.isArray(oneUserBody?.audit) &&
        oneUserBody.audit.length > 0);
    check('the assignment history from the consultation accept',
        Array.isArray(oneUserBody?.assignments));
    check('and it knows this is not the admin looking at themselves',
        oneUserBody?.user?.isSelf === false);
    check('the admin looking at their own row is told so',
        (await (await fetch(`${base}/api/admin/user?id=${adminId}`, { headers: adminAuth }))
            .json())?.user?.isSelf === true);
    check('an unknown account id is 404',
        (await fetch(`${base}/api/admin/user?id=999999`, { headers: adminAuth })).status === 404);

    /* ---- THE GUARDS THAT STOP AN ADMIN LOCKING THEMSELVES OUT ---- */
    const adminAction = (action, extra = {}) => fetch(`${base}/api/admin/user`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({ id: adminId, action, ...extra })
    });

    check('AN ADMIN CANNOT SUSPEND THEMSELVES',
        (await adminAction('suspend')).status === 400);
    check('AN ADMIN CANNOT DELETE THEMSELVES',
        (await adminAction('delete', { confirm: true, confirmUsername: 'admin' })).status === 400);
    check('AN ADMIN CANNOT SIGN THEMSELVES OUT FROM HERE',
        (await adminAction('signout')).status === 400);
    check('and is pointed at Settings instead',
        (await (await adminAction('signout')).json())?.error?.includes('Settings') === true);
    check('an unknown action is refused',
        (await adminAction('become-god')).status === 400);

    /* ---- create a throwaway representative ---- */
    const repStamp = Math.random().toString(36).slice(2, 8);
    const newRepUser = `smokerep.${repStamp}`;

    check('a customer cannot create accounts',
        (await fetch(`${base}/api/admin/create-user`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ role: 'fr', name: 'X Y', email: 'a@b.com', username: 'abcd' })
        })).status === 403);
    check('A CUSTOMER ACCOUNT CANNOT BE CREATED HERE - they register themselves',
        (await fetch(`${base}/api/admin/create-user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({
                role: 'customer', name: 'Sneaky Customer',
                email: `x.${repStamp}@example.com`, username: `x.${repStamp}`
            })
        })).status === 400);

    const madeRep = await fetch(`${base}/api/admin/create-user`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({
            role: 'fr',
            name: 'Smoke Representative',
            email: `${newRepUser}@example.com`,
            username: newRepUser,
            phone: '+65 6555 0100'
        })
    });
    const madeRepBody = await madeRep.json().catch(() => null);

    check('POST /api/admin/create-user makes a representative', madeRep.status === 200,
        `got ${madeRep.status}: ${JSON.stringify(madeRepBody)?.slice(0, 300)}`);
    check('with an fr- person id',
        /^fr-[0-9a-f]{8}$/.test(madeRepBody?.personId ?? ''), madeRepBody?.personId);
    check('and an account id', typeof madeRepBody?.accountId === 'number');
    check('the invitation link is NOT handed back in production',
        madeRepBody?.devLink === null, String(madeRepBody?.devLink));
    check('a duplicate username is refused',
        (await fetch(`${base}/api/admin/create-user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({
                role: 'fr', name: 'Clash', email: `other.${repStamp}@example.com`,
                username: newRepUser
            })
        })).status === 409);
    check('a duplicate email is refused',
        (await fetch(`${base}/api/admin/create-user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({
                role: 'fr', name: 'Clash', email: `${newRepUser}@example.com`,
                username: `other.${repStamp}`
            })
        })).status === 409);
    check('a nonsense phone number is refused',
        (await fetch(`${base}/api/admin/create-user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({
                role: 'fr', name: 'Bad Phone', email: `p.${repStamp}@example.com`,
                username: `p.${repStamp}`, phone: '12'
            })
        })).status === 400);

    const newRepId = madeRepBody.accountId;
    const newRepPersonId = madeRepBody.personId;

    /* THE NEW ACCOUNT CANNOT BE SIGNED INTO. There is no password, and the hash it
       was given is a real bcrypt hash of a random string nobody holds. */
    check('THE NEW ACCOUNT CANNOT BE SIGNED INTO UNTIL ITS OWNER SETS A PASSWORD',
        (await fetch(`${base}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newRepUser, password: 'password' })
        })).status === 401);
    check('and it appears in the list as unverified',
        (await (await fetch(`${base}/api/admin/users?q=${newRepUser}`, { headers: adminAuth }))
            .json())?.users?.[0]?.emailVerified === false);

    /* ---- the per-account actions, on the throwaway ---- */
    const onRep = (action, extra = {}) => fetch(`${base}/api/admin/user`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({ id: newRepId, action, ...extra })
    });

    check('verify-email marks it confirmed by hand',
        (await onRep('verify-email')).status === 200);
    check('and it shows as verified afterwards',
        (await (await fetch(`${base}/api/admin/user?id=${newRepId}`, { headers: adminAuth }))
            .json())?.user?.emailVerified === true);

    check('suspend works', (await onRep('suspend')).status === 200);
    check('and the account reads as suspended',
        (await (await fetch(`${base}/api/admin/user?id=${newRepId}`, { headers: adminAuth }))
            .json())?.user?.status === 'suspended');
    check('activate undoes it', (await onRep('activate')).status === 200);
    check('and it can sign in again, in principle',
        (await (await fetch(`${base}/api/admin/user?id=${newRepId}`, { headers: adminAuth }))
            .json())?.user?.status === 'active');

    check('signout bumps the session epoch', await (async () => {
        const before = await (await fetch(`${base}/api/admin/user?id=${newRepId}`,
            { headers: adminAuth })).json();
        await onRep('signout');
        const after = await (await fetch(`${base}/api/admin/user?id=${newRepId}`,
            { headers: adminAuth })).json();
        return after?.user?.sessionEpoch > before?.user?.sessionEpoch;
    })());

    const resetSent = await onRep('send-reset');
    const resetSentBody = await resetSent.json().catch(() => null);

    check('send-reset emails a link', resetSent.status === 200,
        `got ${resetSent.status}: ${JSON.stringify(resetSentBody)?.slice(0, 200)}`);
    check('THE ADMIN NEVER SEES THE TOKEN', resetSentBody?.devLink === null);
    check('THERE IS NO ACTION THAT SETS A PASSWORD',
        (await onRep('set-password', { password: 'letmein12345' })).status === 400);

    check('a representative cannot be reassigned to a representative',
        (await onRep('reassign-rep', { repId: 'fr-002' })).status === 400);

    /* ---- reassigning a customer, and putting them back ---- */
    const reassigned = await fetch(`${base}/api/admin/user`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({ id: sarahId, action: 'reassign-rep', repId: newRepPersonId })
    });
    const reassignedBody = await reassigned.json().catch(() => null);

    check('a customer can be reassigned', reassigned.status === 200,
        `got ${reassigned.status}: ${JSON.stringify(reassignedBody)?.slice(0, 240)}`);
    check('and it says who they went to',
        (reassignedBody?.message ?? '').includes('Smoke Representative'),
        reassignedBody?.message);
    check('THE MOVE IS RECORDED IN THE ASSIGNMENT HISTORY',
        (await (await fetch(`${base}/api/admin/user?id=${sarahId}`, { headers: adminAuth }))
            .json())?.assignments?.[0]?.to === 'Smoke Representative');
    check('reassigning to the same representative twice is refused',
        (await fetch(`${base}/api/admin/user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ id: sarahId, action: 'reassign-rep', repId: newRepPersonId })
        })).status === 400);
    check('an invented representative is refused',
        (await fetch(`${base}/api/admin/user`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ id: sarahId, action: 'reassign-rep', repId: 'fr-nope' })
        })).status === 400);

    /* Put her back with fr-001, or every later run of this file breaks. */
    const putBack = await fetch(`${base}/api/admin/user`, {
        method: 'POST', headers: adminAuth,
        body: JSON.stringify({ id: sarahId, action: 'reassign-rep', repId: 'fr-001' })
    });

    check('and moved back to her original representative', putBack.status === 200,
        `got ${putBack.status}`);
    check('the demo relationship is restored',
        (await (await fetch(`${base}/api/admin/user?id=${sarahId}`, { headers: adminAuth }))
            .json())?.user?.repId === 'fr-001');

    /* ---- the change-request queue ---- */
    const changeQueue = await fetch(`${base}/api/admin/requests`, { headers: adminAuth });
    const changeQueueBody = await changeQueue.json().catch(() => null);

    check('GET /api/admin/requests returns the queue', changeQueue.status === 200,
        `got ${changeQueue.status}: ${JSON.stringify(changeQueueBody)?.slice(0, 200)}`);
    check('with counts per status',
        changeQueueBody?.counts && typeof changeQueueBody.counts.open === 'number',
        JSON.stringify(changeQueueBody?.counts));
    check('and requests as an array', Array.isArray(changeQueueBody?.requests));
    check('a customer cannot read the queue',
        (await fetch(`${base}/api/admin/requests`, { headers: cAuth })).status === 403);
    check('an unknown request id is 404',
        (await fetch(`${base}/api/admin/requests`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ id: 999999, action: 'approve', repId: 'fr-002' })
        })).status === 404);
    check('a one-word decline reason would be refused', await (async () => {
        const open = (changeQueueBody?.requests ?? []).find(r => r.status === 'open');
        if (!open) { return true; }          /* nothing open to test against */
        const attempt = await fetch(`${base}/api/admin/requests`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ id: open.id, action: 'decline', reason: 'no' })
        });
        return attempt.status === 400;
    })());

    /* ---- the audit log ---- */
    const auditLog = await fetch(`${base}/api/admin/audit`, { headers: adminAuth });
    const auditLogBody = await auditLog.json().catch(() => null);

    check('GET /api/admin/audit returns the activity log', auditLog.status === 200,
        `got ${auditLog.status}: ${JSON.stringify(auditLogBody)?.slice(0, 200)}`);
    check('entries came back', (auditLogBody?.entries ?? []).length > 0,
        String(auditLogBody?.entries?.length));
    check('THIS TEST\'S OWN ADMIN ACTIONS ARE IN IT',
        (auditLogBody?.entries ?? []).some(e => e.action === 'admin_created_user'));
    check('an entry names who did it',
        (auditLogBody?.entries ?? []).find(e => e.action === 'admin_created_user')
            ?.username === 'admin');
    check('recent failed sign-ins are surfaced separately',
        Array.isArray(auditLogBody?.failures) && auditLogBody.failures.length > 0);
    check('and the filter list is built from what actually exists',
        (auditLogBody?.actions ?? []).some(a => a.action === 'login' && a.count > 0),
        JSON.stringify(auditLogBody?.actions?.slice(0, 3)));
    check('the action filter works',
        ((await (await fetch(`${base}/api/admin/audit?action=policy`, { headers: adminAuth }))
            .json())?.entries ?? []).every(e => e.action.includes('policy')));
    check('a customer cannot read the audit log',
        (await fetch(`${base}/api/admin/audit`, { headers: cAuth })).status === 403);
    check('THERE IS NO WAY TO EDIT OR DELETE A LOG ENTRY',
        (await fetch(`${base}/api/admin/audit`, { method: 'POST', headers: adminAuth, body: '{}' }))
            .status === 405);

    /* ---- delete the throwaway, which also tests the delete guards ---- */
    check('delete without confirmation is refused',
        (await onRep('delete')).status === 400);
    check('DELETE NEEDS THE USERNAME TYPED BACK EXACTLY',
        (await onRep('delete', { confirm: true, confirmUsername: 'not-the-name' })).status === 400);
    check('and the refusal names the field',
        (await (await onRep('delete', { confirm: true, confirmUsername: 'wrong' })).json())
            ?.field === 'confirmUsername');

    const deletedRep = await onRep('delete', { confirm: true, confirmUsername: newRepUser });
    const deletedRepBody = await deletedRep.json().catch(() => null);

    check('the throwaway representative can be deleted', deletedRep.status === 200,
        `got ${deletedRep.status}: ${JSON.stringify(deletedRepBody)?.slice(0, 240)}`);
    check('and is gone from the list',
        ((await (await fetch(`${base}/api/admin/users?q=${newRepUser}`, { headers: adminAuth }))
            .json())?.users ?? []).length === 0);
    check('the audit log records the deletion, outliving the account',
        ((await (await fetch(`${base}/api/admin/audit?action=admin_deleted_user`,
            { headers: adminAuth })).json())?.entries ?? [])
            .some(e => e.detail === newRepUser));

    /* =====================================================================
       16. THE LANGUAGE MODEL, AND THE BOUNDARY AROUND IT

       These checks pass either way: with a key configured the model answers, and
       without one the endpoints report themselves unavailable and the app falls
       back to its rules. What is asserted is the CONTRACT - never that OpenAI is
       reachable, which is not something a test can promise.
       ===================================================================== */

    const sessionInfo = await (await fetch(`${base}/api/session`, { headers: cAuth })).json();
    const modelConfigured = sessionInfo?.server?.aiEnabled === true;

    check('/api/session says whether a model is configured',
        typeof sessionInfo?.server?.aiEnabled === 'boolean',
        String(sessionInfo?.server?.aiEnabled));
    check('THE KEY ITSELF IS NEVER SENT TO THE BROWSER',
        !JSON.stringify(sessionInfo).includes('sk-'));

    console.log(`  ..   a model is ${modelConfigured ? 'CONFIGURED' : 'not configured'} ` +
        'on this deployment');

    /* ---- the relay ---- */
    check('/api/ai needs a session - it spends money',
        (await fetch(`${base}/api/ai`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
        })).status === 401);
    check('/api/ai refuses a GET',
        (await fetch(`${base}/api/ai`, { headers: cAuth })).status === 405);
    check('a body with no messages is refused',
        (await fetch(`${base}/api/ai`, {
            method: 'POST', headers: cAuth, body: JSON.stringify({})
        })).status === 400);
    check('a body with no user turn is refused',
        (await fetch(`${base}/api/ai`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ messages: [{ role: 'system', content: 'be nice' }] })
        })).status === 400);

    const askAi = await fetch(`${base}/api/ai`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({
            /* A model the server must ignore. If it were honoured this request
               would fail outright, so a 200 is itself the proof. */
            model: 'gpt-4-turbo-please-charge-me',
            max_tokens: 120,
            messages: [
                { role: 'system', content: 'You are helping a customer called Sarah.' },
                { role: 'user', content: 'In one sentence, what is critical illness cover?' }
            ]
        })
    });
    const askAiBody = await askAi.json().catch(() => null);

    check('POST /api/ai answers 200 whether or not a model is reachable',
        askAi.status === 200, `got ${askAi.status}: ${JSON.stringify(askAiBody)?.slice(0, 200)}`);
    check('THE BROWSER DOES NOT GET TO CHOOSE THE MODEL',
        askAiBody?.model === undefined || askAiBody.model !== 'gpt-4-turbo-please-charge-me',
        String(askAiBody?.model));

    if (modelConfigured) {
        check('THE MODEL ACTUALLY ANSWERED - the key works end to end',
            (askAiBody?.choices?.[0]?.message?.content ?? '').length > 20,
            JSON.stringify(askAiBody)?.slice(0, 300));
        check('and the answer carries no markdown headings or bold',
            !/\*\*|^#/m.test(askAiBody?.choices?.[0]?.message?.content ?? ''));
    } else {
        check('with no key it says so rather than pretending',
            askAiBody?.reason === 'not-configured', JSON.stringify(askAiBody)?.slice(0, 200));
        check('and hands back no choices, so the browser uses its rules',
            (askAiBody?.choices ?? []).length === 0);
    }

    /* ---- suggested replies ---- */
    check('/api/suggest-reply needs a session',
        (await fetch(`${base}/api/suggest-reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: humanThreadId })
        })).status === 401);
    check('an admin has no conversations to suggest replies for',
        (await fetch(`${base}/api/suggest-reply`, {
            method: 'POST', headers: adminAuth,
            body: JSON.stringify({ threadId: humanThreadId })
        })).status === 403);
    check('A THREAD YOU ARE NOT IN IS 404, NOT 403',
        (await fetch(`${base}/api/suggest-reply`, {
            method: 'POST', headers: cAuth, body: JSON.stringify({ threadId: 999999 })
        })).status === 404);
    check('no thread id is refused',
        (await fetch(`${base}/api/suggest-reply`, {
            method: 'POST', headers: cAuth, body: JSON.stringify({})
        })).status === 400);
    check('suggesting replies to PRUWise itself is refused', await (async () => {
        const ai = await (await fetch(`${base}/api/thread?kind=ai`, { headers: cAuth })).json();
        const attempt = await fetch(`${base}/api/suggest-reply`, {
            method: 'POST', headers: cAuth, body: JSON.stringify({ threadId: ai.threadId })
        });
        return attempt.status === 400;
    })());

    const suggest = await fetch(`${base}/api/suggest-reply`, {
        method: 'POST', headers: rAuth, body: JSON.stringify({ threadId: humanThreadId })
    });
    const suggestBody = await suggest.json().catch(() => null);

    check('POST /api/suggest-reply answers', suggest.status === 200,
        `got ${suggest.status}: ${JSON.stringify(suggestBody)?.slice(0, 300)}`);
    check('with two or three suggestions',
        (suggestBody?.suggestions ?? []).length >= 2 &&
        (suggestBody?.suggestions ?? []).length <= 3,
        String(suggestBody?.suggestions?.length));
    check('and says where the wording came from',
        ['openai', 'rules'].includes(suggestBody?.source), suggestBody?.source);
    check('each suggestion is a sendable sentence, not a fragment',
        (suggestBody?.suggestions ?? []).every(s =>
            typeof s === 'string' && s.length > 8 && s.length <= 300),
        JSON.stringify(suggestBody?.suggestions));

    /* THE BOUNDARY. These hold for the model's wording AND for the fallbacks,
       which is the point of testing them here rather than trusting the prompt. */
    const allSuggestions = (suggestBody?.suggestions ?? []).join(' ');

    check('NO SUGGESTION QUOTES A MONETARY FIGURE',
        !/\$\s?\d|\d+\s?(dollars|SGD)/i.test(allSuggestions), allSuggestions.slice(0, 200));
    check('NO SUGGESTION NAMES A PRODUCT',
        !/PRU[A-Z]/.test(allSuggestions), allSuggestions.slice(0, 200));
    check('NO SUGGESTION CLAIMS SOMETHING WAS AGREED OR APPROVED',
        !/\b(agreed|approved|guarantee|guaranteed|confirmed that you)\b/i.test(allSuggestions),
        allSuggestions.slice(0, 200));

    if (modelConfigured) {
        check('THE MODEL WROTE THEM, not the fallback rules',
            suggestBody?.source === 'openai', suggestBody?.source);

        /* The fallback strings are fixed and known, so seeing one of them when a
           model is configured means the model call failed silently. */
        check('and they are not the built-in wording',
            !allSuggestions.includes('Thanks for letting me know - let me look into that'),
            allSuggestions.slice(0, 160));
    }

    /* A customer's suggestions are worded for a customer, not for an adviser. */
    const custSuggest = await fetch(`${base}/api/suggest-reply`, {
        method: 'POST', headers: cAuth, body: JSON.stringify({ threadId: humanThreadId })
    });
    const custSuggestBody = await custSuggest.json().catch(() => null);

    check('a customer gets suggestions too', custSuggest.status === 200 &&
        (custSuggestBody?.suggestions ?? []).length >= 2, `got ${custSuggest.status}`);
    check('and they differ from the representative\'s',
        JSON.stringify(custSuggestBody?.suggestions) !==
            JSON.stringify(suggestBody?.suggestions));

    /* =====================================================================
       17. DOCUMENTS - upload, extraction, and who may read them

       The extractor itself is tested offline by scripts/try-extract.ts against
       files built byte by byte. What is checked HERE is the part that only
       exists once deployed: that a real upload is stored, read, described,
       reachable by the right people and unreachable by everybody else.
       ===================================================================== */

    /* Left-over documents from an interrupted run would make the counts below
       wrong, so they go first. Same reasoning as the appointment cleanup in
       section 13. */
    const wipeSmokeDocs = async () => {
        const alreadyThere = await (await fetch(`${base}/api/documents`, { headers: cAuth })).json();

        for (const doc of (alreadyThere?.documents ?? [])) {
            if (doc.name.startsWith('smoke-')) {
                await fetch(`${base}/api/document?id=${doc.id}`,
                    { method: 'DELETE', headers: cAuth });
            }
        }
    };

    await wipeSmokeDocs();

    const upload = (name, type, body, extra = '', auth = cAuth) => fetch(
        `${base}/api/documents?name=${encodeURIComponent(name)}` +
        `&type=${encodeURIComponent(type)}${extra}`,
        { method: 'POST', headers: { ...auth, 'Content-Type': type }, body });

    /* ---- who may reach the endpoint at all ---- */
    check('/api/documents needs a session',
        (await fetch(`${base}/api/documents`)).status === 401);
    check('AN ADMINISTRATOR IS REFUSED - a payslip is not account administration',
        (await fetch(`${base}/api/documents`, { headers: adminAuth })).status === 403);
    check('/api/documents refuses a PUT',
        (await fetch(`${base}/api/documents`, { method: 'PUT', headers: cAuth })).status === 405);

    /* ---- the empty shelf, and what it tells the page ---- */
    const shelf = await fetch(`${base}/api/documents`, { headers: cAuth });
    const shelfBody = await shelf.json().catch(() => null);

    check('GET /api/documents lists them', shelf.status === 200,
        `got ${shelf.status}: ${JSON.stringify(shelfBody)?.slice(0, 200)}`);
    check('as an array', Array.isArray(shelfBody?.documents));
    check('with the size limit, so the page can refuse a big file before sending it',
        shelfBody?.maxBytes === 4 * 1024 * 1024, String(shelfBody?.maxBytes));
    check('and the kinds it accepts',
        (shelfBody?.kinds ?? []).includes('payslip'), JSON.stringify(shelfBody?.kinds));
    check('and whether descriptions will be written by the model',
        typeof shelfBody?.aiEnabled === 'boolean', String(shelfBody?.aiEnabled));

    /* ---- a real text document, read end to end ---- */
    const payslipText =
        'MONTHLY PAYSLIP\n' +
        'Employee: Sarah Tan\n' +
        'Basic pay\tS$7,000.00\n' +
        'Annual gross salary\tS$84,000.00\n' +
        'CPF contribution\tS$1,400.00\n' +
        'Employer: Example Pte Ltd\n' +
        'Net pay\tS$5,600.00\n';

    const added = await upload('smoke-payslip.txt', 'text/plain', payslipText);
    const addedBody = await added.json().catch(() => null);
    const docId = addedBody?.document?.id;

    check('POST /api/documents accepts a file', added.status === 200,
        `got ${added.status}: ${JSON.stringify(addedBody)?.slice(0, 300)}`);
    check('and reads it', addedBody?.document?.status === 'ready',
        `${addedBody?.document?.status}: ${addedBody?.document?.error}`);
    check('THE KEYWORD RULES CLASSIFIED IT WITHOUT THE MODEL',
        addedBody?.document?.kind === 'payslip', addedBody?.document?.kind);
    check('a description was stored',
        (addedBody?.document?.summary ?? '').length > 20,
        addedBody?.document?.summary);
    check('and says whether the model or the rules wrote it',
        ['openai', 'rules'].includes(addedBody?.document?.notes?.source),
        addedBody?.document?.notes?.source);

    /* THE FIGURES ARE QUOTATIONS. Every one must be a substring of the file. */
    const figures = addedBody?.document?.notes?.figures ?? [];

    check('AMOUNTS WERE FOUND IN THE TEXT', figures.length >= 3,
        JSON.stringify(figures));
    check('EVERY AMOUNT IS A LITERAL SUBSTRING OF THE DOCUMENT',
        figures.every(f => payslipText.includes(f)), JSON.stringify(figures));
    check('including the annual salary', figures.some(f => f.includes('84,000')),
        JSON.stringify(figures));
    /* Compares the VALUE, not the shape of the string. An earlier version of this
       check tested for "one or two digits at the end", which failed on
       "S$7,000.00" - the trailing "00" of the cents. The extraction was right and
       the assertion was wrong. */
    check('and nothing under a hundred was mistaken for money',
        figures.every(f => Number(f.replace(/[^0-9.]/g, '')) >= 100),
        JSON.stringify(figures));

    /* THE BOUNDARY. The description may say what the document contains. It may
       not decide anything about anybody's cover. */
    const described = `${addedBody?.document?.summary ?? ''} ` +
        `${(addedBody?.document?.notes?.points ?? []).join(' ')}`;

    check('THE DESCRIPTION DOES NOT ADVISE',
        !/\byou (should|need to|must|ought)\b|\brecommend|\bunder-?insured\b|\btop up\b/i
            .test(described), described.slice(0, 240));
    check('AND DOES NOT JUDGE WHETHER THE COVER IS ENOUGH',
        !/\b(enough|sufficient|inadequate|too little|too much|good value)\b/i.test(described),
        described.slice(0, 240));
    check('the questions are for the customer to ask, not instructions',
        (addedBody?.document?.notes?.questions ?? []).length > 0);

    /* ---- the full record, including what was read ---- */
    const oneDoc = await fetch(`${base}/api/document?id=${docId}`, { headers: cAuth });
    const oneDocBody = await oneDoc.json().catch(() => null);

    check('GET /api/document returns the extracted text so a summary can be audited',
        oneDoc.status === 200 && (oneDocBody?.text ?? '').includes('Annual gross salary'),
        `got ${oneDoc.status}: ${String(oneDocBody?.text).slice(0, 120)}`);
    check('THE TAB BETWEEN A LABEL AND ITS VALUE SURVIVED',
        (oneDocBody?.text ?? '').includes('Annual gross salary\tS$84,000.00'),
        JSON.stringify(String(oneDocBody?.text).slice(0, 160)));
    check('the list does NOT carry the text, only the single record does',
        (await (await fetch(`${base}/api/documents`, { headers: cAuth })).json())
            ?.documents?.every(d => d.text === undefined) === true);

    /* ---- WHO MAY READ IT ---- */
    check('THE REPRESENTATIVE THIS CUSTOMER IS ASSIGNED TO CAN READ IT',
        (await fetch(`${base}/api/document?id=${docId}`, { headers: rAuth })).status === 200);
    check('and can list the shelf by person',
        (await fetch(`${base}/api/documents?person=cus-001`, { headers: rAuth })).status === 200);
    check('A REPRESENTATIVE CANNOT READ SOMEBODY ELSE\'S CUSTOMER',
        (await fetch(`${base}/api/documents?person=cus-005`, { headers: rAuth })).status === 404);
    check('an administrator cannot read one document either',
        (await fetch(`${base}/api/document?id=${docId}`, { headers: adminAuth })).status === 404);
    check('a signed-out request cannot',
        (await fetch(`${base}/api/document?id=${docId}`)).status === 401);
    check('AN UNKNOWN ID IS 404, NOT 403 - so this cannot be used to count documents',
        (await fetch(`${base}/api/document?id=999999`, { headers: cAuth })).status === 404);
    check('a nonsense id is refused',
        (await fetch(`${base}/api/document?id=abc`, { headers: cAuth })).status === 400);

    /* ---- THE BYTES, which are a separate permission from the row ----

       This is the check that would have caught mayReadAttachment refusing a
       representative: the document row was readable and the file behind it was
       not, which on screen is a download button that 404s. */
    const bytesUrl = addedBody?.document?.url;

    check('the record points at where the file can be read', typeof bytesUrl === 'string',
        String(bytesUrl));
    check('THE OWNER CAN DOWNLOAD THE FILE',
        (await fetch(`${base}${bytesUrl}`, { headers: cAuth })).status === 200);
    check('THEIR REPRESENTATIVE CAN DOWNLOAD IT TOO',
        (await fetch(`${base}${bytesUrl}`, { headers: rAuth })).status === 200);
    check('and the bytes that come back are the file that went up',
        (await (await fetch(`${base}${bytesUrl}`, { headers: cAuth })).text())
            .includes('Annual gross salary'));
    check('a signed-out request gets nothing',
        [401, 404].includes((await fetch(`${base}${bytesUrl}`)).status));

    /* ---- correcting what it is ---- */
    check('either side can correct the kind',
        (await fetch(`${base}/api/document`, {
            method: 'POST', headers: rAuth,
            body: JSON.stringify({ id: docId, act: 'kind', kind: 'statement' })
        })).status === 200);
    check('and it sticks',
        (await (await fetch(`${base}/api/document?id=${docId}`, { headers: cAuth })).json())
            ?.document?.kind === 'statement');
    check('an invented kind is refused',
        (await fetch(`${base}/api/document`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ id: docId, act: 'kind', kind: 'top-secret' })
        })).status === 400);
    check('an unknown action is refused',
        (await fetch(`${base}/api/document`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ id: docId, act: 'summarise-and-sell' })
        })).status === 400);

    /* ---- describing it again ---- */
    const redescribe = await fetch(`${base}/api/document`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ id: docId, act: 'reread' })
    });
    const redescribeBody = await redescribe.json().catch(() => null);

    check('a document with text can be described again', redescribe.status === 200,
        `got ${redescribe.status}: ${JSON.stringify(redescribeBody)?.slice(0, 240)}`);
    check('and the figures are unchanged, because they are not the model\'s to change',
        JSON.stringify(redescribeBody?.document?.notes?.figures) === JSON.stringify(figures),
        JSON.stringify(redescribeBody?.document?.notes?.figures));

    /* ---- a file with nothing to read ---- */
    const blankPng = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 7)
    ]);

    const imageDoc = await upload('smoke-photo.png', 'image/png', blankPng);
    const imageDocBody = await imageDoc.json().catch(() => null);

    check('AN IMAGE IS STILL SAVED, not rejected', imageDoc.status === 200,
        `got ${imageDoc.status}: ${JSON.stringify(imageDocBody)?.slice(0, 200)}`);
    check('and says plainly that there was no text in it',
        imageDocBody?.document?.status === 'failed' &&
        /image/i.test(imageDocBody?.document?.error ?? ''),
        `${imageDocBody?.document?.status}: ${imageDocBody?.document?.error}`);
    check('the file itself is still downloadable',
        (await fetch(`${base}${imageDocBody?.document?.url}`, { headers: rAuth })).status === 200);
    check('AND IT CANNOT BE RE-READ INTO EXISTENCE - no button that lies',
        (await fetch(`${base}/api/document`, {
            method: 'POST', headers: cAuth,
            body: JSON.stringify({ id: imageDocBody?.document?.id, act: 'reread' })
        })).status === 400);

    /* ---- a scanned PDF: the case that must not look like success ---- */
    const scan = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Length 40 /Filter /DCTDecode >>\nstream\n' +
        'x'.repeat(40) + '\nendstream\nendobj\n%%EOF', 'latin1');

    const scanDoc = await upload('smoke-scan.pdf', 'application/pdf', scan);
    const scanDocBody = await scanDoc.json().catch(() => null);

    check('A SCANNED PDF IS RECORDED AS UNREADABLE, not as an empty document',
        scanDoc.status === 200 && scanDocBody?.document?.status === 'failed',
        `got ${scanDoc.status}: ${JSON.stringify(scanDocBody?.document)?.slice(0, 200)}`);
    check('and the reason explains it is a scan, so somebody can fix it',
        /scan|photograph/i.test(scanDocBody?.document?.error ?? ''),
        scanDocBody?.document?.error);

    /* ---- a rubbish file is refused outright ---- */
    check('an unsupported file type is refused',
        (await upload('smoke-bad.bin', 'application/octet-stream',
            Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]))).status === 400);
    check('an empty upload is refused',
        (await upload('smoke-empty.txt', 'text/plain', '')).status === 400);

    /* ---- A FILE DROPPED INTO A CONVERSATION IS READ TOO ----

       This is the chat half of the feature: /api/upload with a thread id both
       attaches the file AND files it as a document, so a reply suggestion can
       refer to what the file said.
       ------------------------------------------------------------------- */
    const chatFile = 'POLICY SCHEDULE\nPolicyholder: Sarah Tan\n' +
        'Sum assured\tS$250,000.00\nPolicy number: XY-1234567\n' +
        'This certificate of insurance confirms the life assured is covered.\n';

    const chatUp = await fetch(
        `${base}/api/upload?name=smoke-schedule.txt&type=text%2Fplain&thread=${humanThreadId}`,
        { method: 'POST', headers: { ...cAuth, 'Content-Type': 'text/plain' }, body: chatFile });
    const chatUpBody = await chatUp.json().catch(() => null);

    check('POST /api/upload still returns an attachment', chatUp.status === 200 &&
        typeof chatUpBody?.attachmentId === 'number',
        `got ${chatUp.status}: ${JSON.stringify(chatUpBody)?.slice(0, 200)}`);
    check('AND THE ASSISTANT READ IT', chatUpBody?.document?.status === 'ready',
        JSON.stringify(chatUpBody?.document)?.slice(0, 240));
    check('filing it as a policy', chatUpBody?.document?.kind === 'policy',
        chatUpBody?.document?.kind);
    check('with the sum assured quoted from the file',
        (chatUpBody?.document?.notes?.figures ?? []).some(f => f.includes('250,000')),
        JSON.stringify(chatUpBody?.document?.notes?.figures));
    check('and it is linked to the conversation it arrived in',
        chatUpBody?.document?.threadId === humanThreadId,
        `${chatUpBody?.document?.threadId} vs ${humanThreadId}`);
    check('so it appears on the customer\'s shelf as well',
        ((await (await fetch(`${base}/api/documents`, { headers: cAuth })).json())
            ?.documents ?? []).some(d => d.id === chatUpBody?.document?.id));
    check('THE REPRESENTATIVE CAN READ WHAT THEIR CUSTOMER JUST SENT',
        (await fetch(`${base}/api/document?id=${chatUpBody?.document?.id}`, { headers: rAuth }))
            .status === 200);

    /* An image in a chat makes NO document - a photo is a normal thing to send
       and does not need a "could not read that" note against it. */
    const chatImage = await fetch(
        `${base}/api/upload?name=smoke-snap.png&type=image%2Fpng&thread=${humanThreadId}`,
        { method: 'POST', headers: { ...cAuth, 'Content-Type': 'image/png' }, body: blankPng });
    const chatImageBody = await chatImage.json().catch(() => null);

    check('an image in a conversation attaches without becoming a document',
        chatImage.status === 200 && chatImageBody?.document === null,
        JSON.stringify(chatImageBody?.document));

    /* A guessed thread id must not let somebody file a document against a
       conversation they are not in. The upload still succeeds - it is their own
       attachment - but no document is created. */
    const chatWrongThread = await fetch(
        `${base}/api/upload?name=smoke-sneak.txt&type=text%2Fplain&thread=999999`,
        { method: 'POST', headers: { ...cAuth, 'Content-Type': 'text/plain' }, body: chatFile });
    const chatWrongBody = await chatWrongThread.json().catch(() => null);

    check('A THREAD YOU ARE NOT IN FILES NOTHING, and does not fail the upload',
        chatWrongThread.status === 200 && chatWrongBody?.document === null,
        `got ${chatWrongThread.status}: ${JSON.stringify(chatWrongBody?.document)}`);

    /* ---- deleting ---- */
    check('A REPRESENTATIVE CANNOT DELETE THEIR CUSTOMER\'S DOCUMENT',
        (await fetch(`${base}/api/document?id=${docId}`,
            { method: 'DELETE', headers: rAuth })).status === 403);
    check('the owner can', (await fetch(`${base}/api/document?id=${docId}`,
        { method: 'DELETE', headers: cAuth })).status === 200);
    check('and it is gone',
        (await fetch(`${base}/api/document?id=${docId}`, { headers: cAuth })).status === 404);

    /* Clean up everything else this section made, so the next run starts level. */
    await wipeSmokeDocs();

    check('the shelf is back to how it started',
        ((await (await fetch(`${base}/api/documents`, { headers: cAuth })).json())
            ?.documents ?? []).every(d => !d.name.startsWith('smoke-')));

    console.log('\n' + '='.repeat(52));
    console.log(failed === 0
        ? `ALL ${passed} CHECKS PASSED`
        : `${passed} passed, ${failed} FAILED`);
    console.log('='.repeat(52) + '\n');

    process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('\nSmoke test could not run:', error);
    process.exit(1);
});
