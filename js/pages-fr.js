/* ==========================================================================
   pages-fr.js
   --------------------------------------------------------------------------
   Every screen the Financial Representative sees:

     /fr/dashboard        overview of the book, appointments, AI insights
     /fr/customers        searchable, filterable customer list
     /fr/customer/:id     one customer's full record
     /fr/recommendations  shortlist, full detail, side-by-side comparison
     /fr/call             AI-assisted video call

   Trends used to be /fr/analytics. It is the third tab of the dashboard now.

   Each page follows the same shape:

     PAGES['/path'] = {
         title, sub,                 shown in the topbar
         render: function (ctx) {},   returns the page HTML as a string
         after:  function (ctx) {}    optional, runs once it is on the page
     }
   ========================================================================== */


/* ==========================================================================
   FR DASHBOARD
   ========================================================================== */
PAGES['/fr/dashboard'] = {
    title: 'Dashboard',
    sub: 'Your book at a glance',

    render: function () {
        var rep = DATA.getRep(STATE.session.personId);
        var customers = DATA.customersForRep(rep.id);
        var appointments = DATA.upcomingForRep(rep.id);
        var active = DATA.getCustomer(STATE.activeCustomerId) || customers[0];


        /* The local `priority` sort and the `totalGap` total that used to be here
           have gone with the things that read them: the priority list now comes
           from loadDashBook() and the book-wide gap figure was removed from the
           hero in the last round - see the note beside the stats. */

        /* SINGAPORE TIME, not the browser's. Read the note above FMT.TZ in
           js/data.js - this said "Good morning" at nine in the evening when the
           app was opened from anywhere west of here. */
        var greeting = FMT.greeting();

        /* A HERO STAT IS A LINK NOW, not a readout.

           Both of these answer a question by naming a screen - "5 clients" means
           go to Clients, "5 upcoming meetings" means go to Calendar - so they
           should take you there. They were plain <div>s, which made them look like
           trophies rather than the shortest route to the thing they describe. */
        var heroStat = function (value, label, href) {
            var inner = '<span class="hero-stat-value">' + value + '</span>' +
                '<span class="hero-stat-label">' + label + '</span>';

            return '<a class="hero-stat is-link" href="' + href + '">' + inner +
                UI.icon('arrowRight', 13) + '</a>';
        };

        /* ---------------------------------------------------------- hero */
        var hero = '<section class="hero anim-up">' +
            '<div class="hero-inner">' +
            /* The name from the SESSION, not from the mock record.

               DATA.getRep() falls back to the first fixture when it does not
               recognise an id, so a representative added since js/data.js was
               written would be greeted by somebody else's name. The session
               always knows who actually signed in. */
            '<span class="hero-eyebrow">' + greeting + ', ' +
            FMT.esc(String(STATE.session.name || rep.name).split(' ')[0]) + '</span>' +
            /* The appointment count is corrected by loadDashAppointments() once the
               real diary arrives. It starts at the sample figure rather than blank
               so the headline is never a hole, and the id is what lets the truth
               replace it a moment later. */
            /* ONE THING, AND WHAT TO DO ABOUT IT.

               The headline used to read "5 appointments and 3 reviews need you
               today" over a paragraph beginning "The biggest opportunity right now
               is Sarah Tan, with a $1.4M protection shortfall".

               Two problems with that. It was a COUNT rather than a decision - five
               appointments and three reviews is a total, and a total does not tell
               anybody what to open first. And "the biggest opportunity" is sales
               framing on a screen that is supposed to be about advising people; the
               largest shortfall is not automatically the most urgent thing, and
               somebody waiting three days for a reply usually is.

               loadDayPriority() ranks what is actually waiting and names the single
               most urgent item with a button that goes straight to it. The
               placeholder below is what shows while that request is in flight. */
            '<h1 class="hero-title" id="fr-day-title">Reading your day\u2026</h1>' +
            '<p class="hero-text" id="fr-day-text">PRUWise is checking who is ' +
            'waiting, what is booked, and which reviews have gone stale.</p>' +
            /* ONE ROW OF BUTTONS, FILLED BY drawDayPriority().

               There used to be a second, fixed row here as well: "Open PRUWise"
               and "View clients". So the hero showed FOUR buttons, two of which -
               "Open PRUWise" and the priority row's "Ask PRUWise" - went to the
               same screen with different labels. Two names for one action is
               worse than either name, because the reader stops to work out the
               difference and there isn't one.

               "View clients" is not lost: the "5 Clients" stat below is a link to
               exactly that, and it is in the sidebar. A hero should offer the one
               thing to do next, not a menu. */
            '<div id="fr-day-action"></div>' +
            '</div>' +
            /* TWO, AND BOTH GO SOMEWHERE. This started as four.

               "Satisfaction 94%" came from rep.stats in the sample data. There is
               no survey behind it and nothing in the app that could produce one, and
               a made-up score about how well somebody does their job is the worst
               kind of invented number to put on their own dashboard.

               "Total protection gap $3.7M" went for a subtler reason: it is the sum
               of every shortfall across the book, which is a SALES PIPELINE FIGURE
               dressed up as a protection metric. Nobody can act on it - you cannot
               close a book-wide gap, you talk to one person at a time - and the
               per-client shortfall is already on every client card where it means
               something. A number whose only use is looking impressive does not
               belong above the work.

               What is left is two counts, both true, both a link to the screen that
               answers them. */
            '<div class="hero-stats">' +
            /* BOTH COUNTS ARE CORRECTED FROM THE SERVER, by loadDashBook() and
               loadDashAppointments(). They start at the sample figures so the
               hero is never a hole, and the ids are what let the truth replace
               them a moment later.

               The client count used to be DATA.customersForRep().length and stop
               there - it said "5 Clients" whatever the representative's real book
               contained, on the one screen where that number is the whole point. */
            heroStat('<span id="fr-hero-clients">' + customers.length + '</span>',
                'Clients', '#/fr/customers') +
            heroStat('<span id="fr-hero-meetings">' + appointments.length + '</span>',
                'Upcoming meetings', '#/fr/calendar') +
            '</div></section>';

        /* ------------------------------------------------- left column */
        var aiInsight = UI.card({
            title: 'AI recommendation insight',
            sub: 'The highest-impact action across your book right now',
            icon: 'sparkles',
            actions: UI.aitag('Updated today')
        },
            UI.callout({
                tone: 'brand', icon: 'target',
                title: active.name + ' - ' + FMT.moneyShort(DATA.coverageGap(active)) + ' protection shortfall',
                text: active.aiSummary
            }) +
            UI.facts([
                ['Protection in place', DATA.coverageRatio(active) + '%'],
                ['Monthly budget', FMT.money(active.money.premiumBudget)],
                ['Last review', FMT.relative(active.lastReview)]
            ]) +
            '<div class="card-actions">' +
            UI.btn({ label: 'Analyse with PRUWise', icon: 'sparkles', act: 'customer-navigator', data: { id: active.id } }) +
            UI.btn({ label: 'Open profile', variant: 'outline', icon: 'user', act: 'open-customer', data: { id: active.id } }) +
            '</div>'
        );

        /* ---------------------------------------------------- appointments

           AN EMPTY CONTAINER, FILLED FROM THE DATABASE. This is the fix for a bug
           worth spelling out.

           This section used to render DATA.upcomingForRep() - fixtures out of
           js/data.js. The Calendar screen has always read the real appointments
           table through /api/appointments. So the two screens were answering the
           same question from two different sources, and they disagreed: the
           dashboard showed a meeting on the 27th and the calendar showed nothing
           on the 27th, because the meeting only ever existed in the sample data.

           Anything that looks like a real appointment must come from the same
           place the booking was written to. loadDashAppointments() does that, and
           the hero counts above are corrected from the same response so the
           headline cannot disagree with the list underneath it either. */
        var apptSection = '<div class="stack-4">' +
            UI.secHead({
                /* "Today" rather than "Upcoming", because that is now what it
                   lists - see the note in loadDashAppointments(). A heading that
                   named the tab and then showed something else was the bug. */
                title: 'Meetings today',
                subHtml: '<span id="fr-appt-sub">Checking your diary\u2026</span>',
                actions: UI.btn({ label: 'AI-assisted call', variant: 'outline', size: 'sm', icon: 'video', href: '#/fr/call' })
            }) +
            '<div id="fr-appts">' + UI.loadingState('Reading your appointments\u2026') + '</div>' +
            '</div>';

        /* WHO NEEDS ATTENTION, FROM THE REAL BOOK.

           This used to map DATA.customersForRep() - fixtures - so it listed
           sample people with sample shortfalls next to a hero counting the same
           fixtures. Same bug as the appointments one: a screen answering a
           question from a different source than the screen it links to.

           Empty container, filled by loadDashBook() from the SAME response that
           corrects the client count in the hero. */
        var prioritySection = '<div class="stack-4">' +
            UI.secHead({
                title: 'Who needs attention first',
                sub: 'Biggest protection shortfall at the top',
                actions: UI.btn({ label: 'See all', variant: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#/fr/customers' })
            }) +
            '<div id="fr-priority">' + UI.loadingState('Reading your book\u2026') + '</div>' +
            '</div>';

        /* ------------------------------------------------ right column

           "Ready to present" has gone from here. It showed one recommendation for
           whichever customer happened to be active, which is not a dashboard's
           job - the recommendations screen does it properly, with the comparison
           and the reasoning next to it. A month calendar takes its place, because
           "what does my week look like" is a question a dashboard should answer
           and this one could not. */
        var calendarCard = UI.card({
            title: 'This month',
            sub: 'Dots mark days with appointments',
            icon: 'calendar',
            actions: UI.btn({
                label: 'Open calendar', variant: 'ghost', size: 'xs',
                iconRight: 'arrowRight', href: '#/fr/calendar'
            })
        },
            /* An empty grid first, filled by after() once the real appointments
               arrive. Drawing it from the mock fixtures and then replacing it
               would flash the wrong dots. */
            '<div id="fr-mini-cal">' + UI.miniCalendar({
                month: new Date(), marks: {}, dayHref: '#/fr/calendar'
            }) + '</div>'
        );

        var gapCard = UI.card({ title: 'Where the gaps are', sub: 'Share of clients below the guideline', icon: 'pieChart' },
            CHARTS.hbars(DATA.analytics.gapBreakdown, { format: function (v) { return v + '%'; } })
        );

        var activityCard = UI.card({ title: 'Recent activity', sub: 'Last 5 days', icon: 'activity' },
            UI.timeline(DATA.activity.slice(0, 5), { link: true })
        );

        var insightCard = UI.card({ title: 'AI insights', sub: 'Patterns across your clients', icon: 'sparkles' },
            '<div class="stack-4">' +
            DATA.analytics.insights.slice(0, 2).map(function (i) { return UI.insight(i); }).join('') +
            '</div>' +
            /* Switches to the Trends tab rather than navigating - this card is on
               the same screen as that tab now. */
            UI.btn({
                label: 'See the trends', variant: 'soft', size: 'sm', block: true,
                iconRight: 'arrowRight', act: 'tab',
                data: { set: 'frdash', tab: 'trends' }
            })
        );

        /* CONSULTATION REQUESTS GO FIRST, ABOVE EVERYTHING.

           Somebody has chosen this representative and is waiting on an answer,
           which outranks every insight on the page. It is also the only thing
           here that another person is blocked on.

           An empty container, filled by after() - it needs the server. Nothing
           is drawn at all when there is nothing pending, so the dashboard does
           not carry a permanent "no requests" panel. */
        /* ==================================================================
           THE PAGE, IN TABS

           WHY TABS. This screen had eight stacked sections and the complaint was
           that finding anything meant scrolling past all of it. Tabs are the fix
           that does not delete anything: one panel is on screen, the other two are
           one click away, and UI.tabs only builds the active one so the charts in
           Trends cost nothing until somebody asks for them.

           WHAT STAYS ABOVE THE TABS is only what is genuinely urgent - the
           greeting, the work queue, and anything another person is blocked on.
           Everything that is browsing rather than doing went inside.
           ================================================================== */
        var panels = UI.tabs('frdash', [
            {
                id: 'today', label: 'Today', icon: 'calendar',
                render: function () {
                    return '<div class="split split-rail">' +
                        '<div class="stack">' + apptSection + '</div>' +
                        '<div class="stack">' + calendarCard + activityCard + '</div>' +
                        '</div>';
                }
            },
            {
                /* "MY BOOK" WAS INDUSTRY SHORTHAND. Everybody in insurance knows a
                   book is the set of clients you look after; nobody outside it
                   does, and a tab label is not the place to teach vocabulary. The
                   tab holds clients, so it says clients.

                   The priority list is FIRST inside it, in the wide column, which
                   is what the tab is for - the analysis beside it is context. */
                id: 'book', label: 'My clients', icon: 'users',
                render: function () {
                    return '<div class="split split-rail">' +
                        '<div class="stack">' + prioritySection + '</div>' +
                        '<div class="stack">' + aiInsight + gapCard + insightCard + '</div>' +
                        '</div>';
                }
            },
            {
                /* ANALYTICS USED TO BE ITS OWN PAGE IN THE SIDEBAR.

                   It is here instead, because nothing on it was an action - it was
                   all context for the book you are already looking at, and a
                   separate nav entry made it feel like a place you had to go and
                   check. analyticsPanel() is the same content, unchanged. */
                id: 'trends', label: 'What to do next', icon: 'sparkles',
                render: analyticsPanel
            }
        ]);

        return hero +
            '<div id="fr-work"></div>' +
            '<div id="fr-requests"></div>' +
            '<div id="fr-policy-queue"></div>' +
            panels +
            '<a class="ai-fab phone-only" href="#/fr/pruwise" aria-label="Ask PRUWise">' +
            UI.icon('sparkles', 18) + '<span>Ask AI</span></a>';
    },

    after: function () {
        loadConsultRequests();
        loadPolicyQueue();
        loadWorkQueue();
        loadDashCalendar();
        loadDashAppointments();
        loadDashBook();
        loadDayPriority();
    }
};


/* ==========================================================================
   THE REAL BOOK, ON THE DASHBOARD

   Corrects the client count in the hero AND fills the priority list, from ONE
   response. That is the point: a headline reading "5 Clients" above a list of
   three sample people is worse than either on its own, because it makes the
   reader distrust both.

   frBook() caches, so the Clients screen and this share a single request.
   ========================================================================== */

function loadDashBook() {
    /* ==================================================================
       GUARDED ON THE HERO, NOT ON THE LIST, AND THAT WAS A REAL BUG

       This used to return early unless #fr-priority was on the page. It never is
       on a first load: the priority list lives inside the "My clients" tab and
       UI.tabs only builds the ACTIVE panel, which is Today. So the whole function
       bailed out and the hero went on showing the fixture count - the exact
       problem it was written to fix - until somebody happened to open that tab.

       scripts/render-check.mjs caught it, by asserting the container was in the
       rendered HTML and finding it was not.

       So the count is corrected whenever the hero exists, and the list is filled
       only if it happens to be on screen. drawDashPriority() then runs again when
       the tab is opened, because by then the container exists and frBook() has the
       answer cached - no second request.
       ================================================================== */
    if (!$('#fr-hero-clients').length) { return; }

    frBook(function (rows) {
        $('#fr-hero-clients').text(String(rows.length));
        paintNavClientCount(rows.length);
        drawDashPriority(rows);
    });
}

/* The sidebar badge, from the same cached list. Hidden until it is known, because
   the number that used to sit there was the hard-coded string '6'. */
function paintNavClientCount(n) {
    $('#nav-client-count').text(String(n)).prop('hidden', false);
}

/* The three clients most worth opening. Separate from the fetch so it can be
   called again when the tab that holds it is finally built. */
function drawDashPriority(rows) {
    var $box = $('#fr-priority');
    if (!$box.length) { return; }

    if (!rows.length) {
        $box.html(UI.emptyState({
            icon: 'users',
            title: 'No clients yet',
            text: 'Somebody becomes your client when they choose you and you accept ' +
                'their request. Any pending requests are above.'
        }));
        return;
    }

    /* THE TOP THREE, and the server has already sorted them - biggest shortfall
       first, nobody-has-told-us-anything last. Re-sorting here would be a second
       opinion about the same question. */
    $box.html('<div class="cust-grid stagger">' +
        rows.slice(0, 3).map(clientCard).join('') + '</div>');

    UI.animateBars();
}


/* ==========================================================================
   THE MOST IMPORTANT THING TO DO TODAY

   The main display on the dashboard. One item, why it matters, and a button that
   opens it.

   ==========================================================================
   THE RANKING IS RULES. THE MODEL ONLY REWORDS IT.
   ==========================================================================

   WHICH item is most urgent is decided by rank() below - a fixed order over
   things that are actually waiting. That is deliberate and it is not a shortcut:

     - it is the same answer every time somebody looks, which matters for
       something a person is meant to act on first thing in the morning
     - it works with no key configured
     - and it cannot invent an item. A model asked "what is most urgent" over a
       summary would occasionally name a client who is not waiting on anything,
       which on this screen is worse than a dull sentence.

   The model is then asked to say the SAME finding in a warmer sentence, and if it
   is unavailable, slow, or returns something that does not mention the person it
   was given, the rules wording stays. The button and the ranking never come from
   the model at all.
   ========================================================================== */

function loadDayPriority() {
    if (!$('#fr-day-title').length) { return; }

    var rep = DATA.getRep(STATE.session.personId);
    var mine = DATA.customersForRep(rep ? rep.id : STATE.session.personId) || [];

    /* Everything that could be the answer, gathered in parallel. Each one is
       allowed to fail without stopping the others - a missing signal just cannot
       win the ranking. */
    var facts = {
        waiting: [],      // clients with unread messages
        soon: null,       // the next appointment today
        requests: 0,      // people asking to be taken on
        applications: 0,  // policy applications awaiting a decision
        overdue: []       // reviews past six months
    };

    facts.overdue = mine.filter(function (c) {
        var last = FMT.toDate(c.lastReview);
        return !last || (Date.now() - last.getTime()) > 182 * 24 * 60 * 60 * 1000;
    });

    var pending = 4;

    var done = function () {
        pending--;
        if (pending === 0) { drawDayPriority(facts, mine); }
    };

    API.threads().then(function (data) {
        facts.waiting = (data.threads || []).filter(function (t) {
            return t.kind === 'human' && Number(t.unread || 0) > 0;
        });
    }, function () { }).always(done);

    API.upcomingAppointments(10).then(function (data) {
        /* "Today" is the Singapore day. It used to be the browser's, which meant
           an evening meeting was reported as tomorrow's problem. */
        var today = FMT.sgDayKey(new Date());

        var todays = (data.appointments || []).filter(function (a) {
            return FMT.sgDayKey(a.start) === today && a.status !== 'cancelled';
        }).sort(function (a, b) {
            return FMT.toDate(a.start) - FMT.toDate(b.start);
        }).map(function (a) {
            // Map withName to customerName for consistency
            a.customerName = a.withName || a.customerName;
            return a;
        });

        facts.soon = todays[0] || null;
    }, function () { }).always(done);

    API.consultations().then(function (data) {
        facts.requests = (data.requests || []).filter(function (r) {
            return r.status === 'pending';
        }).length;
    }, function () { }).always(done);

    API.policyQueue().then(function (data) {
        facts.applications = (data.applications || []).filter(function (a) {
            return a.status === 'submitted' || a.status === 'under_review';
        }).length;
    }, function () { }).always(done);
}


/* The fixed order of urgency, most urgent first.

   The principle: ANOTHER PERSON BEING BLOCKED BEATS ANYTHING INTERNAL. A meeting
   starting in an hour beats a review that has been stale for seven months,
   because one has a deadline today and the other does not. Housekeeping is last. */
function rank(facts) {
    if (facts.soon) {
        var start = FMT.toDate(facts.soon.start);
        var mins = Math.round((start - Date.now()) / 60000);

        if (mins > -30 && mins < 120) {
            var customerName = facts.soon.customerName || 'a client';
            return {
                icon: 'video',
                title: mins <= 0
                    ? 'Your meeting with ' + customerName + ' is now'
                    : customerName + ' in ' + mins + ' minutes',
                text: 'Open the call screen a moment early so the camera and captions ' +
                    'are ready before they arrive.',
                label: 'Go to the call',
                href: '#/fr/call'
            };
        }
    }

    if (facts.requests > 0) {
        return {
            icon: 'userCheck',
            title: facts.requests === 1
                ? 'Somebody has asked you to advise them'
                : facts.requests + ' people have asked you to advise them',
            text: 'They completed an assessment and chose you. Nothing else on this ' +
                'screen has somebody waiting on a yes or no.',
            label: 'Read the requests',
            act: 'scroll-requests'
        };
    }

    if (facts.waiting.length) {
        var names = facts.waiting.map(function (t) {
            return String(t.name || '').split(' ')[0];
        }).filter(Boolean);

        return {
            icon: 'messageCircle',
            title: facts.waiting.length === 1
                ? (names[0] || 'A client') + ' is waiting on a reply'
                : facts.waiting.length + ' clients are waiting on a reply',
            text: names.length > 1
                ? names.slice(0, 3).join(', ') +
                  (names.length > 3 ? ' and others' : '') + '. Replying is the ' +
                  'shortest thing on this list and the only one somebody is sitting on.'
                : 'Replying is the shortest thing on this list, and the only one ' +
                  'somebody is sitting on.',
            label: 'Open messages',
            href: '#/fr/messages'
        };
    }

    if (facts.applications > 0) {
        return {
            icon: 'fileText',
            title: facts.applications === 1
                ? 'One application is waiting to be decided'
                : facts.applications + ' applications are waiting to be decided',
            text: 'No cover starts until you issue it, and the person who applied ' +
                'cannot tell the difference between being reviewed and being forgotten.',
            label: 'Review them',
            act: 'scroll-policy-queue'
        };
    }

    if (facts.soon) {
        var customerName = facts.soon.customerName || 'a client';
        var firstName = customerName.split(' ')[0];
        
        return {
            icon: 'calendar',
            title: 'A meeting later today with ' + customerName,
            text: 'At ' + FMT.time(facts.soon.start) + '. Worth a look at ' +
                firstName + '\'s record beforehand so nothing is a surprise.',
            label: 'Open the calendar',
            href: '#/fr/calendar'
        };
    }

    if (facts.overdue.length) {
        var first = facts.overdue[0];

        return {
            icon: 'clock',
            title: facts.overdue.length === 1
                ? first.firstName + ' has not had a review in over six months'
                : facts.overdue.length + ' reviews are more than six months old',
            /* NOT "a quiet morning". This line is read at every hour of the day and
               the hero already says which part of it. */
            text: 'Nothing is urgent. This is the useful thing to pick up next - ' +
                first.firstName + ' is the one to start with.',
            label: 'Open ' + first.firstName,
            act: 'open-customer',
            data: { id: first.id }
        };
    }

    return {
        icon: 'checkCircle',
        title: 'Nothing is waiting on you',
        text: 'No unanswered messages, no pending requests, no meetings in the next ' +
            'couple of hours and every review is current.',
        label: 'Look through your clients',
        href: '#/fr/customers'
    };
}


function drawDayPriority(facts, mine) {
    var top = rank(facts);

    $('#fr-day-title').text(top.title);
    $('#fr-day-text').text(top.text);

    $('#fr-day-action').html('<div class="card-actions">' +
        UI.btn({
            label: top.label, variant: 'white', icon: top.icon,
            href: top.href, act: top.act, data: top.data
        }) +
        UI.btn({
            label: 'Ask PRUWise', variant: 'glass', icon: 'sparkles', href: '#/fr/pruwise'
        }) +
        '</div>');

    /* ---- and now, optionally, the same thing said better ----

       The model is given the finding that already exists and asked to reword it.
       It is never asked what the priority IS.

       The guard on the way back matters: if the reply does not mention the same
       subject the rules named, it has drifted onto something else and is thrown
       away. A warmer sentence about the wrong client is worse than a flat sentence
       about the right one.

       No "is a model configured" check here - AI.reword() returns immediately when
       there is none, so every caller does not have to ask. */
    var subject = (facts.waiting[0] && facts.waiting[0].name)
        || (facts.soon && facts.soon.customerName)
        || (facts.overdue[0] && facts.overdue[0].name)
        || '';

    AI.reword({
        /* "WARMER AND MORE DIRECT" WAS THE WHOLE PROBLEM.

           That instruction, on a finding about stale reviews, produced:

               "Four reviews are over six months old; a great opportunity to start
                with Sarah this morning."

           Two things wrong with it, and the prompt invited both. "A great
           opportunity" is sales language about a person who has not asked for
           anything - this screen is for advising people, and an overdue review is
           a duty, not a lead. And "this morning" is a time of day the model has no
           way of knowing; the greeting above already says it.

           So the instruction is now plain, not warm, with the two failures named
           explicitly rather than left to be inferred. */
        system: 'You are writing the single line at the top of a financial ' +
            'representative\'s dashboard in Singapore. Rewrite the finding you are ' +
            'given as ONE plain sentence under 18 words, saying what needs doing ' +
            'and who it concerns.\n' +
            'Never call anything an opportunity, a lead, a chance, or potential. ' +
            'This is a duty of care, not a sales prompt.\n' +
            'Never mention a time of day, a day of the week, or a date.\n' +
            'Do not add facts. Do not mention a product or a figure you were not ' +
            'given. Do not greet anybody. No quotation marks.',
        user: 'Finding: ' + top.title + '. Detail: ' + top.text,

        onText: function (text) {
            var clean = String(text || '').replace(/^["']|["']$/g, '').trim();

            if (clean.length < 8 || clean.length > 160) { return; }

            /* AND THE SAME TWO FAILURES CHECKED ON THE WAY BACK, because a prompt
               is a request and a guard is a rule. The rules wording is already on
               screen and is correct, so discarding a bad rewrite costs nothing. */
            if (/\b(opportunit\w*|lead|leads|prospect\w*|chance|potential|upsell|pitch)\b/i.test(clean)) {
                return;
            }
            if (/\b(morning|afternoon|evening|tonight|today|tomorrow)\b/i.test(clean)) {
                return;
            }

            /* Drifted onto a different person? Keep the rules wording. */
            if (subject) {
                var first = subject.split(' ')[0];
                if (top.title.indexOf(first) !== -1 && clean.indexOf(first) === -1) {
                    return;
                }
            }

            $('#fr-day-title').text(clean);
        }
    });
}


/* ==========================================================================
   THE REAL DIARY, ON THE DASHBOARD

   Reads /api/appointments - the same endpoint the Calendar screen uses, which is
   the whole point. Before this, the dashboard listed fixtures from js/data.js and
   the calendar listed rows from the database, so the two screens contradicted each
   other about whether a meeting existed.

   THE COUNTS IN THE HERO ARE CORRECTED FROM THIS SAME RESPONSE. A headline saying
   "5 appointments need you today" above a list showing two is worse than either
   number on its own, because it makes the reader distrust both.
   ========================================================================== */

function loadDashAppointments() {
    if (!$('#fr-appts').length) { return; }

    API.upcomingAppointments(10).then(

        function (data) {
            var live = (data.appointments || []).filter(function (a) {
                return a.status !== 'cancelled';
            });

            /* ==============================================================
               THE TODAY TAB SHOWS TODAY, AND ONLY TODAY

               It listed the next three appointments whenever they were, under a
               heading that said "Today". So a representative with nothing booked
               until Thursday saw Thursday's meeting on their Today tab and had to
               read the date to find that out - which is the tab doing the opposite
               of its job.

               TODAY IS THE SINGAPORE DAY. Using the browser's would put an
               evening meeting on tomorrow's list - see the time-zone note at the
               top of js/pages-calendar.js.

               The hero stat above still counts EVERYTHING UPCOMING, because
               "Upcoming meetings" is what it is labelled. Two different questions,
               two different numbers, both labelled with the question they answer.
               ============================================================== */
            var today = FMT.sgDayKey(new Date());

            var rows = live.filter(function (a) {
                return FMT.sgDayKey(a.start) === today;
            });

            $('#fr-hero-appts').text(live.length);
            $('#fr-hero-meetings').text(live.length);

            $('#fr-appt-sub').text(rows.length
                ? rows.length + (rows.length === 1 ? ' meeting today' : ' meetings today')
                : 'Nothing booked today');

            if (!rows.length) {
                /* NAMES THE NEXT ONE, if there is one. "Nothing today" on its own
                   invites a trip to the calendar to find out what IS next, which
                   is a question this response can already answer. */
                var next = live[0];

                $('#fr-appts').html(UI.emptyState({
                    icon: 'calendar',
                    title: 'No meetings today',
                    text: next
                        ? 'Your next one is ' + FMT.friendly(next.start).toLowerCase() +
                          ' with ' + (next.withName || 'a client') + '.'
                        : 'When a client books a review it appears here, and on your calendar.',
                    actions: UI.btn({
                        label: 'Open the calendar', icon: 'calendar', href: '#/fr/calendar'
                    })
                }));
                return;
            }

            /* UI.apptCard expects the shape js/data.js produces, so the server rows
               are mapped onto it. Doing that here rather than changing the card
               keeps one card working for the calendar, the dashboard and both
               client screens.

               NOT slice(0, 3) any more. Three was a sensible cap on "everything
               upcoming"; a day has however many meetings it has, and hiding the
               fourth one from a list headed Today would be the same fault in a
               smaller size. */
            $('#fr-appts').html('<div class="stack-4 stagger">' +
                rows.map(function (a) {
                    return UI.apptCard(apptFromServer(a), {
                        view: 'fr', agenda: true, join: true, prepare: true, consult: true
                    });
                }).join('') + '</div>');
        },

        function (err) {
            $('#fr-appt-sub').text('Could not be read');

            $('#fr-appts').html(UI.errorState({
                title: 'Could not read your appointments',
                text: (err && err.error) || 'Please try again.',
                actions: UI.btn({
                    label: 'Open the calendar', variant: 'outline',
                    icon: 'calendar', href: '#/fr/calendar'
                })
            }));
        }
    );
}


/* ==========================================================================
   THE CLIENT'S CURRENT PLANS, IN THE CALL PANEL

   Reads /api/policies?personId=, which is the endpoint the client's own My plans
   screen reads. Not DATA.policiesFor() - that is the fixture list and cannot see a
   policy that was actually issued, which is precisely how the dashboard and the
   plans page came to disagree about somebody's premium two rounds ago.

   COMPACT ON PURPOSE. This is a 320px panel beside a live video, not the plans
   page. Name, what it covers, what it costs, and whether it needs renewing - the
   four things somebody asks about mid-conversation. Anything more belongs on the
   profile, which is now one tap away without dropping the call.
   ========================================================================== */
function loadCallPlans(personId) {
    var $box = $('#call-plans');
    if (!$box.length || !personId) { return; }

    API.getPolicies(personId).then(

        function (data) {
            var mine = data.policies || [];

            if (!mine.length) {
                $box.html(UI.card({ cls: 'card-inset' },
                    '<span class="eyebrow">Current plans</span>' +
                    '<div class="t-xs muted">They hold nothing with us yet. Anything issued ' +
                    'appears here.</div>'
                ));
                return;
            }

            $box.html(UI.card({ cls: 'card-inset' },
                '<div class="between">' +
                '<span class="eyebrow">Current plans</span>' +
                '<span class="t-xs muted">' + mine.length +
                (mine.length === 1 ? ' plan' : ' plans') + '</span>' +
                '</div>' +

                '<div class="call-plans">' +
                mine.map(function (p) {
                    var due = p.status === 'renewal-due';

                    return '<div class="call-plan' + (due ? ' is-due' : '') + '">' +
                        '<div class="call-plan-top">' +
                        '<span class="call-plan-name truncate">' + FMT.esc(p.name) + '</span>' +
                        UI.badge(due ? 'Renewal due' : 'Active', due ? 'warn' : 'ok') +
                        '</div>' +

                        '<div class="call-plan-facts">' +
                        '<span>' + FMT.esc(p.coverLabel || FMT.moneyShort(p.cover)) + '</span>' +
                        '<span>&middot;</span>' +
                        '<span>' + FMT.esc(FMT.money(p.premium.amount)) + '/' +
                        (p.premium.per === 'monthly' ? 'mo' : 'yr') + '</span>' +
                        (p.number
                            ? '<span>&middot;</span><span class="truncate">' +
                              FMT.esc(p.number) + '</span>'
                            : '') +
                        '</div>' +
                        '</div>';
                }).join('') +
                '</div>' +

                /* OPENS THEIR PROFILE, and that is now a reasonable thing to
                   offer mid-call: the call docks instead of ending, so this is a
                   detour rather than a hang-up.

                   NOT a "show these to them" button. The pin drawer next to the
                   video shares PRODUCTS from the catalogue, not policies somebody
                   already holds - wiring this to it would put a label on a control
                   that does something else, which is worse than not having the
                   control. */
                UI.btn({
                    label: 'Open their full record', variant: 'outline', size: 'xs',
                    block: true, iconRight: 'arrowRight',
                    act: 'open-customer', data: { id: personId }
                })
            ));
        },

        function () {
            /* Quiet, and honest about what it could not do. A red banner in the
               middle of a live call about a panel nobody asked for is worse than a
               line of grey text. */
            $box.html(UI.card({ cls: 'card-inset' },
                '<span class="eyebrow">Current plans</span>' +
                '<div class="t-xs muted">Could not be read just now. Their profile has the ' +
                'full list.</div>'
            ));
        }
    );
}


/* One appointment row from /api/appointments, in the shape UI.apptCard wants.

   The card was written against the sample fixtures, which carry a few things the
   database does not - an agenda, and who prepared it. Those default to empty
   rather than being invented, so a real appointment simply shows fewer lines than
   a sample one instead of showing made-up ones. */
function apptFromServer(a) {
    return {
        id: a.id,
        customerId: a.customerId || a.customerPersonId || '',
        repId: a.repId || a.frPersonId || '',
        title: a.title || 'Appointment',
        type: a.type || 'Review',
        mode: a.mode || 'video',
        start: a.start,
        minutes: Number(a.minutes) || 45,
        location: a.location || (a.mode === 'video' ? 'Video call' : 'To be confirmed'),
        status: a.status || 'confirmed',
        agenda: Array.isArray(a.agenda) ? a.agenda : [],
        notes: a.notes || '',
        preparedBy: a.preparedBy || ''
    };
}


/* ==========================================================================
   THE WORK QUEUE

   What replaced the four statistic cards. Every tile is a real count from the
   SERVER, and every one is something to go and do.

   IT IS BUILT FROM SEPARATE REQUESTS THAT ARE ALLOWED TO FAIL INDEPENDENTLY.
   A tile whose request failed is left out rather than shown as zero, because
   "no clients are waiting" and "we could not find out" are different facts
   and only one of them should let somebody stop looking.
   ========================================================================== */

function loadWorkQueue() {
    var tiles = {};

    var draw = function () {
        var order = ['waiting', 'today', 'documents', 'reviews'];
        var built = order.filter(function (k) { return tiles[k]; })
            .map(function (k) { return tiles[k]; }).join('');

        if (built) { $('#fr-work').html('<div class="work-queue">' + built + '</div>'); }
    };

    /* ---- customers waiting on a reply ---- */
    API.threads().then(function (data) {
        var unread = (data.threads || []).reduce(function (sum, t) {
            return sum + (t.kind === 'human' ? Number(t.unread || 0) : 0);
        }, 0);

        var who = (data.threads || []).filter(function (t) {
            return t.kind === 'human' && Number(t.unread || 0) > 0;
        }).length;

        tiles.waiting = UI.workTile({
            icon: 'messageCircle',
            count: who,
            label: who === 1 ? 'client waiting on you' : 'clients waiting on you',
            clear: 'Nobody waiting on a reply',
            urgent: true,
            href: '#/fr/messages',
            title: unread + ' unread messages'
        });
        draw();
    }, function () { /* leave the tile out rather than claim zero */ });

    /* ---- meetings today ---- */
    API.upcomingAppointments(20).then(function (data) {
        var today = FMT.sgDayKey(new Date());

        var count = (data.appointments || []).filter(function (a) {
            return FMT.sgDayKey(a.start) === today && a.status !== 'cancelled';
        }).length;

        tiles.today = UI.workTile({
            icon: 'video',
            count: count,
            label: count === 1 ? 'meeting today' : 'meetings today',
            clear: 'No meetings today',
            href: '#/fr/calendar'
        });
        draw();
    }, function () { });

    /* ---- documents a customer has sent that nobody has opened ----

       There is no "unread document" flag, so this counts what arrived in the last
       week. That is honest about what it is - the label says "this week" rather
       than "unread", because claiming to know what a representative has read when
       nothing records it would be a made-up number, which is the whole thing this
       queue exists to avoid. */
    var rep = DATA.getRep(STATE.session.personId);
    var mine = DATA.customersForRep(rep ? rep.id : STATE.session.personId) || [];

    if (mine.length) {
        var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        var pending = 0;
        var answered = 0;

        mine.slice(0, 8).forEach(function (c) {
            API.documents.list(c.id).then(function (data) {
                (data.documents || []).forEach(function (d) {
                    var at = FMT.toDate(d.at);
                    if (at && at.getTime() >= weekAgo) { pending++; }
                });
            }, function () { }).always(function () {
                answered++;

                /* Drawn once every customer has answered, so the number does not
                   climb visibly while the requests land. */
                if (answered === Math.min(mine.length, 8)) {
                    tiles.documents = UI.workTile({
                        icon: 'folder',
                        count: pending,
                        label: pending === 1 ? 'file sent this week' : 'files sent this week',
                        clear: 'No new files',

                        /* Messages, not a documents page - there is no longer a
                           separate one. Files arrive in a conversation and are read
                           there, which is where somebody would go to reply about
                           one anyway. */
                        href: '#/fr/messages'
                    });
                    draw();
                }
            });
        });
    }

    /* ---- reviews overdue ----

       Straight from the customer record, so no request and no failure mode. Six
       months is the guideline this prototype uses. */
    var overdue = mine.filter(function (c) {
        var last = FMT.toDate(c.lastReview);
        return !last || (Date.now() - last.getTime()) > 182 * 24 * 60 * 60 * 1000;
    }).length;

    tiles.reviews = UI.workTile({
        icon: 'clock',
        count: overdue,
        label: overdue === 1 ? 'review overdue' : 'reviews overdue',
        clear: 'Every review up to date',
        href: '#/fr/customers'
    });

    draw();
}


/* Real appointment dates into the mini calendar. Until this lands the card shows
   an empty month, which is honest - it has not been told anything yet. */
function loadDashCalendar() {
    /* THE SINGAPORE MONTH, so the grid and the dots on it agree with the Calendar
       screen - see the time-zone note at the top of js/pages-calendar.js.

       firstOfMonth is a LABEL date at local midnight, not an instant. UI.miniCalendar
       reads .getMonth() off it to lay out the grid, so it has to be the browser's
       idea of "the 1st of August" even though which August came from Singapore.
       Handing it a real +08:00 instant would put the grid a month out for anybody
       west of here. */
    var p = FMT.sgParts(new Date());
    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

    var firstOfMonth = new Date(p.year, p.month - 1, 1);

    var from = p.year + '-' + pad2(p.month) + '-01';

    /* The last day of the month, via the 1st of the next one. Written out rather
       than month + 1 so December does not become month 13. */
    var lastDay = new Date(p.year, p.month, 0);
    var to = p.year + '-' + pad2(p.month) + '-' + pad2(lastDay.getDate());

    API.appointments(from, to).then(function (data) {
        var marks = {};

        (data.appointments || []).forEach(function (a) {
            if (a.status === 'cancelled') { return; }

            /* Keyed on the SINGAPORE day. Keyed on the browser's day, an evening
               meeting put its dot on the wrong square. */
            var key = FMT.sgDayKey(a.start);
            if (!key) { return; }

            marks[key] = (marks[key] || 0) + 1;
        });

        $('#fr-mini-cal').html(UI.miniCalendar({
            month: firstOfMonth, marks: marks, dayHref: '#/fr/calendar'
        }));

    }, function () { /* the empty grid already on screen is a fine fallback */ });
}


/* ==========================================================================
   CONSULTATION REQUESTS  —  the representative's side
   --------------------------------------------------------------------------
   The missing half of the feature. A customer could complete the assessment and
   choose somebody, php/api/consultation.php stored it correctly, and then it
   went nowhere: there was no screen on which a representative could see a
   request, let alone accept it. The demo stopped at that point.

   WHAT ACCEPTING ACTUALLY DOES, on the server, in one transaction:
     - marks the request accepted, with a WHERE on status so two clicks cannot
       both win
     - sets people.rep_id, which is what makes the customer THEIRS - and is what
       lib/calls.php and lib/appointments.php check before allowing a call or a
       booking
     - writes a rep_assignments history row
     - opens the conversation and posts the "X is now your financial
       representative" line
     - emails the customer

   So this UI does not need to do any of that. It sends one action and re-reads.
   ========================================================================== */

function loadConsultRequests() {
    var $box = $('#fr-requests');
    if (!$box.length) { return; }

    API.consultations().then(

        function (data) {
            var list = data.requests || [];
            var pending = [];

            for (var i = 0; i < list.length; i++) {
                if (list[i].status === 'pending') { pending.push(list[i]); }
            }

            /* Nothing waiting? Draw nothing. A card that exists only to say "no
               requests" is noise on a dashboard somebody reads every day. */
            if (!pending.length) { $box.empty(); return; }

            $box.html(
                '<div class="stack-4" style="margin-bottom:var(--gap)">' +
                UI.secHead({
                    title: pending.length === 1
                        ? '1 client is waiting for you'
                        : pending.length + ' clients are waiting for you',
                    sub: 'They chose you after completing their Financial Needs Assessment'
                }) +
                pending.map(consultRequestCard).join('') +
                '</div>'
            );
        },

        function (err) {
            /* Worth reporting, unlike most background failures: a representative
               who cannot see a request has no way to know one exists. */
            $box.html(UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'Could not check for new client requests',
                text: ((err && err.error) ? err.error : 'Please try again.') +
                    ' Anyone waiting will still be here when this loads.'
            }));
        }
    );
}


/* ==========================================================================
   POLICY APPLICATIONS - THE QUEUE

   The one screen in this app where a representative creates cover.

   Same shape as the consultation inbox above, and drawn from the same kind of
   background fetch, because it is the same job: something is waiting on a
   decision only this person can make.

   ONLY THE UNDECIDED ONES ARE SHOWN. The endpoint returns the whole history so
   the queue can be audited, but a dashboard is a list of things to do. Issued and
   declined applications are on the customer's own profile.
   ========================================================================== */

function loadPolicyQueue() {
    var $box = $('#fr-policy-queue');
    if (!$box.length) { return; }

    API.policyQueue().then(

        function (data) {
            var list = data.applications || [];
            var open = [];

            for (var i = 0; i < list.length; i++) {
                if (list[i].status === 'submitted' || list[i].status === 'under_review') {
                    open.push(list[i]);
                }
            }

            /* Nothing waiting, nothing drawn - see the note in
               loadConsultRequests() about permanent empty panels. */
            if (!open.length) { $box.empty(); return; }

            $box.html(
                '<div class="stack-4" style="margin-bottom:var(--gap)">' +
                UI.secHead({
                    title: open.length === 1
                        ? '1 application is waiting to be decided'
                        : open.length + ' applications are waiting to be decided',
                    sub: 'No cover starts until you issue it'
                }) +
                open.map(policyApplicationCard).join('') +
                '</div>'
            );
        },

        function (err) {
            $box.html(UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'Could not check for policy applications',
                text: ((err && err.error) ? err.error : 'Please try again.') +
                    ' Anything waiting will still be here when this loads.'
            }));
        }
    );
}

