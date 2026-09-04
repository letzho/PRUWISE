/* ==========================================================================
   app.js
   --------------------------------------------------------------------------
   The part that holds everything together:

     1. STATE      - what the app remembers (who is logged in, theme, etc.)
     2. THEME      - light / dark switching
     3. NAVIGATION - the menu structure and page titles
     4. ROUTER     - shows the right page for the URL
     5. SHELL      - sidebar + topbar + bottom nav around each page
     6. LOGIN      - the entry screen
     7. HANDLERS   - every click in the app, in one place
     8. START      - kick everything off

   Load this file LAST, because it uses DATA, UI, CHARTS, AI and the page
   files. See the bottom of index.html for the order.
   ========================================================================== */


/* ==========================================================================
   WHICH BUILD IS THIS?
   --------------------------------------------------------------------------
   One number, shown in Settings, so the question "is the live site running my
   latest upload?" can be answered by looking at the screen instead of guessing.

   IT MUST MATCH THE ?v= IN index.html. That query string is what forces a
   browser to fetch a changed file rather than reuse the copy it already has;
   this constant is how you can SEE which one it actually loaded.

   The two are separate on purpose. If they could not disagree there would be
   nothing to check - and the failure we are guarding against is exactly a
   half-done bump, where the files are uploaded but the ?v= is not moved, so
   every browser quietly keeps running the old code. php/setup.php compares
   them and refuses to call the deployment healthy if they differ.

   BUMP BOTH TOGETHER, EVERY UPLOAD.
   ========================================================================== */
var APP_BUILD = 29;


/* ==========================================================================
   1. STATE
   --------------------------------------------------------------------------
   One plain object holding everything the app needs to remember.
   A few keys are saved to localStorage so a page refresh does not log you
   out or reset your theme. Everything else is fine to lose on refresh.
   ========================================================================== */
var STATE = {
    /* WHO IS LOGGED IN.

       This is NOT saved to localStorage any more. The server decides, and it
       decides from a cookie the browser cannot read. On start-up we ask
       php/api/session.php and fill this in from the answer.

       That matters: a value in localStorage can be edited by anyone with the
       developer tools open, so "logged in as a representative" used to be a
       thing you could simply type. Now it is not.

       Shape comes straight from public_account() in php/lib/auth.php:
         { accountId, role, personId, username, name, email, phone, label,
           repId, emailVerified, hasSampleProfile, prefs:{...} }               */
    session: null,

    // Set once session.php answers, so the app knows the server is reachable
    serverReady: false,
    serverInfo: null,       // { time, devMode, aiEnabled }

    theme: null,            // 'light' | 'dark' | null (null = follow the device)
    rememberedUser: '',

    activeCustomerId: 'cus-001',   // which customer the FR is working on
    sharedRecId: null,             // recommendation the FR sent to the customer

    /* Conversations themselves are NOT here. They live in MySQL and js/messages.js
       holds whichever ones it is showing. STATE is written to localStorage, and
       localStorage is editable by whoever is holding the keyboard - no place for
       a copy of somebody's messages. These two are just "where was I looking". */
    openThreadId: null,     // which conversation is open in Messages
    threadOpened: false,    // on phones: are we looking at a thread or the list?

    /* Appointment alerts are dismissed locally by key, because they are a standing
       state rather than an event - see refreshApptAlerts(). Real notifications are
       NOT in here: their read_at lives on the server, so it follows the person to
       another device, which is the whole point of a notification. */
    readNotifs: [],         // ids of appointment alerts already looked at

    notifs: [],             // the real ones, from /api/notifications
    notifUnread: 0,         // counted by the server, not by this list

    /* Appointments that want somebody's attention: a request waiting to be
       accepted, or one of ours that has just been agreed. Filled from the server
       by refreshApptAlerts() and NOT saved - it would be stale within a minute
       and the server is the only thing that actually knows. */
    apptAlerts: [],

    questions: [],          // questions the customer saved for their FR

    ratings: {},            // customer's rating of their FR, keyed by FR id
    repChangeRequest: null, // a pending "please give me a different FR" request
    lastRepChange: null,    // when they last changed FR (policy allows 1 a year)

    donePoints: [],         // talking points the FR ticked off during a call
    callNotes: '',          // the FR's notes, which go on the customer record

    askedQuestions: [],     // questions the customer ticked off during a call
    myCallNotes: '',        // the customer's own private notes from a call

    /* ==========================================================================
       WHAT HAS ALREADY BEEN COVERED IN A CALL

       REQUESTED: "can reload the things then can check it off and it will serve
       as log as what have already been asked".

       Keyed by room code, so two calls do not share a list:

           callCovered = { 'a1b2c3d4': { 'trigger-new-dependent': { label, at } } }

       WHY IT IS IN STATE AND NOT IN js/call.js. It was in call.js, as
       `postits[id].struck`, and it was lost the instant anything re-rendered the
       page - which now happens routinely, because the representative can navigate
       away mid-call and the call docks instead of ending. Ticking a note and then
       opening the client's record threw the tick away, and a log that forgets is
       worse than no log because you stop being able to trust what is missing
       from it.

       BROWSER-LOCAL, AND THAT IS A REAL LIMIT worth being straight about: this
       survives navigation and a refresh, not a different machine. The durable
       record of a call is still the after-call summary, which is a message in the
       conversation.
       ========================================================================== */
    callCovered: {},

    drawerOpen: false
};

/* Which STATE keys get saved to this browser. Anything not listed here resets
   on refresh.

   NOTE WHAT IS NOT HERE ANY MORE: 'session' and 'accounts'. Both now live on
   the server, because both are things a person should not be able to edit for
   themselves. What is left is genuinely per-device preference and scratch work.  */
var SAVED_KEYS = ['theme', 'rememberedUser', 'activeCustomerId',
    'sharedRecId', 'readNotifs', 'questions', 'callNotes', 'myCallNotes', 'ratings',
    'repChangeRequest', 'lastRepChange', 'callCovered'];

/* ==========================================================================
   WHERE LOCAL STATE IS KEPT, AND WHY IT IS KEYED BY ACCOUNT

   ==========================================================================
   REPORTED: "when you put both accounts side by side the web app gets confused"
   ==========================================================================

   It did, and there were two separate causes. This is the one the app can fix.

   Everything in SAVED_KEYS went into ONE localStorage key, 'ain.state', shared by
   every tab on the origin. So a representative's tab and a client's tab wrote over
   each other's:

     activeCustomerId   the rep's selected client, overwritten by the client's tab
     openThreadId       whichever conversation was opened LAST, in either tab
     readNotifs         one list of dismissed alerts for two different people
     callNotes          notes typed in one call appearing in the other person's

   Per-account keys fix all of that. THEME AND rememberedUser STAY GLOBAL, on
   purpose: those are properties of the DEVICE, and wanting dark mode is not
   something you want to re-choose per login.

   ==========================================================================
   THE OTHER CAUSE IS NOT FIXABLE AND IS HANDLED INSTEAD - SEE watchForOtherTab()
   ==========================================================================

   The session is a cookie. Cookies belong to the BROWSER, not to a tab. So
   signing in as a second person in a second tab genuinely replaces the first
   person's session, for both tabs, and no amount of client-side care changes that.
   What the app can do is NOTICE and say so, which is what watchForOtherTab does.
   ========================================================================== */

var STORAGE_KEY = 'ain.state';

/* Per device rather than per account. Everything else is scoped. */
var GLOBAL_KEYS = ['theme', 'rememberedUser'];

/* Which localStorage key this account's state lives under. Signed out, the shared
   one - there is no account to scope by, and the only thing worth keeping then is
   the theme. */
function stateKey() {
    var id = (STATE.session && STATE.session.accountId) ? STATE.session.accountId : '';
    return id ? STORAGE_KEY + '.' + id : STORAGE_KEY;
}

function saveState() {
    try {
        var mine = {};
        var shared = {};

        SAVED_KEYS.forEach(function (key) {
            if (GLOBAL_KEYS.indexOf(key) !== -1) { shared[key] = STATE[key]; }
            else { mine[key] = STATE[key]; }
        });

        localStorage.setItem(stateKey(), JSON.stringify(mine));

        /* The device-wide slice, merged rather than replaced, so writing the theme
           does not blank a remembered username. */
        var existing = {};

        try { existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
        catch (e) { existing = {}; }

        GLOBAL_KEYS.forEach(function (key) { existing[key] = shared[key]; });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));

    } catch (e) {
        // localStorage can be blocked (private browsing). The app still works,
        // it just forgets things on refresh - so we ignore the error.
    }
}

function loadState() {
    /* The device slice first, then this account's over the top. Order matters:
       an account-scoped value must win over a device-wide default. */
    [STORAGE_KEY, stateKey()].forEach(function (key) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) { return; }

            var saved = JSON.parse(raw);

            SAVED_KEYS.forEach(function (name) {
                if (saved[name] !== undefined && saved[name] !== null) {
                    STATE[name] = saved[name];
                }
            });
        } catch (e) { /* corrupted or unavailable - start fresh */ }
    });
}


/* ==========================================================================
   TWO ACCOUNTS IN ONE BROWSER

   ==========================================================================
   THIS CANNOT BE MADE TO WORK, SO IT IS MADE TO SAY SO
   ==========================================================================

   The session is a cookie. A cookie belongs to an origin and therefore to the
   whole browser - there is no such thing as a per-tab cookie. So signing in as
   Kristin in one tab and Sarah in another does not give you two sessions: the
   second sign-in REPLACES the first, and from then on the first tab is a
   representative's screen making requests that the server answers as the client.

   The result was a tab showing one person's layout filled with another person's
   data, which is exactly "the web app gets confused" - and worse than an error,
   because everything looks plausible.

   THE STORAGE EVENT IS THE RIGHT TOOL and the browser provides it for precisely
   this. Every tab writes the account it belongs to into a shared key on sign-in.
   Every OTHER tab is notified, compares, and if it no longer owns the session it
   stops pretending: a full-screen explanation with one button.

   No polling, no request, and it fires the instant the other tab signs in rather
   than up to a minute later.

   WHAT TO DO ABOUT IT is stated rather than implied: two accounts at once needs
   two browsers, or one normal window and one private window. That is not a
   limitation of this app, it is how the web works, and pretending otherwise would
   send somebody hunting for a bug that is not there.
   ========================================================================== */

var SESSION_OWNER_KEY = 'ain.session.owner';

/* Called after any successful sign-in. Tells the other tabs. */
function claimSession(accountId) {
    try {
        localStorage.setItem(SESSION_OWNER_KEY, String(accountId || ''));
    } catch (e) { /* private browsing: the warning below simply will not fire */ }
}

function watchForOtherTab() {
    $(window).on('storage', function (e) {
        var event = e.originalEvent || e;

        if (!event || event.key !== SESSION_OWNER_KEY) { return; }
        if (!STATE.session) { return; }

        var nowOwned = String(event.newValue || '');
        var mine = String(STATE.session.accountId || '');

        if (!nowOwned || nowOwned === mine) { return; }

        showSessionTakenOver();
    });
}

function showSessionTakenOver() {
    if ($('#session-clash').length) { return; }

    /* Polling is stopped first. A tab that has lost the session must not keep
       asking questions as somebody else - every answer it gets would be the other
       person's data arriving on this person's screen. */
    if (window.MESSAGES && MESSAGES.stopPolling) { MESSAGES.stopPolling(); }
    if (window.CALL && CALL.teardown) { CALL.teardown(); }

    $('body').append(
        '<div class="session-clash" id="session-clash" role="alertdialog" ' +
        'aria-labelledby="session-clash-title">' +
        '<div class="session-clash-card">' +
        UI.icon('alertTriangle', 26) +
        '<h2 id="session-clash-title">Somebody signed in on another tab</h2>' +
        '<p>This browser can only hold one PRUWise session at a time, because the ' +
        'sign-in is a cookie and cookies belong to the whole browser rather than to ' +
        'one tab. Another tab has just signed in as somebody else, so this tab is ' +
        'now showing ' + FMT.esc(String(STATE.session.name || 'your')) +
        '\u2019s screen with a different person\u2019s session behind it.</p>' +
        '<p class="session-clash-how"><strong>To use two accounts at once:</strong> ' +
        'open the second one in a different browser, or in a private window. Two ' +
        'normal tabs will always share the one sign-in.</p>' +
        '<div class="card-actions">' +
        UI.btn({ label: 'Reload as the current account', icon: 'refresh',
                 act: 'session-clash-reload' }) +
        '</div>' +
        '</div></div>'
    );
}




/* ==========================================================================
   2. THEME
   ========================================================================== */

// What theme should we actually show? User choice wins, else ask the device.
function currentTheme() {
    if (STATE.theme) { return STATE.theme; }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
    var theme = currentTheme();

    /* Turn transitions off for a moment. Without this, switching theme makes
       every element on the page slowly cross-fade, which looks like a smear.
       base.css has the matching ".theme-switching" rule. */
    $('html').addClass('theme-switching').attr('data-theme', theme);
    $('meta[name="theme-color"]').attr('content', theme === 'dark' ? '#0B0C10' : '#E4002B');
    window.setTimeout(function () { $('html').removeClass('theme-switching'); }, 60);
}

function toggleTheme() {
    STATE.theme = (currentTheme() === 'dark') ? 'light' : 'dark';
    saveState();
    applyTheme();
    // Swap the sun/moon icon on every theme button currently on screen
    $('[data-act="theme"]').html(UI.icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18));
}


/* ==========================================================================
   3. NAVIGATION STRUCTURE
   Change these lists and the sidebar, drawer and bottom bar all update.
   ========================================================================== */

/* ==========================================================================
   THE GROUP HEADINGS SAY WHAT THE THINGS UNDER THEM ARE, NOT WHAT YOU DO

   They used to read "Advise" and "Recommend", which sounded like a workflow and
   was not one. Nothing under "Advise" advised anybody, "Recommend" contained a
   single video-call link, and a representative looking for the calendar had to
   decide which verb a diary belongs to.

     ANALYTICS      things you READ. The dashboard, the client list, the numbers.
     COMMUNICATION  things where you TALK TO SOMEBODY. Messages, the calendar,
                    a video call, an in-person meeting.

   Two headings, and every item obviously belongs to exactly one of them - which is
   the only test a category heading has to pass.
   ========================================================================== */
var NAV = {
    fr: [
        {
            label: 'Analytics', items: [
                { path: '/fr/dashboard', label: 'Dashboard', icon: 'grid' },

                /* CALENDAR SITS HERE, AND ABOVE CLIENTS, BY REQUEST.

                   It was under Communication on the reasoning that a meeting is a
                   way of talking to somebody. The counter-argument is stronger:
                   what a representative does with this screen all day is READ it -
                   what is booked, what is free, where the week has gone. That is
                   the same activity as the dashboard, and it is the second thing
                   opened after it, which is why it is second in the list rather
                   than last. Booking is one action on a screen that mostly exists
                   to be looked at. */
                { path: '/fr/calendar', label: 'Calendar', icon: 'calendar' },

                /* `match` because the profile route is SINGULAR - '/fr/customer/:id'
                   - and this entry is plural. Without it, opening a client lit
                   nothing in the sidebar. See navMatches(). */
                {
                    path: '/fr/customers', label: 'Clients', icon: 'users',
                    badge: 'clients',
                    match: ['/fr/customer', '/fr/recommendations']
                }
            ]
        },
        {
            label: 'Communication', items: [
                /* One entry, not two. PRUWise used to have its own screen, which
                   meant two places to go for the same conversation. It is now the
                   first conversation inside Messages - and '/fr/pruwise' still
                   exists as a route, so it is matched here. */
                {
                    path: '/fr/messages', label: 'Messages & PRUWise',
                    icon: 'messageCircle', ai: true, match: ['/fr/pruwise']
                },
                { path: '/fr/call', label: 'Video consultation', icon: 'video' },

                /* An in-person meeting with the app open on the table. Under
                   Communication with the other two ways of talking to somebody,
                   because that is what it is. */
                { path: '/fr/inperson', label: 'Live transcribe', icon: 'mic', ai: true }
            ]
        },
        {
            label: 'Account', items: [
                { path: '/settings', label: 'Settings', icon: 'settings' }
            ]
        }
    ],

    customer: [
        {
            label: 'My protection', items: [
                { path: '/me/dashboard', label: 'Home', icon: 'home' },

                /* Calendar moved up here for the same reason as the
                   representative's, and it now sits directly under Home because
                   "when am I speaking to them" is the question a client opens this
                   app to answer second, after "what do I have".

                   Appointments stays under Communication: it is the REQUEST queue -
                   what has been asked for and not yet agreed - which is a
                   conversation, not a diary. Two entries that sound alike is the
                   risk here, so their icons stay deliberately different. */
                { path: '/me/calendar', label: 'Calendar', icon: 'calendar' },

                { path: '/me/plans', label: 'My plans', icon: 'shield' }
            ]
        },
        {
            label: 'Communication', items: [
                {
                    path: '/me/messages', label: 'Messages & PRUWise',
                    icon: 'messageCircle', ai: true, match: ['/me/pruwise']
                },
                { path: '/me/appointments', label: 'Appointments', icon: 'clipboard' },
                { path: '/me/call', label: 'Video call', icon: 'video' },
                { path: '/me/representative', label: 'My representative', icon: 'userCheck' }
            ]
        },
        {
            label: 'Account', items: [
                { path: '/settings', label: 'Settings', icon: 'settings' }
            ]
        }
    ],

    /* The administrator sees none of the advisory screens. Their job is the
       accounts themselves, so that is all their navigation offers. */
    admin: [
        {
            label: 'Administration', items: [
                { path: '/admin/users', label: 'Users', icon: 'users' },
                { path: '/admin/requests', label: 'Change requests', icon: 'userX' },
                { path: '/admin/audit', label: 'Activity log', icon: 'clock' }
            ]
        },
        {
            label: 'Account', items: [
                { path: '/settings', label: 'Settings', icon: 'settings' }
            ]
        }
    ]
};

