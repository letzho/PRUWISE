/* =============================================================================
   scripts/live-check.mjs  -  is the DEPLOYED front end the one I just wrote?
   -----------------------------------------------------------------------------
       node scripts/live-check.mjs 10

   Reads the cache-buster number from js/app.js if it is not given.

   WHY THIS EXISTS. The build can succeed, the deployment can go out, and browsers
   can still be running the previous copy - which is exactly what a cache buster is
   for and exactly the thing nobody notices. It has also caught a real deploy that
   reported success while serving the old bundle.

   ASSERT ON CODE SHAPE, NOT ON PROSE. Three times now a check has failed because
   my own explanatory COMMENT contained the very string I was asserting was gone.
   So the "removed" checks below look for the code that would use a thing, not for
   the word.
   ============================================================================= */

import { readFileSync } from 'node:fs';

const base = 'https://pruwise.vercel.app';

const build = process.argv[2]
    ?? (readFileSync('js/app.js', 'utf8').match(/APP_BUILD\s*=\s*(\d+)/)?.[1] ?? '');

if (!build) {
    console.error('Could not work out the build number.');
    process.exit(1);
}

const grab = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, text: await res.text() };
};

const [index, app, ui, fr, me, msgs] = await Promise.all([
    grab('/'),
    grab(`/js/app.js?v=${build}`),
    grab(`/js/ui.js?v=${build}`),
    grab(`/js/pages-fr.js?v=${build}`),
    grab(`/js/pages-me.js?v=${build}`),
    grab(`/js/messages.js?v=${build}`)
]);

const checks = [
    /* ---- is this even the new build ---- */
    [`index.html asks for ?v=${build}`, index.text.includes(`?v=${build}`)],
    [`app.js reports build ${build}`, app.text.includes(`APP_BUILD = ${build}`)],

    /* ---- clients, not customers ---- */
    ['the sidebar says Clients', app.text.includes("label: 'Clients'")],
    ['  the route is untouched', app.text.includes("path: '/fr/customers'")],
    ['  the role value survived', app.text.includes("'customer'")],
    ['  and the action names survived', app.text.includes('open-customer')],

    /* ---- documents folded into chat ---- */
    ['no documents nav entry', !app.text.includes("path: '/me/documents'")],
    ['files are listed in the conversation', msgs.text.includes('loadThreadFiles')],
    ['  with a save-to-disk action', msgs.text.includes('download="')],

    /* ---- recommendations on the client record ---- */
    ['the client profile has a recommendations tab', fr.text.includes('profileRecs')],
    ['  with a release control', fr.text.includes('function releaseControl')],
    ['  and reads what has been released', fr.text.includes('API.recommendations.released')],
    ['the old recommendations screen is a redirect',
        !fr.text.includes("UI.tabs('recs'")],
    ['  and the PREPARED FOR chip bar is gone',
        !fr.text.includes("act: 'pick-customer'")],
    ['go() can replace history, so the redirect is not a trap',
        app.text.includes('replaceState')],

    /* ---- trends stripped ---- */
    ['trends is insights plus an action', fr.text.includes('function suggestedAction')],
    ['  the client-trends graph is gone', !fr.text.includes('customerTrend')],
    ['  no charts left', !fr.text.includes('CHARTS.line')],

    /* ---- hero ---- */
    ['hero stats are links', fr.text.includes('hero-stat is-link')],
    ['  no protection-gap vanity stat', !fr.text.includes("'Total protection gap'")],

    /* ---- the two correlation bugs ---- */
    ['the dashboard reads the real diary', fr.text.includes('loadDashAppointments')],
    ['  and corrects its own headline', fr.text.includes('fr-hero-appts')],
    ['the client home reads real policies', me.text.includes('loadMyTotals')],
    ['  so home and plans agree on the premium',
        me.text.includes('me-hero-premium') && me.text.includes('plansMonthlyTotal')],

    /* ---- client home order and copy ---- */
    ['current plans come before recommendations',
        me.text.indexOf('plansSection + coverage + recSection') !== -1],
    ['the greeting points at the representative too',
        me.text.includes('is the one to ask')],
    ['applications-in-progress explains itself',
        me.text.includes('becomes a policy only once it is issued')],

    /* ---- secHead ---- */
    ['secHead has a deliberate unescaped variant', ui.text.includes('o.subHtml')]
];

let bad = 0;

for (const [label, pass] of checks) {
    if (!pass) { bad++; }
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}`);
}

console.log(bad === 0
    ? `\nBUILD ${build} IS LIVE AND CORRECT (${checks.length} checks)`
    : `\n${bad} of ${checks.length} FAILED`);

process.exit(bad === 0 ? 0 : 1);
