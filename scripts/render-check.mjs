/* Throwaway-ish: actually RENDERS the representative pages in Node with a stub
   jQuery, so a mistake in a render() function is caught here instead of showing
   up as UI.errorState on the deployed dashboard.

   WHY THIS IS WORTH THE STUBS. js/ is excluded from tsconfig and check-js.mjs
   only proves the files PARSE. A typo like `UI.workTile` misspelt, or a helper
   that was never exported, compiles perfectly and throws the moment the page is
   drawn - and the router catches it and shows a tidy error, so it does not even
   crash loudly. That is exactly the failure this catches.

   Run: node scripts/render-check.mjs
*/

import { readFileSync } from 'node:fs';

/* ---------------------------------------------------------------- stub jQuery

   Only what the render paths touch. Anything a render() calls that is really a
   DOM operation returns a chainable no-op; the point is the HTML string that
   comes back, not the document. */
function makeJQuery() {
    const chain = new Proxy(function () { return chain; }, {
        get(_target, prop) {
            if (prop === 'length') { return 0; }
            if (prop === 'files') { return null; }
            if (prop === Symbol.toPrimitive) { return () => ''; }
            return chain;
        },
        apply() { return chain; }
    });

    const $ = new Proxy(function () { return chain; }, {
        get(_target, prop) {
            if (prop === 'trim') { return (s) => String(s ?? '').trim(); }
            if (prop === 'ajax') { return () => chain; }
            if (prop === 'Deferred') {
                return () => ({
                    resolve() { return this; }, reject() { return this; },
                    promise() { return chain; }
                });
            }
            if (prop === 'ajaxSettings') { return { xhr: () => ({}) }; }
            if (prop === 'each') { return () => chain; }
            return chain;
        },
        apply() { return chain; }
    });

    return $;
}

/* The browser's load order, from index.html. pages-docs.js was removed when the
   Documents page was folded into the chat. */
/* pages-inperson must come after pages-fr: it calls frBook() from there. */
const scripts = ['data', 'charts', 'ui', 'ai', 'api', 'app', 'call', 'messages',
    'pages-calendar', 'pages-fr', 'pages-inperson', 'pages-me', 'pages-onboarding',
    'pages-admin', 'pages-settings'];

const source = scripts
    .map((name) => readFileSync(`js/${name}.js`, 'utf8'))
    .join('\n;\n');

const sandbox = {
    $: makeJQuery(),
    jQuery: makeJQuery(),
    window: {
        location: { hash: '#/fr/dashboard', href: '', reload() { } },
        localStorage: {
            getItem: () => null, setItem() { }, removeItem() { }
        },
        setInterval: () => 0, clearInterval() { }, setTimeout: () => 0,
        clearTimeout() { }, requestAnimationFrame() { },
        matchMedia: () => ({ matches: false, addEventListener() { } }),
        navigator: { onLine: true, userAgent: 'node' },
        addEventListener() { }, removeEventListener() { },
        SpeechRecognition: null, webkitSpeechRecognition: null,
        RTCPeerConnection: null, crypto: { getRandomValues: (a) => a }
    },
    document: {
        hidden: false, documentElement: { classList: { toggle() { }, add() { }, remove() { } }, setAttribute() { } },
        getElementById: () => null, createElement: () => ({ style: {}, classList: { add() { } } }),
        addEventListener() { }, querySelector: () => null, querySelectorAll: () => [],
        body: { classList: { add() { }, remove() { } } }
    },
    console,
    Intl,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    Symbol
};

sandbox.window.document = sandbox.document;
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;

const names = Object.keys(sandbox);
const values = names.map((n) => sandbox[n]);

let failed = 0;

/* Evaluate every script in one scope, exactly as the browser does with a series
   of plain <script> tags. */
let api;