/* HOW ACCOUNTS WORK

   There is no demo mode and there are no credentials in this file. Every login
   is a real row in the database, and php/api/login.php is the only thing that
   can decide whether a password is right.

     customer  registers themselves through the sign-up form
     fr        created by an administrator
     admin     the first one is created by php/setup.php, with a random
               password shown to you once; after that admins create each other

   php/api/register.php hard-codes role='customer', so no amount of tampering
   with the request can create staff access. That is also why the login screen
   has no "log in as..." picker: the account itself decides what you see.

   To get the starting passwords, open php/setup.php. If you have lost one, use
   "Forgot password?" on the login screen.                                      */

/* ==========================================================================
   WHAT A CUSTOMER CAN REACH BEFORE THEY HAVE A REPRESENTATIVE

   A brand new customer has no policies, no appointments and nobody to call. Left
   with the full menu they would find four empty screens and conclude the product
   is broken - which is a worse first impression than a short menu.

   So until a representative has ACCEPTED them, they get Home, Messages and
   Settings. Messages still works properly, because PRUWise is in there and is
   genuinely useful from the first minute.

   The gate is ONBOARDING.hasRep(), which asks "has somebody agreed to look after
   them" by reading the consultation requests. A waiting customer genuinely has no
   representative - rep_id is NULL until one accepts - so the screens we hide are
   the same ones the server would refuse with a 409 anyway. Hiding them means the
   customer never meets that refusal.

   THE PATHS ARE STILL BLOCKED IN THE ROUTER TOO. Hiding a link is a courtesy;
   somebody who types the address gets an explanation rather than an empty page.
   Neither is a security control - none of these screens expose anything the
   server would hand over anyway.
   ========================================================================== */

// Reachable before a representative has accepted
var CUSTOMER_OPEN_PATHS = ['/me/dashboard', '/me/messages', '/settings'];

function customerIsWaiting() {
    return !!(STATE.session
        && STATE.session.role === 'customer'
        && window.ONBOARDING
        && !ONBOARDING.hasRep());
}

/* ==========================================================================
   WHICH SIDEBAR ENTRY IS THE CURRENT ONE

   ==========================================================================
   THIS WAS A REPORTED BUG AND THE CAUSE WAS A MISSING LETTER
   ==========================================================================

   "Even though I am still in the client tab the message tab still lights up, and
   sometimes the client tab does not light up at all."

   The second half first, because it is the simpler fault. The test used to be:

       o.path === item.path || o.path.indexOf(item.path + '/') === 0

   The Clients entry points at '/fr/customers'. A client's profile is
   '/fr/customer/cus-001' - SINGULAR. So '/fr/customer/cus-001' neither equals
   '/fr/customers' nor begins with '/fr/customers/', and opening a client lit
   NOTHING. One letter, and the sidebar stopped telling you where you were.

   The same applied to '/fr/pruwise', which the search list and several buttons
   link to while the sidebar entry points at '/fr/messages'.

   Guessing a relationship from string prefixes was the mistake. `match` states it,
   so a route that does not happen to be spelled like its nav entry still belongs
   to it - and adding a route now means deciding where it lives rather than
   discovering later that it lives nowhere.
   ========================================================================== */
function navMatches(path, item) {
    var candidates = [item.path].concat(item.match || []);

    for (var i = 0; i < candidates.length; i++) {
        var base = candidates[i];

        /* Exactly it, or beneath it. The trailing slash matters: without it
           '/fr/customers' would also claim '/fr/customersomething'. */
        if (path === base) { return true; }
        if (path.indexOf(base + '/') === 0) { return true; }
    }
    return false;
}

/* The navigation for a role, trimmed if they are still waiting. Groups that end
   up empty are dropped, so there is no bare heading with nothing under it. */
function navFor(role) {
    var groups = NAV[role] || NAV.customer;

    if (role !== 'customer' || !customerIsWaiting()) { return groups; }

    var trimmed = [];

    groups.forEach(function (group) {
        var items = group.items.filter(function (item) {
            return CUSTOMER_OPEN_PATHS.indexOf(item.path) !== -1;
        });

        if (items.length) {
            trimmed.push({ label: group.label, items: items });
        }
    });

    return trimmed;
}

// Where each role lands after signing in
var HOME_BY_ROLE = {
    fr: '/fr/dashboard',
    customer: '/me/dashboard',
    admin: '/admin/users'
};


/* ==========================================================================
   4. ROUTER
   --------------------------------------------------------------------------
   We use "hash routing": the part of the URL after the # sign.

       index.html#/fr/dashboard

   Why the hash? Because the browser never asks the server for it, so this
   works when you open the file directly AND when you serve it from WAMP,
   with no server configuration at all.

   PAGES is filled in by pages-*.js. Each entry looks like:
       PAGES['/fr/dashboard'] = { title, sub, render, after, flush, wide }
   ========================================================================== */

var PAGES = {};

// Reads the hash and splits it into a path, a query and any :id parameter
function parseHash() {
    var raw = window.location.hash.replace(/^#/, '') || '/login';
    var questionMark = raw.indexOf('?');

    var path = (questionMark === -1) ? raw : raw.substring(0, questionMark);
    var queryString = (questionMark === -1) ? '' : raw.substring(questionMark + 1);

    if (path.charAt(0) !== '/') { path = '/' + path; }
    path = path.replace(/\/+$/, '') || '/';   // drop any trailing slash

    // Turn "rec=abc&tab=compare" into { rec:'abc', tab:'compare' }
    var query = {};
    queryString.split('&').forEach(function (pair) {
        if (!pair) { return; }
        var bits = pair.split('=');
        query[decodeURIComponent(bits[0])] = decodeURIComponent(bits[1] || '');
    });

    return { path: path, query: query };
}

/* Finds the page for a path.
   Exact matches win. Otherwise we look for a route with an :id placeholder,
   e.g. '/fr/customer/:id' matches '/fr/customer/cus-001'. */
function matchRoute(path) {
    if (PAGES[path]) { return { page: PAGES[path], params: {} }; }

    var parts = path.split('/');
    for (var pattern in PAGES) {
        if (pattern.indexOf(':') === -1) { continue; }

        var patternParts = pattern.split('/');
        if (patternParts.length !== parts.length) { continue; }

        var params = {};
        var matched = true;
        for (var i = 0; i < patternParts.length; i++) {
            if (patternParts[i].charAt(0) === ':') {
                params[patternParts[i].substring(1)] = decodeURIComponent(parts[i]);
            } else if (patternParts[i] !== parts[i]) {
                matched = false;
                break;
            }
        }
        if (matched) { return { page: PAGES[pattern], params: params }; }
    }
    return null;
}

/* Navigate to a path.

   Changing the hash fires the browser's "hashchange" event, which calls
   router(). But if we are ALREADY on that address the browser fires nothing,
   so the page would not update. That matters when only the data changed - for
   example switching customer while staying on PRUWise. In that case
   we call router() ourselves. */
function go(path, opts) {
    var target = (path.charAt(0) === '#') ? path : '#' + path;

    if (window.location.hash === target) {
        router();
        return;
    }

    /* REPLACE, FOR A REDIRECT. Without this a route that forwards somewhere else
       is a back-button trap: /fr/recommendations sends you to a client profile,
       you press Back, you land on /fr/recommendations, and it sends you forward
       again. You can never get past it.

       replaceState swaps the current entry instead of adding one, so Back skips
       the redirect entirely and goes where the person actually came from. It does
       not fire hashchange, so router() has to be called by hand. */
    if (opts && opts.replace && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', target);
        router();
        return;
    }

    window.location.hash = target;
}

function homePath() {
    if (!STATE.session) { return '/login'; }
    return HOME_BY_ROLE[STATE.session.role] || '/me/dashboard';
}

/* ==========================================================================
   OLD ADDRESSES THAT STILL WORK

   PRUWise used to be its own screen. It is now the first conversation in
   Messages, so these two addresses redirect there with PRUWise open.

   Kept rather than deleted because links to them exist in saved notifications,
   in anybody's bookmarks, and in a dozen "Ask PRUWise" buttons across the app.
   A redirect is two lines; hunting every link down and getting one wrong is a
   404 for somebody.
   ========================================================================== */
var ROUTE_ALIASES = {
    '/fr/pruwise': '/fr/messages',
    '/me/pruwise': '/me/messages'
};

/* The main render function. Runs on first load and on every hash change. */
function router() {
    var route = parseHash();
    var path = route.path;
    var loggedIn = !!STATE.session;

    /* STOP ANY VOICE FIRST. A "Read aloud" button reads a paragraph about
       somebody's cover; the button vanishes when the screen changes, so without
       this the voice carries on with nothing on screen to stop it. Done here
       rather than in a navigate event because this function IS the navigation. */
    if (window.UI && UI.speech) { UI.speech.stop(); }

    if (ROUTE_ALIASES[path]) {
        // Tell Messages to open PRUWise rather than the last conversation
        if (typeof MESSAGES !== 'undefined') { MESSAGES.focusAi(); }
        go(ROUTE_ALIASES[path]);
        return;
    }

    /* Pages that work WITHOUT being logged in, because they are reached from a
       link in an email. Demanding a login first would be circular: the whole
       reason somebody is on the reset page is that they cannot log in. */
    var PUBLIC_PAGES = ['/login', '/reset-password', '/confirm-email'];
    var isPublic = PUBLIC_PAGES.indexOf(path) !== -1;

    // --- Guard 1: not logged in? Only the public pages are allowed.
    if (!loggedIn && !isPublic) {
        go('/login');
        return;
    }

    /* --- Guard 2: already logged in? Skip the login screen.
       The email links are deliberately NOT included: a logged-in person
       clicking a confirmation link should still have it work. */
    if (loggedIn && path === '/login') {
        go(homePath());
        return;
    }

    // --- The full-page screens, which replace everything (no sidebar, no topbar)
    if (path === '/login') {
        UI.closeModal();
        UI.closeDrops();
        renderLogin();
        return;
    }

    if (path === '/reset-password') {
        UI.closeModal();
        UI.closeDrops();
        renderResetPassword(route.query.token || '');
        return;
    }

    if (path === '/confirm-email') {
        UI.closeModal();
        UI.closeDrops();
        renderConfirmEmail(route.query.token || '');
        return;
    }

    /* Onboarding screens are full-page (no sidebar, no topbar) for customers.
       They are registered in PAGES by pages-onboarding.js but handled here
       BEFORE the shell so they render like the login screen - clean and focused,
       with nothing distracting around the edges. */
    if (path.indexOf('/onboarding/') === 0 && loggedIn) {
        var obFound = matchRoute(path);
        if (obFound) {
            UI.closeModal();
            UI.closeDrops();

            var obBody;

            try {
                obBody = obFound.page.render({ params: obFound.params, query: route.query, path: path });

            } catch (e) {
                /* SAY WHAT BROKE, AND OFFER A RELOAD THAT ACTUALLY RELOADS.

                   The old version of this showed a bare "Page error" with the
                   default Try again button, and that button was
                   data-act="reload" - a soft router() re-run. Re-running the
                   router calls the same render() with the same broken state, so
                   it threw again and the button looked dead. That is exactly the
                   report: "it says try again and the try again button doesn't
                   work".

                   Two changes:

                     data-act="hard-reload" does a real location.reload(). It is
                     the right retry here because the two realistic causes both
                     need a full page load - stale cached JavaScript, and the
                     free host's bot check, which can only be cleared by a
                     navigation. See isHostCheck() in js/api.js.

                     The exception message is shown on screen. It stays in the
                     console too, but nobody looking at a broken screen on a
                     phone can open a console, and "FMT.date is not a function"
                     names the bug instantly instead of hiding it behind a
                     generic apology. */
                console.error('Onboarding render error:', e);

                obBody = UI.errorState({
                    title: 'This screen could not be drawn',
                    text: 'The reason was: ' + ((e && e.message) ? e.message : String(e)) +
                          '. Reloading the page usually fixes it - most often the browser is ' +
                          'holding an old copy of the app.',
                    actions: UI.btn({ label: 'Reload the page', variant: 'outline',
                                      icon: 'refresh', act: 'hard-reload' }) +
                             UI.btn({ label: 'Back to home', variant: 'ghost',
                                      icon: 'home', href: '#' + homePath() })
                });
            }

            $('#root').html('<div class="login"><div class="login-pane" style="grid-column:1/-1">' +
                '<button type="button" class="iconbtn iconbtn-bordered theme-fab" data-act="theme" ' +
                'aria-label="Switch theme">' + UI.icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18) +
                '</button>' + obBody + '</div></div>');

            if (obFound.page.after) {
                try { obFound.page.after({ params: obFound.params, query: route.query, path: path }); }
                catch (e) { console.error('Onboarding after() error:', e); }
            }
            return;
        }
    }

    /* --- Guard 3: keep each role in its own section.

       The server checks this too, on every endpoint. This is only so the
       browser does not draw a page it has no business drawing - the real
       enforcement is in PHP, because a router guard is just JavaScript and
       JavaScript can be edited by whoever is holding the keyboard. */
    var role = STATE.session.role;

    if (role !== 'fr' && path.indexOf('/fr/') === 0) { go(homePath()); return; }
    if (role !== 'customer' && path.indexOf('/me/') === 0) { go(homePath()); return; }
    if (role !== 'admin' && path.indexOf('/admin/') === 0) { go(homePath()); return; }

    /* Onboarding belongs to customers. A representative who lands on one of
       these URLs goes to their own dashboard rather than a screen that would ask
       them to assess themselves. */
    if (role !== 'customer' && path.indexOf('/onboarding/') === 0) { go(homePath()); return; }

    /* A customer still waiting for a representative gets an explanation rather
       than an empty screen. See the note above CUSTOMER_OPEN_PATHS.

       An explanation, not a redirect: bouncing somebody back to the dashboard
       without saying why makes the app feel broken, and they would try again. */
    if (customerIsWaiting()
        && path.indexOf('/onboarding/') !== 0
        && CUSTOMER_OPEN_PATHS.indexOf(path) === -1) {

        var hasAssessment = !!(window.ONBOARDING && ONBOARDING.getAssessment());

        renderShell({
            path: path,
            title: 'Not available yet',
            sub: '',
            body: '<div class="errpage">' +
                '<span class="nh-cta-icon">' + UI.icon('userCheck', 26) + '</span>' +
                '<h1 class="h3">You need a representative first</h1>' +
                '<p class="lead">This screen is about working with your financial ' +
                'representative - your plans, your appointments and your calls. ' +
                'It opens up as soon as somebody has accepted you.</p>' +

                (hasAssessment
                    ? UI.callout({
                        tone: 'info', icon: 'clock',
                        title: 'Your assessment is done',
                        text: 'Choose a representative, or wait for the one you asked to reply. ' +
                            'You will see it on your home screen.'
                    })
                    : UI.callout({
                        tone: 'brand', icon: 'clipboard',
                        title: 'Start with the assessment',
                        text: 'Seven questions, about five minutes. It is how we work out which ' +
                            'representative suits what you are aiming for.'
                    })) +

                '<div class="card-actions" style="justify-content:center">' +
                UI.btn({ label: 'Go to my home', icon: 'home', href: '#/me/dashboard' }) +
                UI.btn({
                    label: hasAssessment ? 'Choose a representative' : 'Take the assessment',
                    variant: 'outline', icon: 'arrowRight',
                    href: hasAssessment ? '#/onboarding/matching' : '#/onboarding/assessment'
                }) +
                UI.btn({ label: 'Ask PRUWise', variant: 'ghost', icon: 'sparkles',
                         href: '#/me/messages' }) +
                '</div></div>'
        });
        return;
    }

    var found = matchRoute(path);

    // --- Unknown address: show a friendly not-found page inside the shell
    if (!found) {
        renderShell({
            path: path,
            title: 'Page not found',
            sub: '',
            body: '<div class="errpage"><div class="errcode">404</div>' +
                '<h1 class="h3">We could not find that page</h1>' +
                '<p class="lead">The link may be out of date. Everything else is still where you left it.</p>' +
                UI.btn({ label: 'Back to my dashboard', icon: 'arrowLeft', href: '#' + homePath() }) +
                '</div>'
        });
        return;
    }

    var page = found.page;
    var context = { params: found.params, query: route.query, path: path };

    /* Build the page HTML. We wrap it in try/catch so that a mistake in one
       page shows a tidy error state instead of a blank white screen. */
    var body;
    try {
        body = page.render(context);
    } catch (err) {
        console.error('Page failed to render:', err);

        /* Show the actual message on screen, not only in the console.

           WHY: "details are in the browser console" is useless to anybody who is
           not already looking at one - which includes whoever is testing this on
           a phone, and whoever reports the bug to you. The message and the line
           are what make it fixable, and this is a prototype rather than a bank. */
        var detail = (err && err.message) ? err.message : String(err);
        var where = '';

        if (err && err.stack) {
            var lines = String(err.stack).split('\n');
            if (lines.length > 1) { where = ' \u2014 ' + $.trim(lines[1]); }
        }

        body = UI.errorState({
            title: 'This page hit an error',
            text: detail + where
        });
    }

    renderShell({
        path: path,
        title: page.title,
        sub: page.sub,
        body: body,
        flush: page.flush,
        wide: page.wide
    });

    // Let the page do any jQuery wiring that needs real elements on the page
    if (page.after) {
        try {
            page.after(context);
        } catch (err) {
            console.error('Page after() failed:', err);
        }
    }
}


