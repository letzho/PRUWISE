/* =============================================================================
   scripts/chatcontext-check.mjs
   -----------------------------------------------------------------------------
   Does the call co-pilot actually read what the client TYPED, and does it keep
   that separate from what was SAID?

   The separation is the part that matters. A live card quotes the microphone and
   puts quote marks round it; if a hit from a three-week-old message came back in
   that same list, the card would claim to have heard something nobody said in the
   room. So this asserts both halves: the chat is read, AND it does not leak into
   `triggers`.
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

const post = async (auth, path, body) => {
    const res = await fetch(`${base}/api/${path}`, {
        method: 'POST', headers: auth, body: JSON.stringify(body ?? {})
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('\nCo-pilot reading the earlier conversation\n');

const rep = await signIn('kristin.henessy', 'studkris');
const customer = await signIn('sarah.tan', 'studsarah');

const stamp = Math.random().toString(36).slice(2, 10);

/* ---- the client types something that IS a life event -------------------- */
const typed = await post(customer, 'send-message', {
    withPerson: 'fr-001',
    text: 'By the way, we are expecting a baby in March - should I be changing anything?',
    clientRef: `chatctx-${stamp}`
});

check('the client can send a message naming a life event',
    typed.status === 200, `got ${typed.status}: ${JSON.stringify(typed.body)?.slice(0, 200)}`);

/* ---- a call, opened by the representative ------------------------------- */
const joined = await post(rep, 'call-join', { withPerson: 'cus-001' });
const room = joined.body?.call?.roomCode ?? joined.body?.roomCode;

check('a room opens', typeof room === 'string' && room.length > 0,
    JSON.stringify(joined.body)?.slice(0, 200));

if (!room) {
    console.log('\nNo room, so nothing else can be checked.\n');
    process.exit(1);
}

/* ---- WITHOUT includeChat: the chat must NOT be read -------------------- */
const withoutChat = await post(rep, 'call-copilot', {
    roomCode: room, text: 'The weather has been quite good this week.'
});

check('an ordinary sentence still triggers nothing live',
    (withoutChat.body?.triggers ?? []).length === 0,
    JSON.stringify(withoutChat.body?.triggers?.map(t => t.id)));
check('and the chat is NOT read unless it was asked for',
    (withoutChat.body?.fromChat ?? []).length === 0,
    JSON.stringify(withoutChat.body?.fromChat?.map(t => t.id)));

/* ---- WITH includeChat: the typed message must be found ----------------- */
const withChat = await post(rep, 'call-copilot', {
    roomCode: room,
    text: 'The weather has been quite good this week.',
    includeChat: true
});

const chatIds = (withChat.body?.fromChat ?? []).map(t => t.id);

check('THE CO-PILOT READS WHAT THEY TYPED BEFORE THE CALL',
    chatIds.includes('new-dependent'), JSON.stringify(chatIds));
check('  and it is returned SEPARATELY, never as something just heard',
    (withChat.body?.triggers ?? []).length === 0,
    JSON.stringify(withChat.body?.triggers?.map(t => t.id)));
check('  the chat hit still names real products',
    (withChat.body.fromChat.find(t => t.id === 'new-dependent')?.products ?? [])
        .every(p => typeof p.name === 'string' && p.name.startsWith('PRU')));
check('  and carries a question to ask rather than only a product',
    typeof withChat.body.fromChat.find(t => t.id === 'new-dependent')?.ask === 'string');

/* MORE THAN TWO ARE ALLOWED FROM CHAT. The live limit is two because attention
   mid-sentence is rationed; the chat arrives once, at the start. */
check('  the chat limit is more generous than the live one',
    chatIds.length >= 1 && chatIds.length <= 6, String(chatIds.length));

/* ---- the customer still cannot use the co-pilot at all ----------------- */
check('THE CUSTOMER CANNOT READ THEIR OWN CO-PILOT, chat or otherwise',
    (await post(customer, 'call-copilot',
        { roomCode: room, text: 'pregnant', includeChat: true })).status === 403);

/* ---- and not for somebody else's call ---------------------------------- */
check('a representative cannot read the chat of a call that is not theirs',
    (await post(rep, 'call-copilot',
        { roomCode: 'nosuchroom12', text: 'x', includeChat: true })).status === 403);

await post(rep, 'call-end', { roomCode: room });

console.log('\n====================================================');
if (failures.length === 0) {
    console.log(`ALL ${pass} CHAT-CONTEXT CHECKS PASSED`);
} else {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    failures.forEach(f => console.log(`   - ${f}`));
}
console.log('====================================================\n');

process.exit(failures.length === 0 ? 0 : 1);
