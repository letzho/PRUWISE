/* ==========================================================================
   call.js
   --------------------------------------------------------------------------
   A REAL video call between two accounts, with a transcript that says who said
   what.

   Shared by both call screens:
     /fr/call   the representative calling one of their customers
     /me/call   the customer joining their representative

   ==========================================================================
   HOW TWO BROWSERS ACTUALLY CONNECT
   ==========================================================================

   The video and audio go DIRECTLY from one browser to the other. No server here
   ever sees a frame. That is what WebRTC is for, and it is why the picture stays
   sharp on a cheap host.

   But two browsers cannot just start sending each other video. First they have to
   introduce themselves, and that takes three kinds of message:

     an OFFER      "here is what I can send and receive"
     an ANSWER     "and here is what I can"
     CANDIDATES    "here are the network addresses you might reach me on"

   Passing those three between the two sides is called SIGNALLING, and it is the
   only part that needs a server. Normally that server is a WebSocket, which has
   to run as a permanent process - something cheap PHP hosting does not offer.

   So signalling here is a MAILBOX in MySQL. Each side posts its messages to
   php/api/call-sync.php and asks, about once a second, whether anything has
   arrived. Connecting takes a second or two longer than a WebSocket would. In
   exchange, the whole thing runs on any host that can serve PHP.

   WHO OFFERS

   One side has to offer and the other has to answer. If both offer, the two
   connections talk past each other and nothing happens.

   THE REPRESENTATIVE ALWAYS OFFERS. Fixed, not negotiated. It does not depend on
   who arrived first, and either side can reload without the roles swapping
   underneath them. The representative waits until the heartbeat says the customer
   is really there, then offers; the customer waits for an offer and answers it.

   ==========================================================================
   WHO IS SAYING WHAT
   ==========================================================================

   Two different questions, answered two different ways, because they genuinely
   are different problems.

   1. "WHO IS TALKING RIGHT NOW?"  Measured from the audio, not the words. A
      little WebAudio analyser watches the loudness of each stream and reports
      who is above the threshold. That is instant, works before anybody has said
      anything recognisable, and works for "mmhmm".

   2. "WHO SAID THAT SENTENCE?"  Each browser transcribes ITS OWN microphone and
      posts the finished sentences with its own account attached. So the speaker
      is not guessed at - the account that sent a line is the person who said it.
      Both sides poll the same table and end up with one merged log, in order,
      with real names against every line.

   WHY NOT TRANSCRIBE BOTH SIDES IN ONE BROWSER

   Because you cannot reliably tell two voices apart in a single mixed stream.
   That is called diarisation and it is a hard research problem, not a checkbox.
   Transcribing your own microphone and sending the text over is both simpler and
   far more accurate - and it means each person's own words are on screen the
   instant their recogniser settles them, with no network delay at all.

   THE LIMIT, SAID PLAINLY: the browser's speech recogniser only hears the
   microphone. If somebody is not running this app, their side is not transcribed.

   ==========================================================================
   THINGS THAT WILL BITE YOU
   ==========================================================================

   HTTPS IS NOT OPTIONAL. A browser will not hand out a camera, a microphone or
   speech recognition to a page that is not on https:// or localhost.

   STUN IS USUALLY ENOUGH, BUT NOT ALWAYS. On a strict corporate network the two
   browsers cannot reach each other directly and need a TURN relay. See the 'call'
   section of php/config.example.php.
   ========================================================================== */