/* ==========================================================================
   5. THE APP SHELL
   Sidebar + topbar + page + bottom navigation.
   We rebuild the whole shell on each navigation. That sounds wasteful, but it
   is only a few hundred elements and it removes any chance of stale UI.
   ========================================================================== */

function renderShell(o) {
    var role = STATE.session.role;
    var isFr = (role === 'fr');
    var isAdmin = (role === 'admin');
    var session = STATE.session;

    /* ---------------------------------------------------------- sidebar */
    var groups = navFor(role).map(function (group) {
        var links = group.items.map(function (item) {
            var on = navMatches(o.path, item);

            return '<a class="navlink' + (item.ai ? ' navlink-ai' : '') + (on ? ' is-on' : '') + '" ' +
                'href="#' + item.path + '" title="' + FMT.esc(item.label) + '"' +
                (on ? ' aria-current="page"' : '') + '>' +
                '<span class="navlink-icon">' + UI.icon(item.icon, 18) + '</span>' +
                '<span class="navlink-label">' + FMT.esc(item.label) + '</span>' +

                /* THE CLIENT COUNT USED TO BE THE STRING '6', HARD-CODED.

                   It was the number of fixtures in js/data.js, sitting in the
                   sidebar of every representative regardless of how many people
                   they actually advise - the same class of lie as the "5 Clients"
                   hero stat, in a place that is on screen constantly.

                   It is filled from the same cached book the Clients screen and
                   the dashboard read, and NO BADGE IS DRAWN until that has
                   arrived. A blank is honest; a wrong number is not. */
                (item.badge === 'clients'
                    ? '<span class="navlink-badge" id="nav-client-count" hidden></span>'
                    : (item.badge ? '<span class="navlink-badge">' + item.badge + '</span>' : '')) +
                '</a>';
        }).join('');

        return '<div class="nav-group">' +
            '<div class="nav-group-label">' + FMT.esc(group.label) + '</div>' + links + '</div>';
    }).join('');

    /* A small card at the bottom of the sidebar. It used to hold a "view as the
       other role" switch, which a real login system cannot offer - you are who
       you signed in as. Now it points at the thing you actually want instead. */
    var promo = isAdmin
        ? '<div class="sidebar-promo">' +
        '<div class="row-2">' + UI.icon('shield', 15) + '<span class="eyebrow">Administrator</span></div>' +
        '<div class="t-xs muted">You are signed in with full access to the user database. ' +
        'Changes here affect real accounts.</div></div>'

        : '<div class="sidebar-promo">' +
        '<div class="row-2">' + UI.icon('sparkles', 15) + '<span class="eyebrow">Ask PRUWise</span></div>' +
        '<div class="t-xs muted">' + (isFr
            ? 'Any question about a client file, answered from their real record.'
            : 'Any question about your cover, explained without the jargon.') + '</div>' +
        UI.btn({
            label: 'Open PRUWise', variant: 'outline', size: 'xs', icon: 'sparkles', block: true,
            href: '#' + (isFr ? '/fr/messages' : '/me/messages')
        }) + '</div>';

    var sidebar = '<aside class="sidebar" id="sidebar" aria-label="Main navigation">' +
        '<div class="sidebar-head">' +
        UI.logo({
            size: 'sm', withText: true, href: '#' + homePath(),
            subtitle: isFr ? 'Representative' : 'My protection', cls: 'sidebar-brand'
        }) +
        '<button type="button" class="iconbtn iconbtn-sm sidebar-close phone-only" ' +
        'data-act="close-drawer" aria-label="Close navigation">' + UI.icon('x', 17) + '</button>' +
        '</div>' +
        '<nav class="sidebar-nav">' + groups + promo + '</nav>' +
        '<div class="sidebar-foot">' +
        UI.person({ name: session.name, meta: isFr ? 'Financial Representative' : 'Client', size: 'sm', seed: session.personId }) +
        '<button type="button" class="navlink" data-act="logout" title="Log out">' +
        '<span class="navlink-icon">' + UI.icon('logOut', 18) + '</span>' +
        '<span class="navlink-label">Log out</span></button>' +
        '</div></aside>';

    /* ----------------------------------------------------------- topbar */

    /* The red dot counts BOTH the mock activity feed and the real appointment
       alerts - see unreadCount(). Appointments are the ones that actually need
       doing, so a bell that ignored them would be worse than no bell. */
    var unreadTotal = unreadCount();

    /* THE "ACTIVE CLIENT" SWITCHER IS GONE FROM THE TOPBAR.

       It sat next to the bell on every single screen, showing a name and a
       chevron, and it was a SECOND WAY of saying something the app already knew.
       STATE.activeCustomerId is set by opening a client's profile, by starting a
       call with them, by asking PRUWise about them - all of which are things a
       person does on purpose. The switcher let it be changed from a screen that
       had nothing to do with any client, so the only reliable use for it was
       discovering which client you had accidentally left selected.

       That is the same problem as the "PREPARED FOR Sarah Tan" chip bar removed
       from the old recommendations screen, in a more permanent place.

       The pick-customer handler in the events section is kept - the client list
       and the profile links still route through it. Only the topbar control has
       gone, and with it a control that appeared on screens where it meant
       nothing. */

    var topbar = '<header class="topbar">' +
        '<button type="button" class="burger" data-act="burger" aria-label="Open navigation" ' +
        'aria-expanded="false" aria-controls="sidebar"><div><span></span><span></span><span></span></div></button>' +

        /* Phones: the logo only. There is no room for the wordmark next to the
           hamburger and the action buttons on a 320px screen. */
        '<span class="phone-only">' + UI.logo({ size: 'sm', withText: false, href: '#' + homePath() }) + '</span>' +

        '<div class="topbar-titles">' +
        '<div class="topbar-title">' + FMT.esc(o.title || '') + '</div>' +
        (o.sub ? '<div class="topbar-sub">' + FMT.esc(o.sub) + '</div>' : '') +
        '</div>' +

        '<div class="topbar-search">' +
        '<span class="search"><span class="input-icon">' + UI.icon('search', 16) + '</span>' +
        '<input class="input" type="search" readonly data-act="search" ' +
        'placeholder="' + (isFr ? 'Search clients, policies, terms...' : 'Search your policies and terms...') + '" ' +
        'aria-label="Search"></span></div>' +

        '<div class="topbar-spacer"></div>' +

        '<div class="topbar-actions">' +
        UI.iconBtn({ icon: 'search', label: 'Search', act: 'search', cls: 'laptop-down' }) +
        '<button type="button" class="iconbtn" data-act="theme" aria-label="Switch between light and dark theme" ' +
        'title="Switch theme">' + UI.icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18) + '</button>' +
        '<span class="drop-anchor">' +
        UI.iconBtn({ icon: 'bell', label: 'Notifications', act: 'notifs', dot: unreadTotal > 0 }) +
        '</span>' +
        '<span class="drop-anchor">' +
        '<button type="button" class="iconbtn" data-act="profile" aria-label="Account menu" style="width:auto;padding:0 4px">' +
        UI.avatar(session.name, 'xs', { seed: session.personId }) + '</button>' +
        '</span>' +
        '</div></header>';

    /* ------------------------------------------------------- assemble

       There is no bottom tab bar. On phones the hamburger opens the sidebar
       as a drawer, which is how a website behaves. */
    var pageClass = 'page' + (o.wide ? ' page-wide' : '') + (o.flush ? ' page-flush' : '');
    var inner = o.flush ? o.body : '<div class="page-inner">' + o.body + '</div>';

    $('#root').html(
        '<div class="shell">' + sidebar +
        '<div class="main">' + topbar +
        '<main class="' + pageClass + '" id="main" tabindex="-1">' + inner + '</main>' +
        '</div></div>'
    );

    STATE.drawerOpen = false;
    UI.animateBars();      // let any progress bars grow to their real width
    window.scrollTo(0, 0);
}


/* ==========================================================================
   6. LOGIN SCREEN
   The entry point. Nothing else is rendered until you sign in.
   ========================================================================== */

function renderLogin() {

    /* --- the left-hand red panel (laptop and up only) --- */
    var feature = function (icon, title, text) {
        return '<div class="feature"><span class="feature-icon">' + UI.icon(icon, 17) + '</span>' +
            '<div><div class="feature-title">' + title + '</div>' +
            '<div class="feature-text">' + text + '</div></div></div>';
    };
    var metric = function (value, label) {
        return '<div><div class="metric-value">' + value + '</div>' +
            '<div class="metric-label">' + label + '</div></div>';
    };

    var visual = '<div class="login-visual">' +
        '<div class="between">' +
        UI.logo({ size: 'lg', onBrand: true, subtitle: 'PRUWise' }) +
        '<span class="badge badge-glass">Prototype</span></div>' +
        '<div class="stack-4">' +
        '<span class="badge badge-glass">Agentic AI for insurance</span>' +
        '<h2 class="visual-title">Manage your time easily.<br>Communicate purposefully.</h2>' +
        '<p class="visual-text">Insurance made clearer, for clients and representatives alike.</p>' +
        '</div>' +
        '<div class="stack-4">' +
        feature('sparkles', 'Needs analysis in seconds', 'Reads the client file and surfaces the real protection gap, not a generic pitch.') +
        feature('scale', 'Comparisons without the jargon', 'Options side by side, with the trade-offs stated plainly.') +
        feature('messageCircle', 'Talk to a real person too', 'Message your representative directly, with PRUWise drafting the awkward questions.') +
        '</div>' +
        '<div class="metrics">' +
        metric('68%', 'Recommendations accepted') +
        metric('41%', 'Average gap closed') +
        metric('2 min', 'To a full needs summary') +
        '</div></div>';

    /* --- the form --- */
    var form = '<form class="login-form" id="login-form" novalidate>' +

        '<div class="field">' +
        '<label class="field-label" for="login-user">Username</label>' +
        '<span class="input-wrap has-icon"><span class="input-icon">' + UI.icon('user', 16) + '</span>' +
        '<input class="input" id="login-user" name="username" type="text" autocomplete="username" ' +
        'placeholder="Enter username" value="' + FMT.esc(STATE.rememberedUser) + '"></span>' +
        '</div>' +

        '<div class="field">' +
        '<label class="field-label" for="login-pass">Password</label>' +
        '<span class="input-wrap has-icon has-btn"><span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
        '<input class="input" id="login-pass" name="password" type="password" autocomplete="current-password" ' +
        'placeholder="Enter password">' +
        '<button type="button" class="input-btn" data-act="reveal" aria-label="Show password">' +
        UI.icon('eye', 16) + '</button></span>' +
        '</div>' +

        '<div class="login-row">' +
        '<label class="check"><input type="checkbox" id="login-remember"' +
        (STATE.rememberedUser ? ' checked' : '') + '><span>Remember me</span></label>' +
        '<button type="button" class="link t-sm" data-act="forgot">Forgot password?</button>' +
        '</div>' +

        '<div id="login-alert"></div>' +

        // type:'submit' so pressing Enter in either field also logs in
        UI.btn({ label: 'Log in', size: 'lg', block: true, iconRight: 'arrowRight', cls: 'login-submit', type: 'submit' }) +
        '</form>';

    var card = '<div class="login-card">' +

        '<div class="login-brand">' +
        UI.logo({ size: 'xl', subtitle: null }) +
        '<h1 class="login-title">An AI powered financial advisor tool</h1>' +
        '<p class="login-sub">Sign in to continue. Insurance made clearer, for clients and ' +
        'representatives alike.</p>' +
        '</div>' +

        /* Google sign-in removed - single auth path keeps the demo clearer. The
           implementation remains (googleBlock, mountGoogle, /api/google-login) in
           case it is needed later. */
        '<div class="login-panel">' + form + demoBlock() + '</div>' +

        '<div class="login-foot">' +
        '<div>New here? <button type="button" class="link" data-act="create-account">Create an account</button></div>' +
        '<div class="t-xs subtle">Representative accounts are issued by an administrator and cannot be ' +
        'created here.</div>' +
        '<div class="t-xs subtle">A student prototype. No real policies, advice or personal data.</div>' +
        '</div></div>';

    $('#root').html('<div class="login">' + visual +
        '<div class="login-pane">' +
        '<button type="button" class="iconbtn iconbtn-bordered theme-fab" data-act="theme" ' +
        'aria-label="Switch between light and dark theme">' +
        UI.icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18) + '</button>' +
        card + '</div></div>');

    $('#login-user').trigger('focus');

    // Draws Google's own button, if a client id is configured
    startGoogleSignIn();
}


/* ==========================================================================
   SIGN IN WITH GOOGLE
   --------------------------------------------------------------------------
   COMPLETELY OPTIONAL. If php/config.php has no google.client_id, session.php
   sends back null, none of this runs, and the login screen looks exactly as it
   did before. Nothing here fails loudly when it is switched off, because "not
   configured" is a normal state, not a problem.

   HOW THE FLOW WORKS

     1. We load Google's script and hand it the client id.
     2. It draws its own button. We do NOT draw our own - Google's terms require
        their button, and it is the one people recognise.
     3. They pick an account. Google hands us an ID TOKEN: a signed statement
        that says "this is who they are".
     4. We post that token to php/api/google-login.php, which checks Google's
        signature on it before believing a word of it.

   THE TOKEN IS NOT A PASSWORD AND NOT A SESSION. Everything that matters
   happens in the PHP - see the long comment at the top of google-login.php for
   why simply decoding the token would be worthless.
   ========================================================================== */

/* ==========================================================================
   ONE-TAP DEMO SIGN-IN

   Three buttons that fill the form and submit it, so a demonstration does not
   begin with somebody typing "kristin.henessy" into a projector.

   ==========================================================================
   THESE PASSWORDS ARE PUBLIC, AND THAT IS A DELIBERATE CHOICE
   ==========================================================================

   Anything in this file is downloadable, so the three passwords below are
   readable by anybody who opens the developer tools. That is worth stating
   plainly rather than hiding.

   It is acceptable HERE because these are seeded demonstration accounts holding
   invented data, on a prototype that already says so on this very screen. It
   would not be acceptable for a real account, and nothing here creates a path to
   one: the buttons carry no privilege of their own.

   THE ALTERNATIVE WAS WORSE. An endpoint that signs you in as a demo account
   without a password is a login bypass sitting in production, and one
   environment-variable mistake away from working on any account. Publishing
   three known passwords costs nothing that is not already public; a bypass is a
   permanent hole. So these go through /api/login exactly like a typed password -
   same bcrypt check, same session, same audit row, same rate limiting.
   ========================================================================== */

var DEMO_LOGINS = [
    {
        username: 'sarah.tan', password: 'studsarah',
        role: 'Client', name: 'Sarah Tan', icon: 'user',
        blurb: 'Has a representative, policies and a full record'
    },
    {
        username: 'kristin.henessy', password: 'studkris',
        role: 'Representative', name: 'Kristin Henessy', icon: 'userCheck',
        blurb: 'Advises the seeded clients'
    },
    {
        username: 'admin', password: 'studadmin',
        role: 'Administrator', name: 'Admin', icon: 'shield',
        blurb: 'Accounts and the activity log'
    }
];

function demoBlock() {
    return '<div class="login-divider"><span>or sign in as</span></div>' +

        '<div class="demo-logins">' +
        DEMO_LOGINS.map(function (d) {
            return '<button type="button" class="demo-login" data-act="demo-login" ' +
                'data-user="' + FMT.esc(d.username) + '" ' +
                'data-pass="' + FMT.esc(d.password) + '">' +

                '<span class="demo-login-icon">' + UI.icon(d.icon, 16) + '</span>' +
                '<span class="demo-login-text">' +
                '<span class="demo-login-role">' + FMT.esc(d.role) + '</span>' +
                '<span class="demo-login-name">' + FMT.esc(d.name) + '</span>' +
                '</span>' +
                UI.icon('arrowRight', 14) +
                '</button>';
        }).join('') +
        '</div>' +

        '<div class="t-xs subtle" style="text-align:center">Demonstration accounts with ' +
        'invented data. They sign in the same way a typed password does.</div>';
}


/* The slot the Google button gets drawn into, plus a divider. Rendered empty
   when Google is not configured, so the login screen is unchanged. */
function googleBlock() {
    if (!STATE.serverInfo || !STATE.serverInfo.googleClientId) { return ''; }

    return '<div class="login-divider"><span>or</span></div>' +
        '<div id="google-btn" class="google-btn-slot"></div>' +
        '<div id="google-alert"></div>';
}

