/* =============================================================================
   scripts/insights-check.mjs  -  does PRUWise read a conversation correctly?
   -----------------------------------------------------------------------------
       node scripts/insights-check.mjs [https://pruwise.vercel.app]

   Drives /api/insights the way the chat and the call screen do, as BOTH sides of
   a real advisory relationship: Sarah Tan (cus-001) and Kristin Henessy (fr-001),
   her representative.

   =============================================================================
   WHAT THIS IS ACTUALLY GUARDING
   =============================================================================

   The feature writes to somebody's financial record. Four things have to be true
   or it is worse than not having it at all, and each one is a check below:

     THE RELEVANCE GATE HOLDS. A conversation about the weather produces nothing.
     Not "produces something harmless" - nothing, with no model call and no row.

     A PROPOSAL IS NEVER APPLIED ON ITS OWN. Analysing writes rows with status
     'open' and changes no record anywhere. Only a representative pressing Confirm
     writes, and only for their own client.

     EVERY PROPOSAL CARRIES THE QUOTE THAT CAUSED IT. Without the words, a
     representative cannot judge it and the only safe answer is always to dismiss.

     A CLIENT NEVER SEES THE 'support' ROWS. "May be under financial pressure" is
     a note for the human advising them, not for the person it is about.

   =============================================================================
   IT PUTS THE RECORD BACK
   =============================================================================

   Confirming a detail is a real write to a real column on a demo profile people
   look at. So the original annual income is read FIRST, as Sarah, and written
   back at the end, as Sarah - the only account allowed to write it. If the
   restore fails the script says so loudly rather than leaving the demo altered
   and passing.
   ============================================================================= */

const base = (process.argv[2] ?? 'https://pruwise.vercel.app').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
    if (ok) { passed++; console.log(`  ok   ${label}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? '  -> ' + detail : ''}`); }
}

async function signIn(username, password) {
    const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    const token = /pruwise_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

    if (!token) {
        console.error(`Could not sign in as ${username}: ${res.status}`);
        process.exit(1);
    }

    return { 'Content-Type': 'application/json', Cookie: `pruwise_session=${token}` };
}