var CALL = (function () {

    /* ======================================================================
       PRIVATE STATE
       ====================================================================== */

    /* ---- media ---- */
    var localStream = null;    // our own camera and microphone
    var pc = null;             // the RTCPeerConnection to the other person
    var remoteStream = null;   // what is arriving from them
    var pendingOffer = null;   // offer received before our media was ready

    /* ---- the clock ---- */
    var timer = null;
    var seconds = 0;

    /* ---- controls ---- */
    var micOn = true;
    var camOn = true;

    /* ---- the room ----
       Filled in by php/api/call-join.php. Null until we are in a call. */
    var room = null;           // { roomCode, callId, role, isOfferer, peer, iceServers, pollMs }
    var peerHere = false;      // has the other side polled in the last few seconds?
    var phase = 'idle';        // idle | joining | waiting | connecting | live | ended | failed

    /* ---- the sync loop ---- */
    var syncTimer = null;
    var syncing = false;       // a request is already in flight, do not stack them
    var outSignals = [];       // signalling waiting for the next request
    var outLines = [];         // transcript lines waiting for the next request
    var syncFailures = 0;

    /* ---- WebRTC bookkeeping ---- */
    var offerSent = false;
    var remoteReady = false;   // have we applied their offer or answer yet?
    var heldCandidates = [];   // candidates that arrived before we could use them
    var recoverVideoTried = false; // one renegotiation if inbound video never arrives
    var syncFlushWaiting = false;  // queueSignal during an in-flight sync
    var iceRestartTried = false;   // one ICE restart if connection fails

    /* The two senders, kept from when the connection was built. A sender with no
       track cannot be found again by searching, so we hold on to them. */
    var audioSenderRef = null;
    var videoSenderRef = null;

    /* ---- captions and the log ---- */
    var recog = null;
    var listening = false;
    var lines = [];            // the merged transcript
    var sinceLine = 0;         // highest transcript id we hold
    var lastAskAt = 0;         // throttle for the PRUWise nudge
    var logOpen = false;       // is the transcript expanded under the captions?

    /* ---- who is talking ---- */
    var meters = {};           // { me: {...}, peer: {...} } - see watchLoudness
    var levelTimer = null;
    var audioCtx = null;
    var speaking = { me: false, peer: false };
    var lastSpoke = { me: 0, peer: 0 };

    /* Who this call is about, so the live assistant asks the right question
       about the right person. Set by begin(). */
    var context = { view: 'fr', customerId: null };
    var onRemoteEnd = null;    // the page's "they hung up" handler

    /* ---- tuning ---- */
    var TRANSCRIBE_LANG = 'en-US';
    var ASK_EVERY_MS = 7000;   // never bother PRUWise more often than this
    var LEVEL_EVERY_MS = 180;  // how often to check who is talking
    var LOUD_ENOUGH = 0.045;   // RMS above this counts as speech, not room noise
    var SPEAKING_HOLD_MS = 900; // keep the label up briefly through natural pauses
    var DEFAULT_POLL_MS = 1000;


    /* ======================================================================
       THE CONTROL BUTTONS
       Small builders, so both pages get identical controls.
       ====================================================================== */

    function control(o) {
        o = o || {};
        return '<button type="button" class="call-btn' + (o.cls ? ' ' + o.cls : '') +
            '" data-act="' + o.act + '"' +
            (o.id ? ' id="' + o.id + '"' : '') +
            ' aria-label="' + FMT.esc(o.aria || o.act) + '"' +
            (o.title ? ' title="' + FMT.esc(o.title) + '"' : '') + '>' +
            UI.icon(o.icon, 18) + '</button>';
    }

    /* Mute. This one genuinely mutes: it switches the audio track off, so the
       other person stops hearing you. It used to be decorative, because there
       was no audio to switch off. */
    function micButton() {
        return control({ act: 'call-mic', id: 'btn-mic', icon: 'mic', aria: 'Mute microphone' });
    }

    /* Camera on and off. Genuinely releases the camera, so the light on the
       machine goes out - see setCamera() for how that is done without having to
       renegotiate the whole connection. */
    function camButton() {
        return control({ act: 'call-cam', id: 'btn-cam', icon: 'video', aria: 'Turn camera off' });
    }

    // Captions and the transcript. Off until asked for: it needs the microphone.
    function ccButton() {
        return control({
            act: 'call-cc', id: 'btn-cc', icon: 'messageSquare',
            aria: 'Turn live captions on', title: 'Live captions, transcript and PRUWise suggestions'
        });
    }

    function shareButton() {
        return control({ act: 'call-share', icon: 'monitor', aria: 'Share screen' });
    }

    /* Opens the side panel. Only useful on phones and tablets - on a laptop the
       panel is always there, so CSS hides this button. */
    function panelButton() {
        return control({
            act: 'call-panel', id: 'btn-panel', icon: 'sparkles',
            cls: 'panel-toggle', aria: 'Show the assistant panel'
        });
    }

    function endButton(o) {
        o = o || {};
        return '<button type="button" class="call-btn end" data-act="' + (o.act || 'call-end') + '">' +
            UI.icon('phoneOff', 17) + '<span>' + FMT.esc(o.label || 'End call') + '</span></button>';
    }


    /* ======================================================================
       THE VIDEO AREA

       CALL.stage({ peerName, peerSeed, peerNote, selfName, selfSeed, controls })

       The element ids are the same on both pages on purpose, so the shared
       camera, connection and caption code can find them.
       ====================================================================== */
    function stage(o) {
        o = o || {};

        /* THE OTHER PERSON. A real <video>, hidden until their stream arrives,
           with the avatar as a placeholder behind it.

           It is deliberately NOT muted - this is where their voice comes out.
           playsinline stops iOS taking the video fullscreen on its own. */
        var peerTile = '<div class="call-tile" id="peer-tile">' +
            '<video id="peer-cam" class="cam-video is-remote" autoplay playsinline hidden></video>' +
            '<div class="call-tile-inner" id="peer-placeholder">' +
            '<span class="call-pulse">' + UI.avatar(o.peerName, 'xl', { seed: o.peerSeed }) + '</span>' +
            '<div style="color:#fff" class="t-sm semi">' + FMT.esc(o.peerName) + '</div>' +
            '<div class="t-xs" style="color:rgba(255,255,255,.6)" id="peer-state">' +
            FMT.esc(o.peerNote || 'Waiting for them to join') + '</div>' +
            '</div>' +
            '<span class="call-tile-name">' +
            '<span class="speak-dot" id="peer-dot" aria-hidden="true"></span>' +
            '<span class="truncate">' + FMT.esc(o.peerName) + '</span></span>' +
            '</div>';

        /* OUR OWN CAMERA, floating in the corner. Muted, always - an unmuted
           self-view is how you get howling feedback. */
        var selfTile = '<div class="call-tile self" id="self-tile">' +
            '<video id="self-cam" class="cam-video" autoplay muted playsinline hidden></video>' +
            '<div class="call-tile-inner" id="self-placeholder">' +
            UI.avatar(o.selfName || 'You', 'sm', { seed: o.selfSeed }) +
            '</div>' +
            '<span class="call-tile-name">' +
            '<span class="speak-dot" id="self-dot" aria-hidden="true"></span>' +
            '<span class="truncate">' + FMT.esc(o.selfName || 'You') + '</span></span>' +
            '</div>';

        return '<div class="call-stage">' +

            /* The status pill. "LIVE 04:12" once connected, and something honest
               about what it is waiting for before that. */
            '<div class="call-status">' +
            '<span class="live-dot" id="call-dot"></span>' +
            '<span id="call-conn">Starting</span>' +
            '<span id="call-time">00:00</span></div>' +

            '<div class="call-grid">' + peerTile + selfTile + '</div>' +

            captionBlock() +

            // Shown only when something could not start - camera, mic, connection
            '<div id="cam-note" class="cam-note" hidden></div>' +

            '<div class="call-controls">' + (o.controls || '') + '</div>' +
            '</div>';
    }

    /* ----------------------------------------------------------------------
       THE CAPTION BAR AND THE LOG

       Collapsed, it is one line: WHO is talking, and WHAT they are saying.
       Tap it and the whole transcript slides open above it.

       No separate button, and no separate screen. The thing you want to expand
       is the thing you tap - which is also why the caption bar is a real
       <button> with aria-expanded rather than a div with a click handler.

       It sits BELOW the video, not over it. An overlay would cover the only face
       on screen, and on a phone it would collide with your own camera.
       ---------------------------------------------------------------------- */
    function captionBlock() {
        return '<div class="cc-wrap" id="cc-wrap" hidden>' +

            /* THE PLAIN-ENGLISH EXPLANATION USED TO BE A FIXED BAR HERE.

               It is a post-it on the video now - see postIt() below. The bar had
               room for one explanation, replaced the previous one silently, and sat
               under the video where nobody looking at a face was reading. Post-its
               stack, move, and stay until they are dealt with. */

            /* THE HISTORY, revealed by expanding the bar.

               This is the only place the transcript lives now. It used to be
               duplicated in the notes panel, which meant two copies of the same
               list to keep in step and two places to look. Expanding the thing
               you are already reading is the obvious gesture. */
            '<div class="cc-log" id="cc-log" hidden>' +
            '<div class="cc-log-head">' +
            '<span class="eyebrow">Everything said so far</span>' +
            '<span class="t-xs subtle" id="cc-log-count">Nothing yet</span>' +
            '</div>' +
            '<div class="cc-log-list" id="cc-log-list"></div>' +

            /* WHAT MAKES A NOTE APPEAR, one line away from the transcript.

               This is where somebody looks when the post-its are not appearing and
               they are wondering whether the feature works. Next to the words that
               were actually heard is the only place it answers the question. */
            UI.listensFor({ label: 'What makes a PRUWise note appear' }) +

            /* The off switch. Here as well as on the control bar, because this is
               where somebody looks when they have decided they do not want it. */
            '<div class="cc-log-foot">' +
            '<button type="button" class="link t-xs" data-act="call-cc">' +
            'Turn live captions off</button>' +
            '<button type="button" class="link t-xs" data-act="call-copy-log">' +
            'Copy to my notes</button>' +
            '</div>' +
            '</div>' +

            /* The bar itself. aria-live tells a screen reader to read new text
               out; "polite" means it waits for a natural pause. */
            '<button type="button" class="cc-line" id="cc-line" data-act="call-log" ' +
            'aria-expanded="false" aria-controls="cc-log">' +
            '<span class="cc-who" id="cc-who">' +
            '<span class="speak-dot" id="cc-dot" aria-hidden="true"></span>' +
            '<span id="cc-who-name">Listening</span>' +
            '</span>' +
            '<span class="cc-text" aria-live="polite">' +
            '<span id="cc-final"></span> ' +
            '<span id="cc-interim" class="cc-interim"></span></span>' +
            '<span class="cc-chev" id="cc-chev">' + UI.icon('chevronUp', 15) + '</span>' +
            '</button>' +
            '</div>';
    }


    /* ======================================================================
       THE SIDE PANEL
       Laptop: a permanent right rail. Phone: a sheet that starts closed,
       because the video needs the room.
       ====================================================================== */
    function rail(tabsHtml) {
        return '<aside class="call-rail" id="call-rail">' +
            '<button type="button" class="rail-handle" data-act="call-panel" ' +
            'aria-controls="call-rail-body" aria-expanded="false">' +
            '<span class="rail-grip" aria-hidden="true"></span>' +
            '<span class="rail-handle-label">' + UI.icon('sparkles', 14) +
            '<span>Assistant</span></span>' +
            '<span class="rail-chev">' + UI.icon('chevronUp', 16) + '</span>' +
            '</button>' +
            '<div class="call-rail-body" id="call-rail-body">' + tabsHtml + '</div>' +
            '</aside>';
    }

    function openPanel() {
        $('#call-rail').addClass('is-open');
        $('.rail-handle').attr('aria-expanded', 'true');
    }

    function togglePanel() {
        var open = $('#call-rail').toggleClass('is-open').hasClass('is-open');
        $('.rail-handle').attr('aria-expanded', open ? 'true' : 'false');
    }


    /* ======================================================================
       STARTING

       CALL.begin({
         view:       'fr' | 'customer',
         customerId: 'cus-001',     who the assistant should read about
         withPerson: 'cus-001',     who we are calling (ignored for a customer)
         appointmentId: 'apt-1',    optional, recorded against the call
         onRemoteEnd: function () { ... }
       })
       ====================================================================== */
    function begin(o) {
        o = o || {};

        context = { view: o.view || 'fr', customerId: o.customerId || null };
        onRemoteEnd = o.onRemoteEnd || null;

        // Fresh call, fresh everything
        seconds = 0;
        micOn = true;
        camOn = true;
        lines = [];
        sinceLine = 0;
        lastAskAt = 0;
        room = null;
        peerHere = false;
        offerSent = false;
        remoteReady = false;
        heldCandidates = [];
        recoverVideoTried = false;
        syncFlushWaiting = false;
        iceRestartTried = false;
        outSignals = [];
        outLines = [];
        syncFailures = 0;
        logOpen = false;
        speaking = { me: false, peer: false };

        /* Fresh co-pilot too. Without this, a second call in the same page visit
           would start with every trigger already marked as seen and show nothing
           at all - which is a maddening bug to look at, because the first call
           worked perfectly. */
        copilotSeen = {};
        copilotAsking = false;
        copilotReadChat = false;

        /* The post-it layer and the positions people dragged them to. A second call
           in the same page visit must not open with last call's notes floating over
           a different person's face. */
        $('#postit-layer').remove();
        postits = {};
        postitCount = 0;

        /* And a fresh drawer. A second call in the same page visit must not
           inherit the policies pinned during the first one. */
        pinned = [];
        drawerOpen = false;
        $('#pin-drawer').remove();

        setPhase('joining');

        if (timer) { window.clearInterval(timer); }

        timer = window.setInterval(function () {
            /* ==============================================================
               NAVIGATING AWAY NO LONGER HANGS UP

               REQUESTED: "when the financial representative moves out of the call
               to go to other tabs during the call, the financial representative
               still stays inside the call."

               This used to call teardown() the moment the clock element vanished -
               so opening a client's record mid-conversation ended the call, told
               the other person you had gone, and turned the camera light off. The
               one thing a representative most wants to do during a call is look
               something up.

               So the call is DOCKED instead: the peer connection, the microphone,
               the sync loop and the transcript all keep running, and a small bar
               appears with the timer, Return and End. See dockCall().

               The camera light staying on is correct and not a bug - the call is
               still up. End is one tap away in the dock, which is the honest way
               to offer "stop being on camera".
               ============================================================== */
            var onCallScreen = !!document.getElementById('call-time');

            if (!onCallScreen) {
                if (!docked) { dockCall(); }

                /* The dock has its own clock, so time still has to be counted. */
                if (phase === 'live') {
                    seconds = seconds + 1;
                    $('#call-dock-time').text(clock());
                }
                return;
            }

            /* Back on the call screen after being docked - put the video back. */
            if (docked) { undockCall(); }

            // Only count time while the two of them are actually connected
            if (phase === 'live') {
                seconds = seconds + 1;
                $('#call-time').text(clock());
            }
        }, 1000);

        startMedia(o);
    }

    /* Ask for the camera and microphone, then join the room.

       The order matters. We get the media FIRST, because the tracks have to
       exist before the peer connection is built - adding them afterwards means
       renegotiating, for no reason. */
    function startMedia(o) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            note('This browser will not share a camera with the page. Open the site through ' +
                'WAMP at http://localhost/Prudential_TheGoats/ to enable it.');
            join(o);   // join anyway: they can still see and hear the other person
            return;
        }

        /* audio:true, which is new. The call needs the microphone now, not just
           the picture - so this is one permission prompt for both. */
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: { echoCancellation: true, noiseSuppression: true }
        }).then(
            function (stream) {
                localStream = stream;
                showSelf(stream);
                watchLoudness(stream, 'me');
                
                /* If an offer arrived while we were waiting for the camera,
                   answer it now that we have our tracks. */
                if (pendingOffer) {
                    console.log('✅ Camera ready, now answering pending offer');
                    var offer = pendingOffer;
                    pendingOffer = null;
                    answerOffer(offer);
                }
                
                join(o);
            },
            function (err) {
                note(mediaReason(err));

                /* Join without media. A one-way call is much better than no call:
                   you can still see and hear them, and they can hear that you
                   cannot be seen. */
                join(o);
            }
        );
    }

    function showSelf(stream) {
        var video = document.getElementById('self-cam');
        if (!video) { return; }

        video.srcObject = stream;
        video.hidden = false;
        $('#self-placeholder').hide();
        $('#cam-note').prop('hidden', true);
    }

    // getUserMedia failures, in plain language rather than an error code
    function mediaReason(err) {
        var name = (err && err.name) ? err.name : '';

        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return 'Camera and microphone permission was declined, so the other person cannot see ' +
                'or hear you. Click the camera icon in the address bar to allow it, then reload.';
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            return 'No camera or microphone was found on this computer. You can still see and hear ' +
                'the other person.';
        }
        if (name === 'NotReadableError' || name === 'TrackStartError') {
            return 'Your camera is already being used by another app. Close that app and reload.';
        }
        if (window.location.protocol === 'file:') {
            return 'Cameras are blocked on file:// pages. Open the site at ' +
                'http://localhost/Prudential_TheGoats/ through WAMP.';
        }
        if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
            return 'Browsers only allow a camera and microphone on https:// or on localhost. ' +
                'This page is on http://' + window.location.hostname + ', so they are blocked.';
        }
        return 'The camera could not be started' + (name ? ' (' + name + ')' : '') + '.';
    }


    /* ======================================================================
       JOINING THE ROOM
       ====================================================================== */
    function join(o) {
        API.callJoin(o.withPerson || '', o.appointmentId || '').then(function (data) {
            room = {
                roomCode: data.roomCode,
                callId: data.callId,
                role: data.role,
                isOfferer: data.isOfferer,
                peer: data.peer || {},
                iceServers: data.iceServers || [],
                usingCustomTurn: !!data.usingCustomTurn,
                pollMs: data.pollMs || DEFAULT_POLL_MS
            };

            console.log('🧊 ICE servers for call:', {
                count: (room.iceServers || []).length,
                usingCustomTurn: room.usingCustomTurn,
                hosts: (room.iceServers || []).map(function (s) {
                    var urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                    return urls.map(function (u) {
                        return String(u).replace(/^turns?:/, '').split('?')[0];
                    });
                }).flat()
            });

            /* DELIBERATELY left false, even when the join response says they are
               already here.

               handlePresence() only acts on a CHANGE - that is what stops it
               re-offering every single second. So if we recorded "present" now,
               the first poll would see no change and the call would never be
               placed. Starting from false means the first poll is always a
               transition, and the offer goes out immediately. */
            peerHere = false;

            // A reload mid-call gets the conversation back rather than an empty log
            if (data.transcript && data.transcript.length) {
                absorbLines(data.transcript);
            }
            sinceLine = data.transcriptSince || 0;

            setPhase('waiting');
            startSync();   // fires once straight away, so no waiting for a tick

            /* CAPTIONS START THEMSELVES.

               They used to wait for a button, which meant the feature that makes
               a jargon-heavy call understandable was off exactly when somebody
               needed it and did not know to look for it.

               Quietly, though: startTranscribe(true) skips the "your browser
               cannot do this" note. Somebody who never asked for captions should
               not be told off about them - the button is still there if they want
               to try and see the reason. */
            startTranscribe(true);

        }, function (err) {
            setPhase('failed');
            note(err.error);
        });
    }


    /* ======================================================================
       THE SYNC LOOP

       One request, about once a second, for as long as the call lasts. It says
       "I am still here", posts whatever we have queued, and collects whatever is
       waiting for us. See php/api/call-sync.php.
       ====================================================================== */
    function startSync() {
        stopSync();
        syncTimer = window.setInterval(syncNow, room ? room.pollMs : DEFAULT_POLL_MS);
        syncNow();
    }

    function stopSync() {
        if (syncTimer) { window.clearInterval(syncTimer); syncTimer = null; }
    }

    /* Push whatever is queued right now. Called by the interval, and also
       straight after we generate an offer, an answer or a spoken line - so those
       do not sit waiting for the next tick. */
    function syncNow() {
        if (!room || phase === 'ended') { return; }

        /* Nested queueSignal() during an in-flight sync used to call syncNow()
           while syncing===true and silently drop the flush. Remember and run
           again when the current request finishes. */
        if (syncing) {
            syncFlushWaiting = true;
            return;
        }

        syncing = true;
        syncFlushWaiting = false;

        /* splice(0) takes everything out of the queue and empties it in one go.
           If the request fails we put them back - see the failure branch. */
        var signals = outSignals.splice(0);
        var spoken = outLines.splice(0);

        API.callSync(room.roomCode, signals, spoken, sinceLine).then(function (data) {
            syncing = false;
            syncFailures = 0;

            // The other side hung up
            if (data.ended) {
                remoteHungUp();
                return;
            }

            if (data.transcript && data.transcript.length) {
                absorbLines(data.transcript);
                sinceLine = data.transcriptSince || sinceLine;
            }

            /* SIGNALS BEFORE PRESENCE.

               Presence used to run first and could resetConnection()/makeOffer()
               in the same tick as an answer arriving. The answer then applied to
               the wrong PC (or was ignored) - one-way video. Apply mailbox
               traffic first, then decide whether to (re)offer. */
            (data.signals || []).forEach(handleSignal);

            handlePresence(!!data.peerPresent);

            if (syncFlushWaiting) { syncNow(); }

        }, function (err) {
            syncing = false;

            // Put the unsent work back at the front of the queue, in order
            outSignals = signals.concat(outSignals);
            outLines = spoken.concat(outLines);

            if (syncFlushWaiting) { syncNow(); }

            if (err.status === 401) {
                stopSync();
                setPhase('failed');
                note('You have been signed out, so the call stopped.');
                return;
            }

            /* One dropped request is a blip. Several in a row means something is
               actually wrong, and saying so beats a screen that quietly freezes. */
            syncFailures++;

            if (syncFailures === 5) {
                plainNote('The connection to the server keeps failing, so the call may not ' +
                    'stay up. ' + err.error);
            }
        });
    }

    /* The other side appeared or disappeared.

       This is what triggers the call. There is no point offering into an empty
       room, so the representative waits here until it can see the customer. */
    /* Is the peer-to-peer connection actually up, whatever the heartbeat says?

       THIS DISTINCTION IS THE WHOLE FIX FOR A REPORTED BUG - "on the customer side
       I cannot see the representative's video".

       Presence and the connection are two completely different things and the code
       below used to treat them as one:

         PRESENCE is a POLLING HEARTBEAT through the server. Each side re-stamps
         seen_at about once a second and the other treats "seen within six seconds"
         as on the line.

         THE CONNECTION is peer-to-peer. Once ICE has done its work the video does
         not touch the server at all.

       So a six-second gap in the heartbeat means almost nothing about the video.
       And there are ordinary reasons for one: js/app.js pauses polling while the
       tab is hidden, so LOOKING AT ANOTHER TAB FOR SEVEN SECONDS was enough. A
       phone that dims. A serverless cold start. A train tunnel.

       What happened then was brutal. The other side saw presence drop, called
       hidePeerVideo() - and the video never came back, because it is only ever
       shown from ontrack and the tracks had already arrived. On the offering side
       it was worse: presence returning ran resetConnection() and makeOffer(),
       destroying a working connection and starting the whole ICE negotiation
       again. If anything went wrong in that second attempt, one side was left
       looking at an avatar. */
    function connectionAlive() {
        if (!pc) { return false; }

        return pc.connectionState === 'connected'
            || pc.connectionState === 'connecting'
            || pc.connectionState === 'new';
    }

    function handlePresence(present) {
        var was = peerHere;
        peerHere = present;

        if (present && !was) {

            /* Anything pinned before they showed up goes out again. Somebody who
               joined late, or came back after a drop, has missed the earlier
               message - and one re-broadcast of the whole list is cheaper and more
               reliable than any scheme for working out what they missed. */
            if (pinned.length) { broadcastPins(); }

            /* ALREADY CONNECTING OR CONNECTED? THEN DO NOT TOUCH THE PC.

               Their heartbeat came back and media may still be negotiating.
               Re-offering here is what used to break the call - see
               connectionAlive().

               IMPORTANT: do not require remoteStream. ontrack often lands AFTER
               ICE reports connecting/connected. The old check was:

                 connectionAlive() && remoteStream

               so a presence blip during that gap ran resetConnection() +
               makeOffer() on the agent (offerer), tearing down a half-built
               connection. The customer kept the old PC and could still see the
               agent, while the agent never got a working inbound video track -
               exactly "client sees agent, agent cannot see client". */
            if (connectionAlive()) {
                if (remoteStream && remoteStream.getVideoTracks().length) {
                    showPeerVideo(remoteStream);
                }
                setPhase(pc.connectionState === 'connected' ? 'live' : 'connecting');
                return;
            }

            /* Genuinely not connected. If we are the offering side, place the
               call. A previous offer means this is a retry, so start from a clean
               connection - their old candidates describe routes to a connection
               that no longer exists. */
            if (room.isOfferer) {
                if (offerSent) { resetConnection(); }
                makeOffer();
            } else {
                setPhase('connecting');
            }
            return;
        }

        if (!present && was) {
            /* THE VIDEO IS LEFT ALONE while the connection is up. Saying "they
               dropped out" over a picture of somebody who is plainly still there
               would be the app arguing with the screen. */
            if (connectionAlive()) {
                showPeerState('Their connection to the server is quiet, but the video ' +
                    'is still up.');
                return;
            }

            // Actually gone as far as we can tell.
            setPhase('waiting');
            showPeerState('They dropped out. Waiting for them to come back\u2026');
            hidePeerVideo();
        }
    }


    /* ======================================================================
       THE PEER CONNECTION
       ====================================================================== */

    /* Attach local mic/camera. Always returns a Promise so createAnswer waits.

       ANSWERER: after setRemoteDescription(offer), set each offer transceiver to
       sendrecv and replaceTrack. Never addTrack/addTransceiver here - those can
       create EXTRA m-lines while the real offer line stays recvonly, which shows
       up on the agent as currentDirection:"sendonly" (exactly the reported bug).

       OFFERER: addTrack / addTransceiver(sendrecv) before createOffer. */
    function liveTrack(kind) {
        if (!localStream) { return null; }
        var list = kind === 'video'
            ? localStream.getVideoTracks()
            : localStream.getAudioTracks();
        var track = list.filter(function (t) { return t.readyState === 'live'; })[0] || null;
        if (track) { track.enabled = true; }
        return track;
    }

    function forceSendrecv() {
        if (!pc) { return; }
        pc.getTransceivers().forEach(function (t) {
            if (t.stopped) { return; }
            try { t.direction = 'sendrecv'; } catch (e) { /* ignore */ }
        });
    }

    function attachLocalTracks(role) {
        if (!pc) { return Promise.resolve(); }

        var audioTrack = liveTrack('audio');
        var videoTrack = liveTrack('video');

        console.log('🎙️ attachLocalTracks[' + role + ']', {
            audio: audioTrack ? audioTrack.readyState : null,
            video: videoTrack ? videoTrack.readyState : null,
            transceiversBefore: pc.getTransceivers().length
        });

        if (role === 'answerer') {
            var jobs = [];

            pc.getTransceivers().forEach(function (t) {
                if (t.stopped) { return; }

                var kind = t.receiver && t.receiver.track && t.receiver.track.kind;
                if (kind !== 'audio' && kind !== 'video') { return; }

                try { t.direction = 'sendrecv'; } catch (e) { /* ignore */ }

                var track = kind === 'audio' ? audioTrack : videoTrack;
                if (!track) { return; }

                if (kind === 'audio') { audioSenderRef = t.sender; }
                if (kind === 'video') { videoSenderRef = t.sender; }

                if (t.sender.track !== track) {
                    jobs.push(Promise.resolve(t.sender.replaceTrack(track)));
                }

                /* Helps some browsers associate the outbound track with a stream
                   so the remote ontrack gets event.streams populated. */
                if (typeof t.sender.setStreams === 'function' && localStream) {
                    try { t.sender.setStreams(localStream); } catch (e) { /* ignore */ }
                }
            });

            return Promise.all(jobs).then(function () {
                console.log('🎙️ answerer senders ready', pc.getTransceivers().map(function (t) {
                    return {
                        mid: t.mid,
                        direction: t.direction,
                        sending: t.sender && t.sender.track
                            ? t.sender.track.kind + ':' + t.sender.track.readyState
                            : null
                    };
                }));
            });
        }

        /* ---- offerer ---- */
        forceSendrecv();

        if (localStream) {
            localStream.getTracks().forEach(function (track) {
                if (track.readyState !== 'live') { return; }

                var already = pc.getSenders().some(function (s) {
                    return s.track === track;
                });
                if (already) { return; }

                var kindSender = pc.getSenders().find(function (s) {
                    return s.track && s.track.kind === track.kind;
                });
                if (kindSender) {
                    kindSender.replaceTrack(track);
                    if (track.kind === 'audio') { audioSenderRef = kindSender; }
                    if (track.kind === 'video') { videoSenderRef = kindSender; }
                    return;
                }

                var sender = pc.addTrack(track, localStream);
                if (track.kind === 'audio') { audioSenderRef = sender; }
                if (track.kind === 'video') { videoSenderRef = sender; }
            });
        }

        var haveAudio = pc.getTransceivers().some(function (t) {
            return (t.receiver.track && t.receiver.track.kind === 'audio')
                || (t.sender.track && t.sender.track.kind === 'audio');
        });
        var haveVideo = pc.getTransceivers().some(function (t) {
            return (t.receiver.track && t.receiver.track.kind === 'video')
                || (t.sender.track && t.sender.track.kind === 'video');
        });

        if (!haveAudio) {
            audioSenderRef = pc.addTransceiver(audioTrack || 'audio', {
                direction: 'sendrecv',
                streams: localStream && audioTrack ? [localStream] : []
            }).sender;
        }
        if (!haveVideo) {
            videoSenderRef = pc.addTransceiver(videoTrack || 'video', {
                direction: 'sendrecv',
                streams: localStream && videoTrack ? [localStream] : []
            }).sender;
        }

        forceSendrecv();
        return Promise.resolve();
    }

    function sdpMediaDirection(sdp, kind) {
        if (!sdp) { return null; }
        var block = sdp.split(/^m=/m).filter(function (part) {
            return part.indexOf(kind) === 0;
        })[0];
        if (!block) { return null; }
        if (/^a=sendrecv$/m.test(block)) { return 'sendrecv'; }
        if (/^a=sendonly$/m.test(block)) { return 'sendonly'; }
        if (/^a=recvonly$/m.test(block)) { return 'recvonly'; }
        if (/^a=inactive$/m.test(block)) { return 'inactive'; }
        return null;
    }

    /* If the peer answered without sending video, renegotiate once.
       IMPORTANT: a muted inbound receiver track is NORMAL when the remote
       answered recvonly - do NOT treat that as "waiting for frames" and skip
       renegotiation (that was why recovery never fired). */
    function recoverMissingRemoteVideo() {
        if (recoverVideoTried || !pc || !room || !room.isOfferer) { return; }
        if (pc.connectionState !== 'connected') { return; }

        var videoT = null;
        pc.getTransceivers().forEach(function (t) {
            if (t.receiver && t.receiver.track && t.receiver.track.kind === 'video') {
                videoT = t;
            }
        });

        var dir = videoT ? videoT.currentDirection : null;
        var track = videoT && videoT.receiver.track;
        var inboundLive = track && track.readyState === 'live' && !track.muted;
        var remoteSending = (dir === 'sendrecv' || dir === 'recvonly');

        if (inboundLive) {
            showPeerVideo(remoteStream || new MediaStream([track]));
            showPeerState('');
            return;
        }

        /* Only wait for first frames when the remote is negotiated to SEND. */
        if (remoteSending && track && track.readyState === 'live' && track.muted) {
            showPeerVideo(remoteStream || new MediaStream([track]));
            showPeerState('Connected. Waiting for their video\u2026');
            window.setTimeout(function () {
                if (!recoverVideoTried) { recoverMissingRemoteVideo(); }
            }, 2500);
            return;
        }

        /* sendonly / inactive / null → client is not sending. Renegotiate
           media only - do NOT iceRestart here. iceRestart tears down the
           working ICE/TURN path and often ends in connectionState=failed
           even when TURN credentials are correct.

           CRITICAL: force direction back to sendrecv before createOffer.
           After a recvonly answer, currentDirection is sendonly and a plain
           createOffer() would offer sendonly again - client can never start
           sending video then. */
        recoverVideoTried = true;
        console.warn('⚠️ No inbound client video - renegotiating (no ICE restart)', {
            direction: videoT && videoT.direction,
            currentDirection: dir
        });

        showPeerState('Connected. Reconnecting their camera\u2026');

        forceSendrecv();

        pc.createOffer().then(function (offer) {
            console.log('📤 Renegotiation offer video direction:',
                sdpMediaDirection(offer.sdp, 'video'));
            return pc.setLocalDescription(offer);
        }).then(function () {
            offerSent = true;
            queueSignal('offer', JSON.stringify(pc.localDescription));
        }, function (err) {
            console.error('Renegotiation failed', err);
            recoverVideoTried = false;
        });
    }

    function ensureConnection() {
        if (pc) { return pc; }

        console.log('🔗 Creating peer connection...', 'localStream exists:', !!localStream);
        if (localStream) {
            console.log('   Audio tracks:', localStream.getAudioTracks().length);
            console.log('   Video tracks:', localStream.getVideoTracks().length);
        }

        pc = new RTCPeerConnection({
            iceServers: room.iceServers,
            iceCandidatePoolSize: 4
        });

        pc.ontrack = function (event) {
            console.log('🎥 ONTRACK FIRED:', event.track.kind, 'muted:', event.track.muted, 'enabled:', event.track.enabled);

            if (!remoteStream) { remoteStream = new MediaStream(); }
            if (remoteStream.getTracks().indexOf(event.track) === -1) {
                remoteStream.addTrack(event.track);
            }

            if (event.track.kind === 'video') {
                console.log('📹 Video track received, showing peer video');
                showPeerVideo(remoteStream);
                showPeerState('');

                event.track.addEventListener('unmute', function () {
                    console.log('📹 Video track unmuted');
                    showPeerVideo(remoteStream);
                    showPeerState('');
                });

                event.track.addEventListener('ended', function () {
                    console.log('📹 Video track ended');
                    hidePeerVideo();
                    showPeerState('Their camera is off.');
                });
            }

            if (event.track.kind === 'audio') {
                console.log('🔊 Audio track received');
            }

            watchLoudness(remoteStream, 'peer');
        };

        pc.onicecandidate = function (event) {
            if (!event.candidate) { return; }
            queueSignal('candidate', JSON.stringify(event.candidate));
        };

        pc.onconnectionstatechange = function () {
            if (!pc) { return; }
            
            console.log('🔌 Connection state changed:', pc.connectionState);

            if (pc.connectionState === 'connected') {
                console.log('✅ WebRTC Connected! Checking for tracks...');
                console.log('   Transceivers:', pc.getTransceivers().map(function (t) { 
                    return {
                        mid: t.mid, 
                        direction: t.direction, 
                        currentDirection: t.currentDirection,
                        sending: !!(t.sender && t.sender.track),
                        receiving: !!(t.receiver && t.receiver.track && !t.receiver.track.muted)
                    };
                }));
                
                setPhase('live');
                $('#cam-note').prop('hidden', true);

                /* Answerer: ensure tracks are on the senders (replaceTrack is
                   enough mid-call IF the answer was already sendrecv). */
                if (room && !room.isOfferer) {
                    attachLocalTracks('answerer');
                }

                window.setTimeout(function () {
                    if (!pc || pc.connectionState !== 'connected') { return; }
                    recoverMissingRemoteVideo();
                }, 2000);

                window.setTimeout(function () {
                    if (!pc || pc.connectionState !== 'connected') { return; }

                    var videoTracks = pc.getReceivers()
                        .map(function (r) { return r.track; })
                        .filter(function (t) { return t && t.kind === 'video'; });

                    var hasLive = videoTracks.some(function (t) {
                        return t.readyState === 'live' && !t.muted;
                    });
                    var waiting = videoTracks.some(function (t) {
                        return t.readyState === 'live' && t.muted;
                    });

                    if (hasLive) {
                        if (remoteStream) { showPeerVideo(remoteStream); }
                        showPeerState('');
                        return;
                    }

                    if (waiting) {
                        if (remoteStream) { showPeerVideo(remoteStream); }
                        showPeerState('Connected. Waiting for their video\u2026');
                        recoverMissingRemoteVideo();
                        return;
                    }

                    showPeerState('Connected. Their camera is off, so you will hear ' +
                        'them but not see them.');
                    recoverMissingRemoteVideo();
                }, 4000);
                return;
            }

            if (pc.connectionState === 'failed') {
                /* One ICE restart with TURN before giving up - a brief NAT blip
                   or a bad first candidate set should not end the call. */
                if (room && room.isOfferer && !iceRestartTried) {
                    iceRestartTried = true;
                    console.warn('⚠️ Connection failed - trying ICE restart via TURN');
                    setPhase('connecting');
                    showPeerState('Connection failed. Retrying via relay\u2026');
                    pc.createOffer({ iceRestart: true }).then(function (offer) {
                        return pc.setLocalDescription(offer);
                    }).then(function () {
                        offerSent = true;
                        remoteReady = false;
                        heldCandidates = [];
                        queueSignal('offer', JSON.stringify(pc.localDescription));
                    }, function (err) {
                        console.error('ICE restart failed', err);
                        setPhase('failed');
                        plainNote(turnFailMessage());
                    });
                    return;
                }

                setPhase('failed');
                plainNote(turnFailMessage());
                return;
            }

            if (pc.connectionState === 'disconnected' && phase === 'live') {
                setPhase('connecting');
                showPeerState('Reconnecting\u2026');
            }
        };

        pc.oniceconnectionstatechange = function () {
            if (!pc) { return; }
            console.log('🧊 ICE connection state:', pc.iceConnectionState,
                'gathering:', pc.iceGatheringState);
        };

        return pc;
    }

    function turnFailMessage() {
        if (room && room.usingCustomTurn) {
            return 'The video call could not connect through the TURN relay. ' +
                'Confirm TURN_URLS includes turn: and turns: on ports 80/443, ' +
                'TURN_USERNAME / TURN_CREDENTIAL match Metered, both browsers allow ' +
                'camera/mic, and try two different networks/browsers.';
        }
        return 'The video could not connect. No custom TURN relay is configured on the server, ' +
            'so only the public fallback was used. Add TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL ' +
            'in the Vercel dashboard (Settings → Environment Variables), redeploy, then try again. ' +
            'A .env file on your laptop is not sent to production.';
    }

    /* Throw the connection away and start clean.

       Used when the other side reappears after dropping out. Their old
       candidates describe routes to a connection that no longer exists, so
       reusing it just fails slowly. */
    function resetConnection() {
        closeConnection();
        offerSent = false;
        remoteReady = false;
        heldCandidates = [];
        recoverVideoTried = false;
        iceRestartTried = false;
    }

    function closeConnection() {
        if (!pc) { return; }

        /* Clear the handlers first. A closing connection fires a last round of
           state changes, and we do not want them repainting the screen. */
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;

        try { pc.close(); } catch (e) { /* already closed */ }

        pc = null;
        audioSenderRef = null;
        videoSenderRef = null;
        remoteStream = null;

        dropMeter('peer');
        hidePeerVideo();
    }

    // --- the representative's side: offer ---
    function makeOffer() {
        var conn = ensureConnection();

        console.log('📤 KRISTIN: Creating offer...');
        setPhase('connecting');
        showPeerState('Connecting\u2026');

        attachLocalTracks('offerer').then(function () {
            forceSendrecv();
            return conn.createOffer();
        }).then(function (offer) {
            var videoDir = sdpMediaDirection(offer.sdp, 'video');
            console.log('📤 KRISTIN: Offer video direction:', videoDir);
            if (videoDir === 'sendonly' || videoDir === 'inactive') {
                console.warn('📤 KRISTIN: Offer video was', videoDir, '- forcing sendrecv and recreating');
                forceSendrecv();
                return conn.createOffer();
            }
            return offer;
        }).then(function (offer) {
            console.log('📤 KRISTIN: Offer created, setting local description');
            return conn.setLocalDescription(offer);
        }).then(function () {
            console.log('📤 KRISTIN: Offer sent to signaling');
            offerSent = true;
            queueSignal('offer', JSON.stringify(conn.localDescription));
        }, function (err) {
            console.error('❌ KRISTIN: Offer failed:', err);
            setPhase('failed');
            plainNote('Could not start the call (' + (err && err.name ? err.name : 'unknown') + ').');
        });
    }

    // --- the customer's side: answer ---
    function answerOffer(sdp) {
        console.log('📥 SARAH: Received offer, creating answer...');
        console.log('📥 SARAH: localStream ready?', !!localStream,
            'video tracks:', localStream ? localStream.getVideoTracks().length : 0);

        if (!localStream) {
            console.log('⏳ SARAH: Waiting for camera/mic before answering...');
            pendingOffer = sdp;
            return;
        }

        function onAnswerFail(err) {
            console.error('❌ SARAH: Answer failed:', err);
            setPhase('failed');
            plainNote('Could not answer the call (' + (err && err.name ? err.name : 'unknown') + ').');
        }

        function buildAnswer(conn) {
            return attachLocalTracks('answerer').then(function () {
                forceSendrecv();
                return conn.createAnswer();
            }).then(function (answer) {
                var videoDir = sdpMediaDirection(answer.sdp, 'video');
                console.log('📥 SARAH: Answer video direction:', videoDir);

                if (videoDir === 'recvonly' || videoDir === 'inactive' || videoDir === null) {
                    console.warn('📥 SARAH: Answer video is', videoDir,
                        '- forcing sendrecv + replaceTrack and recreating answer');
                    forceSendrecv();
                    var vTrack = liveTrack('video');
                    var jobs = [];
                    conn.getTransceivers().forEach(function (t) {
                        if (t.stopped) { return; }
                        if (!(t.receiver && t.receiver.track && t.receiver.track.kind === 'video')) {
                            return;
                        }
                        if (vTrack) {
                            jobs.push(Promise.resolve(t.sender.replaceTrack(vTrack)));
                            videoSenderRef = t.sender;
                        }
                    });
                    return Promise.all(jobs).then(function () {
                        return conn.createAnswer();
                    });
                }

                return answer;
            });
        }

        function doAnswer(conn) {
            setPhase('connecting');
            showPeerState('Connecting\u2026');

            return conn.setRemoteDescription(new RTCSessionDescription(sdp)).then(function () {
                console.log('📥 SARAH: Remote description set; offer video dir:',
                    sdpMediaDirection(typeof sdp === 'string' ? sdp : (sdp && sdp.sdp), 'video'));
                remoteReady = true;
                flushHeldCandidates();
                return buildAnswer(conn);
            }).then(function (answer) {
                console.log('📥 SARAH: Final answer', {
                    videoDir: sdpMediaDirection(answer.sdp, 'video'),
                    directions: conn.getTransceivers().map(function (t) {
                        return {
                            mid: t.mid,
                            direction: t.direction,
                            sending: t.sender && t.sender.track
                                ? t.sender.track.kind + ':' + t.sender.track.readyState
                                : null
                        };
                    })
                });
                return conn.setLocalDescription(answer);
            }).then(function () {
                console.log('📥 SARAH: Answer sent to signaling');
                queueSignal('answer', JSON.stringify(conn.localDescription));
            });
        }

        /* Live renegotiation: answer in place. Destroying the PC while the
           agent keeps theirs breaks ICE and recreates one-way video. */
        if (pc && (pc.signalingState === 'have-remote-offer'
            || pc.connectionState === 'connected'
            || pc.connectionState === 'connecting')) {
            console.log('📥 SARAH: Answering in place (renegotiation)');
            doAnswer(pc).then(null, function (err) {
                console.warn('📥 SARAH: In-place answer failed, full reset', err);
                resetConnection();
                doAnswer(ensureConnection()).then(null, onAnswerFail);
            });
            return;
        }

        if (remoteReady || pc) {
            console.log('📥 SARAH: Resetting connection for fresh start');
            resetConnection();
        }

        doAnswer(ensureConnection()).then(null, onAnswerFail);
    }

    function handleSignal(signal) {
        var payload = null;

        /* The payload is whatever the other browser's WebRTC stack produced. If
           it will not parse, something is badly wrong and there is nothing
           sensible to do with it. */
        try {
            payload = JSON.parse(signal.payload);
        } catch (e) {
            console.error('Unreadable call signal', signal);
            return;
        }

        if (signal.kind === 'offer') {
            // Only the answering side acts on an offer - see "WHO OFFERS" above
            if (!room.isOfferer) { answerOffer(payload); }
            return;
        }

        if (signal.kind === 'answer') {
            console.log('📥 KRISTIN: Received answer from Sarah');
            if (!pc) { 
                console.warn('⚠️ KRISTIN: No peer connection when answer arrived!');
                return; 
            }

            pc.setRemoteDescription(new RTCSessionDescription(payload)).then(function () {
                console.log('✅ KRISTIN: Answer applied, remote description set');
                remoteReady = true;
                flushHeldCandidates();
            }, function (err) {
                console.error('❌ KRISTIN: Could not apply the answer', err);
            });
            return;
        }

        if (signal.kind === 'candidate') {
            /* Candidates can arrive BEFORE the offer or answer they belong to -
               the mailbox does not guarantee an order across kinds. Adding one
               early throws, so hold it until there is a remote description to
               attach it to. */
            if (!pc || !remoteReady) {
                heldCandidates.push(payload);
                return;
            }
            addCandidate(payload);
            return;
        }

        /* The policy snapshot drawer.

           The payload is the WHOLE pinned list, not a change - see the note in
           call_send_signal(). So this simply replaces what is on screen, which
           means a missed message cannot leave the two sides disagreeing forever. */
        if (signal.kind === 'pin') {
            pinned = (payload && payload.length) ? payload : [];
            renderPinned();
            return;
        }

        if (signal.kind === 'bye') {
            remoteHungUp();
        }
    }

    function addCandidate(candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).then(null, function (err) {
            /* A rejected candidate is normal and not worth alarming anybody
               about: some of them describe routes that are already stale by the
               time they arrive. The connection uses whichever ones work. */
            console.warn('Candidate ignored', err);
        });
    }

    function flushHeldCandidates() {
        var held = heldCandidates;
        heldCandidates = [];
        held.forEach(addCandidate);
    }

    function queueSignal(kind, payload) {
        outSignals.push({ kind: kind, payload: payload });

        // Do not make an offer wait for the next tick
        syncNow();
    }


    /* ======================================================================
       WHAT THE SCREEN SAYS ABOUT THE CONNECTION
       ====================================================================== */

    function setPhase(next) {
        phase = next;

        var labels = {
            idle: 'Starting',
            joining: 'Starting',
            waiting: 'Waiting',
            connecting: 'Connecting',
            live: 'LIVE',
            ended: 'Ended',
            failed: 'No connection'
        };

        $('#call-conn').text(labels[next] || next);

        /* The blinking red dot only belongs on a call that is actually running.
           Blinking at somebody while nothing is connected is a lie. */
        $('#call-dot').toggleClass('is-idle', next !== 'live');
        $('#call-status').toggleClass('is-live', next === 'live');

        if (next === 'waiting') {
            /* Say that the other side has been TOLD, not just that we are waiting.

               "Waiting for Sarah to join" leaves the caller wondering whether
               anything is happening at all - and the honest answer is that
               something is: a banner is on her screen, wherever she is in the app.
               Saying so is the difference between waiting and wondering. */
            var who = (room && room.peer && room.peer.name)
                ? room.peer.name.split(' ')[0] : 'them';

            showPeerState('Ringing ' + who + '\u2026 they have been notified');
        }
    }

    function showPeerState(text) {
        $('#peer-state').text(text);
    }

    function showPeerVideo(stream) {
        var video = document.getElementById('peer-cam');
        if (!video) { return; }

        video.srcObject = stream;
        video.hidden = false;
        $('#peer-placeholder').hide();

        tryPlayPeer(video);
    }

    /* Start the remote video playing, and deal with the browser refusing.

       AUTOPLAY WITH SOUND IS BLOCKED until the page has had a real user gesture.
       Reaching a call screen normally involves clicking something, so this
       usually just works - but "usually" is not good enough, because when it
       fails the symptom is a call with picture and NO SOUND, which everybody
       reads as a broken app rather than a browser policy.

       This used to print "click anywhere to let it through" and then nothing
       retried, so clicking anywhere did exactly nothing. Now there is a real
       button, AND a one-time document click that retries - because the first
       thing anybody does when told to click is click. */
    function tryPlayPeer(video) {
        var playing = video.play();

        if (!playing || !playing.then) { return; }

        playing.then(

            function () { $('#audio-unblock').remove(); },

            function () {
                if ($('#audio-unblock').length) { return; }

                $('.call-stage').append(
                    '<button type="button" id="audio-unblock" class="audio-unblock" ' +
                    'data-act="call-unmute-remote">' +
                    UI.icon('volume', 18) +
                    '<span>Tap to hear them</span>' +
                    '</button>'
                );

                /* Any click on the page counts as the gesture the browser wanted,
                   so retry on the next one wherever it lands. .one() so this does
                   not accumulate handlers over a long call. */
                $(document).one('click', function () {
                    var v = document.getElementById('peer-cam');
                    if (!v) { return; }

                    v.play().then(function () { $('#audio-unblock').remove(); }, function () {});
                });
            }
        );
    }

    function hidePeerVideo() {
        $('#peer-cam').prop('hidden', true);
        $('#peer-placeholder').show();
    }


    /* ======================================================================
       WHO IS TALKING RIGHT NOW

       Measured from the SOUND, not from the words, so it is instant and it works
       for "mmhmm" as well as for full sentences.

       An AnalyserNode is a tap on an audio stream that hands back the raw
       waveform. We take the RMS - the root mean square, which is the standard way
       to turn a waveform into one loudness number - and compare it to a threshold
       that sits above normal room noise.

       Note what is NOT connected: the analyser never reaches the speakers. It
       only observes. Connecting it through would double the audio, and for the
       local microphone it would mean hearing yourself.
       ====================================================================== */
    function watchLoudness(stream, which) {
        var Ctx = window.AudioContext || window.webkitAudioContext;

        if (!Ctx || !stream.getAudioTracks().length) { return; }

        try {
            if (!audioCtx) { audioCtx = new Ctx(); }

            /* An AudioContext starts suspended until the page has had a real user
               gesture. Reaching a call involves clicking, so this resumes fine. */
            if (audioCtx.state === 'suspended' && audioCtx.resume) { audioCtx.resume(); }

            dropMeter(which);

            var source = audioCtx.createMediaStreamSource(stream);
            var analyser = audioCtx.createAnalyser();

            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.4;
            source.connect(analyser);

            meters[which] = {
                source: source,
                analyser: analyser,
                data: new Uint8Array(analyser.fftSize)
            };

            if (!levelTimer) {
                levelTimer = window.setInterval(readLevels, LEVEL_EVERY_MS);
            }
        } catch (e) {
            // No loudness detection. The transcript still names every speaker.
            console.warn('Speaking detection unavailable', e);
        }
    }

    function dropMeter(which) {
        if (!meters[which]) { return; }

        try { meters[which].source.disconnect(); } catch (e) { /* already gone */ }
        delete meters[which];
    }

    function readLevels() {
        // Page gone; the clock interval notices and calls teardown()
        if (!document.getElementById('call-time')) { return; }

        ['me', 'peer'].forEach(function (which) {
            var meter = meters[which];
            if (!meter) { return; }

            meter.analyser.getByteTimeDomainData(meter.data);

            /* Samples arrive as 0-255 with 128 as silence. Subtract the middle,
               square, average, square root: that is RMS. */
            var total = 0;

            for (var i = 0; i < meter.data.length; i++) {
                var offset = (meter.data[i] - 128) / 128;
                total += offset * offset;
            }

            var rms = Math.sqrt(total / meter.data.length);
            var loud = rms > LOUD_ENOUGH;

            // Muting yourself should stop you registering as the speaker
            if (which === 'me' && !micOn) { loud = false; }

            if (loud) { lastSpoke[which] = Date.now(); }

            /* Hold the label up briefly after they stop. Without it, the marker
               flickers on and off between every word. */
            speaking[which] = loud || (Date.now() - lastSpoke[which] < SPEAKING_HOLD_MS);
        });

        paintSpeaking();
    }

    function paintSpeaking() {
        $('#self-tile').toggleClass('is-speaking', !!speaking.me);
        $('#self-dot').toggleClass('is-on', !!speaking.me);

        $('#peer-tile').toggleClass('is-speaking', !!speaking.peer);
        $('#peer-dot').toggleClass('is-on', !!speaking.peer);

        // The name on the caption bar follows whoever is making noise
        if (!listening) { return; }

        var name;

        if (speaking.me && speaking.peer) {
            name = 'Both talking';
        } else if (speaking.me) {
            name = 'You';
        } else if (speaking.peer) {
            name = peerFirstName();
        } else {
            name = 'Listening';
        }

        $('#cc-who-name').text(name);
        $('#cc-dot').toggleClass('is-on', !!(speaking.me || speaking.peer));
        $('#cc-who').toggleClass('is-peer', !speaking.me && !!speaking.peer);
    }

    function peerFirstName() {
        if (!room || !room.peer || !room.peer.name) { return 'Them'; }
        return room.peer.name.split(' ')[0];
    }


    /* ======================================================================
       LIVE CAPTIONS

       The browser's own speech recogniser, listening to THIS microphone only.
       Each settled sentence is shown here and posted to the server, where the
       other side picks it up on its next poll.

       WHERE THE AUDIO GOES: in Chrome, to Google's servers to be turned into
       text. That is how the Web Speech API works, and it is worth telling anyone
       you demo this to. Firefox does not support it at all.
       ====================================================================== */

    function speechSupported() {
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    /* quiet=true means "we started this on your behalf". In that mode a browser
       that cannot do speech recognition simply gets no captions, rather than an
       error about a feature nobody asked for. Pressing the button passes
       quiet=false, and then the reason is worth showing. */
    function startTranscribe(quiet) {
        var Engine = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!Engine) {
            if (!quiet) {
                plainNote('Live captions need Chrome, Edge or Safari. Firefox does not support ' +
                    'speech recognition yet - the call itself works fine without them.');
            }
            return;
        }
        if (window.location.protocol === 'file:') {
            if (!quiet) {
                plainNote('Live captions are blocked on file:// pages. Open the site at ' +
                    'http://localhost/Prudential_TheGoats/ through WAMP.');
            }
            return;
        }

        recog = new Engine();
        recog.lang = TRANSCRIBE_LANG;
        recog.continuous = true;       // keep going rather than stopping after one phrase
        recog.interimResults = true;   // give us words as they are recognised
        recog.maxAlternatives = 1;

        /* Results arrive in batches. isFinal means settled; the rest is the
           recogniser's current guess, shown in grey because it may still change.

           Only FINAL text is stored and sent. Streaming every guess would mean
           sending the other person half-words that then change under them. */
        recog.onresult = function (event) {
            var interim = '';

            for (var i = event.resultIndex; i < event.results.length; i++) {
                var chunk = event.results[i][0].transcript;

                if (event.results[i].isFinal) { saySomething(chunk); }
                else { interim = interim + chunk; }
            }
            $('#cc-interim').text(interim);
        };

        // Chrome stops after a pause even with continuous:true. Start it again.
        recog.onend = function () {
            if (!listening) { return; }
            try { recog.start(); } catch (e) { /* already restarting */ }
        };

        recog.onerror = function (event) {
            var code = (event && event.error) ? event.error : '';

            // A pause in the conversation is not a problem
            if (code === 'no-speech' || code === 'aborted') { return; }

            if (code === 'not-allowed' || code === 'service-not-allowed') {
                listening = false;      // stop onend restarting in a loop
                setCcButton(false);
                plainNote('Microphone permission was declined, so captions are off. Allow the ' +
                    'microphone in the address bar and press the captions button again.');
                return;
            }
            if (code === 'network') {
                plainNote('Captions need an internet connection, because the browser sends the ' +
                    'audio away to be turned into text.');
                return;
            }
            plainNote('Captions stopped (' + code + ').');
        };

        try {
            recog.start();
        } catch (e) {
            plainNote('Captions could not start. Try the button again.');
            return;
        }

        listening = true;
        setCcButton(true);

        /* theme.css has [hidden] { display: none !important }, so toggling the
           attribute is all that is needed - no show/hide, and no inline styles
           left behind to fight with later. */
        $('#cc-wrap').prop('hidden', false);
        $('#cc-final').text('');
        $('#cc-who-name').text('Listening');
        renderLog();
    }

    function stopTranscribe() {
        listening = false;
        setCcButton(false);

        if (recog) {
            recog.onend = null;   // do not let it restart itself on the way out
            try { recog.stop(); } catch (e) { /* already stopped */ }
            recog = null;
        }
        $('#cc-interim').text('');
    }

    function setCcButton(on) {
        $('#btn-cc')
            .toggleClass('is-live', !!on)
            .attr('aria-label', on ? 'Turn live captions off' : 'Turn live captions on')
            .attr('title', on
                ? 'Live captions and plain-English explanations are ON'
                : 'Turn on live captions and plain-English explanations');

        /* Hide the whole caption block when it is off. Leaving an empty bar
           sitting under the video suggests it is still working. */
        if (!on) { $('#cc-wrap').prop('hidden', true); }
    }


    /* ======================================================================
       THE TRANSCRIPT
       ====================================================================== */

    /* A random id made before the line goes out, so that when the server hands
       the same line back a second later we recognise it as one we already have
       rather than printing it twice. */
    function lineRef() {
        return 'l' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }

    /* Something WE just said.

       It goes on screen immediately and into the outgoing queue at the same
       time. Waiting for the server would put a second's delay on your own words,
       which reads as a broken caption. */
    function saySomething(text) {
        var clean = String(text || '').trim();
        if (!clean) { return; }

        var ref = lineRef();

        lines.push({
            id: null, ref: ref, who: 'person', name: 'You',
            mine: true, text: clean, at: new Date().toISOString()
        });

        outLines.push({ who: 'person', text: clean, ref: ref });
        syncNow();

        $('#cc-final').text(clean);
        $('#cc-interim').text('');
        $('#cc-who-name').text('You');

        renderLog();

        /* NOTE WHAT IS NOT HERE: we do not ask PRUWise about our own words.

           The point of the live explanation is to help you understand THE OTHER
           PERSON. Explaining your own sentence back to you is useless - you know
           what you meant. So the request is fired from absorbLines() instead,
           when one of their lines arrives. */
    }

    /* Lines arriving from the server: the other person's words, and our own
       coming back with a real id attached.

       DEDUPLICATION. Our own lines are already on screen with a ref and no id.
       When one comes back we fill in the id and leave it where it is. Anything
       with an id we already hold is skipped - which is what makes a retried
       request harmless. */
    function absorbLines(incoming) {
        var held = {};
        var theySaid = [];   // their spoken lines in this batch, for the explainer
        var i;

        for (i = 0; i < lines.length; i++) {
            if (lines[i].id) { held[lines[i].id] = true; }
        }

        var arrived = 0;

        incoming.forEach(function (row) {
            // One of ours, already on screen
            if (row.ref) {
                for (var j = 0; j < lines.length; j++) {
                    if (lines[j].ref === row.ref) {
                        lines[j].id = row.id;
                        return;
                    }
                }
            }

            if (row.id && held[row.id]) { return; }

            lines.push(row);
            held[row.id] = true;
            arrived++;

            /* Their words. Put them in the caption bar too - the loudness meter
               already showed that they were talking, this is what they said. */
            if (!row.mine && row.who === 'person') {
                $('#cc-final').text(row.text);
                $('#cc-interim').text('');

                /* AND EXPLAIN IT. This is the whole point of the feature: they
                   said something, possibly full of jargon, and this turns it into
                   something the person reading can act on.

                   For a customer that is a plain-English version, or a question
                   worth asking back. For a representative it is what to say or
                   check next. Either way it is about THEIR sentence, not ours. */
                theySaid.push(row.text);
            }
        });

        if (arrived) { renderLog(); }

        /* Read the transcript so far. Throttled inside, so this being on the
           hot path of every poll costs one comparison most of the time. */
        if (arrived) { analyseTranscript(false); }

        /* Explain the most recent thing they said, not every line in the batch.
           A poll can return three sentences at once and only the last one is
           still worth reacting to - and asking three times would burn the
           throttle and stack three nudges nobody reads. */
        if (theySaid.length) {

            /* THE CO-PILOT. Representative side only.

               Every one of their sentences is scanned for a life event, not just
               the most recent - a trigger is worth catching whenever it was said,
               and "we're expecting" arriving in the same poll as two other
               sentences must not be thrown away. That is the opposite of the
               explanation below, which is deliberately only about the latest
               thing said. */
            if (context && context.view === 'fr') {
                theySaid.forEach(askCopilot);
            }

            explainWhatTheySaid(theySaid[theySaid.length - 1]);
        }
    }

    /* One row of the log. Used by the expandable bar under the video AND by the
       transcript card in the side panel - one implementation, two places. */
    function logRows() {
        return lines.map(function (l) {
            var cls = 'tr-line' +
                (l.who === 'pruwise' ? ' is-ai' : '') +
                (l.mine && l.who !== 'pruwise' ? ' is-mine' : '');

            return '<div class="' + cls + '">' +
                '<span class="tr-who">' + FMT.esc(l.name || 'Someone') + '</span>' +
                '<span class="tr-text">' + FMT.esc(l.text) + '</span>' +
                '<span class="tr-time">' + FMT.time(l.at) + '</span>' +
                '</div>';
        }).join('');
    }

    function spokenCount() {
        var n = 0;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].who === 'person') { n++; }
        }
        return n;
    }

    function countLabel() {
        var spoken = spokenCount();
        if (!spoken) { return 'Nothing yet'; }

        return spoken + (spoken === 1 ? ' line' : ' lines');
    }

    /* Paint the log everywhere it appears, and keep the newest line in view. */
    function renderLog() {
        var rows = logRows();

        /* The covered log rides along here rather than having its own trigger.
           renderLog() already runs whenever anything about the conversation
           changes, and one more cheap DOM write is better than a second timer. */
        renderCovered();

        // 1. the expandable panel under the captions
        $('#cc-log-list').html(rows || '<div class="t-xs muted">Nothing said yet.</div>');
        $('#cc-log-count').text(countLabel());

        var inline = document.getElementById('cc-log-list');
        if (inline) { inline.scrollTop = inline.scrollHeight; }

        // 2. the transcript card in the side panel
        var box = $('#transcript-box');

        if (box.length) {
            box.html(transcriptHtml());
            $('#transcript-count').text(countLabel());

            var list = document.getElementById('tr-list');
            if (list) { list.scrollTop = list.scrollHeight; }
        }
    }

    /* The transcript as a block, for the side panel. Says plainly what it can
       and cannot hear, because a transcript that silently misses one person is
       worse than no transcript. */
    function transcriptHtml() {
        if (!lines.length) {
            return '<div class="t-xs muted">' +
                (listening
                    ? 'Listening. Every sentence appears here with the name of whoever said it.'
                    : 'Turn on captions with the speech button under the video. Both sides are ' +
                    'written down, each from their own microphone, so every line is labelled ' +
                    'with who said it.') +
                '</div>';
        }

        return '<div class="tr-list" id="tr-list">' + logRows() + '</div>';
    }

    // Plain text, for dropping into a notes box or a record
    function transcriptText() {
        return lines.map(function (l) {
            return (l.name || 'Someone') + ' (' + FMT.time(l.at) + '): ' + l.text;
        }).join('\n');
    }

    /* ======================================================================
       WHAT PRUWISE READ IN THE TRANSCRIPT

       The same reading that runs over a chat thread, over what was said out
       loud. The proposals land on the client's profile, not on this screen -
       a call is not the moment to ask somebody to review a form, and the
       representative is looking at a face.

       ==================================================================
       IT RUNS DURING THE CALL AS WELL AS AT THE END, AND THAT IS THE POINT
       ==================================================================

       "They mentioned a meeting" and "their income has changed" are worth
       having while there is still time to say "shall I book that now". At the
       end only, it would be a to-do list instead.

       So: at most once every 90 seconds while the call is live, and once more
       when it ends so nothing said in the last stretch is missed. The
       fingerprint on ai_insights means re-reading a growing transcript updates
       one row rather than adding a fourteenth - see db/schema.sql.

       NOTHING HERE BLOCKS THE CALL and nothing here reports a failure. The
       transcript is on screen and complete without any of it.
       ====================================================================== */

    var ANALYSE_EVERY_MS = 90000;
    var analysedUpTo = 0;   // highest transcript id already read
    var analysedAt = 0;

    /* Whose record the proposals are about. In a call one side is always the
       client - either the person on the other end, or me. */
    function insightPerson() {
        var peer = (room && room.peer) ? room.peer : {};

        if (peer.kind === 'customer' && peer.personId) { return String(peer.personId); }
        return String(STATE.session.personId || '');
    }

    /* What was said, labelled by speaker.

       THE 'pruwise' LINES ARE LEFT OUT. They are the assistant's own
       suggestions, written into the log so the record shows what was offered.
       Feeding them back in would have it read its own words and propose them as
       something the client said. */
    function analysableText() {
        return lines
            .filter(function (l) { return l.who !== 'pruwise'; })
            .map(function (l) { return (l.name || 'Someone') + ': ' + l.text; })
            .join('\n');
    }

    function analyseTranscript(force) {
        var code = room ? room.roomCode : null;
        if (!code) { return; }

        var personId = insightPerson();
        if (!personId) { return; }

        var newest = lines.length ? lines.length : 0;

        if (!force) {
            if (newest <= analysedUpTo) { return; }
            if (Date.now() - analysedAt < ANALYSE_EVERY_MS) { return; }
        }

        var text = analysableText();
        if (text.length < 40) { return; }

        /* Claimed before the request, so two overlapping calls cannot both go. */
        analysedUpTo = newest;
        analysedAt = Date.now();

        API.insights.analyse(personId, 'call', text, { roomCode: code }).then(
            function () { },
            function () { }
        );
    }

    function toggleLog() {
        logOpen = !logOpen;

        $('#cc-log').prop('hidden', !logOpen);
        $('#cc-line').attr('aria-expanded', logOpen ? 'true' : 'false');
        $('#cc-chev').toggleClass('is-open', logOpen);

        if (logOpen) {
            renderLog();

            var list = document.getElementById('cc-log-list');
            if (list) { list.scrollTop = list.scrollHeight; }
        }
    }


    /* ======================================================================
       THE CO-PILOT  (representative side only)

       The customer says something that changes their financial position; a card
       slides in on the representative's screen naming what it heard, what it
       means, and the one thing to do about it.

       WHY THE CARDS STACK RATHER THAN REPLACE: two triggers in one conversation
       are both still true. "We are expecting" does not stop being relevant
       because "money might get tight" was said thirty seconds later - in fact
       together they are the whole picture, and a representative who can see both
       at once gives better advice than one who saw each for four seconds.

       Each trigger appears ONCE per call. Somebody mentioning the baby three
       times does not need three identical cards, and the repeat is what would
       make the feature feel like a toy.
       ====================================================================== */

    var copilotSeen = {};       // trigger ids already shown this call
    var copilotAsking = false;  // one request in flight at a time
    var copilotReadChat = false; // has the earlier conversation been read yet

    /* ======================================================================
       THE POLICY SNAPSHOT DRAWER

       The representative pins two or three policies; the customer's screen shows
       the same ones, in a drawer over the video.

       WHY THIS EXISTS: the alternative is "open the plans page and scroll down to
       the third one" said out loud, while the customer navigates away from the
       call and stops looking at the person they are talking to. Screen sharing
       solves it by showing them a picture of a website. This shows them the
       actual thing, on their own screen, at their own text size.

       BOTH SIDES SEE THE SAME LIST because it travels on the signalling mailbox -
       see call_send_signal() in php/lib/calls.php for why that channel and not a
       table. Only the representative can change it; the customer's copy is
       read-only, which is the right way round for something being presented TO
       them.
       ====================================================================== */

    var pinned = [];            // product ids currently on screen, both sides
    var drawerOpen = false;     // is the drawer expanded?

    var PIN_MAX = 3;            // more than this stops being a snapshot

    /* Send the whole list. Called on every change, and again when the peer
       arrives - somebody who joined late has missed the earlier message, and one
       re-broadcast is cheaper than any reconciliation scheme. */
    function broadcastPins() {
        if (!room || context.view !== 'fr') { return; }

        outSignals.push({ kind: 'pin', payload: JSON.stringify(pinned) });
        syncNow();
    }

    function togglePin(productId) {
        if (context.view !== 'fr') { return; }      // customers do not pin

        var at = pinned.indexOf(productId);

        if (at === -1) {
            if (pinned.length >= PIN_MAX) {
                UI.toast({
                    title: 'Three at a time',
                    message: 'Unpin one first. A snapshot with six things on it is a brochure.',
                    tone: 'info', duration: 2600
                });
                return;
            }
            pinned.push(productId);
        } else {
            pinned.splice(at, 1);
        }

        renderPinned();
        broadcastPins();
    }

    /* Draw the drawer. Runs on both sides from the same data, so there is one
       implementation and the two screens cannot drift apart visually. */
    function renderPinned() {
        var isRep = (context.view === 'fr');

        // Nothing pinned: no drawer at all, on either side.
        if (!pinned.length) {
            $('#pin-drawer').remove();
            drawerOpen = false;
            return;
        }

        if (!$('#pin-drawer').length) {
            $('.call-stage').append(
                '<div id="pin-drawer" class="pin-drawer">' +
                '<button type="button" class="pin-handle" data-act="pin-toggle-drawer">' +
                '<span class="pin-handle-label">' + UI.icon('fileText', 15) +
                '<span id="pin-count"></span></span>' +
                UI.icon('chevronUp', 15) +
                '</button>' +
                '<div class="pin-body" id="pin-body"></div>' +
                '</div>'
            );
            drawerOpen = true;
        }

        $('#pin-count').text(pinned.length + (pinned.length === 1 ? ' policy pinned' : ' policies pinned'));
        $('#pin-drawer').toggleClass('is-open', drawerOpen);

        var cards = pinned.map(function (id) {
            var p = (typeof DATA !== 'undefined' && DATA.getProduct) ? DATA.getProduct(id) : null;
            if (!p) { return ''; }

            /* Two or three key facts and the same number of caveats. NOT the full
               product page - the point is something readable in ten seconds while
               somebody is talking. */
            var features = (p.features || []).slice(0, 2).map(function (f) {
                return '<li>' + UI.icon('check', 11) + '<span>' + FMT.esc(f) + '</span></li>';
            }).join('');

            var cautions = (p.considerations || []).slice(0, 2).map(function (f) {
                return '<li>' + UI.icon('alertCircle', 11) + '<span>' + FMT.esc(f) + '</span></li>';
            }).join('');

            return '<div class="pin-card">' +
                '<div class="pin-card-head">' +
                '<span class="pin-card-name">' + FMT.esc(p.name) + '</span>' +
                (isRep
                    ? '<button type="button" class="pin-x" data-act="pin-remove" ' +
                      'data-id="' + FMT.esc(id) + '" aria-label="Unpin">' + UI.icon('x', 13) + '</button>'
                    : '') +
                '</div>' +
                '<div class="pin-card-cat">' + FMT.esc(p.category) + '</div>' +
                (p.tagline ? '<div class="pin-card-line">' + FMT.esc(p.tagline) + '</div>' : '') +
                (features ? '<ul class="pin-list pin-good">' + features + '</ul>' : '') +
                (cautions ? '<ul class="pin-list pin-warn">' + cautions + '</ul>' : '') +
                '</div>';
        }).join('');

        $('#pin-body').html(cards);
    }

    /* The representative's picker. Every product, with the pinned ones ticked.

       Rebuilt and reopened on each choice rather than updated in place: the modal
       is small, and reopening keeps one rendering path instead of two that can
       disagree about which items are ticked. */
    function openPinPicker() {
        var catalogue = (typeof DATA !== 'undefined' && DATA.products) ? DATA.products : [];

        var rows = catalogue.map(function (p) {
            var on = (pinned.indexOf(p.id) !== -1);

            return '<button type="button" class="menu-item' + (on ? ' is-on' : '') + '" ' +
                'data-act="pin-pick" data-id="' + FMT.esc(p.id) + '">' +
                UI.icon(p.icon || 'fileText', 16) +
                '<span class="grow">' +
                '<span class="t-sm semi truncate">' + FMT.esc(p.name) + '</span>' +
                '<span class="t-xs muted truncate">' + FMT.esc(p.category) + '</span>' +
                '</span>' +
                UI.icon(on ? 'checkCircle' : 'plus', 15) +
                '</button>';
        }).join('');

        UI.openModal({
            title: 'Pin a policy to the call',
            sub: pinned.length
                ? pinned.length + ' of ' + PIN_MAX + ' pinned'
                : 'They will see whatever you pin, on their own screen',
            size: 'sm',
            body: '<div class="menu">' + rows + '</div>' +
                UI.callout({
                    tone: 'info', icon: 'info',
                    title: 'Three at a time',
                    text: 'A snapshot is meant to be readable while you are talking. Anything ' +
                        'longer belongs in a message afterwards.'
                }),
            foot: UI.btn({ label: 'Done', variant: 'ghost', act: 'close-modal' })
        });
    }

    /* ======================================================================
       PAST CALLS

       Rendered into whatever container is given, from the server's history. Both
       sides use this - the only difference is whose name appears, and the server
       has already worked that out.
       ====================================================================== */

    /* Redraw whichever history container is on this page.

       Called after a call ends, so the call you just had is in the list without a
       reload - a "past calls" tab that does not include the call you just
       finished looks broken, and it is the one entry you are most likely to be
       looking for.

       It checks for both containers rather than being told which: the two call
       screens use different ids, and this is the one place in call.js that has to
       know about either of them. Missing containers are simply skipped, so a
       screen with no history tab costs nothing. */
    function refreshHistory() {
        ['#me-callog', '#fr-callog'].forEach(function (sel) {
            if ($(sel).length) { renderHistory(sel); }
        });
    }

    function renderHistory(selector, howMany) {
        var $box = $(selector);
        if (!$box.length) { return; }

        $box.html(UI.loadingState('Looking up your calls\u2026'));

        API.callHistory(howMany || 8).then(

            function (data) {
                var calls = data.calls || [];

                if (!calls.length) {
                    $box.html(UI.emptyState({
                        icon: 'video', title: 'No calls yet',
                        text: 'Once you have spoken, every call appears here with how long it ran.',
                        plain: true
                    }));
                    return;
                }

                $box.html('<div class="callog">' + calls.map(function (c) {

                    /* A call that connected is reported differently from one
                       nobody answered - see the note in php/api/calls.php. */
                    var tone = c.connected ? 'did' : 'miss';
                    var icon = c.connected ? 'video' : 'phoneOff';

                    var meta = [];
                    meta.push(c.duration);
                    if (c.lineCount) { meta.push(c.lineCount + ' lines transcribed'); }
                    if (c.live) { meta.push('still open'); }

                    return '<div class="callog-row">' +
                        '<span class="callog-icon ' + tone + '">' +
                        UI.icon(icon, 15) + '</span>' +
                        '<span class="callog-main">' +
                        '<span class="callog-who">' + FMT.esc(c.withName) + '</span>' +
                        '<span class="callog-meta">' +
                        meta.map(function (m) { return '<span>' + FMT.esc(m) + '</span>'; }).join('') +
                        '</span></span>' +
                        '<span class="callog-when">' +
                        FMT.relative(c.startedAt || c.createdAt) + '</span>' +
                        '</div>';
                }).join('') + '</div>');
            },

            function (err) {
                $box.html(UI.errorState({ title: 'Could not load your calls', text: err.error }));
            }
        );
    }

    /* The control that opens the picker. Representative side only - added to the
       controls row by whichever page builds the stage. */
    function pinButton() {
        return control({
            act: 'pin-open', id: 'btn-pin', icon: 'fileText',
            aria: 'Pin a policy for them to read',
            title: 'Pin a policy so the client can read it without leaving the call'
        });
    }

    function askCopilot(text) {
        if (!room || !text) { return; }

        /* Serialised on purpose. The transcript can deliver three sentences in
           one poll, and three overlapping requests would race each other to
           render into the same container. */
        if (copilotAsking) { return; }
        copilotAsking = true;

        /* THE EARLIER CONVERSATION, ASKED FOR ONCE.

           The first request of a call also asks the server to scan what the client
           has already written in their chat - see api/_routes/call-copilot.ts. It
           cannot change while the call runs, so asking again on every sentence
           would be a round trip per sentence for the same answer.

           Claimed BEFORE the request rather than in the success handler: a failed
           first request must not leave the flag unset and have the next twenty
           sentences each re-read the whole thread. One attempt is the intent. */
        var wantChat = !copilotReadChat;
        copilotReadChat = true;

        API.callCopilot(room.roomCode, text, wantChat).then(

            function (data) {
                copilotAsking = false;

                (data.triggers || []).forEach(function (t) {
                    if (copilotSeen[t.id]) { return; }     // already shown
                    copilotSeen[t.id] = true;
                    drawCopilotCard(t);
                });

                /* Hits found in the earlier messages. Same trigger objects, drawn
                   as a different KIND of note - one says it heard something just
                   now, the other says the client wrote it before the call. Sharing
                   copilotSeen with the live list is deliberate: if they mentioned
                   the baby in chat AND said it out loud, that is one thing to act
                   on, and the first note to arrive is the one that stays. */
                (data.fromChat || []).forEach(function (t) {
                    if (copilotSeen[t.id]) { return; }
                    copilotSeen[t.id] = true;
                    drawCopilotCard(t, { fromChat: true });
                });
            },

            function () {
                copilotAsking = false;
                /* Quiet. A co-pilot that pops up an error message during a live
                   call is worse than one that misses a trigger. */
            }
        );
    }

    /* ======================================================================
       POST-IT NOTES ON THE VIDEO

       ==================================================================
       WHY EVERYTHING THE ASSISTANT SAYS DURING A CALL IS NOW A POST-IT
       ==================================================================

       There were two surfaces and both were wrong for a live call.

       THE EXPLANATION BAR sat under the video. One at a time, silently replaced by
       the next, in the part of the screen nobody looking at a face is reading. An
       explanation that has been overwritten was never read.

       THE CO-PILOT STACK was pinned to a corner, fixed, and covered whatever was
       behind it. On a phone it covered the other person.

       A post-it is the right object because it matches what people already do in a
       meeting: something gets written down, it sits where you put it, you move it
       out of the way of the thing you are looking at, you cross it off when it is
       dealt with, and you keep it if you want it. So:

         MOVABLE     drag the header. Both people are looking at a face; where the
                     note has to go depends on where the face is, and only the
                     person watching knows that.

         MINIMISE    collapses to the header. Not the same as closing - "I know it
                     is there, not now" is a different intention from "gone", and
                     collapsing keeps the count honest.

         CROSS OUT   struck through and faded, still on screen. "Dealt with" is
                     worth being able to see during a call, and a note that
                     vanishes when you tick it takes the record of what you covered
                     with it.

         COPY        into the notes box for this call AND the clipboard. This is
                     what makes it a note rather than a prompt.

         CLOSE       gone. Some of them are not relevant and should not be argued
                     with.

       ==================================================================
       POSITION IS REMEMBERED, PER NOTE, FOR THE WHOLE CALL
       ==================================================================

       In a variable rather than in the DOM, so a note is not thrown back to its
       default corner by anything that redraws. Nothing else on this screen moves,
       and a note that jumps is worse than a note that cannot be moved at all.
       ====================================================================== */

    var postits = {};        // id -> { x, y, min, struck }
    var postitCount = 0;     // for the cascade, so two notes never land exactly on top

    function postitLayer() {
        if (!$('#postit-layer').length) {
            /* Created on first use rather than rendered with the page, so a call in
               which the assistant says nothing has nothing in the DOM at all. */
            $('.call-stage').append('<div id="postit-layer" class="postit-layer"></div>');
        }
        return $('#postit-layer');
    }

    /* One note. `id` makes it idempotent: the same observation arriving twice
       updates the note that is already there instead of stacking a duplicate. */
    function postIt(o) {
        o = o || {};

        var id = String(o.id || ('note-' + (++postitCount)));
        var state = postits[id];

        if (!state) {
            /* THE CASCADE. Top right, stepping down and left, because the
               right-hand side is where the self-view already is on a wide screen
               and the middle is where the other person's face is. Wrapped after
               five so a long call does not walk them off the bottom. */
            var step = postitCount % 5;

            /* ALREADY TICKED? A note arriving for the second time - after a
               refresh, or because the representative navigated away and came back -
               comes back crossed out, because it was. The saved log is the
               authority on that, not this closure, which is empty again. */
            var saved = coveredMap();

            state = {
                x: 16 + step * 10, y: 16 + step * 30, min: false,
                struck: !!(saved && saved[id])
            };
            postits[id] = state;
            postitCount++;
        }

        /* ==================================================================
           THE HEADER SAYS WHAT KIND OF NOTE THIS IS

           REQUESTED: "can have like different title based on what the post it is
           so that they can differentiate the post its".

           Four things now write post-its and they used to look identical apart
           from a word: a life event detected in the room, the same detected in the
           earlier chat, a plain-language explanation, and a "working that out"
           placeholder. Three of them said "PRUWise" or "Detected" in the same
           grey, so a stack of five notes was a wall.

           `kind` colours the header strip and is what the eye sorts on; the tag
           text is the sentence. Colour ALONE would not be enough - it never is -
           so the wording stays distinct too and the two agree.
           ================================================================== */
        var kind = o.kind || 'ai';

        var body = '' +
            '<div class="postit-grip postit-grip-' + kind + '" data-act="postit-drag">' +
            '<span class="postit-tag">' + UI.icon(o.icon || 'sparkles', 12) +
            '<span>' + FMT.esc(o.tag || 'PRUWise') + '</span></span>' +

            '<span class="postit-tools">' +
            '<button type="button" class="postit-btn" data-act="postit-min" ' +
            'title="Minimise" aria-label="Minimise this note">' +
            UI.icon('chevronDown', 13) + '</button>' +
            '<button type="button" class="postit-btn" data-act="postit-strike" ' +
            'title="Cross it out" aria-label="Cross this note out">' +
            UI.icon('check', 13) + '</button>' +
            '<button type="button" class="postit-btn" data-act="postit-close" ' +
            'title="Close" aria-label="Close this note">' +
            UI.icon('x', 13) + '</button>' +
            '</span></div>' +

            '<div class="postit-body">' +
            (o.title ? '<div class="postit-title">' + FMT.esc(o.title) + '</div>' : '') +
            '<div class="postit-text">' + FMT.esc(o.text || '') + '</div>' +
            (o.extra || '') +

            (o.heard
                ? '<div class="postit-heard">heard: \u201C' + FMT.esc(o.heard) + '\u201D</div>'
                : '') +

            /* A caveat the note carries about itself. Used by the chat-sourced
               co-pilot cards to say the fact may be stale - see drawCopilotCard. */
            (o.note
                ? '<div class="postit-caveat">' + UI.icon('info', 11) +
                  '<span>' + FMT.esc(o.note) + '</span></div>'
                : '') +

            '<div class="postit-foot">' +
            '<button type="button" class="postit-copy" data-act="postit-copy">' +
            UI.icon('clipboard', 12) + '<span>Copy to my notes</span></button>' +
            /* SAID ON EVERY NOTE. The one thing somebody needs to know before
               reacting to a suggestion mid-call is whether the other person can see
               it. They cannot - the server never sends one side's assistant output
               to the other - and a note floating over a shared video call is
               exactly the thing that would make somebody assume otherwise. */
            '<span class="postit-private">' + UI.icon('lock', 10) +
            '<span>only you</span></span>' +
            '</div>' +
            '</div>';

        var $note = $('#postit-' + cssId(id));

        if ($note.length) {
            /* Already on screen. Replace the contents and leave the position and
               the minimised state exactly as the person left them. */
            $note.html(body);

        } else {
            $note = $('<div class="postit" id="postit-' + cssId(id) + '" ' +
                'data-note="' + FMT.esc(id) + '">' + body + '</div>');

            postitLayer().append($note);
        }

        $note.toggleClass('is-min', !!state.min)
            .toggleClass('is-struck', !!state.struck)
            .css({ right: state.x + 'px', top: state.y + 'px' });

        /* NOT capped to three the way the old stack was. A note that is in the way
           can be moved or closed, which is the whole point - silently deleting the
           oldest one meant the thing said four sentences ago disappeared while
           somebody was still reading it. */
        return $note;
    }

    /* Ids come from the server (a trigger id) and from this file. Neither is
       guaranteed to be a legal CSS identifier, and a '.' in one would make the
       selector match a class instead of an id. */
    function cssId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '-'); }


    /* ======================================================================
       THE COVERED-TOPICS LOG

       Every note that gets ticked lands here, and the panel below the transcript
       lists them. That is what turns the tick from a piece of styling into the
       thing that was asked for: a record of what has already been gone through.

       KEYED BY ROOM CODE. Two calls with the same client are two conversations,
       and carrying last week's covered list into today's call would make the
       representative skip something they never actually said.
       ====================================================================== */

    function coveredMap() {
        var code = room ? room.roomCode : '';
        if (!code) { return null; }

        if (!STATE.callCovered) { STATE.callCovered = {}; }
        if (!STATE.callCovered[code]) { STATE.callCovered[code] = {}; }

        return STATE.callCovered[code];
    }

    /* The heading of a note, for the log. Falls back to the body when a note has
       no title - the plain-language explanations do not have one. Trimmed, because
       a log line that runs to forty words is not a log line. */
    function noteLabel($note) {
        var text = $.trim($note.find('.postit-title').first().text()) ||
                   $.trim($note.find('.postit-text').first().text());

        if (text.length > 90) { text = text.slice(0, 88) + '\u2026'; }

        return text || 'A note';
    }

    function markCovered(id, on, label) {
        var map = coveredMap();
        if (!map) { return; }

        if (on) {
            map[id] = { label: label, at: new Date().toISOString() };
        } else {
            /* UNTICKING REMOVES IT. A tick is a statement that something was dealt
               with, and being able to take it back is the same as being able to
               correct a mistake - keeping a "was ticked once" record would make the
               log unfixable. */
            delete map[id];
        }

        saveState();
        renderCovered();
    }

    /* Order is the order they were ticked, not the order the notes arrived - the
       log is a record of the conversation, and the conversation happened in the
       order somebody ticked things off. */
    function coveredList() {
        var map = coveredMap() || {};

        return Object.keys(map).map(function (id) {
            return { id: id, label: map[id].label, at: map[id].at };
        }).sort(function (a, b) {
            return new Date(a.at) - new Date(b.at);
        });
    }

    function renderCovered() {
        var $box = $('#call-covered');
        if (!$box.length) { return; }

        var rows = coveredList();

        $('#call-covered-count').text(rows.length
            ? rows.length + (rows.length === 1 ? ' topic' : ' topics')
            : 'Nothing yet');

        if (!rows.length) {
            $box.html('<div class="t-xs muted">Cross a note out on the video and it ' +
                'is recorded here, so you can see what you have already been ' +
                'through without scrolling the transcript.</div>');
            return;
        }

        $box.html(rows.map(function (r) {
            return '<div class="covered-row">' +
                UI.icon('checkCircle', 13) +
                '<span class="covered-label">' + FMT.esc(r.label) + '</span>' +
                '<span class="covered-time">' + FMT.time(r.at) + '</span>' +
                '</div>';
        }).join('') +

            /* The one control worth having: it puts the whole list into the notes
               box, which is the copy that becomes part of the record. */
            '<button type="button" class="btn btn-soft btn-xs" data-act="covered-copy">' +
            UI.icon('clipboard', 12) + '<span>Add all of this to my notes</span></button>');
    }

    function drawCopilotCard(t, opts) {
        var fromChat = !!(opts && opts.fromChat);

        /* No container is created here any more. postIt() makes the layer on first
           use, which is the same trick the #copilot-stack did - a call in which the
           assistant says nothing has nothing in the DOM at all. */

        var products = (t.products || []).map(function (p) {
            return '<button type="button" class="postit-prod" data-act="copilot-push" ' +
                'data-id="' + FMT.esc(p.productId) + '" data-name="' + FMT.esc(p.name) + '">' +
                UI.icon('send', 12) + '<span>' + FMT.esc(p.name) + '</span></button>';
        }).join('');

        /* A POST-IT NOW, not a card in a fixed corner stack.

           The old .copilot-card had its own dismiss button, its own head, its own
           layout and its own three-card cap. All of that is postIt()'s job, so what
           is left here is only what is specific to a co-pilot trigger: what it
           heard, what it thinks that means, what to do about it, and the products
           it is worth putting in front of somebody.

           The trigger id becomes the note id, which makes the same trigger arriving
           twice update one note rather than stack two. */
        postIt({
            id: 'trigger-' + t.id,

            /* THE LABEL IS THE HONESTY. A live card is quoting the microphone; a
               chat card is quoting something typed days ago. Both are useful and
               they are not the same claim, so `heard: "pregnant"` is only ever
               shown for the live one - a card saying it HEARD something the client
               did not say in the room would send the representative looking for a
               sentence that never happened. */
            tag: fromChat ? 'They wrote this earlier' : 'Heard just now',
            icon: fromChat ? 'messageSquare' : 'mic',
            kind: fromChat ? 'chat' : 'heard',

            title: t.detected,
            text: t.meaning,
            heard: fromChat ? '' : t.heard,
            note: fromChat
                ? 'They wrote this to you before the call, so it may already be ' +
                  'out of date - worth confirming rather than assuming.'
                : '',

            extra:
                '<div class="postit-action">' + UI.icon('arrowRight', 12) +
                '<span>' + FMT.esc(t.action) + '</span></div>' +

                (t.ask
                    ? '<div class="postit-ask">' + UI.icon('helpCircle', 12) +
                      '<span>' + FMT.esc(t.ask) + '</span></div>'
                    : '') +

                (products ? '<div class="postit-prods">' + products + '</div>' : '')
        });
    }

    /* Send a product comparison into the shared conversation, mid-call.

       Uses the ordinary message endpoint, so it lands in the same thread they
       already use and is still there after the call. Nothing bespoke, nothing
       that only exists while the call is open. */
    function pushProduct(productId, name) {
        if (!room) { return; }

        var text = 'Have a look at ' + name + ' - I think it is worth going through ' +
            'together. I will walk you through what it covers and what it does not.';

        API.sendMessage({ withPerson: room.peer ? room.peer.personId : '' }, text, [], lineRef())
            .then(
                function () {
                    UI.toast({
                        title: 'Sent to ' + (room.peer ? room.peer.name.split(' ')[0] : 'them'),
                        message: name + ' is in your conversation.',
                        tone: 'ok', duration: 2600
                    });
                },
                function (err) {
                    UI.toast({ title: 'Could not send', message: err.error, tone: 'warn' });
                }
            );
    }


    /* ======================================================================
       EXPLAINING WHAT THE OTHER PERSON JUST SAID

       This is the "live translation". It is triggered by THEIR sentence, never
       by your own - explaining your own words back to you would be pointless.

       What it produces depends on who is reading:

         a customer sees   the jargon turned into plain English, or a question
                           worth asking back
         a representative  one concrete thing to say or check next

       PRIVATE, BOTH WAYS. Each side's explanation is stored against their own
       account and php/api/call-sync.php never hands one person's over to the
       other. That matters in both directions: the customer should not see a note
       telling their representative to stop pushing, and the representative should
       not see that the customer has been advised to ask about exclusions.
       ====================================================================== */
    function explainWhatTheySaid(text) {
        if (!context.customerId) { return; }
        if (!listening) { return; }   // captions off means this is off too

        // A live assistant that comments on every sentence is unusable
        if (Date.now() - lastAskAt < ASK_EVERY_MS) { return; }
        lastAskAt = Date.now();

        // Only worth a "thinking" state when a real request is going out
        if (AI.config.enabled) { showNudge({ text: 'Working that out\u2026', pending: true }); }

        AI.liveAssist(context.view, text, context.customerId, function (res) {
            // null means "nothing worth interrupting for", so stay quiet
            if (!res) {
                /* Only the "Working that out" placeholder is cleared. Every note
                   holding real wording stays until somebody closes it - see the
                   note above showNudge(). */
                nudgeDone();
                return;
            }

            showNudge(res);

            /* Into the transcript as well, so the record shows what the
               assistant offered and when. Marked 'pruwise', which is what keeps
               it out of the other person's copy. */
            var ref = lineRef();

            lines.push({
                id: null, ref: ref, who: 'pruwise', name: 'PRUWise',
                mine: true, text: res.text, at: new Date().toISOString()
            });

            outLines.push({ who: 'pruwise', text: res.text, ref: ref });
            syncNow();
            renderLog();
        });
    }

    /* The plain-English explanation of what the other person just said.

       ==================================================================
       EVERY EXPLANATION STAYS UNTIL SOMEBODY CLOSES IT
       ==================================================================

       This used to reuse ONE note with a fixed id, so each new explanation silently
       overwrote the last. That was reported as exactly what it was: "the post-its
       came out but they should stay there until we tap cancel." An explanation you
       were halfway through reading being replaced is the same failure as the old
       fixed bar it was meant to fix.

       So each real explanation gets its OWN note and is removed only by its Close
       button. They stack, they can be dragged apart, crossed out or minimised, and
       nothing on a timer touches them.

       THE ONE NOTE THAT IS STILL REPLACED is the "Working that out" placeholder. It
       has a fixed id and holds no content of its own, so it is closed the moment
       there is either something to say or nothing to say - see nudgeDone(). A
       spinner nobody can get rid of would be the opposite of the ask.
       ==================================================================

       Notes keep wherever they were put, because postIt() only positions a note it
       has not seen before. */

    var nudgeSeq = 0;

    var PENDING_NOTE = 'explain-pending';

    function showNudge(res) {
        if (res.pending) {
            postIt({
                id: PENDING_NOTE,
                tag: 'PRUWise is thinking',
                icon: 'sparkles',
                kind: 'pending',
                text: res.text
            }).addClass('is-pending');
            return;
        }

        /* Real wording. The placeholder goes and a permanent note takes its place. */
        nudgeDone();

        postIt({
            id: 'explain-' + (++nudgeSeq),
            tag: 'In plain words',
            icon: 'messageCircle',
            kind: 'plain',
            text: res.text
        });

        /* ==============================================================
           AND SAID OUT LOUD, IF THEY ASKED FOR THAT.

           Settings has offered "Read PRUWise suggestions aloud during a call"
           for several rounds and NOTHING HAS EVER READ ANYTHING ALOUD - the
           preference saved to the database and no code anywhere called
           speechSynthesis. A switch that reports a state it does not have is
           worse than a missing feature: it gets turned on, nothing happens, and
           the conclusion is that the audio is broken.

           So this is the switch finally doing what it says.

           MUTED WHILE THE MICROPHONE IS LIVE, because the alternative is the
           other person hearing a robot read advice about themselves through your
           microphone. That would be a serious thing to leak by accident, and it
           is the reason this is not simply "speak it".
           ============================================================== */
        var prefs = (STATE.session && STATE.session.prefs) || {};

        if (prefs.speechEnabled && !micOn) { UI.speech.say(res.text); }
    }

    /* Close the placeholder, and only the placeholder. Everything else on the stage
       is either something somebody is reading or something they have decided to
       keep. */
    function nudgeDone() {
        delete postits[PENDING_NOTE];
        $('#postit-' + cssId(PENDING_NOTE)).remove();
    }


    /* ======================================================================
       MUTE AND CAMERA

       Both act on the real tracks now, so they mean something to the person on
       the other end rather than just changing an icon.
       ====================================================================== */

    function setMic(on) {
        micOn = on;

        if (localStream) {
            localStream.getAudioTracks().forEach(function (track) {
                track.enabled = on;
            });
        }

        /* Muting yourself should stop transcribing you too. Sending the other
           person a caption of something you deliberately muted would be worse
           than useless. */
        if (!on && listening) { stopTranscribe(); }

        $('#btn-mic').toggleClass('is-off', !on)
            .html(UI.icon(on ? 'mic' : 'micOff', 18))
            .attr('aria-label', on ? 'Mute microphone' : 'Unmute microphone');
    }

    /* Camera off genuinely releases the device, so the light on the machine goes
       out - which is the whole point of a camera button.

       replaceTrack(null) is what makes that possible without renegotiating.
       Removing a track from a connection normally means a fresh offer and answer;
       replacing what a sender is sending does not. So we stop the real track and
       hand the sender nothing, and the other side simply sees the picture stop. */
    function setCamera(on) {
        camOn = on;

        $('#btn-cam').toggleClass('is-off', !on)
            .html(UI.icon(on ? 'video' : 'videoOff', 18))
            .attr('aria-label', on ? 'Turn camera off' : 'Turn camera on');

        if (!on) {
            if (localStream) {
                localStream.getVideoTracks().forEach(function (track) {
                    track.stop();
                    localStream.removeTrack(track);
                });
            }
            videoSender(function (sender) { sender.replaceTrack(null); });

            $('#self-cam').prop('hidden', true);
            $('#self-placeholder').show();
            return;
        }

        // Back on: a fresh video track, swapped into the existing connection
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { return; }

        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }).then(
            function (stream) {
                var track = stream.getVideoTracks()[0];
                if (!track) { return; }

                if (!localStream) { localStream = new MediaStream(); }
                localStream.addTrack(track);

                videoSender(function (sender) { sender.replaceTrack(track); });
                showSelf(localStream);
            },
            function (err) {
                camOn = false;
                note(mediaReason(err));
            }
        );
    }

    /* Hand the video sender to a function, if there is a connection yet.

       We keep the sender from when the connection was built rather than hunting
       for it. Searching by track kind does not work once the track has been
       removed - a sender with no track has nothing to identify it by. */
    function videoSender(use) {
        if (!pc) { return; }

        var sender = videoSenderRef;

        if (!sender) {
            pc.getTransceivers().some(function (t) {
                var kind = (t.receiver && t.receiver.track && t.receiver.track.kind)
                    || (t.sender && t.sender.track && t.sender.track.kind);
                if (kind !== 'video') { return false; }
                sender = t.sender;
                videoSenderRef = sender;
                return true;
            });
        }

        if (!sender) { return; }
        use(sender);
    }


    /* ======================================================================
       ENDING
       ====================================================================== */

    /* Hang up. Returns a promise, because the duration comes from the server -
       our own clock has been running since the page opened, which is not the
       same as the time the two of us were connected.

           CALL.finish().then(function (ended) { ... ended.seconds ... }) */
    function finish() {
        var out = $.Deferred();
        var code = room ? room.roomCode : null;

        /* BEFORE stopEverythingLocal() and before the room is let go, because
           analyseTranscript() needs the room code and the peer to know whose
           record this is about. force = true: whatever was said in the last
           stretch has to be read even if the throttle has not expired. */
        analyseTranscript(true);

        stopEverythingLocal();

        if (!code) {
            out.resolve({ seconds: seconds, text: spoken(seconds), lines: spokenCount(), transcript: lines });
            return out.promise();
        }

        API.callEnd(code).then(function (data) {
            phase = 'ended';

            /* The server has now closed the room, so the history query will
               include this call. Refresh it before resolving. */
            refreshHistory();

            out.resolve({
                seconds: data.seconds,
                text: spoken(data.seconds),
                lines: data.lines,
                transcript: lines
            });
        }, function () {
            /* The server could not be told. The call is over from this person's
               point of view either way, so report our own figures rather than
               refusing to close the screen. */
            phase = 'ended';

            out.resolve({
                seconds: seconds, text: spoken(seconds),
                lines: spokenCount(), transcript: lines
            });
        });

        return out.promise();
    }

    // They hung up, or their session ended the call
    function remoteHungUp() {
        if (phase === 'ended') { return; }

        /* Same reading as finish(). They hung up first, which must not mean the
           last thing they said goes unread. */
        analyseTranscript(true);

        phase = 'ended';
        stopEverythingLocal();

        setPhase('ended');
        showPeerState('They ended the call.');
        hidePeerVideo();

        // Their hang-up ended the room on the server too, so our history moved on
        refreshHistory();

        if (onRemoteEnd) { onRemoteEnd({ seconds: seconds, text: spoken(seconds), lines: spokenCount() }); }
        else { UI.toast({ title: 'Call ended', message: 'The other person hung up.', tone: 'info' }); }
    }

    /* Everything that has to stop, whoever ended it. Deliberately does NOT post
       to the server - finish() does that, and remoteHungUp() must not, because
       the server already knows. */
    function stopEverythingLocal() {
        if (timer) { window.clearInterval(timer); timer = null; }
        if (levelTimer) { window.clearInterval(levelTimer); levelTimer = null; }

        stopSync();
        stopTranscribe();
        closeConnection();
        stopCamera();

        dropMeter('me');
        dropMeter('peer');
    }

    /* ======================================================================
       THE DOCK - a call that carries on while you look at something else

       ==================================================================
       THE ONE HARD PART IS THE <video> ELEMENT
       ==================================================================

       A MediaStream is attached to a specific element via srcObject. When the
       router replaces the page contents, that element is destroyed and the picture
       is gone - even though the peer connection is perfectly healthy and the track
       is still arriving. Re-creating the element later and re-attaching would work
       for the REMOTE stream, but `remoteStream` is the only handle on it and the
       reason it survives is that this module holds it.

       So the elements are MOVED rather than rebuilt. appendChild on a node that is
       already in the document relocates it, and srcObject survives the move - the
       stream keeps playing through the same element in its new parent. Coming back
       to the call screen moves them home.

       That is why undockCall() puts them back rather than re-rendering: a rebuilt
       <video> would be black until the next keyframe at best, and blank forever for
       the self-view, whose stream is local and has no keyframes to wait for.
       ====================================================================== */

    var docked = false;

    function dockCall() {
        if (docked || !room) { return; }
        docked = true;

        if (!$('#call-dock').length) {
            $('body').append(
                '<div class="call-dock" id="call-dock">' +
                '<div class="call-dock-video" id="call-dock-video"></div>' +

                '<div class="call-dock-text">' +
                '<span class="call-dock-who">' +
                '<span class="live-dot is-on"></span>' +
                '<span class="truncate">' +
                FMT.esc(room.peer && room.peer.name ? room.peer.name : 'On a call') +
                '</span></span>' +
                '<span class="call-dock-time" id="call-dock-time">' + clock() + '</span>' +
                '</div>' +

                '<div class="call-dock-tools">' +
                '<button type="button" class="call-dock-btn" data-act="call-dock-mic" ' +
                'id="call-dock-mic" aria-label="Mute or unmute">' +
                UI.icon(micOn ? 'mic' : 'micOff', 15) + '</button>' +

                '<button type="button" class="call-dock-btn is-primary" ' +
                'data-act="call-dock-return">' + UI.icon('maximize', 14) +
                '<span>Return</span></button>' +

                '<button type="button" class="call-dock-btn is-end" ' +
                'data-act="call-dock-end">' + UI.icon('phoneOff', 14) +
                '<span>End</span></button>' +
                '</div>' +
                '</div>'
            );
        }

        /* MOVED, not copied. See the note above. */
        var peer = document.getElementById('peer-cam');
        var host = document.getElementById('call-dock-video');

        if (peer && host) { host.appendChild(peer); }

        /* The self-view is deliberately left behind and destroyed with the page.
           The dock is 240px wide and the useful thing to see in it is the other
           person; a thumbnail of your own face in a thumbnail of a call is not
           information. The local stream is untouched, so they can still be seen
           and the camera button still works. */
    }

    function undockCall() {
        docked = false;

        var peer = document.getElementById('peer-cam');
        var tile = document.getElementById('peer-tile');

        if (peer && tile) {
            /* Back to the front of its tile, before the placeholder, so the
               existing CSS stacking still applies. */
            tile.insertBefore(peer, tile.firstChild);

            /* The freshly rendered page has a hidden <video> of its own in the
               markup. Two elements with the same id is invalid and the wrong one
               would win every getElementById after this, so the empty duplicate
               goes. */
            $(tile).find('video#peer-cam').not(peer).remove();

            if (remoteStream && remoteStream.getVideoTracks().length) {
                showPeerVideo(remoteStream);
            }
        }

        /* The self-view was not docked, so it is re-attached from the local
           stream - which this module still holds. */
        if (localStream) { showSelf(localStream); }

        $('#call-dock').remove();

        renderLog();
        renderPinned();
    }

    /* The page has gone. Same shutdown, plus telling the server, because nobody
       is going to press the hang-up button now. */
    function teardown() {
        var code = room ? room.roomCode : null;

        analyseTranscript(true);

        stopEverythingLocal();
        phase = 'ended';

        if (timer) { window.clearInterval(timer); timer = null; }

        /* The dock goes with the call. Leaving a "you are on a call" bar on screen
           after the call has ended would be the worst of both arrangements. */
        docked = false;
        $('#call-dock').remove();

        if (code) { API.callEnd(code); }
        room = null;
    }

    // Always release the camera, or the light stays on
    function stopCamera() {
        if (localStream) {
            localStream.getTracks().forEach(function (track) { track.stop(); });
            localStream = null;
        }

        /* Clear the local preview too. Leaving a stopped stream on #self-cam
           shows a black "You" tile (as in the post-hangup agent screenshot)
           instead of the avatar placeholder. */
        var selfCam = document.getElementById('self-cam');
        if (selfCam) {
            selfCam.srcObject = null;
            selfCam.hidden = true;
        }
        $('#self-placeholder').show();
    }

    function clock() {
        var mins = String(Math.floor(seconds / 60)).padStart(2, '0');
        var secs = String(seconds % 60).padStart(2, '0');
        return mins + ':' + secs;
    }

    // "4m 12s" - reads better inside a sentence than "04:12"
    function spoken(total) {
        var n = (typeof total === 'number') ? total : seconds;
        return Math.floor(n / 60) + 'm ' + (n % 60) + 's';
    }


    /* ======================================================================
       NOTES SHOWN ON THE STAGE
       ====================================================================== */

    // Something went wrong with the camera: explain, and put the avatar back
    function note(text) {
        $('#cam-note').text(text).prop('hidden', false);
        $('#self-placeholder').show();
        $('#self-cam').prop('hidden', true);
    }

    // Same box, without touching the camera tile
    function plainNote(text) {
        $('#cam-note').text(text).prop('hidden', false);
    }


    /* ======================================================================
       SHARED BUTTON HANDLERS

       Here rather than on the pages, so every control behaves identically for
       the representative and for the customer.
       ====================================================================== */
    $(function () {

        /* =================================================================
           THE POST-IT NOTES

           Dragging uses POINTER events, not mouse events. One set of handlers
           covers a mouse, a finger and a stylus, and setPointerCapture means the
           note keeps following even when the pointer leaves it - which is what
           happens the moment somebody drags faster than the browser repaints. With
           mouse events this needed a mousemove on document plus a mouseup that
           fires outside the window, and the classic bug is a note that stays stuck
           to the cursor.

           POSITIONED FROM THE RIGHT, not the left, and that is deliberate: the
           stage is a video that changes width with the window, and a note anchored
           to the left edge drifts across a face when the layout reflows.
           ================================================================= */

        var dragging = null;    // { id, $note, startX, startY, fromX, fromY }

        $(document).on('pointerdown', '[data-act="postit-drag"]', function (e) {
            /* Not the buttons in the header. They live inside the grip because that
               is where they belong visually, so the drag has to ignore them or
               every Close is also a one-pixel drag. */
            if ($(e.target).closest('.postit-btn').length) { return; }

            var $note = $(this).closest('.postit');
            var id = String($note.data('note'));
            var state = postits[id];

            if (!state) { return; }

            dragging = {
                id: id,
                $note: $note,
                startX: e.clientX,
                startY: e.clientY,
                fromX: state.x,
                fromY: state.y
            };

            $note.addClass('is-dragging');

            /* Brings the note being moved to the front. Somebody dragging a note
               is looking at that one. */
            postitLayer().append($note);

            if (this.setPointerCapture) {
                try { this.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
            }

            e.preventDefault();
        });

        $(document).on('pointermove', function (e) {
            if (!dragging) { return; }

            /* MINUS on x, because the note is anchored to the right edge: dragging
               right has to REDUCE the distance from that edge. Getting this the
               obvious way round makes the note run away from the cursor. */
            var x = dragging.fromX - (e.clientX - dragging.startX);
            var y = dragging.fromY + (e.clientY - dragging.startY);

            var stage = $('.call-stage');
            var maxX = Math.max(0, stage.outerWidth() - 60);
            var maxY = Math.max(0, stage.outerHeight() - 40);

            /* CLAMPED INSIDE THE STAGE. Without this a note can be dragged off the
               edge and there is then no way to get it back - the grip is what moves
               it and the grip is off screen. */
            x = Math.min(maxX, Math.max(0, x));
            y = Math.min(maxY, Math.max(0, y));

            postits[dragging.id].x = x;
            postits[dragging.id].y = y;

            dragging.$note.css({ right: x + 'px', top: y + 'px' });
        });

        $(document).on('pointerup pointercancel', function () {
            if (!dragging) { return; }

            dragging.$note.removeClass('is-dragging');
            dragging = null;
        });

        /* MINIMISE IS NOT CLOSE. "I know it is there, not now" and "gone" are
           different intentions and both are worth having. */
        $(document).on('click', '[data-act="postit-min"]', function () {
            var $note = $(this).closest('.postit');
            var id = String($note.data('note'));

            if (!postits[id]) { return; }

            postits[id].min = !postits[id].min;
            $note.toggleClass('is-min', postits[id].min);

            $(this).find('svg').replaceWith(
                UI.icon(postits[id].min ? 'chevronUp' : 'chevronDown', 13));
        });

        /* CROSSED OUT, STILL THERE. Struck through and faded rather than removed,
           because "we covered that" is worth being able to see for the rest of the
           call - and a note that vanishes when you tick it takes the record of what
           you dealt with along with it.

           AND NOW IT IS WRITTEN DOWN. The tick used to live only in `postits[id]`,
           which meant it was lost by any re-render - and since the call docks when
           the representative navigates, ticking a note and opening the client's
           record silently threw the tick away. It goes into STATE.callCovered,
           which is saved per account, so it survives navigation and a refresh and
           feeds the covered-topics panel. */
        $(document).on('click', '[data-act="postit-strike"]', function () {
            var $note = $(this).closest('.postit');
            var id = String($note.data('note'));

            if (!postits[id]) { return; }

            postits[id].struck = !postits[id].struck;
            $note.toggleClass('is-struck', postits[id].struck);

            markCovered(id, postits[id].struck, noteLabel($note));
        });

        $(document).on('click', '[data-act="postit-close"]', function () {
            var $note = $(this).closest('.postit');
            var id = String($note.data('note'));

            /* The state goes too, so a note of the same id arriving later comes back
               at a fresh position rather than reappearing wherever this one was
               parked - and unminimised, because it is a new thing to read.

               THE COVERED LOG IS NOT TOUCHED. Closing a note is "I do not need this
               on screen"; ticking it was "we went through this". Clearing the log
               entry here would mean tidying the screen quietly deleted the record
               of the conversation, which is the exact failure the log exists to
               prevent. Untick it if it was ticked by mistake. */
            delete postits[id];

            $note.fadeOut(140, function () { $(this).remove(); });
        });

        /* The whole covered list into the notes box - the copy that is stored and
           that the representative can paste into the summary. Same reasoning as the
           per-note copy button above it. */
        $(document).on('click', '[data-act="covered-copy"]', function () {
            var rows = coveredList();
            if (!rows.length) { return; }

            var text = 'Covered in this call:\n' + rows.map(function (r) {
                return '- ' + r.label;
            }).join('\n');

            var $box = $('#call-notes, #me-call-notes, #my-call-notes').first();

            if ($box.length) {
                var existing = $box.val() || '';
                $box.val(existing + (existing && !/\n$/.test(existing) ? '\n' : '') +
                    text + '\n');
                $box.trigger('input');

                UI.toast({ title: 'Added to your notes', tone: 'ok', duration: 1800 });
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(function () { /* optional */ });
            }
        });

        /* COPY IS WHAT MAKES IT A NOTE RATHER THAN A PROMPT.

           Into the notes box for this call FIRST, because that is the copy that
           survives - it is stored, and the clipboard is not. The clipboard write is
           an extra and is allowed to fail silently: it needs a permission on some
           browsers, and a permission prompt in the middle of a live call is worse
           than a missing convenience. */
        $(document).on('click', '[data-act="postit-copy"]', function () {
            var $note = $(this).closest('.postit');

            var parts = [];

            $note.find('.postit-title, .postit-text, .postit-action, .postit-ask')
                .each(function () {
                    var text = $.trim($(this).text());
                    if (text) { parts.push(text); }
                });

            var text = parts.join(' - ');
            if (!text) { return; }

            /* #me-call-notes IS THE CUSTOMER'S BOX. This selector listed
               '#my-call-notes', which nothing renders - js/pages-me.js calls it
               #me-call-notes - so on the customer's side "Copy to my notes" wrote
               into nothing and only the silent clipboard write below did anything.
               All three names are listed rather than one being corrected, because
               the representative's box is #call-notes and both have to work. */
            var $box = $('#call-notes, #me-call-notes, #my-call-notes').first();

            if ($box.length) {
                var existing = $box.val() || '';
                $box.val(existing + (existing && !/\n$/.test(existing) ? '\n' : '') + text + '\n');
                $box.trigger('input');
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(function () { /* see above */ });
            }

            var $btn = $(this);

            $btn.addClass('is-done').html(UI.icon('check', 12) + '<span>Copied</span>');

            window.setTimeout(function () {
                $btn.removeClass('is-done')
                    .html(UI.icon('clipboard', 12) + '<span>Copy to my notes</span>');
            }, 1800);
        });


        /* ---- the dock ---- */

        $(document).on('click', '[data-act="call-dock-return"]', function () {
            /* Straight to the call screen. undockCall() is NOT called here: the
                clock interval notices the stage has come back and moves the video
                home on its next tick, which is the one place that decision lives.
                Doing it here as well would race the router's render. */
            go(STATE.session && STATE.session.role === 'customer' ? '/me/call' : '/fr/call');
        });

        $(document).on('click', '[data-act="call-dock-end"]', function () {
            finish().then(function () {
                docked = false;
                $('#call-dock').remove();

                UI.toast({ title: 'Call ended', tone: 'ok' });
            });
        });

        $(document).on('click', '[data-act="call-dock-mic"]', function () {
            setMic(!micOn);

            $('#call-dock-mic').html(UI.icon(micOn ? 'mic' : 'micOff', 15));

            UI.toast({
                title: micOn ? 'Microphone on' : 'Microphone muted',
                tone: 'info', duration: 1400
            });
        });

        $(document).on('click', '[data-act="call-mic"]', function () {
            setMic(!micOn);

            UI.toast({
                title: micOn ? 'Microphone on' : 'Microphone muted',
                message: micOn ? '' : 'They cannot hear you.',
                tone: 'info', duration: 1600
            });
        });

        $(document).on('click', '[data-act="call-cam"]', function () {
            setCamera(!camOn);
        });

        /* The captions switch. On by default now, so most of the time this is
           somebody turning it OFF - which is why the off path comes first and
           says so plainly. */
        $(document).on('click', '[data-act="call-cc"]', function () {
            if (listening) {
                stopTranscribe();

                UI.toast({
                    title: 'Live captions off',
                    message: 'No more transcript or plain-English explanations.',
                    tone: 'info', duration: 2200
                });
                return;
            }

            startTranscribe(false);

            if (!listening) { return; }   // startTranscribe explained why not

            UI.toast({
                title: 'Live captions on',
                message: 'Tap the caption bar to read everything said so far.',
                tone: 'info', duration: 2600
            });
        });

        // Expand or collapse the transcript under the captions
        $(document).on('click', '[data-act="call-log"]', function () {
            toggleLog();
        });

        /* ---- the co-pilot triggers ----

           The old copilot-dismiss handler has gone: closing is postIt's Close
           button now, and it works the same way for every note on the stage rather
           than only for these. copilotSeen still remembers the trigger, so closing
           a note does not invite it straight back on the next sentence. */

        $(document).on('click', '[data-act="copilot-push"]', function () {
            pushProduct($(this).data('id'), $(this).data('name'));
            $(this).addClass('is-sent').html(UI.icon('check', 12) + '<span>Sent</span>');
        });


        /* ---- the policy snapshot drawer ---- */

        /* The explicit "let the sound through" button. Calling play() from inside
           a click handler is what satisfies the autoplay policy - the same call
           from anywhere else is refused. */
        $(document).on('click', '[data-act="call-unmute-remote"]', function (e) {
            e.stopPropagation();

            var v = document.getElementById('peer-cam');
            if (!v) { return; }

            v.muted = false;

            v.play().then(
                function () {
                    $('#audio-unblock').remove();
                    UI.toast({ title: 'Sound on', tone: 'ok', duration: 1600 });
                },
                function () {
                    UI.toast({
                        title: 'Still blocked',
                        message: 'Check the site is not muted in the address bar.',
                        tone: 'warn'
                    });
                }
            );
        });

        $(document).on('click', '[data-act="pin-toggle-drawer"]', function () {
            drawerOpen = !drawerOpen;
            $('#pin-drawer').toggleClass('is-open', drawerOpen);
        });

        $(document).on('click', '[data-act="pin-remove"]', function (e) {
            e.stopPropagation();
            togglePin(String($(this).data('id')));
        });

        // The representative's picker, opened from the call controls
        $(document).on('click', '[data-act="pin-open"]', function () {
            openPinPicker();
        });

        $(document).on('click', '[data-act="pin-pick"]', function () {
            togglePin(String($(this).data('id')));
            openPinPicker();          // redraw so the ticks update in place
        });

        /* Copy what was said into the notes box. The transcript no longer appears
           in the notes panel, so this is the bridge between the two - and it goes
           into whichever notes box this page has. */
        $(document).on('click', '[data-act="call-copy-log"]', function (e) {
            e.stopPropagation();   // the bar behind this would toggle the log

            var text = transcriptText();

            if (!text) {
                UI.toast({ title: 'Nothing said yet', tone: 'info', duration: 1600 });
                return;
            }

            /* Two possible boxes, one per call screen. Whichever exists is the
               one this person is looking at. */
            var $box = $('#call-notes').length ? $('#call-notes') : $('#me-call-notes');

            if (!$box.length) {
                UI.toast({ title: 'Open the Notes tab first', tone: 'info' });
                return;
            }

            var existing = $.trim($box.val());

            $box.val(existing ? existing + '\n\n' + text : text).trigger('input');

            UI.toast({ title: 'Added to your notes', tone: 'ok' });
        });

        /* call-nudge-hide has gone with the fixed explanation bar it closed. The
           post-it's own Close button does the same job for every note. */

        $(document).on('click', '[data-act="call-panel"]', function () {
            togglePanel();
        });

        $(document).on('click', '[data-act="call-share"]', function () {
            UI.toast({
                title: 'Screen sharing',
                message: 'Not built yet. The camera and microphone are live, though.',
                tone: 'info'
            });
        });
    });


    /* ====================================================================== */
    return {
        // markup
        stage: stage,
        rail: rail,
        control: control,
        micButton: micButton,
        camButton: camButton,
        ccButton: ccButton,

        /* Representative side only. Adding it to the customer's controls would
           let them pin things for themselves, which is not what the drawer is
           for - it is something presented TO them. */
        pinButton: pinButton,

        /* Draw the call history into a container. Used by both call screens. */
        renderHistory: renderHistory,

        /* Paint the covered-topics log. Exported because the panel it draws into
           lives in a TAB, and UI.tabs only builds the active one - so the screen
           has to ask for it after switching to Notes rather than this file being
           able to draw it once. See the pruwise:tab handler in js/pages-fr.js. */
        renderCovered: renderCovered,

        /* Redraw whatever history container is on the page. Exported so a screen
           that changes the history some other way can ask for a refresh. */
        refreshHistory: refreshHistory,
        shareButton: shareButton,
        panelButton: panelButton,
        endButton: endButton,

        // lifecycle
        begin: begin,
        finish: finish,
        clock: clock,
        spoken: spoken,

        // panel
        openPanel: openPanel,
        togglePanel: togglePanel,

        // media
        stopCamera: stopCamera,
        note: note,

        // captions and transcript
        speechSupported: speechSupported,
        stopTranscribe: stopTranscribe,
        transcriptHtml: transcriptHtml,
        transcriptText: transcriptText,
        renderTranscript: renderLog,

        /* The room this screen is in, or null.

           Needed after the call has finished, so the summary can be fetched for
           the call that just ended. finish() deliberately does NOT clear `room`
           for exactly this reason - the code is still the only handle on what
           just happened. */
        roomCode: function () { return room ? room.roomCode : null; },

        /* Shut everything down from outside. Used when this tab discovers it has
           lost the session to another one - see showSessionTakenOver() in
           js/app.js. A tab that is no longer the account it thinks it is must stop
           polling a call as somebody else. */
        teardown: teardown,

        /* Handy while developing: CALL.state() in the console tells you what the
           connection thinks it is doing. */
        state: function () {
            return {
                phase: phase, room: room, peerHere: peerHere,
                offerSent: offerSent, remoteReady: remoteReady,
                lines: lines.length, listening: listening
            };
        }
    };
})();