function policyApplicationCard(a) {
    var reviewing = a.status === 'under_review';

    var figures = UI.facts([
        ['Premium asked for', FMT.money(a.premium) + '/mo'],
        a.cover ? ['Cover', FMT.money(a.cover)] : null,
        a.ciCover ? ['Critical illness', FMT.money(a.ciCover)] : null,
        a.monthlyBenefit ? ['Monthly benefit', FMT.money(a.monthlyBenefit)] : null,
        a.termYears ? ['Term', a.termYears + ' years'] : null,
        ['Applied', FMT.relative(a.createdAt)]
    ].filter(function (row) { return !!row; }));

    return UI.card({
        title: a.customerName + ' - ' + a.name,
        sub: a.category,
        icon: a.icon,
        actions: reviewing ? UI.badge('Under review', 'info') : UI.badge('New', 'brand')
    },
        figures +

        (a.note
            ? UI.callout({
                tone: 'info', icon: 'messageCircle',
                title: 'They wrote', text: a.note
            })
            : '') +

        '<div class="card-actions">' +

        UI.btn({
            label: 'Issue the policy', variant: 'primary', size: 'sm', icon: 'checkCircle',
            act: 'policy-issue',
            data: { id: a.id, name: a.name, customer: a.customerName, premium: a.premium }
        }) +

        UI.btn({
            label: 'Decline', variant: 'outline', size: 'sm',
            act: 'policy-decline', data: { id: a.id, name: a.name }
        }) +

        (reviewing
            ? ''
            : UI.btn({
                label: 'Mark as reviewing', variant: 'ghost', size: 'sm',
                act: 'policy-review', data: { id: a.id }
            })) +

        UI.btn({
            label: 'Open profile', variant: 'ghost', size: 'sm', icon: 'user',
            act: 'open-customer', data: { id: a.customerId }
        }) +

        '</div>'
    );
}


