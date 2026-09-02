/* ==========================================================================
   pages-me.js
   --------------------------------------------------------------------------
   Every screen the CUSTOMER sees:

     /me/dashboard       welcome, policies, coverage, appointment, notifications
     /me/plans           full plan details, dates, benefits
     /me/appointments    upcoming meeting, history, reschedule and contact
     /me/representative  who advises them, and how to reach them

   The tone here is deliberately different from the FR pages: shorter
   sentences, no jargon without an explanation, and no numbers presented as
   a judgement. Where a term has to appear, PRUWise is one tap away.
   ========================================================================== */


// The logged-in customer. Handy because every page on this side needs it.
function me() {
    return DATA.getCustomer(STATE.session.personId) || DATA.customers[0];
}

/* Does this account have sample insurance data behind it?

   The six seeded customers in js/data.js do. Anybody who signed up through the
   form does not - they have a real login and a real representative, but no
   policies, no premiums and no coverage figures, because this is a prototype
   and those numbers are fixtures rather than a product.

   The server decides, not us: public_account() in php/lib/auth.php sets
   hasSampleProfile by checking the person id against the seeded list. Reading it
   from the session means one answer, shared by every screen. */
function hasSampleData() {
    return !!(STATE.session && STATE.session.hasSampleProfile);
}

/* The first word of their name, for greeting them. */
function myFirstName() {
    var name = (STATE.session && STATE.session.name) ? STATE.session.name : 'there';
    return name.split(' ')[0];
}


/* ==========================================================================
   THE NEW CUSTOMER HOME

   What somebody sees on their first login, and every login after that until
   they complete the assessment.

   ONE THING TO DO. A dashboard full of empty cards - no plans, no coverage, no
   appointments - tells a new person that the product is broken. A single clear
   action tells them where to start.

   Once the assessment is done this same screen shows what came out of it, plus
   where their consultation request got to, so the dashboard stays useful for an
   account that will never have sample policies.
   ========================================================================== */

/* Do we ALREADY know this person's assessment, without asking the server?

   Often yes. finishSignIn() calls ONBOARDING.loadState() the moment somebody
   signs in, so by the time they reach the dashboard the answer is usually sitting
   in memory. Reading it from there means a returning customer sees their profile
   drawn instantly and never sees the invitation to take an assessment they have
   already completed. */
function knownAssessment() {
    return (window.ONBOARDING && ONBOARDING.getAssessment)
        ? ONBOARDING.getAssessment()
        : null;
}

function knownRequests() {
    return (window.ONBOARDING && ONBOARDING.getRequests)
        ? (ONBOARDING.getRequests() || [])
        : [];
}

/* The protection needs analysis from the same sign-in prefetch. api/assessment.php
   bundles it with the assessment, so if one is cached the other is too. */
function knownNeeds() {
    return (window.ONBOARDING && ONBOARDING.getNeeds)
        ? ONBOARDING.getNeeds()
        : null;
}

function renderNewCustomerHome() {

    var known = knownAssessment();

    /* The greeting only makes sense for somebody who has nothing yet. Once there
       is a profile, "there is nothing in it yet" is plainly wrong. */
    var hero = known
        ? '<section class="hero anim-up"><div class="hero-inner">' +
          '<span class="hero-eyebrow">Welcome back</span>' +
          '<h1 class="hero-title">Hi ' + FMT.esc(myFirstName()) + '</h1>' +
          '<p class="hero-text">Your Financial Needs Assessment is saved. Here is what came ' +
          'out of it, and where your request to a representative got to.</p>' +
          '</div></section>'

        : '<section class="hero anim-up">' +
        '<div class="hero-inner">' +
        '<span class="hero-eyebrow">Welcome to PRUWise</span>' +
        '<h1 class="hero-title">Hi ' + FMT.esc(myFirstName()) + ' \uD83D\uDC4B</h1>' +
        '<p class="hero-text">Your account is ready. There is nothing in it yet - once you tell ' +
        'us what you are aiming for, PRUWise can suggest policies that fit and put you in touch ' +
        'with a financial representative who works in that area.</p>' +
        '</div></section>';

    /* THE CALL TO ACTION IS DRAWN NOW, NOT AFTER THE SERVER ANSWERS.

       This used to be UI.loadingState('Checking your account...'), filled in by
       the after() hook once api/assessment.php replied. The problem: that panel
       holds the ONLY button on the screen. If the request was slow - and it was,
       because the pollers were queueing behind a session lock, see
       require_login() in php/lib/bootstrap.php - the customer sat looking at a
       spinner with nothing to press, which is what "I don't have the button to do
       the test and it loads so long" means.

       So the safe default goes in first. A brand new account has no assessment,
       so "take the assessment" is right for the overwhelming majority of the
       people who ever see this screen, and it is right instantly. after() then
       REPLACES it only if the server says there is already an assessment - and
       if the server never answers, the screen is still usable rather than dead.

       The cost of guessing wrong is that somebody who already has a profile sees
       the invitation for a moment. The cost of waiting is a screen with no way
       out. Not a close call.

       AND WHEN WE ALREADY KNOW, WE DO NOT GUESS AT ALL. If the assessment is
       already in memory from the sign-in prefetch, the container starts empty and
       after() fills it with the real profile on the same tick - no request, no
       spinner, and no flash of "take the assessment" at somebody who took it
       last week. That was the reported problem: existing accounts should not be
       offered the test. */
    return hero +
        '<div id="new-home" class="stack">' +
        (known ? '' : newHomeStartMarkup()) +
        '</div>';
}

/* The "you have not started yet" panel. Pulled out into its own function so
   render() can draw it immediately and drawNewCustomerHome() can put it back. */
function newHomeStartMarkup() {
    return '<div class="nh-cta">' +
        '<span class="nh-cta-icon">' + UI.icon('clipboard', 28) + '</span>' +
        '<h2 class="nh-cta-title">Start with a Financial Needs Assessment</h2>' +
        '<p class="nh-cta-text">Ten short questions, about five minutes. You will get a ' +
        'profile of what you actually need, policies chosen to match it, and a shortlist of ' +
        'representatives who specialise in it.</p>' +
        '<a class="btn btn-primary btn-lg" href="#/onboarding/assessment">' +
        UI.icon('clipboard', 18) + '<span>Take the assessment</span>' +
        UI.icon('arrowRight', 16) + '</a>' +
        '<p class="nh-cta-note">Nothing is bought or committed to. You can retake it whenever ' +
        'your situation changes.</p>' +
        '</div>' +

        /* Two things worth doing in the meantime, so the screen is not a dead
           end for somebody who does not want to answer questions yet. */
        '<div class="grid grid-sm">' +
        UI.card({ title: 'Ask PRUWise anything', icon: 'sparkles' },
            '<div class="t-sm muted">What is a rider? Do I need critical illness cover? ' +
            'Ask in plain language and get a plain answer.</div>' +
            UI.btn({ label: 'Open PRUWise', variant: 'soft', size: 'sm', block: true,
                     icon: 'sparkles', href: '#/me/messages' })) +
        UI.card({ title: 'Browse what is available', icon: 'shield' },
            '<div class="t-sm muted">Have a look through the policies on offer before ' +
            'deciding anything.</div>' +
            UI.btn({ label: 'See the policies', variant: 'soft', size: 'sm', block: true,
                     icon: 'fileText', href: '#/me/plans' })) +
        '</div>';
}

/* The needs analysis, if we have one.

   `needs` is whatever finances_needs() returned on the server - see
   php/lib/finances.php. It is null when the customer has not saved an income
   yet, because every line is derived from income and zeros would look like an
   answer rather than an absence.

   WHY THE SERVER CALCULATES IT. The customer sees this card and their
   representative sees the same figures on the customer profile. If the browser
   worked them out, the two screens would eventually disagree - and a scoring
   rule sitting in a .js file is a scoring rule anybody can read and edit. */
function needsCard(needs) {

    /* ---------------------------------------------- nothing to work with

       An invitation, not an error. The customer has not done anything wrong;
       we simply have not asked for their numbers yet. */
    if (!needs) {
        return UI.card({ title: 'How much cover do you actually need?', icon: 'shield' },
            '<div class="t-sm muted">Add your income, savings, CPF and what you owe, and ' +
            'PRUWise works out the cover you need line by line - life, critical illness, ' +
            'disability and monthly income. Nothing is shared until you choose a ' +
            'representative.</div>' +
            UI.btn({ label: 'Add my financial details', icon: 'dollarSign', block: true,
                     href: '#/settings' }));
    }

    /* ---------------------------------------------- the analysis */

    /* Tone follows the ratio, so the colour agrees with the sentence. Below 55%
       is a real shortfall, 80%+ is comfortable, the middle is a nudge. */
    var tone = needs.ratio >= 80 ? 'ok' : (needs.ratio >= 55 ? '' : 'warn');

    var headline = needs.gap > 0
        ? UI.callout({
            tone: needs.ratio >= 55 ? 'info' : 'warn',
            icon: needs.ratio >= 55 ? 'info' : 'alertTriangle',
            title: FMT.money(needs.gap) + ' below the suggested cover',
            text: 'Based on ' + needs.yearsOfIncome + ' years of your income, what you owe, and ' +
                'the savings and CPF you told us about. It is a guideline to talk through, not a ' +
                'verdict on your finances.'
        })
        : UI.callout({
            tone: 'ok', icon: 'checkCircle',
            title: 'You are at or above the suggested cover',
            text: 'Worth reviewing anyway when your income, family or mortgage changes.'
        });

    /* Emergency fund. Not insurance, but it is the first thing a representative
       checks, and the customer can read it without being told. */
    var fund = '';
    if (needs.emergency) {
        var e = needs.emergency;
        fund = '<div class="stack-2">' +
            '<div class="meter-head">' +
            '<span class="meter-label">Emergency fund</span>' +
            '<span class="meter-val">' + FMT.moneyShort(e.have) + ' / ' +
            FMT.moneyShort(e.target) + '</span>' +
            '</div>' +
            UI.progress(
                /* Capped at 100 so an over-funded person does not overflow the
                   bar, but monthsHeld below still tells them the true figure. */
                Math.min(100, Math.round((e.have / Math.max(1, e.target)) * 100)),
                { thin: true, tone: e.shortfall > 0 ? 'warn' : 'ok' }
            ) +
            '<div class="t-xs muted">' + e.monthsHeld + ' months of expenses set aside. ' +
            (e.shortfall > 0
                ? FMT.money(e.shortfall) + ' short of the usual ' + e.targetMonths + ' months.'
                : 'That covers the usual ' + e.targetMonths + ' months.') +
            '</div></div>';
    }

    /* Affordability. Flagged BEFORE a plan is recommended, because finding out
       afterwards is how policies get cancelled in the first year. */
    var afford = '';
    if (needs.affordability) {
        var a = needs.affordability;

        if (a.noHeadroom) {
            afford = UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'Your expenses and commitments use up your income',
                text: 'There is nothing spare on the figures you gave us. That is worth saying ' +
                    'out loud to a representative - the answer may be a smaller plan rather than ' +
                    'no plan.'
            });
        } else if (a.overCommitted) {
            afford = UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'Your budget is above what is left over',
                text: 'You said ' + FMT.money(a.statedBudget) + ' a month, but only ' +
                    FMT.money(a.spare) + ' is left after your expenses and commitments.'
            });
        } else {
            afford = UI.callout({
                tone: 'info', icon: 'info',
                title: FMT.money(a.spare) + ' a month is unaccounted for',
                text: 'That is the ceiling on a new premium on your own figures' +
                    (a.statedBudget
                        ? ', and your stated budget of ' + FMT.money(a.statedBudget) + ' fits inside it.'
                        : '. A representative would not normally use all of it.')
            });
        }
    }

    return UI.card({
        title: 'What you need to be covered for',
        sub: 'The dashed outline is the suggested cover. The solid bar is what you already hold.',
        icon: 'shield',
        actions: UI.btn({ label: 'Edit my figures', variant: 'ghost', size: 'xs',
                          icon: 'sliders', href: '#/settings' })
    },
        '<div class="stack-2">' +
        '<div class="meter-head">' +
        '<span class="meter-label semi">Overall</span>' +
        '<span class="meter-val">' + needs.ratio + '% of suggested cover</span>' +
        '</div>' +
        UI.progress(needs.ratio, { thin: true, tone: tone }) +
        '</div>' +
        headline +
        /* Same bars the demo dashboard uses. See coverageLineBars() in js/ui.js. */
        UI.coverageLineBars(needs.lines || []) +
        fund +
        afford
    );
}

/* Draws whatever the new customer should see, once we know whether they have
   completed the assessment and whether a request is outstanding.

   `needs` is optional: null simply means the protection card invites them to add
   their figures instead of showing a gap. */
