/* =============================================================================
   scripts/score-check.mjs  -  does the savings range actually get recommended,
                               and is the cautious saver safe from the
                               market-linked plan?
   -----------------------------------------------------------------------------
   Runs against the DEPLOYED /api/assessment, because that is the code that will
   answer a real customer. Each case posts a set of answers and asserts what came
   back.

   THE POINT OF CASE 2 is a mis-selling guard, not a feature check: somebody who
   said "I want my money to be safe" must never be handed a plan whose own
   considerations say the value can fall.

   It restores sarah.tan's original answers at the end, because posting an
   assessment OVERWRITES the stored one and she is the demo account.
   ============================================================================= */

const base = 'https://pruwise.vercel.app';

let pass = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) { pass++; console.log(`  ok   ${label}`); return; }
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  -> ${detail}`}`);
}

async function signIn(username, password) {
    const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const token = /pruwise_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    if (!token) { console.error(`login failed for ${username}: ${res.status}`); process.exit(1); }
    return { 'Content-Type': 'application/json', Cookie: `pruwise_session=${token}` };
}

const auth = await signIn('sarah.tan', 'studsarah');

async function score(answers) {
    const res = await fetch(`${base}/api/assessment`, {
        method: 'POST', headers: auth, body: JSON.stringify({ answers })
    });
    const body = await res.json().catch(() => null);

    if (res.status !== 200) {
        console.error(`assessment refused: ${res.status} ${JSON.stringify(body)?.slice(0, 300)}`);
        process.exit(1);
    }
    return {
        recs: body?.assessment?.recommended ?? [],
        profile: body?.assessment?.profile ?? null
    };
}

const ids = r => r.map(x => x.productId);

console.log('\nSavings range and mis-selling checks\n');

/* ---------------------------------------------------------- 1. a home deposit */
console.log('  -- saving for a home deposit, cautious --');
const home = await score({
    goal: 'home', age: '25to34', dependants: 'partner', budget: '150to400',
    risk: 'low', cover: 'some', concern: 'inflation'
});

check('the guaranteed savings plan is recommended for a deposit',
    ids(home.recs).includes('prd-save'), JSON.stringify(ids(home.recs)));
check('  and it leads the shortlist',
    home.recs[0]?.productId === 'prd-save', home.recs[0]?.productId);
check('  naming the date, not a death benefit',
    (home.recs.find(r => r.productId === 'prd-save')?.reasons ?? [])
        .some(w => w.includes('date you can name')));
check('NO MARKET-LINKED PLAN for somebody who asked for safety',
    !ids(home.recs).includes('prd-growth'), JSON.stringify(ids(home.recs)));
check('  the profile records them as conservative',
    home.profile?.riskLevel === 'conservative', home.profile?.riskLevel);

/* -------------------------------------- 2. THE MIS-SELLING GUARD: safe + grow */
console.log('\n  -- "grow my money" but "keep it safe" --');
const cautious = await score({
    goal: 'investment', age: '25to34', dependants: 'nobody', budget: '50to150',
    risk: 'low', cover: 'some', concern: 'inflation'
});

check('THE INVESTMENT-LINKED PLAN IS NOT OFFERED',
    !ids(cautious.recs).includes('prd-growth'), JSON.stringify(ids(cautious.recs)));
check('  a savings plan is offered instead',
    ids(cautious.recs).some(id => ['prd-save', 'prd-flexi', 'prd-legacy'].includes(id)),
    JSON.stringify(ids(cautious.recs)));
check('  and the non-guaranteed participating plan is also withheld',
    !ids(cautious.recs).includes('prd-legacy'), JSON.stringify(ids(cautious.recs)));
check('  still at least two recommendations, so the screen is not empty',
    cautious.recs.length >= 2, String(cautious.recs.length));

/* ------------------------------------- 3. the same goal with a risk appetite */
console.log('\n  -- "grow my money" and happy to take risk --');
const bold = await score({
    goal: 'investment', age: '25to34', dependants: 'nobody', budget: 'over400',
    risk: 'high', cover: 'some', concern: 'inflation'
});

check('the investment-linked plan IS offered when risk was accepted',
    ids(bold.recs).includes('prd-growth'), JSON.stringify(ids(bold.recs)));
check('  so the gate is the risk answer, not the product being removed',
    bold.profile?.riskLevel !== 'conservative', bold.profile?.riskLevel);

