/* ==========================================================================
   messages.js
   --------------------------------------------------------------------------
   THE ONE MESSAGES HUB. There is no separate PRUWise page any more.

     Left   the list of conversations
     Middle the conversation you have open
     Right  what PRUWise is reading, but only while PRUWise is the open
            conversation (laptop widths and up - see the note further down)

   WHO YOU CAN TALK TO
     Customer       -> PRUWise  +  their financial representative
     Representative -> PRUWise  +  each of their customers

   TWO KINDS OF CONVERSATION, ON PURPOSE
     'ai'     you are talking TO PRUWise, and it answers you
     'human'  you are talking to a real person. PRUWise stays out of the way
              and only offers draft replies underneath, which you edit before
              sending. It never sends anything for you.

   WHY PRUWISE IS NOT A PAGE ANY MORE

   It used to live at /fr/pruwise and /me/pruwise, with an "Open PRUWise"
   button in the chat header. That was odd: you were already talking to PRUWise,
   and the button sent you somewhere else to do the same thing. Everything that
   page had - the quick prompts, the follow-up questions, the context rail - is
   now part of the conversation itself. The old addresses still work; app.js
   redirects them here.

   EVERYTHING HERE IS REAL

   Conversations live in MySQL, not in the browser. A representative and a
   customer share ONE row per conversation, so when Kristin sends a message,
   Sarah's screen shows it within a couple of seconds and the read receipt goes
   back the other way. Nothing on this screen is simulated.

   HOW THE OTHER PERSON'S MESSAGES ARRIVE: POLLING

   Every POLL_MS we ask thread.php for anything newer than the highest message
   id we hold. Almost every one of those is a single indexed lookup that returns
   an empty list, which costs very little.

   A WebSocket would be instant and tidier, but it needs a process running
   permanently and cheap PHP hosting does not offer one. Two seconds of delay is
   a fair price for "works on any host that runs PHP".
   ========================================================================== */