/* "I am looking at this." Cheap, reversible, and it is what stops two people
   working the same application. */
$(document).on('click', '[data-act="policy-review"]', function () {
    var id = $(this).data('id');

    API.resolvePolicyApplication(id, 'review').then(
        function (data) {
            UI.toast({ title: data.message, tone: 'info' });
            loadPolicyQueue();
        },
        function (err) {
            UI.toast({ title: 'Could not update', message: err.error, tone: 'warn' });
        }
    );
});


/* ==========================================================================
   ISSUING

   The premium is editable here, because it moves. A customer applies at the
   published "from" price; the real figure depends on their age, their health and
   what the cover actually is. Making the representative retype it is deliberate -
   it is the number the customer will be paying, and it should pass through
   somebody's hands rather than being carried over by default.
   ========================================================================== */
$(document).on('click', '[data-act="policy-issue"]', function () {
    var $b = $(this);
    var id = $b.data('id');
    var name = $b.data('name') || 'this plan';
    var customer = $b.data('customer') || 'this client';
    var premium = Number($b.data('premium')) || 0;

    UI.openModal({
        title: 'Issue ' + name + '?',
        sub: 'For ' + customer,
        body: '<div class="stack-4">' +

            UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'This starts real cover',
                text: 'A policy number is generated, the cover begins today, and ' + customer +
                      ' is emailed and told it is in force. There is no undo on this screen.'
            }) +

            '<div class="field"><label class="field-label" for="issue-premium">' +
            'Monthly premium</label>' +
            '<input class="input" id="issue-premium" type="number" min="1" max="100000" ' +
            'value="' + premium + '">' +
            '<div class="field-hint" id="issue-hint">They applied at ' +
            FMT.money(premium) + ' a month. Change it here if underwriting moved it.</div></div>' +

            '</div>',

        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
              UI.btn({ label: 'Issue the policy', variant: 'primary', icon: 'checkCircle',
                       act: 'policy-issue-go', data: { id: id } })
    });
});

$(document).on('click', '[data-act="policy-issue-go"]', function () {
    var $btn = $(this);
    var id = $btn.data('id');
    var premium = Number($('#issue-premium').val() || 0);

    if (!(premium > 0)) {
        $('#issue-hint').html('<span class="t-bad">A policy needs a premium above zero.</span>');
        $('#issue-premium').trigger('focus');
        return;
    }

    $btn.addClass('is-loading').prop('disabled', true);

    API.resolvePolicyApplication(id, 'issue', { premium: premium }).then(

        function (data) {
            UI.closeModal();
            UI.toast({ title: 'Policy issued', message: data.message, tone: 'ok' });
            loadPolicyQueue();
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            $('#issue-hint').html('<span class="t-bad">' + FMT.esc(err.error) + '</span>');
        }
    );
});


/* Declining, with a reason the customer reads. Same rule and same wording as a
   declined consultation request. */
$(document).on('click', '[data-act="policy-decline"]', function () {
    var id = $(this).data('id');
    var name = $(this).data('name') || 'this plan';

    UI.openModal({
        title: 'Decline the ' + name + ' application?',
        body: '<div class="stack-4">' +
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'They will read what you write',
                text: 'No cover starts and nothing is charged. A reason lets them come back ' +
                    'with something that would work instead.'
            }) +
            '<div class="field"><label class="field-label" for="policy-decline-reason">' +
            'Reason (at least 10 characters)</label>' +
            '<textarea class="input" id="policy-decline-reason" rows="3" maxlength="200" ' +
            'placeholder="e.g. The premium is above what your budget allows - let us look at a shorter term."></textarea>' +
            '<div class="field-hint" id="policy-decline-hint"></div></div>' +
            '</div>',
        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
              UI.btn({ label: 'Send decline', variant: 'danger', icon: 'send',
                       act: 'policy-decline-go', data: { id: id } })
    });
});

$(document).on('click', '[data-act="policy-decline-go"]', function () {
    var id = $(this).data('id');
    var reason = $.trim($('#policy-decline-reason').val() || '');

    if (reason.length < 10) {
        $('#policy-decline-hint').html('<span class="t-bad">Please write at least 10 ' +
            'characters so they know why. ' + reason.length + '/10 so far.</span>');
        $('#policy-decline-reason').trigger('focus');
        return;
    }

    var $btn = $(this).addClass('is-loading').prop('disabled', true);

    API.resolvePolicyApplication(id, 'decline', { reason: reason }).then(

        function (data) {
            UI.closeModal();
            UI.toast({ title: 'Declined', message: data.message, tone: 'info' });
            loadPolicyQueue();
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            $('#policy-decline-hint').html('<span class="t-bad">' + FMT.esc(err.error) + '</span>');
        }
    );
});

/* One request, with the assessment attached.

   THE ASSESSMENT IS THE POINT. This is not "somebody wants to talk to you" - it
   is their goal, their risk preference, what they already have, what worries
   them, and the policies that came out of it. A representative who reads this
   card can open the first conversation knowing where the person actually is,
   which is the whole feature. So it is shown expanded, not behind a link. */
function consultRequestCard(req) {
    var a = req.assessment || null;
    var p = (a && a.profile) ? a.profile : {};
    var first = String(req.customerName || 'This client').split(' ')[0];

    var profileRows = [];
    if (p.primaryGoalLabel)    { profileRows.push(['Main goal', p.primaryGoalLabel]); }
    if (p.riskLevelLabel)      { profileRows.push(['Risk preference', p.riskLevelLabel]); }
    if (p.protectionNeedLabel) { profileRows.push(['Protection need', p.protectionNeedLabel]); }
    if (p.experienceLabel)     { profileRows.push(['Experience', p.experienceLabel]); }

    var recs = (a && a.recommended) ? a.recommended : [];

    var recList = recs.length
        ? '<ul class="fr-req-recs">' + recs.slice(0, 3).map(function (r) {
            return '<li>' + UI.icon('check', 13) + '<span>' + FMT.esc(r.name) +
                '</span><span class="fr-req-fit">' + r.fit + '%</span></li>';
        }).join('') + '</ul>'
        : '<div class="t-sm muted">No specific policies came out of their answers.</div>';

    /* What they said, question by question. Inside a <details> because it is the
       long part - available immediately, but not in the way of the decision. */
    /* answerLines, not answers. `answers` is the raw map of question id to stored
       value ({ goal: 'protection' }); `answerLines` is the same thing already
       turned into readable pairs by the server. */
    var lines = (a && a.answerLines) ? a.answerLines : [];

    var answers = lines.length
        ? '<details class="fr-req-answers"><summary>' +
          'Read their answers question by question (' + lines.length + ')</summary>' +
          '<dl>' + lines.map(function (row) {
              /* assessment_answer_lines() in php/lib/assessment.php returns
                 { question, answer }, already turned into readable labels
                 server-side - so there is no value-to-label mapping to repeat
                 here, and an answer stored by an older question set still
                 displays as something rather than vanishing. */
              return '<dt>' + FMT.esc(row.question) + '</dt>' +
                     '<dd>' + FMT.esc(row.answer) + '</dd>';
          }).join('') + '</dl></details>'
        : '';

    return UI.card({
        title: req.customerName || 'New request',
        sub: 'Requested ' + FMT.relative(req.createdAt),
        icon: 'userPlus',
        cls: 'card-soft fr-req'
    },
        (req.note
            ? UI.callout({ tone: 'info', icon: 'messageCircle',
                           title: 'What ' + first + ' wrote', text: req.note })
            : '') +

        (profileRows.length
            ? '<div class="fr-req-grid"><div>' +
              '<div class="fr-req-label">Their profile</div>' + UI.kv(profileRows) +
              '</div><div>' +
              '<div class="fr-req-label">Suggested to discuss</div>' + recList +
              '</div></div>'
            : '<div class="t-sm muted">Their assessment could not be loaded.</div>') +

        answers +

        '<div class="card-actions">' +
        UI.btn({ label: 'Accept and take them on', icon: 'userCheck',
                 act: 'consult-accept', data: { id: req.id, name: req.customerName } }) +
        UI.btn({ label: 'Decline', variant: 'outline', icon: 'userX',
                 act: 'consult-decline', data: { id: req.id, name: req.customerName } }) +
        '</div>'
    );
}


/* ---------------------------------------------------------------- accept ---
   Confirmed first. It is not destructive, but it does create a real advisory
   relationship and send the customer an email, so it should not happen from one
   stray click on a dashboard. */
$(document).on('click', '[data-act="consult-accept"]', function () {
    var id = $(this).data('id');
    var name = $(this).data('name') || 'this client';

    UI.confirmModal({
        title: 'Take on ' + name + '?',
        message: 'They become one of your clients straight away: you will be able to ' +
            'message them, book meetings and start a video consultation. They are told by ' +
            'email that you accepted.',
        confirmLabel: 'Accept',
        confirmAct: 'consult-accept-go',
        confirmData: { id: id }
    });
});

$(document).on('click', '[data-act="consult-accept-go"]', function () {
    var id = $(this).data('id');
    UI.closeModal();

    API.resolveConsultation(id, 'accept').then(

        function (data) {
            UI.toast({ title: 'Accepted', message: data.message, tone: 'ok' });

            /* A full re-render, not just the requests panel. Accepting changes
               the customer count, the appointment list and who can be called, so
               redrawing only the card that was pressed would leave the rest of
               the dashboard describing the situation before the click. */
            router();
        },

        function (err) {
            UI.toast({ title: 'Could not accept', message: err.error, tone: 'warn' });

            /* Re-read either way. The usual reason for a refusal is that the
               request was already dealt with somewhere else, in which case the
               card on screen is stale and should go. */
            loadConsultRequests();
        }
    );
});


/* --------------------------------------------------------------- decline ---
   A REASON IS REQUIRED, and the customer is shown it. The server enforces ten
   characters, so the box says so rather than letting somebody discover it by
   being rejected. A silent no is the most frustrating outcome available. */
$(document).on('click', '[data-act="consult-decline"]', function () {
    var id = $(this).data('id');
    var name = $(this).data('name') || 'this client';

    UI.openModal({
        title: 'Decline ' + name + '?',
        body: '<div class="stack-4">' +
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'They will read what you write',
                text: 'A reason lets them choose somebody else with some idea why. ' +
                    '"I am at capacity this month" is plenty.'
            }) +
            '<div class="field"><label class="field-label" for="decline-reason">' +
            'Reason (at least 10 characters)</label>' +
            '<textarea class="input" id="decline-reason" rows="3" maxlength="300" ' +
            'placeholder="e.g. I am at capacity this month - Marcus specialises in the same area."></textarea>' +
            '<div class="field-hint" id="decline-hint"></div></div>' +
            '</div>',
        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
              UI.btn({ label: 'Send decline', variant: 'danger', icon: 'send',
                       act: 'consult-decline-go', data: { id: id } })
    });
});

$(document).on('click', '[data-act="consult-decline-go"]', function () {
    var id = $(this).data('id');
    var reason = $.trim($('#decline-reason').val() || '');

    // Checked here so the message appears next to the box, not as a toast
    if (reason.length < 10) {
        $('#decline-hint').html('<span class="t-bad">Please write at least 10 characters ' +
            'so they know why. ' + reason.length + '/10 so far.</span>');
        $('#decline-reason').trigger('focus');
        return;
    }

    var $btn = $(this).addClass('is-loading').prop('disabled', true);

    API.resolveConsultation(id, 'decline', { reason: reason }).then(

        function (data) {
            UI.closeModal();
            UI.toast({ title: 'Declined', message: data.message, tone: 'info' });
            loadConsultRequests();
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            $('#decline-hint').html('<span class="t-bad">' + FMT.esc(err.error) + '</span>');
        }
    );
});


