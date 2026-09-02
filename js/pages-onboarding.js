/* ==========================================================================
   pages-onboarding.js
   --------------------------------------------------------------------------
   The new-customer onboarding flow:

     /onboarding/welcome        "Hi Alex!" â€” start or skip
     /onboarding/assessment     10-question Financial Needs Assessment
     /onboarding/results        profile + policy recommendations
     /onboarding/matching       choose a representative
     /onboarding/confirm        summary + send the request
     /onboarding/skipped        the "skip for now" landing
     /onboarding/done           request sent, all finished

   Loaded after pages-me.js so the PAGES object already exists.
   ========================================================================== */

var ONBOARDING = (function () {

    /* Shared state for the flow. Temporary - cleared when the flow finishes. */
    var state = {
        questions: null,
        answers: {},
        currentStep: 0,
        assessment: null,
        requests: [],
        finances: null,
        needs: null,
        reps: null,
        selectedRep: null
    };

    /* Take everything useful out of an api/assessment.php response.

       ONE PLACE, because there are three callers - the results page, the matching
       page and loadState() - and every one of them wants the same fields. As three
       copies they drifted: `requests` was absorbed in all three, and when
       `finances` and `needs` were added to the endpoint they would have had to be
       added three more times, with the one that got forgotten failing silently
       months later. That is the same shape as the six API methods that were never
       written.

       Each field is only overwritten when the response actually carries it, so a
       partial response cannot blank something we already had. */
    function absorbAssessment(d) {
        if (!d) { return; }

        if (d.questions && d.questions.length) {
            state.questions = d.questions;
            cacheQuestions(d.questions);
        }
        if (d.assessment) { state.assessment = d.assessment; }
        if (d.requests) { state.requests = d.requests; }

        /* Not guarded by a truthiness check: null is a real answer here. It means
           "this person has not filled in their figures", and treating it as
           "no news" would leave a stale calculation on screen after somebody
           cleared their record. */
        if (Object.prototype.hasOwnProperty.call(d, 'finances')) { state.finances = d.finances; }
        if (Object.prototype.hasOwnProperty.call(d, 'needs')) { state.needs = d.needs; }
    }


    /* ======================================================================
       CACHING THE QUESTIONS

       The seven questions never change between requests. Fetching them every
       time meant the questionnaire opened on a spinner - which on shared hosting
       is most of a second of somebody staring at nothing, immediately after they
       pressed a button labelled "Start Assessment".

       So they are kept in localStorage and read back SYNCHRONOUSLY, before the
       first render. The screen appears instantly; a fresh copy is fetched in the
       background and replaces the cache for next time.

       WHY THIS IS SAFE TO CACHE AND THE ANSWERS ARE NOT: the questions are the
       same for everybody and contain nothing personal. An assessment belongs to
       one account and would be a privacy problem sitting in a shared browser, so
       it is never written here.

       The version number is what lets a changed question set invalidate an old
       cache. Bump it if the questions change shape.
       ====================================================================== */

    var Q_CACHE_KEY = 'pruwise.questions.v1';


    /* ======================================================================
       THE QUESTIONS, BUILT IN

       A copy of what assessment_questions() in php/lib/assessment.php returns.
       The questionnaire renders from this the moment somebody opens it - no
       request, no cache, no spinner, ever, on any host.

       WHY DUPLICATE THEM AT ALL, WHEN THE SERVER ALREADY SENDS THEM

       Because the request is the part that fails. On free hosting the host
       answers some requests with a bot-check page instead of our JSON (see
       isHostCheck() in js/api.js), and an XHR can never satisfy it. When that
       landed on the question request, the assessment sat on "Loading your
       assessment..." with nothing to press. A questionnaire that cannot open is
       not a slow feature, it is a missing one.

       These seven questions are the safest thing in the app to hold a second
       copy of: they are identical for every person, contain nothing private, and
       change roughly never. That is the same reasoning that already allowed them
       into localStorage.

       WHICH COPY WINS, AND WHY THE SERVER STILL DECIDES

       Order of preference in primeQuestions(): whatever the server last sent,
       then localStorage, then this. So the server always overrides us - if the
       questions change, the fetch in after() replaces these within a second and
       caches the new set for next time.

       THE VALUES ARE THE CONTRACT. php/lib/assessment.php checks every submitted
       answer against its own option list and rejects anything else, so a typo in
       a `value` here would produce a 400 on submit rather than a wrong result.
       Ids and values must match the PHP exactly; labels and hints are only text.
       Order matches the PHP array, because that is the order people are asked.
       ====================================================================== */

    var BUILT_IN_QUESTIONS = [
        {
            id: 'goal',
            type: 'single',
            title: 'What is your main financial goal right now?',
            help: 'Pick the one that matters most today. Everything else can be added later.',
            options: [
                { value: 'home',       label: 'Saving for a home' },
                { value: 'retirement', label: 'Retirement' },
                { value: 'protection', label: 'Protecting my family',
                  hint: 'Making sure they are alright financially if something happens to me' },
                { value: 'education',  label: "Children's education" },
                { value: 'investment', label: 'Growing my money' }
            ]
        },
        {
            id: 'age',
            type: 'single',
            title: 'Which age range are you in?',
            help: 'Age changes what is realistic. Thirty years until retirement is a very different plan from five.',
            options: [
                { value: 'under25', label: 'Under 25' },
                { value: '25to34',  label: '25 to 34' },
                { value: '35to44',  label: '35 to 44' },
                { value: '45to54',  label: '45 to 54' },
                { value: '55plus',  label: '55 or over' }
            ]
        },
        {
            id: 'dependants',
            type: 'single',
            title: 'Who depends on your income?',
            help: 'This is the single biggest thing that decides how much protection you need.',
            options: [
                { value: 'nobody',   label: 'Just me' },
                { value: 'partner',  label: 'A partner' },
                { value: 'children', label: 'Children' },
                { value: 'extended', label: 'Children and parents',
                  hint: 'Supporting both a younger and an older generation' }
            ]
        },
        {
            id: 'budget',
            type: 'single',
            title: 'What could you comfortably put towards a plan each month?',
            help: 'We would rather suggest something you can keep paying than something impressive you cancel in a year.',
            options: [
                { value: 'under50',  label: 'Under $50' },
                { value: '50to150',  label: '$50 to $150' },
                { value: '150to400', label: '$150 to $400' },
                { value: 'over400',  label: 'More than $400' },
                { value: 'unsure',   label: 'I am not sure yet' }
            ]
        },
        {
            id: 'risk',
            type: 'single',
            title: 'How do you feel about investment risk?',
            help: 'There is no right answer. This decides whether we suggest guaranteed returns or market-linked ones.',
            options: [
                { value: 'low',      label: 'I want my money to be safe',
                  hint: 'Lower returns, but predictable' },
                { value: 'moderate', label: 'Some ups and downs are fine',
                  hint: 'A balance between growth and stability' },
                { value: 'high',     label: 'I will take risk for higher returns',
                  hint: 'The value can fall, sometimes a lot, before it recovers' }
            ]
        },
        {
            id: 'cover',
            type: 'single',
            title: 'What insurance do you already have?',
            help: 'So we suggest what is missing rather than what you are already paying for.',
            options: [
                { value: 'none',          label: 'Nothing that I know of' },
                { value: 'employer',      label: 'Only what my employer provides',
                  hint: 'Worth knowing: this usually ends when the job does' },
                { value: 'some',          label: 'Some cover of my own' },
                { value: 'comprehensive', label: 'I think I am well covered' }
            ]
        },
        {
            id: 'concern',
            type: 'single',
            title: 'What worries you most about your financial future?',
            help: 'Last one. The thing that would keep you up at night, if you had to choose.',
            options: [
                { value: 'illness',    label: 'A serious illness and the bills that come with it' },
                { value: 'incomeloss', label: 'Losing my income and not being able to work' },
                { value: 'retirement', label: 'Not having enough to retire on' },
                { value: 'education',  label: "Not being able to afford my children's education" },
                { value: 'inflation',  label: 'My savings not keeping up with rising prices' }
            ]
        }
    ];

    function cachedQuestions() {
        try {
            var raw = localStorage.getItem(Q_CACHE_KEY);
            if (!raw) { return null; }

            var list = JSON.parse(raw);

            /* Only trust it if it still looks like a question set. A truncated or
               half-written value should be ignored rather than rendered as an
               empty form. */
            if (!list || !list.length || !list[0].id || !list[0].options) { return null; }

            return list;

        } catch (e) {
            return null;      // private browsing, or a corrupted value
        }
    }

    function cacheQuestions(list) {
        try {
            if (list && list.length) { localStorage.setItem(Q_CACHE_KEY, JSON.stringify(list)); }
        } catch (e) {
            /* localStorage can be full or blocked. The questions still work, they
               are just fetched again next time. */
        }
    }

    /* Make sure state.questions is populated. Best available copy wins:

         1. what the server sent this visit   - freshest
         2. localStorage                      - what the server sent last visit
         3. BUILT_IN_QUESTIONS                - always there

       Because 3 can never fail, this ALWAYS returns true and the questionnaire
       is never waiting on anything to draw. The return value is kept so callers
       can still ask "did we have to fall back to the built-in copy", which is
       what decides whether after() re-renders once the server answers. */
    function primeQuestions() {
        if (state.questions && state.questions.length) { return true; }

        var cached = cachedQuestions();
        if (cached) { state.questions = cached; return true; }

        /* Slice, so nothing downstream can mutate the built-in list and leave a
           later visit in this session with a modified question set. */
        state.questions = BUILT_IN_QUESTIONS.slice();
        state.usingBuiltIn = true;

        return false;
    }

    /* Are these two question sets the same, as far as the screen is concerned?

       Compares the ids and the option values in order - the parts that decide
       what is drawn and what may be submitted. Labels and hints are deliberately
       ignored: a reworded question is the same question, and redrawing the form
       under somebody to fix a comma is not worth the flicker. */
    function sameQuestions(a, b) {
        if (!a || !b || a.length !== b.length) { return false; }

        for (var i = 0; i < a.length; i++) {
            if (a[i].id !== b[i].id) { return false; }
            if (a[i].type !== b[i].type) { return false; }

            var oa = a[i].options || [];
            var ob = b[i].options || [];
            if (oa.length !== ob.length) { return false; }

            for (var j = 0; j < oa.length; j++) {
                if (oa[j].value !== ob[j].value) { return false; }
            }
        }
        return true;
    }

    function firstName() {
        var name = (STATE.session && STATE.session.name) ? STATE.session.name : 'there';
        return name.split(' ')[0];
    }

    /* Progress bar */
    function progressBar(current, total) {
        var pct = total > 0 ? Math.round((current / total) * 100) : 0;
        return '<div class="ob-progress"><div class="ob-progress-fill" style="width:' + pct + '%"></div></div>';
    }

    /* ONE CHOICE - a radio button in behaviour, so it says so to a screen reader.

       It is a <button> because it has to be a big tappable card with a hint line
       inside it, which a real <input type="radio"> cannot be. But a button that
       behaves like a radio and does not SAY it is a radio is announced as just
       "button", giving no clue that picking one unpicks the others, and no
       reading of which is currently chosen.

       role="radio" plus aria-checked fixes both, and costs two attributes. The
       circle itself is aria-hidden because it is decoration - the state is
       already carried by aria-checked, and announcing it twice is worse than
       not announcing it. */
    function optionBtn(qId, opt, selected) {
        return '<button type="button" class="ob-option' + (selected ? ' is-selected' : '') + '" ' +
            'role="radio" aria-checked="' + (selected ? 'true' : 'false') + '" ' +
            'data-act="ob-pick" data-q="' + FMT.esc(qId) + '" data-v="' + FMT.esc(opt.value) + '">' +
            '<span class="ob-option-radio" aria-hidden="true"></span>' +
            '<span class="ob-option-text">' + FMT.esc(opt.label) +
            (opt.hint ? '<span class="ob-option-hint">' + FMT.esc(opt.hint) + '</span>' : '') +
            '</span></button>';
    }

    /* ANY NUMBER OF CHOICES - a checkbox, and announced as one. Same reasoning. */
    function checkBtn(qId, opt, selected) {
        return '<button type="button" class="ob-option ob-option-multi' + (selected ? ' is-selected' : '') + '" ' +
            'role="checkbox" aria-checked="' + (selected ? 'true' : 'false') + '" ' +
            'data-act="ob-toggle" data-q="' + FMT.esc(qId) + '" data-v="' + FMT.esc(opt.value) + '">' +
            '<span class="ob-option-check" aria-hidden="true">' +
            (selected ? UI.icon('check', 13) : '') + '</span>' +
            '<span class="ob-option-text">' + FMT.esc(opt.label) +
            (opt.hint ? '<span class="ob-option-hint">' + FMT.esc(opt.hint) + '</span>' : '') +
            '</span></button>';
    }

    function currentAnswered() {
        var q = state.questions && state.questions[state.currentStep];
        if (!q) { return false; }
        var val = state.answers[q.id];
        if (q.type === 'multi') { return Array.isArray(val) && val.length > 0; }
        return (val !== undefined && val !== '');
    }

    function specLine(rep) {
        return (rep.specialisations || []).slice(0, 3).join(' \u2022 ');
    }

    /* One representative card */
    function repCard(rep, selected) {
        /* A rating only if js/data.js genuinely has one for THIS representative.

           DATA.getRep() falls back to the first mock record when it does not
           recognise an id, which is right for screens that need something to
           draw - and completely wrong here. Without the id check, every
           representative added since the mock data was written would display
           Kristin's 4.9 as their own. */
        var mockRep = (typeof DATA !== 'undefined' && DATA.getRep) ? DATA.getRep(rep.id) : null;
        var rating = (mockRep && mockRep.id === rep.id && mockRep.rating) ? mockRep.rating : null;

        return '<button type="button" class="ob-rep-card' + (selected ? ' is-selected' : '') + '" ' +
            'data-act="ob-pick-rep" data-id="' + FMT.esc(rep.id) + '">' +
            '<div class="ob-rep-top">' +
            UI.avatar(rep.name, 'md', { seed: rep.id }) +
            '<div class="ob-rep-info"><div class="ob-rep-name">' + FMT.esc(rep.name) + '</div>' +
            (rep.headline ? '<div class="ob-rep-headline">' + FMT.esc(rep.headline) + '</div>' : '') +
            '</div>' +
            '<div class="ob-rep-fit"><span class="ob-fit-num">' + rep.fit + '%</span>' +
            '<span class="ob-fit-label">match</span></div></div>' +
            (specLine(rep) ? '<div class="ob-rep-tags"><span class="ob-tag">' + FMT.esc(specLine(rep)) + '</span></div>' : '') +
            '<div class="ob-rep-meta">' +
            (rating ? '<span>\u2B50 ' + rating + '</span>' : '') +
            (rep.yearsExperience ? '<span>' + rep.yearsExperience + ' yrs</span>' : '') +
            (rep.languages && rep.languages.length ? '<span>' + FMT.esc(rep.languages.join(', ')) + '</span>' : '') +
            '</div>' +
            '<div class="ob-rep-bottom">' +
            '<span class="badge badge-ok">\uD83D\uDFE2 Accepting</span>' +
            (rep.whyMatched && rep.whyMatched[0] ? '<div class="ob-rep-why">' + FMT.esc(rep.whyMatched[0]) + '</div>' : '') +
            '</div>' +
            (selected ? '<div class="ob-rep-selected-mark">' + UI.icon('checkCircle', 18) + ' Selected</div>' : '') +
            '</button>';
    }

    /* One policy recommendation card */
    function recCard(rec) {
        var product = (typeof DATA !== 'undefined' && DATA.getProduct) ? DATA.getProduct(rec.productId) : null;
        return '<div class="ob-rec-card">' +
            '<div class="ob-rec-header"><div class="ob-rec-name">' +
            (product ? UI.icon(product.icon, 18) + ' ' : '') + FMT.esc(rec.name) +
            '</div><div class="ob-rec-fit"><span class="ob-fit-num">' + rec.fit + '%</span> fit</div></div>' +
            '<div class="ob-rec-cat">' + FMT.esc(rec.category) + '</div>' +
            '<div class="ob-rec-reasons">' +
            (rec.reasons || []).slice(0, 2).map(function (r) {
                return '<div class="ob-rec-why">' + UI.icon('check', 13) + ' <span>' + FMT.esc(r) + '</span></div>';
            }).join('') + '</div></div>';
    }


    /* ======================================================================
       1. WELCOME
       ====================================================================== */
    PAGES['/onboarding/welcome'] = {
        title: 'Welcome', sub: '', flush: true,
        render: function () {
            return '<div class="ob-shell"><div class="ob-welcome">' +
                '<div class="ob-welcome-emoji">\uD83D\uDC4B</div>' +
                '<h1 class="ob-welcome-title">Hi, ' + FMT.esc(firstName()) + '!</h1>' +
                '<p class="ob-welcome-lead">Welcome to PRUWise.</p>' +
                '<div class="ob-welcome-body">' +
                '<p>Take a quick <strong>5-minute Financial Needs Assessment</strong> to get personalised recommendations.</p>' +
                '<ul class="ob-welcome-list">' +
                '<li>' + UI.icon('check', 15) + ' Understand what matters to you</li>' +
                '<li>' + UI.icon('check', 15) + ' Suggest policies that suit your goals</li>' +
                '<li>' + UI.icon('check', 15) + ' Match you with the right representative</li></ul>' +
                '<p class="ob-welcome-note">Your representative will see your answers so the first conversation starts from where you actually are.</p></div>' +
                '<div class="ob-welcome-actions">' +
                '<button type="button" class="btn btn-primary btn-lg btn-block" data-act="ob-start">' +
                UI.icon('clipboard', 18) + '<span>Start Assessment</span></button>' +
                '<button type="button" class="btn btn-ghost btn-block" data-act="ob-skip">' +
                '<span>Skip for now</span></button></div></div></div>';
        },
        after: function () {
            primeQuestions();

            API.getAssessment().then(function (d) {
                if (d.questions && d.questions.length) {
                    state.questions = d.questions;
                    cacheQuestions(d.questions);
                }
                if (d.assessment) { state.assessment = d.assessment; }
            }, function () {});
        }
    };


    /* ======================================================================
       2. ASSESSMENT â€” stepped questionnaire
       ====================================================================== */
    PAGES['/onboarding/assessment'] = {
        title: 'Financial Needs Assessment', sub: '', flush: true,
        render: function () {
            /* NO LOADING STATE HERE ANY MORE, AND NOTHING TO WAIT FOR.

               This used to return UI.loadingState('Loading your assessment...')
               when there was no cached copy, and let after() fill it in. That
               made the whole questionnaire depend on one request succeeding - and
               when the host answered it with a bot-check page instead of JSON,
               the screen was a spinner with no buttons for twenty seconds.

               primeQuestions() now always succeeds, because BUILT_IN_QUESTIONS is
               the last resort and it cannot fail. So question one is on screen
               immediately, every time, and after() only ever swaps in a fresher
               set from the server. */
            primeQuestions();

            var questions = state.questions;
            var step = state.currentStep;
            var q = questions[step];
            var total = questions.length;
            var current = state.answers[q.id];
            var isMulti = (q.type === 'multi');
            var selectedVals = isMulti ? (Array.isArray(current) ? current : []) : (current || '');

            var options = (q.options || []).map(function (opt) {
                var sel = isMulti ? (selectedVals.indexOf(opt.value) !== -1) : (selectedVals === opt.value);
                return isMulti ? checkBtn(q.id, opt, sel) : optionBtn(q.id, opt, sel);
            }).join('');

            var hasAnswer = currentAnswered();
            var isLast = (step === total - 1);

            return '<div class="ob-shell"><div class="ob-assessment">' +
                '<div class="ob-assess-head"><button type="button" class="btn btn-ghost btn-sm" data-act="ob-back">' +
                UI.icon('arrowLeft', 15) + '<span>Back</span></button>' +
                '<div class="ob-step-count">Question ' + (step + 1) + ' of ' + total + '</div></div>' +
                progressBar(step, total) +
                '<div class="ob-question-wrap"><h2 class="ob-question-title" id="ob-q-title">' +
                FMT.esc(q.title) + '</h2>' +
                (q.help ? '<p class="ob-question-help">' + FMT.esc(q.help) + '</p>' : '') +
                (isMulti ? '<p class="ob-question-multi-note">Choose all that apply.</p>' : '') + '</div>' +

                /* The group is labelled by the question, so a screen reader reads
                   "What is your main financial goal right now?, radio group" and
                   then each option - rather than five unexplained radios. A
                   single-choice question is a radiogroup; a multi is just a
                   group, because "radiogroup" would promise only one answer. */
                '<div class="ob-options" role="' + (isMulti ? 'group' : 'radiogroup') + '" ' +
                'aria-labelledby="ob-q-title">' + options + '</div>' +
                '<div class="ob-assess-foot">' +
                (isLast
                    ? '<button type="button" class="btn btn-primary btn-lg btn-block ob-submit" ' +
                      (hasAnswer ? '' : 'disabled ') + 'data-act="ob-submit">' +
                      UI.icon('send', 16) + '<span>See my results</span></button>'
                    : '<button type="button" class="btn btn-primary btn-lg btn-block ob-next" ' +
                      (hasAnswer ? '' : 'disabled ') + 'data-act="ob-next">' +
                      '<span>Next</span>' + UI.icon('arrowRight', 16) + '</button>') +
                '<div id="ob-error" class="ob-error" hidden></div></div></div></div>';
        },
        after: function () {

            /* The form is already on screen and usable. This request is now a
               background refresh, not something the screen is waiting for.

               Still worth making: the server is the authority on what the
               questions are, and if they ever change, this is what picks the
               change up and caches it for next time. */
            API.getAssessment().then(

                function (d) {
                    if (d.assessment) { state.assessment = d.assessment; }

                    if (!d.questions || !d.questions.length) { return; }

                    var fresh   = d.questions;
                    var showing = state.questions || [];
                    var changed = !sameQuestions(showing, fresh);

                    state.questions = fresh;
                    state.usingBuiltIn = false;
                    cacheQuestions(fresh);

                    /* ONLY REDRAW IF IT WOULD CHANGE SOMETHING, AND ONLY BEFORE
                       THEY HAVE STARTED.

                       Redrawing mid-questionnaire would throw away the answer
                       they are part-way through choosing. And redrawing when the
                       server sent the identical set - which is the normal case,
                       since BUILT_IN_QUESTIONS mirrors it - would be a visible
                       flicker for no benefit at all. */
                    if (changed && state.currentStep === 0) { router(); }
                },

                function (err) {
                    /* DELIBERATELY QUIET. The questionnaire is drawn from the
                       built-in copy and works perfectly without this request, so
                       replacing a working form with an error message would be a
                       downgrade. If the server really is unreachable, the person
                       finds out when they submit - and the submit handler already
                       reports that properly, in #ob-error, without losing their
                       answers. */
                    if (window.console && console.warn) {
                        console.warn('PRUWise: could not refresh the questions (' +
                            ((err && err.error) ? err.error : 'unknown') +
                            '). Using the built-in set, which is fine.');
                    }
                }
            );
        }
    };


    /* ======================================================================
       3. RESULTS â€” profile + recommendations
       ====================================================================== */
    PAGES['/onboarding/results'] = {
        title: 'Your profile', sub: '', flush: true,
        render: function () {
            /* A reload empties `state`, so this branch is reached by refreshing a
               results page that was working a second earlier. after() below
               fetches the saved assessment back and re-renders, so this is a
               brief in-between state rather than a verdict - but it still gets
               real buttons, in case the fetch is the thing that fails. */
            if (!state.assessment) {
                return '<div class="ob-shell">' + UI.loadingState('Fetching your results\u2026') +
                    '<div id="ob-results-fallback"></div></div>';
            }
            var a = state.assessment, p = a.profile;
            var profileItems = [
                { icon: 'compass', label: 'Primary Goal', value: p.primaryGoalLabel },
                { icon: 'activity', label: 'Risk Preference', value: p.riskLevelLabel },
                { icon: 'shield', label: 'Protection Needs', value: p.protectionNeedLabel },
                { icon: 'user', label: 'Experience', value: p.experienceLabel }
            ];
            var profileCards = profileItems.map(function (i) {
                return '<div class="ob-profile-item"><span class="ob-profile-icon">' + UI.icon(i.icon, 18) + '</span>' +
                    '<div><div class="ob-profile-label">' + FMT.esc(i.label) + '</div>' +
                    '<div class="ob-profile-value">' + FMT.esc(i.value) + '</div></div></div>';
            }).join('');

            var signals = (p.signals || []).map(function (s) { return '<li>' + FMT.esc(s) + '</li>'; }).join('');
            var recs = (a.recommended || []).map(recCard).join('');

            return '<div class="ob-shell"><div class="ob-results">' +
                '<div class="ob-section"><div class="ob-section-head"><h2 class="ob-section-title">Your Financial Profile</h2>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-act="ob-retake">' + UI.icon('refresh', 14) + '<span>Retake</span></button></div>' +
                '<div class="ob-profile-grid">' + profileCards + '</div>' +
                (signals ? '<div class="ob-signals"><p class="ob-signals-label">Based on your answers:</p><ul class="ob-signals-list">' + signals + '</ul></div>' : '') +
                '</div>' +
                '<div class="ob-section"><h2 class="ob-section-title">\uD83D\uDCCB Recommended Policies</h2>' +
                '<p class="ob-section-sub">Starting points for your conversation \u2014 not advice.</p>' +
                '<div class="ob-rec-list">' + recs + '</div></div>' +
                '<div class="ob-section-foot">' +
                '<button type="button" class="btn btn-primary btn-lg btn-block" data-act="ob-go-matching">' +
                UI.icon('userCheck', 18) + '<span>Choose a representative</span>' + UI.icon('arrowRight', 16) + '</button>' +
                '</div></div></div>';
        },

        /* Only runs when there was nothing in memory - the render above is the
           whole screen otherwise and needs nothing from the server. */
        after: function () {
            if (state.assessment) { return; }

            API.getAssessment().then(

                function (d) {
                    absorbAssessment(d);

                    if (state.assessment) {
                        router();                       // draw the real results
                        return;
                    }

                    // Genuinely never completed it
                    $('#root .ob-shell').html(UI.errorState({
                        icon: 'clipboard',
                        title: 'You have not completed the assessment yet',
                        text: 'Seven questions, about five minutes. You will get a profile of ' +
                            'what you actually need and a shortlist of representatives.',
                        actions:
                            UI.btn({ label: 'Take the assessment', icon: 'clipboard',
                                     href: '#/onboarding/assessment' }) +
                            UI.btn({ label: 'Back to home', variant: 'outline',
                                     icon: 'arrowLeft', href: '#/me/dashboard' })
                    }));
                },

                function (err) {
                    $('#root .ob-shell').html(UI.errorState({
                        title: 'Could not fetch your results',
                        text: (err && err.error) ? err.error
                            : 'The connection did not hold. Nothing has been lost - your ' +
                              'answers are saved on your account.',
                        actions:
                            UI.btn({ label: 'Reload the page', icon: 'refresh', act: 'hard-reload' }) +
                            UI.btn({ label: 'Retake the assessment', variant: 'outline',
                                     icon: 'clipboard', act: 'ob-retake' }) +
                            UI.btn({ label: 'Back to home', variant: 'ghost',
                                     icon: 'arrowLeft', href: '#/me/dashboard' })
                    }));
                }
            );
        }
    };


    /* ======================================================================
       4. MATCHING â€” choose a representative
       ====================================================================== */
    PAGES['/onboarding/matching'] = {
        title: 'Choose a representative', sub: '', flush: true,
        render: function () {
            if (!state.reps) {
                return '<div class="ob-shell">' + UI.loadingState('Finding representatives\u2026') + '</div>';
            }
            var selectedId = state.selectedRep ? state.selectedRep.id : null;
            var cards = (state.reps || []).map(function (r) { return repCard(r, r.id === selectedId); }).join('');

            return '<div class="ob-shell"><div class="ob-matching">' +
                '<div class="ob-section-head"><button type="button" class="btn btn-ghost btn-sm" data-act="ob-go-results">' +
                UI.icon('arrowLeft', 15) + '<span>Back</span></button></div>' +
                '<h2 class="ob-section-title">\uD83D\uDC68\u200D\uD83D\uDCBC Recommended Financial Representatives</h2>' +
                '<p class="ob-section-sub">Ranked based on your assessment. Pick one and they will receive your results.</p>' +
                '<div class="ob-rep-list">' + cards + '</div>' +
                '<div class="ob-matching-foot">' +
                '<button type="button" class="btn btn-primary btn-lg btn-block' + (selectedId ? '' : ' is-disabled') + '" ' +
                'data-act="ob-go-confirm">' + '<span>Review and confirm</span>' + UI.icon('arrowRight', 16) + '</button></div></div></div>';
        },
        after: function () {
            if (state.reps) { return; }

            /* SURVIVE A RELOAD.

               This used to be `if (!state.reps && state.assessment)`, and that
               second condition was the bug. Everything in `state` lives in
               memory only, so a refresh empties it - and the assessment is the
               thing this screen needs before it can ask for matches.

               The result was a dead end: no reps, so render() drew a spinner;
               no assessment, so after() did not fetch; and the "Try again"
               button just re-ran the same do-nothing. Reported as "it says try
               again and the try again button doesn't work", which is exactly
               what it did.

               But the assessment is not really lost. It is stored server-side
               against the account. So if it is missing from memory, fetch it
               back, then ask for the matches. */
            var needAssessment = !state.assessment;

            var ready = needAssessment
                ? API.getAssessment().then(function (d) { absorbAssessment(d); })
                : $.Deferred().resolve().promise();

            ready.then(function () {

                /* Still nothing? Then they genuinely have not completed the
                   assessment, and the honest answer is to send them to it -
                   with a button, not a spinner. */
                if (!state.assessment) {
                    $('#root .ob-shell').html(
                        UI.errorState({
                            icon: 'clipboard',
                            title: 'We need your assessment first',
                            text: 'Matching a representative to you is based on your answers, ' +
                                'and we do not have them yet. It takes about five minutes.',
                            actions:
                                UI.btn({ label: 'Take the assessment', icon: 'clipboard',
                                         href: '#/onboarding/assessment' }) +
                                UI.btn({ label: 'Back to home', variant: 'outline',
                                         icon: 'arrowLeft', href: '#/me/dashboard' })
                        })
                    );
                    return;
                }

                return API.getRepresentatives().then(function (d) {
                    state.reps = d.reps || [];
                    router();
                });

            }).then(null, function (err) {

                /* A REAL FAILURE GETS A REAL WAY OUT. The old handler was
                   `function () {}` - the request failed and the screen kept
                   spinning with nothing to press. */
                $('#root .ob-shell').html(
                    UI.errorState({
                        title: 'Could not load the representatives',
                        text: (err && err.error) ? err.error
                            : 'The connection did not hold. Your assessment is saved.',
                        actions:
                            UI.btn({ label: 'Reload the page', icon: 'refresh',
                                     act: 'hard-reload' }) +
                            UI.btn({ label: 'Back to home', variant: 'outline',
                                     icon: 'arrowLeft', href: '#/me/dashboard' })
                    })
                );
            });
        }
    };


    /* ======================================================================
       5. CONFIRM
       ====================================================================== */
    PAGES['/onboarding/confirm'] = {
        title: 'Confirm', sub: '', flush: true,
        render: function () {
            /* "Nothing to confirm" was a cul-de-sac: no buttons, no way back,
               and it appeared after nothing worse than a page refresh - because
               state.selectedRep only ever existed in memory.

               It still cannot be recovered automatically, and should not be:
               which representative you picked is a decision, not data to guess
               at. But the screen can at least say so and offer the two things
               that make sense - go and pick again, or go home. */
            if (!state.assessment || !state.selectedRep) {

                var needsAssessment = !state.assessment;

                return '<div class="ob-shell">' + UI.errorState({
                    icon: needsAssessment ? 'clipboard' : 'userCheck',
                    title: needsAssessment
                        ? 'We do not have your assessment yet'
                        : 'Choose a representative first',
                    text: needsAssessment
                        ? 'The confirmation screen shows what is being sent and who it is going ' +
                          'to, so it needs your answers first. About five minutes.'
                        : 'Refreshing the page cleared your choice - nothing has been sent, and ' +
                          'your assessment is safely saved. Pick somebody and you will come ' +
                          'straight back here.',
                    actions: needsAssessment
                        ? UI.btn({ label: 'Take the assessment', icon: 'clipboard',
                                   href: '#/onboarding/assessment' }) +
                          UI.btn({ label: 'Back to home', variant: 'outline',
                                   icon: 'arrowLeft', href: '#/me/dashboard' })
                        : UI.btn({ label: 'Choose a representative', icon: 'userCheck',
                                   href: '#/onboarding/matching' }) +
                          UI.btn({ label: 'See my results again', variant: 'outline',
                                   icon: 'target', href: '#/onboarding/results' }) +
                          UI.btn({ label: 'Back to home', variant: 'ghost',
                                   icon: 'arrowLeft', href: '#/me/dashboard' })
                }) + '</div>';
            }
            var rep = state.selectedRep, a = state.assessment;
            var recList = (a.recommended || []).map(function (r) {
                return '<li>' + UI.icon('check', 13) + ' <span>' + FMT.esc(r.name) + '</span></li>';
            }).join('');
            /* dateLong, not date. FMT has no `date` - the formatters are
               dateLong, dateShort, dateParts, friendly, time and relative. The
               call to a function that does not exist threw a TypeError out of
               render(), which the router caught and turned into the generic
               "Page error" screen - so choosing a representative appeared to
               break the app, with the real reason only visible in the console. */
            var date = FMT.dateLong(a.completedAt || new Date());

            return '<div class="ob-shell"><div class="ob-confirm">' +
                '<div class="ob-section-head"><button type="button" class="btn btn-ghost btn-sm" data-act="ob-go-matching">' +
                UI.icon('arrowLeft', 15) + '<span>Back</span></button></div>' +
                '<h2 class="ob-section-title">\uD83E\uDD1D Your Selection</h2>' +
                '<div class="ob-confirm-card">' +
                '<div class="ob-confirm-section"><div class="ob-confirm-label">Financial Representative</div>' +
                '<div class="ob-confirm-rep">' + UI.avatar(rep.name, 'sm', { seed: rep.id }) +
                '<div><div class="ob-confirm-rep-name">' + FMT.esc(rep.name) + '</div>' +
                (rep.headline ? '<div class="ob-confirm-rep-hl">' + FMT.esc(rep.headline) + '</div>' : '') + '</div></div></div>' +
                '<div class="ob-confirm-section"><div class="ob-confirm-label">Recommended Policies</div>' +
                '<ul class="ob-confirm-recs">' + recList + '</ul></div>' +
                '<div class="ob-confirm-section"><div class="ob-confirm-label">Assessment completed</div>' +
                '<div class="ob-confirm-date">' + date + '</div></div></div>' +
                '<div class="ob-confirm-note-wrap"><label class="field-label" for="ob-note">Add a note (optional)</label>' +
                '<textarea class="input ob-note-input" id="ob-note" rows="3" placeholder="e.g. I am most interested in retirement planning\u2026" maxlength="500"></textarea>' +
                '<div class="ob-note-count"><span id="ob-note-count">0</span>/500</div></div>' +
                '<div id="ob-confirm-error"></div>' +
                '<div class="ob-confirm-foot"><button type="button" class="btn btn-primary btn-lg btn-block ob-confirm-btn" data-act="ob-confirm">' +
                UI.icon('send', 16) + '<span>Confirm Consultation</span></button></div>' +
                UI.callout({ tone: 'info', icon: 'info', title: 'What happens next',
                    text: rep.name + ' will receive your assessment and get back to you. Nothing changes until they accept.' }) +
                '</div></div>';
        }
    };


    /* ======================================================================
       6. SKIPPED + DONE
       ====================================================================== */
    PAGES['/onboarding/skipped'] = {
        title: 'Ready when you are', sub: '', flush: true,
        render: function () {
            return '<div class="ob-shell"><div class="ob-welcome">' +
                '<div class="ob-welcome-emoji">\uD83D\uDCA1</div>' +
                '<h1 class="ob-welcome-title">Hi, ' + FMT.esc(firstName()) + '!</h1>' +
                '<p class="ob-welcome-lead">Ready to take control of your financial future?</p>' +
                '<div class="ob-welcome-body"><p>Complete a quick 5-minute <strong>Financial Needs Assessment</strong> any time to receive personalised recommendations.</p></div>' +
                '<div class="ob-welcome-actions">' +
                UI.btn({ label: 'Take Assessment', cls: 'btn-primary btn-lg btn-block', href: '#/onboarding/assessment', icon: 'clipboard' }) +
                UI.btn({ label: 'Explore PRUWise', cls: 'btn-ghost btn-block', href: '#/me/dashboard' }) +
                '</div></div></div>';
        }
    };

    PAGES['/onboarding/done'] = {
        title: 'Request sent', sub: '', flush: true,
        render: function () {
            var repName = state.selectedRep ? state.selectedRep.name : 'your representative';
            return '<div class="ob-shell"><div class="ob-welcome">' +
                '<div class="ob-welcome-emoji">\u2705</div>' +
                '<h1 class="ob-welcome-title">Request sent!</h1>' +
                '<p class="ob-welcome-lead">You\u2019re all set.</p>' +
                '<div class="ob-welcome-body"><p><strong>' + FMT.esc(repName) + '</strong> has received your assessment and will get back to you shortly.</p></div>' +
                '<div class="ob-welcome-actions">' +
                UI.btn({ label: 'Go to my dashboard', cls: 'btn-primary btn-lg btn-block', href: '#/me/dashboard', icon: 'home' }) +
                '</div></div></div>';
        },
        after: function () { state.answers = {}; state.currentStep = 0; }
    };


    /* ======================================================================
       EVENT HANDLERS
       ====================================================================== */
    function bindOnboarding() {

        $(document).on('click', '[data-act="ob-start"]', function () {
            state.currentStep = 0;
            go('/onboarding/assessment');
        });

        $(document).on('click', '[data-act="ob-skip"]', function () {
            API.dismissOnboarding().then(function () {
                if (STATE.session) { STATE.session.onboardingSeen = true; }
            }, function () {});
            go('/onboarding/skipped');
        });

        /* Single-choice pick */
        $(document).on('click', '[data-act="ob-pick"]', function () {
            state.answers[$(this).data('q')] = String($(this).data('v'));
            $(this).closest('.ob-options').find('.ob-option').removeClass('is-selected');
            $(this).addClass('is-selected');
            $('.ob-next, .ob-submit').prop('disabled', false);
        });

        /* Multi-choice toggle */
        $(document).on('click', '[data-act="ob-toggle"]', function () {
            var qId = $(this).data('q'), val = String($(this).data('v'));
            var cur = state.answers[qId];
            if (!Array.isArray(cur)) { cur = []; }
            if (val === 'none') { cur = cur.indexOf('none') === -1 ? ['none'] : []; }
            else {
                cur = cur.filter(function (v) { return v !== 'none'; });
                var idx = cur.indexOf(val);
                if (idx === -1) { cur.push(val); } else { cur.splice(idx, 1); }
            }
            state.answers[qId] = cur;
            /* Re-render the options in place */
            router();
        });

        $(document).on('click', '[data-act="ob-back"]', function () {
            if (state.currentStep > 0) { state.currentStep--; router(); }
            else { go('/onboarding/welcome'); }
        });

        $(document).on('click', '[data-act="ob-next"]', function () {
            if (!currentAnswered()) { return; }
            state.currentStep++;
            router();
        });

        $(document).on('click', '[data-act="ob-submit"]', function () {
            if (!currentAnswered()) { return; }
            var $btn = $(this).addClass('is-loading').prop('disabled', true);
            $('#ob-error').prop('hidden', true);

            API.submitAssessment(state.answers).then(function (d) {
                state.assessment = d.assessment;
                state.reps = d.reps;
                if (STATE.session) { STATE.session.onboardingSeen = true; }
                go('/onboarding/results');
            }, function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                $('#ob-error').prop('hidden', false).text(err.error || 'Something went wrong.');
                if (err.field && state.questions) {
                    for (var i = 0; i < state.questions.length; i++) {
                        if (state.questions[i].id === err.field) { state.currentStep = i; router(); break; }
                    }
                }
            });
        });

        $(document).on('click', '[data-act="ob-retake"]', function () {
            state.answers = {}; state.currentStep = 0; state.assessment = null;
            state.reps = null; state.selectedRep = null;
            go('/onboarding/assessment');
        });

        $(document).on('click', '[data-act="ob-go-matching"]', function () { go('/onboarding/matching'); });
        $(document).on('click', '[data-act="ob-go-results"]', function () { go('/onboarding/results'); });

        $(document).on('click', '[data-act="ob-pick-rep"]', function () {
            var id = String($(this).data('id'));
            var found = null;
            (state.reps || []).forEach(function (r) { if (r.id === id) { found = r; } });
            if (!found) { return; }
            state.selectedRep = found;
            $('.ob-rep-card').removeClass('is-selected').find('.ob-rep-selected-mark').remove();
            $(this).addClass('is-selected').append('<div class="ob-rep-selected-mark">' + UI.icon('checkCircle', 18) + ' Selected</div>');
            $('[data-act="ob-go-confirm"]').removeClass('is-disabled').prop('disabled', false);
        });

        $(document).on('click', '[data-act="ob-go-confirm"]', function () {
            if (state.selectedRep) { go('/onboarding/confirm'); }
        });

        $(document).on('input', '#ob-note', function () { $('#ob-note-count').text($(this).val().length); });

        $(document).on('click', '[data-act="ob-confirm"]', function () {
            if (!state.selectedRep) { return; }
            var $btn = $(this).addClass('is-loading').prop('disabled', true);
            var note = $.trim($('#ob-note').val());
            $('#ob-confirm-error').empty();

            API.requestConsultation(state.selectedRep.id, note).then(function () {
                go('/onboarding/done');
            }, function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                $('#ob-confirm-error').html(UI.callout({ tone: 'warn', icon: 'alertTriangle', title: err.error }));
            });
        });
    }

    return {
        init: function () { bindOnboarding(); },
        loadState: function () {
            if (!STATE.session || STATE.session.role !== 'customer') { return; }

            // Cache first so the questionnaire is ready before the request lands
            primeQuestions();

            /* The questions, the assessment, the consultation requests AND the
               financial figures all arrive together - see absorbAssessment() and
               the note in php/api/assessment.php about why they are bundled. */
            API.getAssessment().then(function (d) {
                absorbAssessment(d);

                /* The dashboard reads getAssessment() and getNeeds(), and the
                   navigation reads hasRep(). All of them change once this lands,
                   so redraw - but never mid-questionnaire, which would lose
                   somebody's place. */
                if (window.location.hash.indexOf('/onboarding/assessment') === -1) { router(); }

            }, function () {});
        },
        shouldShowWelcome: function () {
            return STATE.session && STATE.session.role === 'customer' && !STATE.session.onboardingSeen;
        },
        /* shouldPrompt() USED TO BE HERE and has been removed.

           Its only caller was a "take the assessment" banner on the customer
           dashboard, and that banner could only ever appear for the six seeded
           demo customers, who have all already got a full profile. See the long
           note in the render() of PAGES['/me/dashboard'] in js/pages-me.js.

           Deleted rather than left in place unused. An exported function with no
           callers is an invitation for somebody to find it later and assume it
           was meant to be used somewhere. */

        /* The saved assessment, or null. The customer dashboard reads this to
           decide between "take the assessment" and showing the result. */
        getAssessment: function () { return state.assessment; },

        /* The consultation requests, newest first. Cached from the last fetch. */
        getRequests: function () { return state.requests || []; },

        /* The customer's own financial figures, and the protection needs
           calculated from them. Both null until they fill something in.

           Bundled with the assessment by php/api/assessment.php - see the note
           there - so having the assessment means having these too, with no
           second request. */
        getFinances: function () { return state.finances || null; },
        getNeeds: function () { return state.needs || null; },

        /* Remember them, so the navigation can be worked out without another
           request. Called by whatever fetched them. */
        setRequests: function (list) { state.requests = list || []; },

        /* Is there a representative actually looking after this person?

           Answered from the consultation requests rather than from rep_id, and
           the two now agree: a self-registered customer starts with NO
           representative (see the note where pick_rep() used to be, in
           php/lib/auth.php) and php/api/consultation.php sets rep_id in the same
           transaction that marks a request accepted.

           We still read the requests, not rep_id, because the requests carry the
           extra states this side of the app needs - pending and declined - which
           a single id column cannot express.

           It decides how much of the app they can reach. Until somebody has
           accepted, a new customer has no policies, no appointments and nobody to
           call, so most screens would be empty rooms.

           A seeded sample customer is always true: they have real fixture data and
           a real relationship, and locking them out of it would break the demo. */
        hasRep: function () {
            if (!STATE.session || STATE.session.role !== 'customer') { return true; }

            // Sample customers keep everything
            if (STATE.session.hasSampleProfile) { return true; }

            var list = state.requests || [];

            for (var i = 0; i < list.length; i++) {
                if (list[i].status === 'accepted') { return true; }
            }
            return false;
        },

        /* Drop the cached copy so the next read comes from the server. Called
           after a retake, so a stale profile cannot linger on the dashboard. */
        forget: function () { state.assessment = null; state.reps = null; },

        start: function () { go('/onboarding/welcome'); }
    };
})();