const post = async (auth, path, body) => {
    const res = await fetch(`${base}/api/${path}`, {
        method: 'POST', headers: auth, body: JSON.stringify(body ?? {})
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

const get = async (auth, path) => {
    const res = await fetch(`${base}/api/${path}`, { headers: auth });
    return { status: res.status, body: await res.json().catch(() => null) };
};

/* A unique room code per run, so a fingerprint from a previous run cannot make
   this one look like it found nothing. The scope is part of the hash. */
const room = 'ck' + Math.random().toString(36).slice(2, 8);

const SMALL_TALK = [
    'Kristin: Morning Sarah, how are you doing today?',
    'Sarah: Not bad thanks. Terrible weather though, it has not stopped since Tuesday.',
    'Kristin: I know, I got soaked walking in. Did you watch the match at the weekend?',
    'Sarah: I caught the second half. My brother came round and we ordered food.',
    'Kristin: Sounds like a good evening. Right, shall we speak again next time.'
].join('\n');

const REAL = [
    'Kristin: Thanks for making the time Sarah. Anything changed since we last spoke?',
    'Sarah: Quite a bit actually. My salary is now ninety five thousand a year after the promotion.',
    'Kristin: Congratulations, that is a big move.',
    'Sarah: Thank you. The mortgage went up though, we are paying three thousand two hundred a month now.',
    'Sarah: Honestly it feels tight, I am a bit worried about money at the moment.',
    'Kristin: That is worth talking through properly. I will send you the figures this week.',
    'Sarah: Could we book a meeting next Tuesday to go through the cover?'
].join('\n');


async function main() {
    console.log(`\nInsights check against ${base}\n`);

    const client = await signIn('sarah.tan', 'studsarah');
    const rep = await signIn('kristin.henessy', 'studkris');
    const admin = await signIn('admin', 'studadmin');

    console.log('  ..   signed in as sarah.tan, kristin.henessy and admin\n');

    /* ---------------------------------------------------- 0. the record, before */
    const before = await get(client, 'finances');

    check('the client can read their own financial record', before.status === 200,
        `${before.status}: ${JSON.stringify(before.body)?.slice(0, 160)}`);

    console.log(`  ..   annual income found: ${before.body?.finances?.annualIncome}`);

    /* =====================================================================
       THE TEST SETS UP ITS OWN PRECONDITION, AND HAS TO

       This check spent one run failing eight assertions with "no annual_income
       finding", and the server was right every time.

       The transcript says "ninety five thousand". /api/insights deliberately
       SKIPS a proposal whose value already matches the record - "nothing changed,
       nothing to propose", because a proposal that would change nothing is
       busywork for whoever has to read it. So once a previous run had confirmed
       95,000 and then failed to restore the original, every later run found the
       record already saying 95,000 and correctly proposed nothing.

       The old version read whatever was there and restored whatever was there,
       which meant a single interrupted run poisoned every run after it. Reading a
       value you then depend on being different is not a precondition, it is a
       hope.

       So the baseline is now WRITTEN, not read. 132,000 is the seeded figure and
       differs from the 95,000 in the transcript, so the check is idempotent and
       repairs the state it needs whether or not the last run finished.
       ===================================================================== */
    const BASELINE_INCOME = 132000;

    const primed = await post(client, 'finances', { annualIncome: BASELINE_INCOME });

    check('the baseline income can be set, so this run starts from a known state',
        primed.status === 200,
        `${primed.status}: ${JSON.stringify(primed.body)?.slice(0, 160)}`);

    const originalIncome = BASELINE_INCOME;

    console.log(`  ..   annual income set to the baseline: ${originalIncome}\n`);

    /* ------------------------------------------------------ a known starting point

       Every open proposal on cus-001 is dismissed first. Not cosmetic: the
       duplicate test counts rows before and after, and rows left by an earlier run
       - or by an earlier VERSION of the rules, whose fingerprints no longer match
       what this one produces - would make the count meaningless. Dismissing writes
       nothing to anybody's record; it only marks a note decided. */
    const stale = await get(rep, 'insights?person=cus-001&status=open');

    for (const row of stale.body?.insights ?? []) {
        await post(rep, 'insights', { id: row.id, action: 'dismiss' });
    }

    console.log(`  ..   cleared ${(stale.body?.insights ?? []).length} open ` +
        `proposal(s) left from before\n`);

    /* ------------------------------------------------- 1. THE RELEVANCE GATE */
    console.log('  -- the relevance gate --');

    const chat = await post(rep, 'insights', {
        person: 'cus-001', source: 'call', roomCode: room + 'x', text: SMALL_TALK
    });

    check('small talk is accepted, not refused', chat.status === 200,
        `${chat.status}: ${JSON.stringify(chat.body)?.slice(0, 200)}`);

    check('SMALL TALK PRODUCES NOTHING AT ALL',
        Array.isArray(chat.body?.found) && chat.body.found.length === 0,
        JSON.stringify(chat.body?.found)?.slice(0, 200));

    check('  and says so, so nobody wonders whether it ran',
        chat.body?.skipped === 'nothing-relevant', String(chat.body?.skipped));

    /* ------------------------------------------------------ 2. a real conversation */
    console.log('\n  -- a conversation with something in it --');

    const read = await post(rep, 'insights', {
        person: 'cus-001', source: 'call', roomCode: room, text: REAL
    });

    check('a real conversation is analysed', read.status === 200,
        `${read.status}: ${JSON.stringify(read.body)?.slice(0, 300)}`);

    const found = read.body?.found ?? [];

    check('something was found', found.length > 0, JSON.stringify(read.body)?.slice(0, 300));

    const byKind = (kind) => found.filter((f) => f.kind === kind);
    const income = found.find((f) => f.field === 'annual_income');

    check('THE SALARY SPOKEN AS WORDS WAS UNDERSTOOD',
        !!income && Number(income.newValue) === 95000,
        income ? `newValue=${income.newValue}` : 'no annual_income finding');

    check('  and it is a proposal, not a change - status is open',
        !!income && income.status === 'open', String(income?.status));

    check('  and it shows what the record said before',
        !!income && Object.prototype.hasOwnProperty.call(income, 'oldValue'),
        JSON.stringify(income)?.slice(0, 160));

    check('the monthly commitment was picked up too',
        found.some((f) => f.field === 'monthly_expenses'),
        JSON.stringify(found.map((f) => f.field)));

    check('a SUPPORT signal was raised for the money worry',
        byKind('support').length > 0, JSON.stringify(found.map((f) => f.kind)));

    check('the promise to send figures became a follow-up',
        byKind('followup').length > 0, JSON.stringify(found.map((f) => f.kind)));

    check('the request for next Tuesday became a meeting',
        byKind('meeting').length > 0, JSON.stringify(found.map((f) => f.kind)));

    check('EVERY FINDING CARRIES THE WORDS THAT CAUSED IT',
        found.every((f) => typeof f.quote === 'string' && f.quote.length > 0),
        JSON.stringify(found.filter((f) => !f.quote))?.slice(0, 200));

    check('  and each quote is really in the transcript',
        found.every((f) => REAL.toLowerCase().includes(String(f.quote).toLowerCase())),
        JSON.stringify(found.map((f) => f.quote))?.slice(0, 300));

    check('every finding says which engine wrote the wording',
        found.every((f) => f.engine === 'rules' || f.engine === 'openai'),
        JSON.stringify(found.map((f) => f.engine)));

    check('key points were kept as the record of the discussion',
        Array.isArray(read.body?.keyPoints) && read.body.keyPoints.length > 0,
        JSON.stringify(read.body?.keyPoints)?.slice(0, 200));

    /* ------------------------------------- 3. ANALYSING TWICE DOES NOT DUPLICATE */
    console.log('\n  -- reading the same conversation again --');

    const openBefore = await get(rep, 'insights?person=cus-001&status=open');
    const countBefore = (openBefore.body?.insights ?? []).length;

    const again = await post(rep, 'insights', {
        person: 'cus-001', source: 'call', roomCode: room, text: REAL + '\nSarah: See you then.'
    });

    check('a second read succeeds', again.status === 200, String(again.status));

    const openAfter = await get(rep, 'insights?person=cus-001&status=open');
    const countAfter = (openAfter.body?.insights ?? []).length;

    check('RE-READING A GROWING TRANSCRIPT UPDATES, IT DOES NOT PILE UP',
        countAfter === countBefore, `${countBefore} before, ${countAfter} after`);

    /* --------------------------------------- 4. NOTHING WAS WRITTEN TO THE RECORD */
    console.log('\n  -- the record is untouched until somebody confirms --');

    const midway = await get(client, 'finances');

    check('ANALYSING CHANGED NO FINANCIAL FIGURE',
        (midway.body?.finances?.annualIncome ?? null) === originalIncome,
        `${originalIncome} -> ${midway.body?.finances?.annualIncome}`);

    /* ------------------------------------------------------- 5. WHO MAY SEE WHAT */
    console.log('\n  -- who may see and do what --');

    const clientSees = await get(client, 'insights');

    check('a client can read what was noticed about them', clientSees.status === 200,
        `${clientSees.status}: ${JSON.stringify(clientSees.body)?.slice(0, 160)}`);

    const clientRows = clientSees.body?.insights ?? [];

    check('A CLIENT IS NEVER SHOWN THE SUPPORT SIGNALS',
        clientRows.every((r) => r.kind !== 'support'),
        JSON.stringify(clientRows.map((r) => r.kind)));

    check('  but they do see their own detail proposals',
        clientRows.some((r) => r.kind === 'detail'),
        JSON.stringify(clientRows.map((r) => r.kind)));

    const otherClient = await post(rep, 'insights', {
        person: 'cus-005', source: 'chat', text: REAL
    });

    check('a representative cannot analyse somebody else\u2019s client',
        otherClient.status === 404, String(otherClient.status));

    const adminTry = await get(admin, 'insights?person=cus-001');

    check('an administrator is refused outright', adminTry.status === 403,
        `${adminTry.status}: ${JSON.stringify(adminTry.body)?.slice(0, 160)}`);

    const clientDecide = await post(client, 'insights', {
        id: income?.id, action: 'confirm'
    });

    check('A CLIENT CANNOT CONFIRM A CHANGE TO THEIR OWN RECORD',
        clientDecide.status === 403,
        `${clientDecide.status}: ${JSON.stringify(clientDecide.body)?.slice(0, 200)}`);

    check('  and is told why, rather than just refused',
        typeof clientDecide.body?.error === 'string' && clientDecide.body.error.length > 20,
        String(clientDecide.body?.error));

    /* --------------------------------------------------- 6. CONFIRMING, AND ONLY THEN */
    console.log('\n  -- confirming --');

    const confirm = await post(rep, 'insights', { id: income?.id, action: 'confirm' });

    check('the representative can confirm', confirm.status === 200,
        `${confirm.status}: ${JSON.stringify(confirm.body)?.slice(0, 200)}`);

    check('and is told WHICH field was written, not just "done"',
        confirm.body?.applied === 'annual_income', String(confirm.body?.applied));

    check('the proposal is marked confirmed', confirm.body?.insight?.status === 'confirmed',
        String(confirm.body?.insight?.status));

    const after = await get(client, 'finances');

    check('CONFIRMING IS WHAT WROTE THE RECORD',
        Number(after.body?.finances?.annualIncome) === 95000,
        String(after.body?.finances?.annualIncome));

    const gone = await get(rep, 'insights?person=cus-001&status=open');

    check('a confirmed proposal leaves the open list',
        !(gone.body?.insights ?? []).some((r) => r.id === income?.id),
        JSON.stringify((gone.body?.insights ?? []).map((r) => r.id)));

    /* ------------------------------------------------------------ 7. dismissing */
    console.log('\n  -- dismissing --');

    const support = (openAfter.body?.insights ?? []).find((r) => r.kind === 'support');

    if (support) {
        const dismiss = await post(rep, 'insights', { id: support.id, action: 'dismiss' });

        check('a support signal can be dismissed', dismiss.status === 200,
            `${dismiss.status}: ${JSON.stringify(dismiss.body)?.slice(0, 200)}`);

        check('  and dismissing writes nothing', dismiss.body?.applied === null,
            String(dismiss.body?.applied));

        check('  and it is marked dismissed', dismiss.body?.insight?.status === 'dismissed',
            String(dismiss.body?.insight?.status));
    } else {
        check('a support signal was there to dismiss', false, 'none found in the open list');
    }

    const nonsense = await post(rep, 'insights', { id: income?.id, action: 'incinerate' });

    check('an action that is not one of the three is refused', nonsense.status === 400,
        String(nonsense.status));

    const missing = await post(rep, 'insights', { action: 'confirm' });

    check('confirming nothing in particular is refused', missing.status === 400,
        String(missing.status));

    /* ------------------------------------------------------- 8. PUT IT BACK */
    console.log('\n  -- putting the demo record back --');

    /* Back to the BASELINE, not to "whatever was there when this started" - see the
       long note at the top. Restoring the found value is what let one bad run
       poison every run after it. */
    const restore = await post(client, 'finances', { annualIncome: originalIncome });

    check('the client can write their own record back', restore.status === 200,
        `${restore.status}: ${JSON.stringify(restore.body)?.slice(0, 200)}`);

    const final = await get(client, 'finances');

    check('THE DEMO RECORD IS BACK AT THE BASELINE',
        Number(final.body?.finances?.annualIncome) === Number(originalIncome),
        `${originalIncome} expected, ${final.body?.finances?.annualIncome} found`);

    /* ---------------------------------------------------------------- summary */
    console.log(`\n  ${passed} passed, ${failed} failed\n`);

    if (failed > 0) {
        console.log('INSIGHTS CHECK FAILED\n');
        process.exit(1);
    }

    console.log('INSIGHTS OK\n');
}

main().catch((error) => {
    console.error('\nThe check itself broke:', error);
    process.exit(1);
});