/* -------------------------------------------------- 4. a small monthly budget */
console.log('\n  -- a small budget --');
const small = await score({
    goal: 'investment', age: 'under25', dependants: 'nobody', budget: 'under50',
    risk: 'moderate', cover: 'some', concern: 'inflation'
});

check('the $100-a-month savings plan is recommended on a small budget',
    ids(small.recs).includes('prd-flexi'), JSON.stringify(ids(small.recs)));

/* --------------------------------------- 5. protection still works untouched */
console.log('\n  -- a family protection profile still gets protection --');
const family = await score({
    goal: 'protection', age: '35to44', dependants: 'children', budget: '150to400',
    risk: 'moderate', cover: 'employer', concern: 'illness'
});

check('term life is still recommended for a real protection gap',
    ids(family.recs).includes('prd-active'), JSON.stringify(ids(family.recs)));
check('  and the hospital plan too',
    ids(family.recs).includes('prd-shield'), JSON.stringify(ids(family.recs)));
check('  between two and four cards, as smoke asserts',
    family.recs.length >= 2 && family.recs.length <= 4, String(family.recs.length));
check('  every card names a real plan',
    family.recs.every(r => typeof r.name === 'string' && r.name.startsWith('PRU')));
check('  every card has a reason',
    family.recs.every(r => Array.isArray(r.reasons) && r.reasons.length > 0));
check('  every fit is inside the 55-97 band',
    family.recs.every(r => r.fit >= 55 && r.fit <= 97));

/* ------------------------------------------------------ 6. the savings co-pilot */
console.log('\n  -- the co-pilot hears a savings intent --');
const rep = await signIn('kristin.henessy', 'studkris');

const joined = await fetch(`${base}/api/call-join`, {
    method: 'POST', headers: rep,
    body: JSON.stringify({ withPerson: 'cus-001' })
});
const joinedBody = await joined.json().catch(() => null);
const room = joinedBody?.call?.roomCode ?? joinedBody?.roomCode;

if (!room) {
    check('a room could be opened for the co-pilot check', false,
        JSON.stringify(joinedBody)?.slice(0, 200));
} else {
    const cop = await fetch(`${base}/api/call-copilot`, {
        method: 'POST', headers: rep,
        body: JSON.stringify({
            roomCode: room,
            text: 'I just want to save up for something, it is sitting in the bank earning nothing.'
        })
    });
    const copBody = await cop.json().catch(() => null);
    const trig = copBody?.triggers ?? [];

    check('the savings intent fires a card',
        trig.some(t => t.id === 'savings-goal'), JSON.stringify(trig.map(t => t.id)));
    check('  and it offers the savings plans',
        (trig.find(t => t.id === 'savings-goal')?.products ?? [])
            .some(p => p.productId === 'prd-save'),
        JSON.stringify(trig.find(t => t.id === 'savings-goal')?.products));
    check('  and asks what the money is for rather than naming a product',
        (trig.find(t => t.id === 'savings-goal')?.ask ?? '').includes('what is the money for')
        || (trig.find(t => t.id === 'savings-goal')?.ask ?? '').includes('What is the money for'));

    /* A life event must still outrank it. */
    const both = await fetch(`${base}/api/call-copilot`, {
        method: 'POST', headers: rep,
        body: JSON.stringify({
            roomCode: room,
            text: 'My wife is pregnant and we are buying a flat.'
        })
    });
    const bothBody = await both.json().catch(() => null);

    check('a pregnancy and a mortgage still outrank the savings card',
        (bothBody?.triggers ?? []).map(t => t.id).join(',') === 'new-dependent,property',
        JSON.stringify((bothBody?.triggers ?? []).map(t => t.id)));

    await fetch(`${base}/api/call-end`, {
        method: 'POST', headers: rep, body: JSON.stringify({ roomCode: room })
    });
}

/* ============================================================================
   RESTORE THE DEMO ACCOUNT

   Posting an assessment overwrites the stored one. sarah.tan is the account the
   demo is shown from and her answers are what the representative reads, so they
   go back to what they were - the same set scripts/smoke.mjs uses.
   ============================================================================ */
await score({
    goal: 'protection', age: '35to44', dependants: 'children', budget: '150to400',
    risk: 'moderate', cover: 'employer', concern: 'illness'
});
console.log('\n  ..   sarah.tan\'s assessment restored');

console.log('\n====================================================');
if (failures.length === 0) {
    console.log(`ALL ${pass} SCORING CHECKS PASSED`);
} else {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    failures.forEach(f => console.log(`   - ${f}`));
}
console.log('====================================================\n');

process.exit(failures.length === 0 ? 0 : 1);