function drawNewCustomerHome(assessment, requests, needs) {

    /* ------------------------------------------------ nothing done yet

       render() already drew the start panel, so redrawing it here would only
       make the screen flicker. The one thing worth adding is the needs analysis,
       for somebody who filled in their figures in Settings but has not answered
       the questionnaire yet - they have real numbers, so showing them a gap is
       better than pretending we know nothing.

       #nh-needs guards against drawing it twice: after() calls this once from
       the sign-in cache and once from the server reply. */
    if (!assessment) {
        if (needs && !$('#nh-needs').length) {
            $('#new-home').append('<div id="nh-needs">' + needsCard(needs) + '</div>');
            UI.animateBars();
        }
        return;
    }

    /* ------------------------------------------------ assessment done */

    var p = assessment.profile || {};

    var profileRows = [
        ['Primary goal', p.primaryGoalLabel],
        ['Risk preference', p.riskLevelLabel],
        ['Protection needs', p.protectionNeedLabel],
        ['Investment experience', p.experienceLabel]
    ];

    var profileCard = UI.card({
        title: 'Your Financial Profile',
        // dateLong, not date - FMT.date does not exist. See the note in pages-onboarding.js
        sub: assessment.completedAt ? 'Completed ' + FMT.dateLong(assessment.completedAt) : '',
        icon: 'target',
        actions: UI.btn({ label: 'Retake', variant: 'ghost', size: 'xs', icon: 'refresh',
                          act: 'nh-retake' })
    }, UI.kv(profileRows));

    /* The policies that came out of it. Names and reasons only - the detail
       lives on the plans screen, and repeating it here would be a wall. */
    var recs = assessment.recommended || [];

    var recCard = UI.card({
        title: 'Recommended for you',
        sub: recs.length + ' ' + (recs.length === 1 ? 'policy' : 'policies') + ' worth discussing',
        icon: 'fileText'
    },
        recs.length
            ? '<div class="stack-3">' + recs.map(function (r) {

                /* The indicative price. The assessment stores which products fit
                   and why, but no figures - scoring never needed them. The
                   catalogue has a "from" premium and a starting cover, and those
                   are what the customer sees everywhere else, so they are what
                   an application starts from.

                   They are a STARTING POINT, not a quote, and the button copy
                   says so. The representative sets the real terms when they
                   issue. */
                var product = DATA.getProduct(r.productId);

                return '<div class="nh-rec">' +
                    '<div class="nh-rec-head"><span class="nh-rec-name">' + FMT.esc(r.name) + '</span>' +
                    '<span class="nh-rec-fit">' + r.fit + '% fit</span></div>' +
                    '<div class="nh-rec-cat">' + FMT.esc(r.category) + '</div>' +
                    ((r.reasons && r.reasons[0])
                        ? '<div class="nh-rec-why">' + FMT.esc(r.reasons[0]) + '</div>'
                        : '') +

                    /* Applying needs somebody to apply TO. Until a representative
                       has accepted them there is nobody to decide it, and the
                       server refuses with a 409 - so the button is not offered
                       rather than offered and then refused. */
                    ((product && window.ONBOARDING && ONBOARDING.hasRep())
                        ? '<div class="card-actions">' +
                          UI.btn({
                              label: 'Apply for this', variant: 'soft', size: 'sm',
                              icon: 'fileText', act: 'apply-policy',
                              data: {
                                  id: r.productId,
                                  name: r.name,
                                  premium: product.premiumFrom,
                                  cover: product.coverFrom
                              }
                          }) +
                          '</div>'
                        : '') +
                    '</div>';
            }).join('') + '</div>'
            : '<div class="t-sm muted">Nothing specific came out of your answers. Your ' +
              'representative will work through it with you.</div>'
    );

    /* ------------------------------------------------ the request status

       This is the part that answers "what happens now", which is the question
       somebody actually has after pressing Confirm. */
    var pending  = null;
    var accepted = null;
    var declined = null;

    (requests || []).forEach(function (r) {
        if (r.status === 'pending'  && !pending)  { pending = r; }
        if (r.status === 'accepted' && !accepted) { accepted = r; }
        if (r.status === 'declined' && !declined) { declined = r; }
    });

    var statusCard;

    if (accepted) {
        statusCard = UI.card({ title: 'Your representative', icon: 'userCheck' },
            UI.callout({
                tone: 'ok', icon: 'checkCircle',
                title: accepted.repName + ' has accepted',
                text: 'They have read your assessment, so you will not have to start from the ' +
                    'beginning. Message them whenever you are ready.'
            }) +
            '<div class="card-actions">' +
            UI.btn({ label: 'Send a message', icon: 'messageCircle', href: '#/me/messages' }) +
            UI.btn({ label: 'Book a meeting', variant: 'outline', icon: 'calendar',
                     href: '#/me/calendar' }) +
            '</div>');

    } else if (pending) {
        statusCard = UI.card({ title: 'Waiting for a reply', icon: 'clock' },
            UI.callout({
                tone: 'info', icon: 'clock',
                title: 'Sent to ' + pending.repName,
                text: 'They have your assessment and will get back to you. Nothing changes on ' +
                    'your account until they accept.'
            }) +
            UI.btn({ label: 'Withdraw my request', variant: 'ghost', size: 'sm', block: true,
                     act: 'nh-withdraw', data: { id: pending.id } }));

    } else if (declined) {
        statusCard = UI.card({ title: 'Choose somebody else', icon: 'userX' },
            UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: declined.repName + ' could not take this on',
                text: (declined.declineReason ? 'They said: "' + declined.declineReason + '" ' : '') +
                    'Your assessment is saved, so picking somebody else takes one click.'
            }) +
            UI.btn({ label: 'See other representatives', icon: 'userCheck', block: true,
                     href: '#/onboarding/matching' }));

    } else {
        statusCard = UI.card({ title: 'Find a representative', icon: 'userCheck' },
            '<div class="t-sm muted">You have a profile but have not chosen anybody yet. ' +
            'We can suggest the ones who work in what you are aiming for.</div>' +
            UI.btn({ label: 'See who matches', icon: 'userCheck', block: true,
                     href: '#/onboarding/matching' }));
    }

    $('#new-home').html(
        '<div class="split split-rail">' +
        '<div class="stack">' + profileCard + needsCard(needs) + recCard + '</div>' +
        '<div class="stack">' + statusCard +
        UI.card({ title: 'Ask PRUWise', icon: 'sparkles' },
            '<div class="t-sm muted">Anything in your results you would like explained in ' +
            'plain language?</div>' +
            UI.btn({ label: 'Open PRUWise', variant: 'soft', size: 'sm', block: true,
                     icon: 'sparkles', href: '#/me/messages' })) +
        '</div></div>'
    );

    /* The coverage bars in needsCard() grow from 0 to their data-w width. app.js
       does this once when a page renders; this markup arrives afterwards from a
       promise, so without a second call every bar would stay empty. */
    UI.animateBars();
}


/* ==========================================================================
   CUSTOMER DASHBOARD
   ========================================================================== */