try {
    api = new Function(...names, `${source}
        return {
            PAGES: typeof PAGES === 'undefined' ? {} : PAGES,
            STATE: typeof STATE === 'undefined' ? null : STATE,
            NAV:   typeof NAV   === 'undefined' ? null : NAV,
            DATA:  typeof DATA  === 'undefined' ? null : DATA,
            UI:    typeof UI    === 'undefined' ? null : UI,

            /* Round four pinned the whole app to Singapore time, and the checks for
               that assert on VALUES rather than on the existence of a function - a
               helper that quietly returned the browser's day would pass every other
               test in this file. */
            FMT:   typeof FMT   === 'undefined' ? null : FMT,

            /* Panel builders that UI.tabs only calls for the ACTIVE tab. Rendering
               a page therefore does NOT exercise them, so they are handed out to be
               called directly - otherwise a broken tab looks fine here and throws
               the moment somebody clicks it. */
            analyticsPanel: typeof analyticsPanel === 'undefined' ? null : analyticsPanel,
            profileRecs:    typeof profileRecs    === 'undefined' ? null : profileRecs,

            /* CALL and AI are handed out for the round-six checks at the bottom.
               Both are IIFEs assigned to a var inside this same scope, so they are
               reachable here and NOT on the sandbox's window - which is why reading
               them as globals in the checks failed with "CALL is not defined". */
            CALL: typeof CALL === 'undefined' ? null : CALL,
            AI:   typeof AI   === 'undefined' ? null : AI
        };`)(...values);

    console.log('ok    every script evaluated together');
} catch (error) {
    console.log(`FAIL  evaluating the scripts: ${error.message}`);
    process.exit(1);
}

const { PAGES, STATE, NAV, UI, DATA, FMT, CALL, AI } = api;

/* Sign in as the representative so the pages have a session to read. */
STATE.session = {
    personId: 'fr-001', role: 'fr', name: 'Kristin Henessy',
    username: 'kristin.henessy', email: 'k@example.com'
};
STATE.activeCustomerId = 'cus-001';

console.log(`ok    ${Object.keys(PAGES).length} routes registered`);

/* ---- the routes that must exist, and the one that must not ---- */
const mustExist = ['/fr/dashboard', '/fr/customers', '/fr/recommendations',
    '/fr/call', '/fr/messages', '/fr/calendar',
    '/me/dashboard', '/me/plans', '/me/messages', '/settings'];

for (const path of mustExist) {
    const there = !!PAGES[path];
    if (!there) { failed++; }
    console.log(`${there ? 'ok  ' : 'FAIL'}  route ${path} exists`);
}

for (const path of ['/fr/simulation', '/fr/analytics',
    '/fr/documents', '/me/documents']) {
    const gone = !PAGES[path];
    if (!gone) { failed++; }
    console.log(`${gone ? 'ok  ' : 'FAIL'}  route ${path} is gone`);
}

/* ---- nothing in the sidebar may point at a route that does not exist ---- */
for (const role of Object.keys(NAV)) {
    for (const group of NAV[role]) {
        for (const item of group.items) {
            const ok = !!PAGES[item.path];
            if (!ok) { failed++; }
            console.log(`${ok ? 'ok  ' : 'FAIL'}  nav ${role} "${item.label}" -> ${item.path}`);
        }
    }
}

/* ---- the new UI helpers exist ---- */
for (const name of ['miniCalendar', 'miniDayKey', 'workTile', 'tabs', 'apptCard']) {
    const there = typeof UI[name] === 'function';
    if (!there) { failed++; }
    console.log(`${there ? 'ok  ' : 'FAIL'}  UI.${name} is exported`);
}

/* ---- RENDER the pages. This is the part that catches a real mistake. ---- */
const toRender = ['/fr/dashboard', '/fr/customers', '/fr/recommendations',
    '/me/dashboard', '/me/plans', '/me/appointments', '/settings'];

/* Routes that exist only to forward somewhere else. They correctly render a short
   loading line and do their work in after(), so the "is this a real page" length
   threshold does not apply to them. */
const REDIRECTS = new Set(['/fr/recommendations']);

for (const path of toRender) {
    const page = PAGES[path];
    if (!page || typeof page.render !== 'function') { continue; }

    const floor = REDIRECTS.has(path) ? 20 : 200;

    try {
        const html = page.render({ params: {}, query: {}, path });
        const ok = typeof html === 'string' && html.length > floor;
        if (!ok) { failed++; }

        console.log(`${ok ? 'ok  ' : 'FAIL'}  ${path} renders (${String(html).length} chars)` +
            (REDIRECTS.has(path) ? ' - redirect' : ''));
    } catch (error) {
        failed++;
        console.log(`FAIL  ${path} threw: ${error.message}`);
    }
}

/* The client profile is the screen recommendations moved onto, so it has to build
   with a real id and contain the new tab. */
