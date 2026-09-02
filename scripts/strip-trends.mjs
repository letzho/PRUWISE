/* Throwaway: replaces the whole analyticsPanel() body with an insights-only
   version. Cut between two unique markers rather than by line number, and it
   refuses to run unless both are found exactly once. */

import { readFileSync, writeFileSync } from 'node:fs';

const path = 'js/pages-fr.js';
const source = readFileSync(path, 'utf8');

const START = 'function analyticsPanel() {';
const END = '\n/* ==========================================================================\n   CLICK HANDLERS for the FR pages';

const count = (n) => source.split(n).length - 1;

if (count(START) !== 1 || count(END) !== 1) {
    console.error(`Refusing: START ${count(START)}, END ${count(END)}`);
    process.exit(1);
}

const from = source.indexOf(START);
const to = source.indexOf(END);

if (to <= from) { console.error('Refusing: markers out of order.'); process.exit(1); }

const replacement = `function analyticsPanel() {
    var a = DATA.analytics;

    /* WHAT PRUWISE SUGGESTS YOU DO NEXT.

       Each insight is a finding plus a course of action, because a finding on its
       own is homework. "62% of your clients are short on critical illness" is an
       observation; "start with these three, and lead with the pricing argument" is
       something somebody can do this afternoon. suggestedAction() below turns the
       first into the second. */
    var cards = a.insights.map(function (insight, index) {
        return '<div class="next-card">' +

            '<div class="next-head">' +
            '<span class="next-num">' + (index + 1) + '</span>' +
            '<span class="next-title">' + FMT.esc(insight.title) + '</span>' +
            '</div>' +

            '<div class="next-body">' + FMT.esc(insight.text) + '</div>' +

            suggestedAction(insight) +
            '</div>';
    }).join('');

    return '<div class="stack-4">' +

        UI.secHead({
            title: 'What PRUWise suggests you do next',
            sub: 'Read across your whole book, with a course of action for each',
            actions: UI.aitag('PRUWise')
        }) +

        '<div class="next-list">' + cards + '</div>' +

        /* SAID ONCE, PLAINLY. These readings come from the sample book rather than
           a record of this representative's own activity, and pretending otherwise
           would make every number on the tab a small lie. */
        UI.callout({
            tone: 'info', icon: 'info',
            text: 'These readings come from the sample book in this prototype, not ' +
                'from a record of your own activity. Every suggestion is yours to ' +
                'take or ignore - PRUWise does not decide anything.'
        }) +

        '</div>';
}


/* The course of action for one insight.

   RULES, NOT THE MODEL. Each insight already names a pattern; what is added here
   is the obvious next step and a button that goes to the screen where it happens.
   Keeping it deterministic means the suggestion is the same every time somebody
   looks, which matters for something a person is meant to act on - and it works
   with no key configured.

   Nothing here recommends a PRODUCT. It recommends an ACTION: open a client, book
   a review, start a conversation. Which plan suits somebody is the
   representative's decision, made on the client's own record. */
function suggestedAction(insight) {
    var text = String(insight.title + ' ' + insight.text).toLowerCase();

    var has = function () {
        for (var i = 0; i < arguments.length; i++) {
            if (text.indexOf(arguments[i]) !== -1) { return true; }
        }
        return false;
    };

    /* Pull any client names the insight mentions, so the action can link straight
       to the person rather than to a list. */
    var named = (DATA.customers || []).filter(function (c) {
        return text.indexOf(String(c.name).toLowerCase()) !== -1
            || text.indexOf(String(c.firstName || '').toLowerCase() + ' ') !== -1;
    }).slice(0, 3);

    var action;
    var buttons = '';

    if (has('renew', 'age band', 'age-band')) {
        action = 'Contact them before the renewal date, while the current age band ' +
            'still applies. Anything agreed after it lapses is priced higher.';

    } else if (has('critical illness', 'gap', 'shortfall', 'under-insured')) {
        action = 'Open the largest gap first and check the figures against what is ' +
            'on file, then decide whether it is worth raising at their next review.';

    } else if (has('friday', 'slot', 'weekday', 'reschedule')) {
        action = 'Offer the slots that hold up best when you next ask somebody to ' +
            'pick a time - fewer reschedules is less admin for both sides.';
        buttons = UI.btn({
            label: 'Open the calendar', variant: 'soft', size: 'sm',
            icon: 'calendar', href: '#/fr/calendar'
        });

    } else if (has('accepted', 'convert', 'prepared')) {
        action = 'Prepare the needs summary before the meeting rather than during ' +
            'it. It is the preparation doing the work here, not the software.';

    } else {
        action = 'Worth a look before your next round of reviews.';
    }

    if (!buttons) {
        buttons = named.length
            ? named.map(function (c) {
                return UI.btn({
                    label: 'Open ' + (c.firstName || String(c.name).split(' ')[0]),
                    variant: 'soft', size: 'sm', icon: 'user',
                    act: 'open-customer', data: { id: c.id }
                });
            }).join('')
            : UI.btn({
                label: 'Open clients', variant: 'soft', size: 'sm',
                icon: 'users', href: '#/fr/customers'
            });
    }

    return '<div class="next-action">' +
        '<span class="next-action-label">' + UI.icon('arrowUpRight', 13) +
        '<span>Suggested next step</span></span>' +
        '<div class="t-sm">' + FMT.esc(action) + '</div>' +
        '<div class="card-actions">' + buttons + '</div>' +
        '</div>';
}

`;

const out = source.slice(0, from) + replacement + source.slice(to);

writeFileSync(path, out, 'utf8');

console.log(`removed ${source.slice(from, to).split('\n').length} lines`);
console.log(`wrote ${replacement.split('\n').length} lines`);

for (const gone of ['CHARTS.line', 'CHARTS.donut', 'recommendationStats',
    'appointmentsByDay', 'appointmentMix', 'a.segments', 'Recommendation log',
    'Client trends', 'customerTrend']) {
    const n = out.split(gone).length - 1;
    console.log(`${n === 0 ? 'ok  ' : 'LEFT'}  ${gone}: ${n}`);
}