PAGES['/me/dashboard'] = {
    title: 'Home',
    sub: 'Your protection at a glance',

    render: function () {

        /* ------------------------------------------------------------------
           A SELF-REGISTERED ACCOUNT HAS NO INSURANCE DATA.

           js/data.js carries sample policies for the six seeded customers only.
           me() falls back to the first of them when it does not recognise the
           person, which kept the old screens from crashing - but on the
           dashboard that meant a brand new account was shown SOMEBODY ELSE'S
           name, premiums, coverage and protection gap. Alarming, and wrong.

           So a new account gets its own screen: their real name, and one thing
           to do. See renderNewCustomerHome().
           ------------------------------------------------------------------ */
        if (!hasSampleData()) { return renderNewCustomerHome(); }

        var c = me();
        var rep = DATA.getRep(c.repId);
        var policies = DATA.policiesFor(c.id);
        var appt = DATA.nextApptFor(c.id);
        var ratio = DATA.coverageRatio(c);

        /* NO RECOMMENDATION IS CHOSEN HERE ANY MORE.

           This line used to read:
               STATE.sharedRecId ? DATA.recById(STATE.sharedRecId) : DATA.topRec(c.id)

           Look at the fallback. With nothing shared - which is the normal state -
           it showed the customer the TOP COMPUTED RECOMMENDATION anyway. So a
           generated shortlist, ranked by an algorithm and read by nobody, appeared
           on a customer's dashboard under the heading "A recommendation prepared
           for you" and above their representative's name.

           That is a machine advising on insurance in a licensed person's name, and
           it was the default behaviour. STATE.sharedRecId was also localStorage,
           so it was per-browser and the representative's own screen was the only
           place the "sharing" had ever happened.

           Now the server decides: /api/recommendations returns only what a
           representative RELEASED, and loadMyRecs() fills the container below. */

        var notifs = DATA.notifications.customer;
        var unread = notifs.filter(function (n) { return STATE.readNotifs.indexOf(n.id) === -1; });

        /* Singapore time - see the note above FMT.TZ in js/data.js. */
        var greeting = FMT.greeting();

        var heroStat = function (value, label) {
            return '<div><div class="hero-stat-value">' + value + '</div>' +
                '<div class="hero-stat-label">' + label + '</div></div>';
        };

        /* ---------------------------------------------------------- hero */

        /* THERE IS NO "TAKE THE ASSESSMENT" NUDGE HERE, AND THERE CANNOT BE ONE.

           There used to be a banner reading "Complete a quick Financial Needs
           Assessment to get personalised recommendations", shown when
           ONBOARDING.shouldPrompt() was true.

           It could only ever have been shown to the wrong people. Look up: this
           whole function is only reached when hasSampleData() is true, which
           means one of the six seeded customers - Sarah Tan and the rest. They
           each have policies, a representative, a coverage breakdown and a
           protection score already. Asking them to start an assessment to "get
           personalised recommendations" reads as though the screen full of
           personalised recommendations directly below it does not exist.

           And the people who genuinely have not done one never get here at all:
           the guard at the top of render() sends them to
           renderNewCustomerHome(), which is built around that single invitation.

           IT ALSO FLASHED ON EVERY SIGN-IN, even for somebody who had completed
           one. shouldPrompt() answered from ONBOARDING's cached assessment, and
           that cache is filled by a request that finishSignIn() starts but does
           not wait for. So the first render saw "no assessment", drew the banner,
           and then the reply landed, router() ran again and it vanished. A
           banner that appears and disappears on its own reads as a glitch even
           when the final state is right.

           So the nudge was aimed at the only group it did not apply to, and it
           was unreliable at that. Removed rather than made conditional, because
           there is no condition under which this branch wants it. */

        var hero = '<section class="hero anim-up">' +
            '<div class="hero-inner">' +
            '<span class="hero-eyebrow">' + greeting + '</span>' +
            '<h1 class="hero-title">Hi ' + FMT.esc(c.salutation + ' ' + c.name) + '</h1>' +
            '<p class="hero-text">You have ' + policies.length + ' active ' +
            (policies.length === 1 ? 'plan' : 'plans') +
            (appt ? ', and an appointment with ' + FMT.esc(rep.name) + ' ' + FMT.friendly(appt.start).toLowerCase() : '') +
            /* PRUWISE FIRST, THEN THE HUMAN, and the human is named.

               This used to end at "ask PRUWise and it will explain in plain
               language", which quietly implies the assistant is the last word. It
               is not: it explains, it does not advise, and anything a client is
               still unsure about belongs with the person who is actually licensed
               to answer it. Saying so here costs one clause. */
            '. If anything here is unclear, ask PRUWise for a plain-language ' +
            'explanation - and if you are still unsure, ' + FMT.esc(rep.name) +
            ' is the one to ask.</p>' +
            '<div class="card-actions">' +
            UI.btn({ label: 'Ask PRUWise', variant: 'white', icon: 'sparkles', href: '#/me/pruwise' }) +
            UI.btn({ label: 'View my plans', variant: 'glass', icon: 'shield', href: '#/me/plans' }) +
            '</div></div>' +
            /* THE PLAN COUNT AND THE PREMIUM ARE CORRECTED FROM THE DATABASE.

               This is the fix for a reported bug: "Paid monthly" here and on the
               Plans page did not agree.

               The reason was that they were two different sums. This hero used
               DATA.monthlyPremium(), which totals the FIXTURES in js/data.js for a
               customer id. The Plans page uses plansMonthlyTotal() over the list it
               actually received from /api/policies - see the note above that
               function, which says in as many words that DATA.monthlyPremium
               "cannot see a real policy". So a policy that had genuinely been
               issued counted on one screen and not the other.

               Both numbers start from the sample figures so the hero is never
               blank, and loadMyTotals() replaces them with the real ones. Two
               screens, one source. */
            '<div class="hero-stats">' +
            heroStat('<span id="me-hero-plans">' + policies.length + '</span>', 'Active plans') +
            heroStat('<span id="me-hero-premium">' +
                FMT.money(DATA.monthlyPremium(c.id)) + '</span>', 'Paid monthly') +
            heroStat(ratio + '%', 'Of suggested cover') +
            heroStat(unread.length, 'New updates') +
            '</div></section>';

        /* ---------------------------- recommendations the FR has released

           An empty container. loadMyRecs() fills it, and when nothing has been
           released it stays empty rather than showing a placeholder - "your
           representative has not recommended anything yet" is not news a customer
           needs delivered as a panel on their home screen. */
        var recSection = '<div id="me-rec"></div>';

        /* ------------------------------------------------ quick prompts */
        var quickAsk = UI.card({
            title: 'Not sure where to start?',
            sub: 'These are the questions people ask most often',
            icon: 'sparkles',
            actions: UI.aitag('PRUWise')
        },
            '<div class="stack-2">' +
            AI.suggestions('customer', c).slice(0, 4).map(function (q) {
                return '<button type="button" class="prompt-chip block" data-act="ask-ai" data-q="' + FMT.esc(q) + '">' +
                    UI.icon('messageCircle', 14) + '<span>' + FMT.esc(q) + '</span></button>';
            }).join('') + '</div>'
        );

        /* ------------------------------------------------ coverage card */
        var coverage = UI.card({
            title: 'What you are covered for',
            sub: 'The red bar is what you have. The dashed outline is a common guideline.',
            icon: 'shield',
            actions: UI.btn({
                label: 'Explain this', variant: 'ghost', size: 'xs', icon: 'helpCircle',
                act: 'ask-ai', data: { q: 'What am I currently protected against?' }
            })
        },
            UI.coverageBars(c) +
            UI.callout({
                tone: 'info', icon: 'info', title: 'A guideline, not a verdict',
                text: 'These suggested amounts come from a standard calculation using your income, ' +
                    'dependants and mortgage. Your representative can tell you which ones actually matter for you.'
            })
        );

        /* ------------------------------------------------- plans (short) */
        var plansSection = '<div class="stack-4">' +
            UI.secHead({
                title: 'My current plans',
                sub: policies.length + ' active',
                actions: UI.btn({ label: 'See all details', variant: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#/me/plans' })
            }) +
            '<div class="grid grid-lg stagger">' +
            policies.map(function (p) { return UI.policyCard(p, { ask: true }); }).join('') +
            '</div></div>';

        /* ------------------------------------------------- right column */
        var apptCard = appt
            ? '<div class="stack-4">' + UI.secHead({ title: 'Your next appointment' }) +
            UI.apptCard(appt, { view: 'customer', agenda: true, join: true, reschedule: true, consult: true }) + '</div>'
            : UI.card({ title: 'No appointment booked', icon: 'calendar' },
                '<div class="t-sm muted">' + FMT.esc(rep.name) + ' is your representative and ' +
                rep.replyTime.toLowerCase() + '.</div>' +
                UI.btn({ label: 'Request a meeting', variant: 'soft', size: 'sm', block: true, icon: 'calendar', act: 'reschedule' }));

        var myRating = STATE.ratings[rep.id];

        var repCard = UI.card({ title: 'Your Financial Representative', icon: 'userCheck' },
            UI.person({ name: rep.name, meta: rep.role, size: 'lg', seed: rep.id, online: true }) +
            '<div class="row-2 wrap">' + UI.stars(rep.rating) +
            '<span class="t-xs muted">' + rep.rating + ' from ' + rep.reviews + ' reviews</span></div>' +
            '<div class="stack-2">' + rep.highlights.slice(0, 3).map(function (h) {
                return '<span class="tick">' + UI.icon('check', 13) + '<span class="t-xs">' + FMT.esc(h) + '</span></span>';
            }).join('') + '</div>' +
            (myRating
                ? UI.callout({
                    tone: 'ok', icon: 'checkCircle', title: 'You rated ' + myRating.score + ' out of 5',
                    text: 'Thank you. You can update your rating at any time from their profile.'
                })
                : '') +
            '<div class="card-actions">' +
            UI.btn({ label: 'Message', icon: 'messageCircle', size: 'sm', href: '#/me/messages' }) +
            UI.btn({ label: myRating ? 'Update rating' : 'Rate', variant: 'outline', size: 'sm', icon: 'star', act: 'rate-rep', data: { id: rep.id } }) +
            UI.btn({ label: 'Profile', variant: 'ghost', size: 'sm', icon: 'user', href: '#/me/representative' }) +
            '</div>'
        );

        /* ==============================================================
           YOUR MONTH, AND TWO WAYS TO ASK FOR TIME

           Booking used to mean leaving this screen for the Calendar, finding the
           right day and filling in a form. For the commonest request - "can I
           speak to somebody" - that is four steps to say one sentence.

           So: the month, with a dot on any day that has something in it, and two
           buttons that are deliberately not the same button.

             ASK FOR THE NEXT SLOT      one click, no form. PRUWise picks the
                                        next sensible time and asks for it. The
                                        representative still has to accept, so
                                        nothing is agreed by one side.

             CHOOSE A TIME              the calendar, for somebody who has a
                                        particular day in mind.

           The grid starts empty and is filled by loadMyCalendar(). Drawing it from
           the fixtures first and replacing it would flash the wrong dots.
           ============================================================== */
        var calendarCard = UI.card({
            title: 'This month',
            sub: 'Dots mark days with something booked',
            icon: 'calendar',
            actions: UI.btn({
                label: 'Open calendar', variant: 'ghost', size: 'xs',
                iconRight: 'arrowRight', href: '#/me/calendar'
            })
        },
            '<div id="me-mini-cal">' + UI.miniCalendar({
                month: new Date(), marks: {}, dayHref: '#/me/calendar'
            }) + '</div>' +

            '<div class="card-actions">' +
            UI.btn({
                label: 'Ask for the next slot', size: 'sm', icon: 'clock',
                act: 'me-quick-book'
            }) +
            UI.btn({
                label: 'Choose a time', variant: 'outline', size: 'sm', icon: 'calendar',
                href: '#/me/calendar'
            }) +
            '</div>' +
            '<div class="t-xs muted">' + FMT.esc(rep.name) + ' accepts the time before ' +
            'anything is agreed, and can suggest a different one.</div>'
        );

        /* THE REAL NOTIFICATIONS, not the js/data.js activity feed.

           This card used to render DATA.notifications - demo colour - on the screen
           a client checks to find out whether anything has happened. It now reads
           the same rows as the bell, which is where a change to their own financial
           record and a suggested meeting time now arrive. */
        var notifCard = UI.card({
            title: 'Recent updates',
            icon: 'bell',
            actions: UI.btn({
                label: 'See all', variant: 'ghost', size: 'xs',
                iconRight: 'arrowRight', href: '#/notifications'
            })
        }, '<div id="me-notifs">' + UI.loadingState('Checking for updates\u2026') + '</div>');

        var questionsCard = UI.card({ title: 'My questions', sub: 'Saved for your next meeting', icon: 'bookmark' },
            (STATE.questions.length
                ? '<div class="stack-2">' + STATE.questions.slice(0, 3).map(function (q) {
                    return '<span class="tick">' + UI.icon('check', 13) + '<span class="t-xs">' + FMT.esc(q) + '</span></span>';
                }).join('') + '</div>'
                : '<div class="t-sm muted">Nothing saved yet. Ask PRUWise what you should discuss, then save ' +
                'the questions that feel relevant.</div>') +
            UI.btn({
                label: STATE.questions.length ? 'Review my ' + STATE.questions.length + ' questions' : 'Find questions to ask',
                variant: 'soft', size: 'sm', block: true, icon: 'bookmark',
                act: STATE.questions.length ? 'open-questions' : 'ask-ai',
                data: STATE.questions.length ? null : { q: 'What should I discuss with my representative?' }
            })
        );

        /* WHAT YOU HAVE COMES BEFORE WHAT YOU MIGHT BUY.

           The order was recommendations, prompts, coverage, plans - so the first
           thing on a client's own home page was a suggestion to buy something, and
           their existing cover was below it.

           That is the wrong way round for a product whose stated purpose is trust.
           A client opening this screen is far more often checking what they already
           hold than shopping, and leading with a recommendation makes the app feel
           like it is selling. Own cover first, then the shortfall, then anything
           the representative has released, then the prompts. */
        return hero +
            '<div class="split split-rail">' +
            '<div class="stack">' +
            plansSection + coverage + recSection + quickAsk +
            '</div>' +
            '<div class="stack">' + apptCard + calendarCard + repCard + notifCard + questionsCard + '</div>' +
            '</div>' +
            '<a class="ai-fab phone-only" href="#/me/pruwise" aria-label="Ask PRUWise">' +
            UI.icon('sparkles', 18) + '<span>Ask AI</span></a>';
    },

    after: function () {
        /* Released recommendations, for BOTH versions of this screen. Whether a
           customer has sample data or not has nothing to do with whether their
           representative has recommended something to them. */
        loadMyRecs();

        /* The plan count and monthly premium, from the same endpoint the Plans page
           reads. Also for BOTH versions - the two screens disagreeing about what
           somebody pays is exactly the bug this fixes. */
        loadMyTotals();

        /* The month grid and the updates panel, also for both versions. Both read
           real rows, and neither has anything to do with whether this account has
           a sample profile behind it. */
        loadMyCalendar();
        loadMyNotifs();

        /* Only the new-customer version needs anything else from the server. The
           sample dashboard is drawn from js/data.js and has nothing to wait for. */
        if (hasSampleData()) { return; }

        /* DRAW WHAT WE ALREADY KNOW, IMMEDIATELY.

           finishSignIn() prefetches the assessment, so this is usually populated
           before the dashboard is even reached. Drawing from it here means a
           returning customer's profile appears on the first frame rather than
           after a round trip - and render() left the container empty for exactly
           this, so there is no flicker and no wrong CTA in between.

           The request below still runs, because the status of a consultation
           request can have changed since sign-in - a representative may have
           accepted while the tab sat open. */
        var known = knownAssessment();
        if (known) { drawNewCustomerHome(known, knownRequests(), knownNeeds()); }

        /* ONE request, not two - now three things in it. api/assessment.php
           returns the consultation requests AND the needs analysis alongside the
           assessment, because this screen always wants all of them and on shared
           hosting every round trip costs most of a second. */
        API.getAssessment().then(

            function (data) {
                drawNewCustomerHome(data.assessment, data.requests || [], data.needs || null);
            },

            /* PREPEND a warning, do NOT replace the panel.

               The old code called $('#new-home').html(UI.errorState(...)), which
               threw away the assessment button that render() had already drawn -
               so a single slow or dropped request turned a working screen into a
               dead one. Now the failure is reported above the button and the
               button still works: worst case the customer starts an assessment
               they had already done, and the server hands back their existing
               answers anyway. */
            function (err) {
                if ($('#new-home-warn').length) { return; }   // one notice is enough

                $('#new-home').prepend(
                    '<div id="new-home-warn">' +
                    UI.callout({
                        tone: 'warn', icon: 'alertTriangle',
                        title: 'We could not check your account just now',
                        text: ((err && err.error) ? err.error : 'The connection timed out.') +
                            ' Everything below still works.'
                    }) +
                    /* hard-reload rather than a soft retry: on free hosting the
                       usual cause is a bot-check page that only a full page load
                       can get past. See isHostCheck() in js/api.js. */
                    UI.btn({ label: 'Reload the page', variant: 'outline', size: 'sm',
                             icon: 'refresh', act: 'hard-reload' }) +
                    '</div>'
                );
            }
        );
    }
};

/* Retake, from the new-customer dashboard. Clears the cached copy first so the
   dashboard cannot redraw the old profile while the new one is being answered. */
$(document).on('click', '[data-act="nh-retake"]', function () {
    if (window.ONBOARDING) { ONBOARDING.forget(); }
    go('/onboarding/assessment');
});

/* Withdraw a pending request. Confirmed first - it is not destructive, but it
   does mean somebody has to choose again, and it is one tap from a card. */
$(document).on('click', '[data-act="nh-withdraw"]', function () {
    var id = $(this).data('id');

    UI.confirmModal({
        title: 'Withdraw your request?',
        message: 'The representative will no longer see it, and you can choose somebody else. ' +
            'Your assessment is kept.',
        confirmLabel: 'Withdraw',
        tone: 'danger',
        confirmAct: 'nh-confirm-withdraw',
        confirmData: { id: id }
    });
});

$(document).on('click', '[data-act="nh-confirm-withdraw"]', function () {
    var id = $(this).data('id');
    UI.closeModal();

    API.resolveConsultation(id, 'withdraw').then(
        function (data) {
            UI.toast({ title: data.message || 'Withdrawn.', tone: 'info' });
            router();
        },
        function (err) {
            UI.toast({ title: 'Could not withdraw', message: err.error, tone: 'warn' });
        }
    );
});


/* ==========================================================================
   MY PLANS

   TWO SOURCES, ONE LIST.

   js/data.js carries eleven fixture policies for the six seeded demo customers.
   The `policies` table carries real cover that somebody applied for and a
   representative issued. Both are shown here, in one list, because from the
   customer's point of view they are the same thing: plans they hold.

   php/lib/policies.php shapes a database row to match a fixture field for
   field, so UI.policyCard() renders either without knowing which it was given.

   THE OLD GATE HAD TO GO. This screen used to read
   `hasSampleData() ? DATA.policiesFor(c.id) : []`, which was right while
   policies existed only as fixtures. It is wrong the moment real cover exists:
   hasSampleProfile is a hard-coded list of eight person ids in
   php/lib/auth.php, so a self-registered customer holding a genuine policy
   would have been shown "No plans yet" while the database said otherwise.

   The fixtures are still gated - they belong to specific demo accounts and
   showing them to anybody else would be listing a stranger's cover as your own.
   Real rows are not gated at all. They came back from the server keyed to the
   session, so they are already the right person's.
   ========================================================================== */

/* Real policies and applications, from the last time the server answered.

   Held at module level rather than in STATE because only this screen and the
   dashboard read them, and because a stale copy is exactly what we want on a
   re-render: it lets render() draw the list it already knows about instantly,
   and after() correct it a moment later. */
var myRealPolicies = [];
var myPolicyApps = [];

/* Fixtures for the demo accounts, plus every real policy. */
function myPlanList() {
    var c = me();
    var fixtures = hasSampleData() ? DATA.policiesFor(c.id) : [];

    return fixtures.concat(myRealPolicies);
}

/* Applications that have not been decided yet. These are the ones worth showing
   prominently, because the customer is waiting on them. */
function myOpenApps() {
    return myPolicyApps.filter(function (a) {
        return a.status === 'submitted' || a.status === 'under_review';
    });
}

/* THE HOME SCREEN'S PLAN COUNT AND MONTHLY PREMIUM, FROM THE DATABASE.

   Reads /api/policies - the same endpoint the Plans page reads, and totalled with
   the same plansMonthlyTotal() below. That is the whole point: the two screens
   were showing different figures for "Paid monthly" because they were computing it
   from different places.

   Silent on failure. The sample figures are already on screen and a customer's
   home page is not the right place to report that a background total could not be
   refreshed. */
function loadMyTotals() {
    if (!$('#me-hero-premium').length) { return; }

    API.getPolicies().then(

        function (data) {
            var mine = data.policies || [];

            /* An account with no issued policies genuinely has none, and the honest
               figure is zero rather than the sample total. Leaving the fixtures on
               screen for a real customer would be telling them they hold cover they
               do not have, which is the worst version of this bug. */
            $('#me-hero-plans').text(mine.length);
            $('#me-hero-premium').text(FMT.money(plansMonthlyTotal(mine)));
        },

        function () { /* the sample figures stay, and the Plans page says the same */ }
    );
}


/* ==========================================================================
   THE MONTH GRID ON THE HOME SCREEN

   Same endpoint the Calendar screen reads, and the same Singapore-day keying -
   see the time-zone note at the top of js/pages-calendar.js. Two screens
   answering "is anything booked on the 14th" from two sources is the bug this
   whole round keeps being about.
   ========================================================================== */
function loadMyCalendar() {
    if (!$('#me-mini-cal').length) { return; }

    /* The Singapore month. firstOfMonth is a LOCAL-MIDNIGHT LABEL date, not an
       instant: UI.miniCalendar reads .getMonth() off it to lay out the grid, so
       handing it a real +08:00 instant would put the grid a month out for anybody
       west of here. */
    var p = FMT.sgParts(new Date());
    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

    var firstOfMonth = new Date(p.year, p.month - 1, 1);
    var lastDay = new Date(p.year, p.month, 0);

    var from = p.year + '-' + pad2(p.month) + '-01';
    var to = p.year + '-' + pad2(p.month) + '-' + pad2(lastDay.getDate());

    API.appointments(from, to).then(function (data) {
        var marks = {};

        (data.appointments || []).forEach(function (a) {
            if (a.status === 'cancelled') { return; }

            var key = FMT.sgDayKey(a.start);
            if (!key) { return; }

            marks[key] = (marks[key] || 0) + 1;
        });

        $('#me-mini-cal').html(UI.miniCalendar({
            month: firstOfMonth, marks: marks, dayHref: '#/me/calendar'
        }));

    }, function () { /* the empty grid already on screen is a fine fallback */ });
}


/* The real notifications, in the home-screen panel. Same rows as the bell. */
function loadMyNotifs() {
    var $box = $('#me-notifs');
    if (!$box.length) { return; }

    API.notifications.list(6).then(

        function (data) {
            var rows = data.notifications || [];

            /* The bell's copy is refreshed from the same response, so the badge and
               this panel cannot disagree about what is unread. */
            STATE.notifs = rows;
            STATE.notifUnread = Number(data.unread) || 0;
            paintBellDot();

            if (!rows.length) {
                $box.html('<div class="t-sm muted">Nothing new right now. PRUWise will tell ' +
                    'you here if a detail on your record changes or a meeting is suggested.</div>');
                return;
            }

            $box.html('<div class="notif-list is-page">' +
                rows.map(notifRow).join('') + '</div>');
        },

        function () {
            $box.html('<div class="t-sm muted">Could not check for updates just now.</div>');
        }
    );
}


/* ONE-CLICK MEETING REQUEST.

   ==========================================================================
   WHY THIS EXISTS AS ITS OWN THING AND NOT A LINK TO THE FORM
   ==========================================================================

   The commonest thing a client wants is "can I speak to somebody". Through the
   calendar that is: leave this screen, find a day, open a modal, type a title,
   pick a length, submit. Five steps to say one sentence, and the four in the
   middle are decisions the app can make perfectly well itself.

   So this picks the time and sends the request. It is still a REQUEST - the
   server writes it as 'pending' and the representative accepts or suggests
   another - so the one click commits nobody to anything.

   ==========================================================================
   WHICH SLOT, AND WHY NOT "AS SOON AS POSSIBLE"
   ==========================================================================

   10am on the next weekday, Singapore time. Not "in an hour": a request for a
   meeting starting shortly is one the representative almost certainly cannot
   accept, and an unacceptable default is worse than no default. Not the weekend
   either, for the same reason.
   ========================================================================== */
function nextWeekdaySlot() {
    var p = FMT.sgParts(new Date());
    var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

    /* Walk forward from tomorrow until a weekday. Built as label dates so the
       weekday arithmetic is plain, then turned into a real instant with the
       Singapore offset at the end. */
    var probe = new Date(p.year, p.month - 1, p.day + 1);

    for (var i = 0; i < 7; i++) {
        var weekday = probe.getDay();
        if (weekday !== 0 && weekday !== 6) { break; }

        probe = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() + 1);
    }

    var key = probe.getFullYear() + '-' + pad2(probe.getMonth() + 1) + '-' + pad2(probe.getDate());

    return FMT.sgInstant(key, '10:00');
}

$(function () {
    $(document).on('click', '[data-act="me-quick-book"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        var when = nextWeekdaySlot();

        if (!when) {
            UI.toast({ tone: 'bad', title: 'Could not work out a time',
                       message: 'Please choose one from the calendar.' });
            return;
        }

        $btn.addClass('is-loading').prop('disabled', true);

        API.bookAppointment({
            /* withPerson is deliberately absent. A client has exactly one
               representative and the server reads it off their own record - see
               createAppointment() - so there is nothing here to get wrong and
               nothing to spoof. */
            title: 'Questions about my cover',
            mode: 'video',
            minutes: 30,
            start: when.toISOString()
        }).then(

            function (data) {
                $btn.removeClass('is-loading').prop('disabled', false);

                UI.toast({
                    tone: 'ok',
                    title: 'Time requested',
                    message: FMT.friendly(when) + '. ' + (data.message || ''),
                    duration: 5200
                });

                loadMyCalendar();
                loadMyNotifs();
            },

            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);

                /* A CLASH IS THE EXPECTED FAILURE, not an exception. The
                   representative may already be busy at ten - so say so and send
                   them to the calendar rather than reporting an error they cannot
                   act on. */
                UI.toast({
                    tone: 'warn',
                    title: 'That slot is not free',
                    message: (err && err.error ? err.error + ' ' : '') +
                        'Open the calendar to pick another time.',
                    duration: 6000
                });
            }
        );
    });
});