try {
    const profile = PAGES['/fr/customer/:id'].render({
        params: { id: 'cus-001' }, query: {}, path: '/fr/customer/cus-001'
    });

    const hasTab = profile.includes('data-tab="recs"');
    if (!hasTab) { failed++; }
    console.log(`${hasTab ? 'ok  ' : 'FAIL'}  client profile has the Recommendations tab`);

    /* The panel itself, called directly - UI.tabs only builds the active one, so
       rendering the page does not touch this. */
    const panel = api.profileRecs
        ? api.profileRecs(DATA.getCustomer('cus-001'), DATA.recsFor('cus-001'))
        : '';

    for (const [label, needle] of [
        ['a release control per option', 'rec-release'],
        ['a match percentage', 'fit-ring'],
        ['the how-it-compares block', 'How this compares'],
        ['the honest limit on comparing insurers', 'never seen their wording'],
        ['and says nothing reaches the client yet', 'Only you can see this']
    ]) {
        const there = panel.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  the Recommendations panel has ${label}`);
    }

    const stale = profile.includes("href: '#/fr/recommendations'");
    if (stale) { failed++; }
    console.log(`${stale ? 'FAIL' : 'ok  '}  client profile no longer links to the old screen`);

    /* WHAT PRUWISE NOTICED. The container has to be in the markup before after()
       can fill it - loadInsights() gives up silently when it is not there, which
       would be a feature that never appears and never complains. */
    const box = profile.includes('id="fr-insights"');
    if (!box) { failed++; }
    console.log(`${box ? 'ok  ' : 'FAIL'}  client profile has the insights container`);

    /* And the live-client branch, which is the one most likely to HAVE had a real
       conversation. Rendered with an id DATA has never heard of. */
    const live = PAGES['/fr/customer/:id'].render({
        params: { id: 'p-not-in-the-demo-set' }, query: {},
        path: '/fr/customer/p-not-in-the-demo-set'
    });

    const liveBox = live.includes('id="fr-insights"');
    if (!liveBox) { failed++; }
    console.log(`${liveBox ? 'ok  ' : 'FAIL'}  a live client profile has the insights container`);

    /* Every icon the insight cards ask for has to exist, or UI.icon silently
       substitutes a question mark and a support signal ships with the wrong
       symbol on it. */
    const iconsOk = ['edit', 'heart', 'clock', 'calendar', 'clipboard',
        'messageCircle', 'lock', 'arrowRight', 'check', 'x',
        /* round four: the post-it controls and the notification kinds */
        'chevronDown', 'chevronUp', 'trash', 'sparkles', 'dollarSign',
        'shieldCheck', 'bell', 'checkCheck', 'refresh', 'user']
        .every((name) => UI.icon(name, 14) !== UI.icon('helpCircle', 14));

    if (!iconsOk) { failed++; }
    console.log(`${iconsOk ? 'ok  ' : 'FAIL'}  every icon the cards and notes use exists`);

} catch (error) {
    failed++;
    console.log(`FAIL  the client profile threw: ${error.message}`);
}

/* ---- and every tab panel of the dashboard, since only one builds at a time -- */
try {
    const html = PAGES['/fr/dashboard'].render({ params: {}, query: {}, path: '/fr/dashboard' });

    for (const [label, needle] of [
        ['the work queue container', 'id="fr-work"'],
        ['the mini calendar', 'mini-cal'],
        ['tabs', 'data-tabset="frdash"'],
        ['no vanity stat cards', null]
    ]) {
        if (needle === null) { continue; }
        const there = html.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  dashboard has ${label}`);
    }

    for (const banned of ['Recommendations accepted', 'Average gap closed',
        'Reviews completed', 'Ready to present', 'Satisfaction']) {
        const gone = !html.includes(banned);
        if (!gone) { failed++; }
        console.log(`${gone ? 'ok  ' : 'FAIL'}  dashboard no longer shows "${banned}"`);
    }
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the dashboard: ${error.message}`);
}

/* The Trends panel is a plain function now - render it directly. */
try {
    const panel = new Function(...names, `${source}\nreturn analyticsPanel();`)(...values);
    const ok = typeof panel === 'string' && panel.length > 500;
    if (!ok) { failed++; }
    console.log(`${ok ? 'ok  ' : 'FAIL'}  the Trends panel renders (${String(panel).length} chars)`);
} catch (error) {
    failed++;
    console.log(`FAIL  the Trends panel threw: ${error.message}`);
}

/* ==========================================================================
   ROUND FOUR

   Each of these is a thing that was reported as wrong or missing, asserted on the
   SHAPE OF THE CODE rather than on prose - three checks in an earlier round failed
   because my own explanatory comment contained the string I was asserting had
   gone.
   ========================================================================== */

/* ---- the representative's dashboard hero ---- */
try {
    const html = PAGES['/fr/dashboard'].render({ params: {}, query: {}, path: '/fr/dashboard' });

    /* "Open PRUWise" and the priority row's "Ask PRUWise" were two names for one
       action. Only one PRUWise button may remain, and it is the one drawDayPriority
       adds - so the RENDERED hero must contain no PRUWise button at all. */
    const dupe = html.includes("label: 'Open PRUWise'") || html.includes('>Open PRUWise<');
    if (dupe) { failed++; }
    console.log(`${dupe ? 'FAIL' : 'ok  '}  the hero no longer has a duplicate PRUWise button`);

    const counted = html.includes('id="fr-hero-clients"');
    if (!counted) { failed++; }
    console.log(`${counted ? 'ok  ' : 'FAIL'}  dashboard has a server-corrected client count`);

    /* #fr-priority IS NOT IN THE FIRST RENDER, and that is correct - it lives
       inside the "My clients" tab and UI.tabs only builds the active panel.

       This check caught a real bug because of that: loadDashBook() used to return
       early when #fr-priority was absent, which is every first load - so the hero
       count was never corrected until somebody happened to open that tab. The fix
       was to split the two jobs. What is asserted here is therefore that the
       container is BUILT SOMEWHERE, not that it is on screen immediately. */
    const hasPriority = source.includes("'<div id=\"fr-priority\">'")
        || source.includes('id="fr-priority"');

    if (!hasPriority) { failed++; }
    console.log(`${hasPriority ? 'ok  ' : 'FAIL'}  a container for the real priority list is built`);

    const renamed = html.includes('My clients') && !html.includes('>My book<');
    if (!renamed) { failed++; }
    console.log(`${renamed ? 'ok  ' : 'FAIL'}  the tab reads "My clients", not "My book"`);
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the hero: ${error.message}`);
}