function startGoogleSignIn() {
    var info = STATE.serverInfo;

    if (!info || !info.googleClientId || !document.getElementById('google-btn')) { return; }

    /* The script is only fetched when it is actually going to be used. Loading
       Google's library on every page visit for a button that may not exist is
       a request and a third-party connection nobody asked for. */
    loadScript('https://accounts.google.com/gsi/client', function (ok) {
        if (!ok || !window.google || !window.google.accounts) {
            $('#google-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) +
                '<span>Google sign-in could not load. Check your connection, or use your ' +
                'username and password.</span></div>');
            return;
        }

        window.google.accounts.id.initialize({
            client_id: info.googleClientId,

            /* NO NONCE ANY MORE, and it is worth knowing why rather than
               wondering.

               The replay protection used to work by having session.php mint a
               random value into a PHP session BEFORE anybody signed in, which
               google-login.php then compared against the nonce Google embedded
               in the token. Sessions are database rows now, so a pre-login
               session would mean writing a row and setting a cookie for every
               visitor who merely LOOKED at the sign-in button.

               What stands in its place: the token is signed for this client id
               only, it expires within the hour, and it travels over TLS to one
               endpoint. Anybody who can capture it can already capture the
               session cookie it produces.

               Left as an expression rather than deleted because Google's library
               treats undefined as "no nonce", so this keeps working unchanged if
               server info ever carries one again. */
            nonce: info.googleNonce || undefined,

            callback: onGoogleCredential
        });

        window.google.accounts.id.renderButton(document.getElementById('google-btn'), {
            theme: currentTheme() === 'dark' ? 'filled_black' : 'outline',
            size: 'large',
            shape: 'rectangular',
            text: 'signin_with',
            logo_alignment: 'left',

            /* Google sizes its button in pixels, not percentages, so it cannot
               simply be told to fill the width. We measure the panel and pass a
               number, clamped to the 200-400px range Google accepts. */
            width: Math.max(200, Math.min(400, $('.login-panel').width() || 320))
        });
    });
}

/* Google calls this with the signed token. It is the only thing we do with it. */
function onGoogleCredential(response) {
    if (!response || !response.credential) { return; }

    $('#google-alert').html('<div class="login-alert info" role="status">' +
        UI.icon('info', 15) + '<span>Checking that with Google\u2026</span></div>');

    API.googleLogin(response.credential).then(

        function (data) {
            /* Deliberately the same as attemptLogin's success path. A session is
               a session however it started, so there is one place that decides
               what happens next rather than two that can drift. */
            finishSignIn(data.account, data.created
                ? { title: 'Welcome to PRUWise, ' + data.account.name.split(' ')[0],
                    message: 'Your account was created from your Google details.' }
                : null);
        },

        function (err) {
            $('#google-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) + '<span>' + FMT.esc(err.error) + '</span></div>');

            /* Refresh the server info before a retry. This used to be about
               spending a one-shot nonce; there is no nonce now (see the note in
               startGoogleSignIn), but re-asking is still the cheapest way to
               notice that the deployment's Google configuration changed under
               us - which is one real reason a sign-in fails and then works. */
            API.session().then(function (fresh) {
                STATE.serverInfo = fresh.server;
                AI.configure(STATE.serverInfo);
            });
        }
    );
}

/* Loads a script once and calls back with true or false.

   Written by hand rather than with $.getScript because that treats a blocked
   or offline request as a silent nothing, and here we want to say so. */
function loadScript(src, done) {
    var existing = document.querySelector('script[src="' + src + '"]');

    if (existing) { done(true); return; }

    var tag = document.createElement('script');

    tag.src = src;
    tag.async = true;
    tag.defer = true;
    tag.onload = function () { done(true); };
    tag.onerror = function () { done(false); };

    document.head.appendChild(tag);
}

/* Runs when the login form is submitted.

   The password is checked by php/api/login.php, never here. There is no copy
   of it in the browser to compare against, which is the entire point. */
function attemptLogin() {
    var username = $.trim($('#login-user').val()).toLowerCase();
    var password = $('#login-pass').val();
    var $submit = $('.login-submit');

    // Already waiting on the server? Ignore the extra click.
    if ($submit.hasClass('is-loading')) { return; }

    $('#login-alert').empty();

    // A courtesy check so an empty form does not need a round trip. The server
    // checks the same thing again, because this one can be skipped.
    if (!username || !password) {
        showLoginError('Please enter both a username and a password.');
        $(username ? '#login-pass' : '#login-user').trigger('focus');
        return;
    }

    $submit.addClass('is-loading').prop('disabled', true);

    API.login(username, password).then(

        function (data) {
            // "Remember me" only stores the username, never the password
            STATE.rememberedUser = $('#login-remember').is(':checked') ? data.account.username : '';
            finishSignIn(data.account);
        },

        function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);
            showLoginError(err.error);

            // Put the cursor where the problem is
            if (err.field === 'username') {
                $('#login-user').trigger('focus').trigger('select');
            } else {
                $('#login-pass').trigger('focus').trigger('select');
            }
        }
    );
}

/* Everything that happens once somebody is signed in, wherever they came from.

   ONE PLACE ON PURPOSE. There are three doors into the app - a password, a
   Google account, and signing up - and every one of them has to adopt the
   session, follow the account's saved theme, and land on the right home page. As
   three copies they would drift; the theme line in particular was the sort of
   thing that gets added to one and forgotten in the others.

   `greeting` overrides the default welcome, for the cases where "welcome back"
   would be wrong. */
function finishSignIn(account, greeting) {
    STATE.session = account;
    STATE.serverReady = true;

    /* THIS ACCOUNT'S OWN LOCAL STATE, now that we know which account it is.

       loadState() ran at boot with no session, so it only had the device-wide
       slice. Running it again picks up the per-account one - the client this
       representative was working on, which conversation was open, their call
       notes. Before the state was scoped, all of that was shared with whoever
       else had used this browser. */
    loadState();

    /* Follow the theme saved on the account, so somebody who chose dark on their
       laptop gets dark on their phone too. 'system' means "do not override". */
    if (account.prefs && account.prefs.theme && account.prefs.theme !== 'system') {
        STATE.theme = account.prefs.theme;
    }

    /* Tell the other tabs. Any of them still showing a different account will
       explain itself rather than quietly making requests as this one - see
       watchForOtherTab(). */
    claimSession(account.accountId);

    saveState();
    applyTheme();

    /* ----------------------------------------------------------------------
       EVERYTHING FROM HERE TO router() IS OPTIONAL, SO NONE OF IT MAY THROW.

       The sign-in has already succeeded. The session is adopted and saved. The
       only thing that still matters is drawing the first screen.

       This block used to be bare, and it cost us the single worst bug in the
       project: ONBOARDING.loadState() called API.getAssessment(), which did not
       exist, which threw TypeError - synchronously, right here, BEFORE
       router(). So the new screen was never drawn, the submit button never came
       out of its loading state, and the only way in was to reload the page,
       where a different code path took over. It presented as "signing in is
       slow" and as "I have to reload to get in", and neither pointed anywhere
       near the real cause.

       Background work must never be able to stop the foreground. Each piece is
       wrapped separately so one failure does not take the others with it, and
       the reason is reported rather than swallowed.
       ---------------------------------------------------------------------- */
    function tryStep(what, fn) {
        try {
            fn();
        } catch (e) {
            if (window.console && console.error) {
                console.error('PRUWise: "' + what + '" failed during sign-in, ' +
                    'carrying on without it.', e);
            }
        }
    }

    // Find out whether anything is waiting to be accepted, or somebody is calling
    tryStep('appointment alerts', startApptAlerts);
    tryStep('incoming call watch', startRingWatch);
    tryStep('idle sign-out watch', startIdleWatch);

    /* A brand new customer goes to the welcome screen rather than an empty
       dashboard. Anybody else goes to their usual home. */
    var destination = homePath();

    if (account.role === 'customer' && !account.onboardingSeen) {
        destination = '/onboarding/welcome';
    }

    /* Fetch the questions and any saved assessment NOW, for every customer,
       whichever screen they are heading to.

       WHY EAGERLY: this one request feeds three screens - the welcome, the
       questionnaire and the dashboard - and it is the difference between the
       assessment opening instantly and showing a spinner for a second. It costs
       one request at a moment when the person is still reading a toast. */
    if (account.role === 'customer' && window.ONBOARDING) {
        tryStep('assessment prefetch', function () { ONBOARDING.loadState(); });
    }

    UI.toast({
        title: greeting ? greeting.title : 'Welcome back, ' + account.name.split(' ')[0],
        message: greeting ? greeting.message : (account.role === 'fr'
            ? 'Your dashboard is ready.'
            : 'Your protection summary is ready.'),
        tone: 'ok'
    });

    /* ----------------------------------------------------------------------
       DRAW THE NEW SCREEN OURSELVES, DO NOT WAIT TO BE TOLD.

       go() sets window.location.hash and relies on the browser firing
       "hashchange" to run the router. That is normally fine, but it fails here
       for a reason that is easy to miss: if the hash is ALREADY the destination,
       the browser fires nothing at all.

       Which happens more often than it sounds. Somebody signs out (hash becomes
       #/login), signs back in, and the destination is the same address they were
       on before the sign-out. Or a failed first attempt already moved the hash.
       The address bar then says the right thing, the session is real, and the
       screen still shows the login form until you reload - which is exactly the
       bug that was reported, twice, for sign-up and for sign-in.

       Setting the hash and calling router() directly makes the render
       unconditional. If hashchange does also fire, router() simply runs a second
       time and paints the same screen - wasteful for a few milliseconds, and far
       better than a login that appears not to work.
       ---------------------------------------------------------------------- */
    var target = '#' + destination;

    if (window.location.hash !== target) {
        window.location.hash = target;
    }

    /* IF THE RENDER THROWS, DO NOT LEAVE THEM ON A DEAD LOGIN FORM.

       The sign-in is already complete at this point - session adopted, state
       saved, hash set. If router() then throws on its way through a page's
       render(), the exception escapes back into the login handler, the submit
       button never gets re-enabled, and the person is looking at a spinning
       "Signing in..." for a login that actually succeeded. Indistinguishable
       from the reload bug we just fixed, and far harder to work out.

       So catch it, put them somewhere that definitely draws, and say what
       happened. Reporting to the console as well, because a swallowed exception
       is how a small bug becomes an unexplainable one. */
    try {
        router();
    } catch (e) {
        if (window.console && console.error) {
            console.error('PRUWise: the first screen after sign-in failed to draw', e);
        }

        UI.toast({
            title: 'Signed in',
            message: 'That screen would not load. Showing your home page instead.',
            tone: 'warn'
        });

        window.location.hash = '#' + homePath();

        // If even the home page throws there is nothing left to try but a reload
        try { router(); } catch (e2) { window.location.reload(); }
    }
}

/* ==========================================================================
   SIGNED OUT AFTER A WHILE DOING NOTHING
   --------------------------------------------------------------------------
   WHY THIS EXISTS AT ALL. The session cookie lasts until the browser closes,
   which is fine on your own laptop and not fine anywhere else. This app is
   demonstrated on shared screens and in labs, and it holds real conversations
   and somebody's financial profile. A tab left open on a machine other people
   use is the realistic risk here, not an attacker.

   HOW IT DECIDES SOMEBODY IS IDLE. Any of the events below resets the clock.
   Deliberately NOT counting the pollers: a page that keeps itself signed in by
   asking the server what time it is has no timeout at all. Idle means the
   PERSON has stopped, not the JavaScript.

   A WARNING FIRST, NOT A SURPRISE. Being thrown out mid-sentence with no notice
   is its own bug. One minute before the deadline a dialog appears with a
   countdown and a "Stay signed in" button, so the only people who get signed
   out are the ones who genuinely are not there.

   NEVER DURING A CALL. A video consultation can legitimately run for half an
   hour with nobody touching the keyboard, and dropping the session mid-call
   would end the call. Being on the call screen counts as being present.
   ========================================================================== */

var IDLE_MINUTES  = 20;    // total, from the last thing the person did
var IDLE_WARN_SEC = 60;    // how long the warning is on screen before it acts

var idleTimer  = null;
var idleWarnAt = null;     // timestamp the warning is due, or null
var idleTick   = null;

function startIdleWatch() {
    stopIdleWatch();

    /* passive: true tells the browser we will not call preventDefault, so it
       does not have to wait for us before scrolling - these fire constantly and
       a non-passive scroll listener is a well-known cause of jank. */
    var opts = { passive: true };
    var events = ['mousedown', 'keydown', 'touchstart', 'scroll', 'wheel', 'click'];

    for (var i = 0; i < events.length; i++) {
        document.addEventListener(events[i], noteActivity, opts);
    }

    // Coming back to the tab is also a sign of life
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { noteActivity(); }
    });

    noteActivity();
}

function stopIdleWatch() {
    if (idleTimer) { window.clearInterval(idleTimer); idleTimer = null; }
    if (idleTick)  { window.clearInterval(idleTick);  idleTick  = null; }
    idleWarnAt = null;
}

/* Called on every interaction, so it has to be cheap: one assignment, and a
   dialog dismissal only if one is actually open. */
function noteActivity() {
    STATE.lastSeenAt = Date.now();

    if (idleWarnAt !== null) {
        idleWarnAt = null;
        if (idleTick) { window.clearInterval(idleTick); idleTick = null; }
        if ($('#idle-warning').length) { UI.closeModal(); }
    }

    if (!idleTimer) {
        // Checked every 15 seconds, which is precise enough for a 20 minute rule
        idleTimer = window.setInterval(checkIdle, 15000);
    }
}

function checkIdle() {
    if (!STATE.session) { stopIdleWatch(); return; }

    // A call is presence, even with no input for half an hour
    if (window.location.hash.indexOf('/call') !== -1) { STATE.lastSeenAt = Date.now(); return; }

    var idleMs = Date.now() - (STATE.lastSeenAt || Date.now());
    var limit  = IDLE_MINUTES * 60000;

    if (idleWarnAt !== null) { return; }              // already warning

    if (idleMs >= limit - IDLE_WARN_SEC * 1000) {
        idleWarnAt = Date.now() + IDLE_WARN_SEC * 1000;
        showIdleWarning();
    }
}

function showIdleWarning() {
    UI.openModal({
        title: 'Still there?',
        size: 'sm',
        body: '<div id="idle-warning" class="stack-3">' +
            '<div class="t-sm muted">You have not done anything for a while, so we are ' +
            'about to sign you out. This is to protect your details on a shared computer.</div>' +
            '<div class="idle-count"><span id="idle-secs">' + IDLE_WARN_SEC + '</span> seconds</div>' +
            '</div>',
        foot: UI.btn({ label: 'Sign me out now', variant: 'ghost', act: 'idle-logout' }) +
              UI.btn({ label: 'Stay signed in', icon: 'check', act: 'idle-stay' })
    });

    idleTick = window.setInterval(function () {
        if (idleWarnAt === null) { return; }

        var left = Math.max(0, Math.round((idleWarnAt - Date.now()) / 1000));
        $('#idle-secs').text(left);

        if (left <= 0) {
            window.clearInterval(idleTick);
            idleTick = null;
            idleLogout('You were signed out after ' + IDLE_MINUTES + ' minutes of inactivity.');
        }
    }, 1000);
}

/* Signing out for real. Same order as the manual sign-out: clear our own screen
   first so the UI is never sitting there looking signed in while a slow request
   finishes, then tell the server. */
function idleLogout(message) {
    stopIdleWatch();
    UI.closeModal();
    clearLocalSession();

    API.logout(false).then(done, done);

    function done() {
        go('/login');
        UI.toast({ title: 'Signed out', message: message, tone: 'info' });
    }
}

$(document).on('click', '[data-act="idle-stay"]', function () {
    UI.closeModal();
    noteActivity();
});

$(document).on('click', '[data-act="idle-logout"]', function () {
    idleLogout('Signed out at your request.');
});


/* ==========================================================================
   NOTIFICATIONS
   --------------------------------------------------------------------------
   Two sources, deliberately kept apart:

     REAL appointment alerts, from the database. Somebody has asked for a meeting
     and is waiting on you, or one you asked for has been agreed. These matter,
     so they go at the top.

     The mock activity feed in js/data.js, which is demo colour.

   Both are dismissed the same way - by id, into STATE.readNotifs - so an
   appointment alert stops nagging once it has been looked at.
   ========================================================================== */

/* Fetch the appointments that want attention, and update the red dot.

   Quiet on failure. A notification bell is not worth an error message: if the
   request fails the badge simply does not appear, and the calendar itself will
   say what is wrong when somebody opens it. */
/* Start checking, and keep checking.

   The interval is created ONCE however many times this is called - signing in,
   reloading and re-rendering all reach it, and three overlapping timers polling
   the same endpoint would be a silly way to make the app feel slow. */
var apptAlertTimer = null;

function startApptAlerts() {
    refreshApptAlerts();

    if (apptAlertTimer) { return; }

    /* A minute. Appointments are not chat - nobody needs to know within two
       seconds that a meeting three days away was accepted. */
    apptAlertTimer = window.setInterval(function () {
        if (pageIsHidden()) { return; }
        if (STATE.session) { refreshApptAlerts(); }
    }, 60000);

    onPageVisible(function () {
        if (STATE.session) { refreshApptAlerts(); }
    });
}