/* ==========================================================================
   THE CLIENT LIST

   ==========================================================================
   THE SAMPLE BOOK HAS GONE FROM THIS SCREEN
   ==========================================================================

   It used to be two lists stacked on one page: the representative's REAL clients
   from the database at the top, and underneath them a section headed "Worked
   examples" containing the six people in js/data.js - with the search box and the
   filter chips wired only to the second one.

   Every part of that was a problem:

     THE COUNT WAS WRONG. The page said "the 6 worked examples" and the dashboard
     hero said "5 Clients", both counted from fixtures. Neither was the number of
     people this representative actually advises, which is the only number the
     word "clients" can honestly mean on their own screen.

     THE SEARCH LIED. Typing a real client's name into a search box that only
     looked at the sample six returned "no clients match that" about somebody who
     is sitting in the list above it.

     AND THE SEEDED SIX ARE ALREADY IN THE DATABASE. cus-001 to cus-006 are rows
     in `people` with rep_id = fr-001. So the "real" list was already showing
     them, and the sample section below was a SECOND COPY of the same people with
     slightly different figures. Two rows for Sarah Tan, disagreeing.

   So there is now one list, from one place: /api/consultation, which returns
   everybody whose people.rep_id is the representative asking. The rich fixture
   records in js/data.js are still used on the PROFILE, where the depth is the
   point - they are just no longer a second answer to "who are my clients".
   ========================================================================== */

/* Fetched once per page load and shared. The dashboard needs the same list for
   its hero count and its priority section, and two screens asking the same
   question of the same endpoint a second apart is the shape of bug this whole
   round has been about. */
var FR_BOOK = { rows: null, loading: false, waiting: [] };

function frBook(done) {
    if (FR_BOOK.rows !== null) { done(FR_BOOK.rows); return; }

    FR_BOOK.waiting.push(done);
    if (FR_BOOK.loading) { return; }

    FR_BOOK.loading = true;

    var settle = function (rows) {
        FR_BOOK.rows = rows;
        FR_BOOK.loading = false;

        var waiting = FR_BOOK.waiting.splice(0);
        waiting.forEach(function (fn) { fn(rows); });
    };

    API.consultations().then(
        function (data) { settle((data && data.customers) ? data.customers : []); },

        /* An empty list rather than a rejection. Every caller draws "nobody yet",
           which is the right thing to show when we cannot find out - and stops
           each of them writing its own error branch. */
        function () { settle([]); }
    );
}

/* Something changed the book (a request was accepted). Drop the cache so the
   next reader fetches it again rather than trusting a stale count. */
function frBookStale() { FR_BOOK.rows = null; }


var custQuery = '';
var custFilter = 'all';

/* The chips are only things a real client row can actually answer.

   The old set included "Priority" and "Review due", which read c.priority and
   c.tags - fields that exist on a js/data.js fixture and nowhere in the database.
   A filter that silently matches nothing is worse than no filter, because the
   empty result looks like an answer. */
var CUST_FILTERS = [
    { id: 'all', label: 'Everyone' },
    { id: 'gap', label: 'Biggest shortfall' },
    { id: 'nofigures', label: 'No figures yet' },
    { id: 'noassessment', label: 'No assessment' },
    { id: 'new', label: 'New this month' }
];

function filteredBook(rows) {
    var q = custQuery.toLowerCase();

    return rows.filter(function (c) {
        var haystack = (c.name + ' ' + (c.segment || '')).toLowerCase();
        if (q && haystack.indexOf(q) === -1) { return false; }

        if (custFilter === 'gap') { return c.gap !== null && c.gap > 400000; }
        if (custFilter === 'nofigures') { return !c.hasFinances; }
        if (custFilter === 'noassessment') { return !c.hasAssessment; }

        if (custFilter === 'new') {
            var since = FMT.toDate(c.clientSince);
            return !!since && (Date.now() - since.getTime()) < 31 * 86400000;
        }
        return true;
    });
}

/* Draws just the results area, so typing in the search box does not rebuild the
   whole page and does not steal focus from the input. */
function renderClientResults() {
    var $box = $('#cust-results');
    if (!$box.length) { return; }

    var rows = FR_BOOK.rows || [];

    /* NOBODY AT ALL is a different situation from NOBODY MATCHING, and they need
       different words. The first is a new representative; the second is a search
       that came up empty. */
    if (!rows.length) {
        $box.html(UI.emptyState({
            icon: 'users',
            title: 'No clients yet',
            text: 'Somebody becomes your client when they choose you and you accept their ' +
                'request. Pending requests appear on your dashboard.',
            actions: UI.btn({ label: 'Open the dashboard', icon: 'grid', href: '#/fr/dashboard' })
        }));
        $('#cust-count').text('0');
        return;
    }

    var list = filteredBook(rows);

    $('#cust-count').text(String(rows.length));

    if (!list.length) {
        $box.html(UI.emptyState({
            icon: 'search',
            title: 'No clients match that',
            text: 'Try a different name, or clear the filters to see everyone you advise.',
            actions: UI.btn({ label: 'Clear filters', variant: 'outline', icon: 'refresh', act: 'cust-clear' })
        }));
        return;
    }

    $box.html('<div class="cust-grid stagger">' +
        list.map(clientCard).join('') + '</div>');

    UI.animateBars();
}

PAGES['/fr/customers'] = {
    title: 'Clients',
    sub: 'Everyone you advise',

    render: function () {
        var chips = CUST_FILTERS.map(function (f) {
            return UI.chip({ label: f.label, on: custFilter === f.id, act: 'cust-filter', data: { filter: f.id } });
        }).join('');

        /* THE CARDS/TABLE TOGGLE HAS GONE TOO.

           Two layouts of the same list, one of which showed columns that only the
           fixtures had (occupation, risk profile, income). Keeping it would mean
           either inventing those for real clients or shipping a table of blanks,
           and a view switch nobody asked for is a decision handed to the reader
           for no reason. */
        var toolbar = UI.card({ cls: 'card-inset' },
            '<span class="search grow" style="max-width:420px">' +
            '<span class="input-icon">' + UI.icon('search', 16) + '</span>' +
            '<input class="input" id="cust-search" type="search" placeholder="Search by name..." ' +
            'value="' + FMT.esc(custQuery) + '" aria-label="Search clients"></span>' +
            '<div class="chips scroll-x">' + chips + '</div>'
        );

        return UI.pageHead({
            eyebrow: 'Your book',
            title: 'Clients',
            /* THE COUNT COMES FROM THE SERVER, so it is filled in by after().
               subHtml rather than sub because it contains an element the load
               replaces - see UI.secHead's two subtitle names. */
            subHtml: '<span id="cust-count">\u2026</span> ' +
                'people you advise, biggest protection shortfall first, with anybody who ' +
                'has not entered figures last.',
            actions: UI.btn({ label: 'Ask PRUWise', icon: 'sparkles', href: '#/fr/pruwise' })
        }) +
            toolbar +
            '<div id="cust-results">' + UI.loadingState('Reading your book\u2026') + '</div>';
    },

    after: function () {
        frBook(function (rows) {
            renderClientResults();
            paintNavClientCount(rows.length);
        });
    }
};


/* One client card, built only from fields a real row actually has.

   The gap is null when they have not entered an income, and that reads as "not
   enough to calculate" rather than as a comfortable zero - the distinction the
   nullable columns in customer_finances exist to preserve. */
function clientCard(c) {
    var known = (c.gap !== null && c.gap !== undefined);

    var meterRow = known
        ? '<div class="stack-2">' +
          '<div class="meter-head">' +
          '<span class="meter-label">Protection</span>' +
          '<span class="meter-val">' + c.ratio + '% of suggested</span>' +
          '</div>' +
          UI.progress(c.ratio, {
              thin: true,
              tone: c.ratio >= 80 ? 'ok' : (c.ratio >= 55 ? '' : 'warn')
          }) +
          '<div class="t-xs ' + (c.gap > 0 ? 't-warn semi' : 't-ok semi') + '">' +
          (c.gap > 0 ? FMT.moneyShort(c.gap) + ' shortfall' : 'Meets the suggested cover') +
          '</div></div>'

        : '<div class="t-xs muted">No figures entered yet, so there is no protection gap to ' +
          'show. Only they can add them, in their settings.</div>';

    return UI.card({ cls: 'cust-card', hover: true },
        UI.person({
            name: c.name,
            meta: c.segment ? c.segment : 'Client',
            size: 'lg',
            seed: c.personId
        }) +

        '<div class="row-2 wrap">' +
        (c.hasAssessment
            ? UI.badge('Assessment done', 'ok')
            : UI.badge('No assessment', 'warn')) +
        (c.hasFinances ? UI.badge('Figures entered', 'brand') : '') +
        '</div>' +

        meterRow +

        '<div class="card-actions">' +
        UI.btn({ label: 'Open profile', size: 'sm', iconRight: 'arrowRight',
                 act: 'open-customer', data: { id: c.personId } }) +
        UI.btn({ label: 'Call', variant: 'outline', size: 'sm', icon: 'video',
                 act: 'start-call', data: { id: c.personId } }) +
        '</div>'
    );
}

/* Kept under its old name because liveCustomerShell's error state and a couple of
   other callers reference it. One implementation, two names, rather than two
   implementations that drift. */
function liveCustomerCard(c) { return clientCard(c); }

/* One card, built only from fields a real customer actually has.

   The gap is null when they have not entered an income, and that reads as "not
   enough to calculate" rather than as a comfortable zero - the distinction the
   nullable columns exist to preserve. */
function liveCustomerCard(c) {
    var known = (c.gap !== null && c.gap !== undefined);

    var meterRow = known
        ? '<div class="stack-2">' +
          '<div class="meter-head">' +
          '<span class="meter-label">Protection</span>' +
          '<span class="meter-val">' + c.ratio + '% of suggested</span>' +
          '</div>' +
          UI.progress(c.ratio, {
              thin: true,
              tone: c.ratio >= 80 ? 'ok' : (c.ratio >= 55 ? '' : 'warn')
          }) +
          '<div class="t-xs ' + (c.gap > 0 ? 't-warn semi' : 't-ok semi') + '">' +
          (c.gap > 0 ? FMT.moneyShort(c.gap) + ' shortfall' : 'Meets the suggested cover') +
          '</div></div>'

        : '<div class="t-xs muted">No figures entered yet, so there is no protection gap to ' +
          'show. Only they can add them, in their settings.</div>';

    /* cust-card and hover, so these sit in the same grid and behave the same way
       as the worked examples below them. The grid itself is .cust-grid. */
    return UI.card({ cls: 'cust-card', hover: true },
        UI.person({
            name: c.name,
            meta: c.segment ? c.segment : 'Client',
            size: 'lg',
            seed: c.personId
        }) +

        '<div class="row-2 wrap">' +
        (c.hasAssessment
            ? UI.badge('Assessment done', 'ok')
            : UI.badge('No assessment', 'warn')) +
        (c.hasFinances ? UI.badge('Figures entered', 'brand') : '') +
        '</div>' +

        meterRow +

        '<div class="card-actions">' +
        UI.btn({ label: 'Open profile', size: 'sm', iconRight: 'arrowRight',
                 href: '#/fr/customer/' + encodeURIComponent(c.personId) }) +
        UI.btn({ label: 'Call', variant: 'outline', size: 'sm', icon: 'video',
                 act: 'start-call', data: { id: c.personId } }) +
        '</div>'
    );
}


/* ==========================================================================
   CUSTOMER PROFILE
   ========================================================================== */
PAGES['/fr/customer/:id'] = {
    title: 'Client profile',
    sub: 'Full record and AI analysis',

    render: function (ctx) {
        var c = DATA.getCustomer(ctx.params.id);

        /* NOT IN THE DEMO SET DOES NOT MEAN NOT REAL.

           DATA.customers holds the six seeded people. A customer who signed up
           themselves and was accepted through the consultation inbox is a real
           row in `people`, with a real id that DATA has never heard of - and
           until now this screen answered "Client not found" for them, which is
           the first thing a representative would see after accepting somebody.

           So an unknown id is treated as a live customer and looked up on the
           server instead. api/finances.php only answers for a customer whose
           people.rep_id is the representative asking, so an id that is not
           theirs still ends up at "not found" - just for the right reason. */
        if (!c) { return liveCustomerShell(ctx.params.id); }

        // Remember who we are looking at, so the AI and other pages follow along
        STATE.activeCustomerId = c.id;
        saveState();

        var rep = DATA.getRep(c.repId);
        var policies = DATA.policiesFor(c.id);
        var appt = DATA.nextApptFor(c.id);
        var recs = DATA.recsFor(c.id);
        var gap = DATA.coverageGap(c);
        var ratio = DATA.coverageRatio(c);

        /* ------------------------------------------------------- tabs */
        var tabs = UI.tabs('profile', [
            {
                id: 'overview', label: 'Overview', icon: 'user',
                render: function () { return profileOverview(c, recs, gap, ratio); }
            },
            {
                id: 'coverage', label: 'Coverage', icon: 'shield',
                render: function () { return profileCoverage(c, policies); }
            },
            {
                id: 'plans', label: 'Plans (' + policies.length + ')', icon: 'fileText',
                render: function () { return profilePlans(c, policies); }
            },
            {
                /* RECOMMENDATIONS LIVE ON THE CLIENT NOW.

                   They used to be their own screen at /fr/recommendations, which
                   meant picking a client from a chip bar at the top and then
                   reading a shortlist with none of their record beside it. A
                   recommendation is a statement ABOUT ONE PERSON, so it belongs on
                   that person's page, next to the coverage and the plans it is
                   arguing about.

                   This tab is also the only place a recommendation can be released
                   - see releaseControl(). Keeping the shortlist and the release
                   control on the same screen is deliberate: the decision should be
                   made while looking at the reasoning, not on a different page. */
                id: 'recs', label: 'Recommendations (' + recs.length + ')', icon: 'target',
                render: function () { return profileRecs(c, recs); }
            },
            {
                id: 'meetings', label: 'Appointments', icon: 'calendar',
                render: function () { return profileMeetings(c); }
            },
            {
                id: 'record', label: 'Record', icon: 'clipboard',
                render: function () { return profileRecord(c); }
            }
        ]);

        /* ------------------------------------------------- right rail */
        var rail = '<div class="stack">' +

            UI.card({ cls: 'card-soft' },
                '<div class="between">' + UI.aitag('AI needs summary') +
                UI.badge('Fit ' + (recs.length ? recs[0].fit : '-') + '/100', 'brand') + '</div>' +
                '<div class="t-sm">' + FMT.esc(c.aiSummary) + '</div>' +
                UI.btn({
                    label: 'Ask PRUWise', icon: 'sparkles', size: 'sm', block: true,
                    act: 'customer-navigator', data: { id: c.id }
                })
            ) +

            /* ==============================================================
               THE MONEY ON THIS SCREEN COMES FROM THE DATABASE, NOT THE FIXTURES

               REPORTED: "the financial details are changed in the customer page
               but not in the financial representative page financial overview of
               client."

               Exactly so, and it is the third time this shape of bug has turned
               up in this project. The client edits customer_finances in their own
               Settings. This screen read DATA.getCustomer(id) - the hand-written
               record in js/data.js - for the shortfall, the ratio, the protection
               score and the stated budget. Two screens answering the same question
               from two different sources, so the representative was reading last
               year's income about somebody who had just corrected it.

               The container is filled by loadClientMoney() from
               /api/finances?personId=, which is the SAME function
               (financesNeeds) the client's own dashboard uses. The fixture
               figures are drawn first so the panel is never a hole, and they are
               replaced a moment later - and if the client has entered nothing,
               the panel says THAT rather than silently keeping the sample.
               ============================================================== */
            '<div id="fr-prof-money">' +
            clientMoneyCard({ ratio: ratio, gap: gap, score: c.protectionScore, sample: true }) +
            '</div>' +

            UI.card({ title: 'Assigned representative', icon: 'userCheck' },
                UI.person({ name: rep.name, meta: rep.role, size: 'lg', seed: rep.id, online: true }) +
                UI.kv([
                    ['Experience', rep.years + ' years'],
                    ['Rating', rep.rating + ' (' + rep.reviews + ' reviews)'],
                    ['Licence', rep.licence]
                ])
            ) +

            (appt
                ? '<div class="stack-4">' + UI.secHead({ title: 'Next appointment' }) +
                UI.apptCard(appt, { view: 'fr', agenda: true, join: true }) + '</div>'
                : UI.card({ title: 'No appointment scheduled', icon: 'calendar' },
                    '<div class="t-sm muted">Last contact was ' + FMT.relative(c.lastContact) + '.</div>' +
                    UI.btn({ label: 'Start an AI-assisted call', variant: 'soft', size: 'sm', block: true, icon: 'video', act: 'start-call', data: { id: c.id } })
                )) +

            /* The stated budget is the client's own figure too, so this card is
               corrected from the same response. */
            '<div id="fr-prof-premiums">' +
            clientPremiumsCard(c, c.money.premiumBudget, true) +
            '</div>' +
            '</div>';

        var crumbs = '<div class="crumbs"><a href="#/fr/customers" class="link">Clients</a>' +
            UI.icon('chevronRight', 12) + '<span class="now">' + FMT.esc(c.name) + '</span></div>';

        return UI.pageHead({
            crumbs: crumbs,
            eyebrow: c.segment,
            title: c.salutation + ' ' + c.name,
            sub: c.age + ' | ' + c.occupation + ' at ' + c.employer + ' | ' + c.maritalStatus + ', ' + c.dependantDetail,
            actions: UI.btn({ label: 'Analyse with AI', icon: 'sparkles', act: 'customer-navigator', data: { id: c.id } }) +

                /* Switches to the tab on THIS page rather than navigating to a
                   separate recommendations screen, which no longer exists. */
                UI.btn({
                    label: 'Recommendations', variant: 'outline', icon: 'target',
                    act: 'tab', data: { set: 'profile', tab: 'recs' }
                }) +
                UI.btn({ label: 'Start call', variant: 'outline', icon: 'video', act: 'start-call', data: { id: c.id } })
        }) +
            '<div class="split split-rail"><div class="stack">' +

            /* WHAT PRUWISE READ IN THE CONVERSATIONS SITS ABOVE THE TABS.

               It is a proposal waiting on a decision, and the person who has to
               make it should not have to guess which tab it is behind. Empty
               until after() fills it, and drawn as nothing at all when there is
               nothing to decide - see loadInsights(). */
            '<div id="fr-insights"></div>' +

            tabs + '</div>' + rail + '</div>';
    },

    after: function (ctx) {
        /* Runs for both branches. Insights come from conversations, and a client
           who is not in the demo set is the one MOST likely to have had a real
           one. */
        loadInsights(ctx.params.id);

        /* Only the live-client branch has anything else to fetch. The six demo
           profiles are drawn entirely from js/data.js. */
        if (!DATA.getCustomer(ctx.params.id)) {
            loadLiveCustomer(ctx.params.id);
            return;
        }

        /* Which recommendations this client has already been shown. Runs for the
           demo profiles too, because releases are stored on the server and are
           real even when the shortlist beside them is sample data. */
        loadReleaseState(ctx.params.id);

        /* THE REAL MONEY, over the sample money. This is the fix for "the
           financial details are changed in the customer page but not in the
           financial representative page". */
        loadClientMoney(ctx.params.id, DATA.getCustomer(ctx.params.id));
    }
};