var MESSAGES = (function () {

    /* ----------------------------------------------------------------------
       WHAT IS ON SCREEN

       Deliberately module-local rather than in STATE. STATE is saved to
       localStorage, and localStorage is editable by whoever is holding the
       keyboard - it is no place for a copy of a conversation. The database is
       the truth here; these are just the bytes we happen to be showing.
       ---------------------------------------------------------------------- */
    var view;              // 'fr' or 'customer'
    var threads = [];      // the conversation list, straight from the server
    var open = null;       // the row in `threads` that is open
    var messages = [];     // the messages in it
    var latestId = 0;      // highest message id we hold - what the poller asks past
    var subject = null;    // the customer PRUWise is answering ABOUT

    var pending = [];      // files uploaded and waiting to be sent with a message
    var busy = false;      // a send or a PRUWise answer is in flight
    var poller = null;     // the setInterval handle
    var pollTick = 0;

    /* The server's clock as of the last response, sent back on the next poll so it
       can report anything edited or deleted since. Empty until the first response,
       which is correct: a full load already reflects every change made before it. */
    var lastServerTime = '';

    /* A question asked from somewhere else in the app ("Ask about this gap").
       We remember it, come here, and ask it once the conversation is loaded. */
    var pendingQuestion = null;
    var wantAi = false;    // open PRUWise rather than whatever was last open
    var wantPerson = null; // open this person's conversation - see openWith()

    var POLL_MS = 2000;
    var LIST_EVERY = 5;    // refresh the conversation list every 5th poll

    /* The keys a PRUWise answer is allowed to carry into the database. The same
       list appears in php/api/store-ai-message.php, which is the one that
       matters - this copy just avoids sending fields that would be dropped. */
    var ANSWER_KEYS = ['paragraphs', 'bullets', 'chips', 'callouts', 'term',
        'recId', 'actions', 'followups', 'disclaimer'];


    /* ======================================================================
       WHO AM I, AND WHO IS PRUWISE READING ABOUT
       ====================================================================== */

    /* Works out the subject of the PRUWise conversation.

       For a representative that is whichever customer they are looking at, and
       they can change it from the chip bar. For a customer it is themselves.

       THE HONEST BIT: the policy figures live in js/data.js as mock data, not in
       MySQL. Accounts are real; insurance products are not. So an account that
       signed itself up has no record to read, and we fall back to a sample
       profile and SAY SO in the rail rather than quietly showing somebody
       else's money as if it were theirs. */
    function findSubject() {
        var found = (view === 'fr')
            ? DATA.getCustomer(STATE.activeCustomerId)
            : DATA.getCustomer(STATE.session.personId);

        realProfile = !!found;
        subject = found || DATA.customers[0];
    }

    var realProfile = true;


    /* ======================================================================
       FIRST RENDER

       render() has to return HTML immediately - the router puts it on the page
       and then calls after(). The conversations are a request away, so what we
       return here is the frame plus a "loading" line, and after() fills it in.
       ====================================================================== */
    function render() {
        view = (STATE.session.role === 'fr') ? 'fr' : 'customer';
        findSubject();

        // Reset per-visit things so returning to Messages never shows stale bytes
        threads = [];
        open = null;
        messages = [];
        latestId = 0;
        pending = [];
        busy = false;

        return '<div class="msgs show-list" id="msgs">' +
            '<aside class="msgs-list">' +
            listHead(0) +
            '<div class="chat-list" id="chat-list">' + loadingLine('Loading conversations') + '</div>' +
            '</aside>' +
            '<section class="msgs-thread" id="msgs-thread">' +
            loadingLine('Opening') +
            '</section>' +
            '</div>';
    }

    function loadingLine(text) {
        return '<div class="pad-4 t-sm muted" style="text-align:center">' +
            FMT.esc(text) + '\u2026</div>';
    }

    function after() {
        loadList().then(function () {
            /* Nothing at all means loadList failed and has already put the reason
               on screen. Opening a conversation now would just stack a second
               error message on top of the first. There is always at least the
               PRUWise conversation when the list really loads. */
            if (!threads.length) { return; }

            openThread(firstSpec());
        });
    }

    /* Which conversation opens when the screen loads.

       PRUWise is first in the list, so it is also the default. That is on
       purpose: it is the one conversation that always has something to say. */
    function firstSpec() {
        if (wantAi || pendingQuestion) {
            wantAi = false;
            return { kind: 'ai' };
        }

        /* Somebody arrived here asking for one particular person - the Consult
           button on an appointment card. Checked BEFORE the remembered thread,
           because an explicit request beats where you happened to be last, and
           cleared as it is used so it cannot capture the next visit. */
        if (wantPerson) {
            var person = wantPerson;
            wantPerson = null;
            return { withPerson: person };
        }

        if (STATE.openThreadId && rowFor(STATE.openThreadId)) {
            return { threadId: STATE.openThreadId };
        }
        return threads.length ? { threadId: threads[0].threadId } : { kind: 'ai' };
    }


    /* ======================================================================
       THE CONVERSATION LIST
       ====================================================================== */

    function loadList() {
        return API.threads().then(function (data) {
            threads = data.threads || [];
            drawList();
        }, function (err) {
            $('#chat-list').html(UI.errorState({
                title: 'Could not load your conversations',
                text: err.error
            }));
            $('#msgs-thread').html('');
        });
    }

    /* A quieter reload used after sending, and every few polls. It redraws the
       previews and unread pills without touching the open conversation. */
    function refreshList() {
        API.threads().then(function (data) {
            threads = data.threads || [];

            // Keep the open conversation marked read - we are looking at it
            var row = rowFor(open ? open.threadId : 0);
            if (row) { row.unread = 0; }

            drawList();
        }, function () { /* a blip in the list is not worth interrupting anybody */ });
    }

    function rowFor(threadId) {
        for (var i = 0; i < threads.length; i++) {
            if (threads[i].threadId === Number(threadId)) { return threads[i]; }
        }
        return null;
    }

    function listHead(count) {
        return '<div class="msgs-list-head">' +
            '<div class="between"><h1 class="h4">Messages</h1>' +
            '<span id="msgs-count">' +
            (count ? UI.badge(count + (count === 1 ? ' conversation' : ' conversations')) : '') +
            '</span></div>' +
            '<span class="search"><span class="input-icon">' + UI.icon('search', 16) + '</span>' +
            '<input class="input" id="msg-search" type="search" placeholder="Search conversations..." ' +
            'aria-label="Search conversations"></span>' +
            '</div>';
    }

    function drawList() {
        var openId = open ? open.threadId : Number(STATE.openThreadId);

        var rows = threads.map(function (t) {
            return UI.chatItem({
                id: t.threadId,
                name: t.name,
                seed: t.seed,
                isAi: t.kind === 'ai',
                online: t.online,
                active: t.threadId === openId,
                time: t.time ? FMT.time(t.time) : '',
                preview: t.preview,
                fromMe: t.fromMe,
                unread: t.unread
            });
        }).join('');

        $('#chat-list').html(rows || loadingLine('No conversations yet'));

        /* Only the count is replaced, NOT the whole header.

           Redrawing the header would rebuild the search box, and this runs every
           few seconds off the poller - so anything somebody was typing would
           vanish under them mid-word. */
        $('#msgs-count').html(threads.length
            ? UI.badge(threads.length + (threads.length === 1 ? ' conversation' : ' conversations'))
            : '');

        // The list was just rebuilt, so re-apply whatever is in the search box
        applyFilter();
    }

    /* Hide the rows that do not match the search box. Called after every redraw
       as well as on typing, because a redraw replaces the rows it had hidden. */
    function applyFilter() {
        var q = $.trim(String($('#msg-search').val() || '')).toLowerCase();

        $('#chat-list .chat-item').each(function () {
            var name = $(this).find('.chat-item-name').text().toLowerCase();
            $(this).toggle(!q || name.indexOf(q) !== -1);
        });
    }


    /* ======================================================================
       OPENING A CONVERSATION

       `spec` is one of { threadId } / { kind:'ai' } / { withPerson }. All three
       work on every message endpoint, and the server creates the conversation
       on first use - so a representative can click a customer they have never
       messaged and just start typing.
       ====================================================================== */
    function openThread(spec) {
        stopPolling();

        messages = [];
        latestId = 0;
        pending = [];
        busy = false;

        /* A DIFFERENT CONVERSATION IS A CLEAN SLATE FOR SUGGESTIONS. A draft turned
           down for one person is perfectly good wording for another, and carrying
           the rejects across would shrink the pool every time somebody switched. */
        aiSuggest = {
            threadId: null, items: null, source: null, asking: false, rejected: []
        };

        /* Cleared too: the list about to arrive is already up to date, so asking
           for changes since some earlier moment would only re-send them. */
        lastServerTime = '';

        $('#msgs-thread').html(loadingLine('Opening'));

        API.thread(spec).then(function (data) {
            STATE.openThreadId = data.threadId;

            /* Prefer the row from the list - it knows the avatar seed and the
               online dot. If the list has not caught up (a brand new
               conversation), build a row from what thread.php told us. */
            open = rowFor(data.threadId) || rowFromThread(data);
            open.unread = 0;

            messages = data.messages || [];
            latestId = data.latestId || 0;
            lastServerTime = data.serverTime || '';
            applyReadUpTo(data.readUpTo);

            drawList();
            drawThreadPane();
            startPolling();
            runPendingQuestion();

        }, function (err) {
            $('#msgs-thread').html(UI.errorState({
                title: 'Could not open that conversation',
                text: err.error
            }));
        });
    }

    // A list row invented from a thread response, for conversations too new to be listed
    function rowFromThread(data) {
        if (data.kind === 'ai') {
            return {
                threadId: data.threadId, kind: 'ai', name: 'PRUWise',
                sub: 'Always available', seed: 'pruwise', online: true, unread: 0
            };
        }
        var other = data.other || {};
        return {
            threadId: data.threadId, kind: 'human',
            personId: other.personId, name: other.name || 'Conversation',
            sub: other.sub || '', seed: other.personId, online: true, unread: 0
        };
    }


    /* ======================================================================
       DRAWING THE OPEN CONVERSATION
       ====================================================================== */

    function isAi() { return !!open && open.kind === 'ai'; }

    function drawThreadPane() {
        $('#msgs-thread').html(threadPane());

        /* The context rail is a third column of the grid, so it is a sibling of
           the thread pane rather than inside it. It only exists for the PRUWise
           conversation, and CSS hides it below 1024px where there is no room. */
        $('#msgs-rail').remove();
        $('#msgs').toggleClass('has-rail', isAi());

        if (isAi()) {
            $('#msgs').append('<aside class="nav-ws-rail" id="msgs-rail">' + contextCards() + '</aside>');
        }

        /* The files shared in a HUMAN conversation, under the composer - the rail
           above only exists for the PRUWise thread. This is what replaced the
           Documents page, so it has to be reachable from the conversation people
           actually share files in. */
        if (!isAi()) {
            /* WHAT PRUWISE READS IN A CHAT, said where the typing happens.

               The same panel as on the call screen, and for the same reason: the
               transcript reading works on chat messages too, and there is no way to
               guess that from an empty composer. One line until it is opened. */
            $('#suggest-slot').before(UI.listensFor({
                label: 'What PRUWise picks up from this chat'
            }));

            $('#suggest-slot').before('<div id="ctx-files" class="thread-files"></div>');
            loadThreadFiles();
        }

        wireComposer();
        drawMessages();
        drawTray();
        scrollDown(false);
    }

    function threadPane() {
        var ai = isAi();

        /* --- header --------------------------------------------------------
           No "Open PRUWise" button, and no context button on desktop either:
           the rail is simply there. The only button is the phone-sized one
           below, because on a 375px screen the cards genuinely do not fit. */
        var avatarHtml = ai
            ? '<span class="chat-avatar-ai" style="width:36px;height:36px">' + UI.icon('sparkles', 17) + '</span>'
            : UI.avatar(open.name, 'sm', { seed: open.seed, online: open.online });

        var head = '<div class="thread-head">' +
            '<button type="button" class="thread-back" data-act="thread-back" aria-label="Back to conversations">' +
            UI.icon('arrowLeft', 18) + '</button>' +
            avatarHtml +
            '<div class="grow" style="min-width:0">' +
            '<div class="thread-title">' + (ai ? UI.pruwise() : FMT.esc(open.name)) + '</div>' +
            '<div class="thread-sub">' +
            (ai
                ? 'Always available'
                : FMT.esc(open.sub || '') + (open.online ? ' &middot; online now' : '')) +
            '</div></div>' +
            headerTools(ai) +
            '</div>';

        var body = '<div class="chat-log" id="thread-log" role="log" aria-live="polite"></div>';

        /* Follow-up questions for PRUWise, draft replies for a person. Two
           different jobs: one continues a conversation with a machine, the
           other helps you word a message to a human being. */
        var helper = ai
            ? '<div id="chat-followups"></div>'
            : '<div id="suggest-slot"></div>';

        return head + body + helper + composer();
    }

    /* The buttons on the right of the conversation header.

       WHY THESE ARE DROPDOWNS AND NOT A ROW OF CHIPS

       The old PRUWise page had a whole strip across the top: a chip for every
       customer, or four quick questions, plus a Context button. Moved into the
       conversation it cost an entire row above the messages - on a laptop that is
       fine, on a phone it was a third of what was left after the header.

       So the same things are now one small button each. A dropdown is the right
       shape for this: the list is only interesting at the moment you want to
       change something, and the rest of the time the button is just a label
       telling you the current state.

       Nothing was lost. The suggested questions are still one tap away, and the
       follow-ups under the log already offer the useful ones without being asked. */
    function headerTools(ai) {
        if (!ai) {
            /* A LABELLED BUTTON, NOT A BARE ICON.

               This was UI.iconBtn - a video glyph on its own. The link between the
               conversation and the call has worked the whole time and nobody could
               find it, which is the same reason the Refresh and Hide controls in
               the suggestion strip had to be rebuilt: an icon with no word next to
               it does not read as an action.

               The word is hidden by CSS below 640px, where the header genuinely has
               no room for it, and aria-label carries it for a screen reader either
               way. */
            return '<button type="button" class="btn btn-primary btn-sm thread-call" ' +
                'data-act="msg-call" aria-label="Start a video call with ' +
                FMT.esc(open.name) + '">' +
                UI.icon('video', 15) + '<span>Video call</span></button>';
        }

        var tools = '';

        if (view === 'fr') {
            /* WHO PRUWISE IS READING ABOUT. Doubles as the label, so a
               representative can always see which customer the answers are about
               without opening anything. */
            tools += '<span class="drop-anchor">' +
                '<button type="button" class="thread-pick" data-act="pruwise-subject" ' +
                'aria-label="Change who PRUWise is reading about">' +
                UI.avatar(subject.name, 'xs', { seed: subject.id }) +
                '<span class="truncate phone-hide">' + FMT.esc(subject.firstName) + '</span>' +
                UI.icon('chevronDown', 14) +
                '</button></span>';
        } else {
            tools += '<span class="drop-anchor">' +
                UI.iconBtn({ icon: 'sparkles', label: 'Questions worth asking', act: 'pruwise-prompts' }) +
                '</span>';
        }

        /* The context sheet, only on screens too narrow for the rail. On a laptop
           the rail is simply there, so this button would do nothing. */
        tools += '<span class="laptop-down">' +
            UI.iconBtn({ icon: 'layers', label: 'What PRUWise is reading', act: 'nav-context' }) +
            '</span>';

        return tools;
    }

    function composer() {
        var ai = isAi();

        var placeholder = ai
            ? (view === 'fr'
                ? 'Ask about ' + subject.firstName + '\u2019s situation...'
                : 'Ask anything about your insurance...')
            : 'Write a message...';

        /* The hint under the box, worded for whoever is reading it. A
           representative does not need telling that an assistant is not a
           financial adviser - they need telling to check the figures. */
        var hint = ai
            ? (view === 'fr'
                ? 'Answers come from this client\u2019s record on file. Verify the figures before you advise.'
                : 'PRUWise explains and suggests. It does not give financial advice.')
            : 'Files are uploaded and kept with the conversation, so both of you can open them.';

        return '<div class="composer">' +
            '<div class="attach-tray" id="attach-tray"></div>' +
            '<div class="composer-row">' +

            /* PRUWise takes text only. There is nothing useful it could do with
               a spreadsheet, and offering the paperclip would imply otherwise. */
            (ai ? '' :
                '<button type="button" class="attach-btn" data-act="pick-file" ' +
                'aria-label="Attach a file or photo" title="Attach a file or photo">' +
                UI.icon('paperclip', 18) + '</button>' +
                '<input type="file" id="file-input" class="file-input-hidden" multiple ' +
                'accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt">') +

            '<textarea id="msg-input" rows="1" aria-label="Write a message" placeholder="' +
            FMT.esc(placeholder) + '"></textarea>' +
            '<button type="button" class="composer-send" id="msg-send" aria-label="Send message">' +
            UI.icon('send', 18) + '</button>' +
            '</div>' +
            '<div class="composer-hint">' + UI.icon('info', 12) + '<span>' +
            FMT.esc(hint) + '</span></div></div>';
    }

    /* Draws the messages, inserting a date separator whenever the day changes -
       the same thing every messaging app does. */
    function drawMessages() {
        var out = '';
        var lastDay = '';

        // An empty PRUWise conversation opens with a greeting rather than a void
        var list = messages;

        if (!list.length && isAi()) {
            list = AI.opening(view, subject).filter(function (m) {
                /* The grey context banner is dropped: the chip bar and the rail
                   already say who PRUWise is reading about, three times over
                   would be noise. */
                return m.role !== 'system';
            });
        }

        list.forEach(function (m) {
            var day = FMT.dateLong(m.time);

            if (day !== lastDay) {
                out += '<div class="day-sep"><span>' + dayLabel(m.time) + '</span></div>';
                lastDay = day;
            }

            out += UI.message(m, {
                view: view,
                userName: STATE.session.name,
                // themName makes UI.message show a person's initials, not the sparkle
                themName: isAi() ? null : open.name,
                themSeed: open.seed,
                senderName: isAi() ? 'PRUWise' : open.name,

                /* Edit and delete are offered in a conversation with a PERSON only.

                   In the PRUWise thread the whole exchange is stored so it survives
                   a refresh, and the assistant's half is not anybody's to rewrite -
                   editing your own question there would leave an answer to a
                   question that is no longer on screen, which reads as the
                   assistant having answered something else. */
                editable: !isAi()
            });
        });

        $('#thread-log').html(out);

        if (isAi()) { drawFollowups(); } else { drawSuggestions(); }
        UI.animateBars();
    }

    // "Today" / "Yesterday" / "12 Mar 2026"
    function dayLabel(time) {
        var friendly = FMT.friendly(time);
        if (friendly.indexOf('Today') === 0) { return 'Today'; }
        if (friendly.indexOf('Yesterday') === 0) { return 'Yesterday'; }
        return FMT.dateLong(time);
    }

    // Suggested next questions, taken from the most recent PRUWise answer
    function drawFollowups() {
        var list = null;

        for (var i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== 'me' && messages[i].followups) {
                list = messages[i].followups;
                break;
            }
        }
        if (!list || !list.length) {
            list = AI.suggestions(view, subject).slice(0, 3);
        }
        $('#chat-followups').html(UI.followups(list));
    }

    /* =====================================================================
       SUGGESTED REPLIES
       ---------------------------------------------------------------------
       Draft replies for a HUMAN conversation. They only ever fill the input
       box - A PERSON ALWAYS PRESSES SEND, which is the whole point, and why
       /api/suggest-reply writes nothing to the messages table.

       TWO SOURCES, DRAWN IN TWO PASSES.

       The built-in keyword rules in AI.replySuggestions() answer instantly and
       need no key. They go on screen first. If a model is configured, it is
       then asked for something better and the strip is redrawn when the answer
       arrives - typically a second or two later.

       That ordering matters more than it looks. The alternative - wait for the
       model, show nothing meanwhile - means the most common case (somebody
       glancing at the strip and starting to type) sees an empty box, and the
       suggestions arrive after they have stopped caring. Instant-then-better
       is never worse than instant.
       ===================================================================== */

    /* Whether the strip is folded away. A UI preference, kept in localStorage
       rather than in account_prefs: it is about this screen on this device, it
       has to survive a redraw rather than a device change, and a round trip to
       save a toggle would make the toggle feel slow. */
    var SUGGEST_HIDDEN_KEY = 'pruwise.suggest.hidden';

    function suggestHidden() {
        try { return window.localStorage.getItem(SUGGEST_HIDDEN_KEY) === '1'; }
        catch (e) { return false; }
    }

    function setSuggestHidden(hidden) {
        try { window.localStorage.setItem(SUGGEST_HIDDEN_KEY, hidden ? '1' : '0'); }
        catch (e) { /* private browsing - the toggle still works for this visit */ }
    }

    /* The model's answer for the conversation currently open, so a redraw does
       not re-ask. Cleared when the thread changes or Refresh is pressed.

       `rejected` is everything Refresh has already thrown away in this thread. It
       is sent with the next request so neither the model nor the fixed fallback can
       offer it again - pressing Refresh three times now walks forward rather than
       returning to the start. Reset when the conversation changes, because a draft
       rejected for one person is perfectly good for another. */
    var aiSuggest = {
        threadId: null, items: null, source: null, asking: false, rejected: [],

        /* The server says when the built-in pool has nothing new left. Shown as a
           sentence rather than allowed to look like a broken button - see the note
           above fromPool() in api/_routes/suggest-reply.ts. */
        exhausted: false
    };

    function localSuggestions() {
        var lastFromThem = null;

        for (var i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'them') { lastFromThem = messages[i]; break; }
        }

        var lastText = (lastFromThem && lastFromThem.paragraphs)
            ? lastFromThem.paragraphs.join(' ') : '';

        return AI.replySuggestions(view, subject, lastText);
    }

    function drawSuggestions() {
        var slot = $('#suggest-slot');
        if (!slot.length) { return; }

        if (suggestHidden()) {
            slot.html(UI.suggestBox({ collapsed: true }));
            return;
        }

        var local = localSuggestions();
        var usingAi = aiSuggest.threadId === openThreadId() && aiSuggest.items;

        slot.html(UI.suggestBox({
            items: usingAi ? aiSuggest.items : local.items,

            /* The rules explain WHY they suggested what they did ("she has raised
               cost"). The model's wording speaks for itself, so the note would be
               about suggestions that are no longer on screen. */
            note: usingAi ? null : local.note,

            source: usingAi ? aiSuggest.source : 'rules',
            loading: aiSuggest.asking,

            /* Said out loud when Refresh has nothing left to offer. Without this
               the third press returns the same three lines and the button looks
               broken - which is exactly how it was reported. */
            exhausted: usingAi && aiSuggest.exhausted
        }));

        askForBetterSuggestions();
    }

    function openThreadId() {
        return (open && open.threadId) ? open.threadId : null;
    }

    /* Ask the server for wording from the model. Silent about failure: the rules
       are already on screen, so there is nothing to report and nothing to fix. */
    function askForBetterSuggestions(force) {
        var threadId = openThreadId();

        if (!threadId || isAi()) { return; }
        if (aiSuggest.asking) { return; }

        /* NO KEY IS NOT A REASON TO IGNORE A BUTTON PRESS.

           This used to return here whenever no model was configured, which meant
           Refresh did nothing at all on a deployment without a key - the strip
           redrew from the same deterministic local rules and looked frozen.

           /api/suggest-reply answers either way, and its fallback pool now rotates
           past whatever has been rejected, so a forced ask is worth making. An
           UNFORCED ask still stops here: filling the strip is already handled
           locally and instantly, and a request per redraw for wording that would
           not change is waste. */
        if (!force && !AI.config.enabled) { return; }

        if (!force && aiSuggest.threadId === threadId && aiSuggest.items) { return; }

        aiSuggest.asking = true;

        /* WHAT IS ALREADY ON SCREEN GOES WITH THE REQUEST.

           This is the Refresh fix. aiSuggest.items is cleared before a forced
           re-ask so the cache cannot answer, but the SERVER still needs to know
           what was rejected or it hands back the same three lines - which is
           exactly what pressing Refresh used to do. shown[] survives the clear
           because it is captured here, from whichever source drew the strip. */
        var shown = (aiSuggest.rejected || []).concat(
            force ? [] : (aiSuggest.items || [])
        );

        API.suggestReply(threadId, shown).then(
            function (data) {
                aiSuggest.asking = false;

                if (openThreadId() !== threadId) { return; }   // moved on

                if (data && data.suggestions && data.suggestions.length) {
                    aiSuggest.threadId = threadId;
                    aiSuggest.items = data.suggestions;
                    aiSuggest.source = data.source || 'rules';
                    aiSuggest.exhausted = !!data.exhausted;
                }
                if (!suggestHidden()) { drawSuggestions(); }
            },
            function () {
                aiSuggest.asking = false;
                if (!suggestHidden()) { drawSuggestions(); }
            }
        );
    }

    function scrollDown(smooth) {
        var el = document.getElementById('thread-log');
        if (!el) { return; }

        if (smooth) { $(el).stop().animate({ scrollTop: el.scrollHeight }, 300); }
        else { el.scrollTop = el.scrollHeight; }
    }

    function wireComposer() {
        var $input = $('#msg-input');

        // Enter sends, Shift+Enter makes a new line
        $input.on('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });

        // Grow the box as the message gets longer
        $input.on('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 132) + 'px';
        });
    }


    /* ======================================================================
       POLLING - how the other person's messages turn up
       ====================================================================== */

    function startPolling() {
        stopPolling();
        pollTick = 0;
        poller = window.setInterval(tick, POLL_MS);

        /* Registered once per visit to this screen. onPageVisible keeps a list
           rather than binding an event per poller - see the note above it in
           js/app.js. tick() checks for #msgs and stops itself if the router has
           moved on, so a stale waker cannot poll a screen that is gone. */
        if (window.onPageVisible) { onPageVisible(tick); }
    }

    function stopPolling() {
        if (poller) { window.clearInterval(poller); poller = null; }
    }

    function tick() {
        /* The router replaced the page and this interval is all that is left of
           us. Stop, rather than polling forever in the background. */
        if (!$('#msgs').length) { stopPolling(); return; }

        /* NOTHING TO SHOW A HIDDEN WINDOW.

           Two seconds is the right cadence for a conversation somebody is reading
           and twenty-eight thousand requests a day for one they are not. The
           waker registered in startPolling() catches up the instant they return,
           so a reply that arrived while the tab was in the background is on screen
           before they have finished looking at it.

           This also stops the read receipt lying: the poll below sends read=1 to
           mean "this window is in front of somebody", which was not true of a
           background tab. */
        if (pageIsHidden()) { return; }

        if (!open || busy) { return; }

        pollTick++;

        /* read=1 says "this window is actually in front of somebody". Without
           it, a tab left open behind others would quietly mark a conversation
           read while nobody was looking at it, and the sender would see a
           double tick that was not true. */
        var focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : true;

        API.thread({
            threadId: open.threadId,
            read: focused ? 1 : 0,

            /* THE SERVER'S OWN CLOCK, HANDED BACK.

               An edited or deleted message keeps its id, so the "anything newer
               than what I hold" query cannot see it and the other person would go
               on reading the original wording until they reloaded. This is what
               closes that - see the note beside `changed` in api/_routes/thread.ts.

               Not a fixed window like "the last two minutes": a window is a guess,
               and a tab that slept for longer than the guess misses the change for
               good. */
            changedSince: lastServerTime
        }, latestId).then(function (data) {
            var fresh = data.messages || [];
            var changed = applyReadUpTo(data.readUpTo);

            if (data.serverTime) { lastServerTime = data.serverTime; }

            if (applyChanges(data.changed)) { changed = true; }

            if (fresh.length) {
                messages = messages.concat(fresh);
                latestId = data.latestId || latestId;
                changed = true;
            }

            if (changed) { drawMessages(); }
            if (fresh.length) { scrollDown(true); refreshList(); }
            else if (pollTick % LIST_EVERY === 0) { refreshList(); }

            /* The other side said something. Their words are the ones most worth
               reading - a change to a client's record comes from the client. */
            if (fresh.length) { maybeAnalyse(); }

        }, function (err) {
            /* A single failed poll is usually a blip and not worth a message on
               screen. A 401 is different: the session has gone, and carrying on
               would just fail every two seconds forever. */
            if (err.status === 401) {
                stopPolling();
                clearLocalSession();
                go('/login');
            }
        });
    }

    /* Replaces messages the other side (or this side, on another device) has since
       edited or deleted. Returns true if anything actually changed, so a poll that
       brought nothing does not redraw the log and scroll somebody's reading
       position.

       Matched by id and replaced whole rather than patched field by field: the
       server has just built the authoritative version of that message for this
       viewer, and copying two of its fields across would be a second opinion about
       what it says. */
    function messageById(id) {
        for (var i = 0; i < messages.length; i++) {
            if (Number(messages[i].id) === Number(id)) { return messages[i]; }
        }
        return null;
    }

    /* Swap one message for the server's version of it. Used after an edit or a
       delete, so the local copy and the copy the other side is about to poll for
       are the same object shape from the same builder. */
    function replaceMessage(fresh) {
        if (!fresh) { return; }

        messages = messages.map(function (m) {
            return Number(m.id) === Number(fresh.id) ? fresh : m;
        });
    }

    function applyChanges(list) {
        if (!list || !list.length) { return false; }

        var byId = {};
        list.forEach(function (m) { byId[m.id] = m; });

        var touched = false;

        messages = messages.map(function (m) {
            var replacement = byId[m.id];

            if (!replacement) { return m; }

            touched = true;
            return replacement;
        });

        return touched;
    }

    /* Ticks my own messages up to the id the other side has read. Returns true
       if anything actually changed, so we only redraw when there is a reason. */
    function applyReadUpTo(readUpTo) {
        var upTo = Number(readUpTo) || 0;
        if (!upTo) { return false; }

        var changed = false;

        messages.forEach(function (m) {
            if (m.role === 'me' && !m.read && m.id <= upTo) {
                m.read = true;
                changed = true;
            }
        });
        return changed;
    }


    /* ======================================================================
       READING THE CONVERSATION

       PRUWise looks at a person-to-person thread and proposes what it noticed:
       a detail that seems to have changed, a support signal, a loose end, a
       meeting somebody asked for. The proposals are drawn on the client's
       profile, not here - see loadInsights() in js/pages-fr.js - because that is
       where the record they would change is.

       ==================================================================
       THREE THINGS STOP THIS BEING EXPENSIVE OR ANNOYING
       ==================================================================

       NOT THE PRUWISE THREAD. Asking the assistant to analyse its own answers
       would find its own words and propose them back.

       ONLY WHEN SOMETHING NEW WAS SAID, and at most once every 45 seconds.
       Without the first test, every poll would re-read the same conversation;
       without the second, a fast exchange would re-read it on every line. The
       server also gates on relevance before it calls a model at all, so a thread
       about the weather costs nothing either way - but not asking is cheaper
       than being told no.

       AND IT IS NEVER IN THE WAY. Nothing on this screen waits for it and
       nothing here fails visibly if it does. A representative is told only when
       there is something to look at.
       ====================================================================== */

    var ANALYSE_EVERY_MS = 45000;

    var analysed = {
        threadId: 0,   // which conversation the two below refer to
        upToId: 0,     // the newest message already read
        at: 0          // when, so a fast exchange is not re-read every line
    };

    /* Who the proposals would be about. A representative is looking at a
       client; a client is looking at their own conversation. */
    function insightPerson() {
        return (view === 'fr')
            ? (open && open.personId ? String(open.personId) : '')
            : String(STATE.session.personId || '');
    }

    /* The recent conversation as plain text, labelled by speaker.

       LABELLED, BECAUSE WHO SAID IT CHANGES WHAT IT MEANS. "I cannot afford
       that" from the client is a support signal; the same words from the
       representative are not. The rules quote the sentence they matched, and a
       quote without a speaker is not evidence of anything. */
    function conversationText() {
        var mine = STATE.session.name || 'Me';
        var them = (open && open.name) ? open.name : 'Them';

        return messages.slice(-40).map(function (m) {
            var said = (m.paragraphs || []).join(' ');
            if (!said) { return ''; }

            return (m.role === 'me' ? mine : them) + ': ' + said;
        }).filter(Boolean).join('\n');
    }

    function maybeAnalyse() {
        if (!open || isAi()) { return; }

        var personId = insightPerson();
        if (!personId) { return; }

        /* A different conversation is a clean slate. */
        if (analysed.threadId !== open.threadId) {
            analysed = { threadId: open.threadId, upToId: 0, at: 0 };
        }

        if (latestId <= analysed.upToId) { return; }
        if (Date.now() - analysed.at < ANALYSE_EVERY_MS) { return; }

        var text = conversationText();
        if (text.length < 40) { return; }

        /* Claimed BEFORE the request, not after it. Two polls can overlap, and
           marking it afterwards would let both through. */
        analysed.upToId = latestId;
        analysed.at = Date.now();

        API.insights.analyse(personId, 'chat', text, { threadId: open.threadId }).then(

            function (data) {
                var found = (data.found || []).length;

                /* Nothing found is the normal case and is said out loud to
                   nobody. A client is not told either - the proposals appear on
                   their own record, and a notification about a machine reading
                   their chat would be alarming rather than useful. */
                if (!found || view !== 'fr') { return; }

                UI.toast({
                    tone: 'info',
                    title: found === 1
                        ? 'PRUWise noticed something'
                        : 'PRUWise noticed ' + found + ' things',
                    message: 'On ' + (open.name || 'their') + '\u2019s profile, waiting for you ' +
                        'to confirm or dismiss. Nothing has changed yet.',
                    duration: 6000
                });
            },

            /* Silent on purpose. This is a background reading of a conversation
               that is already on screen and complete without it; a red banner
               would be reporting a failure of something nobody asked for. */
            function () { }
        );
    }


    /* ======================================================================
       SENDING
       ====================================================================== */

    /* A random id made BEFORE the request goes out. If the connection drops and
       we retry, the unique key on messages.client_ref makes the server return
       the original message instead of posting the same line twice. */
    function clientRef() {
        return 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function send() {
        var $input = $('#msg-input');
        var text = $.trim($input.val() || '');
        var files = pending.slice();   // slice() = a copy, so clearing does not empty it

        if ((!text && !files.length) || busy || !open) { return; }

        // Still uploading? Sending now would leave the file behind.
        for (var i = 0; i < files.length; i++) {
            if (!files[i].attachmentId) {
                UI.toast({
                    title: 'Still uploading',
                    message: 'Give the attachment a moment to finish, then send.',
                    tone: 'info'
                });
                return;
            }
        }

        busy = true;
        setSending(true);

        // Clear the composer straight away - it feels instant
        $input.val('').css('height', 'auto');
        pending = [];
        drawTray();

        var ids = files.map(function (f) { return f.attachmentId; });

        API.sendMessage({ threadId: open.threadId }, text, ids, clientRef()).then(function (data) {
            absorb(data);
            drawMessages();
            scrollDown(true);
            refreshList();

            if (isAi()) {
                answerFromPruwise(text);
            } else {
                busy = false;
                setSending(false);

                /* After the message is on screen, never before. Analysis is a
                   background read; the send has already succeeded. */
                maybeAnalyse();
            }

        }, function (err) {
            /* Put the message back in the box. Losing what somebody typed
               because the wifi blinked is the rudest thing a chat app can do. */
            busy = false;
            setSending(false);
            $input.val(text);
            pending = files;
            drawTray();

            UI.toast({ title: 'Message not sent', message: err.error, tone: 'warn' });
        });
    }

    /* Adds messages from a server response, ignoring any we already hold.
       send-message.php returns everything from our new message onwards, which
       can overlap with what a poll picked up a moment earlier. */
    function absorb(data) {
        var have = {};
        messages.forEach(function (m) { have[m.id] = true; });

        (data.messages || []).forEach(function (m) {
            if (!have[m.id]) { messages.push(m); }
        });

        latestId = Math.max(latestId, data.latestId || 0);
    }

    function setSending(on) {
        $('#msg-send').prop('disabled', !!on);
    }

    /* PRUWise answering in its own conversation.

       WHY THE ANSWER IS WORKED OUT HERE AND SAVED AFTERWARDS

       The answer logic is a few hundred lines of keyword rules over the
       customer record, in js/ai.js. It already exists, runs instantly, and needs
       no key. Rewriting it on the server would be a second copy of the same
       thing, free to drift from the first. So the browser composes the answer
       and then stores it - and it IS stored, which is what stops a PRUWise
       conversation vanishing on refresh.

       The OpenAI key is never exposed: when one is configured, AI.reply posts
       through /api/ai, which holds the key server-side and prepends the
       guardrail. The browser only ever sees the finished wording. */
    function answerFromPruwise(text) {
        $('#thread-log').append(UI.typing());
        scrollDown(true);

        AI.reply(view, text, subject.id, function (answer) {
            $('#typing').remove();

            // Only the parts a stored message is allowed to carry
            var payload = {};

            ANSWER_KEYS.forEach(function (key) {
                if (answer[key]) { payload[key] = answer[key]; }
            });

            API.storeAiMessage(payload, clientRef()).then(function (data) {
                answer.id = data.messageId;
                answer.role = 'them';
                answer.read = true;
                messages.push(answer);
                latestId = Math.max(latestId, data.latestId || 0);
                done();

            }, function (err) {
                /* Saving failed, but the answer is still worth reading. Show it
                   and say plainly that it will not be here after a refresh -
                   quietly dropping it would be worse, and quietly keeping it
                   would be a lie. */
                answer.role = 'them';
                messages.push(answer);

                UI.toast({
                    title: 'Answer not saved',
                    message: err.error + ' You can read it now, but it will not be here after a refresh.',
                    tone: 'warn'
                });
                done();
            });
        });

        function done() {
            busy = false;
            setSending(false);
            drawMessages();
            scrollDown(true);
            refreshList();
        }
    }


    /* ======================================================================
       ATTACHMENTS

       The file is uploaded THE MOMENT IT IS PICKED, and the id that comes back
       is attached when the message is finally sent. That way a slow upload
       happens while you are still typing rather than after you press send.
       ====================================================================== */

    function addFiles(fileList) {
        for (var i = 0; i < fileList.length; i++) { uploadOne(fileList[i]); }
    }

    function uploadOne(file) {
        // A chip appears immediately, showing progress, so nothing feels stuck
        var slot = {
            name: file.name,
            size: file.size,
            type: file.type,
            isImage: String(file.type || '').indexOf('image/') === 0,
            progress: 0,
            attachmentId: null
        };

        pending.push(slot);
        drawTray();

        /* The third argument is the conversation, and passing it is what makes
           the assistant READ the file rather than just store it: the server
           extracts the text, describes it, and files it against the customer.
           See the note in api/_routes/upload.ts.

           `open` is the thread row, NOT `subject` - subject is the customer the
           PRUWise conversation is ABOUT, and its id is a person id, which the
           endpoint would reject. Only a conversation with a person gets this:
           PRUWise's own thread answers through /api/ai and has no customer whose
           shelf a document would belong on. */
        var readIt = (open && !isAi()) ? open.id : null;

        API.upload(file, function (percent) {
            slot.progress = percent;
            drawTray();
        }, readIt).then(function (data) {
            /* Trust the SERVER's answer about what the file is. It sniffed the
               actual bytes; the browser only reported what the file was called.
               See api/_lib/files.ts for why that difference matters. */
            slot.attachmentId = data.attachmentId;
            slot.name = data.name;
            slot.size = data.size;
            slot.type = data.type;
            slot.isImage = data.isImage;
            slot.url = data.url;
            drawTray();

            /* WHAT PRUWISE MADE OF IT, said once, quietly, at the moment it is
               useful. Null for an image or anything with no text layer, in which
               case nothing is shown rather than "could not read that" - a photo
               is a perfectly normal thing to send and does not need an apology. */
            if (data.document && data.document.status === 'ready') {
                showReadNote(data.document);
            }

            /* Refresh the file list beside the conversation, so what was just
               shared appears there without a reload. */
            loadThreadFiles();

        }, function (err) {
            var at = pending.indexOf(slot);
            if (at !== -1) { pending.splice(at, 1); }
            drawTray();

            UI.toast({
                title: 'Could not attach ' + file.name,
                message: err.error,
                tone: 'warn'
            });
        });
    }

    /* ----------------------------------------------------------------------
       "PRUWISE READ THIS"

       Shown in the conversation the moment a file with readable text finishes
       uploading, before the message is even sent.

       IT IS NOT A MESSAGE. Nothing is written to the database and the other
       person does not see it - they get their own note from the document on
       their side. It is a note to the sender about what the assistant
       understood, and it disappears on the next redraw, which is right: the
       document itself is on the documents page permanently, and this is just the
       receipt.

       THE FIGURES IN IT ARE QUOTATIONS. They came from a regular expression over
       the file's own text, not from the model, and the wording says so. See
       findFigures in api/_lib/documents.ts.
       ---------------------------------------------------------------------- */
    function showReadNote(doc) {
        var figures = (doc.notes && doc.notes.figures) ? doc.notes.figures : [];

        var body = '<div class="t-xs">' + FMT.esc(doc.summary || '') + '</div>';

        if (figures.length) {
            body += '<div class="row-2 wrap" style="margin-top:6px">' +
                figures.slice(0, 6).map(function (f) {
                    return '<span class="docs-figure">' + FMT.esc(f) + '</span>';
                }).join('') + '</div>' +
                '<div class="t-xs subtle" style="margin-top:4px">' +
                'Copied from the file, not calculated.</div>';
        }

        body += '<div style="margin-top:8px">' +
            UI.btn({
                /* Was a link to a separate documents page. There isn't one any
                   more - the files are listed in the rail beside this
                   conversation, which is closer than a different screen was. */
                label: 'See the files in this conversation', variant: 'ghost', size: 'xs',
                iconRight: 'arrowRight', act: 'show-files'
            }) + '</div>';

        $('#thread-log').append(
            '<div class="read-note" role="status">' +
            '<span class="read-note-head">' + UI.icon('sparkles', 13) +
            '<span>PRUWise read ' + FMT.esc(doc.name) + '</span></span>' +
            body + '</div>'
        );

        scrollDown(true);
    }

    /* ----------------------------------------------------------------------
       FILES SHARED HERE

       The documents PRUWise has read in this conversation, in the rail beside it.
       Replaced the Documents page entirely.

       Every file already went through /api/upload?thread=<id>, which extracts the
       text and stores a neutral description - so this list is the same records the
       old page showed, in the place they were shared.
       ---------------------------------------------------------------------- */
    function loadThreadFiles() {
        var $box = $('#ctx-files');
        if (!$box.length || !subject) { return; }

        API.documents.list(view === 'fr' ? subject.id : '').then(

            function (data) {
                /* Only the files from THIS conversation. A client's whole shelf
                   would include things sent long ago in other threads, which is
                   not what "files in this conversation" means. */
                var mine = (data.documents || []).filter(function (d) {
                    return open && Number(d.threadId) === Number(open.threadId);
                });

                if (!mine.length) { $box.empty(); return; }

                $box.html('<div class="ctx-card">' +
                    '<div class="ctx-card-head">' + UI.icon('folder', 13) +
                    '<span>Files shared here</span></div>' +

                    '<div class="ctx-files">' + mine.map(function (d) {
                        var read = d.status === 'ready';

                        return '<div class="ctx-file">' +
                            '<span class="ctx-file-top">' +
                            UI.icon(String(d.mime).indexOf('image/') === 0 ? 'image' : 'file', 13) +
                            '<span class="ctx-file-name" title="' + FMT.esc(d.name) + '">' +
                            FMT.esc(d.name) + '</span>' +
                            '</span>' +

                            (read && d.summary
                                ? '<span class="ctx-file-sum">' + FMT.esc(d.summary) + '</span>'
                                : '<span class="ctx-file-sum subtle">' +
                                  FMT.esc(d.error || 'Not read automatically') + '</span>') +

                            '<span class="ctx-file-acts">' +

                            /* SAVE FILE. The user asked for this on photos and it
                               belongs on everything: `download` rather than a plain
                               link, so the browser writes it to disk with its real
                               name instead of navigating away from the app to show
                               it. */
                            (d.url
                                ? '<a class="ctx-file-btn" href="' + FMT.esc(d.url) +
                                  '" download="' + FMT.esc(d.name) + '">' +
                                  UI.icon('download', 12) + '<span>Save</span></a>' +
                                  '<a class="ctx-file-btn" href="' + FMT.esc(d.url) +
                                  '" target="_blank" rel="noopener">' +
                                  UI.icon('externalLink', 12) + '<span>Open</span></a>'
                                : '') +

                            (read
                                ? '<button type="button" class="ctx-file-btn" ' +
                                  'data-act="file-text" data-id="' + d.id + '">' +
                                  UI.icon('fileText', 12) + '<span>Text</span></button>'
                                : '') +

                            '</span></div>';
                    }).join('') + '</div>' +
                    '</div>');
            },

            function () { $box.empty(); }
        );
    }

    function drawTray() {
        $('#attach-tray').html(pending.map(function (f, i) {
            if (f.attachmentId) { return UI.attachChip(f, i); }

            // Still going up: same chip, with a percentage instead of a size
            return '<span class="attach-chip">' + UI.icon('paperclip', 13) +
                '<span class="name">' + FMT.esc(f.name) + '</span>' +
                '<span class="size">' + f.progress + '%</span></span>';
        }).join(''));
    }


    /* ======================================================================
       THE CONTEXT RAIL

       Everything PRUWise is reading to answer you, moved here from the old
       PRUWise page. Almost every card is also a way to ASK something - the
       policy rows, the glossary chips and the appointment button all carry
       data-act="ask-ai", so the rail is a set of questions as much as a set of
       facts.
       ====================================================================== */
    function contextCards() {
        var isFr = (view === 'fr');
        var policies = DATA.policiesFor(subject.id);
        var recs = DATA.recsFor(subject.id);
        var appt = DATA.nextApptFor(subject.id);
        var rep = DATA.getRep(subject.repId);
        var ratio = DATA.coverageRatio(subject);
        var cards = [];

        var cardHead = function (icon, label) {
            return '<div class="ctx-card-head">' + UI.icon(icon, 13) + '<span>' + label + '</span></div>';
        };

        /* --- said out loud, if the figures are not really theirs --- */
        if (!realProfile) {
            cards.push('<div class="ctx-card">' +
                cardHead('info', 'Sample figures') +
                '<div class="t-xs muted">Your account is real and this conversation is saved, but ' +
                'there is no policy record attached to it yet. PRUWise is reading ' +
                FMT.esc(subject.name) + '\u2019s sample profile, so treat every amount below as ' +
                'an example rather than your own cover.</div>' +
                '</div>');
        }

        /* --- FILES SHARED IN THIS CONVERSATION ---

           This is what replaced the separate Documents page. The reasoning was
           the user's and it is right: a file is shared IN a conversation, read in
           that conversation, and replied to in that conversation. Making people
           leave for a different screen to see the same list was one function
           split across two places.

           An empty container - loadThreadFiles() fills it, because the list comes
           from the server. Nothing is drawn when there are no files, so the rail
           does not carry a permanent empty panel. */
        cards.push('<div id="ctx-files"></div>');

        /* --- who we are talking about --- */
        cards.push('<div class="ctx-card">' +
            cardHead('user', isFr ? 'Client context' : 'Your details') +
            '<div class="row-2">' + UI.avatar(subject.name, 'lg', { seed: subject.id }) +
            '<div style="min-width:0">' +
            '<div class="t-sm bold truncate">' + FMT.esc(subject.name) + '</div>' +
            '<div class="t-xs muted truncate">' + FMT.esc(subject.age + ' | ' + subject.occupation) + '</div>' +
            '<div class="t-xs subtle truncate">' + FMT.esc(subject.riskProfile + ' risk | ' + subject.segment) + '</div>' +
            '</div></div>' +
            UI.meter({
                label: 'Protection in place', value: ratio + '%', percent: ratio, thin: true,
                tone: ratio >= 80 ? 'ok' : (ratio >= 55 ? '' : 'warn')
            }) +
            UI.kv([
                [isFr ? 'Monthly premium' : 'You pay', FMT.money(DATA.monthlyPremium(subject.id))],
                ['Shortfall', FMT.moneyShort(DATA.coverageGap(subject))],
                isFr ? ['Budget', FMT.money(subject.money.premiumBudget) + '/mo'] : null
            ]) +
            UI.btn({
                label: isFr ? 'Open full profile' : 'See my plans',
                variant: 'outline', size: 'xs', block: true, iconRight: 'arrowRight',
                href: isFr ? '#/fr/customer/' + subject.id : '#/me/plans'
            }) +
            '</div>');

        /* --- coverage snapshot --- */
        cards.push('<div class="ctx-card">' +
            cardHead('shield', 'Coverage snapshot') +
            UI.coverageBars(subject) +
            '<button type="button" class="prompt-chip block" data-act="ask-ai" data-q="' +
            (isFr ? 'Where is the biggest gap?' : 'What am I currently protected against?') + '">' +
            UI.icon('messageCircle', 13) + '<span>' +
            (isFr ? 'Ask about this gap' : 'Ask what this means for me') + '</span></button>' +
            '</div>');

        /* --- policies in force, each one a question --- */
        cards.push('<div class="ctx-card">' +
            cardHead('fileText', 'Policies in force (' + policies.length + ')') +
            '<div class="stack-2">' + policies.map(function (p) {
                var question = isFr
                    ? 'Tell me about the ' + p.name + ' policy'
                    : 'Explain my ' + p.name + ' policy in simple terms';

                return '<button type="button" class="talkpoint" data-act="ask-ai" data-q="' + FMT.esc(question) + '">' +
                    '<span style="color:var(--brand);flex-shrink:0">' + UI.icon(p.icon, 14) + '</span>' +
                    '<span style="min-width:0">' +
                    '<span class="t-xs semi truncate" style="display:block">' + FMT.esc(p.name) + '</span>' +
                    '<span class="t-xs muted truncate" style="display:block">' + FMT.esc(p.coverText) + '</span>' +
                    '</span></button>';
            }).join('') + '</div></div>');

        /* --- the recommendation --- */
        if (recs.length) {
            var rec = recs[0];

            cards.push('<div class="ctx-card" style="background-image:var(--brand-grad-soft);border-color:var(--brand-border)">' +
                cardHead('sparkles', isFr ? 'Top recommendation' : 'Prepared for you') +
                '<div class="t-sm bold">' + FMT.esc(rec.product.name) + '</div>' +
                '<div class="t-xs muted">' + FMT.esc(rec.headline) + '</div>' +
                UI.kv([
                    ['Cover', rec.coverLabel],
                    ['Premium', rec.premiumLabel],
                    ['Fit score', rec.fit + '/100']
                ]) +
                UI.btn({
                    label: isFr ? 'Open recommendation' : 'Read the explanation',
                    size: 'xs', block: true, iconRight: 'arrowRight',
                    href: isFr ? '#/fr/recommendations?rec=' + rec.id : '#/me/dashboard'
                }) +
                '</div>');
        }

        /* --- next appointment --- */
        if (appt) {
            cards.push('<div class="ctx-card">' +
                cardHead('calendar', 'Next appointment') +
                '<div class="t-sm semi">' + FMT.esc(appt.title) + '</div>' +
                '<div class="t-xs muted">' + FMT.time(appt.start) + ' | ' + FMT.esc(appt.type) + '</div>' +
                '<div class="t-xs subtle">' + FMT.esc(isFr ? subject.name : rep.name) + '</div>' +
                UI.btn({
                    label: isFr ? 'Prepare talking points' : 'What should I ask?',
                    variant: 'soft', size: 'xs', block: true, icon: 'sparkles',
                    act: 'ask-ai',
                    data: { q: isFr ? 'Prepare talking points for the call' : 'What should I discuss with my representative?' }
                }) +
                '</div>');
        }

        /* --- saved questions (customer only) --- */
        if (!isFr) {
            var saved = STATE.questions;

            cards.push('<div class="ctx-card">' +
                cardHead('bookmark', 'My saved questions') +
                (saved.length
                    ? '<div class="stack-2">' + saved.slice(0, 4).map(function (q) {
                        return '<div class="t-xs" style="display:flex;gap:8px">' +
                            '<span style="color:var(--brand);flex-shrink:0">' + UI.icon('check', 12) + '</span>' +
                            '<span>' + FMT.esc(q) + '</span></div>';
                    }).join('') + '</div>'
                    : '<div class="t-xs muted">Nothing saved yet. Ask "What should I discuss with my ' +
                    'representative?" and save the ones that matter to you.</div>') +
                UI.btn({
                    label: 'Review my questions', variant: 'outline', size: 'xs', block: true,
                    icon: 'bookmark', act: 'open-questions'
                }) +
                '</div>');
        }

        /* --- glossary shortcuts --- */
        cards.push('<div class="ctx-card">' +
            cardHead('bookOpen', 'Explain a term') +
            '<div class="chips">' + DATA.glossary.slice(0, 6).map(function (t) {
                return UI.chip({ label: t.term, act: 'ask-ai', data: { q: 'What does ' + t.term + ' mean?' } });
            }).join('') + '</div></div>');

        return cards.join('');
    }

    /* The same cards as a pop-up, for phones and tablets where the rail does
       not fit. One implementation, two places to show it. */
    function openContextSheet() {
        UI.openModal({
            title: (view === 'fr') ? 'Client context' : 'Your context',
            sub: 'Everything PRUWise is using to answer',
            size: 'lg',
            body: '<div class="stack-4">' + contextCards() + '</div>',
            foot: null
        });
    }


    /* ======================================================================
       ASKING FROM SOMEWHERE ELSE

       Buttons all over the app carry data-act="ask-ai". If we are not on this
       screen, we remember the question, come here, and ask it once the
       conversation is loaded.
       ====================================================================== */

    function ask(question) {
        var text = $.trim(String(question || ''));
        if (!text) { return; }

        // Not on Messages at all: go there, PRUWise open, and ask on arrival
        if (!$('#msgs').length) {
            pendingQuestion = text;
            wantAi = true;
            go((STATE.session.role === 'fr') ? '/fr/messages' : '/me/messages');
            return;
        }

        // The click may have come from the context sheet, or the prompts dropdown
        UI.closeModal();
        UI.closeDrops();

        // On Messages but in a human conversation: switch to PRUWise first
        if (!isAi()) {
            pendingQuestion = text;
            openThread({ kind: 'ai' });
            return;
        }

        $('#msg-input').val(text);
        send();
    }

    function runPendingQuestion() {
        if (!pendingQuestion) { return; }

        var question = pendingQuestion;
        pendingQuestion = null;

        // A short pause so the conversation is drawn before the answer lands on it
        window.setTimeout(function () {
            $('#msg-input').val(question);
            send();
        }, 250);
    }

    /* Something elsewhere asked for the PRUWise conversation by name - the old
       /fr/pruwise address, or the sparkle button on a customer card. */
    function focusAi() {
        wantAi = true;
        if ($('#msgs').length) { openThread({ kind: 'ai' }); }
    }

    /* Open the conversation with a particular PERSON, from somewhere else in the
       app - the Consult button on an appointment card, mainly.

       Two paths on purpose. Already on this screen and nothing navigates, so the
       conversation has to be opened here and now. Arriving from another page,
       after() runs next and firstSpec() picks `wantPerson` up.

       { withPerson } rather than a thread id because there may not BE a thread
       yet: the server creates one on first use, so this works for a customer the
       representative has never messaged. */
    function openWith(personId) {
        var id = String(personId || '');
        if (!id) { return; }

        wantPerson = id;

        if ($('#msgs').length) {
            wantPerson = null;
            openThread({ withPerson: id });
        }
    }


    /* ======================================================================
       CLICK HANDLERS

       Registered once, on document, so they survive every re-render.
       ====================================================================== */
    function registerHandlers() {

        // Open a conversation
        $(document).on('click', '[data-act="open-thread"]', function () {
            var id = Number($(this).data('id'));

            STATE.threadOpened = true;
            $('#msgs').removeClass('show-list').addClass('show-thread');

            if (open && open.threadId === id) { return; }
            openThread({ threadId: id });
        });

        // Phone only: back to the conversation list
        $(document).on('click', '[data-act="thread-back"]', function () {
            STATE.threadOpened = false;
            $('#msgs').removeClass('show-thread').addClass('show-list');
        });

        $(document).on('click', '#msg-send', function () { send(); });

        // The paperclip opens the hidden file input
        $(document).on('click', '[data-act="pick-file"]', function () {
            $('#file-input').trigger('click');
        });

        $(document).on('change', '#file-input', function () {
            addFiles(this.files);
            this.value = '';   // lets you pick the same file again later
        });

        // Remove one waiting attachment
        $(document).on('click', '[data-act="drop-attach"]', function () {
            pending.splice(Number($(this).data('index')), 1);
            drawTray();
        });

        // Tap a sent image to see it full size
        $(document).on('click', '[data-act="view-image"]', function () {
            UI.openModal({
                title: $(this).data('name') || 'Image',
                size: 'lg',
                body: '<img class="image-viewer" src="' + $(this).data('url') + '" alt="">',
                foot: UI.btn({ label: 'Close', variant: 'outline', act: 'close-modal' })
            });
        });

        /* =================================================================
           EDITING AND DELETING SOMETHING YOU SAID
           ================================================================= */

        /* EDITING HAPPENS IN PLACE, in the bubble, not in a modal.

           A modal would cover the conversation, and the conversation is the context
           you need in order to decide what the message should have said. The bubble
           becomes a textarea with Save and Cancel and everything else stays where
           it was. */
        $(document).on('click', '[data-act="msg-edit"]', function () {
            var id = Number($(this).data('id'));
            var msg = messageById(id);

            if (!msg) { return; }

            var current = (msg.paragraphs || []).join('\n');
            var $row = $('.msg[data-msg="' + id + '"]');

            /* Already editing this one - a second click should not nest a second
               textarea inside the first. */
            if ($row.find('.msg-edit-box').length) { return; }

            $row.find('.msg-bubble').first().hide();

            $row.find('.msg-body').prepend(
                '<div class="msg-edit-box">' +
                '<textarea class="textarea msg-edit-input" rows="3" ' +
                'aria-label="Edit your message">' + FMT.esc(current) + '</textarea>' +
                '<div class="card-actions">' +
                UI.btn({ label: 'Save', size: 'sm', icon: 'check',
                         act: 'msg-edit-save', data: { id: id } }) +
                UI.btn({ label: 'Cancel', variant: 'ghost', size: 'sm',
                         act: 'msg-edit-cancel', data: { id: id } }) +
                '</div></div>'
            );

            var input = $row.find('.msg-edit-input')[0];

            if (input) {
                input.focus();
                /* Cursor at the END, not selecting the whole thing. Somebody
                   editing usually wants to change a word, and a full selection
                   means the first keystroke destroys the message. */
                input.setSelectionRange(current.length, current.length);
            }
        });

        $(document).on('click', '[data-act="msg-edit-cancel"]', function () {
            var id = Number($(this).data('id'));
            var $row = $('.msg[data-msg="' + id + '"]');

            $row.find('.msg-edit-box').remove();
            $row.find('.msg-bubble').first().show();
        });

        $(document).on('click', '[data-act="msg-edit-save"]', function () {
            var $btn = $(this);
            if ($btn.hasClass('is-loading')) { return; }

            var id = Number($btn.data('id'));
            var $row = $('.msg[data-msg="' + id + '"]');
            var text = $.trim($row.find('.msg-edit-input').val() || '');

            if (!text) {
                UI.toast({
                    tone: 'warn',
                    title: 'An edit cannot be empty',
                    message: 'Use Delete if you want the message gone - that leaves a ' +
                        'mark saying so.'
                });
                return;
            }

            $btn.addClass('is-loading').prop('disabled', true);

            API.editMessage(id, text).then(

                function (data) {
                    /* The server's version replaces ours. It has just built the
                       authoritative message for this viewer, including the edited
                       stamp, and reconstructing that here would be a second opinion
                       about what the message now says. */
                    replaceMessage(data.message);
                    drawMessages();

                    if (data.changed) {
                        UI.toast({ tone: 'ok', title: 'Message updated',
                                   message: 'It is marked as edited for both of you.' });
                    }
                    refreshList();
                },

                function (err) {
                    $btn.removeClass('is-loading').prop('disabled', false);
                    UI.toast({ tone: 'bad', title: 'Could not save that', message: err.error });
                }
            );
        });

        /* DELETING ASKS FIRST, and says what will actually happen.

           "This cannot be undone" is true but useless on its own. What somebody
           needs to know before pressing it is that the other person will still see
           that a message was here - because a lot of people expect deleting to mean
           nobody ever knows, and finding out afterwards is too late. */
        $(document).on('click', '[data-act="msg-delete"]', function () {
            var id = Number($(this).data('id'));

            UI.confirmModal({
                title: 'Delete this message',
                message: 'The words are removed for both of you, along with anything ' +
                    'attached to it. ' + (open && open.name ? open.name : 'The other person') +
                    ' will still see that a message was here and was deleted - it is ' +
                    'not removed from the conversation, because they have already read it.',
                confirmLabel: 'Delete it',
                tone: 'danger',
                confirmAct: 'msg-delete-do',
                confirmData: { id: id }
            });
        });

        $(document).on('click', '[data-act="msg-delete-do"]', function () {
            var id = Number($(this).data('id'));

            UI.closeModal();

            API.deleteMessage(id).then(

                function (data) {
                    replaceMessage(data.message);
                    drawMessages();
                    refreshList();

                    UI.toast({ title: 'Message deleted', tone: 'ok' });
                },

                function (err) {
                    UI.toast({ tone: 'bad', title: 'Could not delete that', message: err.error });
                }
            );
        });

        /* Use a draft reply. It only fills the box - a person still has to
           press send, which is the whole point. */
        $(document).on('click', '[data-act="use-suggestion"]', function () {
            var $input = $('#msg-input');

            $input.val($(this).data('text')).trigger('focus');
            $input[0].style.height = 'auto';
            $input[0].style.height = Math.min($input[0].scrollHeight, 132) + 'px';
        });

        /* HIDE AND SHOW, and the choice is remembered.

           It used to only slide the box away, which left no route back short of
           reloading the page - so "hide" was really "delete until further
           notice". Now it collapses to a one-line button and the preference
           persists, which is what people mean by hiding something. */
        $(document).on('click', '[data-act="hide-suggest"]', function () {
            setSuggestHidden(true);

            $('#suggest-box').slideUp(150, function () {
                $('#suggest-slot').html(UI.suggestBox({ collapsed: true }));
            });
        });

        $(document).on('click', '[data-act="show-suggest"]', function () {
            setSuggestHidden(false);
            drawSuggestions();

            /* Asked here as well as in drawSuggestions, because unfolding the
               strip is the clearest signal yet that somebody wants a suggestion -
               and if the model was never asked while it was folded away, there is
               nothing cached to show. */
            askForBetterSuggestions();
        });

        /* Ask again. The conversation may have moved on since the last answer,
           and a second opinion is cheap - it counts against the same hourly
           allowance as everything else, so it cannot be leaned on. */
        $(document).on('click', '[data-act="refresh-suggest"]', function () {
            /* REMEMBER WHAT IS BEING REJECTED BEFORE CLEARING IT.

               This is the line the feature was missing. Refresh emptied the cache
               and asked again with no record of what had just been turned down, so
               the server - having no way to tell a first ask from a fifth - answered
               the same way every time. */
            var shown = aiSuggest.items || localSuggestions().items || [];

            aiSuggest.rejected = aiSuggest.rejected.concat(shown).slice(-12);
            aiSuggest.items = null;
            aiSuggest.threadId = null;
            aiSuggest.exhausted = false;

            /* ==========================================================
               THE FORCED ASK GOES FIRST, AND THE ORDER WAS A REAL BUG

               It used to be drawSuggestions() and then
               askForBetterSuggestions(true). drawSuggestions() ends by calling
               askForBetterSuggestions() ITSELF, unforced - which set
               aiSuggest.asking = true and fired a request. The forced call on the
               next line then hit `if (aiSuggest.asking) { return; }` and did
               nothing at all.

               So Refresh never made a forced request. It made the ordinary one,
               which is the one allowed to answer from cache and to skip the
               higher temperature and the "do not repeat these" instruction.

               Forced first: it claims `asking`, and drawSuggestions()'s own
               unforced attempt then correctly early-returns.
               ========================================================== */
            askForBetterSuggestions(true);
            drawSuggestions();
        });

        // Ask PRUWise something, from anywhere in the app
        $(document).on('click', '[data-act="ask-ai"]', function () {
            ask($(this).data('q'));
        });

        // The context sheet, on screens too narrow for the rail
        $(document).on('click', '[data-act="nav-context"]', function () {
            openContextSheet();
        });

        /* Which customer PRUWise is reading about.

           stopPropagation, because app.js closes any open dropdown on a click
           anywhere else - including, without this, the click that opened it. */
        $(document).on('click', '[data-act="pruwise-subject"]', function (e) {
            e.stopPropagation();

            var rows = DATA.customers.map(function (c) {
                var on = (c.id === subject.id);

                return '<button type="button" class="menu-item' + (on ? ' is-on' : '') + '" ' +
                    'data-act="nav-customer" data-id="' + c.id + '">' +
                    UI.avatar(c.name, 'xs', { seed: c.id }) +
                    '<span class="grow"><span class="t-sm semi truncate">' + FMT.esc(c.name) + '</span>' +
                    '<span class="t-xs muted truncate">' + FMT.esc(c.segment) + '</span></span>' +
                    (on ? UI.icon('check', 15) : '') + '</button>';
            }).join('');

            UI.openDrop($(this).closest('.drop-anchor'),
                '<div class="drop-head"><span>PRUWise is reading about</span></div>' +
                '<div class="menu">' + rows + '</div>');
        });

        // Questions worth asking, for a customer
        $(document).on('click', '[data-act="pruwise-prompts"]', function (e) {
            e.stopPropagation();

            var rows = AI.suggestions(view, subject).slice(0, 6).map(function (q) {
                return '<button type="button" class="menu-item" data-act="ask-ai" ' +
                    'data-q="' + FMT.esc(q) + '">' + UI.icon('messageCircle', 15) +
                    '<span class="grow"><span class="t-sm truncate">' + FMT.esc(q) + '</span></span>' +
                    '</button>';
            }).join('');

            UI.openDrop($(this).closest('.drop-anchor'),
                '<div class="drop-head"><span>Ask PRUWise</span></div>' +
                '<div class="menu">' + rows + '</div>', { wide: true });
        });

        /* A representative changing who PRUWise is reading about. The
           conversation itself does not change - there is one PRUWise
           conversation per person, and this is what it is looking at now. */
        $(document).on('click', '[data-act="nav-customer"]', function () {
            STATE.activeCustomerId = $(this).data('id');
            saveState();
            UI.closeDrops();

            if (!$('#msgs').length) { focusAi(); go('/fr/messages'); return; }

            findSubject();
            drawThreadPane();
        });

        // Filter the conversation list as you type
        $(document).on('input', '#msg-search', applyFilter);

        /* Scroll the file list into view. The "See the files in this
           conversation" button used to be a link to a separate page. */
        $(document).on('click', '[data-act="show-files"]', function () {
            var box = document.getElementById('ctx-files');

            if (!box) { return; }

            box.scrollIntoView({ behavior: 'smooth', block: 'center' });
            $(box).addClass('is-flash');
            window.setTimeout(function () { $(box).removeClass('is-flash'); }, 1200);
        });

        /* What PRUWise actually read out of a file, so a summary can be checked
           against the text rather than taken on trust. */
        $(document).on('click', '[data-act="file-text"]', function () {
            var id = Number($(this).data('id'));

            UI.openModal({
                title: 'What PRUWise read',
                sub: 'The text pulled out of the file',
                size: 'lg',
                body: UI.loadingState('Fetching the text\u2026')
            });

            API.documents.get(id).then(
                function (data) {
                    $('.modal-body').html(data.text
                        ? '<pre class="docs-text">' + FMT.esc(data.text) + '</pre>'
                        : UI.emptyState({
                            icon: 'fileText',
                            title: 'There is no text in this one',
                            text: (data.document && data.document.error) ||
                                'Nothing could be extracted from this file.'
                        }));
                },
                function (err) {
                    $('.modal-body').html(UI.errorState({
                        title: 'That could not be loaded', text: err.error
                    }));
                }
            );
        });

        // Start a video call with whoever is open
        $(document).on('click', '[data-act="msg-call"]', function () {
            if (view === 'fr' && open && open.personId) {
                STATE.activeCustomerId = open.personId;
                saveState();
                go('/fr/call');
            } else {
                go('/me/call');
            }
        });
    }

    registerHandlers();

    return {
        render: render,
        after: after,
        ask: ask,
        focusAi: focusAi,
        openWith: openWith,
        stopPolling: stopPolling
    };

})();


/* --------------------------------------------------------------------------
   Routes

   Two addresses, one screen. The sub-line names both halves of it, because
   "Messages" alone no longer says that PRUWise is in here too.
   -------------------------------------------------------------------------- */
PAGES['/fr/messages'] = {
    title: 'Messages',
    sub: 'PRUWise and every client, in one place',
    flush: true,
    render: MESSAGES.render,
    after: MESSAGES.after
};

PAGES['/me/messages'] = {
    title: 'Messages',
    sub: 'PRUWise and your representative, in one place',
    flush: true,
    render: MESSAGES.render,
    after: MESSAGES.after
};
