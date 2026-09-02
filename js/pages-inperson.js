/* ==========================================================================
   pages-inperson.js
   --------------------------------------------------------------------------
   /fr/inperson  -  live transcribe for a meeting you are sitting in

   The one kind of meeting the app could not help with. A video call is
   transcribed because each browser hears its own microphone; a chat is text
   already. An in-person meeting had nothing - the representative wrote notes by
   hand afterwards, from memory, which is where detail goes to die.

   So: the app is left open on the table, this screen listens, and everything
   PRUWise does with a call transcript it now does with this one.

   ==========================================================================
   ONE MICROPHONE, TWO PEOPLE, AND WHAT THAT HONESTLY MEANS
   ==========================================================================

   A video call transcribes each side separately, so every line carries the account
   that said it. Here there is ONE microphone hearing BOTH people, and telling two
   voices apart in a mixed stream is diarisation - a hard research problem, not a
   checkbox. See the note at the top of js/call.js.

   This screen therefore does NOT claim to know who said what. Lines are recorded
   in order, unattributed, and the screen says so in as many words. That is a real
   limitation and hiding it would be worse than the limitation: a transcript with
   confident wrong speaker labels is more dangerous than one with none, because
   somebody will quote it.

   What still works perfectly without speaker labels: the figures, the life events,
   the commitments, the meeting requests. api/_lib/insights.ts reads SENTENCES.

   ==========================================================================
   NOTHING IS SENT ANYWHERE UNTIL THE MEETING IS SAVED
   ==========================================================================

   Well - with one honest caveat that is the browser's doing, not ours. The Web
   Speech API in Chrome sends the audio to Google to be turned into text. That is
   how it works, it is worth telling anybody you demo this to, and it is stated on
   the screen rather than buried here.

   The TEXT stays in this tab until either PRUWise is asked to read it or the
   meeting is saved. Analysis writes proposals, not records - see
   api/_routes/insights.ts.
   ========================================================================== */