/* ==========================================================================
   A REAL CUSTOMER'S PROFILE

   Everything above this point reads js/data.js. This part reads the server.

   WHAT A REPRESENTATIVE CAN SEE HERE, AND WHY IT IS LESS

   A seeded customer has policies, appointment history, an AI summary and a
   protection score, because all of that was written by hand to demonstrate the
   product. A customer who signed up last week has none of it. Inventing the
   missing pieces would be worse than leaving them out: the representative would
   be reading fiction about a real person.

   So this screen shows exactly three things, all of them genuine:

     the figures the customer entered themselves, in Settings
     the protection needs calculated from those figures, by finances_needs()
     the ways to get in touch

   READ-ONLY, ALWAYS. api/finances.php refuses a write from anybody but the
   owner, so there is no edit button here to be disappointed by. That is the
   point of the record - it is a statement of what the customer said, and a
   representative editing it would make it worthless as one.
   ========================================================================== */

/* The shell render() returns immediately. The panel is filled by after().

   Drawn as a real page with a heading rather than a bare spinner, so a slow
   response leaves the representative somewhere they can navigate away from
   instead of a blank screen. */
function liveCustomerShell(personId) {

    /* Remembered now rather than after the fetch, so "Start call" and the AI
       follow this person even if the profile request is still in flight. */
    STATE.activeCustomerId = personId;
    saveState();

    var crumbs = '<div class="crumbs"><a href="#/fr/customers" class="link">Clients</a>' +
        UI.icon('chevronRight', 12) + '<span class="now">Client</span></div>';

    return UI.pageHead({
        crumbs: crumbs,
        eyebrow: 'Your client',
        title: 'Client profile',
        sub: 'Loading the record they filled in themselves.'
    }) +
        /* Above the record, for the same reason as on a demo profile: it is the
           only thing on the screen waiting on a decision. */
        '<div id="fr-insights"></div>' +
        '<div id="fr-live-cust">' + UI.loadingState('Opening their record\u2026') + '</div>';
}

function loadLiveCustomer(personId) {
    var $box = $('#fr-live-cust');
    if (!$box.length) { return; }

    API.customerFinances(personId).then(

        function (data) { drawLiveCustomer(personId, data); },

        function (err) {
            /* 404 covers BOTH "no such person" and "not your client" - see the
               note at the top of php/api/finances.php. The wording has to be true
               of either, so it does not confirm that an id exists. */
            var missing = (err && err.status === 404);

            $box.html(UI.errorState({
                icon: missing ? 'user' : 'alertTriangle',
                title: missing ? 'That client is not on your list' : 'Could not open their record',
                text: missing
                    ? 'Either the link is out of date, or they are not one of your clients. ' +
                      'Accepting a consultation request is what puts somebody on your list.'
                    : ((err && err.error) ? err.error : 'The connection timed out.'),
                actions: UI.btn({ label: 'Back to clients', variant: 'outline',
                                  icon: 'arrowLeft', href: '#/fr/customers' }) +
                    (missing ? '' : UI.btn({ label: 'Try again', variant: 'ghost', icon: 'refresh',
                                             act: 'fr-live-reload', data: { id: personId } }))
            }));
        }
    );
}

$(document).on('click', '[data-act="fr-live-reload"]', function () {
    var id = $(this).data('id');
    $('#fr-live-cust').html(UI.loadingState('Opening their record\u2026'));
    loadLiveCustomer(id);
});

function drawLiveCustomer(personId, data) {
    var name  = data.customerName || 'Your client';
    var first = data.firstName || name.split(' ')[0];
    var f     = data.finances || {};
    var needs = data.needs || null;

    /* The heading was written before the name was known - render() runs before
       the request finishes - so correct it now rather than leaving a generic
       "Client profile" sitting above a named record.

       .text() rather than .html(), because the name comes from the database and
       must never be treated as markup. UI.pageHead() renders the title as the
       single <h1> inside .page-head, so this is the one it finds. */
    $('.page-head h1').first().text(name);
    $('.page-head .crumbs .now').first().text(name);

    /* ------------------------------------------------ nothing filled in yet

       The honest version. A representative needs to know the difference between
       "no shortfall" and "no figures", and a screen full of zeros does not tell
       them which they are looking at. */
    if (!data.hasAny) {
        $('#fr-live-cust').html(
            UI.card({ title: 'No financial details yet', icon: 'dollarSign' },
                UI.callout({
                    tone: 'info', icon: 'info',
                    title: first + ' has not entered any figures',
                    text: 'Their income, savings, CPF and commitments are entered by them in ' +
                        'Settings, and only they can change them. Until then there is nothing to ' +
                        'calculate a protection gap from - which is why this is blank rather ' +
                        'than zero.'
                }) +
                '<div class="t-sm muted">Asking them directly is the fastest route. A message ' +
                'explaining what the numbers are for tends to work better than the form on its ' +
                'own.</div>' +
                liveCustomerActions(personId, first)
            )
        );
        return;
    }

    /* ------------------------------------------------ the record */

    /* Only what they actually answered. A row reading "Savings: $0" for somebody
       who left the box empty would be a statement they never made - which is the
       whole reason every column in customer_finances is nullable. */
    var rows = [];

    function addMoney(label, value, suffix) {
        if (value === null || value === undefined) { return; }
        rows.push([label, FMT.money(value) + (suffix || '')]);
    }

    addMoney('Annual income', f.annualIncome);
    addMoney('Monthly take-home', f.monthlyIncome);
    addMoney('Monthly expenses', f.monthlyExpenses);
    addMoney('Monthly commitments', f.monthlyCommitments);
    addMoney('Stated premium budget', f.premiumBudget, '/mo');
    addMoney('Savings', f.savings);
    addMoney('CPF', f.cpf);
    addMoney('Outstanding mortgage', f.mortgage);
    addMoney('Other debt', f.otherDebt);

    if (f.dependants !== null && f.dependants !== undefined) {
        rows.push(['People depending on their income', String(f.dependants)]);
    }
    if (f.retireAge !== null && f.retireAge !== undefined) {
        rows.push(['Target retirement age', String(f.retireAge)]);
    }
    addMoney('Retirement income wanted', f.retireMonthlyTarget, '/mo');
    addMoney('Life cover held elsewhere', f.existingLifeCover);
    addMoney('Critical illness held elsewhere', f.existingCiCover);

    var recordCard = UI.card({
        title: 'What ' + first + ' told us',
        sub: f.updatedAt ? 'They last updated this ' + FMT.relative(f.updatedAt) : 'Entered by them',
        icon: 'dollarSign'
    },
        UI.facts(rows) +
        '<div class="t-xs muted">Entered by the client and read-only here. If something is ' +
        'wrong, they can correct it in their own settings - a figure you edited would no longer ' +
        'be a record of what they said.</div>'
    );

    /* The needs analysis. Identical bars to the customer's own dashboard, from
       identical numbers, because both call finances_needs() on the server. */
    /* Named needsPanel, not needsCard: pages-me.js already has a global function
       called needsCard() for the customer's own version of this. Nothing breaks
       either way - a local var only shadows inside this function - but two things
       with the same name doing similar jobs in the same global scope is exactly
       how somebody later calls the wrong one. */
    var needsPanel = needs
        ? UI.card({
            title: 'Protection needs',
            sub: 'Calculated from their figures. The dashed outline is the suggested cover.',
            icon: 'shield'
        },
            (needs.gap > 0
                ? UI.callout({
                    tone: needs.ratio >= 55 ? 'info' : 'warn',
                    icon: needs.ratio >= 55 ? 'info' : 'alertTriangle',
                    title: FMT.money(needs.gap) + ' below the suggested cover',
                    text: 'Cover sits at ' + needs.ratio + '% of the suggested level, based on ' +
                        needs.yearsOfIncome + ' years of income, what they owe, and the savings ' +
                        'and CPF they declared. ' + first + ' sees these same figures.'
                })
                : UI.callout({
                    tone: 'ok', icon: 'checkCircle',
                    title: 'At or above the suggested cover',
                    text: 'No material shortfall on their own figures.'
                })) +
            UI.coverageLineBars(needs.lines || [])
        )
        : UI.card({ title: 'Protection needs', icon: 'shield' },
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'Not enough to calculate from yet',
                text: first + ' has entered some figures but not an income, and every line of ' +
                    'the calculation is derived from income. Nothing is shown rather than a ' +
                    'row of zeros that would read like an answer.'
            }));

    /* ---- right rail: the score, the emergency fund, affordability ---- */

    var scoreCard = needs
        ? UI.card({ title: 'Protection score', sub: 'Cover in place against the suggested level',
                    icon: 'target' },
            CHARTS.gauge({
                value: needs.ratio,
                label: 'of the suggested cover',
                tone: needs.ratio >= 80 ? 'var(--ok)'
                    : (needs.ratio >= 55 ? 'var(--brand)' : 'var(--warn)')
            }) +
            UI.facts([
                ['Suggested cover', FMT.moneyShort(needs.totalNeed)],
                ['Already held', FMT.moneyShort(needs.totalHave)],
                ['Shortfall', FMT.moneyShort(needs.gap)]
            ]))
        : '';

    var fundCard = (needs && needs.emergency)
        ? UI.card({ title: 'Emergency fund', icon: 'briefcase' },
            UI.meter({
                label: needs.emergency.monthsHeld + ' months of expenses',
                value: FMT.moneyShort(needs.emergency.have) + ' / ' +
                       FMT.moneyShort(needs.emergency.target),
                percent: Math.min(100, (needs.emergency.have /
                                        Math.max(1, needs.emergency.target)) * 100),
                tone: needs.emergency.shortfall > 0 ? 'warn' : 'ok'
            }) +
            '<div class="t-xs muted">' +
            (needs.emergency.shortfall > 0
                ? FMT.money(needs.emergency.shortfall) + ' short of the usual ' +
                  needs.emergency.targetMonths + ' months. Worth settling before adding a premium.'
                : 'Comfortable. A new premium would not be coming out of their buffer.') +
            '</div>')
        : '';

    /* Affordability is the one figure that should change what gets recommended,
       so it is a callout rather than a row in a table. */
    var affordCard = '';

    if (needs && needs.affordability) {
        var a = needs.affordability;

        affordCard = UI.card({ title: 'What they can afford', icon: 'creditCard' },
            a.noHeadroom
                ? UI.callout({
                    tone: 'warn', icon: 'alertTriangle',
                    title: 'No headroom on their own figures',
                    text: 'Expenses and commitments account for all of their income. Anything ' +
                        'recommended here has to displace something else, and saying so first is ' +
                        'better than a policy that lapses in month four.'
                })
                : (a.overCommitted
                    ? UI.callout({
                        tone: 'warn', icon: 'alertTriangle',
                        title: 'Their budget is above what is left over',
                        text: 'They said ' + FMT.money(a.statedBudget) + ' a month, but only ' +
                            FMT.money(a.spare) + ' is spare after expenses and commitments. ' +
                            'Worth resolving before quoting.'
                    })
                    : UI.callout({
                        tone: 'ok', icon: 'checkCircle',
                        title: FMT.money(a.spare) + ' a month unaccounted for',
                        text: (a.statedBudget
                            ? 'Their stated budget of ' + FMT.money(a.statedBudget) + ' fits inside it.'
                            : 'They have not stated a budget.') +
                            ' Using all of it would be a mistake, but there is room.'
                    })));
    }

    $('#fr-live-cust').html(
        '<div class="split split-rail">' +
        '<div class="stack">' + needsPanel + recordCard + '</div>' +
        '<div class="stack">' + scoreCard + fundCard + affordCard +
        UI.card({ title: 'Get in touch', icon: 'messageCircle' },
            '<div class="t-sm muted">They chose you, and they know their assessment was sent ' +
            'across - so there is no need to start from the beginning.</div>' +
            liveCustomerActions(personId, first)) +
        '</div></div>'
    );

    /* The coverage bars and meters start at width 0 and grow to the width in
       their data-w attribute. app.js calls this once after a page renders, but
       this markup arrived later, from a promise - so it has to be called again or
       every bar stays empty. */
    UI.animateBars();
}

/* The three ways to reach a real customer, in one place because the "no figures
   yet" panel and the full profile both offer them. */
function liveCustomerActions(personId, first) {
    return '<div class="card-actions">' +
        UI.btn({ label: 'Message ' + first, icon: 'messageCircle', size: 'sm',
                 href: '#/fr/messages' }) +
        UI.btn({ label: 'Start a call', variant: 'outline', size: 'sm', icon: 'video',
                 act: 'start-call', data: { id: personId } }) +
        UI.btn({ label: 'Book a meeting', variant: 'ghost', size: 'sm', icon: 'calendar',
                 href: '#/fr/calendar' }) +
        '</div>';
}


/* ==========================================================================
   THE RECOMMENDATIONS TAB ON A CLIENT'S PROFILE

   What replaced /fr/recommendations. The shortlist, the comparison, and the
   control that decides whether the client ever sees any of it.

   ==========================================================================
   NOTHING HERE IS VISIBLE TO THE CLIENT UNTIL IT IS RELEASED
   ==========================================================================

   That is the product rule, and this is where it is enforced in the interface -
   /api/recommendations enforces it on the server, which is the half that
   actually counts. The shortlist is COMPUTED: fit scores, gap arithmetic,
   comparisons against the other options. Computed output reaching a client
   unreviewed would be a machine advising on insurance in a licensed person's
   name.

   So each card carries its own release control, and releasing requires the
   representative to write a sentence in their own words.
   ========================================================================== */

function profileRecs(c, recs) {
    if (!recs.length) {
        return UI.emptyState({
            icon: 'target',
            title: 'No recommendations prepared yet',
            text: 'Once ' + FMT.esc(c.firstName) + ' has financial details on file, ' +
                'PRUWise shortlists the options that fit them and you decide which, ' +
                'if any, to put in front of them.'
        });
    }

    return '<div class="stack-4">' +

        /* SAID AT THE TOP, ONCE. A representative arriving here should know before
           they read anything that none of it has reached the client. */
        UI.callout({
            tone: 'info', icon: 'shield',
            title: 'Only you can see this',
            text: 'PRUWise shortlists and compares; it does not advise. Nothing on ' +
                'this tab reaches ' + FMT.esc(c.firstName) + ' until you release it, ' +
                'and you can release one, several or none.'
        }) +

        '<div id="rec-released-state"></div>' +

        recs.map(function (rec, index) {
            var heading = index === 0
                ? UI.secHead({
                    eyebrow: 'Closest match',
                    title: 'Ranked by how well each fits the record',
                    sub: recs.length + ' options shortlisted for ' + c.name
                })
                : '';

            return '<div class="stack-4">' + heading +
                UI.aiRecCard(rec, {
                    view: 'fr',
                    ask: true,
                    actions: releaseControl(c, rec) +
                        UI.btn({
                            label: 'Add to call agenda', variant: 'ghost', size: 'sm',
                            icon: 'plus', act: 'add-agenda'
                        })
                }) + '</div>';
        }).join('') +

        /* The side-by-side comparison, behind an expander rather than a separate
           tab - it is the same three options in a different shape, and somebody
           reading one card does not need a table until they want to compare. */
        UI.expand('Compare the options side by side',
            recCompare(recs, c), { icon: 'scale' }) +

        '</div>';
}


/* The Release / Withdraw control for one recommendation.

   Rendered optimistically as "Release", then corrected by loadReleaseState() once
   the server says what has actually been released. The wrong way round would be
   to render nothing until the request lands, which leaves the card looking broken
   for a moment on every visit. */
function releaseControl(c, rec) {
    return '<span class="rec-release" data-rec="' + FMT.esc(rec.id) + '">' +
        UI.btn({
            label: 'Release to ' + FMT.esc(c.firstName), icon: 'share', size: 'sm',
            act: 'share-rec', data: { rec: rec.id }
        }) +
        '</span>';
}


/* What this client has already been shown, folded into the cards above.

   Reads /api/recommendations, which for a representative returns withdrawn rows
   too - "I showed this and took it back" is something they need to remember
   having done. */
function loadReleaseState(personId) {
    if (!$('#rec-released-state').length) { return; }

    API.recommendations.released(personId).then(

        function (data) {
            var rows = data.released || [];
            var live = rows.filter(function (r) { return !r.withdrawnAt; });

            $('#rec-released-state').html(live.length
                ? UI.callout({
                    tone: 'ok', icon: 'checkCircle',
                    title: live.length === 1
                        ? '1 recommendation has been released'
                        : live.length + ' recommendations have been released',
                    text: live.map(function (r) { return r.productName; }).join(', ') +
                        ' - visible on their side since ' + FMT.relative(live[0].at) + '.'
                })
                : '');

            /* Swap the button on any card that is already out. */
            rows.forEach(function (row) {
                var $slot = $('.rec-release[data-rec="' + row.recId + '"]');
                if (!$slot.length) { return; }

                if (row.withdrawnAt) {
                    $slot.html(UI.btn({
                        label: 'Release again', icon: 'share', size: 'sm',
                        variant: 'outline', act: 'share-rec', data: { rec: row.recId }
                    }) + '<span class="t-xs subtle">Withdrawn ' +
                        FMT.relative(row.withdrawnAt) + '</span>');
                    return;
                }

                $slot.html(
                    UI.badge('Released', 'ok') +
                    UI.btn({
                        label: 'Withdraw', variant: 'ghost', size: 'sm', icon: 'x',
                        act: 'withdraw-rec',
                        data: { rec: row.recId, person: personId }
                    })
                );
            });
        },

        function () { /* the cards already show a usable Release button */ }
    );
}


/* ==========================================================================
   WHAT PRUWISE NOTICED  -  the representative's review queue for one client

   Detail changes, support signals, follow-ups and meeting requests read out of
   chats, calls and in-person meetings. Every one carries the QUOTE that produced
   it, so it can be judged without replaying anything.

   ==========================================================================
   THE FOUR KINDS ARE PRESENTED DIFFERENTLY ON PURPOSE
   ==========================================================================

   A support signal is NOT the same sort of thing as a salary change, and showing
   them in one undifferentiated list would flatten that. So:

     detail    a before-and-after, with Confirm and "That is wrong". Confirming is
               the only thing in this app that writes to a client's record from a
               conversation.
     support   a private heads-up. Marked clearly as the representative's alone,
               with "Noted" rather than "Confirm" - there is nothing to confirm
               about how somebody might be feeling, only a decision about whether
               to raise it.
     followup  a loose end, with Done.
     meeting   a request, with a button that opens the calendar.
   ========================================================================== */

