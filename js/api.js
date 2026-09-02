/* ==========================================================================
   api.js
   --------------------------------------------------------------------------
   THE ONLY FILE THAT TALKS TO THE SERVER.

   Everything else calls API.something() and gets a promise back. Nothing else
   in the project builds a URL or touches $.ajax, so if the API ever moves or
   changes shape, this is the one file to edit.

       API.login({ username: 'x', password: 'y' })
           .then(function (data) { ... it worked ... },
                 function (err)  { ... err.error is a readable message ... });

   WHY TWO FUNCTIONS INSTEAD OF .then().catch()
   Same reason as elsewhere in this project: `catch` is awkward in the older
   parser we lint with, and .then(ok, fail) is exactly equivalent.

   WHAT AN ERROR LOOKS LIKE
   Always the same object, whatever went wrong:

       { error: 'Something a human can read',
         field: 'password',     // optional, names the input at fault
         status: 401,           // 0 means the server could not be reached
         offline: false }

   That means a form only ever needs one error handler. It does not have to
   care whether the failure was a validation problem, a dead database or a
   pulled network cable.
   ========================================================================== */

var API = (function () {

    /* Root-relative, because Vercel serves functions from /api/ regardless of
       where the page itself sits.

       WAS 'php/api/'. The backend moved from PHP on Apache to TypeScript
       functions on Vercel, and Vercel decides what is a function by its path:
       a file at api/login.ts is served at /api/login. There is no php folder
       and no .php extension any more. */
    var BASE = '/api/';

    /* Set to true once a request fails because the server is unreachable, so
       the app can say "the server is not responding" instead of silently
       looking broken. Reset by the next successful call. */
    var offline = false;


    /* ======================================================================
       THE ONE REQUEST FUNCTION
       ====================================================================== */
    function call(method, endpoint, data) {
        var settings = {
            /* THE .php IS STRIPPED HERE, ON PURPOSE, RATHER THAN AT 40 CALL SITES.

               Every method below asks for an endpoint by its old filename -
               'login.php', 'call-sync.php', 'admin/users.php'. Those names appear
               in about forty places and in a dozen explanatory comments.

               Rewriting them all would be forty mechanical edits for no
               behavioural gain, and forty chances to fumble one and produce a 404
               that only shows up when somebody happens to use that screen. One
               regex here renames all of them at once, and it means the call sites
               still read the same as the PHP they document.

               Worth removing eventually, but only in a change that does nothing
               else, so a mistake is obvious. */
            url: BASE + String(endpoint).replace(/\.php$/, ''),
            method: method,
            dataType: 'json',
            timeout: 20000,

            /* Send the session cookie. Same-origin requests do this anyway,
               but being explicit means it still works if the app is ever
               served from a slightly different host name. */
            xhrFields: { withCredentials: true }
        };

        if (method === 'POST') {
            settings.contentType = 'application/json';
            settings.data = JSON.stringify(data || {});
        } else if (data) {
            settings.data = data;
        }

        /* $.Deferred is jQuery's promise. We create our own so we can hand
           back a clean object instead of jQuery's three arguments. */
        var out = $.Deferred();

        $.ajax(settings).then(
            function (payload) {
                offline = false;

                /* The server answers 200 with ok:false for anything it handled
                   but refused. Treat that as a rejection, so success handlers
                   never have to check a flag. */
                if (!payload || payload.ok !== true) {
                    out.reject(normalise(null, payload));
                    return;
                }
                out.resolve(payload);
            },
            function (xhr, textStatus) {
                var err = normalise(xhr, xhr ? xhr.responseJSON : null, textStatus);
                offline = err.offline;
                out.reject(err);
            }
        );

        return out.promise();
    }


    /* Is this response the host's bot-check page rather than anything of ours?

       Matched on the machinery it needs to do its job - the aes.js script it
       pulls in, and the two functions it defines inline - rather than on a
       provider name or a message, which are the parts most likely to be
       reworded. Also required to be small: a real page of ours that happened to
       mention aes.js would not be under 4 KB. */
    function isHostCheck(body) {
        if (typeof body !== 'string' || body.length > 4000) { return false; }

        return body.indexOf('aes.js') !== -1
            || body.indexOf('slowAES') !== -1
            || (body.indexOf('toNumbers') !== -1 && body.indexOf('toHex') !== -1);
    }

    /* Reload, but only once per tab.

       Without the guard this is an infinite loop: reload, get challenged again,
       reload. sessionStorage is the right store - it is per tab and it is
       cleared when the tab closes, so a genuine second occurrence later in the
       day still gets one automatic attempt.

       Deliberately NOT instant. A reload fired during the first second of a page
       load looks like a crash and gives the check no time to have set its
       cookie from the page request that is already in flight. */
    function reloadForHostCheck() {
        try {
            if (window.sessionStorage.getItem('pruwise.hostCheckReload') === '1') { return; }
            window.sessionStorage.setItem('pruwise.hostCheckReload', '1');
        } catch (e) {
            /* Private mode can throw on sessionStorage. Better to skip the
               automatic reload than to risk looping with no way to remember. */
            return;
        }

        if (window.console && console.warn) {
            console.warn('PRUWise: the host answered with a bot-check page instead of JSON. ' +
                'Reloading once so the browser can satisfy it.');
        }

        window.setTimeout(function () { window.location.reload(); }, 1200);
    }


    /* Turns anything that can go wrong into the one error shape.

       The four cases worth telling apart, because the fix is different:
         status 0    nothing answered at all - no server, or no network
         got JSON    the server explained the problem, so use its words
         bot check   the HOST interrupted us; only a full page load fixes it
         got HTML    PHP crashed and printed an error page instead of JSON     */
    function normalise(xhr, payload, textStatus) {
        // The server told us what was wrong. Its message is the best one.
        if (payload && payload.error) {
            return {
                error: payload.error,
                field: payload.field || null,
                status: xhr ? xhr.status : 200,
                offline: false
            };
        }

        var status = xhr ? xhr.status : 0;

        if (status === 0 || textStatus === 'timeout') {
            return {
                error: window.location.protocol === 'file:'
                    ? 'This version needs a web server. Open the site through WAMP at ' +
                      'http://localhost/Prudential_TheGoats/ rather than opening the file directly.'
                    : 'The server is not responding. Check that WAMP is running, then try again.',
                field: null,
                status: 0,
                offline: true
            };
        }

        if (status === 401) {
            return { error: 'Please log in to continue.', field: null, status: 401, offline: false };
        }

        /* A 404 from the API means the router did not recognise the path - so
           either the endpoint name here is wrong, or api/router.ts has no line
           in its ROUTES map for it. Both are our mistake rather than the
           visitor's, so the message names the address instead of asking them to
           check something they cannot see.

           It used to say "check that the php folder was uploaded", which was
           true on the old host and is now impossible: there is no php folder
           and no upload step. */
        if (status === 404) {
            return {
                error: 'That part of the server could not be found. If this keeps ' +
                       'happening the address is wrong - the console has the detail.',
                field: null, status: 404, offline: false
            };
        }

        /* ------------------------------------------------------------------
           THE HOST'S BOT CHECK, WHICH IS NOT OUR BUG BUT IS OUR PROBLEM.

           Free hosting (InfinityFree, and others like it) protects the account
           by answering a request it does not recognise with a small HTML page
           that runs an AES routine in JavaScript, sets a cookie, and reloads.
           A browser doing normal navigation solves it without the visitor
           noticing.

           AN XHR CANNOT. It receives that HTML, does not execute scripts, and
           so can never obtain the cookie. What arrives here is a 200 with an
           HTML body where JSON was asked for - and jQuery, told dataType json,
           reports it as a parse failure. That is why one screen could sit on
           "Loading..." forever while the rest of the site looked fine: the page
           itself had solved the check, and then the cookie expired underneath
           the running app.

           Measured against the live site: 24 of 26 requests came back as this
           page, and the only two that got through were .css files.

           THE ONLY RECOVERY IS A FULL PAGE LOAD, because that is the one thing
           that lets the browser run the check and set the cookie. So say what
           happened and reload - once. See reloadForHostCheck(). */
        if (xhr && xhr.responseText && isHostCheck(xhr.responseText)) {
            reloadForHostCheck();

            return {
                error: 'Your web host interrupted that request with a security check. ' +
                       'Reloading the page clears it.',
                field: null, status: status, offline: false, hostCheck: true
            };
        }

        /* An HTML body where JSON was expected. On Vercel this means the request
           fell through the /api rewrite and was answered with index.html, which
           is what a mistyped endpoint or a deployment with no functions looks
           like. The response is worth logging in full and is not fit to show a
           stranger, so we log it and say something plainer.

           The old wording pointed at php/error-log/php-errors.log. There is no
           such file now; the equivalent is the function log in the Vercel
           dashboard, which is where console.error on the server ends up. */
        if (xhr && xhr.responseText && xhr.responseText.indexOf('<') === 0) {
            console.error('PRUWise API returned HTML instead of JSON:\n' + xhr.responseText);

            return {
                error: 'The server hit an error. The details are in the browser ' +
                       'console, and in the function log on the server.',
                field: null, status: status, offline: false
            };
        }

        return {
            error: 'Something went wrong (' + status + '). Please try again.',
            field: null, status: status, offline: false
        };
    }


    /* ======================================================================
       SENDING A FILE AS THE WHOLE REQUEST BODY

       Shared by API.upload (a chat attachment) and API.documents.add (a filed
       document), because they are the same request to two endpoints and the
       forty lines of XHR wiring below should exist once.

       This cannot go through call() because a file is not JSON.

       ----------------------------------------------------------------------
       THE FILE IS THE WHOLE BODY. IT USED TO BE A MULTIPART FIELD.
       ----------------------------------------------------------------------

       The old version built a FormData and let the browser produce a
       multipart/form-data request, because that is what PHP parses for free.
       The serverless functions this now talks to do not: they handle JSON and
       form-urlencoded and hand anything else over as raw bytes. Adding a
       multipart parser on the server to decode a single field, when the
       request only ever carries one file, would be a dependency and a class
       of bug in exchange for nothing.

       So the bytes are the body, and the two things multipart was carrying
       alongside them - the filename and the type - go in the query string.
       Both are only ever claims; the server checks the type against the
       actual leading bytes and never lets the name near a path.

       processData: false stops jQuery turning the File into a query string.
       contentType is set explicitly rather than false, because false makes
       jQuery send no Content-Type at all and the type is the one hint worth
       passing on.

       onProgress is optional and receives a whole number 0-100. It reads the
       XHR's own upload events, which do not care what shape the body is.
       ====================================================================== */
    function rawUpload(endpoint, file, onProgress, extra) {
        var out = $.Deferred();

        var query = '?name=' + encodeURIComponent(file.name || 'file') +
                    '&type=' + encodeURIComponent(file.type || '');

        /* Anything else the endpoint wants, appended in the same place. Values
           are encoded here so no caller has to remember to. */
        if (extra) {
            for (var key in extra) {
                if (!Object.prototype.hasOwnProperty.call(extra, key)) { continue; }
                if (extra[key] === null || extra[key] === undefined || extra[key] === '') { continue; }

                query += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(extra[key]);
            }
        }

        $.ajax({
            url: BASE + endpoint + query,
            method: 'POST',
            data: file,
            processData: false,
            contentType: file.type || 'application/octet-stream',
            dataType: 'json',
            timeout: 120000,          // a big attachment on a slow line
            xhrFields: { withCredentials: true },

            // Hook into the raw XHR to watch the bytes go up
            xhr: function () {
                var xhr = $.ajaxSettings.xhr();

                if (onProgress && xhr.upload) {
                    xhr.upload.addEventListener('progress', function (e) {
                        if (e.lengthComputable) {
                            onProgress(Math.round((e.loaded / e.total) * 100));
                        }
                    });
                }
                return xhr;
            }
        }).then(
            function (payload) {
                if (!payload || payload.ok !== true) { out.reject(normalise(null, payload)); return; }
                out.resolve(payload);
            },
            function (xhr, textStatus) {
                out.reject(normalise(xhr, xhr ? xhr.responseJSON : null, textStatus));
            }
        );

        return out.promise();
    }


    /* ======================================================================
       NAMED CALLS

       One per endpoint. They exist so the pages read as English and so the
       endpoint filenames appear exactly once each.
       ====================================================================== */

    return {
        base: BASE,

        isOffline: function () { return offline; },

        post: function (endpoint, data) { return call('POST', endpoint, data); },
        get:  function (endpoint, data) { return call('GET', endpoint, data); },

        /* ---- who am I ---- */
        session: function () {
            return call('GET', 'session.php');
        },

        /* ---- getting in ---- */
        login: function (username, password) {
            return call('POST', 'login.php', { username: username, password: password });
        },

        register: function (details) {
            return call('POST', 'register.php', details);
        },

        /* Sign in with Google.

           `credential` is the ID token Google's own button hands us. It is NOT a
           password and NOT a session - it is a signed statement of identity, and
           every bit of the checking happens in php/api/google-login.php, which
           verifies Google's signature before believing anything inside it.

           Sending it here rather than trusting it in the browser is the whole
           point: a token can be read by anybody, so only the signature check
           makes it mean anything. */
        googleLogin: function (credential) {
            return call('POST', 'google-login.php', { credential: credential });
        },

        logout: function (everywhere) {
            return call('POST', 'logout.php', { everywhere: everywhere === true });
        },

        /* ---- forgotten passwords ---- */
        forgotPassword: function (email) {
            return call('POST', 'forgot-password.php', { email: email });
        },

        // Is this reset link still usable? Called when the reset page opens.
        checkResetToken: function (token) {
            return call('POST', 'reset-password.php', { token: token, check: true });
        },

        resetPassword: function (token, password) {
            return call('POST', 'reset-password.php', { token: token, password: password });
        },

        /* ---- account settings ---- */
        changePassword: function (currentPassword, newPassword, signOutEverywhere) {
            return call('POST', 'change-password.php', {
                currentPassword: currentPassword,
                newPassword: newPassword,
                signOutEverywhere: signOutEverywhere !== false
            });
        },

        /* Only send the fields that changed. See php/api/update-profile.php -
           anything absent is left alone. */
        updateProfile: function (changes) {
            return call('POST', 'update-profile.php', changes);
        },

        confirmEmail: function (token) {
            return call('POST', 'confirm-email.php', { token: token });
        },

        resendConfirmation: function () {
            return call('POST', 'resend-confirmation.php', {});
        },

        /* Close the account permanently.

           Needs the password (unless it is a Google-only account, which has
           none) and the literal word DELETE typed out. Both checks are enforced
           in php/api/delete-account.php - this only carries them across. */
        deleteAccount: function (password, confirm) {
            return call('POST', 'delete-account.php', {
                password: password || '', confirm: confirm || ''
            });
        },

        /* ==================================================================
           MESSAGES

           A "spec" says WHICH conversation you mean, and there are three ways
           to say it. Every message endpoint accepts the same three, so you
           never have to look up a thread id before you can talk to somebody:

               { threadId: 12 }          one you already have open
               { kind: 'ai' }            my PRUWise conversation
               { withPerson: 'cus-001' } my conversation with that person

           The server creates the conversation on first use, so the second and
           third forms work even when nothing has ever been sent.
           ================================================================== */

        // Every conversation down the left of the Messages screen
        threads: function () {
            return call('GET', 'threads.php');
        },

        /* One conversation. Pass sinceId to ask only for what is newer than
           the last message you have - that is what the poller does, and it is
           why an idle chat costs almost nothing.

           Loading without sinceId also marks the other side's messages as
           read. Polling deliberately does not, so a tab left open in the
           background cannot quietly clear somebody's unread badge. */
        thread: function (spec, sinceId) {
            var query = {};

            for (var key in (spec || {})) {
                if (spec[key]) { query[key] = spec[key]; }
            }
            if (sinceId) { query.since = sinceId; }

            return call('GET', 'thread.php', query);
        },

        /* Send one message.

           clientRef is a random id the browser makes up BEFORE sending. If the
           connection drops and we retry, the server recognises the id and
           returns the original message instead of posting a second copy. */
        sendMessage: function (spec, text, attachmentIds, clientRef) {
            var data = { text: text || '', attachmentIds: attachmentIds || [], clientRef: clientRef || '' };

            for (var key in (spec || {})) {
                if (spec[key]) { data[key] = spec[key]; }
            }
            return call('POST', 'send-message.php', data);
        },

        /* Change or withdraw something you already said.

           YOUR OWN MESSAGE ONLY, and the server decides that from the row rather
           than from anything sent here - being in a conversation lets you read what
           the other person said and nothing more. Deleting leaves a tombstone both
           sides can see rather than removing the row, because the other person
           already read it. See api/_routes/message.ts. */
        editMessage: function (id, body) {
            return call('POST', 'message', { id: id, action: 'edit', body: body });
        },

        deleteMessage: function (id) {
            return call('POST', 'message', { id: id, action: 'delete' });
        },

        /* The bell. Every notification carries a link to the screen where the thing
           can be dealt with - see api/_lib/notify.ts. */
        notifications: {
            list: function (limit) {
                return call('GET', 'notifications', limit ? { limit: limit } : {});
            },

            read: function (id) {
                return call('POST', 'notifications', { id: id });
            },

            readAll: function () {
                return call('POST', 'notifications', { all: true });
            }
        },

        /* Save a PRUWise answer into my own PRUWise conversation.

           The answer is worked out in the browser by AI.reply() and stored
           afterwards, which is why the content comes from this side. It is safe
           because this endpoint can only ever write into the caller's own
           private thread - there is no thread id in the request and no way to
           name one. See php/api/store-ai-message.php for the full reasoning. */
        storeAiMessage: function (payload, clientRef) {
            return call('POST', 'store-ai-message.php', {
                payload: payload, clientRef: clientRef || ''
            });
        },

        /* Upload one file and get an attachment id back. See rawUpload above
           for why the file is the entire request body.

           threadId is optional. Passing it means the file is going into that
           conversation, and the server READS IT: the text is extracted, a
           neutral description is stored, and the reply comes back with a
           `document` for the chat to show a "PRUWise read this" note from.
           Passing nothing keeps the old behaviour exactly - just an
           attachment.

           A file with no text in it, an image most often, still uploads
           normally and simply comes back with document: null. */
        upload: function (file, onProgress, threadId) {
            return rawUpload('upload', file, onProgress, { thread: threadId || '' });
        },

        /* ==================================================================
           RELEASED RECOMMENDATIONS

           A recommendation is not advice until a representative decides it is.
           The shortlist is computed; only what a representative RELEASES
           reaches the customer. See api/_routes/recommendations.ts.

           A customer calling release() gets 403 - the rule is enforced on the
           server, not by hiding the button.
           ================================================================== */
        recommendations: {

            // What has been released. personId only matters for a representative.
            released: function (personId) {
                return call('GET', 'recommendations', personId ? { person: personId } : {});
            },

            /* Release one to a customer. `note` is REQUIRED and must be a real
               sentence - the server refuses anything under 15 characters,
               because a one-click release would make this a rubber stamp on
               generated text. */
            release: function (personId, rec, note) {
                return call('POST', 'recommendations', {
                    person: personId,
                    recId: rec.id,
                    productId: rec.product ? rec.product.id : '',
                    productName: rec.product ? rec.product.name : '',
                    note: note || '',
                    action: 'release'
                });
            },

            // Take one back. Recorded as a withdrawal, not deleted.
            withdraw: function (personId, recId) {
                return call('POST', 'recommendations', {
                    person: personId, recId: recId, action: 'withdraw'
                });
            }
        },

        /* ==================================================================
           WHAT PRUWISE NOTICED IN A CONVERSATION

           Detail changes, support signals, follow-ups and a meeting somebody
           wants - read out of a chat, a call transcript or an in-person
           meeting.

           PROPOSALS ONLY. analyse() writes rows with status 'open' and changes
           nothing else; a proposed change to somebody's record reaches it only
           when a representative confirms. See api/_routes/insights.ts for why
           that is not negotiable (speech recognition mishears numbers, and a
           silently rewritten income flows into every recommendation).
           ================================================================== */
        insights: {

            /* personId only matters for a representative. status defaults to
               'open' on the server; pass 'all' for the history. */
            list: function (personId, status) {
                var query = {};
                if (personId) { query.person = personId; }
                if (status) { query.status = status; }

                return call('GET', 'insights', query);
            },

            /* Read a conversation. `text` is the transcript or the recent
               messages; the server gates on relevance first, so calling this
               after small talk costs nothing and writes nothing. */
            analyse: function (personId, source, text, where) {
                var w = where || {};

                return call('POST', 'insights', {
                    person: personId,
                    source: source,
                    text: String(text || '').slice(-8000),
                    threadId: w.threadId || null,
                    roomCode: w.roomCode || null
                });
            },

            /* confirm applies a detail change to the record. dismiss says it was
               wrong. done marks a follow-up handled without changing anything. */
            decide: function (id, action) {
                return call('POST', 'insights', { id: id, action: action });
            }
        },

        /* ==================================================================
           DOCUMENTS - files the assistant has read

           Separate from attachments on purpose: an attachment belongs to one
           message, a document belongs to a PERSON and stays re-readable. See
           the header of api/_lib/documents.ts.

           personId is optional and only meaningful for a representative
           reading their own customer's shelf. The server checks it rather
           than trusting it, so passing somebody else's is a 404 and not a
           leak.
           ================================================================== */
        documents: {

            list: function (personId) {
                return call('GET', 'documents', personId ? { person: personId } : {});
            },

            /* Add one. onProgress is the same 0-100 callback as API.upload.

               kind is optional - left off, the server classifies the file by
               keyword rules. */
            add: function (file, onProgress, options) {
                var o = options || {};

                return rawUpload('documents', file, onProgress, {
                    person: o.personId || '',
                    kind: o.kind || ''
                });
            },

            /* One document including the extracted text, which the list
               deliberately leaves out. */
            get: function (id) {
                return call('GET', 'document', { id: id });
            },

            /* Describe it again. Worth offering because the first attempt can
               fail for reasons that stop being true - a spent hourly
               allowance, or a key configured after the file was added. */
            reread: function (id) {
                return call('POST', 'document', { id: id, act: 'reread' });
            },

            /* Correct what kind of document it is. The keyword rules get it
               wrong sometimes and the person looking at it knows better. */
            setKind: function (id, kind) {
                return call('POST', 'document', { id: id, act: 'kind', kind: kind });
            },

            /* Only the person it belongs to can remove one. A representative
               can read a customer's document and cannot destroy it. */
            remove: function (id) {
                return call('DELETE', 'document', { id: id });
            }
        },

        /* Three replies somebody might send next, for the strip above the
           message box.

           WRITES NOTHING. It reads the last few lines of a conversation the
           caller is already in and hands back wording; tapping one fills the
           input box and a person still presses send. See the header of
           api/_routes/suggest-reply.ts for why that boundary is not negotiable.

           Answers with the built-in wording and source:'rules' when no model is
           configured or the hourly allowance is spent, so the caller never has
           to handle "no suggestions" as a special case. */
        /* `previous` is what is on screen right now, and it is what makes the
           Refresh button do something. Without it a re-ask is byte-identical to the
           request that produced what the person is looking at, so the server has no
           way to know it is being asked again - and both the model and the fixed
           fallback answered the same way. See the note at the top of
           api/_routes/suggest-reply.ts. */
        suggestReply: function (threadId, previous) {
            return call('POST', 'suggest-reply', {
                threadId: threadId,
                previous: Array.isArray(previous) ? previous.slice(0, 12) : []
            });
        },

        /* ==================================================================
           APPOINTMENTS AND THE CALENDAR

           A note on times: everything crossing this boundary is an ISO 8601
           string with an offset, e.g. '2026-03-15T14:00:00+00:00'. The server
           stores UTC and the browser formats it for whoever is looking.

           Never send a bare '2026-03-15 14:00'. Whose 2pm? The answer changes
           when the clocks move, and neither side can tell afterwards.
           ================================================================== */

        /* Everything between two dates, for a month grid.
           from/to are plain 'YYYY-MM-DD'. Both days are included. */
        appointments: function (from, to) {
            return call('GET', 'appointments.php', { from: from, to: to });
        },

        // "What is next" - for a dashboard, which has no grid to fill
        upcomingAppointments: function (howMany) {
            return call('GET', 'appointments.php', { upcoming: howMany || 5 });
        },

        // One appointment, with its "add to Google Calendar" and .ics links
        appointment: function (id) {
            return call('GET', 'appointment.php', { id: id });
        },

        /* Book one.
           details: { withPerson, title, mode, start, minutes, location, agenda, notes }

           withPerson is ignored for a customer - they have one representative and
           the server reads it off their own record. It always comes back as
           'pending', because the OTHER person is the one who confirms. */
        bookAppointment: function (details) {
            var data = { action: 'create' };

            for (var key in (details || {})) { data[key] = details[key]; }
            return call('POST', 'appointment.php', data);
        },

        /* action is one of: reschedule, confirm, cancel, complete, reopen.
           reschedule also needs { start, minutes }. */
        appointmentAction: function (id, action, extra) {
            var data = { action: action, id: id };

            for (var key in (extra || {})) { data[key] = extra[key]; }
            return call('POST', 'appointment.php', data);
        },

        /* Issue a new calendar feed address, which stops every copy of the old
           one working. The only way to undo having shared it by accident. */
        regenerateCalendarFeed: function () {
            return call('POST', 'appointment.php', { action: 'regenerate-feed' });
        },

        /* ==================================================================
           THE ASSESSMENT AND CHOOSING A REPRESENTATIVE

           THESE SIX WERE MISSING ENTIRELY, and it is worth recording what that
           actually looked like, because none of it looked like a missing
           function.

           js/pages-onboarding.js and js/pages-me.js have always called
           API.getAssessment(), API.submitAssessment() and the rest. api.js never
           defined them. So every one of those calls was reading `undefined` and
           then trying to invoke it, which throws TypeError immediately -
           synchronously, before any request was made.

           A throw inside a page's after() hook aborts the hook. Whatever that
           hook was going to fill in never gets filled in. Which is why:

             - the customer dashboard sat on "Checking your account..." forever;
               drawNewCustomerHome() is called from the .then() of a request that
               was never made
             - the questionnaire sat on "Loading your assessment..." forever, for
               the same reason
             - signing in appeared to need a page reload. finishSignIn() calls
               ONBOARDING.loadState() BEFORE it calls router(), so the throw
               happened before the new screen was ever drawn. The session was
               real and saved - hence pressing reload "fixed" it.

           Every symptom was a spinner or a dead screen, so it read as slowness
           or as a hosting problem. It was neither: it was six absent functions.

           The shapes below follow php/api/assessment.php,
           php/api/consultation.php and php/api/representatives.php exactly.
           ================================================================== */

        /* Everything the questionnaire and the customer dashboard need, in one
           request: the questions, the saved assessment (or null), the recent
           consultation requests, and whether the welcome screen has been seen.

           The requests are bundled by the server on purpose - see the note in
           php/api/assessment.php. Two round trips on the slowest screen in the
           app was the thing worth avoiding. */
        getAssessment: function () {
            return call('GET', 'assessment.php');
        },

        /* Score and store the answers.

           `answers` is a flat map of question id to chosen value, e.g.
           { goal: 'protection', age: '25to34', ... }. The server validates every
           value against its own option list and refuses anything else, so this
           does not need to check first - and should not, because a check here
           could be skipped.

           Comes back with the assessment AND the matched representatives, since
           the results screen shows both. */
        submitAssessment: function (answers) {
            return call('POST', 'assessment.php', { answers: answers || {} });
        },

        /* "Skip for now" on the welcome screen. Only stops the full-screen
           greeting returning - it records no refusal, and the dashboard still
           offers the assessment quietly afterwards. */
        dismissOnboarding: function () {
            return call('POST', 'assessment.php', { action: 'dismiss' });
        },

        /* The representatives to choose from, best fit first.

           Matched against the caller's own saved assessment when they have one,
           so there is no profile to pass - the server already has it. Always
           filtered by who is actually accepting new customers and who is under
           their limit, which is a rule in match_reps() rather than a badge on
           the card. */
        getRepresentatives: function () {
            return call('GET', 'representatives.php');
        },

        /* Ask a representative to take you on.

           A REQUEST, NOT AN ASSIGNMENT. Nothing about the account changes until
           they accept - see the header of php/api/consultation.php. One pending
           request at a time, enforced server-side. */
        requestConsultation: function (repId, note) {
            return call('POST', 'consultation.php', {
                action: 'request',
                repId: repId,
                note: note || ''
            });
        },

        /* Resolve one, from either side.

           action is 'withdraw' for the customer, or 'accept' / 'decline' for the
           representative it was sent to. A decline needs a reason, which the
           customer is shown - a silent no is the most frustrating outcome there
           is, so the server requires at least ten characters.

             API.resolveConsultation(4, 'withdraw')
             API.resolveConsultation(4, 'decline', { reason: '...' })            */
        resolveConsultation: function (id, action, extra) {
            var data = { action: action, id: id };

            for (var key in (extra || {})) { data[key] = extra[key]; }
            return call('POST', 'consultation.php', data);
        },

        /* The full list, which is what the representative's dashboard wants.
           The customer gets a short version bundled with getAssessment(). */
        consultations: function () {
            return call('GET', 'consultation.php');
        },


        /* ==================================================================
           THE CUSTOMER'S OWN FINANCIAL RECORD

           Income, savings, CPF, mortgage, what they can afford. Entered by the
           customer in Settings, read by their representative, and the basis of
           the protection needs calculation.

           THE CALCULATION IS NOT DONE HERE. finances_needs() in
           php/lib/finances.php returns it alongside the figures, because the
           customer's dashboard and the representative's view of that customer
           must never show different numbers for the same person. One function,
           on the server, called by both.
           ================================================================== */

        /* My own record, with the needs analysis on it.

           Comes back as { finances, needs, hasAny, editable, whose }. `needs` is
           null when there is not enough to calculate from - which is honest, and
           better than a confident zero. */
        getFinances: function () {
            return call('GET', 'finances.php');
        },

        /* Save some of it. ONLY THE FIELDS YOU PASS ARE TOUCHED - a form that
           sends three values will not blank the other eleven. Pass an empty
           string to clear one, which is different from omitting it. */
        saveFinances: function (changes) {
            return call('POST', 'finances.php', { finances: changes || {} });
        },

        /* A representative reading one of their own customers' figures.

           Read-only by design: these are the customer's own numbers, and a
           record the representative could edit would stop being a statement of
           what the customer actually said. Somebody else's customer returns 404
           rather than 403, so "not yours" and "not real" look the same. */
        customerFinances: function (personId) {
            return call('GET', 'finances.php', { personId: personId });
        },


        /* ==================================================================
           POLICIES AND APPLICATIONS

           The one part of the app that creates cover.

           A customer APPLIES; the representative the application was sent to
           ISSUES it. Nothing else can - see the header of php/api/policies.php
           for why a licensed human makes that decision rather than a button.

           An application is not a policy. Until it is issued there is no cover,
           and every screen says so in those words.
           ================================================================== */

        /* What I hold, and what I have asked for.

           Comes back as { policies, applications, canApply, whose }. `policies`
           are real rows from the database, already shaped exactly like the
           fixtures in js/data.js so UI.policyCard() renders either without
           knowing the difference.

           canApply is false when the customer has no representative yet, because
           there would be nobody to decide the application. */
        /* personId is for a REPRESENTATIVE reading one of their own clients'
           plans - the call panel does this so "what have I already got" can be
           answered without leaving the conversation. It is CHECKED, not trusted:
           /api/policies 404s a customer who is not assigned to the caller, and
           ignores the parameter entirely for a customer, who always means
           themselves. Left off, it means "mine". */
        getPolicies: function (personId) {
            return call('GET', 'policies.php', personId ? { personId: personId } : {});
        },

        /* Apply for a plan.

           productId must be one of the seven in the catalogue; the server checks
           it against assessment_products() and refuses anything else, so a
           mistyped id fails loudly rather than creating a policy for a product
           that does not exist.

             API.applyForPolicy('prd-active', {
                 cover: 300000, ciCover: 100000, premium: 118, termYears: 25,
                 note: 'Happy to go ahead'
             })

           One open application per product, enforced server-side, so a double
           tap cannot produce two.                                             */
        applyForPolicy: function (productId, terms) {
            var data = { action: 'apply', productId: productId };

            for (var key in (terms || {})) { data[key] = terms[key]; }
            return call('POST', 'policies.php', data);
        },

        /* Resolve an application.

           action is 'withdraw' for the customer, or 'review' / 'issue' /
           'decline' for the representative it was sent to.

           A decline needs a reason of at least ten characters, which the customer
           reads. An issue may carry revised terms - the premium usually moves
           once the figures have been looked at properly - and anything not passed
           is taken from what was applied for.

             API.resolvePolicyApplication(4, 'withdraw')
             API.resolvePolicyApplication(4, 'issue', { premium: 132 })
             API.resolvePolicyApplication(4, 'decline', { reason: '...' })      */
        resolvePolicyApplication: function (id, action, extra) {
            var data = { action: action, id: id };

            for (var key in (extra || {})) { data[key] = extra[key]; }
            return call('POST', 'policies.php', data);
        },

        /* The representative's queue: every application sent to them, undecided
           first and oldest-first within that, because the one that has been
           waiting longest is the one most likely to need attention. */
        policyQueue: function () {
            return call('GET', 'policies.php');
        },

        /* A representative reading one of their own customers' policies and
           applications. Somebody else's customer returns 404 rather than 403, so
           "not yours" and "not real" look the same. */
        customerPolicies: function (personId) {
            return call('GET', 'policies.php', { personId: personId });
        },


        /* ==================================================================
           VIDEO CALLS

           Three calls, and only three. Everything else about a call - the
           audio, the video, the connection itself - happens directly between
           the two browsers and never comes near the server.

               callJoin  once, when the call screen opens
               callSync  about once a second, for as long as the call lasts
               callEnd   once, when somebody hangs up
           ================================================================== */

        /* "Put me in the call with this person."

           withPerson is IGNORED for a customer: they have one representative
           and the server reads it off their own record, so there is nothing to
           choose. A representative must name a customer who is actually theirs.

           Returns the room code, which role you are, whether you are the side
           that makes the offer, and the ICE servers to use. */
        callJoin: function (withPerson, appointmentId) {
            return call('POST', 'call-join.php', {
                withPerson: withPerson || '',
                appointmentId: appointmentId || ''
            });
        },

        /* The call loop. One request carries four jobs, because they all happen
           at the same rate and splitting them would mean four requests a second
           instead of one:

             - says "I am still here", which is how the other side knows to
               start connecting, and how it notices a closed laptop
             - posts our outgoing WebRTC signalling
             - collects theirs
             - posts what we just said and collects the shared transcript

           signals: [{ kind: 'offer'|'answer'|'candidate', payload: '...' }]
           lines:   [{ who: 'person'|'pruwise', text: '...', ref: '...' }]
           sinceLine: the highest transcript id we already hold             */
        callSync: function (roomCode, signals, lines, sinceLine) {
            return call('POST', 'call-sync.php', {
                roomCode: roomCode,
                signals: signals || [],
                lines: lines || [],
                sinceLine: sinceLine || 0
            });
        },

        /* Hang up. Either side may do it - a customer is not stuck on a call
           because the representative has not pressed the button.

           The duration comes back from the server rather than from our own
           clock, because our clock has been running since the page opened,
           which is not the same as the time the two of them were connected. */
        callEnd: function (roomCode) {
            return call('POST', 'call-end.php', { roomCode: roomCode });
        },

        /* "Is somebody trying to call me right now?"

           Polled from anywhere in the app, not just the call screen - that is
           the whole point. A call is the one urgent thing in PRUWise, and the
           person who needs to know is by definition not looking at the screen
           that knows. See php/api/call-ring.php for how "ringing" is derived
           from the presence heartbeats rather than stored as a flag. */
        callRinging: function () {
            return call('GET', 'call-ring.php');
        },

        /* The call history for whichever side is asking. A call that never
           connected comes back as "No answer" rather than 0:00, because those are
           different facts. See php/api/calls.php. */
        callHistory: function (howMany) {
            return call('GET', 'calls.php', { limit: howMany || 20 });
        },

        /* The representative's co-pilot. Sends the sentence the CUSTOMER just
           said and gets back action cards when it contains a life event that
           changes their financial position.

           Representative only, and only for a call they are actually on - both
           checked in php/api/call-copilot.php. The customer never sees these. */
        callCopilot: function (roomCode, text, includeChat) {

            /* `includeChat` asks the server to ALSO scan the client's earlier
               messages in this conversation, returning those hits separately as
               `fromChat`. Sent on the FIRST request of a call and not again: the
               answer cannot change while the call is running, and reading a whole
               thread once per spoken sentence would be a database round trip per
               sentence. See the long note in api/_routes/call-copilot.ts. */
            var body = { roomCode: roomCode, text: text };

            if (includeChat) { body.includeChat = true; }

            return call('POST', 'call-copilot.php', body);
        },

        /* The after-call write-up.

           callSummary() reads the transcript and hands back a DRAFT - what was
           discussed, what the customer asked, and the next steps. Nothing is
           sent by it.

           sendCallSummary() is the approval. It takes the body as the
           representative edited it, posts it into the shared conversation as an
           ordinary message, and saves it to their own call notes.

           Two calls rather than one on purpose: a message written in a
           representative's name about somebody's policies is theirs to approve,
           and the draft only saves them the typing. See the long note at the top
           of php/api/call-summary.php. */
        callSummary: function (roomCode) {
            return call('GET', 'call-summary.php', { roomCode: roomCode });
        },

        sendCallSummary: function (roomCode, body) {
            return call('POST', 'call-summary.php', { roomCode: roomCode, body: body });
        },

        /* ==================================================================
           ADMIN

           Every one of these is refused with a 403 unless the session belongs
           to an admin. That check lives in PHP (require_admin), not here - the
           browser hiding a button is a convenience, not a control.
           ================================================================== */
        admin: {
            // filters: { q, role, status, sort, page, perPage }
            users: function (filters) {
                return call('GET', 'admin/users.php', filters || {});
            },

            user: function (accountId) {
                return call('GET', 'admin/user.php', { id: accountId });
            },

            /* action is one of: suspend, activate, signout, verify-email,
               send-reset, reassign-rep, delete. See php/api/admin/user.php. */
            act: function (accountId, action, extra) {
                var data = { id: accountId, action: action };

                for (var key in (extra || {})) { data[key] = extra[key]; }
                return call('POST', 'admin/user.php', data);
            },

            createUser: function (details) {
                return call('POST', 'admin/create-user.php', details);
            },

            requests: function (status) {
                return call('GET', 'admin/requests.php', { status: status || 'open' });
            },

            resolveRequest: function (id, action, extra) {
                var data = { id: id, action: action };

                for (var key in (extra || {})) { data[key] = extra[key]; }
                return call('POST', 'admin/requests.php', data);
            },

            audit: function (filters) {
                return call('GET', 'admin/audit.php', filters || {});
            }
        }
    };
})();