/* ==========================================================================
   POLLING WHILE NOBODY IS LOOKING

   This app polls: incoming calls every four seconds, messages every two, a live
   call every one. That is the right behaviour for a window somebody is watching
   and a waste for one they are not.

   THE ARITHMETIC. A single tab left open all day on the ring poll alone is
   4 requests a minute, 5,760 an hour, about 21,000 a day - every one of them a
   function invocation, and almost all of them answering "no, nobody is calling"
   to a screen nobody can see.

   WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO

   It skips the REQUEST while the page is hidden. It does NOT clear and recreate
   the timers. Tearing intervals down and building them back up on every tab
   switch is how you end up with two of them running, or none - and this file
   already carries comments about both of those bugs. A one-line guard inside the
   callback cannot produce either.

   ON COMING BACK, EVERY PAUSED POLLER FIRES IMMEDIATELY rather than waiting out
   the rest of its interval. That makes this a UX improvement as well as a saving:
   browsers already throttle timers in a background tab to roughly once a minute,
   so the old behaviour was "up to sixty seconds stale when you look back". Now it
   is current by the time the tab has finished painting.

   THE LIVE CALL IS EXEMPT. See startSync() in js/call.js. A hidden tab during a
   call still has to exchange signalling, or the call quietly dies the moment
   somebody looks at another window.
   ========================================================================== */

/* document.hidden is supported everywhere this app runs. The `!== false` shape
   means an environment that does not report visibility at all is treated as
   VISIBLE, so a missing API can only ever cost bandwidth - never break polling. */
function pageIsHidden() {
    return document.hidden === true;
}

/* Callbacks to run the moment the page comes back into view. Each poller adds
   its own tick here instead of every poller adding its own event listener. */
var visibilityWakers = [];

function onPageVisible(fn) {
    visibilityWakers.push(fn);
}

$(document).on('visibilitychange', function () {
    if (pageIsHidden()) { return; }

    visibilityWakers.forEach(function (wake) {
        /* One waker throwing must not stop the others - they are independent
           screens, and a broken one is not a reason for the rest to stay stale. */
        try { wake(); } catch (e) { console.error('Waking a poller failed:', e); }
    });
});


/* ==========================================================================
   INCOMING CALL

   The one urgent thing in this app. Everything else can wait for somebody to
   look at a screen; a person sitting in an empty call room is waiting in real
   time, and if the other side never finds out they give up.

   So this polls on its own timer, faster than the appointment alerts, from
   whatever page you happen to be on - and puts a banner across the top that
   cannot be missed.

   WHY IT IS NOT A TOAST: a toast disappears. If you were making coffee when it
   appeared, you never knew. The banner stays for as long as they are actually
   waiting, and removes itself the moment they hang up, because "ringing" is
   derived from their heartbeat rather than stored - see php/api/call-ring.php.
   ========================================================================== */

var ringTimer = null;
var ringDismissed = '';     // room code the user waved away, so it stays away
var ringInFlight = false;   // one ring check at a time - see checkRinging()

function startRingWatch() {
    checkRinging();

    if (ringTimer) { return; }

    /* Four seconds. Fast enough that somebody answers while the caller is still
       hopeful, slow enough to be a trivial query - see the note at the top of
       api/_routes/call-ring.ts about why this is the cheapest endpoint here.

       SKIPPED WHILE THE TAB IS HIDDEN, and that costs nothing: the whole output
       of this poll is a banner across the top of the page, which cannot be seen
       in a tab nobody is looking at. The waker below asks the moment they look
       back, so the banner is there as the tab paints rather than up to a minute
       later, which is what a throttled background timer actually gave. */
    ringTimer = window.setInterval(function () {
        if (pageIsHidden()) { return; }
        if (STATE.session) { checkRinging(); }
    }, 4000);

    onPageVisible(function () {
        if (STATE.session) { checkRinging(); }
    });
}

function stopRingWatch() {
    if (ringTimer) { window.clearInterval(ringTimer); ringTimer = null; }
    $('#ring-banner').remove();
}

function checkRinging() {
    if (!STATE.session || STATE.session.role === 'admin') { return; }

    /* Already on the call screen? Then you are in the room, or about to be, and
       a banner telling you somebody is calling would be absurd. */
    if (window.location.hash.indexOf('/call') !== -1) { $('#ring-banner').remove(); return; }

    /* NEVER TWO AT ONCE.

       setInterval does not care whether the last callback finished. If a poll
       takes longer than four seconds - a slow connection, a busy shared host -
       the next one starts anyway, and now there are two. Stay slow and they
       stack up: three, four, ten requests all asking the same question, each one
       making the host slower, which makes the next one slower still.

       One boolean stops it. A skipped poll costs four seconds of delay on a
       banner; a pile-up costs the whole tab. */
    if (ringInFlight) { return; }
    ringInFlight = true;

    API.callRinging().then(function (data) {
        ringInFlight = false;

        var ring = data.ringing;

        if (!ring) { $('#ring-banner').remove(); return; }

        // They dismissed this particular call already
        if (ring.roomCode === ringDismissed) { return; }

        drawRingBanner(ring);

    }, function () {
        // A missed poll is not worth telling anybody about - just allow the next
        ringInFlight = false;
    });
}

function drawRingBanner(ring) {
    var waited = ring.waitingSeconds;
    var waitText = (waited < 60)
        ? 'waiting ' + waited + ' second' + (waited === 1 ? '' : 's')
        : 'waiting ' + Math.floor(waited / 60) + ' minute' + (Math.floor(waited / 60) === 1 ? '' : 's');

    var firstName = String(ring.fromName || 'Someone').split(' ')[0];

    /* Redrawn in place when it already exists, so the wait counter ticks up
       without the banner flickering back into view every four seconds. */
    if ($('#ring-banner').length) {
        $('#ring-banner .ring-wait').text(waitText);
        return;
    }

    $('body').prepend(
        '<div id="ring-banner" class="ring-banner" role="alert">' +
        '<span class="ring-pulse">' + UI.icon('video', 18) + '</span>' +
        '<span class="ring-text">' +
        '<strong>' + FMT.esc(firstName) + ' is calling you</strong>' +
        '<span class="ring-wait">' + waitText + '</span>' +
        '</span>' +
        '<span class="ring-actions">' +
        '<button type="button" class="btn btn-white btn-sm" data-act="ring-answer">' +
        UI.icon('video', 15) + '<span>Answer</span></button>' +
        '<button type="button" class="iconbtn ring-dismiss" data-act="ring-dismiss" ' +
        'data-room="' + FMT.esc(ring.roomCode) + '" aria-label="Dismiss">' +
        UI.icon('x', 16) + '</button>' +
        '</span>' +
        '</div>'
    );
}


function refreshApptAlerts() {
    if (!STATE.session) { return; }

    /* ------------------------------------------------------------------
       THE REAL NOTIFICATIONS, from the notifications table.

       This is the half the bell was missing entirely. PRUWise could read a call
       transcript, work out that somebody's income had changed and that they
       wanted a meeting booked, write both down - and the bell went on reporting
       a number about the hard-coded activity feed in js/data.js. The one control
       somebody presses to ask "has anything happened" knew nothing about the most
       important thing that had.

       Admins get these too. A notification is about the account reading it and
       nobody else, so there is nothing to withhold - and a bell that 403s reads
       as a broken feature. ------------------------------------------------ */
    API.notifications.list(40).then(function (data) {
        STATE.notifs = data.notifications || [];
        STATE.notifUnread = Number(data.unread) || 0;

        paintBellDot();

        if ($('.drop .notif-list').length) {
            drawNotifDrop($('[data-act="notifs"]').closest('.drop-anchor'));
        }
    }, function () { /* a bell is not worth interrupting anybody over */ });

    /* Appointments stay a SEPARATE source rather than being written into the
       table, and that is deliberate. "A meeting is waiting for you to accept" is
       a STANDING STATE, not an event: it stops being true the moment somebody
       accepts, and it should stop nagging then too. A notification row is a
       record of a moment and would still be sitting there afterwards. */
    if (STATE.session.role === 'admin') { return; }

    API.upcomingAppointments(20).then(function (data) {
        STATE.apptAlerts = (data.appointments || []).filter(function (a) {
            /* Waiting on ME to accept - the one that genuinely needs doing. */
            if (a.status === 'pending' && !a.createdByMe) { return true; }

            /* Mine, and now agreed. Worth telling somebody about once. */
            if (a.status === 'confirmed' && a.createdByMe) { return true; }

            return false;
        });

        paintBellDot();

        // If the panel is open, redraw it in place
        if ($('.drop .notif-list').length) {
            drawNotifDrop($('[data-act="notifs"]').closest('.drop-anchor'));
        }
    }, function () { /* as above */ });
}

/* The red dot, added or removed rather than only toggled.

   .toggle() on a .dot that is not in the DOM does nothing, which is why the old
   version needed both branches and still missed the case where the count went from
   zero to non-zero on a bell that had never had a dot. One function, called from
   everywhere, so that cannot drift again. */
function paintBellDot() {
    var $bell = $('[data-act="notifs"]');
    if (!$bell.length) { return; }

    var some = unreadCount() > 0;
    var $dot = $bell.find('.dot');

    if (some && !$dot.length) { $bell.append('<span class="dot"></span>'); }
    else if (!some && $dot.length) { $dot.remove(); }
}

/* How many things are unread, across the sources. Drives the red dot. */
function unreadCount() {
    /* Counted by the SERVER for the real ones. It knows read_at; the browser only
       knows what it has been told, and two answers to "how many are unread" is how
       a badge ends up disagreeing with the list under it. */
    var real = Number(STATE.notifUnread) || 0;

    var appts = (STATE.apptAlerts || []).filter(function (a) {
        return STATE.readNotifs.indexOf('appt-' + a.id + '-' + a.status) === -1;
    }).length;

    return real + appts;
}

/* One appointment alert, worded for whichever situation it is. */
function apptNotifRow(appt) {
    var needsMe = (appt.status === 'pending');
    var theirName = String(appt.withName || 'Someone').split(' ')[0];

    /* The read-key includes the STATUS, so the same appointment can notify twice
       for two different reasons - once as a request, and again once it is agreed -
       without the second one arriving pre-dismissed. */
    var key = 'appt-' + appt.id + '-' + appt.status;
    var isUnread = (STATE.readNotifs.indexOf(key) === -1);

    var link = (STATE.session.role === 'fr') ? '#/fr/calendar' : '#/me/calendar';

    return '<button type="button" class="notif' + (isUnread ? ' unread' : '') + '" ' +
        'data-act="open-notif" data-id="' + FMT.esc(key) + '" data-link="' + link + '">' +
        '<span class="notif-icon ' + (needsMe ? 'warn' : 'ok') + '">' +
        UI.icon(needsMe ? 'clock' : 'checkCircle', 16) + '</span>' +
        '<span class="grow">' +
        '<span class="notif-title">' + FMT.esc(needsMe
            ? theirName + ' asked for a meeting'
            : theirName + ' accepted your meeting') + '</span>' +
        '<span class="notif-text">' + FMT.esc(appt.title + ' - ' + FMT.friendly(appt.start) +
            (needsMe ? '. Tap to accept or suggest another time.' : '. It is confirmed.')) + '</span>' +
        '<span class="notif-time">' + FMT.relative(appt.start) + '</span>' +
        '</span></button>';
}

/* What kind of thing it is -> which icon and colour. One table, so a row in the
   bell and the same row on the log page cannot disagree about what amber means. */
var NOTIF_LOOK = {
    insight: { icon: 'sparkles',    tone: 'brand' },
    meeting: { icon: 'calendar',    tone: 'ok' },
    finance: { icon: 'dollarSign',  tone: 'warn' },
    policy:  { icon: 'shieldCheck', tone: 'ok' },
    message: { icon: 'messageCircle', tone: '' },
    system:  { icon: 'bell',        tone: '' }
};

/* One real notification row. */
function notifRow(n) {
    var look = NOTIF_LOOK[n.kind] || NOTIF_LOOK.system;

    /* A row with no link is still drawn, but as a plain block rather than a button
       - so nothing looks tappable and then does nothing. In practice every
        notification this app writes carries one; see _lib/notify.ts, where "if
        there is nowhere to send somebody there is nothing worth telling them" is
        the rule. */
    var tag = n.link ? 'button' : 'div';
    var attrs = n.link
        ? ' type="button" data-act="open-notif-row" data-id="' + FMT.esc(n.id) +
          '" data-link="' + FMT.esc(n.link) + '"'
        : '';

    return '<' + tag + ' class="notif' + (n.read ? '' : ' unread') + '"' + attrs + '>' +
        '<span class="notif-icon ' + look.tone + '">' + UI.icon(look.icon, 16) + '</span>' +
        '<span class="grow">' +
        '<span class="notif-title">' + FMT.esc(n.title) + '</span>' +
        (n.body ? '<span class="notif-text">' + FMT.esc(n.body) + '</span>' : '') +
        '<span class="notif-time">' + FMT.relative(n.at) + '</span>' +
        '</span></' + tag + '>';
}

function drawNotifDrop($anchor) {
    /* APPOINTMENTS FIRST, then everything else newest-first.

       Not because they are more interesting, but because they are the only ones
       where ANOTHER PERSON IS BLOCKED - somebody has asked for a meeting and cannot
       do anything until this is answered. The same principle the dashboard priority
       ranking uses.

       THE MOCK ACTIVITY FEED FROM js/data.js IS GONE FROM HERE. It was demo colour
       in the one place a person looks to find out whether anything real has
       happened, and it padded the list so the real rows scrolled out of sight. */
    var apptRows = (STATE.apptAlerts || []).map(apptNotifRow).join('');
    var realRows = (STATE.notifs || []).map(notifRow).join('');

    var rows = (apptRows + realRows) || UI.emptyState({
        icon: 'bell',
        title: 'Nothing new',
        text: 'PRUWise will tell you here when it notices something in a conversation, ' +
            'and when a meeting is booked or agreed.',
        plain: true
    });

    UI.openDrop($anchor,
        '<div class="drop-head"><span>Notifications</span>' +
        (unreadCount()
            ? UI.btn({ label: 'Mark all read', variant: 'ghost', size: 'xs', act: 'read-all' })
            : UI.badge('All read', 'ok')) +
        '</div><div class="notif-list">' + rows + '</div>' +

        /* A WAY TO SEE THE WHOLE LOG. The panel holds what fits; "the last time
           PRUWise mentioned my income" is a question somebody will ask a week
           later, and a dropdown is not where you answer it. */
        '<div class="menu" style="border-top:1px solid var(--divider)">' +
        '<a class="menu-item" href="#/notifications">' + UI.icon('clipboard', 16) +
        '<span class="grow">See the full log</span>' + UI.icon('chevronRight', 14) +
        '</a></div>',
        { wide: true });
}

function showLoginError(text) {
    $('#login-alert').html('<div class="login-alert" role="alert">' +
        UI.icon('alertCircle', 15) + '<span>' + FMT.esc(text) + '</span></div>');
}

// The same box, in green, for "that worked" messages on the login screen
function showLoginNote(text, tone) {
    $('#login-alert').html('<div class="login-alert ' + (tone || 'ok') + '" role="status">' +
        UI.icon(tone === 'info' ? 'info' : 'checkCircle', 15) +
        '<span>' + FMT.esc(text) + '</span></div>');
}


/* ==========================================================================
   THE RESET PASSWORD PAGE

   Reached from a link in an email:
       index.html#/reset-password?token=abc123...

   The token is checked with the server the moment the page opens, so an
   expired link says so straight away rather than after somebody has carefully
   typed a new password twice.
   ========================================================================== */
function renderResetPassword(token) {

    // A small wrapper so this page and the confirm page look like the login one
    function shell(inner) {
        return '<div class="login"><div class="login-pane" style="grid-column:1/-1">' +
            '<button type="button" class="iconbtn iconbtn-bordered theme-fab" data-act="theme" ' +
            'aria-label="Switch between light and dark theme">' +
            UI.icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18) + '</button>' +
            '<div class="login-card">' + inner + '</div></div></div>';
    }

    if (!token) {
        $('#root').html(shell(
            '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
            '<h1 class="login-title">That link is incomplete</h1></div>' +
            '<div class="login-panel">' +
            UI.callout({
                tone: 'warn', icon: 'alertTriangle', title: 'No reset code in the address',
                text: 'Open the link from your email again, or ask for a new one.'
            }) +
            UI.btn({ label: 'Back to login', block: true, icon: 'arrowLeft', href: '#/login' }) +
            '</div>'
        ));
        return;
    }

    // Loading state while we ask whether the token is still good
    $('#root').html(shell(
        '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
        '<h1 class="login-title">Checking your link</h1></div>' +
        '<div class="login-panel">' + UI.loadingState('One moment...') + '</div>'
    ));

    API.checkResetToken(token).then(

        function (data) {
            $('#root').html(shell(
                '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
                '<h1 class="login-title">Choose a new password</h1>' +
                '<p class="login-sub">For the account <strong>' + FMT.esc(data.username) +
                '</strong>. This link expires ' + FMT.relative(data.expiresAt) + '.</p></div>' +

                '<div class="login-panel">' +
                '<form class="login-form" id="reset-form" novalidate>' +

                '<div class="field">' +
                '<label class="field-label" for="new-pass">New password</label>' +
                '<span class="input-wrap has-icon has-btn">' +
                '<span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
                '<input class="input" id="new-pass" type="password" autocomplete="new-password" ' +
                'placeholder="At least 8 characters">' +
                '<button type="button" class="input-btn" data-act="reveal-new" ' +
                'aria-label="Show password">' + UI.icon('eye', 16) + '</button></span>' +
                '<div class="field-hint">Length beats complexity. A few unrelated words is ideal.</div>' +
                '</div>' +

                '<div class="field">' +
                '<label class="field-label" for="new-pass2">Confirm new password</label>' +
                '<span class="input-wrap has-icon">' +
                '<span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
                '<input class="input" id="new-pass2" type="password" autocomplete="new-password" ' +
                'placeholder="Type it again"></span>' +
                '</div>' +

                '<div id="reset-alert"></div>' +

                UI.callout({
                    tone: 'info', icon: 'info', title: 'You will be signed out everywhere',
                    text: 'Changing your password ends every other session. If somebody else had ' +
                        'access to your account, this removes it.'
                }) +

                UI.btn({
                    label: 'Set my new password', size: 'lg', block: true, type: 'submit',
                    iconRight: 'arrowRight', cls: 'reset-submit'
                }) +
                '</form>' +
                '</div>' +

                '<div class="login-foot"><button type="button" class="link" ' +
                'data-act="go-login">Back to login</button></div>'
            ));

            // Remember the token for the submit handler without putting it in the DOM
            pendingResetToken = token;
            $('#new-pass').trigger('focus');
        },

        function (err) {
            $('#root').html(shell(
                '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
                '<h1 class="login-title">This link has expired</h1></div>' +
                '<div class="login-panel"><div class="stack-4">' +
                UI.callout({
                    tone: 'warn', icon: 'clock', title: 'No longer usable', text: err.error
                }) +
                '<div class="t-sm muted">Reset links last about an hour and work once only, ' +
                'which is what stops an old email being a way in later.</div>' +
                UI.btn({ label: 'Back to login', block: true, icon: 'arrowLeft', href: '#/login' }) +
                '</div></div>'
            ));
        }
    );
}