/* Premium totals across whatever is in the list.

   Computed here rather than through DATA.monthlyPremium(), which sums the
   fixtures for a customer id and therefore cannot see a real policy. Both
   shapes carry premium.amount and premium.per, so one function does both. */
function plansMonthlyTotal(policies) {
    return Math.round(policies.reduce(function (total, p) {
        return total + p.premium.amount * (p.premium.per === 'monthly' ? 1 : 1 / 12);
    }, 0));
}

function plansYearlyTotal(policies) {
    return policies.reduce(function (total, p) {
        return total + p.premium.amount * (p.premium.per === 'monthly' ? 12 : 1);
    }, 0);
}

/* ==========================================================================
   APPLICATIONS IN PROGRESS

   WHAT THIS SECTION IS FOR, since it was not obvious from the screen.

   Applying for a plan is not the same as holding one. When a client applies, the
   request goes to their representative, who decides whether to issue it - see the
   policy queue in js/pages-fr.js. Between those two moments the application
   exists and the cover does not, and this card is the only place the client can
   see that.

   Without it, applying appears to do nothing: the plan is not in "My plans",
   because it is not a plan yet, so the obvious conclusion is that the button
   failed.

   IT KEEPS DECLINED ONES TOO. That is deliberate. A declined application is the
   answer to "what happened to the thing I asked for", and the reason the
   representative wrote is the most useful sentence on the screen. Hiding it would
   leave the request looking like it vanished.

   Issued and withdrawn ones are filtered out: an issued application has become a
   real plan and is listed as one, and a withdrawn one was cancelled by the client
   themselves.
   ========================================================================== */
/* ONE ROW PER PRODUCT, NEWEST FIRST.

   Applying again after a decline is allowed and normal - it is how a decline gets
   resolved after a conversation - so the same plan can genuinely appear several
   times. Listing every attempt is not useful: what the customer wants to know is
   where THIS plan has got to, and the newest row is the answer. The earlier
   attempts become a count on the newest row instead of eight near-identical cards.

   This also happens to be what a screen carrying sixteen copies of one declined
   application needed. That data is being cleaned up separately - see the tidy step
   in api/_routes/setup.ts - but a screen that falls apart when a list is longer
   than expected will fall apart again on something else. */
function collapseApplications(list) {
    var seen = {};
    var out = [];

    /* Newest first, so the first row met for a product is the one to keep. Sorted
       on a copy: myPolicyApps is the module's cache of what the server said and
       reordering it in place would change what every other reader sees. */
    list.slice().sort(function (a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
    }).forEach(function (a) {
        var key = a.productId || a.name;

        if (seen[key]) {
            seen[key].earlier++;
            return;
        }

        var row = $.extend({}, a);
        row.earlier = 0;

        seen[key] = row;
        out.push(row);
    });

    return out;
}

function myApplicationsCard() {
    var shown = collapseApplications(myPolicyApps.filter(function (a) {
        return a.status !== 'issued' && a.status !== 'withdrawn';
    }));

    if (!shown.length) { return ''; }

    var tone = {
        submitted: 'info', under_review: 'info', declined: 'warn'
    };

    var label = {
        submitted: 'Waiting for your representative',
        under_review: 'Being reviewed now',
        declined: 'Not taken forward'
    };

    var rows = shown.map(function (a) {
        var open = a.status === 'submitted' || a.status === 'under_review';

        return '<div class="stack-2">' +
            '<div class="between">' +
            '<div class="row-2">' + UI.icon(a.icon, 15) +
            '<span class="t-sm bold">' + FMT.esc(a.name) + '</span></div>' +
            UI.badge(label[a.status] || a.status, tone[a.status] || 'info') +
            '</div>' +

            '<div class="t-xs muted">Applied ' + FMT.relative(a.createdAt) + ' | ' +
            FMT.money(a.premium) + ' a month' +
            (a.earlier
                ? ' | ' + a.earlier + ' earlier attempt' + (a.earlier === 1 ? '' : 's')
                : '') +
            (a.cover ? ' | ' + FMT.money(a.cover) + ' cover' : '') + '</div>' +

            (a.declineReason
                ? '<div class="t-xs">' + FMT.esc(a.declineReason) + '</div>'
                : '') +

            (open
                ? '<div class="card-actions">' +
                  UI.btn({ label: 'Withdraw', variant: 'ghost', size: 'sm',
                           act: 'withdraw-application', data: { id: a.id } }) +
                  '</div>'
                : '') +
            '</div>';
    }).join('');

    return UI.card({
        title: 'Applications in progress',
        sub: 'Nothing here is cover yet - it becomes a policy only once it is issued',
        icon: 'clock'
    },
        '<div class="stack-4">' + rows + '</div>' +

        /* SAYS WHAT HAPPENS NEXT, because a status on its own does not.

           "Waiting for your representative" tells somebody where the request is
           and not what to expect or when to chase. This is the one line that makes
           the section answer its own question. */
        UI.callout({
            tone: 'info', icon: 'info',
            text: 'Your representative reviews each application and decides whether ' +
                'to issue it. You are told either way, and anything issued moves ' +
                'into My plans. If you have been waiting and want to know where it ' +
                'has got to, message them.'
        }) +

        UI.btn({
            label: 'Message my representative', variant: 'soft', size: 'sm',
            block: true, icon: 'messageCircle', href: '#/me/messages'
        })
    );
}


/* ==========================================================================
   RECOMMENDATIONS A REPRESENTATIVE HAS RELEASED

   The customer's side of the gate. Only rows the server returns are drawn, and
   the server only returns what a representative released and has not withdrawn -
   see api/_routes/recommendations.ts.

   THE REPRESENTATIVE'S NOTE COMES FIRST, above the generated detail, because it
   is the only part of this a human wrote and it is what makes the recommendation
   theirs rather than the software's.
   ========================================================================== */
/* The last answer from the server, so a screen that renders synchronously can ask
   what has been released without making its own request. Deliberately starts
   EMPTY: before the first answer arrives, nothing has been released as far as this
   browser knows, which is the safe direction to be wrong in. */
var MY_RELEASED = [];

function releasedRecCached() {
    for (var i = 0; i < MY_RELEASED.length; i++) {
        var rec = DATA.recById(MY_RELEASED[i].recId);
        if (rec) { return rec; }
    }
    return null;
}