var INPERSON = (function () {

    /* ---------------------------------------------------------------- state */
    var recog = null;
    var listening = false;

    var lines = [];            // { text, at }
    var personId = '';         // who the meeting is with
    var startedAt = null;
    var saved = false;

    var analysedUpTo = 0;
    var analysedAt = 0;

    /* Long enough that a pause does not trigger a re-read, short enough that
       something said early in a long meeting is picked up while it still matters.
       Same reasoning and same figure as the call screen. */
    var ANALYSE_EVERY_MS = 90000;

    /* ======================================================================
       LANGUAGE

       ==================================================================
       THIS IS SINGAPORE, SO ONE LANGUAGE WAS NEVER GOING TO DO
       ==================================================================

       The call screen hard-codes 'en-US'. In a country where a client meeting
       routinely runs in English, Mandarin, Malay or Tamil - and often more than one
       of them in the same sentence - a fixed recogniser language means the
       transcript is wrong exactly when it matters.

       What the browser can do is one language at a time, chosen up front. So this
       is a picker, not magic, and it is honest about that: switching mid-meeting is
       one tap and the earlier lines keep whatever they were recognised as.

       en-SG rather than en-US as the default, because it handles Singaporean
       place names and the local accent noticeably better.

       WHAT THIS IS NOT: real code-switching, where somebody moves between English
       and Mandarin mid-sentence and both come out right. The browser cannot do it.
       MERaLiON is built for precisely that and is the reason it is worth
       integrating - see the note at the bottom of this file.
       ====================================================================== */
    /* ======================================================================
       DIALECTS: WHAT WAS ASKED FOR, AND WHAT ACTUALLY WORKS

       REQUESTED: "live transcribe should have dialects like singlish or hokkien
       or cantonese (if it doesnt work, dont integrate it)".

       Taking the second half of that seriously, because it is the important half.

         CANTONESE - WORKS, and is added. The recogniser has a Cantonese model
         under 'yue-Hant-HK'. It is trained on Hong Kong Cantonese, which is close
         enough to the Cantonese spoken here to be useful and not identical, so it
         is labelled honestly rather than as "Cantonese".

         SINGLISH - NO SUCH MODEL, and there was never going to be one. What
         exists is 'en-SG', an English model tuned for Singapore, and it is
         already the default on this screen. It copes with local place names,
         "can lah" and code-switched fragments far better than en-US, and it is
         the closest thing to the request that is real. Adding a menu entry
         labelled "Singlish" pointing at en-SG would be a label claiming a
         capability that does not exist.

         HOKKIEN - DOES NOT WORK. There is no Hokkien / Min Nan model in any
         browser recogniser. It is NOT in the list, per the instruction. It is
         named in the hint on the screen anyway, because somebody looking for it
         needs to know it is missing rather than assume they failed to find it.

       -----------------------------------------------------------------------
       THE LIST IS FILTERED AT RUNTIME, NOT TRUSTED
       -----------------------------------------------------------------------
       Which models a machine has depends on the browser, the platform and what
       language packs are installed - it is not a property of this code. Newer
       browsers expose SpeechRecognition.available(), so availableLangs() ASKS and
       drops anything the answer says is unavailable.

       Where that method does not exist the full list is shown, because the
       alternative - hiding options that might work perfectly - is worse than
       showing one that might not. A language that turns out to be missing fails
       visibly on start, which onerror already reports.
       ====================================================================== */
    var LANGS = [
        { code: 'en-SG', label: 'English (Singapore)' },
        { code: 'zh-CN', label: '\u4e2d\u6587 Mandarin' },
        { code: 'yue-Hant-HK', label: '\u5ee3\u6771\u8a71 Cantonese (Hong Kong model)' },
        { code: 'ms-MY', label: 'Bahasa Melayu' },
        { code: 'ta-IN', label: '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd Tamil' },
        { code: 'en-US', label: 'English (US)' }
    ];

    /* Cached, because available() is asynchronous and the picker is rendered
       synchronously. Starts as the whole list - see the note above about which way
       to be wrong - and is narrowed once the browser answers. */
    var langsAvailable = LANGS.slice();

    function refreshAvailableLangs(done) {
        var Engine = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!Engine || typeof Engine.available !== 'function') {
            if (done) { done(); }
            return;
        }

        var checked = 0;
        var keep = [];

        LANGS.forEach(function (l) {
            var settle = function (ok) {
                if (ok) { keep.push(l); }

                checked++;
                if (checked < LANGS.length) { return; }

                /* Never end up with an empty picker. If the browser claims it can
                   do nothing at all, that is far more likely to be a quirk of
                   available() than the truth, and an empty select is unusable. */
                langsAvailable = keep.length
                    ? LANGS.filter(function (x) { return keep.indexOf(x) !== -1; })
                    : LANGS.slice();

                if (done) { done(); }
            };

            try {
                var answer = Engine.available({ langs: [l.code] });

                if (answer && typeof answer.then === 'function') {
                    answer.then(
                        function (state) { settle(state && state !== 'unavailable'); },
                        function () { settle(false); }
                    );
                } else {
                    settle(!!answer && answer !== 'unavailable');
                }
            } catch (e) {
                /* An older signature, or a browser that throws on an unknown tag.
                   Keep it: an untested option that might work beats hiding it. */
                settle(true);
            }
        });
    }

    var LANG_KEY = 'pruwise.transcribe.lang';

    function lang() {
        try {
            var saved_ = window.localStorage.getItem(LANG_KEY);
            if (saved_) { return saved_; }
        } catch (e) { /* private browsing */ }

        return 'en-SG';
    }

    function setLang(code) {
        try { window.localStorage.setItem(LANG_KEY, code); }
        catch (e) { /* the choice still applies to this meeting */ }
    }


    /* ======================================================================
       THE PAGE
       ====================================================================== */
    function render() {
        lines = [];
        listening = false;
        startedAt = null;
        saved = false;
        analysedUpTo = 0;
        analysedAt = 0;

        var supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

        var langOptions = langsAvailable.map(function (l) {
            return '<option value="' + l.code + '"' +
                (l.code === lang() ? ' selected' : '') + '>' + FMT.esc(l.label) + '</option>';
        }).join('');

        return UI.pageHead({
            eyebrow: 'In person',
            title: 'Live transcribe',
            sub: 'Leave this open on the table during a meeting. PRUWise writes down what is ' +
                'said and reads it the same way it reads a call.',
            actions: UI.aitag('PRUWise')
        }) +

            (supported ? '' : UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'This browser cannot listen',
                text: 'Live transcribe needs Chrome, Edge or Safari. Firefox has no speech ' +
                    'recognition, so there is nothing this screen can do in it. Everything ' +
                    'else in the app works normally.'
            })) +

            '<div class="split split-rail">' +

            /* ---------------------------------------------- left: the meeting */
            '<div class="stack">' +

            UI.card({ title: 'The meeting', icon: 'mic' },
                '<div class="grid-2">' +

                '<div class="field">' +
                '<label class="field-label" for="ip-who">Who is it with</label>' +
                '<select class="select" id="ip-who"><option value="">Loading your clients\u2026</option></select>' +
                '<div class="field-hint">Anything PRUWise notices is proposed on their ' +
                'record, so this has to be right.</div>' +
                '</div>' +

                '<div class="field">' +
                '<label class="field-label" for="ip-lang">Language</label>' +
                '<select class="select" id="ip-lang">' + langOptions + '</select>' +
                /* SAYS WHAT IS MISSING. Somebody sent here looking for Hokkien
                   will otherwise assume they have failed to find the setting. See
                   the long note above LANGS for which dialects are real. */
                '<div class="field-hint">The recogniser listens for one language at a ' +
                'time, and you can change it mid-meeting - earlier lines keep whatever ' +
                'they were recognised as. English (Singapore) handles local place names ' +
                'and Singlish far better than English (US), which is why it is the ' +
                'default. <strong>Hokkien and Teochew are not available:</strong> no ' +
                'browser has a model for them, so they are left out rather than ' +
                'offered and quietly transcribed as something else.</div>' +
                '</div>' +
                '</div>' +

                '<div class="card-actions">' +
                UI.btn({
                    label: 'Start listening', icon: 'mic', act: 'ip-start',
                    cls: 'ip-start'
                }) +
                UI.btn({
                    label: 'Stop', variant: 'outline', icon: 'micOff', act: 'ip-stop',
                    cls: 'ip-stop'
                }) +
                '</div>' +

                /* SAID ON THE SCREEN, not in a comment. Somebody about to record a
                   client conversation is entitled to know where the audio goes and
                   that the other person is in the room to be told. */
                UI.callout({
                    tone: 'info', icon: 'info',
                    title: 'Tell them you are doing this',
                    text: 'The browser sends the audio to its speech service to be turned ' +
                        'into text. Nothing is stored anywhere until you save the meeting, ' +
                        'and nothing changes a client record without you confirming it - but ' +
                        'recording somebody without saying so is not something an app can ' +
                        'make acceptable.'
                })
            ) +

            /* The live line, big, because during a meeting nobody is reading a
               scrollback - they want to see that it is working. */
            '<div class="ip-live" id="ip-live">' +
            '<div class="ip-live-head">' +
            '<span class="ip-dot" id="ip-dot"></span>' +
            '<span id="ip-status">Not listening</span>' +
            '<span class="ip-clock" id="ip-clock"></span>' +
            '</div>' +
            '<div class="ip-final" id="ip-final"></div>' +
            '<div class="ip-interim" id="ip-interim"></div>' +
            '</div>' +

            UI.card({
                title: 'What was said',
                subHtml: '<span id="ip-count">Nothing yet</span>',
                icon: 'clipboard',
                actions: UI.btn({
                    label: 'Copy', variant: 'ghost', size: 'xs', icon: 'clipboard',
                    act: 'ip-copy'
                })
            },
                '<div class="ip-log" id="ip-log">' +
                '<div class="t-sm muted">Press Start listening and talk. Settled sentences ' +
                'appear here in the order they were said.</div>' +
                '</div>' +

                /* THE HONEST CAVEAT, next to the transcript rather than hidden in
                   a tooltip. One microphone cannot tell two voices apart. */
                '<div class="t-xs muted" style="margin-top:12px">' +
                UI.icon('info', 12) + ' One microphone hears both of you, so these lines are ' +
                'not labelled with who said them - telling two voices apart in one recording ' +
                'is not something a browser can do. The order is right.' +
                '</div>'
            ) +

            '</div>' +

            /* --------------------------------------------- right: PRUWise */
            '<div class="stack">' +

            UI.card({
                title: 'What PRUWise noticed',
                sub: 'Read from the meeting as it goes',
                icon: 'sparkles',
                actions: UI.btn({
                    label: 'Read it now', variant: 'soft', size: 'xs', icon: 'refresh',
                    act: 'ip-analyse'
                })
            },
                '<div id="ip-found">' +
                '<div class="t-sm muted">PRUWise reads the transcript every minute or so, and ' +
                'whenever you ask. Anything it finds is proposed on the client\u2019s profile ' +
                'for you to confirm or dismiss - nothing is written to their record here.</div>' +
                '</div>'
            ) +

            UI.card({ title: 'When you are finished', icon: 'check' },
                '<div class="t-sm muted">Saving files the transcript against the client and ' +
                'puts a line in your conversation with them, so it is findable later. The ' +
                'proposals PRUWise made stay on their profile either way.</div>' +
                '<div class="card-actions">' +
                UI.btn({ label: 'Save the meeting', icon: 'check', block: true, act: 'ip-save' }) +
                '</div>'
            ) +

            UI.listensFor({ label: 'What makes PRUWise notice something' }) +

            '</div></div>';
    }

    function after() {
        /* The same cached book the dashboard and the client list read, so this
           screen costs no extra request. */
        frBook(function (rows) {
            var $who = $('#ip-who');
            if (!$who.length) { return; }

            if (!rows.length) {
                $who.html('<option value="">You have no clients yet</option>');
                return;
            }

            $who.html(rows.map(function (c) {
                var chosen = (c.personId === STATE.activeCustomerId) ? ' selected' : '';
                return '<option value="' + FMT.esc(c.personId) + '"' + chosen + '>' +
                    FMT.esc(c.name) + '</option>';
            }).join(''));

            personId = String($who.val() || '');
        });

        /* ASK THE BROWSER WHICH LANGUAGES IT ACTUALLY HAS, then rebuild the
           picker with the answer. Asynchronous, so the select is already on screen
           with the full list - which is the right way round: an option that turns
           out to be missing fails loudly on start, whereas an option hidden while
           we waited would look like it was never offered.

           Only the <option> list is replaced, not the field, so somebody who has
           already changed the selection does not have it reset underneath them. */
        refreshAvailableLangs(function () {
            var $sel = $('#ip-lang');
            if (!$sel.length) { return; }

            var chosen = String($sel.val() || lang());

            $sel.html(langsAvailable.map(function (l) {
                return '<option value="' + l.code + '"' +
                    (l.code === chosen ? ' selected' : '') + '>' +
                    FMT.esc(l.label) + '</option>';
            }).join(''));

            /* Their saved choice may be one the browser has just told us it cannot
               do. Falling back silently would transcribe a Cantonese meeting as
               English and look like the feature is simply bad, so it says so. */
            if ($sel.val() !== chosen) {
                UI.toast({
                    tone: 'info',
                    title: 'That language is not installed',
                    message: 'This browser has no model for it, so ' +
                        langLabel(String($sel.val() || '')) + ' is selected instead.',
                    duration: 5000
                });
                setLang(String($sel.val() || 'en-SG'));
            }
        });

        setListening(false);
    }


    /* ======================================================================
       LISTENING
       ====================================================================== */
    function start() {
        var Engine = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!Engine) {
            UI.toast({
                tone: 'warn', title: 'This browser cannot listen',
                message: 'Live transcribe needs Chrome, Edge or Safari.'
            });
            return;
        }

        if (window.location.protocol === 'file:') {
            UI.toast({
                tone: 'warn', title: 'Blocked on a file:// page',
                message: 'Open the site over http://localhost or https.'
            });
            return;
        }

        personId = String($('#ip-who').val() || '');

        if (!personId) {
            UI.toast({
                tone: 'warn', title: 'Say who the meeting is with',
                message: 'Anything PRUWise notices is proposed on their record.'
            });
            return;
        }

        if (listening) { return; }

        recog = new Engine();
        recog.lang = String($('#ip-lang').val() || lang());
        recog.continuous = true;
        recog.interimResults = true;
        recog.maxAlternatives = 1;

        recog.onresult = function (event) {
            var interim = '';

            for (var i = event.resultIndex; i < event.results.length; i++) {
                var chunk = event.results[i][0].transcript;

                if (event.results[i].isFinal) { addLine(chunk); }
                else { interim = interim + chunk; }
            }

            $('#ip-interim').text(interim);
        };

        /* Chrome stops after a pause even with continuous:true. A meeting has long
           pauses in it, so restarting is not an edge case here - it is the normal
           course of an hour. */
        recog.onend = function () {
            if (!listening) { return; }
            try { recog.start(); } catch (e) { /* already restarting */ }
        };

        recog.onerror = function (event) {
            var code = (event && event.error) ? event.error : '';

            if (code === 'no-speech' || code === 'aborted') { return; }

            if (code === 'not-allowed' || code === 'service-not-allowed') {
                /* listening = false FIRST, or onend restarts in a loop and the
                   browser is asked for the microphone again every second. */
                listening = false;
                setListening(false);

                UI.toast({
                    tone: 'bad', title: 'Microphone permission was declined',
                    message: 'Allow the microphone from the address bar, then press Start again.'
                });
                return;
            }

            if (code === 'network') {
                UI.toast({
                    tone: 'warn', title: 'No connection',
                    message: 'The browser sends the audio away to be turned into text, so ' +
                        'this needs the internet.'
                });
            }
        };

        try { recog.start(); }
        catch (e) { /* already going */ }

        listening = true;
        if (!startedAt) { startedAt = Date.now(); }

        setListening(true);
    }

    function stop() {
        listening = false;

        if (recog) {
            try { recog.stop(); } catch (e) { /* already stopped */ }
            recog = null;
        }

        setListening(false);
        $('#ip-interim').text('');
    }

    function setListening(on) {
        $('#ip-dot').toggleClass('is-on', !!on);
        $('#ip-live').toggleClass('is-live', !!on);

        $('#ip-status').text(on
            ? 'Listening in ' + langLabel(String($('#ip-lang').val() || lang()))
            : (lines.length ? 'Paused' : 'Not listening'));

        $('.ip-start').prop('disabled', !!on);
        $('.ip-stop').prop('disabled', !on);

        paintClock();
    }

    function langLabel(code) {
        for (var i = 0; i < LANGS.length; i++) {
            if (LANGS[i].code === code) { return LANGS[i].label; }
        }
        return code;
    }

    function paintClock() {
        if (!startedAt) { $('#ip-clock').text(''); return; }

        var mins = Math.floor((Date.now() - startedAt) / 60000);
        $('#ip-clock').text(mins < 1 ? 'just started' : mins + ' min');
    }

    function addLine(text) {
        var clean = $.trim(text);
        if (!clean) { return; }

        lines.push({ text: clean, at: new Date().toISOString() });

        $('#ip-final').text(clean);
        $('#ip-interim').text('');

        drawLog();
        maybeAnalyse(false);
    }

    function drawLog() {
        var $box = $('#ip-log');
        if (!$box.length) { return; }

        $('#ip-count').text(lines.length
            ? lines.length + (lines.length === 1 ? ' line' : ' lines')
            : 'Nothing yet');

        if (!lines.length) { return; }

        $box.html(lines.map(function (l) {
            return '<div class="ip-line">' +
                '<span class="ip-line-time">' + FMT.time(l.at) + '</span>' +
                '<span class="ip-line-text">' + FMT.esc(l.text) + '</span>' +
                '</div>';
        }).join(''));

        var el = document.getElementById('ip-log');
        if (el) { el.scrollTop = el.scrollHeight; }
    }

    function transcriptText() {
        return lines.map(function (l) { return l.text; }).join('\n');
    }


    /* ======================================================================
       PRUWISE READING IT

       Exactly the endpoint the call screen and the chat use, with source
       'meeting'. One reader for all three, so a rule added for a call applies to
       an in-person meeting on the same deploy.
       ====================================================================== */
    function maybeAnalyse(force) {
        if (!personId) { return; }

        if (!force) {
            if (lines.length <= analysedUpTo) { return; }
            if (Date.now() - analysedAt < ANALYSE_EVERY_MS) { return; }
        }

        var text = transcriptText();
        if (text.length < 40) {
            if (force) {
                UI.toast({
                    tone: 'info', title: 'Not enough said yet',
                    message: 'PRUWise needs a couple of sentences before there is anything ' +
                        'to read.'
                });
            }
            return;
        }

        analysedUpTo = lines.length;
        analysedAt = Date.now();

        if (force) { $('#ip-found').html(UI.loadingState('Reading the meeting\u2026')); }

        API.insights.analyse(personId, 'meeting', text).then(

            function (data) {
                var found = data.found || [];

                if (data.skipped === 'nothing-relevant') {
                    $('#ip-found').html(UI.callout({
                        tone: 'info', icon: 'info',
                        title: 'Nothing to raise yet',
                        text: 'Nothing said so far touches money, cover, health, work, family ' +
                            'or a meeting. That is not a failure - it is the relevance gate ' +
                            'doing its job.'
                    }));
                    return;
                }

                if (!found.length) {
                    $('#ip-found').html('<div class="t-sm muted">Read, and nothing new to ' +
                        'raise. Anything found earlier is already on their profile.</div>');
                    return;
                }

                /* A SUMMARY AND A LINK, not the cards themselves.

                   The proposals live on the client's profile, which is where they
                   can be confirmed against the rest of the record. Rebuilding the
                   decision UI here would be a second place to confirm a change to
                   somebody's money, and two of those is one too many. */
                $('#ip-found').html(
                    UI.callout({
                        tone: 'brand', icon: 'sparkles',
                        title: found.length === 1
                            ? 'PRUWise noticed one thing'
                            : 'PRUWise noticed ' + found.length + ' things',
                        text: 'Proposed on their profile with the words that caused each one. ' +
                            'Nothing has changed on their record.'
                    }) +
                    '<ul class="ip-found-list">' +
                    found.map(function (f) {
                        return '<li>' + UI.icon('arrowRight', 12) +
                            '<span>' + FMT.esc(f.note) + '</span></li>';
                    }).join('') +
                    '</ul>' +
                    UI.btn({
                        label: 'Open their profile', variant: 'outline', size: 'sm',
                        block: true, iconRight: 'arrowRight',
                        act: 'open-customer', data: { id: personId }
                    })
                );
            },

            function (err) {
                if (!force) { return; }   // background read: stay quiet

                $('#ip-found').html(UI.errorState({
                    title: 'Could not read the meeting',
                    text: (err && err.error) ? err.error : 'Please try again.',
                    plain: true
                }));
            }
        );
    }


    /* ======================================================================
       SAVING

       The transcript goes to /api/documents, which is the shelf both sides
       already use - so it is readable afterwards from the client's record rather
       than living in a table only this screen knows about. And a line goes into
       the conversation, for the same reason the call log does: a record nobody
       stumbles across is a record nobody reads.
       ====================================================================== */
    function save() {
        if (!lines.length) {
            UI.toast({
                tone: 'warn', title: 'Nothing to save',
                message: 'No sentences were recognised.'
            });
            return;
        }

        if (!personId) {
            UI.toast({ tone: 'warn', title: 'Say who the meeting was with' });
            return;
        }

        if (saved) {
            UI.toast({ tone: 'info', title: 'Already saved' });
            return;
        }

        var $btn = $('[data-act="ip-save"]');
        $btn.addClass('is-loading').prop('disabled', true);

        stop();

        var day = FMT.sgDayKey(startedAt || new Date());

        var body = 'In-person meeting, ' + FMT.dateLong(startedAt || new Date()) + '\n' +
            'Transcribed by PRUWise from one microphone. Lines are in the order they were ' +
            'said and are NOT attributed to a speaker - one microphone cannot tell two ' +
            'voices apart.\n\n' + transcriptText();

        /* BUILT AS A REAL FILE AND SENT THROUGH THE DOCUMENTS SHELF.

           Not a bespoke endpoint. /api/documents already accepts text/plain, already
           lets a representative file something against a client of theirs (?person=
           is checked, not trusted - see mayReadDocument), already extracts the text
           so it is searchable, and already appears on the client's record where
           somebody will find it.

           A new "save a transcript" route would have been a second way to write a
           document, with its own permission check to get wrong. */
        var file = new File([body], 'Meeting ' + day + '.txt', { type: 'text/plain' });

        API.documents.add(file, null, { personId: personId, kind: 'other' }).then(

            function () {
                saved = true;

                $btn.removeClass('is-loading')
                    .html(UI.icon('check', 15) + '<span>Saved</span>');

                UI.toast({
                    tone: 'ok', title: 'Meeting saved',
                    message: 'Filed against them and readable from their record.'
                });

                /* One last read, forced, so anything said in the final stretch is
                   not lost because the throttle had not expired. */
                maybeAnalyse(true);
            },

            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);

                UI.toast({
                    tone: 'bad', title: 'Could not save the meeting',
                    message: (err && err.error) ? err.error : 'The transcript is still on ' +
                        'screen - copy it before leaving this page.'
                });
            }
        );
    }


    /* ---------------------------------------------------------------- events */
    $(function () {
        $(document).on('click', '[data-act="ip-start"]', function () { start(); });
        $(document).on('click', '[data-act="ip-stop"]', function () { stop(); });
        $(document).on('click', '[data-act="ip-analyse"]', function () { maybeAnalyse(true); });
        $(document).on('click', '[data-act="ip-save"]', function () { save(); });

        $(document).on('change', '#ip-who', function () {
            personId = String($(this).val() || '');
        });

        /* CHANGING LANGUAGE MID-MEETING RESTARTS THE RECOGNISER, because `lang` is
           read when it starts and cannot be changed on a running instance. The
           lines already recorded keep whatever they were recognised as - which is
           correct, and is why the hint says so. */
        $(document).on('change', '#ip-lang', function () {
            var code = String($(this).val() || 'en-SG');
            setLang(code);

            if (!listening) { setListening(false); return; }

            stop();
            start();
        });

        /* The minute counter. One interval for the page rather than one per line. */
        window.setInterval(function () {
            if ($('#ip-clock').length && startedAt) { paintClock(); }
        }, 30000);
    });


    return { render: render, after: after, isListening: function () { return listening; } };
}());


PAGES['/fr/inperson'] = {
    title: 'Live transcribe',
    sub: 'An in-person meeting, written down',

    render: function () { return INPERSON.render(); },
    after: function () { INPERSON.after(); }
};


/* ==========================================================================
   WHERE THIS GOES NEXT: SEA-LION AND MERaLiON

   The browser's recogniser is one language at a time, chosen from a dropdown.
   That is a real limitation in Singapore, where a client meeting moves between
   English, Mandarin, Malay and Tamil - sometimes inside one sentence.

   MERaLiON is built for exactly that: speech recognition trained on Singaporean
   English and local code-switching. SEA-LION is the text model, tuned for South
   East Asian languages, which would replace the general-purpose model behind the
   note wording and the summaries.

   NEITHER IS WIRED IN YET, and this comment is not pretending otherwise. Doing it
   properly means an audio pipeline rather than a text one: capturing chunks with
   MediaRecorder, posting them to an inference endpoint, and reconciling the
   results with what is already on screen. That is a bigger change than swapping a
   language code, and the honest order is to get the transcript useful first -
   which is what this screen does - and change where the text comes from second.
   ========================================================================== */