/* Held in a variable rather than a hidden input, so the token is not sitting in
   the page for any script or browser extension to read. */
var pendingResetToken = '';

function submitNewPassword() {
    var $submit = $('.reset-submit');
    if ($submit.hasClass('is-loading')) { return; }

    var first = $('#new-pass').val();
    var second = $('#new-pass2').val();

    function problem(text, focusId) {
        $('#reset-alert').html('<div class="login-alert" role="alert">' +
            UI.icon('alertCircle', 15) + '<span>' + FMT.esc(text) + '</span></div>');
        $(focusId).trigger('focus').trigger('select');
    }

    if (!first) { return problem('Please choose a new password.', '#new-pass'); }

    /* Catching the mismatch here rather than at the server is the one piece of
       validation that genuinely belongs in the browser: the server only ever
       receives one password, so it cannot possibly check they matched. */
    if (first !== second) { return problem('Those two passwords do not match.', '#new-pass2'); }

    $('#reset-alert').empty();
    $submit.addClass('is-loading').prop('disabled', true);

    API.resetPassword(pendingResetToken, first).then(

        function (data) {
            pendingResetToken = '';

            // Straight to the login screen with the username already filled in
            STATE.rememberedUser = data.username;
            saveState();

            go('/login');

            window.setTimeout(function () {
                showLoginNote(data.message);
                $('#login-pass').trigger('focus');
            }, 60);
        },

        function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);
            problem(err.error, '#new-pass');
        }
    );
}


/* ==========================================================================
   THE CONFIRM EMAIL PAGE

   Also reached from an email link:
       index.html#/confirm-email?token=abc123...

   Nothing to fill in - opening the page IS the confirmation, so it does the
   work immediately and just reports what happened.
   ========================================================================== */
function renderConfirmEmail(token) {

    function shell(inner) {
        return '<div class="login"><div class="login-pane" style="grid-column:1/-1">' +
            '<div class="login-card">' + inner + '</div></div></div>';
    }

    function result(title, calloutHtml, buttonHtml) {
        return '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
            '<h1 class="login-title">' + title + '</h1></div>' +
            '<div class="login-panel"><div class="stack-4">' + calloutHtml + buttonHtml + '</div></div>';
    }

    if (!token) {
        $('#root').html(shell(result('That link is incomplete',
            UI.callout({
                tone: 'warn', icon: 'alertTriangle', title: 'No confirmation code in the address',
                text: 'Open the link from your email again.'
            }),
            UI.btn({ label: 'Continue', block: true, href: '#/login' })
        )));
        return;
    }

    $('#root').html(shell(result('Confirming your email',
        UI.loadingState('One moment...'), '')));

    API.confirmEmail(token).then(

        function (data) {
            /* If they are already logged in, their copy of the account is now
               out of date, so refresh it before moving on. */
            var onward = STATE.session ? homePath() : '/login';

            if (STATE.session) { STATE.session.email = data.email; }

            $('#root').html(shell(result('Email confirmed',
                UI.callout({
                    tone: 'ok', icon: 'checkCircle', title: data.message,
                    text: 'You can use this address to sign in and to reset your password.'
                }),
                UI.btn({ label: 'Continue', block: true, iconRight: 'arrowRight',
                         href: '#' + onward })
            )));
        },

        function (err) {
            $('#root').html(shell(result('Could not confirm that address',
                UI.callout({ tone: 'warn', icon: 'alertTriangle', title: 'Link not usable', text: err.error }) +
                '<div class="t-sm muted">You can send yourself a new confirmation link from ' +
                'Settings once you are signed in.</div>',
                UI.btn({ label: 'Continue', block: true, href: '#/login' })
            )));
        }
    );
}

/* --------------------------------------------------------------------------
   Sign-up (customers only)
   -------------------------------------------------------------------------- */
function doSignup() {
    var $submit = $('[data-act="do-signup"]');
    if ($submit.hasClass('is-loading')) { return; }

    var details = {
        name:     $.trim($('#su-name').val()),
        email:    $.trim($('#su-email').val()).toLowerCase(),
        username: $.trim($('#su-user').val()).toLowerCase(),
        password: $('#su-pass').val(),
        terms:    $('#su-terms').is(':checked')
    };

    $('#signup-alert').empty();
    $submit.addClass('is-loading').prop('disabled', true);

    /* Every rule is enforced in php/api/register.php - uniqueness especially,
       because only the database can answer "is this name taken" without a race.
       So we simply send it and let the server be the judge. */
    API.register(details).then(

        function (data) {
            /* register.php logs the new account straight in, so there is no
               second step and no password to re-type. */
            STATE.rememberedUser = data.account.username;

            UI.closeModal();

            finishSignIn(data.account, {
                title: 'Welcome to PRUWise, ' + data.account.name.split(' ')[0],
                message: 'Your account is ready.'
            });

            /* In development the confirmation link comes back in the response,
               because there is usually no mail server on a laptop. Opened after
               finishSignIn so it lands on top of the page they arrived at. */
            if (data.devLink) {
                showEmailDevLink('Confirm your email address', data.devLink, data.emailRoute);
            }
        },

        function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);

            $('#signup-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) + '<span>' + FMT.esc(err.error) + '</span></div>');

            // Focus the field the server named, if it named one
            var fieldToId = {
                name: '#su-name', email: '#su-email', username: '#su-user',
                password: '#su-pass', terms: '#su-terms'
            };
            if (err.field && fieldToId[err.field]) {
                $(fieldToId[err.field]).trigger('focus');
            }
        }
    );
}


/* --------------------------------------------------------------------------
   FORGOTTEN PASSWORDS
   -------------------------------------------------------------------------- */

function doForgotPassword() {
    var $submit = $('[data-act="send-reset"]');
    if ($submit.hasClass('is-loading')) { return; }

    var email = $.trim($('#reset-email').val()).toLowerCase();

    if (!email || email.indexOf('@') === -1) {
        $('#reset-alert').html('<div class="login-alert" role="alert">' +
            UI.icon('alertCircle', 15) + '<span>Please enter a valid email address.</span></div>');
        return;
    }

    $('#reset-alert').empty();
    $submit.addClass('is-loading').prop('disabled', true);

    API.forgotPassword(email).then(

        function (data) {
            UI.closeModal();

            /* The server deliberately gives the same answer whether or not the
               address exists, so that this form cannot be used to find out who
               has an account. We repeat its wording rather than improving on
               it, because "we sent it" would be a lie half the time. */
            UI.openModal({
                title: 'Check your email',
                size: 'sm',
                body: UI.callout({
                    tone: 'info', icon: 'mail', title: 'On its way, if that address is registered',
                    text: data.message
                }) +
                    (data.devLink
                        ? UI.callout({
                            tone: 'warn', icon: 'alertTriangle',
                            title: 'Development mode: no email was sent',
                            text: 'There is no mail server configured, so the link is below and a copy ' +
                                'was written to php/mail-log/.'
                        }) +
                        '<a class="btn btn-primary btn-block" href="' + data.devLink + '">' +
                        UI.icon('arrowRight', 15) + '<span>Open the reset link</span></a>'
                        : ''),
                foot: UI.btn({ label: 'Done', variant: 'ghost', act: 'close-modal' })
            });
        },

        function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);
            $('#reset-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) + '<span>' + FMT.esc(err.error) + '</span></div>');
        }
    );
}

/* Shown only while dev_mode is on. A confirmation link in the page would be
   readable by anything running on it, so the server never sends one in
   production - see the devLink notes in the PHP endpoints. */
function showEmailDevLink(what, link, route) {
    UI.openModal({
        title: 'Development mode',
        sub: 'No email was sent',
        size: 'sm',
        body: UI.callout({
            tone: 'warn', icon: 'alertTriangle',
            title: what + ' - link below',
            text: route === 'log'
                ? 'A copy was also written to php/mail-log/. Configure SMTP in php/config.php ' +
                  'to send real email.'
                : 'Email route: ' + route
        }) +
            '<a class="btn btn-primary btn-block" href="' + link + '">' +
            UI.icon('arrowRight', 15) + '<span>Open the link</span></a>',
        foot: UI.btn({ label: 'Later', variant: 'ghost', act: 'close-modal' })
    });
}


/* ==========================================================================
   7. EVENT HANDLERS
   --------------------------------------------------------------------------
   All clicks are handled here, using ONE listener per action attached to the
   document. This is "event delegation": because the listener sits on the
   document rather than the button, it keeps working for buttons we create
   later. That matters because we rebuild the page HTML constantly.

       $(document).on('click', '[data-act="theme"]', handler)
                   ^event      ^which elements       ^what to do
   ========================================================================== */