function loadMyRecs() {
    API.recommendations.released().then(

        function (data) {
            var rows = data.released || [];
            MY_RELEASED = rows;

            if (!rows.length) { return; }

            var c = me();
            var rep = DATA.getRep(c.repId);
            var repFirst = rep ? String(rep.name).split(' ')[0] : 'your representative';

            var cards = rows.map(function (row) {
                /* The detail still comes from the catalogue - what the server
                   stores is the DECISION. A release whose recommendation is no
                   longer in the catalogue shows the note alone rather than
                   vanishing, because the decision happened either way. */
                var rec = DATA.recById(row.recId);

                var note = '<div class="rec-note">' +
                    '<div class="rec-note-head">' + UI.icon('messageCircle', 14) +
                    '<span>' + FMT.esc(rep ? rep.name : 'Your representative') +
                    ' wrote</span>' +
                    '<span class="t-xs subtle">' + FMT.relative(row.at) + '</span>' +
                    '</div>' +
                    '<div class="t-sm">' + FMT.esc(row.note || '') + '</div>' +
                    '</div>';

                if (!rec) {
                    return UI.card({
                        title: row.productName,
                        sub: 'Recommended by ' + (rep ? rep.name : 'your representative'),
                        icon: 'fileText'
                    }, note);
                }

                return note + UI.aiRecCard(rec, {
                    view: 'customer',
                    showNeeds: false,
                    actions: UI.btn({
                        label: 'Ask PRUWise about this', icon: 'sparkles', size: 'sm',
                        act: 'ask-ai', data: { q: 'Why was ' + rec.product.name + ' recommended for me?' }
                    }) +
                        UI.btn({
                            label: 'What are the downsides?', variant: 'outline', size: 'sm',
                            icon: 'helpCircle', act: 'ask-ai',
                            data: { q: 'What are the downsides of ' + rec.product.name + '?' }
                        }) +
                        UI.btn({
                            label: 'Discuss with ' + repFirst, variant: 'ghost', size: 'sm',
                            icon: 'messageCircle', act: 'contact-rep',
                            data: { id: rep ? rep.id : '' }
                        })
                });
            }).join('');

            $('#me-rec').html('<div class="stack-4">' +
                UI.secHead({
                    eyebrow: 'From ' + (rep ? rep.name : 'your representative'),
                    title: rows.length === 1
                        ? 'A recommendation prepared for you'
                        : rows.length + ' recommendations prepared for you',
                    sub: 'Read them at your own pace. Nothing is decided until you say so.'
                }) +
                cards +
                '</div>');
        },

        function () {
            /* Silent. A customer with no recommendations and a customer whose
               request failed both see the same empty space, and neither is worth
               an error panel on a home screen. */
        }
    );
}


PAGES['/me/plans'] = {
    title: 'My plans',
    sub: 'What you hold and what it covers',

    render: function () {
        var c = me();

        /* Fixtures for the demo accounts plus any real cover - see the long note
           above this page. Drawn from whatever we already know, immediately;
           after() corrects it once the server answers. */
        var policies = myPlanList();

        if (!policies.length) {
            /* Three empty states now, because there are three genuinely different
               situations and the useful next step differs in each.

               An application already in flight is the important addition. Without
               it, somebody who applied yesterday opened this screen, read "no
               plans yet", and had no way to tell whether their application had
               been lost. */
            var openApps = myOpenApps();

            if (openApps.length) {
                return UI.pageHead({ title: 'My plans' }) +
                    myApplicationsCard() +
                    UI.emptyState({
                        icon: 'clock',
                        title: 'Nothing in force yet',
                        text: 'Your application is with your representative. Cover starts only ' +
                              'once they issue it, and it will appear here the moment they do.',
                        actions: UI.btn({ label: 'Message my representative', icon: 'messageCircle',
                                          act: 'contact-rep', data: { id: c.repId } })
                    });
            }

            var noAssessment = !!(window.ONBOARDING && !ONBOARDING.getAssessment());

            return UI.pageHead({ title: 'My plans' }) +
                myApplicationsCard() +
                UI.emptyState({
                    icon: 'shield',
                    title: 'No plans yet',
                    text: noAssessment
                        ? 'Take the Financial Needs Assessment and PRUWise will suggest policies ' +
                          'that match what you are aiming for.'
                        : 'Once a policy is issued it will appear here with all the details.',
                    actions: noAssessment
                        ? UI.btn({ label: 'Take the assessment', icon: 'clipboard',
                                   href: '#/onboarding/assessment' })
                        : UI.btn({ label: 'Talk to my representative', icon: 'messageCircle',
                                   act: 'contact-rep', data: { id: c.repId } })
                });
        }

        /* --- summary numbers ---

           Totalled over the list actually on screen, not through
           DATA.monthlyPremium(), which sums the fixtures for a customer id and so
           cannot see a policy that was really issued. */
        var facts = [
            ['Active plans', String(policies.length)],
            ['Paid monthly', FMT.money(plansMonthlyTotal(policies))],
            ['Paid yearly', FMT.money(plansYearlyTotal(policies))]
        ];

        /* "Cover in place" is a percentage of a recommended figure that only the
           fixtures carry - DATA.coverageRatio() reads customer.coverage, which a
           self-registered account does not have. Showing 100% because there is
           nothing to compare against would be the worst kind of wrong, so the
           fact is simply absent for them. Their real needs analysis lives on the
           dashboard, built from figures they typed. */
        if (hasSampleData()) {
            facts.push(['Cover in place', DATA.coverageRatio(c) + '% of guideline']);
        }

        var summary = UI.card({ cls: 'card-inset' }, UI.facts(facts));

        /* --- simple visual coverage summary --- */
        var coverage = UI.card({
            title: 'Simple coverage summary',
            sub: 'One bar for each type of protection',
            icon: 'shield',
            actions: UI.btn({
                label: 'Explain my coverage', variant: 'soft', size: 'sm', icon: 'sparkles',
                act: 'ask-ai', data: { q: 'Explain my coverage' }
            })
        }, UI.coverageBars(c));

        /* --- important dates, sorted so the soonest comes first --- */
        var dates = [];
        policies.forEach(function (p) {
            dates.push({ policy: p.name, label: 'Renews', date: p.renewal });
            if (p.maturity) { dates.push({ policy: p.name, label: 'Matures', date: p.maturity }); }
        });
        dates.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });

        var datesCard = UI.card({ title: 'Important dates', sub: 'Nothing needs doing unless we contact you', icon: 'calendar' },
            UI.table({
                caption: 'Important dates',
                scrollHint: false,
                rows: dates,
                columns: [
                    { label: 'Plan', key: 'policy' },
                    { label: 'What happens', key: 'label' },
                    { label: 'Date', key: 'date', render: function (r) { return FMT.dateLong(r.date); } },
                    { label: 'When', key: 'when', render: function (r) { return FMT.relative(r.date); } }
                ]
            })
        );

        /* --- all the benefits in one list --- */
        var benefitsCard = UI.card({ title: 'Everything you are entitled to', sub: 'Across all of your plans', icon: 'checkCircle' },
            '<div class="stack-4">' + policies.map(function (p) {
                return '<div class="stack-2">' +
                    '<div class="row-2">' + UI.icon(p.icon, 14) + '<span class="eyebrow">' + FMT.esc(p.name) + '</span></div>' +
                    p.benefits.map(function (b) {
                        return '<span class="tick">' + UI.icon('check', 13) + '<span class="t-sm">' + FMT.esc(b) + '</span></span>';
                    }).join('') +
                    (p.riders.length
                        ? p.riders.map(function (r) {
                            return '<span class="tick">' + UI.icon('plus', 13) + '<span class="t-sm">' +
                                FMT.esc(r.name + ': ' + r.detail) + '</span></span>';
                        }).join('')
                        : '') +
                    '</div>';
            }).join('') + '</div>'
        );

        return UI.pageHead({
            eyebrow: 'Your protection',
            title: 'My plans',

            /* THE EXCLAMATION MARKER, next to the title because that is the first
               thing read on the screen and a warning nobody scrolls to is not a
               warning.

               knownNeeds() rather than a request: /api/assessment bundles the
               needs analysis and it is already prefetched at sign-in, so this
               costs nothing and cannot leave the marker arriving after the person
               has finished reading. Returns nothing at all when there is no
               shortfall, and UI.warnDot renders '' for that. */
            titleAfter: UI.warnDot({
                warnings: DATA.planWarnings(knownNeeds()),
                label: 'My plans'
            }),

            sub: 'Every plan you hold, what it covers, and when the important dates fall. ' +
                'Tap "Ask about this plan" on any card for a plain-language explanation.',
            actions: UI.btn({ label: 'Ask PRUWise', icon: 'sparkles', href: '#/me/pruwise' }) +
                UI.btn({ label: 'Contact my representative', variant: 'outline', icon: 'messageCircle', act: 'contact-rep', data: { id: c.repId } })
        }) +
            summary +
            myApplicationsCard() +
            '<div class="split split-rail">' +
            '<div class="stack">' +
            '<div class="stack-4">' + UI.secHead({ title: 'My plans in detail' }) +
            '<div class="grid grid-lg stagger">' +
            policies.map(function (p) { return UI.policyCard(p, { ask: true }); }).join('') +
            '</div></div>' +
            benefitsCard +
            '</div>' +

            /* The coverage bars read customer.coverage, which only the fixtures
               carry, so the rail is fixtures-only. A self-registered customer gets
               the dates table on its own rather than an empty chart. */
            '<div class="stack">' + (hasSampleData() ? coverage : '') + datesCard + '</div>' +
            '</div>';
    },

    /* Real policies come from the server, and the page is drawn twice.

       WHY TWICE. The first pass uses whatever myRealPolicies already holds, which
       on a fresh load is nothing - so a customer with only real cover briefly sees
       "No plans yet". The alternative is a spinner where their policy list should
       be, and this screen is reached by people who want to check something
       specific about their cover. Drawing what we know and correcting it is the
       same trade-off renderNewCustomerHome() documents.

       Re-rendering through render() rather than patching a container keeps one
       description of the screen. #main is the element the router fills - see
       renderShell() in js/app.js - so writing to it is what the router itself
       does, minus the shell. */
    after: function () {
        API.getPolicies().then(
            function (data) {
                myRealPolicies = (data && data.policies) ? data.policies : [];
                myPolicyApps   = (data && data.applications) ? data.applications : [];

                /* ONLY IF THEY ARE STILL HERE.

                   This writes a whole screen into #main, and the request it is
                   waiting on can easily outlive the visit: tap My plans, change
                   your mind, tap Messages, and the answer arrives to paint the
                   plans screen over the top of the conversation you just opened.
                   The cache above is still updated either way, so the next visit
                   draws the corrected list immediately. */
                if (!/^#\/me\/plans\b/.test(location.hash)) { return; }

                $('#main').html(PAGES['/me/plans'].render());
            },
            function () {
                /* Left alone on purpose. The fixtures - or the empty state - are
                   already on screen and still true; an error banner over somebody's
                   policy list would suggest their cover is in doubt when the only
                   thing that failed was a request. */
            }
        );
    }
};


/* Withdrawing an application the customer no longer wants.

   Confirmed first, because it cannot be undone from this screen: withdrawing sets
   the row to 'withdrawn' and applying again creates a new one, which puts them
   back at the end of their representative's queue. */
$(document).on('click', '[data-act="withdraw-application"]', function () {
    UI.confirmModal({
        title: 'Withdraw this application?',
        message: 'Your representative will no longer see it. You can apply again later, ' +
            'but it will go back to the end of their queue.',
        confirmLabel: 'Withdraw',
        tone: 'danger',
        confirmAct: 'confirm-withdraw-application',
        confirmData: { id: $(this).data('id') }
    });
});

$(document).on('click', '[data-act="confirm-withdraw-application"]', function () {
    var id = $(this).data('id');
    UI.closeModal();

    API.resolvePolicyApplication(id, 'withdraw').then(
        function (data) {
            UI.toast({ title: data.message || 'Withdrawn.', tone: 'info' });

            /* Re-read rather than splicing the local copy. The server decides what
               state the row ended in, and one round trip is cheaper than a second
               place that models the same rules. */
            if (PAGES['/me/plans'].after) { PAGES['/me/plans'].after(); }
        },
        function (err) {
            UI.toast({ title: 'Could not withdraw', message: err.error, tone: 'warn' });
        }
    );
});


/* ==========================================================================
   APPLYING FOR A PLAN

   THE WORDING HERE IS THE FEATURE.

   Somebody pressing a button called "Apply" on an insurance app could reasonably
   believe they have just bought something. They have not, and every sentence in
   this dialog says so: it is a request, their representative decides, the figures
   are a starting point, and nothing is charged.

   Getting that wrong would be worse than not having the feature. A customer who
   thinks they are covered and is not has been actively misled by the software.
   ========================================================================== */
$(document).on('click', '[data-act="apply-policy"]', function () {
    var $b = $(this);
    var productId = $b.data('id');
    var name      = $b.data('name') || 'this plan';
    var premium   = Number($b.data('premium')) || 0;
    var cover     = Number($b.data('cover')) || 0;

    UI.openModal({
        title: 'Apply for ' + name,
        sub: 'A request to your representative, not a purchase',
        body: '<div class="stack-4">' +

            UI.callout({
                tone: 'info', icon: 'info',
                title: 'Nothing is bought and nothing is charged',
                text: 'This asks your representative to look at ' + name + ' for you. They ' +
                      'decide the final cover and premium, and no cover starts until they ' +
                      'issue the policy. You can withdraw at any point before that.'
            }) +

            UI.facts([
                ['Plan', name],
                ['Starting premium', premium ? FMT.money(premium) + ' a month' : 'To be quoted'],
                ['Starting cover', cover ? FMT.money(cover) : 'Depends on the plan']
            ]) +

            '<div class="field"><label class="field-label" for="apply-note">' +
            'Anything you want them to know (optional)</label>' +
            '<textarea class="input" id="apply-note" rows="3" maxlength="500" ' +
            'placeholder="e.g. I would rather keep the premium under $150 a month."></textarea>' +
            '<div class="field-hint" id="apply-hint">These figures are the published ' +
            'starting point for this plan. Your representative will confirm the real ones.</div>' +
            '</div>' +

            '</div>',

        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
              UI.btn({ label: 'Send application', variant: 'primary', icon: 'send',
                       act: 'apply-policy-go',
                       data: { id: productId, premium: premium, cover: cover } })
    });
});