var INSIGHT_LOOK = {
    detail:   { icon: 'edit',           label: 'Detail to check' },
    support:  { icon: 'heart',          label: 'Worth knowing' },
    followup: { icon: 'clock',          label: 'Follow up' },
    meeting:  { icon: 'calendar',       label: 'Wants a meeting' },
    keypoint: { icon: 'clipboard',      label: 'From the discussion' }
};

function loadInsights(personId) {
    var $box = $('#fr-insights');
    if (!$box.length) { return; }

    API.insights.list(personId, 'open').then(

        function (data) {
            var rows = data.insights || [];

            /* Nothing noticed, nothing drawn. A permanent "PRUWise has not noticed
               anything" panel is noise on a screen somebody reads often. */
            if (!rows.length) { $box.empty(); return; }

            var cards = rows.map(function (row) {
                return insightRowCard(row, personId);
            }).join('');

            $box.html('<div class="stack-4">' +
                UI.secHead({
                    title: rows.length === 1
                        ? 'PRUWise noticed something'
                        : 'PRUWise noticed ' + rows.length + ' things',
                    sub: 'Read from your conversations. Nothing here has changed the ' +
                        'record - you decide.',
                    actions: UI.aitag('PRUWise')
                }) +
                '<div class="insight-list">' + cards + '</div>' +
                '</div>');
        },

        function () { $box.empty(); }
    );
}


/* NAMED insightRowCard, NOT insightCard.

   The dashboard render already declares a local `var insightCard` for the "AI
   insights" panel. A local only shadows inside its own function, so nothing was
   broken - but two different things called the same name in the same file is
   exactly how somebody later calls the wrong one. */
function insightRowCard(row, personId) {
    var look = INSIGHT_LOOK[row.kind] || INSIGHT_LOOK.followup;

    /* The before-and-after, for a detail that carries a value. */
    var change = (row.kind === 'detail' && row.newValue)
        ? '<div class="insight-change">' +
          '<span class="insight-was">' +
          (row.oldValue ? FMT.esc(insightValue(row.field, row.oldValue)) : 'not on file') +
          '</span>' +
          UI.icon('arrowRight', 13) +
          '<span class="insight-now">' +
          FMT.esc(insightValue(row.field, row.newValue)) + '</span>' +
          '</div>'
        : '';

    /* THE TIME PRUWISE READ OUT OF WHAT WAS SAID, shown before the button that
       books it. Nobody should have to press "Book it" to find out when it is - and
       the quote is right underneath, so the two can be compared. */
    if (row.kind === 'meeting' && row.newValue) {
        change = '<div class="insight-change">' +
            UI.icon('calendar', 13) +
            '<span class="insight-now">' + FMT.esc(FMT.friendly(row.newValue)) + '</span>' +
            '<span class="insight-was" style="text-decoration:none">30 minutes, video</span>' +
            '</div>';
    }

    /* THE EVIDENCE. Without the words that caused it, a proposal cannot be judged
       and the only safe answer is always to dismiss it. */
    var quote = row.quote
        ? '<blockquote class="insight-quote">' + UI.icon('messageCircle', 12) +
          '<span>' + FMT.esc(row.quote) + '</span></blockquote>'
        : '';

    var actions;

    if (row.kind === 'detail') {
        actions = UI.btn({
            label: row.newValue ? 'Confirm and update' : 'Noted, I will check',
            size: 'sm', icon: 'check',
            act: 'insight-decide', data: { id: row.id, action: 'confirm', person: personId }
        }) +
            UI.btn({
                label: 'That is wrong', variant: 'outline', size: 'sm', icon: 'x',
                act: 'insight-decide', data: { id: row.id, action: 'dismiss', person: personId }
            });

    } else if (row.kind === 'support') {
        /* No "confirm". There is nothing to confirm about how somebody may be
           feeling - only a decision about whether to raise it. */
        actions = UI.btn({
            label: 'Noted', size: 'sm', variant: 'soft', icon: 'check',
            act: 'insight-decide', data: { id: row.id, action: 'done', person: personId }
        }) +
            UI.btn({
                label: 'Not relevant', variant: 'ghost', size: 'sm',
                act: 'insight-decide', data: { id: row.id, action: 'dismiss', person: personId }
            });

    } else if (row.kind === 'meeting') {
        /* ONE BUTTON THAT ACTUALLY BOOKS IT, when a time could be read out of what
           was said. PRUWise finds the slot, works out the day and time, fills in
           the title and the length; a person presses the button.

           Not zero buttons. Speech recognition mishears days as readily as numbers,
           and "no, not Tuesday" is a sentence people say in the middle of agreeing
           a time - a meeting that books itself off a half-finished negotiation puts
           a wrong entry in two diaries and notifies somebody about it. See the
           reasoning beside the 'book' action in api/_routes/insights.ts.

           With no time mentioned there is nothing to book and it says so, offering
           the calendar instead of an invented Thursday. */
        actions = row.newValue
            ? UI.btn({
                label: 'Book it', size: 'sm', icon: 'calendar',
                act: 'insight-decide', data: { id: row.id, action: 'book', person: personId }
            }) +
              UI.btn({
                  label: 'Pick another time', variant: 'outline', size: 'sm',
                  href: '#/fr/calendar'
              }) +
              UI.btn({
                  label: 'Not needed', variant: 'ghost', size: 'sm',
                  act: 'insight-decide', data: { id: row.id, action: 'dismiss', person: personId }
              })

            : UI.btn({
                label: 'Open the calendar', size: 'sm', icon: 'calendar',
                href: '#/fr/calendar'
            }) +
              UI.btn({
                  label: 'Booked', variant: 'outline', size: 'sm', icon: 'check',
                  act: 'insight-decide', data: { id: row.id, action: 'done', person: personId }
              });

    } else {
        actions = UI.btn({
            label: 'Done', size: 'sm', icon: 'check',
            act: 'insight-decide', data: { id: row.id, action: 'done', person: personId }
        }) +
            UI.btn({
                label: 'Not needed', variant: 'ghost', size: 'sm',
                act: 'insight-decide', data: { id: row.id, action: 'dismiss', person: personId }
            });
    }

    return '<div class="insight-card is-' + row.kind + '" id="insight-' + row.id + '">' +

        '<div class="insight-head">' +
        '<span class="insight-icon">' + UI.icon(look.icon, 14) + '</span>' +
        '<span class="insight-kind">' + look.label + '</span>' +

        /* Says where it came from and which engine produced it, rather than
           implying more intelligence than was used. */
        '<span class="insight-src">' + FMT.esc(row.source) +
        (row.engine === 'openai' ? '' : ' \u00b7 keyword rules') + '</span>' +
        '</div>' +

        '<div class="insight-note">' + FMT.esc(row.note) + '</div>' +
        change + quote +

        (row.kind === 'support'
            ? '<div class="insight-private">' + UI.icon('lock', 11) +
              '<span>Only you can see this. It is a possibility to be aware of, ' +
              'not a conclusion - raise it if and when it feels right.</span></div>'
            : '') +

        '<div class="card-actions">' + actions + '</div>' +
        '</div>';
}


/* Money fields read as money; everything else as it was said. */
function insightValue(field, value) {
    if (field === 'annual_income') { return FMT.money(Number(value)) + ' a year'; }
    if (field === 'monthly_expenses') { return FMT.money(Number(value)) + ' a month'; }
    return String(value);
}


$(document).on('click', '[data-act="insight-decide"]', function () {
    var $btn = $(this);
    if ($btn.hasClass('is-loading')) { return; }

    var id = Number($btn.data('id'));
    var action = String($btn.data('action'));
    var personId = String($btn.data('person'));

    $btn.addClass('is-loading').prop('disabled', true);

    API.insights.decide(id, action).then(

        function (data) {
            /* Fade the card rather than redrawing the list, so the others do not
               jump while somebody is working down them. */
            $('#insight-' + id).slideUp(160, function () { $(this).remove(); });

            /* THREE DIFFERENT THINGS CAN HAVE HAPPENED, and the toast says which.
               "Noted" for all of them would be a small lie repeated every time -
               a booked meeting and a dismissed note are not the same outcome. */
            var title = 'Noted';
            var message = '';

            if (data.booked) {
                title = 'Meeting booked';
                message = 'It is in your calendar and they have been asked to accept the time.';

            } else if (data.applied) {
                title = 'Record updated';
                message = 'Their ' + String(data.applied).replace(/_/g, ' ') +
                    ' now reflects this, and they have been told.';

            } else if (action === 'dismiss') {
                title = 'Dismissed';
            }

            UI.toast({
                tone: action === 'dismiss' ? '' : 'ok',
                title: title,
                message: message
            });

            /* The overview reads the finances and the diary, so either is stale
               once one of these lands. */
            if (data.applied || data.booked) { router(); }
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            UI.toast({ tone: 'bad', title: 'That could not be saved', message: err.error });
        }
    );
});


/* The last real record read, so switching tabs redraws without a second request.

   NEEDED because UI.tabs rebuilds the active panel from scratch every time - so
   leaving Overview and coming back re-renders the FIXTURE card, and without a
   cached copy the only way to correct it again would be to re-fetch. Keyed by
   person so it cannot be applied to the wrong client after navigating. */
var FR_MONEY = null;

/* ==========================================================================
   THE CLIENT'S MONEY, FROM WHICHEVER SOURCE IS AUTHORITATIVE

   ONE BUILDER FOR BOTH SOURCES. That is the whole point of these two functions
   existing rather than the markup being written inline twice: the fixture render
   and the corrected render go through the same code, so they cannot end up
   disagreeing about what a shortfall looks like or which colour 60% is.

   `sample: true` is not decoration. It puts a visible note on the card saying the
   figures are sample data, so a representative reading it during the second it
   takes the real ones to arrive is not misled - and if the request fails, the
   note is still there and still true.
   ========================================================================== */

function clientMoneyCard(o) {
    /* Nothing to calculate from is a THIRD state, distinct from zero. Every line
       of the needs calculation derives from income, so without one there is no
       ratio and no shortfall - and "0% covered" would be a statement nobody made. */
    if (o.none) {
        return UI.card({ title: 'Protection score', icon: 'target' },
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'No figures on file yet',
                text: FMT.esc(o.firstName || 'They') + ' has not entered an income, and every ' +
                    'line of the calculation comes from it. Nothing is shown rather than a ' +
                    'row of zeros that would read like an answer.'
            })
        );
    }

    var ratio = Number(o.ratio) || 0;

    /* THE EXCLAMATION MARKER, from the same judgement the client's own screen
       uses - DATA.planWarnings(). Deliberately absent on the sample render: a
       warning derived from fixture figures would be a warning about a person who
       does not exist, and the representative has no way to tell the difference
       once it is on screen. */
    var warn = o.sample ? '' : UI.warnDot({
        warnings: DATA.planWarnings(o.needs),
        label: 'Protection score'
    });

    return UI.card({
        title: 'Protection score',
        sub: o.sample
            ? 'Sample figures - checking their record\u2026'
            : 'Cover in place against the suggested level',
        icon: 'target',
        actions: warn
    },
        CHARTS.gauge({
            value: ratio,
            label: 'of the suggested cover',
            tone: ratio >= 80 ? 'var(--ok)' : (ratio >= 55 ? 'var(--brand)' : 'var(--warn)')
        }) +
        UI.facts([
            ['Shortfall', FMT.moneyShort(o.gap)],
            o.score ? ['Protection score', o.score + '/100'] : null,
            o.updatedAt ? ['They last updated this', FMT.relative(o.updatedAt)] : null
        ].filter(Boolean)) +

        (o.sample
            ? '<div class="t-xs muted">' + UI.icon('info', 11) +
              ' From the sample profile. The real figures are being read from their record.</div>'
            : '<div class="t-xs muted">' + UI.icon('lock', 11) +
              ' Entered by them, and read-only here. Calculated by the same function ' +
              'their own dashboard uses, so you are both looking at one number.</div>')
    );
}

function clientPremiumsCard(c, budget, sample) {
    var monthly = DATA.monthlyPremium(c.id);
    var hasBudget = Number(budget) > 0;

    return UI.card({ title: 'Premiums today', icon: 'creditCard' },
        UI.kv([
            ['Monthly', FMT.money(monthly)],
            ['Yearly', FMT.money(DATA.annualPremium(c.id))],
            ['Stated budget', hasBudget
                ? FMT.money(budget) + '/mo' + (sample ? ' (sample)' : '')
                : 'Not stated']
        ]) +

        /* THE METER IS DROPPED WHEN THERE IS NO BUDGET, rather than dividing by
           zero and rendering Infinity% - which is what the old version did for
           anybody who had not answered that question. */
        (hasBudget
            ? UI.meter({
                label: 'Budget used',
                value: Math.round((monthly / budget) * 100) + '%',
                percent: (monthly / budget) * 100
            })
            : '<div class="t-xs muted">They have not said what they could put towards a ' +
              'plan, so there is nothing to measure this against.</div>')
    );
}

/* The Financial overview card on the Overview tab - the one the bug report named.

   ONE BUILDER, TWO SOURCES, same reasoning as clientMoneyCard: a fixture render
   and a real render that go through different code end up disagreeing about
   rounding, wording or which rows appear.

   `o.money` is the fixture shape (camelCase, always populated).
   `o.finances` is the server shape (camelCase too, but any field may be null).

   A NULL FIELD IS OMITTED, not shown as $0. That distinction is the whole reason
   every column in customer_finances is nullable: "they did not tell us" and "they
   told us nothing" are different facts, and a table of zeros invites the second
   reading of the first. */
function clientFinanceFactsCard(o) {
    var rows = [];

    function add(label, value, suffix) {
        if (value === null || value === undefined || value === '') { return; }
        rows.push([label, FMT.money(value) + (suffix || '')]);
    }

    if (o.sample) {
        var m = o.money;

        add('Annual income', m.annualIncome);
        add('Monthly income', m.monthlyIncome);
        add('Monthly expenses', m.monthlyExpenses);
        add('Commitments', m.monthlyCommitments);
        add('Savings', m.savings);
        add('CPF (OA)', m.cpf);
        rows.push(['Mortgage', m.mortgage ? FMT.money(m.mortgage) : 'None']);
        rows.push(['Emergency fund', m.emergencyMonths + ' months']);
        add('Premium budget', m.premiumBudget, '/mo');
        rows.push(['Retirement target', 'Age ' + m.retireAge]);

    } else {
        var f = o.finances || {};

        add('Annual income', f.annualIncome);
        add('Monthly take-home', f.monthlyIncome);
        add('Monthly expenses', f.monthlyExpenses);
        add('Commitments', f.monthlyCommitments);
        add('Savings', f.savings);
        add('CPF', f.cpf);
        add('Outstanding mortgage', f.mortgage);
        add('Other debt', f.otherDebt);
        add('Premium budget', f.premiumBudget, '/mo');

        if (f.dependants !== null && f.dependants !== undefined) {
            rows.push(['People depending on their income', String(f.dependants)]);
        }
        if (f.retireAge !== null && f.retireAge !== undefined) {
            rows.push(['Retirement target', 'Age ' + f.retireAge]);
        }

        add('Retirement income wanted', f.retireMonthlyTarget, '/mo');
        add('Life cover held elsewhere', f.existingLifeCover);
        add('Critical illness held elsewhere', f.existingCiCover);
    }

    if (!rows.length) {
        return UI.card({ title: 'Financial overview', icon: 'dollarSign' },
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'They have not entered any figures',
                text: 'Their income, savings, CPF and commitments are entered by them in ' +
                    'Settings, and only they can change them. Nothing is shown here rather ' +
                    'than a column of zeros they never gave us.'
            })
        );
    }

    return UI.card({
        title: 'Financial overview',
        sub: o.sample
            ? 'Sample figures - reading their record\u2026'
            : (o.updatedAt
                ? 'They last updated this ' + FMT.relative(o.updatedAt)
                : 'Entered by them'),
        icon: 'dollarSign'
    },
        UI.facts(rows) +

        (o.sample
            ? '<div class="t-xs muted">' + UI.icon('info', 11) +
              ' From the sample profile, while their own figures are fetched.</div>'
            : '<div class="t-xs muted">' + UI.icon('lock', 11) +
              ' Entered by the client and read-only here. If something is wrong they can ' +
              'correct it in their own settings - a figure you edited would no longer be a ' +
              'record of what they told you.</div>')
    );
}

/* Read the real record and replace both cards.

   SILENT ON FAILURE, but not silently WRONG: the cards it would have replaced say
   "sample figures" in their own subtitle, so a failed request leaves a screen that
   is still telling the truth about itself. */
function loadClientMoney(personId, c) {
    if (!$('#fr-prof-money').length) { return; }

    API.customerFinances(personId).then(

        function (data) {
            var f = data.finances || {};
            var needs = data.needs || null;
            var first = data.firstName || (c ? c.firstName : 'They');

            $('#fr-prof-money').html(clientMoneyCard(
                needs
                    ? {
                        ratio: needs.ratio,
                        gap: needs.gap,
                        updatedAt: f.updatedAt || null,

                        /* The whole needs object, not just the ratio: the marker
                           explains itself line by line and the per-line gaps and
                           reasons are what it explains itself WITH. */
                        needs: needs
                    }
                    : { none: true, firstName: first }
            ));

            if (c) {
                $('#fr-prof-premiums').html(
                    clientPremiumsCard(c, f.premiumBudget, false));
            }

            /* AND THE OVERVIEW TAB'S CARD, when that tab happens to be the one
               open. UI.tabs only builds the active panel, so this is a no-op on
               any other tab - and switching to Overview rebuilds it from the
               fixtures again, which is why loadClientMoney is called again on
               `pruwise:tab`. */
            $('#fr-prof-facts').html(clientFinanceFactsCard({
                finances: f,
                updatedAt: f.updatedAt || null
            }));

            /* Cached, so the tab handler can redraw without a second request. */
            FR_MONEY = { personId: personId, finances: f, needs: needs };

            UI.animateBars();
        },

        function () { /* the sample cards stay, and they say they are samples */ }
    );
}


/* ---- the individual profile tabs ---- */

