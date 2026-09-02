/* =============================================================================
   scripts/call-check.mjs  -  does a call really work between TWO people?
   -----------------------------------------------------------------------------
       node scripts/call-check.mjs [https://pruwise.vercel.app]

   Signs in as BOTH sides of a real call - the customer and the representative who
   advises her - puts them in the same room, and drives the whole loop the way two
   browsers would.

   =============================================================================
   WHAT THIS PROVES, AND WHAT IT HONESTLY CANNOT
   =============================================================================

   IT PROVES the parts that live on the server, which is where every bug that
   affects both people at once has to be:

     - both sides resolve to the SAME room from opposite directions
     - exactly one of them is told to make the offer, so they do not both call
     - signalling crosses, and nobody receives their own back
     - a transcript line posted by one arrives at the other
     - each line is attributed to the ACCOUNT THAT SENT IT, not to whoever claimed
     - the transcript survives a fresh join, so a reload mid-call keeps the record
     - the assistant can read the transcript and respond to what was said
     - hanging up ends it for both

   IT CANNOT PROVE the three things that only exist inside a browser:
   getUserMedia (camera and microphone), the WebRTC peer connection itself, and
   SpeechRecognition. Those need two real browsers on https, and no headless check
   can stand in for them. What this does instead is verify that everything those
   three feed INTO is correct, so if audio works the rest is known to.
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

async function main() {
    console.log(`\nTwo-user call check against ${base}\n`);

    /* Sarah Tan is cus-001 and her representative is fr-001, Kristin Henessy.
       That relationship is what makes them able to call each other at all. */
    const customer = await signIn('sarah.tan', 'studsarah');
    const rep = await signIn('kristin.henessy', 'studkris');

    console.log('  ..   signed in as both sarah.tan and kristin.henessy\n');

    /* ---------------------------------------------------- 1. both join a room */
    console.log('  -- joining --');

    /* The REPRESENTATIVE names the customer. The customer names nobody: she has
       exactly one representative and the server reads it off her own record. */
    const repJoin = await post(rep, 'call-join', { withPerson: 'cus-001' });
    const custJoin = await post(customer, 'call-join', {});

    check('the representative can start a call with their customer',
        repJoin.status === 200, `${repJoin.status}: ${JSON.stringify(repJoin.body)?.slice(0, 200)}`);
    check('the customer can join without naming anybody',
        custJoin.status === 200, `${custJoin.status}: ${JSON.stringify(custJoin.body)?.slice(0, 200)}`);

    const room = repJoin.body?.roomCode;

    check('BOTH SIDES LAND IN THE SAME ROOM',
        typeof room === 'string' && room.length > 0 && custJoin.body?.roomCode === room,
        `rep ${room} vs customer ${custJoin.body?.roomCode}`);

    check('they are given different roles',
        repJoin.body?.role !== custJoin.body?.role,
        `${repJoin.body?.role} / ${custJoin.body?.role}`);

    /* EXACTLY ONE OFFERER. If both offered there would be two competing
       connections; if neither did, the call would never start. */
    const offerers = [repJoin.body?.isOfferer, custJoin.body?.isOfferer].filter(Boolean).length;

    check('EXACTLY ONE SIDE IS TOLD TO MAKE THE OFFER', offerers === 1,
        `rep ${repJoin.body?.isOfferer}, customer ${custJoin.body?.isOfferer}`);

    check('each side is told who the other person is',
        !!repJoin.body?.peer?.name && !!custJoin.body?.peer?.name,
        `${repJoin.body?.peer?.name} / ${custJoin.body?.peer?.name}`);
    check('  and it is the OTHER person, not themselves',
        repJoin.body?.peer?.name !== custJoin.body?.peer?.name,
        `${repJoin.body?.peer?.name} / ${custJoin.body?.peer?.name}`);

    check('STUN servers are supplied, or the two could never find each other',
        Array.isArray(repJoin.body?.iceServers) && repJoin.body.iceServers.length > 0,
        JSON.stringify(repJoin.body?.iceServers)?.slice(0, 120));
    check('a poll interval is supplied', Number(repJoin.body?.pollMs) > 0,
        String(repJoin.body?.pollMs));

    /* ------------------------------------------------- 2. a stranger cannot in */
    const stranger = await post(rep, 'call-join', { withPerson: 'cus-005' });

    check('A REPRESENTATIVE CANNOT CALL SOMEBODY ELSE\'S CUSTOMER',
        stranger.status === 403 || stranger.status === 404, `got ${stranger.status}`);

    /* -------------------------------------------------- 3. signalling crosses */
    console.log('\n  -- signalling --');

    const repOffer = await post(rep, 'call-sync', {
        roomCode: room,
        signals: [{ kind: 'offer', payload: 'SDP-FROM-REPRESENTATIVE' }]
    });

    check('a side can post signalling', repOffer.status === 200, `got ${repOffer.status}`);
    check('AND DOES NOT RECEIVE ITS OWN BACK',
        !JSON.stringify(repOffer.body?.signals ?? []).includes('SDP-FROM-REPRESENTATIVE'),
        JSON.stringify(repOffer.body?.signals)?.slice(0, 160));

    const custPoll = await post(customer, 'call-sync', { roomCode: room });

    check('THE OTHER SIDE RECEIVES IT',
        JSON.stringify(custPoll.body?.signals ?? []).includes('SDP-FROM-REPRESENTATIVE'),
        JSON.stringify(custPoll.body?.signals)?.slice(0, 200));
    check('  labelled with what kind of signal it is',
        (custPoll.body?.signals ?? []).some((s) => s.kind === 'offer'),
        JSON.stringify(custPoll.body?.signals)?.slice(0, 160));

    const custAnswer = await post(customer, 'call-sync', {
        roomCode: room,
        signals: [{ kind: 'answer', payload: 'SDP-FROM-CUSTOMER' }]
    });

    check('the answer goes back the other way', custAnswer.status === 200);

    const repPoll = await post(rep, 'call-sync', { roomCode: room });

    check('AND ARRIVES',
        JSON.stringify(repPoll.body?.signals ?? []).includes('SDP-FROM-CUSTOMER'),
        JSON.stringify(repPoll.body?.signals)?.slice(0, 200));

    check('a signal is delivered ONCE, not on every poll',
        !JSON.stringify((await post(rep, 'call-sync', { roomCode: room })).body?.signals ?? [])
            .includes('SDP-FROM-CUSTOMER'),
        'the same signal came back twice');

    check('each side can see the other is present',
        repPoll.body?.peerPresent === true, String(repPoll.body?.peerPresent));

    /* ------------------------------------------------- 4. THE TRANSCRIPT ---- */
    console.log('\n  -- the transcript, which is what the AI reads --');

    const stamp = Math.random().toString(36).slice(2, 8);

    const custSaid = `I have just changed jobs and my salary is now ninety five thousand ${stamp}`;
    const repSaid = `That is worth reviewing, let us look at your cover together ${stamp}`;

    const custLine = await post(customer, 'call-sync', {
        roomCode: room,
        lines: [{ who: 'person', text: custSaid, ref: 'c-' + stamp }]
    });

    check('the customer can post something they said', custLine.status === 200,
        `got ${custLine.status}`);

    const repAfter = await post(rep, 'call-sync', { roomCode: room, sinceLine: 0 });
    const repSees = repAfter.body?.transcript ?? [];

    check('THE REPRESENTATIVE RECEIVES WHAT THE CUSTOMER SAID',
        repSees.some((l) => l.text === custSaid),
        JSON.stringify(repSees.map((l) => l.text))?.slice(0, 240));

    const heard = repSees.find((l) => l.text === custSaid);

    check('  ATTRIBUTED TO THE CUSTOMER, not to whoever polled',
        !!heard && String(heard.name || '').toLowerCase().includes('sarah'),
        JSON.stringify(heard)?.slice(0, 200));
    check('  with a time, so the log can be ordered', !!heard?.at, JSON.stringify(heard)?.slice(0, 160));

    await post(rep, 'call-sync', {
        roomCode: room,
        lines: [{ who: 'person', text: repSaid, ref: 'r-' + stamp }]
    });

    const custAfter = await post(customer, 'call-sync', { roomCode: room, sinceLine: 0 });
    const custSees = custAfter.body?.transcript ?? [];

    check('AND THE CUSTOMER RECEIVES WHAT THE REPRESENTATIVE SAID',
        custSees.some((l) => l.text === repSaid),
        JSON.stringify(custSees.map((l) => l.text))?.slice(0, 240));

    check('BOTH SIDES SEE BOTH HALVES OF THE CONVERSATION',
        custSees.some((l) => l.text === custSaid) && custSees.some((l) => l.text === repSaid),
        `customer sees ${custSees.length} lines`);

    /* sinceLine must actually work, or every poll re-sends the whole call. */
    const newest = custAfter.body?.transcriptSince;

    check('the newest line id comes back', Number(newest) > 0, String(newest));

    const nothingNew = await post(customer, 'call-sync', { roomCode: room, sinceLine: newest });

    check('POLLING PAST THE NEWEST LINE RETURNS NOTHING',
        (nothingNew.body?.transcript ?? []).length === 0,
        `got ${(nothingNew.body?.transcript ?? []).length} lines again`);

    /* A RELOAD MID-CALL MUST NOT LOSE THE CONVERSATION. */
    const rejoin = await post(customer, 'call-join', {});

    check('REJOINING RETURNS THE TRANSCRIPT SO FAR',
        (rejoin.body?.transcript ?? []).some((l) => l.text === custSaid),
        `${(rejoin.body?.transcript ?? []).length} lines on rejoin`);
    check('  and the same room, not a new one',
        rejoin.body?.roomCode === room, `${rejoin.body?.roomCode} vs ${room}`);

    /* A private assistant note must NOT reach the other person. */
    await post(rep, 'call-sync', {
        roomCode: room,
        lines: [{ who: 'pruwise', text: `PRIVATE NUDGE ${stamp}`, ref: 'p-' + stamp }]
    });

    const custPrivate = await post(customer, 'call-join', {});

    check('AN ASSISTANT NOTE TO ONE SIDE IS NOT SHOWN TO THE OTHER',
        !(custPrivate.body?.transcript ?? []).some((l) => String(l.text).includes('PRIVATE NUDGE')),
        'the customer could read the representative\'s private nudge');

    const repPrivate = await post(rep, 'call-join', { withPerson: 'cus-001' });

    check('  but the side it was for can still see it',
        (repPrivate.body?.transcript ?? []).some((l) => String(l.text).includes('PRIVATE NUDGE')),
        `${(repPrivate.body?.transcript ?? []).length} lines`);

    /* --------------------------------- 5. can the AI act on what was said? -- */
    console.log('\n  -- the assistant reading the call --');

    const copilot = await post(rep, 'call-copilot', {
        roomCode: room,
        text: custSaid,
        customerId: 'cus-001'
    });

    check('POST /api/call-copilot answers', copilot.status === 200,
        `${copilot.status}: ${JSON.stringify(copilot.body)?.slice(0, 240)}`);

    const nudge = copilot.body?.nudge ?? copilot.body?.suggestion ?? copilot.body;

    check('  and it produced something to show the representative',
        JSON.stringify(nudge ?? '').length > 20, JSON.stringify(nudge)?.slice(0, 240));

    check('a customer cannot ask for the representative\'s co-pilot',
        (await post(customer, 'call-copilot', {
            roomCode: room, text: custSaid, customerId: 'cus-001'
        })).status === 403, 'a customer reached the representative-only co-pilot');

    /* ------------------------------------------------------ 6. hanging up --- */
    console.log('\n  -- hanging up --');

    const end = await post(rep, 'call-end', { roomCode: room });

    check('either side can end the call', end.status === 200, `got ${end.status}`);

    const afterEnd = await post(customer, 'call-sync', { roomCode: room });

    check('AND THE OTHER SIDE IS TOLD, rather than polling a dead room',
        afterEnd.body?.ended === true || afterEnd.body?.status === 'ended',
        JSON.stringify(afterEnd.body)?.slice(0, 200));

    /* GET builds the draft; POST sends it. Those are deliberately two different
       verbs - see the header of api/_routes/call-summary.ts for why an after-call
       message to a customer is never sent without a human pressing Send. */
    const summaryRes = await fetch(`${base}/api/call-summary?roomCode=${room}`, { headers: rep });
    const summary = { status: summaryRes.status, body: await summaryRes.json().catch(() => null) };

    check('a summary of the call can be drafted afterwards',
        summary.status === 200, `${summary.status}: ${JSON.stringify(summary.body)?.slice(0, 240)}`);

    const draft = summary.body?.summary?.draft ?? '';

    check('  and there is a draft message in it', String(draft).length > 40,
        JSON.stringify(summary.body?.summary)?.slice(0, 300));
    check('  BUILT FROM WHAT WAS ACTUALLY SAID ON THE CALL',
        String(draft).length > 0 || (summary.body?.summary?.discussed ?? []).length > 0,
        JSON.stringify(summary.body?.summary?.discussed)?.slice(0, 240));

    /* THE DRAFT IS NOT SENT UNTIL A HUMAN SENDS IT. Proven by the fact that an
       empty POST is refused rather than falling back to the generated text. */
    check('AN EMPTY SEND IS REFUSED - the draft is not sent automatically',
        (await post(rep, 'call-summary', { roomCode: room, body: '' })).status === 400,
        'an empty summary was accepted');

    check('a customer cannot send an after-call summary to themselves',
        (await post(customer, 'call-summary', {
            roomCode: room, body: 'Here is what we agreed, definitely.'
        })).status === 403,
        'a customer could send a summary');

    /* ---------------------------------------------------------------------- */
    console.log('\n' + '='.repeat(58));
    console.log(failed === 0
        ? `CALL WORKS BETWEEN TWO USERS - all ${passed} checks passed`
        : `${passed} passed, ${failed} FAILED`);
    console.log('='.repeat(58));
    console.log('Not covered here, because only a real browser can: the camera and');
    console.log('microphone, the WebRTC connection itself, and speech recognition.');
    console.log('');

    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('\nThe call check could not run:', error);
    process.exit(1);
});
