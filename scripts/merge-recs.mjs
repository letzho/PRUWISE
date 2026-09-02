/* Throwaway: replaces the standalone /fr/recommendations page with a redirect to
   the Recommendations tab of the client's own profile, which is where the
   shortlist now lives.

   recShortlist() and recCompare() are KEPT - the profile tab calls recCompare(),
   and recShortlist is left in place because removing it would be a second change
   in the same edit. Cut between markers, refuses to run unless both are unique. */

import { readFileSync, writeFileSync } from 'node:fs';

const path = 'js/pages-fr.js';
const source = readFileSync(path, 'utf8');

const START = `/* ==========================================================================
   POLICY RECOMMENDATIONS
   ========================================================================== */
PAGES['/fr/recommendations'] = {`;

const END = '\nfunction recShortlist(';

const count = (n) => source.split(n).length - 1;

if (count(START) !== 1 || count(END) !== 1) {
    console.error(`Refusing: START ${count(START)}, END ${count(END)}`);
    process.exit(1);
}

const from = source.indexOf(START);
const to = source.indexOf(END);

if (to <= from) { console.error('Refusing: markers out of order.'); process.exit(1); }

const replacement = `/* ==========================================================================
   /fr/recommendations  ->  the client's own Recommendations tab

   This WAS a full screen: a chip bar of every client across the top, a shortlist
   tab and a compare tab underneath. It is a redirect now.

   WHY IT WENT. A recommendation is a statement about one person, and this screen
   made you pick that person from a strip of first names and then read the
   shortlist with none of their record beside it - no coverage, no plans, no
   history to argue against. The chip bar reading "Sarah Tan | $1.4M shortfall |
   $420/mo budget" existed only to tell you which client you had accidentally
   left selected.

   THE ROUTE IS KEPT RATHER THAN DELETED. js/ai.js links here, UI.recSummaryCard
   links here, and somebody may have bookmarked it. A redirect costs four lines
   and turns every one of those into a working link; deleting the route would turn
   them all into a 404 page.
   ========================================================================== */
PAGES['/fr/recommendations'] = {
    title: 'Policy recommendations',
    sub: 'Now on the client\\u2019s own record',

    render: function () {
        return UI.loadingState('Opening the client\\u2019s recommendations\\u2026');
    },

    after: function (ctx) {
        /* ?rec=rec-cus-001-prd-active names a client in the middle of it, so an
           incoming deep link lands on the right person rather than on whoever was
           last active. */
        var fromLink = ctx.query.rec ? DATA.recById(ctx.query.rec) : null;

        var personId = (fromLink && fromLink.customerId)
            || STATE.activeCustomerId
            || (DATA.customers[0] && DATA.customers[0].id);

        if (!personId) { go('/fr/customers'); return; }

        /* replace, so the back button does not bounce through this redirect. */
        STATE.activeCustomerId = personId;
        saveState();

        go('/fr/customer/' + personId, { replace: true });

        /* The profile builds its tabs on render, so the switch has to wait for it
           to exist. One frame is enough. */
        window.setTimeout(function () { UI.switchTab('profile', 'recs'); }, 0);
    }
};


`;

const out = source.slice(0, from) + replacement + source.slice(to);

writeFileSync(path, out, 'utf8');

console.log(`removed ${source.slice(from, to).split('\n').length} lines`);

for (const gone of ['Prepared for', "act: 'pick-customer'", "UI.tabs('recs'"]) {
    const n = out.split(gone).length - 1;
    console.log(`${n === 0 ? 'ok  ' : 'LEFT'}  ${gone}: ${n}`);
}

for (const kept of ['function recShortlist(', 'function recCompare(',
    'function profileRecs(', 'function loadReleaseState(']) {
    const n = out.split(kept).length - 1;
    console.log(`${n === 1 ? 'ok  ' : 'MISS'}  ${kept}: ${n}`);
}