function profileOverview(c, recs, gap, ratio) {
    var m = c.money;

    var banner = gap > 0
        ? UI.callout({
            tone: 'warn', icon: 'alertTriangle',
            title: FMT.moneyShort(gap) + ' below the suggested cover',
            text: 'Cover currently sits at ' + ratio + '% of what the needs calculation suggests for this profile. ' +
                'The Coverage tab breaks it down line by line.'
        })
        : UI.callout({
            tone: 'ok', title: 'Cover meets the suggested level',
            text: 'No material protection shortfall on the current record.'
        });

    /* THE CARD THE BUG REPORT WAS ABOUT.

       "The financial details are changed in the customer page but not in the
       financial representative page financial overview of client" - and this is
       the financial overview of the client. It read c.money, the fixtures, so a
       client who corrected their income in Settings changed nothing here.

       An empty container now, filled by loadClientFinanceFacts() from
       /api/finances?personId= - the one place these figures actually live, and the
       same endpoint the client's own screen reads. The sample values are drawn
       first, LABELLED AS SAMPLE, so the card is never blank and never quietly
       wrong. */
    var finances = '<div id="fr-prof-facts">' +
        clientFinanceFactsCard({ money: m, sample: true }) +
        '</div>';

    var goals = UI.card({ title: 'Goals', sub: 'What the client said they want', icon: 'target' },
        '<div class="stack-4">' + c.goals.map(function (g) {
            return '<div class="row top"><span class="card-icon">' + UI.icon('compass', 15) + '</span>' +
                '<div style="min-width:0"><div class="t-sm semi">' + FMT.esc(g.label) + '</div>' +
                '<div class="t-xs muted">Priority: ' + g.priority + ' | Horizon: ' + g.horizon + '</div></div></div>';
        }).join('') + '</div>'
    );

    var concerns = UI.card({ title: 'Stated concerns', icon: 'messageCircle' },
        '<div class="stack-2">' + c.concerns.map(function (x) {
            return '<span class="tick warn">' + UI.icon('alertCircle', 13) + '<span class="t-sm">' + FMT.esc(x) + '</span></span>';
        }).join('') + '</div>'
    );

    var events = UI.card({ title: 'Recent life events', icon: 'activity' },
        (c.lifeEvents && c.lifeEvents.length)
            ? UI.timeline(c.lifeEvents.map(function (e) { return { title: e.label, time: e.date, icon: 'zap' }; }))
            : '<div class="t-sm muted">No recorded life events since the last review.</div>'
    );

    var shortlist = recs.length
        ? '<div class="stack-4">' +
        UI.secHead({
            title: 'Shortlisted recommendations',
            sub: 'Generated from this profile',
            actions: UI.btn({ label: 'Open comparison', variant: 'outline', size: 'sm', icon: 'scale', href: '#/fr/recommendations?tab=compare' })
        }) +
        '<div class="grid grid-lg">' + recs.map(function (r) { return UI.recSummaryCard(r); }).join('') + '</div>' +
        '</div>'
        : '';

    var talking = UI.card({ title: 'Talking points', sub: 'AI-prepared for your next conversation', icon: 'sparkles', actions: UI.aitag('AI generated') },
        '<div class="stack-3">' + c.talkingPoints.map(function (p, i) {
            return UI.talkpoint({ text: p, num: String(i + 1) });
        }).join('') + '</div>' +
        UI.btn({
            label: 'Discuss with PRUWise', variant: 'soft', size: 'sm', icon: 'sparkles',
            act: 'customer-navigator', data: { id: c.id }
        })
    );

    return '<div class="stack">' + banner + finances + goals +
        '<div class="grid grid-md">' + concerns + events + '</div>' +
        shortlist + talking + '</div>';
}

function profileCoverage(c, policies) {
    var lines = DATA.numericCoverage(c);
    var hospital = c.coverage.hospital;
    var shieldPolicy = policies.filter(function (p) { return p.category === 'Hospitalisation'; })[0];

    var breakdown = lines.map(function (line) {
        var summary = line.gap > 0 ? FMT.moneyShort(line.gap) + ' short' : 'adequate';
        var icon = line.gap > 0 ? 'alertTriangle' : 'checkCircle';

        return UI.expand(line.label + ' - ' + summary,
            UI.kv([
                ['In place', FMT.money(line.current) + (line.monthly ? '/mo' : '')],
                ['Suggested', FMT.money(line.recommended) + (line.monthly ? '/mo' : '')],
                ['Shortfall', FMT.money(line.gap) + (line.monthly ? '/mo' : '')]
            ]) +
            UI.progress(line.recommended ? (line.current / line.recommended) * 100 : 100, { thin: true }),
            { icon: icon });
    }).join('');

    var hospitalRow = UI.expand(hospital.label + ' - ' + hospital.text,
        '<div class="t-sm">This cover is described in words rather than a dollar amount: ' +
        FMT.esc(hospital.text) + '. Provided by ' +
        FMT.esc(shieldPolicy ? shieldPolicy.name : 'the hospitalisation plan') + '.</div>',
        { icon: 'shield' });

    return '<div class="stack">' +
        UI.card({
            title: 'Coverage against the suggested level',
            sub: 'The solid bar is cover in force. The dashed outline is what the calculation suggests.',
            icon: 'shield'
        }, UI.coverageBars(c)) +
        UI.card({ title: 'Line by line', icon: 'layers' },
            '<div class="stack-3">' + breakdown + hospitalRow + '</div>') +
        '</div>';
}

function profilePlans(c, policies) {
    if (!policies.length) {
        return UI.emptyState({
            icon: 'fileText',
            title: 'No policies on file',
            text: 'This client has no in-force policies in the demo data set.'
        });
    }

    var oldest = policies.map(function (p) { return p.start; }).sort()[0];

    return '<div class="stack">' +
        UI.card({ cls: 'card-inset' }, UI.facts([
            ['Policies', String(policies.length)],
            ['Monthly premium', FMT.money(DATA.monthlyPremium(c.id))],
            ['Yearly premium', FMT.money(DATA.annualPremium(c.id))],
            ['Oldest policy', FMT.dateLong(oldest)]
        ])) +
        '<div class="grid grid-lg stagger">' +
        policies.map(function (p) { return UI.policyCard(p); }).join('') +
        '</div></div>';
}

function profileMeetings(c) {
    var upcoming = DATA.apptsFor(c.id).filter(function (a) { return a.status !== 'completed'; });
    var past = DATA.pastApptsFor(c.id);

    var upcomingHtml = upcoming.length
        ? '<div class="stack-4">' + upcoming.map(function (a) {
            return UI.apptCard(a, { view: 'fr', agenda: true, join: true });
        }).join('') + '</div>'
        : UI.emptyState({
            icon: 'calendar',
            title: 'No upcoming appointments',
            text: 'Last contact was ' + FMT.relative(c.lastContact) + '. Booking a review would be the natural next step.',
            actions: UI.btn({ label: 'Start an AI-assisted call', icon: 'video', act: 'start-call', data: { id: c.id } })
        });

    var historyHtml = past.length
        ? '<div class="stack-4">' +
        UI.secHead({ title: 'History', sub: past.length + ' completed meetings' }) +
        UI.card({}, UI.timeline(past.map(function (a) {
            return {
                title: a.title,
                text: a.type + ' | ' + (a.notes || 'No notes recorded.'),
                time: a.start,
                icon: a.mode === 'video' ? 'video' : (a.mode === 'phone' ? 'phone' : 'mapPin')
            };
        }))) + '</div>'
        : '';

    return '<div class="stack">' +
        '<div class="stack-4">' +
        UI.secHead({ title: 'Upcoming', sub: upcoming.length ? upcoming.length + ' scheduled' : 'Nothing scheduled' }) +
        upcomingHtml + '</div>' + historyHtml + '</div>';
}

function profileRecord(c) {
    var items = DATA.activity.filter(function (a) { return a.customerId === c.id; });

    return '<div class="stack">' +
        UI.card({ title: 'Activity on this profile', icon: 'activity' },
            items.length ? UI.timeline(items) : '<div class="t-sm muted">No recent activity recorded.</div>') +
        UI.card({ title: 'Record keeping', sub: 'What was captured, and when', icon: 'clipboard' },
            UI.kv([
                ['Client since', FMT.dateLong(c.clientSince)],
                ['Last contact', FMT.dateLong(c.lastContact) + ' (' + FMT.relative(c.lastContact) + ')'],
                ['Last full review', FMT.dateLong(c.lastReview) + ' (' + FMT.relative(c.lastReview) + ')'],
                ['Risk profile', c.riskProfile + ' (' + c.riskScore + '/100)'],
                ['Email', c.email],
                ['Phone', c.phone],
                ['Location', c.location]
            ])) +
        '</div>';
}


/* ==========================================================================
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
    sub: 'Now on the client\u2019s own record',

    render: function () {
        return UI.loadingState('Opening the client\u2019s recommendations\u2026');
    },

    after: function (ctx) {
        /* ?rec=rec-cus-001-prd-active names a client in the middle of it, so an
           incoming deep link lands on the right person rather than on whoever was
           last active. */
        var fromLink = ctx.query.rec ? DATA.recById(ctx.query.rec) : null;

        /* ?person=cus-001 IS THE SIMPLER FORM, and it is what the notifications
           use: "Sarah has entered her financial details" has to be able to send
           somebody to Sarah's recommendations and not to whoever they last looked
           at. It takes precedence over the remembered active client for exactly
           that reason - a link that lands on the wrong person is worse than no
           link. */
        var personId = ctx.query.person
            || (fromLink && fromLink.customerId)
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



function recShortlist(recs, c, focusId) {
    // If we arrived via ?rec=..., show that one first
    var ordered = recs.slice();
    if (focusId) {
        ordered.sort(function (a, b) {
            return (a.id === focusId) ? -1 : ((b.id === focusId) ? 1 : 0);
        });
    }

    var intro = UI.callout({
        tone: 'brand', icon: 'sparkles',
        title: 'How this shortlist was built',
        text: 'Income, dependants, debts, existing cover, stated goals and the ' +
            FMT.money(c.money.premiumBudget) + ' monthly budget on file were compared against the product range. ' +
            'Options are ranked by fit, not by premium.'
    });

    var cards = ordered.map(function (rec, index) {
        var heading = '';
        if (index === 0) {
            heading = UI.secHead({ title: 'Primary recommendation', sub: 'Best overall match for this profile' });
        } else if (index === 1) {
            heading = UI.secHead({ title: 'Alternatives', sub: 'Worth presenting so the choice is informed' });
        }

        return '<div class="stack-4">' + heading +
            UI.aiRecCard(rec, {
                view: 'fr',
                ask: true,
                actions: UI.btn({ label: 'Share with client', icon: 'share', size: 'sm', act: 'share-rec' }) +
                    UI.btn({ label: 'Add to call agenda', variant: 'ghost', size: 'sm', icon: 'plus', act: 'add-agenda' })
            }) + '</div>';
    }).join('');

    return '<div class="stack">' + intro + cards + '</div>';
}

function recCompare(recs, c) {
    /* The attributes we compare. `best` marks rows where a bigger number is
       better, so we can highlight the strongest value. */
    var rows = [
        { key: 'Category', get: function (r) { return r.product.category; } },
        { key: 'Cover', get: function (r) { return r.coverLabel; }, best: function (r) { return r.cover || 0; } },
        { key: 'Estimated premium', get: function (r) { return r.premiumLabel; } },
        { key: 'Term', get: function (r) { return r.term; } },
        { key: 'Payout', get: function (r) { return r.product.payout; } },
        { key: 'AI fit score', get: function (r) { return r.fit + '/100'; }, best: function (r) { return r.fit; } },
        {
            /* Kept as an explicit list rather than inferred from the category
               string, because "does this give me anything back" is a factual
               question about each plan and getting it wrong in a comparison table
               is worse than not having the row. Every savings plan belongs here;
               term life, standalone CI, disability income and hospitalisation do
               not, because they all return nothing if nothing happens. */
            key: 'Builds cash value', get: function (r) {
                return ['prd-save', 'prd-flexi', 'prd-legacy',
                        'prd-growth', 'prd-edu', 'prd-retire']
                    .indexOf(r.productId) !== -1 ? 'Yes' : 'No';
            }
        },
        { key: 'Best suited to', get: function (r) { return r.product.bestFor.slice(0, 2).join(', '); } }
    ];

    var intro = UI.callout({
        tone: 'info', icon: 'scale',
        title: 'How to read this comparison',
        text: 'Highlighted cells are the strongest value on that row, which is not the same as the best choice. ' +
            'Premium, term and payout structure all need weighing against what the client actually needs.'
    });

    /* --- one card per option (the main view on phones and tablets) --- */
    var columns = '<div class="compare-grid">' + recs.map(function (rec) {
        return '<div class="card card-pad compare-col' + (rec.isTop ? ' is-best' : '') + '">' +
            (rec.isTop ? '<span class="badge badge-solid compare-flag">AI recommended</span>' : '') +
            '<div class="stack-4" style="margin-top:' + (rec.isTop ? '8px' : '0') + '">' +
            '<div class="between">' + UI.aitag('Fit ' + rec.fit) + UI.badge(rec.product.category, 'line') + '</div>' +
            '<div class="h5">' + FMT.esc(rec.product.name) + '</div>' +
            '<div class="t-xs muted">' + FMT.esc(rec.product.tagline) + '</div>' +
            UI.facts([['Cover', rec.coverLabel], ['Premium', rec.premiumLabel]]) +
            '<div>' + rows.map(function (row) {
                return '<div class="compare-row"><span class="k">' + row.key + '</span>' +
                    '<span class="v">' + FMT.esc(row.get(rec)) + '</span></div>';
            }).join('') + '</div>' +
            UI.expand('Estimated benefits',
                rec.benefits.map(function (b) {
                    return '<div class="compare-row"><span class="k">' + FMT.esc(b.label) + '</span>' +
                        '<span class="v">' + FMT.esc(b.value) + '</span></div>';
                }).join(''), { icon: 'checkCircle' }) +
            UI.expand('Trade-offs',
                '<div class="stack-2">' + rec.considerations.map(function (x) {
                    return '<div class="t-xs muted"><strong>' + FMT.esc(x.title) + '</strong> - ' + FMT.esc(x.text) + '</div>';
                }).join('') + '</div>', { icon: 'alertTriangle' }) +
            UI.btn({
                label: 'View full recommendation',
                variant: rec.isTop ? 'primary' : 'outline',
                size: 'sm', block: true,
                href: '#/fr/recommendations?rec=' + rec.id
            }) +
            '</div></div>';
    }).join('') + '</div>';

    /* --- the full matrix table (richer on a big screen) --- */
    var matrixRows = rows.map(function (row) {
        var best = null;
        if (row.best) {
            best = Math.max.apply(null, recs.map(function (r) { return row.best(r) || 0; }));
        }

        var record = { attribute: row.key };
        recs.forEach(function (rec, i) {
            var value = String(row.get(rec));
            var isBest = (best !== null && row.best(rec) === best);
            record['opt' + i] = isBest ? '<span class="cell-best">' + FMT.esc(value) + '</span>' : FMT.esc(value);
        });
        return record;
    });

    var matrixColumns = [{
        label: 'Attribute', key: 'attribute',
        render: function (r) { return '<span class="semi">' + FMT.esc(r.attribute) + '</span>'; }
    }].concat(recs.map(function (rec, i) {
        return {
            label: rec.product.name, key: 'opt' + i,
            render: function (r) { return r['opt' + i]; }
        };
    }));

    var matrix = UI.card({ title: 'Full comparison matrix', sub: 'Every attribute, side by side', icon: 'scale' },
        UI.table({ caption: 'Recommendation comparison', rows: matrixRows, columns: matrixColumns })
    );

    var lead = UI.card({ title: 'What the AI would lead with', sub: 'For ' + c.firstName, icon: 'sparkles', actions: UI.aitag('AI generated') },
        '<div class="t-sm">' + FMT.esc(recs[0].product.name + ' first, because ' +
            recs[0].whyFits.charAt(0).toLowerCase() + recs[0].whyFits.slice(1)) + '</div>' +
        (recs[1]
            ? '<div class="t-sm muted">Present ' + FMT.esc(recs[1].product.name) + ' as the deliberate alternative ' +
            'rather than a fallback: ' + FMT.esc(recs[1].whyFits.charAt(0).toLowerCase() + recs[1].whyFits.slice(1)) + '</div>'
            : '') +
        UI.disclaimer('long')
    );

    return '<div class="stack">' + intro + columns + matrix + lead + '</div>';
}

function recLibrary() {
    return '<div class="stack">' +
        UI.secHead({ title: 'Product library', sub: 'The full range available for recommendations' }) +
        '<div class="grid grid-lg stagger">' + DATA.products.map(function (p) {
            return UI.card({ hover: true },
                '<div class="between">' +
                '<span class="card-icon">' + UI.icon(p.icon, 17) + '</span>' +
                (p.badge ? UI.badge(p.badge, 'brand') : '') + '</div>' +
                '<div class="stack-2" style="gap:2px">' +
                '<div class="card-title">' + FMT.esc(p.name) + '</div>' +
                '<div class="t-xs subtle">' + FMT.esc(p.category) + '</div></div>' +
                '<div class="t-sm muted">' + FMT.esc(p.tagline) + '</div>' +
                UI.facts([
                    ['Cover from', p.coverFrom ? FMT.money(p.coverFrom) : 'As charged'],
                    ['Premium from', FMT.money(p.premiumFrom) + '/mo']
                ]) +
                UI.expand('Features and considerations',
                    '<div class="stack-2"><span class="eyebrow">Features</span>' +
                    p.features.map(function (f) {
                        return '<span class="tick">' + UI.icon('check', 12) + '<span>' + FMT.esc(f) + '</span></span>';
                    }).join('') +
                    '<span class="eyebrow" style="margin-top:8px">Considerations</span>' +
                    p.considerations.map(function (x) {
                        return '<span class="tick warn">' + UI.icon('alertCircle', 12) + '<span>' + FMT.esc(x) + '</span></span>';
                    }).join('') + '</div>', { icon: 'fileText' }) +
                '<div class="chips">' + p.bestFor.map(function (t) { return UI.badge(t); }).join('') + '</div>'
            );
        }).join('') + '</div></div>';
}


/* ==========================================================================
   AI-ASSISTED VIDEO CALL

   The video area, the clock and the webcam all live in js/call.js, because the
   customer side (/me/call) uses exactly the same ones. Only the side panel is
   specific to the representative.
   ========================================================================== */
