/* ==========================================================================
   pages-calendar.js
   --------------------------------------------------------------------------
   THE CALENDAR. One screen, shared by both roles:

     /fr/calendar   a representative's diary, across all their customers
     /me/calendar   a customer's appointments with their representative

   A month grid, and under it whichever day you tapped. That is the whole design.
   Deliberately not a week view or a drag-and-drop planner: there are a handful of
   meetings a month here, and a month grid answers the only two questions anybody
   actually has - "when am I busy" and "what is that thing on Thursday".

   ==========================================================================
   HOW BOOKING WORKS
   ==========================================================================

   Tap a day. Fill in four things. It is saved as a REQUEST, not a booking.

   Then the OTHER person accepts it. Whoever proposed the time is not the one who
   agrees it, because otherwise "confirmed" would mean nothing more than "somebody
   typed it in". So:

     a customer asks       -> the representative accepts    -> confirmed
     a representative asks -> the customer accepts          -> confirmed

   Until then it sits on both calendars in amber, and it shows up in the other
   person's notifications so it does not go unnoticed.

   ==========================================================================
   THE COLOURS MEAN SOMETHING
   ==========================================================================

     amber   waiting to be accepted   - somebody needs to do something
     red     confirmed                - it is happening
     green   done                     - it happened
     grey    cancelled                - it is not happening, struck through

   Colour is by STATUS, not by type, because status is the axis you act on. Every
   appointment here is the same KIND of thing - a meeting with your representative
   - so colouring by that would tell you nothing. The MODE (video, phone, in
   person) is a small icon instead, and there is a legend on screen, because a
   colour code nobody explains is decoration.

   Colour is never the only signal: every pill carries a time and a title, the
   legend spells the states out in words, and cancelled ones are struck through as
   well as greyed. Somebody who cannot tell red from green loses nothing.

   ==========================================================================
   DONE BY HAND, OR ON ITS OWN
   ==========================================================================

   Either, and the screen is honest about which:

     you pressed the button   -> "Marked as done"
     its time simply passed   -> "Closed automatically when the time passed"

   The second is a GUESS - the meeting might have been a no-show - so it says so,
   and there is a Reopen button to correct it. See php/lib/appointments.php.

   ==========================================================================
   TIME ZONES, BRIEFLY
   ==========================================================================

   The server speaks UTC and sends ISO strings. THIS SCREEN IS SINGAPORE TIME,
   both directions, always.

   It used to be the BROWSER's time, on the reasoning that "Thursday" means the
   viewer's Thursday. That reasoning is wrong for this product: there are exactly
   two people in every meeting and both of them are in Singapore. Following the
   browser meant a 9am Thursday meeting sat in Wednesday's cell for anybody
   opening the app from Europe, and the client and the representative could read
   different days off the same row.

   Coming in:  instantKey() and shortTime() read the Singapore clock.
   Going out:  FMT.sgInstant(date, time) writes '...T14:00+08:00', so 2pm means
               2pm in Singapore wherever the form was filled in.

   dayKey() survives for GRID LABELS only - "the 12th" as a cell in a month has
   no zone. See the note above the date helpers for why those are two jobs.
   ========================================================================== */

