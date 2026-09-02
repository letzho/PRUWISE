/* Throwaway: is build 9 live, and did this round's changes actually ship? */
const base = 'https://pruwise.vercel.app';
const grab = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, text: await res.text() };
};

const index = await grab('/');
const app = await grab('/js/app.js?v=9');
const ui = await grab('/js/ui.js?v=9');
const fr = await grab('/js/pages-fr.js?v=9');
const msgs = await grab('/js/messages.js?v=9');
const docs = await grab('/js/pages-docs.js');

const checks = [
    ['index.html asks for ?v=9', index.text.includes('?v=9')],
    ['and no longer ?v=8', !index.text.includes('?v=8')],
    ['app.js is build 9', app.text.includes('APP_BUILD = 9')],

    /* task 2 */
    ['clients, not customers, in the nav', app.text.includes("label: 'Clients'")],
    ['  the route is untouched', app.text.includes("path: '/fr/customers'")],
    ['  the role value survived the rename', app.text.includes("'customer'")],
    ['  and so did the action name', app.text.includes('open-customer')],

    /* task 3 */
    ['the documents page is gone', docs.status === 404
        || !docs.text.includes("PAGES['/me/documents']")],
    ['  no documents nav entry', !app.text.includes("path: '/me/documents'")],
    ['  files listed in the chat instead', msgs.text.includes('loadThreadFiles')],
    ['  with a save action', msgs.text.includes('download="')],

    /* task 5 */
    ['trends is insights only', fr.text.includes('What PRUWise suggests you do next')],
    ['  the client-trends graph is gone', !fr.text.includes('customerTrend')],
    ['  no charts left in the panel', !fr.text.includes('CHARTS.line')],
    ['  every insight carries a next step', fr.text.includes('function suggestedAction')],

    /* task 6 */
    ['hero stats are links', fr.text.includes('hero-stat is-link')],
    ['  the protection-gap vanity stat is gone',
        !fr.text.includes("'Total protection gap'")],

    /* task 8 */
    ['the dashboard reads the real diary', fr.text.includes('loadDashAppointments')],
    ['  from the same endpoint as the calendar',
        fr.text.includes('API.upcomingAppointments')],
    ['  and corrects the hero count from it', fr.text.includes('fr-hero-appts')],
    ['  no mock appointments on the dashboard',
        !fr.text.includes('appointments.slice(0, 3).map')],

    /* secHead */
    ['secHead can take unescaped html deliberately', ui.text.includes('o.subHtml')]
];

let bad = 0;
for (const [label, pass] of checks) {
    if (!pass) { bad++; }
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}`);
}
console.log(bad === 0 ? '\nBUILD 9 IS LIVE AND CORRECT' : `\n${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