PAGES['/fr/call'] = {
    title: 'Video consultation',
    sub: 'PRUWise helping while you talk',
    flush: true,

    render: function () {
        var c = DATA.getCustomer(STATE.activeCustomerId) || DATA.customers[0];
        var rep = DATA.getRep(c.repId);
        var rec = DATA.topRec(c.id);

        /* ------------------------------------------------- video area */
        var stage = CALL.stage({
            peerName: c.name,
            peerSeed: c.id,
            selfName: 'You',
            selfSeed: rep.id,
            controls: CALL.micButton() + CALL.camButton() + CALL.ccButton() +
                CALL.pinButton() +
                CALL.shareButton() +
                CALL.control({ act: 'call-notes', icon: 'edit', aria: 'Jump to notes' }) +
                CALL.panelButton() +
                CALL.endButton({ act: 'call-end' })
        });

        /* ------------------------------------------ AI assistance panel */
        var points = AI.callPoints(c);

        var tabs = UI.tabs('call', [
            {
                id: 'points', label: 'Talking points', icon: 'sparkles',
                render: function () {
                    return '<div class="stack-4">' +
                        UI.callout({
                            tone: 'brand', icon: 'sparkles', title: 'AI prepared this agenda',
                            text: 'Tap a point to tick it off as you cover it. Nothing here is a script.'
                        }) +
                        '<div class="stack-2">' + points.map(function (p) {
                            return UI.talkpoint({
                                text: p.text, check: true,
                                done: STATE.donePoints.indexOf(p.id) !== -1,
                                act: 'call-point', data: { id: p.id }
                            });
                        }).join('') + '</div>' +
                        '<div class="stack-2"><span class="eyebrow">Live nudges</span>' +
                        AI.nudges.map(function (n) { return UI.insight(n); }).join('') + '</div>' +
                        '</div>';
                }
            },
            {
                id: 'customer', label: 'Client', icon: 'user',
                render: function () {
                    return '<div class="stack-4">' +
                        UI.person({ name: c.name, meta: c.age + ' | ' + c.occupation, size: 'lg', seed: c.id }) +
                        UI.kv([
                            ['Segment', c.segment],
                            ['Risk profile', c.riskProfile + ' (' + c.riskScore + '/100)'],
                            ['Dependants', c.dependantDetail],
                            ['Monthly premium', FMT.money(DATA.monthlyPremium(c.id))],
                            ['Budget', FMT.money(c.money.premiumBudget) + '/mo'],
                            ['Shortfall', FMT.moneyShort(DATA.coverageGap(c))]
                        ]) +

                        /* ==============================================
                           WHAT THEY ALREADY HOLD, DURING THE CALL

                           REQUESTED: "in the client section of the column on the
                           right we can also include the 2 plans the client
                           currently has."

                           It is the question that comes up most in a live
                           conversation - "what have I already got" - and before
                           this the answer meant leaving the call to open their
                           profile. Which, until the dock existed, ended the call.

                           Empty until loadCallPlans() fills it from
                           /api/policies, the SAME endpoint their own My plans
                           screen reads. Not DATA.policiesFor(), which is the
                           fixtures and cannot see a policy that was actually
                           issued - the mistake that made home and plans disagree
                           about the premium two rounds ago.
                           ============================================== */
                        '<div id="call-plans">' +
                        UI.loadingState('Reading their plans\u2026') +
                        '</div>' +

                        UI.coverageBars(c) +
                        '<div class="stack-2"><span class="eyebrow">Stated concerns</span>' +
                        c.concerns.map(function (x) {
                            return '<span class="tick warn">' + UI.icon('alertCircle', 12) +
                                '<span class="t-xs">' + FMT.esc(x) + '</span></span>';
                        }).join('') + '</div>' +
                        '</div>';
                }
            },
            {
                id: 'rec', label: 'Recommendation', icon: 'fileText',
                render: function () {
                    return rec
                        ? UI.aiRecCard(rec, { view: 'fr', compact: true, showNeeds: false })
                        : UI.emptyState({ icon: 'fileText', title: 'No recommendation prepared', plain: true });
                }
            },
            {
                id: 'notes', label: 'Notes', icon: 'edit',
                render: function () {
                    /* THE TRANSCRIPT IS NOT HERE ANY MORE.

                       It used to be duplicated in this panel, which meant two
                       copies of the same growing list to keep in step, and two
                       places to look for it. It now lives in one place: tap the
                       caption bar under the video and it expands to show
                       everything said so far.

                       This panel keeps the notes you type, and a pointer to where
                       the transcript went. */
                    var whereItWent = UI.callout({
                        tone: 'info', icon: 'messageSquare',
                        title: 'Looking for the transcript?',
                        text: 'Tap the caption bar under the video. It opens out into everything ' +
                            'said so far, with a name against every line, and a button to copy it here.'
                    });

                    /* ==============================================
                       WHAT HAS ALREADY BEEN COVERED

                       REQUESTED: the assistant's suggestions "can check it
                       off and it will serve as log as what have already been
                       asked".

                       Crossing a post-it out on the video writes it here, and
                       STATE.callCovered keeps it, so it survives navigating
                       away mid-call and a refresh. Filled by
                       CALL.renderCovered() - see the note where that is
                       exported.
                       ============================================== */
                    var covered = UI.card({
                        title: 'Covered so far',
                        icon: 'checkCircle',

                        /* subId, not raw HTML: UI.card already supports naming the
                           subtitle so a live counter can be written into it without
                           redrawing the card. */
                        sub: 'Nothing yet',
                        subId: 'call-covered-count'
                    }, '<div id="call-covered"></div>');

                    return '<div class="stack-4">' +
                        covered +
                        whereItWent +
                        '<div class="field"><label class="field-label" for="call-notes">Live notes</label>' +
                        '<textarea class="textarea" id="call-notes" style="min-height:160px" ' +
                        'placeholder="Type as you talk. Notes save automatically.">' +
                        FMT.esc(STATE.callNotes) + '</textarea>' +
                        '<div class="field-hint" id="notes-status">Saved automatically to this device.</div></div>' +
                        UI.btn({ label: 'Save to client record', icon: 'check', size: 'sm', act: 'call-save-notes' }) +
                        '</div>';
                }
            },

            /* --- past calls ----------------------------------------------

               "When did we last speak, and for how long." Filled in by
               CALL.renderHistory() in after(), because it needs a request. */
            {
                id: 'history', label: 'Past calls', icon: 'clock',
                render: function () {
                    return '<div id="fr-callog"></div>';
                }
            }
        ]);

        return '<div class="call">' + stage + CALL.rail(tabs) + '</div>';
    },

    /* Asks for the camera and microphone, then joins the room on the server so
       the customer's browser can find us.

       Two different ids, doing two different jobs:
         withPerson  WHO WE ARE CALLING. Checked on the server against
                     people.rep_id, so naming somebody else's customer is
                     refused rather than connected.
         customerId  who the live assistant should read about. The same person
                     here, but it is the mock record in js/data.js rather than a
                     real account, so it stays a separate argument.

       See js/call.js. */
    after: function () {

        /* ------------------------------------------------------------------
           WHO ARE WE ACTUALLY CALLING?

           This used to read STATE.activeCustomerId out of js/data.js and fall
           back to DATA.customers[0]. That worked for the six seeded customers
           and silently broke for everybody else: a representative ringing a
           self-registered customer would place the call to Sarah Tan instead,
           because the real person is not in the mock list. The customer sat
           waiting for a call that was never aimed at them.

           So the list of who can be called comes from the SERVER - the same
           `people` array the calendar uses, which is that representative's real
           customers. Mock data does not get a say in who exists.
           ------------------------------------------------------------------ */
        /* PAST CALLS FIRST, AND ON ITS OWN.

           This used to be the last line of the success branch below, which meant
           the history only appeared if the call itself could start. A
           representative with nobody assigned yet, or one whose appointments
           request happened to fail, got a "Past calls" tab that was permanently
           blank with no explanation - even though their history had nothing to do
           with either of those things.

           Looking up who you spoke to last week does not require a camera, a
           customer to call, or a room. So it runs first and unconditionally, the
           same way the customer side does it. */
        CALL.renderHistory('#fr-callog');

        /* What they already hold. Independent of whether the call connects, for
           the same reason as the history above - "what has she got" is worth
           answering even if the camera never starts. */
        loadCallPlans(STATE.activeCustomerId);

        API.appointments(gmdateToday(), gmdateToday()).then(

            function (data) {
                var mine = data.people || [];

                if (!mine.length) {
                    $('.call-stage').replaceWith(UI.emptyState({
                        icon: 'userX',
                        title: 'No clients to call yet',
                        text: 'Once a client is assigned to you, you can start a video ' +
                            'consultation with them from here. Your past calls are still in ' +
                            'the Past calls tab.'
                    }));
                    return;
                }

                /* Prefer whoever is being worked on, if they are genuinely one of
                   this representative's customers. Otherwise the first real one. */
                var targetId = null;

                for (var i = 0; i < mine.length; i++) {
                    if (mine[i].personId === STATE.activeCustomerId) { targetId = mine[i].personId; }
                }
                if (!targetId) { targetId = mine[0].personId; }

                /* Mock record if there is one, purely for the summary screen's
                   figures. The CALL itself uses the real person id. */
                var mock = DATA.getCustomer(targetId);
                var appt = mock ? DATA.nextApptFor(mock.id) : null;

                CALL.begin({
                    view: 'fr',
                    customerId: targetId,
                    withPerson: targetId,
                    appointmentId: appt ? appt.id : null,

                    // They hung up first. Show the same summary rather than nothing.
                    onRemoteEnd: function () {
                        showCallSummary(mock || DATA.customers[0]);
                    }
                });
            },

            function (err) {
                $('.call-stage').replaceWith(UI.errorState({
                    title: 'Could not start the call',
                    text: err.error
                }));
            }
        );
    }
};

/* Today as YYYY-MM-DD. The appointments endpoint wants a range, and we only want
   the `people` list that comes back with it, so the narrowest range possible
   keeps the query cheap. */
function gmdateToday() { return FMT.sgDayKey(new Date()); }


/* ==========================================================================
   TRENDS  -  the third tab of the dashboard

   This was PAGES['/fr/analytics'], its own entry in the sidebar. It is a panel
   now, for one reason: NOTHING ON IT IS AN ACTION. It is all context for the book
   the representative is already looking at, and giving it a nav entry made it
   feel like somewhere you were supposed to go and check.

   The content is unchanged apart from the four statistic cards at the top, which
   went for the reasons written above UI.workTile.

   Returns HTML, so UI.tabs only builds it when somebody opens the tab - which
   also means none of these charts cost anything on a normal dashboard visit.
   ========================================================================== */
function analyticsPanel() {
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


/* ==========================================================================
   CLICK HANDLERS for the FR pages
   Registered once, right here, using the same delegation pattern as app.js.
   ========================================================================== */
$(function () {

    /* ==================================================================
       A NEWLY BUILT TAB PANEL MAY NEED WHAT THE PAGE ALREADY KNOWS

       UI.tabs renders only the ACTIVE panel, so anything after() filled inside a
       different tab is not in the DOM - and switching to that tab builds it from
       scratch, undoing the correction. Both cases below are that same problem.

       Everything here reads from a CACHE. Opening a tab three times is still one
       request.
       ================================================================== */
    $(document).on('pruwise:tab', function (e, setId, tabId) {
        if (setId === 'frdash' && tabId === 'book') {
            frBook(function (rows) { drawDashPriority(rows); });
            return;
        }

        /* The Overview tab's Financial overview card. Rebuilt from the fixtures by
           the tab switch, so the real figures have to be put back. */
        if (setId === 'profile' && tabId === 'overview') {
            if (FR_MONEY && FR_MONEY.personId === STATE.activeCustomerId) {
                $('#fr-prof-facts').html(clientFinanceFactsCard({
                    finances: FR_MONEY.finances,
                    updatedAt: FR_MONEY.finances.updatedAt || null
                }));
                UI.animateBars();
            }
            return;
        }

        /* The call screen's Notes tab carries the covered-topics log. Same reason
           as the card above: the panel does not exist until this tab is the active
           one, so it has to be filled after the switch rather than once. */
        if (setId === 'call' && tabId === 'notes' && window.CALL && CALL.renderCovered) {
            CALL.renderCovered();
        }
    });

    /* ---- client list ----

       The cards/table toggle handler has gone with the toggle. See the note above
       the toolbar in PAGES['/fr/customers']. */

    // "input" fires on every keystroke, including paste and backspace
    $(document).on('input', '#cust-search', function () {
        custQuery = $(this).val();
        renderClientResults();
    });

    $(document).on('click', '[data-act="cust-filter"]', function () {
        custFilter = $(this).data('filter');
        $('[data-act="cust-filter"]').removeClass('is-on').attr('aria-pressed', 'false');
        $(this).addClass('is-on').attr('aria-pressed', 'true');
        renderClientResults();
    });

    $(document).on('click', '[data-act="cust-clear"]', function () {
        custQuery = '';
        custFilter = 'all';
        $('#cust-search').val('');
        $('[data-act="cust-filter"]').removeClass('is-on');
        $('[data-act="cust-filter"][data-filter="all"]').addClass('is-on');
        renderClientResults();
    });

    $(document).on('click', '[data-act="add-agenda"]', function () {
        UI.toast({ title: 'Added to the call agenda', tone: 'ok' });
    });


    /* ---- video call ----
       The microphone, camera and screen-share buttons are handled once in
       js/call.js, because the customer side uses the same ones. What is left
       here is only what belongs to the representative. */

    $(document).on('click', '[data-act="call-notes"]', function () {
        CALL.openPanel();          // on a phone the panel starts closed
        UI.switchTab('call', 'notes');
        window.setTimeout(function () { $('#call-notes').trigger('focus'); }, 60);
    });

    /* Copy the transcript into the notes box. Appended rather than replacing,
       so anything already typed survives. */
    $(document).on('click', '[data-act="call-transcript-to-notes"]', function () {
        var transcript = CALL.transcriptText();

        if (!transcript) {
            UI.toast({
                title: 'Nothing transcribed yet',
                message: 'Turn on live captions with the speech button under the video.',
                tone: 'info'
            });
            return;
        }

        var existing = STATE.callNotes ? STATE.callNotes + '\n\n' : '';
        STATE.callNotes = existing + transcript;
        saveState();

        $('#call-notes').val(STATE.callNotes);
        UI.toast({ title: 'Transcript added to your notes', tone: 'ok' });
    });

    // Tick a talking point off
    $(document).on('click', '[data-act="call-point"]', function () {
        var id = $(this).data('id');
        var index = STATE.donePoints.indexOf(id);

        if (index === -1) { STATE.donePoints.push(id); }
        else { STATE.donePoints.splice(index, 1); }

        $(this).toggleClass('done', index === -1);
    });

    // Save notes as they are typed
    $(document).on('input', '#call-notes', function () {
        STATE.callNotes = $(this).val();
        saveState();
        $('#notes-status').text('Saved at ' + FMT.time(new Date()));
    });

    $(document).on('click', '[data-act="call-save-notes"]', function () {
        UI.toast({ title: 'Notes saved to the client record', tone: 'ok' });
    });

    $(document).on('click', '[data-act="call-end"]', function () {
        showCallSummary(DATA.getCustomer(STATE.activeCustomerId) || DATA.customers[0]);
    });
});


/* Closes the call and shows what came out of it.

   CALL.finish() returns a PROMISE now, because the duration comes back from the
   server. Our own clock has been running since the page opened, which is not the
   same thing as the time the two of them were actually connected - and it is a
   number that whoever is holding the keyboard could change. See
   php/api/call-end.php.

   Also called when the CUSTOMER hangs up first, from the onRemoteEnd hook, so
   the representative gets the same summary either way. */
function showCallSummary(c) {

    /* Grabbed BEFORE finish(), because that is what identifies the call we are
       about to summarise. finish() leaves it in place deliberately, but reading
       it first means this does not depend on that staying true. */
    var roomCode = CALL.roomCode ? CALL.roomCode() : null;

    CALL.finish().then(function (ended) {

        /* The shell of the modal goes up immediately with the facts we already
           know, and the draft drops in when the server answers.

           WHY NOT WAIT: the representative has just pressed End Call and is
           looking at a video of nobody. A blank screen for a second reads as a
           crash, and the duration and line count are already in hand. */
        UI.openModal({
            title: 'Call ended',
            sub: 'Review the follow-up before it goes',
            size: 'lg',
            body: UI.kv([
                ['Client', c.name],
                ['Talking time', ended.text],
                ['Transcript', ended.lines
                    ? ended.lines + (ended.lines === 1 ? ' line captured' : ' lines captured')
                    : 'Captions were off']
            ]) +
                '<div id="cs-body" style="margin-top:var(--sp-4)">' +
                UI.loadingState('Reading the transcript\u2026') +
                '</div>',

            /* Three ways out, because a representative whose customer has just
               hung up needs somewhere to go - not only a Send button. Previously
               the only options were "Skip for now" and sending the summary, which
               left them sitting on a dead call screen. */
            foot: UI.btn({ label: 'Back to dashboard', variant: 'ghost', icon: 'home',
                           href: '#/fr/dashboard', act: 'close-modal' }) +
                UI.btn({ label: 'Message ' + String(c.firstName || c.name).split(' ')[0],
                         variant: 'outline', icon: 'messageCircle',
                         href: '#/fr/messages', act: 'close-modal' }) +
                '<span id="cs-send"></span>'
        });

        /* No captions means no transcript means nothing to summarise. Say so
           plainly rather than sending a request that can only come back empty. */
        if (!roomCode || !ended.lines) {
            $('#cs-body').html(UI.callout({
                tone: 'info', icon: 'info',
                title: 'No transcript to summarise',
                text: 'Live captions were off, so there is nothing to read back. Turn them on ' +
                    'during the next call and PRUWise will draft the follow-up for you.'
            }));
            return;
        }

        API.callSummary(roomCode).then(

            function (data) {
                var s = data.summary;

                /* The draft in a textarea, not a read-only panel. The whole point
                   is that it can be corrected before it is sent - speech
                   recognition mis-hears, and a wrong summary in writing is worse
                   than none. */
                $('#cs-body').html(
                    (s.triggerIds && s.triggerIds.length
                        ? '<div class="cs-found">' +
                          '<span class="cs-found-tag">' + UI.icon('sparkles', 13) +
                          '<span>PRUWise picked up ' + s.triggerIds.length +
                          (s.triggerIds.length === 1 ? ' thing' : ' things') + '</span></span>' +
                          '</div>'
                        : '') +

                    (data.alreadySent
                        ? UI.callout({
                            tone: 'warn', icon: 'alertTriangle',
                            title: 'A summary was already sent for this meeting',
                            text: 'Sending again replaces your note and posts a second message. ' +
                                'That is fine for a correction.'
                        })
                        : '') +

                    '<div class="field">' +
                    '<label class="field-label" for="cs-draft">Message to ' +
                    FMT.esc(String(c.firstName || c.name)) + '</label>' +
                    '<textarea class="input cs-draft" id="cs-draft" rows="14">' +
                    FMT.esc(s.draft) + '</textarea>' +
                    '<div class="field-hint">Edit anything. It sends as a normal message in ' +
                    'your conversation and is saved to your call notes.</div>' +
                    '</div>' +

                    '<div id="cs-alert"></div>'
                );

                $('#cs-send').html(UI.btn({
                    label: 'Approve & send', icon: 'send', act: 'cs-send',
                    data: { room: roomCode }
                }));
            },

            function (err) {
                $('#cs-body').html(UI.callout({
                    tone: 'warn', icon: 'alertTriangle',
                    title: 'Could not build the summary',
                    text: err.error
                }));
            }
        );
    });
}

/* Approve and send. The body sent is whatever is in the box, not what we
   generated - see the note in php/api/call-summary.php about why re-generating
   here would silently discard the representative's corrections. */
$(document).on('click', '[data-act="cs-send"]', function () {
    var $btn = $(this);
    if ($btn.hasClass('is-loading')) { return; }

    var room = $btn.data('room');
    var body = $.trim($('#cs-draft').val());

    if (!body) {
        $('#cs-alert').html(UI.callout({
            tone: 'warn', icon: 'alertTriangle', title: 'There is nothing to send.'
        }));
        return;
    }

    $btn.addClass('is-loading').prop('disabled', true);
    $('#cs-alert').empty();

    API.sendCallSummary(room, body).then(

        function (data) {
            UI.closeModal();
            UI.toast({ title: data.message || 'Summary sent.', tone: 'ok' });
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            $('#cs-alert').html(UI.callout({
                tone: 'warn', icon: 'alertTriangle', title: err.error
            }));
        }
    );
});
