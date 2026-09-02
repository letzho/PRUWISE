/* =============================================================================
   scripts/suggest-check.mjs
   -----------------------------------------------------------------------------
   REPORTED TWICE: "upon tapping, it will load but then it will show the same
   suggested reply I want it to show a diff set", and again as "don't use the same
   suggested stuff and we can always refresh if we don't need".

   So this asserts the thing that was actually complained about, against the
   deployed endpoint: ask, then ask again saying what is already on screen, and the
   second set must have NOTHING in common with the first.

   It also checks the guardrails still hold on the refreshed set. A second set that
   varies by inventing a premium figure would be a worse bug than the one being
   fixed.
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

const rep = await signIn('kristin.henessy', 'studkris');
const customer = await signIn('sarah.tan', 'studsarah');

/* The shared conversation. Found the way the app finds it. */
const threads = await (await fetch(`${base}/api/threads`, { headers: rep })).json();
/* threadId, NOT id. /api/threads names it threadId - see the same lookup in
   scripts/smoke.mjs - and reading `id` finds nothing while looking like the list
   was empty. */
const human = (threads.threads ?? []).find(t => t.kind === 'human' && t.threadId);

check('the representative has a conversation to suggest replies for',
    !!human, JSON.stringify((threads.threads ?? []).map(t => t.kind)));

if (!human) { process.exit(1); }

/* THE FIELD IS `previous`, AND GETTING THIS WRONG MADE THIS TEST LIE.

   The first version of this file sent `already`, which the endpoint does not read -
   see the field list in api/_routes/suggest-reply.ts and the `previous` argument in
   API.suggestReply. So every "refresh" here was byte-identical to the first
   request: no exclusion list, no raised temperature, no "do not repeat" wording.

   It passed anyway, twice, on nothing but the model happening to answer
   differently. A test that can pass while exercising none of the mechanism it
   claims to check is worse than no test, because it is quoted as evidence. */
async function suggest(auth, previous) {
    const res = await fetch(`${base}/api/suggest-reply`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ threadId: human.threadId, previous: previous ?? [] })
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

console.log('\nSuggested replies: does Refresh actually give a different set?\n');

/* ---------------------------------------------------------- the first set */
const first = await suggest(rep, []);

check('POST /api/suggest-reply answers', first.status === 200,
    `got ${first.status}: ${JSON.stringify(first.body)?.slice(0, 200)}`);

const set1 = first.body?.suggestions ?? [];

check('with two or three suggestions', set1.length >= 2 && set1.length <= 3,
    String(set1.length));
check('and says where the wording came from',
    first.body?.source === 'openai' || first.body?.source === 'rules',
    first.body?.source);
check('THE MODEL WROTE THEM, not the fallback rules',
    first.body?.source === 'openai', first.body?.source);

/* ------------------------------------------- REFRESH: the whole complaint */
const second = await suggest(rep, set1);

check('a refresh answers too', second.status === 200, `got ${second.status}`);

const set2 = second.body?.suggestions ?? [];

check('  and returns a full set again', set2.length >= 2, String(set2.length));

/* =============================================================================
   THE CONTRACT BEING ASSERTED, PRECISELY

   "Never repeat" is the wrong rule, and asserting it would be asserting a lie.
   The built-in pool is finite - six per situation - so it CAN genuinely run out,
   and round five made a deliberate decision about that case: keep the wording on
   screen and say "that is all the built-in wording I have" rather than clearing
   the strip or shuffling silently back to the first set.

   So the real rule is conditional:

     exhausted === false  ->  nothing may be repeated. This is the bug that was
                              reported twice and it must not come back.
     exhausted === true   ->  repeating is allowed, because the alternative is
                              throwing away suggestions somebody can still use,
                              and the interface says plainly that there are no
                              more.

   Asserting the unconditional version would fail at random depending on whether
   the model happened to answer, which is a test that teaches you to ignore it.
   ============================================================================= */
const opener = s => norm(s).replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(Boolean).slice(0, 6).join(' ');

function assertFresh(label, older, newer, exhausted) {
    if (exhausted) {
        console.log(`  ..   ${label} - pool exhausted, repeats allowed and declared`);
        pass++;
        return;
    }

    const repeated = newer.filter(s => older.some(a => norm(a) === norm(s)));
    check(label, repeated.length === 0, JSON.stringify(repeated));

    /* Rephrasing is the sneaky failure: sentences that are technically different
       strings but say the same thing. Caught on the opening words, which is where
       a rephrase still matches. */
    const sameOpener = newer.filter(s => older.some(a => opener(a) === opener(s)));

    check(`  ${label} - and none is the same sentence with a word changed`,
        sameOpener.length === 0, JSON.stringify(sameOpener));
}

assertFresh('NOT ONE SUGGESTION IS REPEATED AFTER A REFRESH',
    set1, set2, second.body?.exhausted === true);

/* ------------------------------------------------- a THIRD press, because
   the reported bug was specifically that it "reverts back" on a later press */
const third = await suggest(rep, set1.concat(set2));
const set3 = third.body?.suggestions ?? [];

assertFresh('a third press still does not fall back to the first set',
    set1.concat(set2), set3, third.body?.exhausted === true);

/* If the built-in wording ever does run out it must SAY so rather than looking
   broken. Either it is honest about being exhausted, or it found something new. */
check('  and either offers something new or admits the pool is empty',
    set3.length >= 2 || third.body?.exhausted === true,
    `${set3.length} suggestions, exhausted=${third.body?.exhausted}`);

/* ----------------------------------------- the guardrails on the NEW wording */
const all = set1.concat(set2, set3);

check('NO SUGGESTION QUOTES A MONETARY FIGURE, refreshed or not',
    !all.some(s => /\$\s?\d/.test(s)), JSON.stringify(all.filter(s => /\$\s?\d/.test(s))));
check('none claims something was agreed or approved',
    !all.some(s => /\b(agreed|approved|confirmed that|has been accepted)\b/i.test(s)),
    JSON.stringify(all.filter(s => /\b(agreed|approved)\b/i.test(s))));
check('every one is a sendable sentence, not a fragment',
    all.every(s => typeof s === 'string' && s.trim().length > 15));

/* ------------------------------------------------ the client's side differs */
const cust = await suggest(customer, []);
const custSet = cust.body?.suggestions ?? [];

check('a client gets suggestions too', cust.status === 200 && custSet.length >= 2,
    `got ${cust.status}, ${custSet.length}`);
check('  and they are not the representative\'s wording',
    !custSet.some(s => set1.some(a => norm(a) === norm(s))));

/* A client refresh has to work as well. It is the same button. */
const custAgain = await suggest(customer, custSet);
const custSet2 = custAgain.body?.suggestions ?? [];

assertFresh('  and the client\'s refresh also gives a different set',
    custSet, custSet2, custAgain.body?.exhausted === true);

console.log('\n====================================================');
if (failures.length === 0) {
    console.log(`ALL ${pass} SUGGESTION CHECKS PASSED`);
} else {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    failures.forEach(f => console.log(`   - ${f}`));
}
console.log('====================================================\n');

process.exit(failures.length === 0 ? 0 : 1);