/* ---- the clients list reads the server, not the fixtures ---- */
try {
    const html = PAGES['/fr/customers'].render({ params: {}, query: {}, path: '/fr/customers' });

    const counted = html.includes('id="cust-count"');
    if (!counted) { failed++; }
    console.log(`${counted ? 'ok  ' : 'FAIL'}  the clients page counts from the server`);

    /* The sample section, the search that only searched it, and the table whose
       columns only fixtures had. */
    for (const banned of ['Worked examples', 'data-act="cust-view"']) {
        const gone = !html.includes(banned);
        if (!gone) { failed++; }
        console.log(`${gone ? 'ok  ' : 'FAIL'}  the clients page no longer has "${banned}"`);
    }
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the clients page: ${error.message}`);
}

/* ---- the topbar switcher is gone ----

   ASSERT ON CODE SHAPE, NOT PROSE. The first version of this looked for
   'data-act="ctx-switch"' anywhere in the source and failed, because the COMMENT
   explaining that the handler had been removed contains that exact string. Third
   time this file has been bitten by it.

   So it looks for the class the button was built with, in a string-concatenation
   context that only appears if the markup is really there. */
try {
    const gone = !source.includes('class="ctx-switch"');
    if (!gone) { failed++; }
    console.log(`${gone ? 'ok  ' : 'FAIL'}  the active-client switcher is gone from the topbar`);
} catch (error) {
    failed++;
    console.log(`FAIL  checking the switcher: ${error.message}`);
}

/* ---- Singapore time ---- */
for (const [label, fn] of [
    ['FMT.greeting exists', () => typeof FMT.greeting === 'function'],
    ['FMT.sgDayKey exists', () => typeof FMT.sgDayKey === 'function'],
    ['FMT.sgInstant exists', () => typeof FMT.sgInstant === 'function'],

    /* THE ONE THAT WOULD ACTUALLY CATCH A REGRESSION. 2026-03-15T20:00Z is
       already the 16th in Singapore, and the old code answered the 15th for
       anybody running west of +08:00. Asserted on the VALUE, not on the existence
       of the function, because a function that returns the browser's day would
       pass every check above. */
    ['sgDayKey rolls over at Singapore midnight, not UTC',
        () => FMT.sgDayKey('2026-03-15T20:00:00Z') === '2026-03-16'],

    ['sgDayKey is still correct before it',
        () => FMT.sgDayKey('2026-03-15T10:00:00Z') === '2026-03-15'],

    /* 3pm Singapore is 07:00 UTC. If this ever reads 15:00Z somebody has dropped
       the offset and every booked meeting is eight hours out. */
    ['sgInstant writes a +08:00 wall clock',
        () => FMT.sgInstant('2026-03-15', '15:00').toISOString() === '2026-03-15T07:00:00.000Z']
]) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }

    if (!ok) { failed++; }
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}

/* ---- the notification log page ---- */
try {
    const there = !!PAGES['/notifications'];
    if (!there) { failed++; }
    console.log(`${there ? 'ok  ' : 'FAIL'}  route /notifications exists`);

    if (there) {
        const html = PAGES['/notifications'].render({ params: {}, query: {}, path: '/notifications' });
        const built = typeof html === 'string' && html.includes('id="notif-log"');

        if (!built) { failed++; }
        console.log(`${built ? 'ok  ' : 'FAIL'}  the notification log renders its container`);
    }
} catch (error) {
    failed++;
    console.log(`FAIL  the notification log threw: ${error.message}`);
}

/* ---- edit, delete and the tombstone ---- */
try {
    const mine = UI.message({
        id: 41, role: 'me', paragraphs: ['Hello'], time: new Date().toISOString(),
        canEdit: true, editedAt: new Date().toISOString()
    }, { userName: 'Me', editable: true });

    for (const [label, needle] of [
        ['an Edit control', 'data-act="msg-edit"'],
        ['a Delete control', 'data-act="msg-delete"'],
        ['an edited marker', 'msg-edited'],
        ['the id the handlers need', 'data-msg="41"']
    ]) {
        const there = mine.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  a message of mine has ${label}`);
    }

    /* NOT offered on somebody else's message, and not in the PRUWise thread. Two
       separate reasons, so two separate checks. */
    const theirs = UI.message({
        id: 42, role: 'them', paragraphs: ['Hello'], time: new Date().toISOString(),
        canEdit: false
    }, { themName: 'Sarah', editable: true });

    const noneTheirs = !theirs.includes('data-act="msg-edit"');
    if (!noneTheirs) { failed++; }
    console.log(`${noneTheirs ? 'ok  ' : 'FAIL'}  their message offers no Edit`);

    const inAi = UI.message({
        id: 43, role: 'me', paragraphs: ['Hello'], time: new Date().toISOString(),
        canEdit: true
    }, { userName: 'Me', editable: false });

    const noneAi = !inAi.includes('data-act="msg-edit"');
    if (!noneAi) { failed++; }
    console.log(`${noneAi ? 'ok  ' : 'FAIL'}  the PRUWise thread offers no Edit`);

    const gone = UI.message({
        id: 44, role: 'them', deleted: true, paragraphs: [],
        time: new Date().toISOString()
    }, { themName: 'Sarah' });

    const tomb = gone.includes('msg-gone') && gone.includes('deleted');
    if (!tomb) { failed++; }
    console.log(`${tomb ? 'ok  ' : 'FAIL'}  a deleted message leaves a tombstone`);
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting a message: ${error.message}`);
}

/* ---- the client dashboard gained a calendar and a one-click request ----

   SIGNED IN AS THE CLIENT for this block, and that mattered. Rendered under the
   representative's session, /me/dashboard takes its new-customer branch - there is
   no sample profile for fr-001 - so it produced 4,700 characters of "take the
   assessment" and none of the panels being checked. The first version of this
   check failed for that reason and not because anything was missing.

   The session is put back afterwards, because everything below expects the
   representative. */
try {
    const wasSession = STATE.session;

    STATE.session = {
        personId: 'cus-001', role: 'customer', name: 'Sarah Tan',
        username: 'sarah.tan', email: 's@example.com', hasSampleProfile: true
    };

    const html = PAGES['/me/dashboard'].render({ params: {}, query: {}, path: '/me/dashboard' });

    for (const [label, needle] of [
        ['a month grid', 'id="me-mini-cal"'],
        ['a one-click meeting request', 'data-act="me-quick-book"'],
        ['a real notifications panel', 'id="me-notifs"']
    ]) {
        const there = html.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  the client home has ${label}`);
    }

    STATE.session = wasSession;
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the client home: ${error.message}`);
}

/* =============================================================================
   ROUND SIX: THE THINGS ADDED THIS ROUND, LOCKED DOWN

   Every one of these is a helper or a catalogue entry that compiles perfectly
   when it is wrong. UI.warnDot returning '' for the rest of time, a savings
   product quietly missing from js/data.js, a post-it losing its kind - none of
   those crash, and none of them would be noticed until somebody demonstrated the
   feature and it was not there.

   ASSERTING ON CODE SHAPE, NOT PROSE. Bitten three times before by a check
   failing because an explanatory COMMENT contained the string being searched for,
   so these look for markup and data, never for wording.
   ============================================================================= */

/* ---- the savings range ---- */
try {
    for (const id of ['prd-save', 'prd-flexi', 'prd-legacy']) {
        const product = DATA.products.filter((p) => p.id === id)[0];

        /* Every field UI.aiRecCard and the product library read. A savings entry
           missing `features` would throw inside DATA.recCompare()'s set
           difference, which is a render-time crash rather than a bad layout. */
        const whole = !!product
            && typeof product.name === 'string' && product.name.startsWith('PRU')
            && typeof product.category === 'string'
            && typeof product.icon === 'string'
            && typeof product.tagline === 'string'
            && typeof product.payout === 'string'
            && Array.isArray(product.features) && product.features.length > 0
            && Array.isArray(product.considerations) && product.considerations.length > 0
            && Array.isArray(product.bestFor) && product.bestFor.length > 0;

        if (!whole) { failed++; }
        console.log(`${whole ? 'ok  ' : 'FAIL'}  ${id} is in the catalogue and complete`);
    }

    /* The savings plans lead the list, which is what makes the range read as
       savings-first rather than protection with savings bolted on. */
    const leads = DATA.products[0].id === 'prd-save';
    if (!leads) { failed++; }
    console.log(`${leads ? 'ok  ' : 'FAIL'}    and the guaranteed savings plan leads the range`);

} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the savings range: ${error.message}`);
}