$(document).on('click', '[data-act="apply-policy-go"]', function () {
    var $btn = $(this);
    var productId = $btn.data('id');
    var premium   = Number($btn.data('premium')) || 0;
    var cover     = Number($btn.data('cover')) || 0;

    $btn.addClass('is-loading').prop('disabled', true);

    var terms = { premium: premium, note: $.trim($('#apply-note').val() || '') };

    /* Only send a cover figure when the catalogue has one. prd-shield has
       coverFrom 0 because a hospitalisation plan pays the bill rather than a sum
       assured, and sending 0 would render as "$0 death benefit" on the policy
       card - a number that is not merely useless but alarming. */
    if (cover > 0) { terms.cover = cover; }

    API.applyForPolicy(productId, terms).then(

        function (data) {
            UI.closeModal();
            UI.toast({ title: 'Application sent', message: data.message, tone: 'ok' });

            /* Back to the router so the dashboard and the plans screen both pick
               up the new application. */
            router();
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);
            $('#apply-hint').html('<span class="t-bad">' + FMT.esc(err.error) + '</span>');
        }
    );
});


/* ==========================================================================
   APPOINTMENTS
   ========================================================================== */
PAGES['/me/appointments'] = {
    title: 'Appointments',
    sub: 'Your meetings and history',

    render: function () {
        var c = me();
        var rep = DATA.getRep(c.repId);
        var upcoming = DATA.apptsFor(c.id).filter(function (a) { return a.status !== 'completed'; });
        var past = DATA.pastApptsFor(c.id);

        var upcomingSection = upcoming.length
            ? '<div class="stack-4">' +
            UI.secHead({ title: 'Coming up', sub: upcoming.length + ' scheduled' }) +
            '<div class="stack-4 stagger">' + upcoming.map(function (a) {
                return UI.apptCard(a, { view: 'customer', agenda: true, join: true, reschedule: true, consult: true });
            }).join('') + '</div></div>'

            : UI.emptyState({
                icon: 'calendar',
                title: 'No appointments booked',
                text: 'When you are ready, ' + rep.name + ' can walk you through your cover. ' +
                    rep.replyTime.toLowerCase() + '.',
                actions: UI.btn({ label: 'Request a meeting', icon: 'calendar', act: 'reschedule' }) +
                    UI.btn({ label: 'Send a message', variant: 'outline', icon: 'messageCircle', act: 'contact-rep', data: { id: rep.id } })
            });

        var prepCard = UI.card({
            title: 'Get ready for your meeting',
            sub: 'A few minutes now makes the meeting far more useful',
            icon: 'sparkles',
            actions: UI.aitag('PRUWise')
        },
            '<div class="stack-2">' +
            ['What should I discuss with my representative?',
                'What am I currently protected against?',
                'Compare my current plan with another option'].map(function (q) {
                    return '<button type="button" class="prompt-chip block" data-act="ask-ai" data-q="' + FMT.esc(q) + '">' +
                        UI.icon('messageCircle', 14) + '<span>' + FMT.esc(q) + '</span></button>';
                }).join('') + '</div>' +
            UI.btn({
                label: STATE.questions.length ? 'Review my ' + STATE.questions.length + ' saved questions' : 'My saved questions',
                variant: 'outline', size: 'sm', block: true, icon: 'bookmark', act: 'open-questions'
            })
        );

        var repCard = UI.card({ title: 'Who you are meeting', icon: 'userCheck' },
            UI.person({ name: rep.name, meta: rep.title, size: 'lg', seed: rep.id, online: true }) +
            UI.kv([
                ['Role', rep.role],
                ['Experience', rep.years + ' years'],
                ['Rating', rep.rating + ' out of 5 (' + rep.reviews + ' reviews)'],
                ['Speaks', rep.languages.join(', ')],
                ['Usual reply time', rep.replyTime.replace('Typically replies within ', 'Within ')]
            ]) +
            '<div class="card-actions">' +
            UI.btn({ label: 'Call', icon: 'phone', size: 'sm', variant: 'outline', href: 'tel:' + rep.phone.replace(/\s/g, '') }) +
            UI.btn({ label: 'Email', icon: 'mail', size: 'sm', variant: 'outline', href: 'mailto:' + rep.email }) +
            UI.btn({ label: 'Message', icon: 'messageCircle', size: 'sm', act: 'contact-rep', data: { id: rep.id } }) +
            '</div>'
        );

        var historySection = past.length
            ? '<div class="stack-4">' +
            UI.secHead({ title: 'Past meetings', sub: past.length + ' completed' }) +
            UI.card({}, UI.timeline(past.map(function (a) {
                return {
                    title: a.title,
                    text: a.type + (a.notes ? ' | ' + a.notes : ''),
                    time: a.start,
                    icon: a.mode === 'video' ? 'video' : (a.mode === 'phone' ? 'phone' : 'mapPin')
                };
            }))) + '</div>'
            : '';

        return UI.pageHead({
            eyebrow: 'With ' + rep.name,
            title: 'Appointments',
            sub: 'Your upcoming meetings, what they will cover, and everything you have discussed before.',
            actions: UI.btn({ label: 'Request a meeting', icon: 'calendar', act: 'reschedule' }) +
                UI.btn({ label: 'Join video call', variant: 'outline', icon: 'video', href: '#/me/call' }) +
                UI.btn({ label: 'Ask PRUWise', variant: 'outline', icon: 'sparkles', href: '#/me/pruwise' })
        }) +
            '<div class="split split-rail">' +
            '<div class="stack">' + upcomingSection + historySection + '</div>' +
            '<div class="stack">' + prepCard + repCard + '</div>' +
            '</div>';
    }
};


/* ==========================================================================
   VIDEO CALL - THE CUSTOMER'S SIDE

   The same call as /fr/call, seen from the other chair. The video area, the
   clock and the webcam all come from js/call.js, so both sides behave
   identically. What changes is the side panel:

     the representative gets   AI talking points and a note pad for the file
     the customer gets         questions to ask, their own cover, plain-English
                               explanations of anything they hear, private notes

   The customer's panel is deliberately not a script either. It is there so
   nobody leaves a call realising too late what they meant to ask.
   ========================================================================== */
PAGES['/me/call'] = {
    title: 'Video call',
    sub: 'Talking to your representative',
    flush: true,

    render: function () {
        var c = me();
        var rep = DATA.getRep(c.repId);
        var policies = DATA.policiesFor(c.id);

        /* A recommendation the representative has RELEASED, if there is one.

           MY_RELEASED is filled by loadMyRecs() and is a cache, not the truth -
           this panel renders synchronously and cannot wait for a request, so on a
           cold load straight to the call screen it may be empty. That is the right
           way round to be wrong: an empty panel, never a recommendation the
           customer was not meant to see yet. */
        var rec = releasedRecCached();

        // Questions PRUWise thinks are worth asking, each with a reason
        var suggested = AI.questionsFor(c);

        /* ------------------------------------------------- video area */
        var stage = CALL.stage({
            peerName: rep.name,

            /* No peerNote. That line is now the connection state - "Waiting for
               Kristin to join", "Connecting", "They ended the call" - and putting
               a job title there instead would hide the one thing somebody
               staring at an empty tile actually wants to know. */
            peerSeed: rep.id,
            selfName: 'You',
            selfSeed: c.id,
            controls: CALL.micButton() + CALL.camButton() + CALL.ccButton() +
                CALL.control({ act: 'me-call-ask', icon: 'helpCircle', aria: 'Questions to ask' }) +
                CALL.control({ act: 'me-call-jot', icon: 'edit', aria: 'Jot something down' }) +
                CALL.panelButton() +
                CALL.endButton({ act: 'me-call-end', label: 'Leave call' })
        });

        /* ------------------------------------------------- side panel */
        var tabs = UI.tabs('mecall', [

            /* --- 1. what to ask ------------------------------------- */
            {
                id: 'ask', label: 'What to ask', icon: 'sparkles',
                render: function () {
                    // Anything the customer bookmarked earlier comes first
                    var saved = STATE.questions.length
                        ? '<div class="stack-2">' +
                        '<span class="eyebrow">Saved by you</span>' +
                        STATE.questions.map(function (q, i) {
                            return UI.talkpoint({
                                text: q, check: true,
                                done: STATE.askedQuestions.indexOf('saved-' + i) !== -1,
                                act: 'me-call-asked', data: { key: 'saved-' + i }
                            });
                        }).join('') + '</div>'
                        : '';

                    // Then the suggestions, each with a short "why this matters"
                    var ideas = '<div class="stack-2">' +
                        '<span class="eyebrow">PRUWise suggests</span>' +
                        suggested.map(function (q, i) {
                            return '<div class="stack-2" style="gap:4px">' +
                                UI.talkpoint({
                                    text: q.question, check: true,
                                    done: STATE.askedQuestions.indexOf('ai-' + i) !== -1,
                                    act: 'me-call-asked', data: { key: 'ai-' + i }
                                }) +
                                UI.expand('Why this matters', '<div class="t-xs muted">' +
                                    FMT.esc(q.why) + '</div>') +
                                '</div>';
                        }).join('') + '</div>';

                    return '<div class="stack-4">' +
                        UI.callout({
                            tone: 'brand', icon: 'sparkles', title: 'Your list for this call',
                            text: 'Tap a question once you have asked it. There is no wrong question, ' +
                                'and you can ask for anything to be repeated.'
                        }) +
                        saved + ideas +
                        '</div>';
                }
            },

            /* --- 2. their own cover, plus anything shared ----------- */
            {
                id: 'cover', label: 'My cover', icon: 'shield',
                render: function () {
                    /* Whatever the representative shared sits with the rest of
                       the customer's cover, because that is the comparison the
                       customer is actually making in their head. */
                    var shared = rec
                        ? '<div class="stack-3">' +
                        '<span class="eyebrow">Shared with you</span>' +
                        UI.callout({
                            tone: 'info', icon: 'info', title: 'Take your time',
                            text: 'You do not have to decide anything on this call. ' +
                                'Ask for it in writing and think it over.'
                        }) +
                        UI.aiRecCard(rec, { view: 'customer', compact: true, showNeeds: false }) +
                        '</div>'
                        : '';

                    return '<div class="stack-4">' +
                        UI.facts([
                            ['Active plans', String(policies.length)],
                            ['Paid monthly', FMT.money(DATA.monthlyPremium(c.id))],
                            ['Cover in place', DATA.coverageRatio(c) + '% of guideline']
                        ]) +
                        UI.coverageBars(c) +
                        '<div class="stack-2"><span class="eyebrow">Your plans</span>' +
                        (policies.length
                            ? policies.map(function (p) {
                                return '<div class="spec">' + UI.icon('shield', 15) +
                                    '<span>' + FMT.esc(p.name) + '</span></div>';
                            }).join('')
                            : '<div class="t-sm muted">No plans on your record yet.</div>') +
                        '</div>' +
                        shared +
                        UI.disclaimer('short') +
                        '</div>';
                }
            },

            /* --- 3. jargon help, in case a term comes up ------------ */
            {
                id: 'terms', label: 'Jargon', icon: 'bookOpen',
                render: function () {
                    /* Plain <details> boxes, so a term can be looked up mid-call
                       without leaving the page or interrupting anyone. */
                    return '<div class="stack-4">' +
                        UI.callout({
                            tone: 'info', icon: 'bookOpen', title: 'Heard a word you did not follow?',
                            text: 'Open it here, or just ask. A good representative will be happy to explain.'
                        }) +
                        '<div class="stack-2">' + DATA.glossary.slice(0, 8).map(function (t) {
                            return UI.expand(t.term, '<div class="t-sm">' + FMT.esc(t.plain) + '</div>',
                                { icon: 'bookOpen' });
                        }).join('') + '</div>' +
                        UI.btn({
                            label: 'Ask PRUWise instead', variant: 'outline', size: 'sm',
                            block: true, icon: 'sparkles', href: '#/me/pruwise'
                        }) +
                        '</div>';
                }
            },

            /* --- 4. transcript and private notes ------------------- */
            {
                id: 'notes', label: 'Notes', icon: 'edit',
                render: function () {
                    /* THE TRANSCRIPT IS NOT HERE ANY MORE.

                       It used to be duplicated in this panel, which meant two
                       copies of the same growing list to keep in step, and two
                       places to look for it. It now lives in one place: tap the
                       caption bar under the video and it expands to show
                       everything said so far.

                       This panel keeps only what is genuinely yours - your own
                       private notes - plus a pointer to where the transcript went
                       and a button to pull it in. */
                    var whereItWent = UI.callout({
                        tone: 'info', icon: 'messageSquare',
                        title: 'Looking for what was said?',
                        text: 'Tap the caption bar under the video. It opens out into ' +
                            'everything said so far, with a name against every line.'
                    });

                    return '<div class="stack-4">' +
                        whereItWent +
                        '<div class="field"><label class="field-label" for="me-call-notes">' +
                        'Notes for yourself</label>' +
                        '<textarea class="textarea" id="me-call-notes" style="min-height:140px" ' +
                        'placeholder="Numbers, dates, anything you want to check later.">' +
                        FMT.esc(STATE.myCallNotes) + '</textarea>' +
                        '<div class="field-hint" id="me-notes-status">' +
                        'Private to you, saved on this device only.</div></div>' +
                        UI.btn({
                            // UI.btn escapes the label itself, so no FMT.esc here
                            label: 'Send these to ' + rep.name.split(' ')[0],
                            icon: 'send', size: 'sm', block: true, act: 'me-call-send-notes'
                        }) +
                        '</div>';
                }
            },

            /* --- past calls ----------------------------------------------

               So "when did we last speak" has an answer. Filled in by
               CALL.renderHistory() in after(), because it needs a request. */
            {
                id: 'history', label: 'Past calls', icon: 'clock',
                render: function () {
                    return '<div id="me-callog"></div>';
                }
            }
        ]);

        return '<div class="call">' + stage + CALL.rail(tabs) + '</div>';
    },

    /* Asks for the camera and microphone, then joins the room on the server.

       Note there is no withPerson. A customer has exactly one representative and
       the server reads it off their own record, so there is nothing to choose and
       nothing the browser could get wrong. See resolvePair() in api/_lib/calls.ts. */
    after: function () {
        var c = me();
        var appt = DATA.nextApptFor(c.id);

        /* Warms MY_RELEASED so the Recommendation tab has something to show if
           they open it mid-call. Landing straight here on a cold load means the
           tab is empty until this returns, which is the safe way round. */
        loadMyRecs();

        CALL.begin({
            view: 'customer',
            customerId: c.id,
            appointmentId: appt ? appt.id : null,

            // They hung up first. Show the same summary rather than nothing.
            onRemoteEnd: function () { showMyCallSummary(); }
        });

        CALL.renderHistory('#me-callog');
    }
};