function bindHandlers() {

    /* ---------------------------------------------------------- login */

    /* The Log in button is type="submit", so both clicking it and pressing
       Enter in a field end up here. preventDefault stops the browser from
       reloading the page, which is the default behaviour for a form. */
    $(document).on('submit', '#login-form', function (e) {
        e.preventDefault();
        attemptLogin();
    });

    /* One-tap demo sign-in. Fills the real form and submits it through
       attemptLogin(), so there is exactly one login path in this app and the
       demo buttons cannot drift away from what a typed password does.

       The fields are filled visibly rather than posted behind the scenes, which
       also makes the demonstration clearer - whoever is watching sees which
       account is being used. */
    $(document).on('click', '[data-act="demo-login"]', function () {
        var $b = $(this);

        $('#login-user').val($b.data('user'));
        $('#login-pass').val($b.data('pass'));
        $('#login-alert').empty();

        attemptLogin();
    });

    // Show / hide the password
    $(document).on('click', '[data-act="reveal"]', function () {
        var $input = $('#login-pass');
        var nowText = ($input.attr('type') === 'password');
        $input.attr('type', nowText ? 'text' : 'password');
        $(this).html(UI.icon(nowText ? 'eyeOff' : 'eye', 16))
            .attr('aria-label', nowText ? 'Hide password' : 'Show password');
    });

    $(document).on('click', '[data-act="forgot"]', function () {
        UI.openModal({
            title: 'Reset your password',
            sub: 'We will email you a link',
            size: 'sm',
            body: '<div class="stack-4">' +
                '<div class="field"><label class="field-label" for="reset-email">Email address</label>' +
                '<span class="input-wrap has-icon"><span class="input-icon">' + UI.icon('mail', 16) + '</span>' +
                '<input class="input" id="reset-email" type="email" autocomplete="email" ' +
                'placeholder="you@example.com"></span>' +
                '<div class="field-hint">Use the address on your account. The link works once and ' +
                'expires within the hour.</div></div>' +
                '<div id="reset-alert"></div>' +
                '</div>',
            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Send reset link', icon: 'mail', act: 'send-reset' })
        });

        window.setTimeout(function () { $('#reset-email').trigger('focus'); }, 80);
    });

    // Enter inside the email field should submit too
    $(document).on('keydown', '#reset-email', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doForgotPassword(); }
    });

    $(document).on('click', '[data-act="send-reset"]', function () {
        doForgotPassword();
    });


    /* ---------------------------------------- the reset password page */

    $(document).on('submit', '#reset-form', function (e) {
        e.preventDefault();
        submitNewPassword();
    });

    // Its own reveal button, because this page has two password fields
    $(document).on('click', '[data-act="reveal-new"]', function () {
        var $input = $('#new-pass');
        var nowText = ($input.attr('type') === 'password');

        $input.attr('type', nowText ? 'text' : 'password');
        $(this).html(UI.icon(nowText ? 'eyeOff' : 'eye', 16))
            .attr('aria-label', nowText ? 'Hide password' : 'Show password');
    });

    $(document).on('click', '[data-act="go-login"]', function () {
        go('/login');
    });

    /* The server-is-down screen. A full reload rather than another API call,
       because whatever was wrong was probably fixed outside the browser. */
    $(document).on('click', '[data-act="retry-server"]', function () {
        window.location.reload();
    });


    /* -------------------------------------------------- incoming call */

    $(document).on('click', '[data-act="ring-answer"]', function () {
        $('#ring-banner').remove();

        /* Straight to your own side of the call screen. No room code needed -
           call-join.php works out which call you belong to from your own
           account, which is also why you cannot join somebody else's. */
        go(STATE.session.role === 'fr' ? '/fr/call' : '/me/call');
    });

    $(document).on('click', '[data-act="ring-dismiss"]', function () {
        /* Remembered by room code, so waving this call away does not also
           silence the next one. */
        ringDismissed = String($(this).data('room') || '');
        $('#ring-banner').remove();
    });

    /* Sign-up. Customers only - see the note in DEMO_ACCOUNTS about why
       representative accounts cannot be created here. */
    $(document).on('click', '[data-act="create-account"]', function () {
        UI.openModal({
            title: 'Create your account',
            sub: 'For clients. Representative accounts are issued by an administrator.',
            body: '<form id="signup-form" class="stack-4" novalidate>' +

                '<div class="field"><label class="field-label" for="su-name">Full name</label>' +
                '<input class="input" id="su-name" type="text" placeholder="As shown on your NRIC"></div>' +

                '<div class="field"><label class="field-label" for="su-email">Email address</label>' +
                '<input class="input" id="su-email" type="email" placeholder="you@example.com"></div>' +

                '<div class="field"><label class="field-label" for="su-user">Choose a username</label>' +
                '<input class="input" id="su-user" type="text" placeholder="e.g. jane.lim" autocomplete="off">' +
                '<div class="field-hint">Letters, numbers and dots. This is what you log in with.</div></div>' +

                '<div class="field"><label class="field-label" for="su-pass">Choose a password</label>' +
                '<input class="input" id="su-pass" type="password" placeholder="At least 8 characters"></div>' +

                '<label class="check"><input type="checkbox" id="su-terms">' +
                '<span>I agree to the terms of use and privacy policy</span></label>' +

                '<div id="signup-alert"></div>' +

                UI.callout({
                    tone: 'info', icon: 'info', title: 'What happens next',
                    text: 'Your account is created in the database and a representative is assigned to ' +
                        'you automatically. You will be signed in straight away. The policy figures you ' +
                        'see are sample data, since this is a prototype.'
                }) +
                '</form>',
            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Create account', icon: 'userPlus', act: 'do-signup' })
        });
    });

    // Pressing Enter inside the sign-up form should submit it
    $(document).on('submit', '#signup-form', function (e) {
        e.preventDefault();
        doSignup();
    });

    $(document).on('click', '[data-act="do-signup"]', function () {
        doSignup();
    });


    /* ------------------------------------------------- theme and drawer */

    /* The only way out of the session-clash overlay. A full reload rather than a
       router() call, because everything in memory belongs to the account that no
       longer owns the session - including whatever js/messages.js and js/call.js
       are holding. Starting over is the only state that is certainly consistent. */
    $(document).on('click', '[data-act="session-clash-reload"]', function () {
        window.location.reload();
    });

    $(document).on('click', '[data-act="theme"]', function () {
        toggleTheme();
    });

    $(document).on('click', '[data-act="burger"]', function () {
        STATE.drawerOpen = !STATE.drawerOpen;
        $('#sidebar').toggleClass('is-open', STATE.drawerOpen);
        $(this).toggleClass('is-open', STATE.drawerOpen).attr('aria-expanded', STATE.drawerOpen);

        if (STATE.drawerOpen) {
            // The dark background. Clicking it closes the drawer.
            $('.shell').append('<div class="scrim phone-only" data-act="close-drawer"></div>');
        } else {
            $('.scrim').remove();
        }
    });

    $(document).on('click', '[data-act="close-drawer"], .sidebar .navlink', function () {
        STATE.drawerOpen = false;
        $('#sidebar').removeClass('is-open');
        $('[data-act="burger"]').removeClass('is-open').attr('aria-expanded', 'false');
        $('.scrim').remove();
    });


    /* ----------------------------------------------------- dropdowns */

    $(document).on('click', '[data-act="notifs"]', function (e) {
        e.stopPropagation();     // stop the "click anywhere closes it" handler

        drawNotifDrop($(this).closest('.drop-anchor'));

        /* Ask again while it is open. Somebody opening the bell is exactly the
           moment they want the truth rather than whatever was cached a minute
           ago, and the panel redraws itself if anything changed. */
        refreshApptAlerts();
    });

    /* An APPOINTMENT alert. Dismissed locally, because it is a standing state and
       the key includes the status - see apptNotifRow(). */
    $(document).on('click', '[data-act="open-notif"]', function () {
        var id = $(this).data('id');
        var link = $(this).data('link');
        if (STATE.readNotifs.indexOf(id) === -1) { STATE.readNotifs.push(id); saveState(); }
        UI.closeDrops();
        if (link) { go(String(link).replace(/^#/, '')); }
    });

    /* A REAL notification. Marked read on the SERVER and then followed.

       ==============================================================
       IT NAVIGATES FIRST AND CONFIRMS AFTERWARDS
       ==============================================================

       The link is followed without waiting for the mark-read request. Somebody
       tapping a notification wants the screen it is about, not a spinner while a
       housekeeping write completes - and if the write fails the only consequence is
       that the row is still bold next time, which is a smaller problem than a
       tap that appeared to do nothing. */
    $(document).on('click', '[data-act="open-notif-row"]', function () {
        var id = Number($(this).data('id'));
        var link = String($(this).data('link') || '');

        /* Optimistic: the count drops now, so the dot goes the moment it is
           tapped. refreshApptAlerts() replaces both with the server's answer on
           the next poll, so a failed write self-corrects. */
        STATE.notifUnread = Math.max(0, (Number(STATE.notifUnread) || 0) - 1);

        STATE.notifs = (STATE.notifs || []).map(function (n) {
            return Number(n.id) === id ? $.extend({}, n, { read: true }) : n;
        });

        paintBellDot();
        UI.closeDrops();

        if (link) { go(link.replace(/^#/, '')); }

        API.notifications.read(id).then(function () { }, function () { });
    });

    $(document).on('click', '[data-act="read-all"]', function (e) {
        e.stopPropagation();

        /* The appointment alerts, keyed the same way apptNotifRow() keys them -
           id AND status, so accepting one later can still notify. */
        (STATE.apptAlerts || []).forEach(function (a) {
            var key = 'appt-' + a.id + '-' + a.status;
            if (STATE.readNotifs.indexOf(key) === -1) { STATE.readNotifs.push(key); }
        });

        saveState();

        /* And the real ones, on the server, so they are read on every device the
           person uses rather than only this browser. */
        STATE.notifUnread = 0;
        STATE.notifs = (STATE.notifs || []).map(function (n) {
            return $.extend({}, n, { read: true });
        });

        paintBellDot();
        UI.closeDrops();
        router();      // redraw so the red dot disappears

        API.notifications.readAll().then(function () { }, function () { });
    });

    $(document).on('click', '[data-act="profile"]', function (e) {
        e.stopPropagation();
        var isFr = STATE.session.role === 'fr';
        UI.openDrop($(this).closest('.drop-anchor'),
            '<div class="drop-head">' +
            UI.person({ name: STATE.session.name, meta: STATE.session.username, size: 'sm', seed: STATE.session.personId }) +
            '</div><div class="menu">' +
            '<a class="menu-item" href="#/settings">' + UI.icon('settings', 16) +
            '<span class="grow">Settings and my account</span></a>' +
            (STATE.session.role === 'admin'
                ? '<a class="menu-item" href="#/admin/users">' + UI.icon('users', 16) +
                  '<span class="grow">Manage users</span></a>'
                : '<a class="menu-item" href="#' + (isFr ? '/fr/dashboard' : '/me/representative') + '">' +
                  UI.icon(isFr ? 'grid' : 'user', 16) +
                  '<span class="grow">' + (isFr ? 'My dashboard' : 'My representative') + '</span></a>') +
            '<div class="menu-sep"></div>' +
            '<button type="button" class="menu-item is-bad" data-act="logout">' + UI.icon('logOut', 16) +
            '<span class="grow">Log out</span></button>' +
            '</div>');
    });

    /* The [data-act="ctx-switch"] dropdown that used to live here has gone with
       the topbar control that opened it - see the note where ctxSwitch was built.
       It listed DATA.customers, which is the six sample people, so on top of being
       a duplicate source of truth it could set the active client to somebody the
       signed-in representative does not advise.

       pick-customer STAYS. It is how the client list and several cards say "work
       on this person", and those are all places where a client is the subject of
       the screen. */
    $(document).on('click', '[data-act="pick-customer"]', function () {
        STATE.activeCustomerId = $(this).data('id');
        saveState();
        UI.closeDrops();
        router();
    });

    // Click anywhere else to close any open dropdown
    $(document).on('click', function (e) {
        if (!$(e.target).closest('.drop, .drop-anchor').length) { UI.closeDrops(); }
    });


    /* ------------------------------------------------ session actions */

    $(document).on('click', '[data-act="logout"]', function () {
        UI.closeDrops();
        UI.confirmModal({
            title: 'Log out?',
            message: 'You will go back to the login screen. Your demo progress is cleared.',
            confirmLabel: 'Log out',
            tone: 'danger',
            confirmAct: 'confirm-logout'
        });
    });

    $(document).on('click', '[data-act="confirm-logout"]', function () {
        UI.closeModal();

        /* Clear the screen and the camera first, then tell the server. Doing it
           in this order means the UI never sits there looking logged in while a
           slow request finishes. */
        clearLocalSession();

        API.logout(false).then(finish, finish);

        function finish() {
            UI.toast({ title: 'Signed out', tone: 'info' });
            go('/login');
        }
    });

    /* There is deliberately no "view as the other role" shortcut any more.

       You are who you signed in as - that is what having real accounts means.
       To see both sides of a conversation, open a second browser window (or a
       private window) and sign in there as the other person. Messages and video
       calls genuinely link the two accounts together, so that is now a better
       demo than a fake switch ever was. */


    /* ------------------------------------------- modal, toast, tabs */

    $(document).on('click', '[data-act="close-modal"]', function () {
        UI.closeModal();
    });

    // Clicking the dark background closes the modal, but clicking the white
    // panel must not. e.target is the exact element clicked.
    $(document).on('mousedown', '#modal-scrim', function (e) {
        if (e.target === this) { UI.closeModal(); }
    });

    $(document).on('click', '[data-act="close-toast"]', function () {
        $(this).closest('.toast').fadeOut(150, function () { $(this).remove(); });
    });

    // Escape closes whatever is open
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') {
            if ($('#modal-scrim').length) { UI.closeModal(); }
            else if ($('.drop').length) { UI.closeDrops(); }
            else if (STATE.drawerOpen) { $('[data-act="close-drawer"]').first().trigger('click'); }
        }
    });

    /* ------------------------------------------------ read aloud

       One handler for every "Read aloud" button in the app. Toggles: pressing it
       again stops, which is the behaviour somebody expects from a button that is
       currently making noise and the reason it is aria-pressed rather than a
       one-way action.

       The text comes from the data attribute rather than the bubble's own text -
       see UI.speakBtn for why. */
    $(document).on('click', '[data-act="speak"]', function () {
        var $btn = $(this);
        var wasOn = $btn.attr('aria-pressed') === 'true';

        UI.speech.stop();       /* clears every button's state too */

        if (wasOn) { return; }

        var ok = UI.speech.say($btn.data('text'), {
            lang: $btn.data('lang') || undefined,
            onEnd: function () {
                $btn.removeClass('is-speaking').attr('aria-pressed', 'false');
            }
        });

        if (!ok) {
            UI.toast({
                tone: 'warn',
                title: 'Cannot read that aloud',
                message: 'This browser has no speech voices available.'
            });
            return;
        }

        $btn.addClass('is-speaking').attr('aria-pressed', 'true');
    });

    /* ------------------------------------------------ the warning marker

       Click toggles it open, which is what makes UI.warnDot() work on a phone
       where there is no hover at all. `aria-expanded` is the state CSS reads, so
       there is one source of truth rather than a class and an attribute that can
       disagree.

       Opening one closes the others. Two explanation panels open at once overlap
       and neither can be read. */
    $(document).on('click', '[data-act="warn-toggle"]', function (e) {
        e.stopPropagation();

        var $btn = $(this);
        var open = $btn.attr('aria-expanded') === 'true';

        $('[data-act="warn-toggle"]').not($btn).attr('aria-expanded', 'false');
        $btn.attr('aria-expanded', open ? 'false' : 'true');
    });

    /* Anywhere else closes it, matching how the notification and profile drops
       already behave. Escape too, because a panel opened from the keyboard has to
       be closeable from the keyboard. */
    $(document).on('click', function () {
        $('[data-act="warn-toggle"]').attr('aria-expanded', 'false');
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') {
            $('[data-act="warn-toggle"]').attr('aria-expanded', 'false');
        }
    });

    $(document).on('click', '[data-act="tab"]', function () {
        UI.switchTab($(this).data('set'), $(this).data('tab'));
    });

    /* "Try again" - re-runs the current page's render and after(), which reissues
       whatever request failed. Cheap, keeps the session, and is the right answer
       for an ordinary hiccup. */
    $(document).on('click', '[data-act="reload"]', function () {
        router();
    });

    /* A REAL page load, which is a different thing and sometimes the only thing.

       router() cannot fix a problem that lives outside our JavaScript. The case
       that forced this button into existence: free hosting answers a request it
       does not recognise with a bot-check page that has to be executed to get
       past it. An XHR cannot execute anything, so retrying the XHR fails exactly
       the same way forever - only a top-level navigation lets the browser run the
       check and store its cookie.

       Clearing the one-reload guard first, because the person pressing this
       button is explicitly asking for the thing the guard exists to ration. */
    $(document).on('click', '[data-act="hard-reload"]', function () {
        try { window.sessionStorage.removeItem('pruwise.hostCheckReload'); } catch (e) {}
        window.location.reload();
    });


    /* --------------------------------------------------------- search */

    $(document).on('click focus', '[data-act="search"]', function () {
        $(this).trigger('blur');     // do not leave the topbar input focused
        openSearch();
    });

    $(document).on('input', '#search-input', function () {
        renderSearchResults($(this).val());
    });

    $(document).on('click', '[data-act="search-go"]', function () {
        var path = $(this).data('path');
        UI.closeModal();
        if (path) { go(path); }
    });

    $(document).on('click', '[data-act="search-term"]', function () {
        var term = DATA.findTerm($(this).data('term'));
        if (term) {
            $('#search-results').html(UI.termCard(term) +
                UI.btn({ label: 'Back to results', variant: 'ghost', size: 'sm', act: 'search-back' }));
        }
    });

    $(document).on('click', '[data-act="search-back"]', function () {
        renderSearchResults($('#search-input').val());
    });


    /* ------------------------------------------- shared page actions */

    // Open a customer profile
    $(document).on('click', '[data-act="open-customer"]', function () {
        var id = $(this).data('id');
        STATE.activeCustomerId = id;
        saveState();
        go('/fr/customer/' + id);
    });

    /* Open the PRUWise conversation, reading about this customer.
       focusAi() first, so Messages knows to open PRUWise rather than whichever
       conversation happened to be open last. */
    $(document).on('click', '[data-act="customer-navigator"]', function () {
        STATE.activeCustomerId = $(this).data('id');
        saveState();
        MESSAGES.focusAi();
        go('/fr/messages');
    });

    /* "Start call" / "Join call". Both sides use this same button, so we send
       people to their own version of the call screen. */
    $(document).on('click', '[data-act="start-call"]', function () {
        var id = $(this).data('id');
        if (id) { STATE.activeCustomerId = id; saveState(); }

        go(STATE.session && STATE.session.role === 'customer' ? '/me/call' : '/fr/call');
    });



    // Table rows in the customer list
    $(document).on('click keydown', '[data-act="row-customer"]', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter') { return; }
        var id = $(this).data('id');
        STATE.activeCustomerId = id;
        saveState();
        go('/fr/customer/' + id);
    });

    /* ------------------------------------------------- RELEASE A RECOMMENDATION

       WHAT THIS REPLACED, because the old version was actively misleading. It set
       STATE.sharedRecId in localStorage, opened a modal headed "Sent" that named
       the customer's email address, and did nothing else. Nothing was sent, the
       customer's screen never changed, and the record was per-browser. Everybody
       involved believed the feature worked.

       It is real now: /api/recommendations writes a row, and only released rows
       reach the customer. See the header of api/_routes/recommendations.ts for why
       a computed shortlist must not appear on a customer's screen unreviewed.

       THE NOTE IS REQUIRED. A one-click release would make this a rubber stamp on
       generated text, which is the thing the whole feature exists to prevent - so
       the representative writes a sentence in their own words and the server
       refuses anything shorter than fifteen characters. */
    $(document).on('click', '[data-act="share-rec"]', function () {
        var customer = DATA.getCustomer(STATE.activeCustomerId);
        if (!customer) { return; }

        var recId = $(this).data('rec');
        var rec = recId ? DATA.recById(recId) : DATA.topRec(customer.id);

        if (!rec) {
            UI.toast({ tone: 'warn', title: 'There is no recommendation to release yet' });
            return;
        }

        UI.openModal({
            title: 'Release to ' + customer.firstName,
            sub: 'Nothing reaches them until you do this',
            body: UI.kv([
                ['Recommendation', rec.product.name],
                ['Cover', rec.coverLabel],
                ['Estimated premium', rec.premiumLabel],
                ['Match', rec.fit + '%']
            ]) +

                '<div class="field" style="margin-top:var(--sp-4)">' +
                '<label class="field-label" for="rel-note">Your note to ' +
                FMT.esc(customer.firstName) + '</label>' +
                '<textarea class="textarea" id="rel-note" rows="4" maxlength="2000" ' +
                'placeholder="Why you are suggesting this, in your own words. ' +
                'This is the first thing they read."></textarea>' +
                '<div class="field-hint">They see this above anything the assistant ' +
                'wrote. It is what makes this your recommendation rather than the ' +
                'software\u2019s.</div>' +
                '</div>' +

                '<div id="rel-alert"></div>' +
                UI.disclaimer('short'),

            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({
                    label: 'Release it', icon: 'share', act: 'release-rec-go',
                    data: { rec: rec.id, person: customer.id }
                })
        });
    });

    $(document).on('click', '[data-act="release-rec-go"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        var note = $.trim(String($('#rel-note').val() || ''));

        /* Checked here as well as on the server, so the person typing finds out
           before a round trip. The server is still the one that decides. */
        if (note.length < 15) {
            $('#rel-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) +
                '<span>Please add a sentence in your own words first.</span></div>');
            $('#rel-note').trigger('focus');
            return;
        }

        var personId = String($btn.data('person'));
        var rec = DATA.recById(String($btn.data('rec')));

        $btn.addClass('is-loading').prop('disabled', true);

        API.recommendations.release(personId, rec, note).then(
            function () {
                UI.closeModal();
                UI.toast({
                    tone: 'ok',
                    title: 'Released to ' + (DATA.getCustomer(personId) || {}).firstName,
                    message: rec.product.name + ' is now visible on their side.'
                });
                router();
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                $('#rel-alert').html('<div class="login-alert" role="alert">' +
                    UI.icon('alertCircle', 15) +
                    '<span>' + FMT.esc(err.error) + '</span></div>');
            }
        );
    });

    /* Taking one back. Recorded as a withdrawal rather than deleted - "shown and
       then taken back" is a different fact from "never shown". */
    $(document).on('click', '[data-act="withdraw-rec"]', function () {
        var recId = String($(this).data('rec'));
        var personId = String($(this).data('person'));

        UI.confirmModal({
            title: 'Withdraw this recommendation?',
            message: 'It disappears from the client\u2019s side. The fact that you ' +
                'released it and then withdrew it stays on the record.',
            confirmLabel: 'Withdraw it',
            tone: 'danger',
            confirmAct: 'withdraw-rec-go',
            confirmData: { rec: recId, person: personId }
        });
    });

    $(document).on('click', '[data-act="withdraw-rec-go"]', function () {
        var recId = String($(this).data('rec'));
        var personId = String($(this).data('person'));
        UI.closeModal();

        API.recommendations.withdraw(personId, recId).then(
            function () {
                UI.toast({ tone: 'ok', title: 'Withdrawn' });
                router();
            },
            function (err) {
                UI.toast({ tone: 'bad', title: 'Could not withdraw that', message: err.error });
            }
        );
    });

    /* "Request a meeting" / "Reschedule", from anywhere in the app.

       This used to open a modal that took a date, said "nothing is really booked
       in this prototype", and threw it away. Appointments are real now, so it
       hands over to the calendar - which is the screen that knows how to book,
       check for clashes, and show whose turn it is to accept.

       Sending somebody to the calendar rather than reproducing a booking form
       here also means there is ONE booking form to keep correct. */
    $(document).on('click', '[data-act="reschedule"]', function () {
        go(STATE.session && STATE.session.role === 'fr' ? '/fr/calendar' : '/me/calendar');
    });


    /* ------------------------------------- talk to whoever the meeting is with

       Replaced "Add to calendar" as the button on an appointment card. Wanting to
       message the other person about a meeting is the thing that actually happens
       while looking at one; exporting it to Google is a once-per-booking chore,
       and it still lives on the Calendar screen and in the subscribable feed.

       The id carried here is the OTHER person, so the same button works from both
       sides - see the note in UI.apptCard. */
    $(document).on('click', '[data-act="appt-consult"]', function () {
        var personId = String($(this).data('id') || '');

        if (!personId) { return; }

        var isFr = STATE.session && STATE.session.role === 'fr';

        if (isFr) {
            /* Also sets the PRUWise subject, so if they switch to the assistant it
               is already reading about the person they were just looking at. */
            STATE.activeCustomerId = personId;
            saveState();
        }

        /* Ask for THAT conversation specifically. Navigating alone would open
           whichever thread happened to be open last, which for a button labelled
           "Consult" about a named meeting is the wrong one often enough to be
           annoying. MESSAGES.openWith handles both the already-here and the
           arriving-from-elsewhere cases. */
        if (window.MESSAGES) { MESSAGES.openWith(personId); }

        go(isFr ? '/fr/messages' : '/me/messages');
    });


    /* ------------------------------------------- add to a real calendar

       Still reachable from the Calendar screen. Both links come from the server:
       /api/appointment builds the Google URL with the times formatted the way
       Google expects, and the .ics link points at an endpoint that checks who is
       asking before handing the file over.

       Fetched rather than constructed here, because getting either one subtly
       wrong produces a calendar entry at the wrong time - which is worse than no
       button, since nobody checks. */
    $(document).on('click', '[data-act="appt-calendar"]', function () {
        var id = $(this).data('id');

        API.appointment(id).then(

            function (data) {
                var appt = data.appointment;

                UI.openModal({
                    title: 'Add to your calendar',
                    sub: appt ? appt.title : '',
                    size: 'sm',
                    body: UI.kv([
                        ['When', appt ? FMT.friendly(appt.start) + ', ' + FMT.time(appt.start) : '-'],
                        ['Length', appt ? appt.minutes + ' minutes' : '-'],
                        ['Where', appt ? appt.location : '-']
                    ]) +

                        '<div class="stack-3" style="margin-top:var(--sp-4)">' +

                        '<a class="btn btn-primary btn-block" target="_blank" rel="noopener" ' +
                        'href="' + FMT.esc(data.googleUrl) + '">' +
                        UI.icon('calendar', 15) + '<span>Add to Google Calendar</span></a>' +

                        /* download, not target=_blank. A .ics opened in a tab is a
                           page of text; downloaded, the operating system hands it
                           to whichever calendar app is installed - which is what
                           somebody on an iPhone or in Outlook actually needs. */
                        '<a class="btn btn-outline btn-block" download ' +
                        'href="' + FMT.esc(data.icsUrl) + '">' +
                        UI.icon('download', 15) + '<span>Download .ics file</span></a>' +

                        '</div>' +

                        UI.callout({
                            tone: 'info', icon: 'info',
                            title: 'It will not update itself',
                            text: 'This copies the meeting across once. If it is rescheduled in ' +
                                'PRUWise, add it again - or subscribe to your whole PRUWise ' +
                                'calendar from the Calendar screen, which does stay in step.'
                        }),

                    foot: UI.btn({ label: 'Done', variant: 'ghost', act: 'close-modal' })
                });
            },

            function (err) {
                UI.toast({ title: 'Could not load that meeting', message: err.error, tone: 'warn' });
            }
        );
    });

    /* Quick contact details. The real conversation happens in Messages, so the
       main button here takes you there. */
    $(document).on('click', '[data-act="contact-rep"]', function () {
        var rep = DATA.getRep($(this).data('id') || 'fr-001');
        var isCustomer = STATE.session.role === 'customer';

        UI.openModal({
            title: 'Contact ' + rep.name,
            sub: rep.replyTime,
            body: UI.kv([
                ['Phone', rep.phone],
                ['Email', rep.email],
                ['Office', rep.office],
                ['Languages', rep.languages.join(', ')]
            ]) +
                UI.callout({
                    tone: 'brand', icon: 'messageCircle', title: 'Messages is usually fastest',
                    text: 'You can send files and photos there too, and PRUWise will help you word the ' +
                        'awkward questions.'
                }),
            foot: UI.btn({ label: 'Close', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({
                    label: 'Open Messages', icon: 'messageCircle',
                    href: isCustomer ? '#/me/messages' : '#/fr/messages', act: 'close-modal'
                })
        });
    });

    // Customer saves a question suggested by the AI
    $(document).on('click', '[data-act="save-question"]', function () {
        var question = $(this).data('q');
        var index = STATE.questions.indexOf(question);
        var saved;

        if (index === -1) { STATE.questions.push(question); saved = true; }
        else { STATE.questions.splice(index, 1); saved = false; }
        saveState();

        $(this).toggleClass('btn-soft', saved).toggleClass('btn-ghost', !saved)
            .html(UI.icon(saved ? 'checkCircle' : 'bookmark', 13) +
                '<span>' + (saved ? 'Saved to my questions' : 'Save this question') + '</span>');

        UI.toast({
            title: saved ? 'Saved to your questions' : 'Removed from your questions',
            message: saved ? 'You can review the list before your appointment.' : '',
            tone: saved ? 'ok' : 'info'
        });
    });

    $(document).on('click', '[data-act="open-questions"]', function () {
        openQuestionList();
    });

    $(document).on('click', '[data-act="send-questions"]', function () {
        UI.closeModal();
        UI.toast({
            title: 'Sent to your representative',
            message: 'They will see your questions before your appointment.',
            tone: 'ok'
        });
    });
}


/* --------------------------------------------------------------------------
   Global search dialog
   -------------------------------------------------------------------------- */
function openSearch() {
    UI.openModal({
        title: 'Search',
        sub: 'Clients, policies, pages and plain-language explanations',
        size: 'lg',
        body: '<span class="search"><span class="input-icon">' + UI.icon('search', 16) + '</span>' +
            '<input class="input" id="search-input" type="search" autocomplete="off" ' +
            'placeholder="Search clients, policies or insurance terms..." aria-label="Search"></span>' +
            '<div id="search-results" class="stack-4"></div>',
        foot: null
    });
    renderSearchResults('');
}

function renderSearchResults(query) {
    var isFr = STATE.session.role === 'fr';
    var q = $.trim(String(query || '')).toLowerCase();

    var row = function (icon, title, meta, act, dataAttr) {
        return '<button type="button" class="menu-item" data-act="' + act + '" ' + dataAttr + '>' +
            UI.icon(icon, 16) +
            '<span class="grow"><span class="t-sm semi truncate">' + FMT.esc(title) + '</span>' +
            (meta ? '<span class="t-xs muted truncate">' + FMT.esc(meta) + '</span>' : '') + '</span>' +
            UI.icon('chevronRight', 14) + '</button>';
    };
    var group = function (label, rows) {
        return rows.length
            ? '<div class="stack-2"><div class="eyebrow">' + label + '</div>' +
            '<div class="stack-2" style="gap:2px">' + rows.join('') + '</div></div>'
            : '';
    };

    var pages = isFr
        ? [['/fr/dashboard', 'Dashboard'], ['/fr/customers', 'Clients'], ['/fr/pruwise', 'PRUWise'],
        ['/fr/messages', 'Messages'], ['/fr/recommendations', 'Policy recommendations'],
        ['/fr/call', 'Video consultation']]
        : [['/me/dashboard', 'Home'], ['/me/plans', 'My plans'], ['/me/pruwise', 'PRUWise'],
        ['/me/messages', 'Messages'], ['/me/appointments', 'Appointments'],
        ['/me/representative', 'My representative']];

    // Nothing typed yet: show useful shortcuts instead of an empty box
    if (!q) {
        $('#search-results').html(
            group('Jump to', pages.map(function (p) {
                return row('arrowRight', p[1], '', 'search-go', 'data-path="' + p[0] + '"');
            })) +
            group('Popular explanations', DATA.glossary.slice(0, 4).map(function (t) {
                return row('bookOpen', t.term, t.short, 'search-term', 'data-term="' + FMT.esc(t.term) + '"');
            }))
        );
        return;
    }

    var customerRows = isFr
        ? DATA.customers.filter(function (c) {
            return (c.name + ' ' + c.occupation + ' ' + c.segment + ' ' + c.tags.join(' ')).toLowerCase().indexOf(q) !== -1;
        }).slice(0, 5).map(function (c) {
            return row('user', c.name, c.age + ' | ' + c.occupation + ' | ' + c.segment,
                'search-go', 'data-path="/fr/customer/' + c.id + '"');
        })
        : [];

    var policyRows = DATA.policies.filter(function (p) {
        var inScope = isFr || p.customerId === STATE.session.personId;
        return inScope && (p.name + ' ' + p.category + ' ' + p.number).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5).map(function (p) {
        return row(p.icon, p.name, p.category + ' | ' + p.number, 'search-go',
            'data-path="' + (isFr ? '/fr/customer/' + p.customerId : '/me/plans') + '"');
    });

    var termRows = DATA.glossary.filter(function (t) {
        return (t.term + ' ' + t.short).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5).map(function (t) {
        return row('bookOpen', t.term, t.short, 'search-term', 'data-term="' + FMT.esc(t.term) + '"');
    });

    var pageRows = pages.filter(function (p) {
        return p[1].toLowerCase().indexOf(q) !== -1;
    }).map(function (p) {
        return row('arrowRight', p[1], '', 'search-go', 'data-path="' + p[0] + '"');
    });

    var total = customerRows.length + policyRows.length + termRows.length + pageRows.length;

    if (!total) {
        $('#search-results').html(UI.emptyState({
            icon: 'search',
            title: 'No matches for "' + query + '"',
            text: 'Try a client name, a policy name, or a term such as "rider" or "sum assured".',
            plain: true
        }));
        return;
    }

    $('#search-results').html(
        group('Clients', customerRows) +
        group('Policies', policyRows) +
        group('Explanations', termRows) +
        group('Pages', pageRows)
    );
}


/* --------------------------------------------------------------------------
   The customer's saved-question list
   -------------------------------------------------------------------------- */
function openQuestionList() {
    var customer = DATA.getCustomer(STATE.session.role === 'customer' ? STATE.session.personId : STATE.activeCustomerId);
    var rep = DATA.getRep(customer.repId);
    var saved = STATE.questions;

    var body = saved.length
        ? UI.callout({
            tone: 'info', icon: 'info', title: 'Bring this list with you',
            text: 'These are your questions, not a script. Your representative should be happy to work through all of them.'
        }) +
        '<div class="stack-3">' + saved.map(function (q, i) {
            return UI.talkpoint({ text: q, num: String(i + 1) });
        }).join('') + '</div>'
        : '<div class="t-sm muted">Ask PRUWise what you should discuss, then save the questions that feel ' +
        'relevant. They will appear here.</div>' +
        '<div class="stack-3">' + AI.questionsFor(customer).slice(0, 3).map(function (q) {
            return UI.talkpoint({ text: q.question, num: '?' });
        }).join('') + '</div>';

    UI.openModal({
        title: 'Questions for my representative',
        sub: saved.length ? saved.length + ' saved for your next conversation with ' + rep.name : 'Nothing saved yet',
        body: body,
        foot: UI.btn({ label: 'Close', variant: 'ghost', act: 'close-modal' }) +
            UI.btn({ label: 'Send to my representative', icon: 'send', act: 'send-questions' })
    });
}


/* Wipes everything about the current person from this browser.

   Called on log out and before switching accounts. Two things matter more than
   the rest: the camera, because without stopping it the indicator light stays on
   behind a logged-out screen, which is alarming and rightly so; and the message
   poller, because a timer left running would keep asking the server for one
   person's conversation after somebody else has signed in. */
function clearLocalSession() {
    STATE.session = null;
    STATE.openThreadId = null;
    STATE.threadOpened = false;
    STATE.apptAlerts = [];
    STATE.questions = [];
    STATE.donePoints = [];
    STATE.askedQuestions = [];
    STATE.callNotes = '';
    STATE.myCallNotes = '';
    STATE.sharedRecId = null;

    if (window.CALL) { CALL.stopCamera(); CALL.stopTranscribe(); }
    if (window.MESSAGES) { MESSAGES.stopPolling(); }

    /* Stop watching for calls, and take the banner down. Without this, a timer
       left running would keep asking the server about one person's calls after
       somebody else has signed in on the same browser. */
    stopRingWatch();

    /* And stop the idle clock, for the same reason - otherwise it would count
       down against whoever signs in next and sign THEM out early. */
    stopIdleWatch();

    saveState();
}


/* ==========================================================================
   8. START THE APP

   The order matters now that there is a server.

   We CANNOT draw anything until we know who is logged in, and only the server
   can tell us that. So the first thing that happens is a request to
   php/api/session.php, and the page shows a spinner until it answers.

   Drawing first and correcting afterwards would mean a visitor briefly sees
   somebody's dashboard before being bounced to the login screen, which looks
   like a security hole even when it is not.
   ========================================================================== */
$(function () {
    loadState();
    applyTheme();
    bindHandlers();

    /* Listening before the session request goes out, so a tab that loses the
       session while it is still starting up notices too. */
    watchForOtherTab();

    /* The onboarding screens bind their own clicks. Without this every button in
       the assessment flow does nothing at all, which is a very confusing bug to
       look at - the pages render perfectly and simply ignore you. */
    if (window.ONBOARDING) { ONBOARDING.init(); }

    // Follow the device theme while the user has not chosen one themselves
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (!STATE.theme) { applyTheme(); }
    });

    $(window).on('hashchange', router);

    if (!window.location.hash) {
        window.location.replace(window.location.pathname + window.location.search + '#/login');
    }

    /* Ask the server who we are. Both outcomes end in router(), so the app
       starts exactly once either way. */
    API.session().then(

        function (data) {
            STATE.serverReady = true;
            STATE.serverInfo = data.server || null;
            STATE.session = data.account || null;

            /* Reloading a signed-in tab: adopt this account's own local state, and
               claim the session so any OTHER tab still showing somebody else finds
               out. Both are no-ops when nobody is signed in. */
            if (STATE.session) {
                loadState();
                claimSession(STATE.session.accountId);
            }

            /* TURN THE MODEL ON, IF THERE IS ONE.

               ai.js starts with enabled:false and learns the answer from here,
               rather than carrying a flag somebody has to remember to edit. The
               key itself never reaches the browser - the server only says whether
               it has one, and every request goes through /api/ai.

               False keeps everything working on the built-in keyword rules, which
               is the demo default and costs nothing. */
            AI.configure(STATE.serverInfo);

            /* The account's saved theme wins over this device's, so signing in
               on a new machine looks the way you left it. */
            if (STATE.session && STATE.session.prefs &&
                STATE.session.prefs.theme && STATE.session.prefs.theme !== 'system') {
                STATE.theme = STATE.session.prefs.theme;
                applyTheme();
            }

            /* Already signed in from a previous visit - the cookie survived a
               reload - so start watching for appointment requests here too, not
               only after a fresh sign-in. The idle clock restarts as well, and
               it restarts from NOW rather than from whenever they last did
               something: a reload is itself an interaction. */
            if (STATE.session) { startApptAlerts(); startRingWatch(); startIdleWatch(); }

            router();
        },

        function (err) {
            STATE.serverReady = false;
            STATE.session = null;

            // Nothing else will work, so explain it properly instead of failing
            // into a login form that cannot possibly succeed.
            renderServerDown(err);
        }
    );
});


/* Shown when php/api/session.php cannot be reached at all. This is the screen
   somebody sees if they open index.html directly, if WAMP is not running, or
   if the php folder was not uploaded - so it names all three. */
function renderServerDown(err) {
    var openedAsFile = (window.location.protocol === 'file:');

    $('#root').html(
        '<div class="login"><div class="login-pane" style="grid-column:1/-1">' +
        '<div class="login-card">' +

        '<div class="login-brand">' + UI.logo({ size: 'xl', subtitle: null }) +
        '<h1 class="login-title">The server is not responding</h1>' +
        '<p class="login-sub">PRUWise now keeps accounts and messages in a database, so it needs ' +
        'PHP and MySQL running.</p></div>' +

        '<div class="login-panel"><div class="stack-4">' +

        UI.callout({
            tone: 'warn', icon: 'alertTriangle',
            title: openedAsFile ? 'This page was opened as a file' : 'Could not reach php/api/session.php',
            text: err && err.error ? err.error : 'No response from the server.'
        }) +

        (openedAsFile
            ? UI.callout({
                tone: 'brand', icon: 'arrowRight', title: 'Open it through WAMP instead',
                text: 'Put the project in C:\\wamp64\\www\\ and visit ' +
                    'http://localhost/Prudential_TheGoats/ - the address has to start with http, ' +
                    'not file.'
            })
            : '<div class="stack-3">' +
            '<span class="eyebrow">Things to check, in order</span>' +
            [
                'Is WAMP running? The tray icon should be green, not orange or red.',
                'Have you created php/config.php? Copy php/config.example.php to php/config.php.',
                'Have you run the installer? Open php/setup.php once - it creates the tables.',
                'Is MySQL up? An orange WAMP icon usually means MySQL stopped.'
            ].map(function (line, i) {
                return '<div class="spec">' + UI.icon('info', 15) +
                    '<span>' + (i + 1) + '. ' + FMT.esc(line) + '</span></div>';
            }).join('') + '</div>') +

        '<div class="card-actions">' +
        UI.btn({ label: 'Try again', icon: 'refresh', act: 'retry-server' }) +
        UI.btn({ label: 'Open the installer', variant: 'outline', icon: 'externalLink',
                 href: 'php/setup.php' }) +
        '</div>' +

        '</div></div></div></div></div>'
    );
}