var CALENDAR = (function () {

    /* ---------------------------------------------------------------- state */
    var view;              // 'fr' or 'customer'
    var monthStart;        // a Date on the 1st of the month on screen
    var selectedDay;       // 'YYYY-MM-DD', the day open underneath
    var appointments = []; // everything in the visible range
    var people = [];       // who this person can book with
    var busy = false;      // a save is in flight
    var loadError = null;

    /* The subscribable calendar address, from the same response as the
       appointments. Held rather than re-requested because it does not change
       between months and asking again on every arrow press would be a round trip
       for a value we already have. See subscribeCard(). */
    var feedUrl = '';
    var webcalUrl = '';

    var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    /* Status -> how it looks and what it is called. ONE table, so the pill, the
       legend and the detail card can never disagree about what amber means. */
    var STATUS = {
        pending:   { cls: 'is-pending',   label: 'Waiting to be accepted', tone: 'warn' },
        confirmed: { cls: 'is-confirmed', label: 'Confirmed',              tone: 'brand' },
        completed: { cls: 'is-done',      label: 'Done',                   tone: 'ok' },
        cancelled: { cls: 'is-cancelled', label: 'Cancelled',              tone: '' }
    };

    var MODE_ICON = { video: 'video', 'in-person': 'mapPin', phone: 'phone' };
    var MODE_LABEL = { video: 'Video call', 'in-person': 'In person', phone: 'Phone call' };


    /* ======================================================================
       DATE HELPERS

       ==================================================================
       TWO DIFFERENT JOBS THAT LOOK LIKE ONE
       ==================================================================

       A GRID CELL is a label. "The 12th" is not an instant, it has no zone, and
       the Date objects gridDays() builds are just a convenient way to count
       forwards. Local midnight is fine for those and always was.

       AN APPOINTMENT IS AN INSTANT, and asking which day it falls on has exactly
       one correct answer: the day it is in SINGAPORE. Both people in the meeting
       are there. Using the browser's day here is what put a 9am Thursday meeting
       into Wednesday's cell for anybody demonstrating the app from Europe.

       So dayKey() is for labels and instantKey() is for appointments, with
       different names, because one function doing both is how they got confused.
       ====================================================================== */

    /* A grid-label Date -> 'YYYY-MM-DD'. No zone meaning. */
    function dayKey(date) {
        var month = String(date.getMonth() + 1);
        var day = String(date.getDate());

        return date.getFullYear() + '-' +
            (month.length < 2 ? '0' + month : month) + '-' +
            (day.length < 2 ? '0' + day : day);
    }

    /* An instant (ISO string or Date) -> the Singapore calendar day it is on. */
    function instantKey(input) { return FMT.sgDayKey(input); }

    /* Today in Singapore. NOT dayKey(new Date()) - that is today where the
       browser is, and "is this cell today" has to mean the same thing to both
       people looking at it. */
    function todayKey() { return FMT.sgDayKey(new Date()); }

    // 'YYYY-MM-DD' -> a Date at local midnight, for label arithmetic only
    function fromKey(key) {
        var parts = String(key).split('-');
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    /* The Monday of the week containing this date.

       getDay() gives 0 for Sunday and this grid starts on Monday, so Sunday has
       to count as 6 rather than 0 or every row shifts by a week. */
    function weekStart(date) {
        var out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        var weekday = (out.getDay() + 6) % 7;

        out.setDate(out.getDate() - weekday);
        return out;
    }

    /* The 42 days a six-row grid shows: the Monday on or before the 1st, then six
       weeks. ALWAYS six rows, so the grid keeps the same height as you page
       through months - otherwise the whole screen jumps under your thumb. */
    function gridDays() {
        var first = weekStart(monthStart);
        var days = [];

        for (var i = 0; i < 42; i++) {
            days.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
        }
        return days;
    }

    function sameMonth(date) {
        return date.getMonth() === monthStart.getMonth() &&
            date.getFullYear() === monthStart.getFullYear();
    }

    function monthLabel() {
        return MONTH_NAMES[monthStart.getMonth()] + ' ' + monthStart.getFullYear();
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    /* '2:00 PM' is too wide for a grid cell. '2pm' and '2:30pm' are not.
       Read off the Singapore clock, so it agrees with the day the meeting was
       filed under. */
    function shortTime(iso) {
        var p = FMT.sgParts(iso);
        if (!p) { return ''; }

        var suffix = p.hour < 12 ? 'am' : 'pm';
        var hour12 = p.hour % 12;

        if (hour12 === 0) { hour12 = 12; }

        return hour12 + (p.minute ? ':' + pad(p.minute) : '') + suffix;
    }


    /* ======================================================================
       LOADING
       ====================================================================== */

    /* Fetch the whole VISIBLE range, not the calendar month. The grid shows the
       tail of the previous month and the start of the next, and a meeting in one
       of those cells is just as real. A day of slack either side covers the few
       hours a local date can differ from the UTC one. */
    function load() {
        var days = gridDays();
        var from = new Date(days[0].getTime() - 86400000);
        var to = new Date(days[41].getTime() + 86400000);

        loadError = null;

        return API.appointments(dayKey(from), dayKey(to)).then(function (data) {
            appointments = data.appointments || [];
            people = data.people || [];

            /* The subscribable address. It has been in this response since the
               endpoint was written and nothing on this screen ever offered it -
               see subscribeCard(). */
            feedUrl = data.feedUrl || '';
            webcalUrl = data.webcalUrl || '';

            draw();
        }, function (err) {
            loadError = err.error;
            draw();
        });
    }

    // Everything on one local day, earliest first
    function forDay(key) {
        return appointments.filter(function (a) {
            return instantKey(a.start) === key;
        }).sort(function (a, b) {
            return new Date(a.start) - new Date(b.start);
        });
    }

    function findAppt(id) {
        for (var i = 0; i < appointments.length; i++) {
            if (appointments[i].id === id) { return appointments[i]; }
        }
        return null;
    }


    /* ======================================================================
       RENDER

       render() must return HTML at once - the router puts it on the page and then
       calls after(). So this is the frame, and after() fills in the days.
       ====================================================================== */
    function render() {
        view = (STATE.session.role === 'fr') ? 'fr' : 'customer';

        /* Open on the month containing today IN SINGAPORE, with today selected.
           Derived from todayKey() rather than from the browser's clock, so the
           selected day is guaranteed to be a day the grid actually contains. */
        selectedDay = todayKey();
        monthStart = fromKey(selectedDay.slice(0, 8) + '01');

        appointments = [];
        people = [];
        busy = false;

        return UI.pageHead({
            eyebrow: (view === 'fr') ? 'Your diary' : 'You and your representative',
            title: 'Calendar',
            sub: (view === 'fr')
                ? 'Every meeting with every client. Tap any day to see it or to book one.'
                : 'Your appointments. Tap any day to see what is happening, or to ask for a meeting.',
            actions: UI.btn({ label: 'Book a meeting', icon: 'plus', act: 'cal-book' })
        }) +
            '<div class="cal" id="cal">' + UI.loadingState('Loading your calendar...') + '</div>';
    }

    function after() { load(); }

    function draw() {
        if (loadError) {
            $('#cal').html(UI.errorState({
                title: 'Could not load your calendar',
                text: loadError,
                actions: UI.btn({ label: 'Try again', variant: 'outline', icon: 'refresh', act: 'cal-reload' })
            }));
            return;
        }

        $('#cal').html(monthBar() + legend() + grid() + dayPanel() + subscribeCard());
        UI.animateBars();
    }


    /* ======================================================================
       PUT THIS CALENDAR ON THE DEVICE, ONCE, AND LEAVE IT

       REQUESTED: "for the calendar can there be a button, or a button to auto
       save to save the future meetings on the calendar app on individual device
       and auto delete the task for both fr and clients".

       -----------------------------------------------------------------------
       THIS ALREADY WORKED AND WAS NOT OFFERED ANYWHERE
       -----------------------------------------------------------------------
       /api/appointments has returned `feedUrl` and `webcalUrl` since it was
       written, /api/calendar?feed=<token> serves a live iCalendar document, and
       scripts/smoke.mjs already proves the feed answers with NO COOKIE (the token
       is the authentication), that a wrong token is a flat 404, and that a
       cancelled meeting stays in the feed MARKED CANCELLED. Every part of the
       feature existed. There was no button.

       -----------------------------------------------------------------------
       SUBSCRIBE, NOT DOWNLOAD - AND THAT DISTINCTION IS THE WHOLE ANSWER
       -----------------------------------------------------------------------
       "Add to calendar" on an individual meeting copies it ACROSS ONCE. If the
       time then moves, the copy is wrong and silently wrong, which is worse than
       not having it.

       A subscription is a standing link. The calendar app re-reads it on its own
       schedule, so a new meeting appears by itself, a rescheduled one moves by
       itself, and a cancelled one is marked cancelled and drops out - which is the
       "auto save and auto delete" that was asked for. It works the same way for a
       representative and a client because it is the same endpoint.

       WHAT IT IS NOT: instant. Calendar apps decide their own refresh interval and
       most check every few hours, not every few minutes. The feed asks for 1 hour -
       smoke checks that too - but asking is all anybody can do. That is stated on
       screen rather than left to be discovered when somebody misses a meeting.

       THE ADDRESS IS A SECRET, because the token in it is what stands in for a
       login. So it is not printed as plain text to be read over somebody's
       shoulder; it is behind a copy button, and the wording says what it is.
       ====================================================================== */
    function subscribeCard() {
        if (!feedUrl) { return ''; }

        var isFr = !!(STATE.session && STATE.session.role === 'fr');

        return UI.card({
            title: 'Keep this calendar on your phone',
            sub: 'Subscribe once and it stays in step by itself',
            icon: 'calendar'
        },
            UI.callout({
                tone: 'info', icon: 'info',
                title: 'This is different from "Add to calendar"',
                text: 'Adding a single meeting copies it across once, and the copy does ' +
                    'not change if the time moves. Subscribing is a standing link: new ' +
                    'meetings appear on their own, changed ones move, and cancelled ones ' +
                    'are marked cancelled and drop off. Your calendar app decides how ' +
                    'often to check - usually every few hours, not instantly.'
            }) +

            '<div class="card-actions">' +

            /* webcal:// is claimed by the calendar app rather than the browser, so
               this is the one that produces "Subscribe to this calendar?" instead
               of downloading a file. Not target=_blank: handing a custom scheme to
               a new tab leaves an empty tab behind on several browsers. */
            '<a class="btn btn-primary" href="' + FMT.esc(webcalUrl) + '">' +
            UI.icon('calendar', 15) + '<span>Subscribe on this device</span></a>' +

            UI.btn({
                label: 'Copy the address', variant: 'outline', icon: 'clipboard',
                act: 'cal-copy-feed'
            }) +
            '</div>' +

            '<div class="t-xs muted">' + UI.icon('lock', 11) +
            ' Treat that address like a password: anyone who has it can read ' +
            (isFr ? 'your whole diary, including client names' : 'your meetings') +
            ' without signing in. You can replace it in Settings, which immediately ' +
            'stops the old one working.</div>'
        );
    }


    /* --- the month name, and how to move between months ------------------- */
    function monthBar() {
        return '<div class="cal-bar">' +
            '<div class="cal-month">' +
            UI.iconBtn({ icon: 'chevronLeft', label: 'Previous month', act: 'cal-prev', bordered: true }) +
            '<h2 class="h4">' + FMT.esc(monthLabel()) + '</h2>' +
            UI.iconBtn({ icon: 'chevronRight', label: 'Next month', act: 'cal-next', bordered: true }) +
            '</div>' +
            UI.btn({ label: 'Today', variant: 'ghost', size: 'sm', act: 'cal-today' }) +
            '</div>';
    }

    /* --- what the colours mean -------------------------------------------
       On screen, not in a tooltip. A colour code explained only on hover is no
       use on a phone, where there is no hover. */
    function legend() {
        var items = ['pending', 'confirmed', 'completed', 'cancelled'].map(function (key) {
            return '<span class="cal-key">' +
                '<span class="cal-key-dot ' + STATUS[key].cls + '"></span>' +
                FMT.esc(STATUS[key].label) + '</span>';
        }).join('');

        return '<div class="cal-legend">' + items + '</div>';
    }


    /* --- the month grid --------------------------------------------------- */
    function grid() {
        var heads = DAY_NAMES.map(function (name) {
            return '<div class="cal-dow">' + name + '</div>';
        }).join('');

        var cells = gridDays().map(function (date) {
            var key = dayKey(date);
            var items = forDay(key);
            var isToday = (key === todayKey());

            var cls = 'cal-day' +
                (sameMonth(date) ? '' : ' is-outside') +
                (isToday ? ' is-today' : '') +
                (key === selectedDay ? ' is-selected' : '');

            /* Two pills at most. A cell that grows with its contents makes the
               rows different heights and the whole grid lurches; the rest are one
               tap away. */
            var pills = items.slice(0, 2).map(pill).join('');

            var more = (items.length > 2)
                ? '<span class="cal-more">+' + (items.length - 2) + ' more</span>'
                : '';

            /* On a phone the pills are too small to read, so the cell shows dots
               instead - one per appointment, coloured by status. Same information,
               at a size that fits. CSS decides which is visible. */
            var dots = items.slice(0, 4).map(function (a) {
                var status = STATUS[a.status] || STATUS.pending;
                return '<span class="cal-dot ' + status.cls + '"></span>';
            }).join('');

            /* A real button, so the grid works by keyboard and announces itself.
               aria-label carries the full date and the count, because "14" on its
               own tells a screen reader nothing useful. */
            return '<button type="button" class="' + cls + '" data-act="cal-day" data-day="' + key + '" ' +
                'aria-label="' + FMT.esc(FMT.dateLong(date.toISOString()) + ', ' +
                    (items.length
                        ? items.length + ' appointment' + (items.length === 1 ? '' : 's')
                        : 'nothing booked')) + '"' +
                (key === selectedDay ? ' aria-current="date"' : '') + '>' +
                '<span class="cal-date">' + date.getDate() + '</span>' +
                '<span class="cal-items">' + pills + more + '</span>' +
                '<span class="cal-dots">' + dots + '</span>' +
                '</button>';
        }).join('');

        return '<div class="cal-grid">' + heads + cells + '</div>';
    }

    /* One appointment inside a day cell. Tiny on purpose - the detail lives in
       the panel below, this only has to say "something, roughly then". */
    function pill(appt) {
        var status = STATUS[appt.status] || STATUS.pending;

        return '<span class="cal-pill ' + status.cls + '">' +
            '<span class="cal-pill-time">' + FMT.esc(shortTime(appt.start)) + '</span>' +
            '<span class="cal-pill-text">' + FMT.esc(appt.title) + '</span>' +
            '</span>';
    }


    /* --- the selected day, in full ---------------------------------------- */
    function dayPanel() {
        var items = forDay(selectedDay);
        var date = fromKey(selectedDay);
        var isToday = (selectedDay === todayKey());

        var heading = UI.secHead({
            eyebrow: isToday ? 'Today' : '',
            title: FMT.dateLong(date.toISOString()),
            sub: items.length
                ? items.length + (items.length === 1 ? ' appointment' : ' appointments')
                : 'Nothing booked',
            actions: UI.btn({
                label: 'Book this day', variant: 'outline', size: 'sm', icon: 'plus',
                act: 'cal-book', data: { day: selectedDay }
            })
        });

        if (!items.length) {
            return '<div class="cal-day-panel">' + heading +
                UI.emptyState({
                    icon: 'calendar',
                    title: 'Nothing on this day',
                    text: (view === 'fr')
                        ? 'Pick another day, or book a meeting with one of your clients.'
                        : 'Pick another day, or ask your representative for a meeting.',
                    actions: UI.btn({
                        label: 'Book a meeting', icon: 'plus',
                        act: 'cal-book', data: { day: selectedDay }
                    })
                }) + '</div>';
        }

        return '<div class="cal-day-panel">' + heading +
            '<div class="stack-4">' + items.map(apptCard).join('') + '</div></div>';
    }

    /* A full appointment card.

       Built here rather than reusing UI.apptCard, because that one reads its data
       out of the mock records in js/data.js and knows nothing about status, who
       accepts what, or which buttons this person is allowed to press. */
    function apptCard(appt) {
        var status = STATUS[appt.status] || STATUS.pending;
        var can = appt.can || {};
        var theirFirstName = String(appt.withName || 'They').split(' ')[0];

        var agenda = appt.agenda.length
            ? '<div class="stack-2" style="gap:4px"><span class="eyebrow">Agenda</span>' +
              appt.agenda.map(function (line) {
                  return '<span class="tick">' + UI.icon('check', 12) +
                      '<span>' + FMT.esc(line) + '</span></span>';
              }).join('') + '</div>'
            : '';

        /* WHO IS WAITING ON WHOM. The single most useful sentence on the card,
           because "pending" on its own does not say whose turn it is. */
        var waiting = '';

        if (appt.status === 'pending') {
            waiting = UI.callout({
                tone: 'warn', icon: 'clock',
                title: appt.createdByMe ? 'Waiting for them' : 'Waiting for you',
                text: appt.createdByMe
                    ? 'You asked for this time. ' + theirFirstName +
                      ' needs to accept it before it is agreed.'
                    : theirFirstName + ' asked for this time. Accept it if it suits you, ' +
                      'or suggest another.'
            });
        }

        /* WHY IT IS DONE. The automatic case is a guess, so it says so instead of
           implying somebody confirmed it happened. */
        var done = '';

        if (appt.status === 'completed') {
            done = UI.callout({
                tone: appt.autoCompleted ? 'info' : 'ok',
                icon: appt.autoCompleted ? 'clock' : 'checkCircle',
                title: appt.autoCompleted ? 'Closed automatically' : 'Marked as done',
                text: appt.autoCompleted
                    ? 'Nobody marked this one - it closed because its time passed. If it did not ' +
                      'actually happen, reopen it.'
                    : 'Confirmed as having taken place.'
            });
        }

        var actions = UI.join([
            can.confirm ? UI.btn({
                label: 'Accept this time', size: 'sm', icon: 'check',
                act: 'cal-act', data: { id: appt.id, todo: 'confirm' }
            }) : '',

            can.join ? UI.btn({
                label: (view === 'customer') ? 'Join call' : 'Start call',
                variant: can.confirm ? 'outline' : 'primary', size: 'sm', icon: 'video',
                act: 'start-call', data: { id: appt.customerPersonId }
            }) : '',

            can.complete ? UI.btn({
                label: 'Mark as done', variant: 'outline', size: 'sm', icon: 'checkCircle',
                act: 'cal-act', data: { id: appt.id, todo: 'complete' }
            }) : '',

            can.reschedule ? UI.btn({
                label: 'Suggest another time', variant: 'outline', size: 'sm', icon: 'calendar',
                act: 'cal-reschedule', data: { id: appt.id }
            }) : '',

            (appt.status === 'completed' || appt.status === 'cancelled') ? UI.btn({
                label: 'Reopen', variant: 'ghost', size: 'sm', icon: 'refresh',
                act: 'cal-act', data: { id: appt.id, todo: 'reopen' }
            }) : '',

            /* PUT IT IN A REAL CALENDAR.

               Offered on anything still to come, whether or not it has been
               accepted yet - a proposed time is exactly when somebody wants it in
               their own diary so they do not double-book it.

               Hidden on cancelled and completed meetings, where adding a past
               event to a calendar is just clutter.

               NO GOOGLE ACCOUNT IS NEEDED for this to appear. The Google link is
               an ordinary URL that opens their calendar's "add event" page, and
               the .ics download works with no account at all. This button was
               previously only on the dashboard cards, which is why it looked like
               it did not exist. */
            (appt.status === 'pending' || appt.status === 'confirmed') ? UI.btn({
                label: 'Add to calendar', variant: 'ghost', size: 'sm', icon: 'calendar',
                act: 'appt-calendar', data: { id: appt.id }
            }) : '',

            can.cancel ? UI.btn({
                label: 'Cancel', variant: 'ghost', size: 'sm', icon: 'x',
                act: 'cal-cancel', data: { id: appt.id }
            }) : ''
        ]);

        return '<div class="card cal-card ' + status.cls + '">' +
            '<span class="cal-card-stripe"></span>' +
            '<div class="card-body">' +

            '<div class="between" style="gap:8px;align-items:flex-start">' +
            '<div class="stack-2" style="gap:2px;min-width:0">' +
            '<div class="appt-title">' + FMT.esc(appt.title) + '</div>' +
            '<div class="t-xs muted">' + FMT.esc(FMT.time(appt.start) + ' to ' +
                FMT.time(appt.end) + '  (' + appt.minutes + ' min)') + '</div>' +
            '</div>' +
            UI.dotBadge(status.label, status.tone) +
            '</div>' +

            '<div class="appt-meta">' +
            '<span>' + UI.icon(MODE_ICON[appt.mode] || 'calendar', 13) +
            FMT.esc(MODE_LABEL[appt.mode] || appt.mode) + '</span>' +
            '<span class="truncate">' + UI.icon('user', 13) + FMT.esc(appt.withName) + '</span>' +
            (appt.location ? '<span class="truncate subtle">' + UI.icon('mapPin', 13) +
                FMT.esc(appt.location) + '</span>' : '') +
            '</div>' +

            waiting + agenda +
            (appt.notes ? '<div class="t-xs muted">' + FMT.esc(appt.notes) + '</div>' : '') +
            done +

            (actions ? '<div class="card-actions">' + actions + '</div>' : '') +
            '</div></div>';
    }


    /* ======================================================================
       BOOKING

       A day, a time, how long, and what it is about. Nothing else is required - a
       form that demands an agenda before it will book a phone call is a form
       people learn to work around.
       ====================================================================== */
    function openBook(day) {
        var when = day || selectedDay;

        if (view === 'fr' && !people.length) {
            UI.openModal({
                title: 'No clients yet',
                size: 'sm',
                body: UI.callout({
                    tone: 'info', icon: 'users', title: 'Nobody is assigned to you',
                    text: 'Once a client is assigned to you they appear here and you can book ' +
                        'meetings with them.'
                })
            });
            return;
        }

        /* Default to the next round hour ON THE SINGAPORE CLOCK, which is what
           the person filling this in is reading off the wall. */
        var soonParts = FMT.sgParts(new Date(Date.now() + 3600000));
        var soonHHMM = pad(soonParts.hour) + ':00';

        var whoField = (view === 'fr')
            ? '<div class="field"><label class="field-label" for="bk-who">Client</label>' +
              '<select class="select" id="bk-who">' +
              people.map(function (p) {
                  var chosen = (p.personId === STATE.activeCustomerId) ? ' selected' : '';
                  return '<option value="' + FMT.esc(p.personId) + '"' + chosen + '>' +
                      FMT.esc(p.name) + '</option>';
              }).join('') + '</select></div>'

            /* A customer does not choose. They have one representative and the
               server reads it off their own record whatever the browser sends, so
               this is a statement rather than a control. */
            : '<div class="field"><span class="field-label">With</span>' +
              '<div class="t-sm semi">' +
              FMT.esc(people.length ? people[0].name : 'your representative') + '</div></div>';

        UI.openModal({
            title: 'Book a meeting',
            sub: (view === 'fr')
                ? 'Your client accepts the time before it is agreed.'
                : 'Your representative accepts the time before it is agreed.',
            body: '<form id="book-form" class="stack-4" novalidate>' +

                whoField +

                '<div class="field"><label class="field-label" for="bk-title">What is it about?</label>' +
                '<input class="input" id="bk-title" type="text" maxlength="190" value="' +
                (view === 'fr' ? 'Protection review' : 'Questions about my cover') + '"></div>' +

                '<div class="grid-2">' +
                '<div class="field"><label class="field-label" for="bk-date">Date</label>' +
                '<input class="input" id="bk-date" type="date" value="' + FMT.esc(when) + '" ' +
                'min="' + todayKey() + '"></div>' +

                '<div class="field"><label class="field-label" for="bk-time">' +
                'Start time <span class="t-xs muted">(Singapore)</span></label>' +
                '<input class="input" id="bk-time" type="time" value="' + soonHHMM + '"></div>' +
                '</div>' +

                '<div class="grid-2">' +
                '<div class="field"><label class="field-label" for="bk-mins">How long</label>' +
                '<select class="select" id="bk-mins">' +
                [15, 30, 45, 60, 90, 120].map(function (m) {
                    return '<option value="' + m + '"' + (m === 30 ? ' selected' : '') + '>' +
                        m + ' minutes</option>';
                }).join('') + '</select></div>' +

                '<div class="field"><label class="field-label" for="bk-mode">How</label>' +
                '<select class="select" id="bk-mode">' +
                '<option value="video">Video call</option>' +
                '<option value="phone">Phone call</option>' +
                '<option value="in-person">In person</option>' +
                '</select></div>' +
                '</div>' +

                '<div class="field"><label class="field-label" for="bk-agenda">' +
                'Anything to cover? <span class="subtle">(optional)</span></label>' +
                '<textarea class="textarea" id="bk-agenda" rows="3" ' +
                'placeholder="One point per line"></textarea>' +
                '<div class="field-hint">One point per line. Both of you will see these.</div></div>' +

                '<div id="book-alert"></div>' +
                '</form>',

            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Ask for this time', icon: 'calendar', act: 'cal-do-book' })
        });
    }

    function submitBook() {
        var $submit = $('[data-act="cal-do-book"]');

        if ($submit.hasClass('is-loading')) { return; }

        var date = $('#bk-date').val();
        var time = $('#bk-time').val();

        if (!date || !time) {
            formError('#book-alert', 'Please pick a date and a start time.');
            return;
        }

        /* THE ONE LINE THAT HANDLES TIME ZONES.

           '2026-03-15T14:00+08:00' is 2pm IN SINGAPORE, wherever the browser is,
           and toISOString() turns that instant into the UTC the server stores.

           It used to be written without the offset, which means "2pm here" - so a
           representative demonstrating from London booked 2pm and their client in
           Singapore was told 10pm. Both people in every meeting are in Singapore;
           the label on the clock should be too. FMT.TZ_OFFSET is a constant
           because Singapore has no daylight saving. */
        var start = FMT.sgInstant(date, time);

        if (!start) {
            formError('#book-alert', 'That date and time could not be read.');
            return;
        }

        $submit.addClass('is-loading').prop('disabled', true);

        API.bookAppointment({
            withPerson: (view === 'fr') ? $('#bk-who').val() : '',
            title: $.trim($('#bk-title').val()),
            mode: $('#bk-mode').val(),
            start: start.toISOString(),
            minutes: Number($('#bk-mins').val()),
            agenda: $('#bk-agenda').val()
        }).then(function (data) {
            UI.closeModal();

            // Jump to the day it landed on, so the result is immediately visible
            selectedDay = instantKey(data.appointment.start);
            monthStart = fromKey(selectedDay.slice(0, 8) + '01');

            load();
            UI.toast({ title: 'Time requested', message: data.message, tone: 'ok' });

        }, function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);
            formError('#book-alert', err.error);
        });
    }

    function formError(where, text) {
        $(where).html('<div class="login-alert" role="alert">' +
            UI.icon('alertCircle', 15) + '<span>' + FMT.esc(text) + '</span></div>');
    }


    /* ======================================================================
       SUGGESTING ANOTHER TIME
       ====================================================================== */
    function openReschedule(id) {
        var appt = findAppt(id);
        if (!appt) { return; }

        /* Prefilled with the time it is at NOW, read off the Singapore clock so
           the box shows what the card above it says. */
        var startParts = FMT.sgParts(appt.start);
        var theirFirstName = String(appt.withName || 'They').split(' ')[0];

        UI.openModal({
            title: 'Suggest another time',
            sub: appt.title,
            body: '<form id="resch-form" class="stack-4" novalidate>' +
                UI.callout({
                    tone: 'info', icon: 'info', title: 'It will need accepting again',
                    text: 'Changing the time un-agrees it, so ' + theirFirstName +
                        ' will be asked to accept the new one.'
                }) +

                '<div class="grid-2">' +
                '<div class="field"><label class="field-label" for="rs-date">New date</label>' +
                '<input class="input" id="rs-date" type="date" value="' + instantKey(appt.start) + '" ' +
                'min="' + todayKey() + '"></div>' +

                '<div class="field"><label class="field-label" for="rs-time">' +
                'New start time <span class="t-xs muted">(Singapore)</span></label>' +
                '<input class="input" id="rs-time" type="time" value="' +
                pad(startParts.hour) + ':' + pad(startParts.minute) + '"></div>' +
                '</div>' +

                '<div class="field"><label class="field-label" for="rs-mins">How long</label>' +
                '<select class="select" id="rs-mins">' +
                [15, 30, 45, 60, 90, 120].map(function (m) {
                    return '<option value="' + m + '"' + (m === appt.minutes ? ' selected' : '') + '>' +
                        m + ' minutes</option>';
                }).join('') + '</select></div>' +

                '<div id="resch-alert"></div>' +
                '</form>',

            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({
                    label: 'Suggest this time', icon: 'calendar',
                    act: 'cal-do-reschedule', data: { id: id }
                })
        });
    }

    function submitReschedule(id) {
        var $submit = $('[data-act="cal-do-reschedule"]');

        if ($submit.hasClass('is-loading')) { return; }

        // Singapore wall-clock in, UTC instant out - as in submitBook()
        var start = FMT.sgInstant($('#rs-date').val(), $('#rs-time').val());

        if (!start) {
            formError('#resch-alert', 'Please pick a date and a time.');
            return;
        }

        $submit.addClass('is-loading').prop('disabled', true);

        API.appointmentAction(id, 'reschedule', {
            start: start.toISOString(),
            minutes: Number($('#rs-mins').val())
        }).then(function (data) {
            UI.closeModal();

            selectedDay = instantKey(data.appointment.start);
            load();

            UI.toast({ title: 'New time suggested', message: data.message, tone: 'ok' });

        }, function (err) {
            $submit.removeClass('is-loading').prop('disabled', false);
            formError('#resch-alert', err.error);
        });
    }


    /* ======================================================================
       ACCEPT / DONE / CANCEL / REOPEN
       ====================================================================== */
    function act(id, what) {
        if (busy) { return; }
        busy = true;

        API.appointmentAction(id, what).then(function (data) {
            busy = false;
            load();

            /* The bell is showing a count that has just changed - accepting a
               request is exactly the thing it was nagging about. */
            if (window.refreshApptAlerts) { refreshApptAlerts(); }

            UI.toast({
                title: {
                    confirm: 'Accepted', complete: 'Marked as done',
                    cancel: 'Cancelled', reopen: 'Reopened'
                }[what] || 'Saved',
                message: data.message,
                tone: (what === 'cancel') ? 'info' : 'ok'
            });

        }, function (err) {
            busy = false;
            UI.toast({ title: 'That did not work', message: err.error, tone: 'warn' });
        });
    }

    /* Cancelling asks first. It is the one action here the other person cannot
       undo on their own, and an accidental tap quietly removes a meeting from
       somebody else's calendar too. */
    function confirmCancel(id) {
        var appt = findAppt(id);
        if (!appt) { return; }

        UI.openModal({
            title: 'Cancel this meeting?',
            size: 'sm',
            body: UI.kv([
                ['Meeting', appt.title],
                ['When', FMT.friendly(appt.start)],
                ['With', appt.withName]
            ]) +
                UI.callout({
                    tone: 'warn', icon: 'alertTriangle', title: 'They will see it disappear',
                    text: String(appt.withName || 'They').split(' ')[0] +
                        ' will see this cancelled on their own calendar.'
                }),
            foot: UI.btn({ label: 'Keep it', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({
                    label: 'Cancel the meeting', icon: 'x',
                    act: 'cal-do-cancel', data: { id: id }
                })
        });
    }


    /* ======================================================================
       HANDLERS - registered once, on document, so they survive every redraw
       ====================================================================== */
    function registerHandlers() {

        $(document).on('click', '[data-act="cal-prev"]', function () {
            monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
            load();
        });

        $(document).on('click', '[data-act="cal-next"]', function () {
            monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
            load();
        });

        $(document).on('click', '[data-act="cal-today"]', function () {
            selectedDay = todayKey();
            monthStart = fromKey(selectedDay.slice(0, 8) + '01');
            load();
        });

        $(document).on('click', '[data-act="cal-reload"]', function () { load(); });

        /* COPY, NOT DISPLAY. The token in this address is what stands in for a
           login, so it is never printed on screen where a shoulder or a screenshot
           would collect it.

           The prompt() fallback matters more than it looks: navigator.clipboard
           needs a secure context and a permission on some browsers, and somebody
           who taps Copy and gets nothing has no other way to reach the address at
           all - the whole point is that it is not written down anywhere else. */
        $(document).on('click', '[data-act="cal-copy-feed"]', function () {
            var $btn = $(this);

            if (!feedUrl) { return; }

            var done = function () {
                $btn.addClass('is-done').html(UI.icon('check', 15) + '<span>Copied</span>');

                window.setTimeout(function () {
                    $btn.removeClass('is-done')
                        .html(UI.icon('clipboard', 15) + '<span>Copy the address</span>');
                }, 1900);
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(feedUrl).then(done, function () {
                    window.prompt('Copy this address into your calendar app:', feedUrl);
                });
                return;
            }

            window.prompt('Copy this address into your calendar app:', feedUrl);
        });

        /* Tapping a day. No fetch - the month is already loaded, so only the grid
           highlight and the panel underneath need redrawing. */
        $(document).on('click', '[data-act="cal-day"]', function () {
            selectedDay = $(this).data('day');
            draw();

            /* Scroll the day's detail into view. On a phone the panel is below the
               fold, so without this a tap looks like it did nothing. */
            var panel = document.querySelector('.cal-day-panel');

            if (panel && window.innerWidth < 1024) {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });

        $(document).on('click', '[data-act="cal-book"]', function () {
            openBook($(this).data('day'));
        });

        $(document).on('submit', '#book-form', function (e) { e.preventDefault(); submitBook(); });
        $(document).on('click', '[data-act="cal-do-book"]', function () { submitBook(); });

        $(document).on('click', '[data-act="cal-reschedule"]', function () {
            openReschedule($(this).data('id'));
        });

        $(document).on('submit', '#resch-form', function (e) {
            e.preventDefault();
            submitReschedule($('[data-act="cal-do-reschedule"]').data('id'));
        });

        $(document).on('click', '[data-act="cal-do-reschedule"]', function () {
            submitReschedule($(this).data('id'));
        });

        /* `todo` rather than `do`, because `do` is a reserved word and
           $(this).data('do') reads awkwardly next to it. */
        $(document).on('click', '[data-act="cal-act"]', function () {
            act($(this).data('id'), $(this).data('todo'));
        });

        $(document).on('click', '[data-act="cal-cancel"]', function () {
            confirmCancel($(this).data('id'));
        });

        $(document).on('click', '[data-act="cal-do-cancel"]', function () {
            var id = $(this).data('id');

            UI.closeModal();
            act(id, 'cancel');
        });
    }

    registerHandlers();

    return {
        render: render,
        after: after,

        /* Used by the notification bell, which needs the same numbers without
           opening the calendar. */
        pendingForMe: function (list) {
            return (list || []).filter(function (a) {
                return a.status === 'pending' && !a.createdByMe;
            });
        }
    };

})();


/* --------------------------------------------------------------------------
   Routes. One screen, two addresses - the sub-line is the only difference.
   -------------------------------------------------------------------------- */
PAGES['/fr/calendar'] = {
    title: 'Calendar',
    sub: 'Every meeting with every client',
    render: CALENDAR.render,
    after: CALENDAR.after
};

PAGES['/me/calendar'] = {
    title: 'Calendar',
    sub: 'Your appointments with your representative',
    render: CALENDAR.render,
    after: CALENDAR.after
};