/* ==========================================================================
   MY REPRESENTATIVE
   ========================================================================== */
PAGES['/me/representative'] = {
    title: 'My representative',
    sub: 'Who advises you',

    render: function () {
        var c = me();
        var rep = DATA.getRep(c.repId);
        var past = DATA.pastApptsFor(c.id);
        var next = DATA.nextApptFor(c.id);

        /* --- the header card --- */
        var profile = UI.card({ cls: 'card-soft' },
            '<div class="row top wrap" style="gap:20px">' +
            UI.avatar(rep.name, 'xl', { seed: rep.id, online: true }) +
            '<div class="grow stack-3">' +
            '<div class="stack-2" style="gap:2px">' +
            '<h2 class="h3">' + FMT.esc(rep.name) + '</h2>' +
            '<div class="t-sm semi t-brand">' + FMT.esc(rep.role) + '</div>' +
            '<div class="t-xs muted">' + FMT.esc(rep.title) + '</div>' +
            '</div>' +
            '<div class="chips">' +
            UI.dotBadge('Available now', 'ok') +
            UI.badge(rep.rating + ' / 5 rating', 'brand') +
            UI.badge(rep.years + ' years experience') +
            '</div>' +
            '<div class="t-sm muted">' + FMT.esc(rep.bio) + '</div>' +
            '<div class="card-actions">' +
            UI.btn({ label: 'Send a message', icon: 'messageCircle', act: 'contact-rep', data: { id: rep.id } }) +
            UI.btn({ label: 'Start a video call', variant: 'outline', icon: 'video', href: '#/me/call' }) +
            UI.btn({ label: 'Call ' + rep.phone, variant: 'outline', icon: 'phone', href: 'tel:' + rep.phone.replace(/\s/g, '') }) +
            UI.btn({ label: 'Email', variant: 'outline', icon: 'mail', href: 'mailto:' + rep.email }) +
            '</div>' +
            '</div></div>'
        );

        /* --- what they specialise in --- */
        var specialisations = UI.card({ title: 'What ' + rep.name.split(' ')[0] + ' specialises in', icon: 'award' },
            '<div class="stack-3">' + rep.specialisations.map(function (s) {
                return '<div class="spec">' + UI.icon('checkCircle', 15) + '<span>' + FMT.esc(s) + '</span></div>';
            }).join('') + '</div>'
        );

        var highlights = UI.card({ title: 'Track record', sub: 'Why you were matched together', icon: 'trendingUp' },
            '<div class="stack-3">' + rep.highlights.map(function (h) {
                return '<div class="spec">' + UI.icon('star', 15) + '<span>' + FMT.esc(h) + '</span></div>';
            }).join('') + '</div>' +
            UI.disclaimer('short')
        );

        /* --- contact details --- */
        var contact = UI.card({ title: 'Contact options', icon: 'phone' },
            UI.kv([
                ['Phone', rep.phone],
                ['Email', rep.email],
                ['Office', rep.office],
                ['Languages', rep.languages.join(', ')],
                ['Usual reply time', rep.replyTime.replace('Typically replies within ', 'Within ')],
                ['Licence', rep.licence]
            ]) +
            '<div class="card-actions">' +
            UI.btn({ label: 'Message', icon: 'messageCircle', size: 'sm', block: true, act: 'contact-rep', data: { id: rep.id } }) +
            '</div>'
        );

        var nextCard = next
            ? '<div class="stack-4">' + UI.secHead({ title: 'Next appointment' }) +
            UI.apptCard(next, { view: 'customer', agenda: true, join: true, reschedule: true, consult: true }) + '</div>'
            : UI.card({ title: 'No appointment booked', icon: 'calendar' },
                '<div class="t-sm muted">Request a time that suits you and ' + FMT.esc(rep.name.split(' ')[0]) +
                ' will confirm it.</div>' +
                UI.btn({ label: 'Request a meeting', variant: 'soft', size: 'sm', block: true, icon: 'calendar', act: 'reschedule' }));

        var history = UI.card({ title: 'Appointment history', sub: past.length + ' meetings so far', icon: 'clock' },
            past.length
                ? UI.timeline(past.map(function (a) {
                    return {
                        title: a.title,
                        text: a.type + (a.notes ? ' | ' + a.notes : ''),
                        time: a.start,
                        icon: a.mode === 'video' ? 'video' : (a.mode === 'phone' ? 'phone' : 'mapPin')
                    };
                }))
                : '<div class="t-sm muted">You have not had a meeting yet.</div>'
        );

        var trust = UI.card({ title: 'Good to know', icon: 'shield' },
            UI.callout({
                tone: 'info', icon: 'info', title: 'You can always ask for a second opinion',
                text: 'Your representative is licensed and regulated. You are entitled to ask how they are paid, ' +
                    'to take any recommendation away and think about it, and to change your mind.'
            })
        );

        /* ---------------------------------------------------- your rating */
        var myRating = STATE.ratings[rep.id];

        var ratingCard = UI.card({
            title: 'Rate your representative',
            sub: myRating ? 'You rated them ' + FMT.relative(myRating.at) : 'Your feedback stays private to Prudential',
            icon: 'star'
        },
            '<div class="rating-summary">' +
            '<span class="rating-big">' + rep.rating + '</span>' +
            '<div><div>' + UI.stars(rep.rating, 16) + '</div>' +
            '<div class="t-xs muted">' + rep.reviews + ' client reviews</div></div>' +
            '</div>' +

            /* A simple breakdown. Derived from the overall score so it always
               looks consistent with the number above it. */
            '<div class="stack-2">' +
            UI.ratingBar('5 star', Math.round(rep.rating / 5 * 100) - 4) +
            UI.ratingBar('4 star', 14) +
            UI.ratingBar('3 star', 4) +
            UI.ratingBar('2 star', 1) +
            UI.ratingBar('1 star', 1) +
            '</div>' +

            '<div class="hr"></div>' +

            (myRating
                ? '<div class="stack-2">' +
                '<span class="eyebrow">Your rating</span>' +
                '<div class="row-2">' + UI.stars(myRating.score, 18) +
                '<span class="t-sm semi">' + myRating.score + ' out of 5</span></div>' +
                (myRating.comment ? '<div class="t-xs muted">' + FMT.esc(myRating.comment) + '</div>' : '') +
                UI.btn({ label: 'Update my rating', variant: 'outline', size: 'sm', icon: 'edit', act: 'rate-rep', data: { id: rep.id } }) +
                '</div>'
                : '<div class="stack-2">' +
                '<div class="t-sm muted">How has your experience been? It takes about a minute and helps ' +
                'us match clients with the right representative.</div>' +
                UI.btn({ label: 'Rate ' + rep.name.split(' ')[0], icon: 'star', size: 'sm', block: true, act: 'rate-rep', data: { id: rep.id } }) +
                '</div>')
        );

        /* ------------------------------------------ request a different FR */
        var pending = STATE.repChangeRequest;

        var changeCard = UI.card({
            title: 'Not the right fit?',
            sub: 'You can ask for a different representative',
            icon: 'userX'
        },
            pending
                ? UI.callout({
                    tone: 'info', icon: 'clock', title: 'Request received',
                    text: 'Your request to change representative was submitted ' + FMT.relative(pending.at) +
                        '. Our client care team reviews these within 3 working days and will contact you by email.'
                }) +
                UI.kv([
                    ['Reference', pending.reference],
                    ['Reason given', pending.reason],
                    ['Preferred representative', pending.preferred || 'No preference'],
                    ['Status', 'Under review']
                ]) +
                UI.btn({ label: 'Withdraw request', variant: 'ghost', size: 'sm', icon: 'x', act: 'cancel-rep-change' })

                : '<div class="t-sm muted">Sometimes the fit is not right, and that is completely fine. ' +
                'You can ask to be reassigned - it will not affect your policies, your cover or your premiums ' +
                'in any way.</div>' +
                UI.callout({
                    tone: 'info', icon: 'shield', title: 'How it works',
                    text: 'We check a few conditions, you tell us why, and our client care team handles the ' +
                        'handover. Your new representative receives your file so you do not repeat yourself.'
                }) +
                UI.btn({
                    label: 'Request a different representative', variant: 'outline', size: 'sm',
                    block: true, icon: 'userX', act: 'change-rep'
                })
        );

        return UI.pageHead({
            eyebrow: 'Your adviser',
            title: 'My representative',
            sub: 'Who advises you, what they specialise in, and every way to reach them.',
            actions: UI.btn({ label: 'Message', icon: 'messageCircle', href: '#/me/messages' }) +
                UI.btn({ label: 'Ask PRUWise', variant: 'outline', icon: 'sparkles', href: '#/me/pruwise' })
        }) +
            profile +
            '<div class="split split-rail">' +
            '<div class="stack">' + specialisations + highlights + history + '</div>' +
            '<div class="stack">' + nextCard + ratingCard + contact + changeCard + trust + '</div>' +
            '</div>';
    }
};


/* ==========================================================================
   RATING YOUR REPRESENTATIVE
   ========================================================================== */

// Remembers the stars chosen inside the open dialog
var pendingStars = 0;

function openRatingDialog(repId) {
    var rep = DATA.getRep(repId);
    var existing = STATE.ratings[repId];
    pendingStars = existing ? existing.score : 0;

    UI.openModal({
        title: existing ? 'Update your rating' : 'Rate ' + rep.name,
        sub: 'Your feedback is private and helps us match clients with the right representative',
        body: '<div class="stack-4">' +

            UI.person({ name: rep.name, meta: rep.role, size: 'lg', seed: rep.id }) +

            '<div class="field">' +
            '<span class="field-label">How would you rate your experience?</span>' +
            '<div id="star-area">' + UI.starPicker(pendingStars) + '</div>' +
            '<div class="field-hint" id="star-label">' +
            (pendingStars ? starWord(pendingStars) : 'Tap a star to choose') + '</div>' +
            '</div>' +

            '<div class="field">' +
            '<label class="field-label" for="rate-what">What stood out? (optional)</label>' +
            '<select class="select" id="rate-what">' +
            '<option value="">Choose one</option>' +
            '<option>Explained things clearly</option>' +
            '<option>Responded quickly</option>' +
            '<option>Did not feel pushed</option>' +
            '<option>Understood my situation</option>' +
            '<option>Communication could be better</option>' +
            '<option>Felt rushed into a decision</option>' +
            '</select></div>' +

            '<div class="field">' +
            '<label class="field-label" for="rate-note">Anything else? (optional)</label>' +
            '<textarea class="textarea" id="rate-note" placeholder="Your comments go to Prudential, not directly to your representative.">' +
            (existing && existing.comment ? FMT.esc(existing.comment) : '') +
            '</textarea></div>' +

            '<div id="rate-alert"></div>' +
            '</div>',

        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
            UI.btn({ label: existing ? 'Update rating' : 'Submit rating', icon: 'star', act: 'submit-rating', data: { id: repId } })
    });
}

// Turns 1-5 into words, so the number means something
function starWord(n) {
    return ['', 'Poor', 'Below expectations', 'Good', 'Very good', 'Excellent'][n] || '';
}


/* ==========================================================================
   ASKING FOR A DIFFERENT REPRESENTATIVE

   Customers are allowed to change, but there are conditions. We check them
   openly and show the result, rather than letting someone fill in a whole
   form and then rejecting it.
   ========================================================================== */

/* Works out whether this customer may request a change right now.
   Returns a list of rules, each with pass true or false. */