/* ---- the exclamation marker ---- */
try {
    /* Nothing wrong means NO marker. An exclamation mark that opens to say
       everything is fine trains people to ignore exclamation marks. */
    const quiet = UI.warnDot({ warnings: DATA.planWarnings(null) });

    const silent = quiet === '';
    if (!silent) { failed++; }
    console.log(`${silent ? 'ok  ' : 'FAIL'}  the warning marker is absent when there is nothing to say`);

    /* A real shortfall, in the shape financesNeeds() returns. */
    const warnings = DATA.planWarnings({
        lines: [{
            key: 'life', label: 'Life / death benefit', current: 400000,
            recommended: 1150000, monthly: false, gap: 750000,
            why: 'Eleven years of your income, plus what you owe'
        }],
        ratio: 35,
        emergency: { target: 30000, have: 12000, monthsHeld: 2.4, shortfall: 18000 },
        affordability: null
    });

    const found = warnings.count === 2 && warnings.tone === 'bad';
    if (!found) { failed++; }
    console.log(`${found ? 'ok  ' : 'FAIL'}    and finds the cover gap and the emergency fund`);

    const marker = UI.warnDot({ warnings, label: 'My plans' });

    /* A BUTTON, not a hover target: a phone has no hover and a keyboard user
       would never find it. */
    const usable = marker.includes('data-act="warn-toggle"')
        && marker.includes('aria-expanded="false"')
        && marker.includes('<button')
        && marker.includes('warn-pop');

    if (!usable) { failed++; }
    console.log(`${usable ? 'ok  ' : 'FAIL'}    and opens by click and keyboard, not only hover`);

    /* It must name the plan that answers the gap, and quote the server's own
       explanation rather than asserting a figure of its own. */
    const explains = marker.includes('PRUActive Protect')
        && marker.includes('Eleven years of your income');

    if (!explains) { failed++; }
    console.log(`${explains ? 'ok  ' : 'FAIL'}    and explains itself with the server's own wording`);

    /* NO HEADROOM, NO SUGGESTION. A marker that recommends a purchase to somebody
       whose own figures say they cannot afford one is a sales prod wearing a
       warning triangle. */
    const broke = DATA.planWarnings({
        lines: [{
            key: 'life', label: 'Life / death benefit', current: 0,
            recommended: 500000, monthly: false, gap: 500000, why: 'Income and debts'
        }],
        ratio: 0,
        emergency: null,
        affordability: { spare: -200, statedBudget: 300, overCommitted: false, noHeadroom: true }
    });

    const withheld = broke.blocked === true
        && broke.findings.every((f) => f.productId === null);

    if (!withheld) { failed++; }
    console.log(`${withheld ? 'ok  ' : 'FAIL'}    and NAMES NO PRODUCT when they have no room for a premium`);

} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the warning marker: ${error.message}`);
}

/* ---- read aloud ---- */
try {
    /* speechSynthesis does not exist in this harness, so speakBtn must return ''
       rather than offering a control that cannot work. That IS the behaviour being
       checked - nobody should be shown a Read aloud button on a browser with no
       voices. */
    const absent = UI.speakBtn('Some wording to read out.') === '';
    if (!absent) { failed++; }
    console.log(`${absent ? 'ok  ' : 'FAIL'}  read aloud is not offered where speech is unavailable`);

    const guarded = typeof UI.speech.supported === 'function'
        && UI.speech.supported() === false
        && UI.speech.say('anything') === false;

    if (!guarded) { failed++; }
    console.log(`${guarded ? 'ok  ' : 'FAIL'}    and asking it to speak returns false rather than throwing`);

} catch (error) {
    failed++;
    console.log(`FAIL  inspecting read aloud: ${error.message}`);
}

/* ---- the calendar subscription ---- */
try {
    const source = readFileSync('js/pages-calendar.js', 'utf8');

    for (const [label, needle] of [
        ['a subscribe control', 'data-act="cal-copy-feed"'],
        ['the webcal scheme, so a calendar app claims it', 'webcalUrl'],
        ['and the feed address is never printed on screen', 'window.prompt(']
    ]) {
        const there = source.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  the calendar offers ${label}`);
    }
} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the calendar subscription: ${error.message}`);
}

/* ---- the call screen's post-it kinds and covered log ---- */
try {
    const source = readFileSync('js/call.js', 'utf8');

    for (const [label, needle] of [
        ['four post-it kinds', 'postit-grip-'],
        ['a caveat on chat-sourced notes', 'postit-caveat'],
        ['ticks written to saved state', 'STATE.callCovered'],
        ['a covered-topics panel', 'call-covered'],
        ['and the chat read once per call', 'copilotReadChat']
    ]) {
        const there = source.includes(needle);
        if (!there) { failed++; }
        console.log(`${there ? 'ok  ' : 'FAIL'}  the call has ${label}`);
    }

    /* Exported, because the panel lives in a tab and UI.tabs only builds the
       active one - so the screen has to be able to ask for a repaint. */
    const exported = typeof CALL.renderCovered === 'function';
    if (!exported) { failed++; }
    console.log(`${exported ? 'ok  ' : 'FAIL'}    and CALL.renderCovered is exported for the tab switch`);

} catch (error) {
    failed++;
    console.log(`FAIL  inspecting the call screen: ${error.message}`);
}

/* ---- AI-suggested questions, both sides ---- */
try {
    const chips = UI.followups(['What am I not covered for?', 'What would this cost?']);

    const tappable = chips.includes('data-act="ask-ai"')
        && chips.includes('What am I not covered for?');

    if (!tappable) { failed++; }
    console.log(`${tappable ? 'ok  ' : 'FAIL'}  suggested questions render as tappable chips`);

    const empty = UI.followups([]) === '';
    if (!empty) { failed++; }
    console.log(`${empty ? 'ok  ' : 'FAIL'}    and an empty list draws nothing`);

    /* Both audiences must actually get some. A representative asking PRUWise and a
       client asking PRUWise are different prompts and both are supposed to end
       with somewhere to go next. */
    const forFr = AI.suggestions('fr', DATA.getCustomer('cus-001'));
    const forClient = AI.suggestions('customer', DATA.getCustomer('cus-001'));

    const bothSides = Array.isArray(forFr) && forFr.length > 0
        && Array.isArray(forClient) && forClient.length > 0
        && forFr[0] !== forClient[0];

    if (!bothSides) { failed++; }
    console.log(`${bothSides ? 'ok  ' : 'FAIL'}    and the two sides are offered different questions`);

} catch (error) {
    failed++;
    console.log(`FAIL  inspecting suggested questions: ${error.message}`);
}

console.log(failed === 0 ? '\nRENDER OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