function repChangeRules(customer) {
    var daysAsClient = Math.floor((Date.now() - new Date(customer.clientSince).getTime()) / 86400000);

    // Has a change already been made in the last 12 months?
    var lastChange = STATE.lastRepChange ? new Date(STATE.lastRepChange).getTime() : 0;
    var monthsSinceChange = lastChange ? (Date.now() - lastChange) / (86400000 * 30) : 999;

    return [
        {
            title: 'You have been with your representative for at least 30 days',
            text: 'You joined ' + FMT.dateLong(customer.clientSince) + ', which is ' + daysAsClient + ' days ago.',
            pass: daysAsClient >= 30
        },
        {
            title: 'No application or claim is currently being processed',
            text: 'Changing representative mid-application would delay it, so we finish that first.',
            pass: true
        },
        {
            title: 'No change request already open',
            text: STATE.repChangeRequest
                ? 'You already have a request under review.'
                : 'You have no request in progress.',
            pass: !STATE.repChangeRequest
        },
        {
            title: 'At most one change in a 12-month period',
            text: monthsSinceChange > 900
                ? 'You have not changed representative before.'
                : 'Your last change was about ' + Math.round(monthsSinceChange) + ' months ago.',
            pass: monthsSinceChange >= 12
        }
    ];
}

function openRepChangeDialog() {
    var customer = me();
    var currentRep = DATA.getRep(customer.repId);
    var rules = repChangeRules(customer);
    var allPass = rules.every(function (r) { return r.pass; });

    // Other representatives who could take over
    var others = DATA.reps.filter(function (r) { return r.id !== currentRep.id; });

    var body = '<div class="stack-4">' +

        UI.callout({
            tone: 'info', icon: 'info', title: 'This will not affect your policies',
            text: 'Your cover, premiums and claim history all stay exactly as they are. Only the person ' +
                'who advises you changes.'
        }) +

        '<div class="stack-2"><span class="eyebrow">Eligibility check</span>' +
        rules.map(function (r) { return UI.rule(r); }).join('') + '</div>';

    if (!allPass) {
        // Blocked: explain, and offer the more useful alternative
        body += UI.callout({
            tone: 'warn', icon: 'alertTriangle', title: 'You cannot submit a request just yet',
            text: 'One or more conditions above are not met. If something urgent is wrong, please contact ' +
                'client care directly and they can help straight away.'
        }) + '</div>';

        UI.openModal({
            title: 'Request a different representative',
            sub: 'Reviewed against our reassignment policy',
            size: 'lg',
            body: body,
            foot: UI.btn({ label: 'Close', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Contact client care', icon: 'phone', act: 'contact-care' })
        });
        return;
    }

    body += '<div class="hr"></div>' +

        '<div class="field"><label class="field-label" for="rc-reason">Why would you like to change?</label>' +
        '<select class="select" id="rc-reason">' +
        '<option value="">Please choose</option>' +
        '<option>Communication style is not a good fit</option>' +
        '<option>Slow to respond to my questions</option>' +
        '<option>I felt pushed towards a decision</option>' +
        '<option>I would prefer someone who speaks my first language</option>' +
        '<option>I have moved and would like someone closer</option>' +
        '<option>I would prefer a different gender of representative</option>' +
        '<option>Other</option>' +
        '</select>' +
        '<div class="field-hint">This is only shared with our client care team.</div></div>' +

        '<div class="field"><label class="field-label" for="rc-notes">Anything you would like to add? (optional)</label>' +
        '<textarea class="textarea" id="rc-notes" placeholder="The more we know, the better the match."></textarea></div>' +

        '<div class="field"><label class="field-label" for="rc-preferred">Any preference for who takes over?</label>' +
        '<select class="select" id="rc-preferred">' +
        '<option value="">No preference, please match me</option>' +
        others.map(function (r) {
            return '<option value="' + FMT.esc(r.name) + '">' + FMT.esc(r.name) + ' - ' +
                FMT.esc(r.title) + '</option>';
        }).join('') +
        '</select></div>' +

        '<label class="check"><input type="checkbox" id="rc-confirm">' +
        '<span>I understand my new representative will be given access to my policy file so they can ' +
        'advise me properly.</span></label>' +

        '<div id="rc-alert"></div>' +
        '</div>';

    UI.openModal({
        title: 'Request a different representative',
        sub: 'All conditions met - you can go ahead',
        size: 'lg',
        body: body,
        foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
            UI.btn({ label: 'Submit request', icon: 'send', act: 'submit-rep-change' })
    });
}


/* ==========================================================================
   HANDLERS for the customer pages
   ========================================================================== */
$(function () {

    /* ---- rating ---- */

    $(document).on('click', '[data-act="rate-rep"]', function () {
        openRatingDialog($(this).data('id'));
    });

    // Choosing a star: light up every star up to the one clicked
    $(document).on('click', '[data-act="pick-star"]', function () {
        pendingStars = Number($(this).data('value'));

        $('#star-area .star-pick button').each(function (index) {
            $(this).toggleClass('is-on', index < pendingStars);
        });
        $('#star-label').text(starWord(pendingStars));
    });

    $(document).on('click', '[data-act="submit-rating"]', function () {
        if (!pendingStars) {
            $('#rate-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) + '<span>Please choose a star rating first.</span></div>');
            return;
        }

        var repId = $(this).data('id');
        var highlight = $('#rate-what').val();
        var note = $.trim($('#rate-note').val());

        STATE.ratings[repId] = {
            score: pendingStars,
            highlight: highlight,
            comment: note,
            at: new Date().toISOString()
        };
        saveState();
        UI.closeModal();

        UI.toast({
            title: 'Thank you for your rating',
            message: pendingStars >= 4
                ? 'We will pass your feedback on.'
                : 'Client care will look at this and may get in touch.',
            tone: 'ok'
        });

        router();   // redraw so the new rating shows
    });

    /* ---- changing representative ---- */

    $(document).on('click', '[data-act="change-rep"]', function () {
        openRepChangeDialog();
    });

    $(document).on('click', '[data-act="submit-rep-change"]', function () {
        var reason = $('#rc-reason').val();
        var notes = $.trim($('#rc-notes').val());
        var preferred = $('#rc-preferred').val();
        var confirmed = $('#rc-confirm').is(':checked');

        var problem = null;
        if (!reason) { problem = 'Please choose a reason so we can match you properly.'; }
        else if (reason === 'Other' && !notes) { problem = 'You chose "Other", so please tell us a little more.'; }
        else if (!confirmed) { problem = 'Please confirm the file transfer to continue.'; }

        if (problem) {
            $('#rc-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) + '<span>' + FMT.esc(problem) + '</span></div>');
            return;
        }

        /* A reference number the customer can quote. Date plus a short random
           part, which is enough to look and behave like a real ticket. */
        var reference = 'RC-' + new Date().getFullYear() + '-' +
            Math.floor(1000 + Math.random() * 9000);

        STATE.repChangeRequest = {
            reference: reference,
            reason: reason,
            notes: notes,
            preferred: preferred,
            at: new Date().toISOString()
        };
        saveState();
        UI.closeModal();

        UI.openModal({
            title: 'Request submitted',
            sub: 'Reference ' + reference,
            body: UI.callout({
                tone: 'ok', icon: 'checkCircle', title: 'We have got it',
                text: 'Our client care team reviews reassignment requests within 3 working days and will ' +
                    'email you at ' + me().email + '. Nothing about your cover changes in the meantime.'
            }) +
                UI.kv([
                    ['Reference', reference],
                    ['Reason', reason],
                    ['Preferred representative', preferred || 'No preference'],
                    ['Expected response', 'Within 3 working days']
                ]) +
                '<div class="t-xs muted">You can withdraw this request at any time from your representative\u2019s page.</div>',
            foot: UI.btn({ label: 'Done', act: 'close-modal-reload' })
        });
    });

    $(document).on('click', '[data-act="cancel-rep-change"]', function () {
        UI.confirmModal({
            title: 'Withdraw your request?',
            message: 'Your current representative stays with you and nothing else changes. ' +
                'You can request a change again later.',
            confirmLabel: 'Withdraw request',
            tone: 'danger',
            confirmAct: 'confirm-cancel-rep-change'
        });
    });

    $(document).on('click', '[data-act="confirm-cancel-rep-change"]', function () {
        STATE.repChangeRequest = null;
        saveState();
        UI.closeModal();
        UI.toast({ title: 'Request withdrawn', tone: 'info' });
        router();
    });

    $(document).on('click', '[data-act="contact-care"]', function () {
        UI.closeModal();
        UI.openModal({
            title: 'Client care',
            sub: 'For anything urgent',
            size: 'sm',
            body: UI.kv([
                ['Phone', '1800 333 0333'],
                ['Hours', 'Mon to Fri, 8.45am to 5.30pm'],
                ['Email', 'clientcare@navigator-demo.sg']
            ]) +
                '<div class="t-xs muted">In the live product this would open a direct line to the team.</div>',
            foot: UI.btn({ label: 'Close', act: 'close-modal' })
        });
    });

    // Closes a dialog and redraws the page behind it
    $(document).on('click', '[data-act="close-modal-reload"]', function () {
        UI.closeModal();
        router();
    });


    /* ---- the customer's side of a video call ----
       The microphone and camera buttons are handled once in js/call.js. These
       are only the parts that belong to the customer. */

    /* The two shortcut buttons under the video jump to the right panel tab.
       On a phone the panel starts closed, so open it first. */
    $(document).on('click', '[data-act="me-call-ask"]', function () {
        CALL.openPanel();
        UI.switchTab('mecall', 'ask');
    });

    $(document).on('click', '[data-act="me-call-jot"]', function () {
        CALL.openPanel();
        UI.switchTab('mecall', 'notes');
        window.setTimeout(function () { $('#me-call-notes').trigger('focus'); }, 60);
    });

    // Copy the transcript into the customer's own notes, keeping what is there
    $(document).on('click', '[data-act="me-call-transcript-to-notes"]', function () {
        var transcript = CALL.transcriptText();

        if (!transcript) {
            UI.toast({
                title: 'Nothing written down yet',
                message: 'Turn on live captions with the speech button under the video.',
                tone: 'info'
            });
            return;
        }

        var existing = STATE.myCallNotes ? STATE.myCallNotes + '\n\n' : '';
        STATE.myCallNotes = existing + transcript;
        saveState();

        $('#me-call-notes').val(STATE.myCallNotes);
        UI.toast({ title: 'Added to your notes', tone: 'ok' });
    });

    // Tick a question off once it has been asked
    $(document).on('click', '[data-act="me-call-asked"]', function () {
        var key = $(this).data('key');
        var index = STATE.askedQuestions.indexOf(key);

        if (index === -1) { STATE.askedQuestions.push(key); }
        else { STATE.askedQuestions.splice(index, 1); }

        $(this).toggleClass('done', index === -1);
    });

    // Save the customer's own notes as they type
    $(document).on('input', '#me-call-notes', function () {
        STATE.myCallNotes = $(this).val();
        saveState();
        $('#me-notes-status').text('Saved at ' + FMT.time(new Date()));
    });

    $(document).on('click', '[data-act="me-call-send-notes"]', function () {
        var rep = DATA.getRep(me().repId);

        if (!$.trim(STATE.myCallNotes)) {
            UI.toast({ title: 'Nothing to send yet', message: 'Type a note first.', tone: 'info' });
            return;
        }
        UI.toast({
            title: 'Sent to ' + rep.name.split(' ')[0],
            message: 'Your notes were added to the conversation in Messages.',
            tone: 'ok'
        });
    });

    $(document).on('click', '[data-act="me-call-end"]', function () {
        showMyCallSummary();
    });
});


/* Leaving the call. The customer gets a plain summary and the obvious next
   steps - never a decision to make on the spot.

   CALL.finish() returns a PROMISE now, because the talking time is worked out on
   the server from when both sides were actually connected. Our own clock has
   been running since the page opened, which is a different number. See
   php/api/call-end.php.

   Also called from onRemoteEnd when the representative hangs up first, so the
   customer sees the same summary either way rather than a screen that just
   stops. */
function showMyCallSummary() {
    var c = me();
    var rep = DATA.getRep(c.repId);
    var totalQuestions = STATE.questions.length + AI.questionsFor(c).length;

    CALL.finish().then(function (ended) {
        UI.openModal({
            title: 'Call ended',
            sub: 'A quick summary for you',
            body: UI.kv([
                ['Spoke with', rep.name],
                ['Talking time', ended.text],
                ['Questions you asked', STATE.askedQuestions.length + ' of ' + totalQuestions],
                ['Written down', ended.lines
                    ? ended.lines + (ended.lines === 1 ? ' line captured' : ' lines captured')
                    : 'Captions were off'],
                ['Your notes', STATE.myCallNotes ? 'Saved on this device' : 'None taken']
            ]) +
                UI.callout({
                    tone: 'info', icon: 'shield', title: 'Nothing has been signed',
                    text: 'A call is a conversation, not a commitment. If anything was recommended, ' +
                        'ask for it in writing and take as long as you need.'
                }) +

                /* Tells them a write-up is coming, without promising when.

                   WHY THIS IS WORDED CAREFULLY: the representative has to approve
                   the draft before it sends, so it is genuinely "usually" and not
                   "in a moment". Saying it will arrive shortly and then having it
                   not arrive - because the representative closed the tab - would
                   be worse than not mentioning it. */
                UI.callout({
                    tone: 'brand', icon: 'messageCircle', title: 'A written summary usually follows',
                    text: rep.name.split(' ')[0] + ' will normally send a summary of what you ' +
                        'discussed into your conversation, so you have it in writing. If it does ' +
                        'not turn up, ask - it is a reasonable thing to expect.'
                }) +
                UI.disclaimer('short'),

            foot: UI.btn({ label: 'Back to home', variant: 'ghost', href: '#/me/dashboard', act: 'close-modal' }) +
                UI.btn({
                    label: 'Message ' + rep.name.split(' ')[0], icon: 'messageCircle',
                    href: '#/me/messages', act: 'close-modal'
                })
        });
    });
}
