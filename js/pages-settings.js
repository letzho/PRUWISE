/* ==========================================================================
   pages-settings.js
   --------------------------------------------------------------------------
   /settings - one page, shared by all three roles.

   Everything about your own account lives here: your name, your phone number,
   your email address, your password, and how the app behaves for you.

   FOUR THINGS, FOUR DIFFERENT LEVELS OF CARE

   The page is deliberately not one big "Save" button, because these changes are
   not equally serious and should not feel equally casual:

     name and phone   saved on their own, no confirmation needed
     preferences      saved as you toggle them
     email address    needs your password, AND the new address has to be
                      confirmed by clicking a link before it takes effect
     password         needs your CURRENT password, and signs out other devices

   Grouping them into one form would mean the least dangerous change carried
   the same friction as the most dangerous one, or - worse - the other way
   round.

   Every rule here is enforced again in php/api/update-profile.php and
   php/api/change-password.php. What is in this file is only about making the
   form pleasant; the server is what makes it safe.
   ========================================================================== */

PAGES['/settings'] = {
    title: 'Settings',
    sub: 'Your account and how the app behaves',

    render: function () {
        var s = STATE.session;
        if (!s) { return UI.loadingState('Loading your account...'); }

        return UI.pageHead({
            eyebrow: 'My account',
            title: 'Settings',
            sub: 'Your details, your password, and how PRUWise behaves for you.'
        }) +
            '<div class="split split-rail">' +
            '<div class="stack">' +
            settingsProfileCard(s) +

            /* Customers only. A representative has no financial record here -
               theirs is a professional profile, edited on their own screen. */
            (s.role === 'customer' ? '<div id="set-finances"></div>' : '') +

            settingsEmailCard(s) +
            settingsPasswordCard() +
            '</div>' +
            '<div class="stack">' +
            settingsAccountCard(s) +
            settingsPrefsCard(s) +
            settingsSecurityCard(s) +
            settingsBuildCard() +
            '</div>' +
            '</div>';
    },

    after: function () {
        if (STATE.session && STATE.session.role === 'customer') { loadFinancesCard(); }
    }
};


/* ==========================================================================
   WHICH BUILD AM I LOOKING AT?
   --------------------------------------------------------------------------
   A small card at the bottom of the rail, and it exists for one practical
   reason: after uploading to a shared host there is no way to tell whether the
   browser in front of you is running the files you just sent, or a cached copy
   from last week.

   That is not hypothetical. A misspelt formatter was fixed and uploaded, and the
   live site kept throwing the identical error for two more rounds, because
   index.html still said ?v=2 - so no browser ever requested the new file. This
   card turns that from a guess into a glance.

   APP_BUILD lives at the top of js/app.js and must match the ?v= in index.html.
   Reading it here means the number shown is the one the browser ACTUALLY
   executed, not the one the file sitting on the server claims.
   ========================================================================== */

function settingsBuildCard() {

    /* Read defensively. If app.js somehow did not load then the whole app is
       broken and this card is the least of the problems - but it must not be the
       thing that throws and hides everything else. */
    var build = (typeof APP_BUILD !== 'undefined') ? APP_BUILD : 'unknown';

    return UI.card({ title: 'App version', icon: 'info' },
        UI.kv([
            ['Build', String(build)],
            ['Served from', String(window.location.host || 'this device')]
        ]) +
        '<div class="t-xs muted">If you have just uploaded a change and this number has not ' +
        'moved, the browser is still running the old copy. A hard refresh fetches everything ' +
        'again - Ctrl+Shift+R, or Cmd+Shift+R on a Mac.</div>' +
        UI.btn({ label: 'Force a fresh copy', variant: 'outline', size: 'sm', block: true,
                 icon: 'refresh', act: 'hard-reload' })
    );
}


/* ==========================================================================
   YOUR FINANCIAL DETAILS
   --------------------------------------------------------------------------
   The customer's own figures - income, savings, CPF, mortgage, what they can
   afford each month. Everything here is entered by them and nobody else can
   change it: php/api/finances.php refuses a write from any account that is not
   the owner, including their own representative.

   WHY IT IS WORTH ASKING FOR AT ALL

   Without it, a self-registered customer's dashboard has no numbers, and their
   representative opens their profile to a "this is sample data" caveat. With it,
   the protection gap on both screens is genuinely theirs, calculated by
   finances_needs() in php/lib/finances.php - one function on the server, so the
   two screens can never disagree.

   WHY EVERY FIELD IS OPTIONAL

   A form of fourteen money questions with a "required" star on each one is a
   form nobody finishes. Three answered fields are more useful than none, so the
   server treats an absent field as "leave alone" and an empty one as "clear it",
   and the calculation says so honestly when there is not enough to work with.
   ========================================================================== */

/* One row of the form. `hint` earns its place only where the question is
   genuinely ambiguous - a hint under every field is noise that stops being read. */
function moneyField(id, label, value, opts) {
    opts = opts || {};

    return '<div class="field">' +
        '<label class="field-label" for="fin-' + id + '">' + FMT.esc(label) + '</label>' +
        '<div class="fin-input">' +
        (opts.plain ? '' : '<span class="fin-prefix">$</span>') +
        '<input class="input' + (opts.plain ? '' : ' fin-money') + '" id="fin-' + id + '" ' +
        'type="text" inputmode="numeric" autocomplete="off" ' +
        'placeholder="' + FMT.esc(opts.placeholder || '') + '" ' +
        'value="' + (value === null || value === undefined ? '' : FMT.esc(String(value))) + '">' +
        (opts.suffix ? '<span class="fin-suffix">' + FMT.esc(opts.suffix) + '</span>' : '') +
        '</div>' +
        (opts.hint ? '<div class="field-hint">' + FMT.esc(opts.hint) + '</div>' : '') +
        '</div>';
}

function loadFinancesCard() {
    var $box = $('#set-finances');
    if (!$box.length) { return; }

    $box.html(UI.loadingState('Loading your financial details\u2026'));

    API.getFinances().then(

        function (data) { drawFinancesCard(data); },

        function (err) {
            /* A real error state with a retry, not a silent empty panel. This is
               a section somebody navigated to Settings specifically to fill in. */
            $box.html(UI.card({ title: 'Your financial details', icon: 'dollarSign' },
                UI.errorState({
                    title: 'Could not load your figures',
                    text: (err && err.error) ? err.error : 'Please try again.',
                    plain: true,
                    actions: UI.btn({ label: 'Try again', variant: 'outline', icon: 'refresh',
                                      act: 'fin-reload' })
                })
            ));
        }
    );
}

function drawFinancesCard(data) {
    var f = (data && data.finances) ? data.finances : {};
    var needs = (data && data.needs) ? data.needs : null;

    /* What the numbers are FOR, shown before the form rather than after it.
       Fourteen money questions with no stated purpose is an interrogation; the
       same questions with a reason attached is a service. */
    var why = needs
        ? UI.callout({
            tone: 'ok', icon: 'checkCircle',
            title: 'Your protection figures are being calculated from these',
            text: 'Based on what you have entered, the suggested cover is ' +
                FMT.money(needs.totalNeed) + ' and your shortfall is ' +
                FMT.money(needs.gap) + '. Your representative sees the same figures.'
        })
        : UI.callout({
            tone: 'info', icon: 'info',
            title: 'Nothing is required, and nothing is shared beyond your representative',
            text: 'Fill in what you know. Your annual income alone is enough to work out an ' +
                'indicative protection gap - everything else makes it more accurate. Only you ' +
                'can edit this; your representative can read it but not change it.'
        });

    $('#set-finances').html(UI.card({
        title: 'Your financial details',
        sub: f.updatedAt ? 'Last updated ' + FMT.relative(f.updatedAt) : 'Not filled in yet',
        icon: 'dollarSign'
    },
        why +

        '<form id="set-finances-form" class="stack-4" novalidate>' +

        '<div class="fin-group-label">Income and outgoings</div>' +
        '<div class="fin-grid">' +
        moneyField('annualIncome', 'Annual income', f.annualIncome,
            { placeholder: '96000', hint: 'Before tax and CPF. The one figure everything else builds on.' }) +
        moneyField('monthlyIncome', 'Monthly take-home', f.monthlyIncome, { placeholder: '6500' }) +
        moneyField('monthlyExpenses', 'Monthly living expenses', f.monthlyExpenses, { placeholder: '2800' }) +
        moneyField('monthlyCommitments', 'Monthly commitments', f.monthlyCommitments,
            { placeholder: '1200', hint: 'Loans, childcare, anything already committed and hard to stop.' }) +
        moneyField('premiumBudget', 'What you could put towards a plan', f.premiumBudget,
            { placeholder: '300', suffix: '/month',
              hint: 'Be honest rather than optimistic - a plan you keep beats a bigger one you cancel.' }) +
        '</div>' +

        '<div class="fin-group-label">What you already have</div>' +
        '<div class="fin-grid">' +
        moneyField('savings', 'Savings and cash', f.savings, { placeholder: '25000' }) +
        moneyField('cpf', 'CPF balance', f.cpf, { placeholder: '40000' }) +
        '</div>' +

        '<div class="fin-group-label">What you owe</div>' +
        '<div class="fin-grid">' +
        moneyField('mortgage', 'Outstanding mortgage', f.mortgage, { placeholder: '320000' }) +
        moneyField('otherDebt', 'Other debt', f.otherDebt,
            { placeholder: '0', hint: 'Car loan, study loan, anything that would still be owed.' }) +
        '</div>' +

        '<div class="fin-group-label">Your household and plans</div>' +
        '<div class="fin-grid">' +
        moneyField('dependants', 'People who depend on your income', f.dependants,
            { plain: true, placeholder: '2',
              hint: 'This decides how many years of income the calculation replaces.' }) +
        moneyField('retireAge', 'Age you would like to retire', f.retireAge,
            { plain: true, placeholder: '62' }) +
        moneyField('retireMonthlyTarget', 'Monthly income you would want then', f.retireMonthlyTarget,
            { placeholder: '4000', suffix: '/month' }) +
        '</div>' +

        '<div class="fin-group-label">Cover you already hold elsewhere</div>' +
        '<div class="fin-grid">' +
        moneyField('existingLifeCover', 'Life / death benefit', f.existingLifeCover,
            { placeholder: '0', hint: 'Including anything through your employer.' }) +
        moneyField('existingCiCover', 'Critical illness', f.existingCiCover, { placeholder: '0' }) +
        '</div>' +
        '<div class="field-hint">Telling us about cover you already hold makes your gap smaller ' +
        'and more accurate. Leaving it out would overstate what you need.</div>' +

        '<div id="set-finances-alert"></div>' +

        UI.btn({
            label: 'Save my figures', icon: 'check', size: 'sm',
            type: 'submit', cls: 'set-finances-submit'
        }) +
        '</form>'
    ) + financeLogCard(data));
}


/* ==========================================================================
   WHAT CHANGED, WHEN, AND WHO CHANGED IT
   --------------------------------------------------------------------------
   ==========================================================================
   THREE DIFFERENT PARTIES CAN NOW MOVE THESE NUMBERS
   ==========================================================================

   The client edits them here. The representative confirms a change PRUWise read
   out of a conversation. And PRUWise is the thing that proposed it.

   customer_finances holds only the CURRENT value, so before this the answer to
   "why does it say ninety-five thousand when I told you a hundred and ten" was
   that nobody knew. Every one of those three routes is a legitimate way for the
   figure to move, which is exactly why the record has to say which one it was.

   ==========================================================================
   THE 'ai' ENTRIES CARRY THE WORDS THAT CAUSED THEM
   ==========================================================================

   "Your representative confirmed this from your call on Tuesday" is only
   reassuring if it can show the sentence. Without the quote an entry like that is
   not much better than no entry - and it is the one kind somebody is most likely
   to want to check, because it is the one they did not do themselves.

   Nothing here is editable. It is a log.
   ========================================================================== */

/* source -> how to say it, and to whom. `self` reads differently depending on
   whether you are the person who did it. */
function financeSourceLabel(source, by, whose) {
    if (source === 'self') {
        return whose === 'self' ? 'You changed this' : 'They changed this themselves';
    }
    if (source === 'ai') {
        return (by ? by : 'Your representative') + ' confirmed this from a conversation';
    }
    if (source === 'rep') {
        return (by ? by : 'Your representative') + ' changed this';
    }
    return 'Changed by the system';
}

function financeLogCard(data) {
    var rows = (data && data.changes) ? data.changes : [];
    var whose = (data && data.whose) ? data.whose : 'self';

    /* NOT DRAWN AT ALL WHEN THERE IS NOTHING IN IT. A permanent "no changes yet"
       panel under a form somebody has just filled in for the first time is noise
       about a feature they have no way to have used. */
    if (!rows.length) { return ''; }

    var list = rows.map(function (c) {
        var money = (c.field !== 'dependants' && c.field !== 'retire_age');

        var show = function (value) {
            if (value === null || value === '') { return 'not set'; }
            return money ? FMT.money(Number(value)) : String(value);
        };

        return '<li class="fin-log-row">' +
            '<div class="fin-log-head">' +
            '<span class="fin-log-field">' + FMT.esc(c.label) + '</span>' +
            '<span class="fin-log-when">' + FMT.esc(FMT.friendly(c.at)) + '</span>' +
            '</div>' +

            '<div class="fin-log-change">' +
            '<span class="fin-log-was">' + FMT.esc(show(c.oldValue)) + '</span>' +
            UI.icon('arrowRight', 12) +
            '<span class="fin-log-now">' + FMT.esc(show(c.newValue)) + '</span>' +
            '</div>' +

            '<div class="fin-log-by">' +
            UI.icon(c.source === 'ai' ? 'sparkles' : 'user', 11) +
            '<span>' + FMT.esc(financeSourceLabel(c.source, c.by, whose)) + '</span>' +
            '</div>' +

            /* The evidence, for an entry somebody did not make themselves. */
            (c.quote
                ? '<blockquote class="fin-log-quote">' + UI.icon('messageCircle', 11) +
                  '<span>' + FMT.esc(c.quote) + '</span></blockquote>'
                : '') +
            '</li>';
    }).join('');

    return UI.card({
        title: 'History of changes',
        sub: rows.length + (rows.length === 1 ? ' change' : ' changes') + ' to these figures',
        icon: 'clipboard'
    },
        '<div class="t-xs muted">Every change to the figures above is recorded here, ' +
        'including any that PRUWise read from a conversation and your representative ' +
        'confirmed. If something looks wrong, correct it in the form above - only you ' +
        'can.</div>' +
        '<ul class="fin-log">' + list + '</ul>'
    );
}


/* ---------------------------------------------------------------- handlers --- */

$(document).on('click', '[data-act="fin-reload"]', function () { loadFinancesCard(); });

$(document).on('submit', '#set-finances-form', function (e) {
    e.preventDefault();

    var $btn = $('.set-finances-submit');
    if ($btn.hasClass('is-loading')) { return; }

    /* Built from the same key list the server uses, so a field added to one side
       does not silently go missing on the other. An untouched empty box is sent
       as '' which CLEARS that value - correct, because the box being empty is
       exactly what the person is telling us. */
    var keys = ['annualIncome', 'monthlyIncome', 'monthlyExpenses', 'monthlyCommitments',
                'premiumBudget', 'savings', 'cpf', 'mortgage', 'otherDebt', 'dependants',
                'retireAge', 'retireMonthlyTarget', 'existingLifeCover', 'existingCiCover'];

    var changes = {};

    for (var i = 0; i < keys.length; i++) {
        var $input = $('#fin-' + keys[i]);
        if ($input.length) { changes[keys[i]] = $.trim($input.val()); }
    }

    $('#set-finances-alert').empty();
    $btn.addClass('is-loading').prop('disabled', true);

    API.saveFinances(changes).then(

        function (data) {
            /* Redraw from the SERVER'S copy, not from what was typed. The server
               strips commas and dollar signs and rounds to whole dollars, so
               redrawing from the response is what shows the person what was
               actually stored. */
            drawFinancesCard(data);

            UI.toast({
                title: 'Saved',
                message: data.message || 'Your figures have been updated.',
                tone: 'ok'
            });

            /* The dashboard reads these for the protection gap, so its cached
               copy is now stale. Dropping it means the next visit refetches. */
            if (window.ONBOARDING && ONBOARDING.forget) { ONBOARDING.forget(); }
        },

        function (err) {
            $btn.removeClass('is-loading').prop('disabled', false);

            /* Next to the form, not as a toast. The server's message names which
               figure it objected to, and that belongs beside the boxes. */
            $('#set-finances-alert').html(UI.callout({
                tone: 'warn', icon: 'alertTriangle', title: err.error
            }));
        }
    );
});


/* ==========================================================================
   NAME AND PHONE
   ========================================================================== */
function settingsProfileCard(s) {
    return UI.card({
        title: 'Your details',
        sub: 'How your name appears to the people you talk to',
        icon: 'user'
    },
        '<form id="set-profile-form" class="stack-4" novalidate>' +

        '<div class="field">' +
        '<label class="field-label" for="set-name">Full name</label>' +
        '<input class="input" id="set-name" type="text" autocomplete="name" ' +
        'value="' + FMT.esc(s.name) + '">' +
        '</div>' +

        '<div class="field">' +
        '<label class="field-label" for="set-phone">Phone number</label>' +
        '<input class="input" id="set-phone" type="tel" autocomplete="tel" ' +
        'placeholder="+65 9123 4567" value="' + FMT.esc(s.phone || '') + '">' +
        '<div class="field-hint">Include the country code. Leave it blank if you would rather ' +
        'not give one.</div>' +
        '</div>' +

        '<div id="set-profile-alert"></div>' +

        UI.btn({
            label: 'Save my details', icon: 'check', size: 'sm',
            type: 'submit', cls: 'set-profile-submit'
        }) +
        '</form>'
    );
}


/* ==========================================================================
   EMAIL ADDRESS
   ========================================================================== */
function settingsEmailCard(s) {
    /* The unconfirmed warning comes first, because it is the one thing on this
       page that can quietly cost somebody their account: an unconfirmed address
       means a password reset has nowhere to go. */
    var warning = s.emailVerified
        ? UI.callout({
            tone: 'ok', icon: 'checkCircle', title: 'This address is confirmed',
            text: 'Password reset links will reach you here.'
        })
        : UI.callout({
            tone: 'warn', icon: 'alertTriangle', title: 'This address is not confirmed yet',
            text: 'Until it is, a password reset cannot reach you. If you lose your password ' +
                'you would need an administrator to help.'
        }) +
        UI.btn({
            label: 'Send the confirmation link again', variant: 'outline', size: 'sm',
            icon: 'mail', act: 'set-resend-confirm'
        });

    return UI.card({
        title: 'Email address',
        sub: 'Used for signing in problems and password resets',
        icon: 'mail'
    },
        '<div class="stack-4">' +
        UI.kv([['Current address', s.email]]) +
        warning +
        '<div class="hr"></div>' +

        '<form id="set-email-form" class="stack-4" novalidate>' +
        '<span class="eyebrow">Change it</span>' +

        '<div class="field">' +
        '<label class="field-label" for="set-email">New email address</label>' +
        '<input class="input" id="set-email" type="email" autocomplete="email" ' +
        'placeholder="you@example.com">' +
        '</div>' +

        '<div class="field">' +
        '<label class="field-label" for="set-email-pass">Your password</label>' +
        '<span class="input-wrap has-icon"><span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
        '<input class="input" id="set-email-pass" type="password" autocomplete="current-password" ' +
        'placeholder="Confirm it is you"></span>' +
        '<div class="field-hint">Changing where password resets go is a security action, so it ' +
        'needs your password.</div>' +
        '</div>' +

        '<div id="set-email-alert"></div>' +

        UI.callout({
            tone: 'info', icon: 'info', title: 'Your old address keeps working until you confirm',
            text: 'We email the new address a link. Nothing changes until you click it, so a typo ' +
                'cannot lock you out.'
        }) +

        UI.btn({
            label: 'Send the confirmation link', icon: 'send', size: 'sm',
            type: 'submit', cls: 'set-email-submit'
        }) +
        '</form>' +
        '</div>'
    );
}


/* ==========================================================================
   PASSWORD
   ========================================================================== */
function settingsPasswordCard() {
    return UI.card({
        title: 'Password',
        sub: 'You need your current one to set a new one',
        icon: 'lock'
    },
        '<form id="set-password-form" class="stack-4" novalidate>' +

        '<div class="field">' +
        '<label class="field-label" for="set-pass-old">Current password</label>' +
        '<span class="input-wrap has-icon"><span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
        '<input class="input" id="set-pass-old" type="password" autocomplete="current-password" ' +
        'placeholder="The one you use now"></span>' +
        '</div>' +

        '<div class="field">' +
        '<label class="field-label" for="set-pass-new">New password</label>' +
        '<span class="input-wrap has-icon has-btn">' +
        '<span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
        '<input class="input" id="set-pass-new" type="password" autocomplete="new-password" ' +
        'placeholder="At least 8 characters">' +
        '<button type="button" class="input-btn" data-act="set-reveal-new" ' +
        'aria-label="Show password">' + UI.icon('eye', 16) + '</button></span>' +
        '<div class="field-hint">Length beats complexity. A few unrelated words is stronger than ' +
        'one word with symbols in it.</div>' +
        '</div>' +

        '<div class="field">' +
        '<label class="field-label" for="set-pass-new2">Confirm new password</label>' +
        '<span class="input-wrap has-icon"><span class="input-icon">' + UI.icon('lock', 16) + '</span>' +
        '<input class="input" id="set-pass-new2" type="password" autocomplete="new-password" ' +
        'placeholder="Type it again"></span>' +
        '</div>' +

        '<label class="check"><input type="checkbox" id="set-pass-signout" checked>' +
        '<span>Sign out my other devices</span></label>' +
        '<div class="field-hint">Leave this on unless you know why you are turning it off. If ' +
        'somebody else has your password, this is what removes their access.</div>' +

        '<div id="set-password-alert"></div>' +

        UI.btn({
            label: 'Change my password', icon: 'lock', size: 'sm',
            type: 'submit', cls: 'set-password-submit'
        }) +
        '</form>'
    );
}


/* ==========================================================================
   THE ACCOUNT ITSELF - read only
   ========================================================================== */
function settingsAccountCard(s) {
    var roleNames = {
        admin: 'Administrator',
        fr: 'Financial Representative',
        customer: 'Client'
    };

    return UI.card({ title: 'This account', icon: 'shield' },
        '<div class="row-2" style="margin-bottom:12px">' +
        UI.avatar(s.name, 'lg', { seed: s.personId }) +
        '<div style="min-width:0">' +
        '<div class="t-sm semi truncate">' + FMT.esc(s.name) + '</div>' +
        '<div class="t-xs muted truncate">' + FMT.esc(s.username) + '</div>' +
        '</div></div>' +

        UI.kv([
            ['Role', roleNames[s.role] || s.role],
            ['Username', s.username + ' (cannot be changed)'],
            ['Account id', String(s.accountId)],
            ['Joined', s.createdAt ? FMT.dateLong(s.createdAt) : '-'],
            ['Last signed in', s.lastLogin ? FMT.relative(s.lastLogin) : 'This is your first time']
        ]) +

        /* Honest about the sample data. A self-registered account has no entry
           in js/data.js, so the policy figures it shows belong to the sample
           customer - saying so is better than letting somebody believe those
           numbers are theirs. */
        (s.role === 'customer' && !s.hasSampleProfile
            ? UI.callout({
                tone: 'info', icon: 'info', title: 'Your policy figures are sample data',
                text: 'This is a prototype, so a new account has no real policies. The cover, ' +
                    'premiums and recommendations you see come from a sample profile. Your ' +
                    'messages, appointments and account details are genuinely yours.'
            })
            : '')
    );
}


/* ==========================================================================
   PREFERENCES - saved as you change them
   ========================================================================== */
function settingsPrefsCard(s) {
    var p = s.prefs || {};

    function toggle(id, label, hint, on) {
        return '<div class="stack-2" style="gap:2px">' +
            '<label class="check"><input type="checkbox" id="' + id + '"' +
            (on ? ' checked' : '') + '><span>' + FMT.esc(label) + '</span></label>' +
            '<div class="field-hint">' + FMT.esc(hint) + '</div></div>';
    }

    return UI.card({
        title: 'Preferences',
        sub: 'Saved as you change them',
        icon: 'settings'
    },
        '<div class="stack-4">' +

        '<div class="field">' +
        '<label class="field-label" for="set-theme">Appearance</label>' +
        '<select class="select" id="set-theme">' +
        ['system', 'light', 'dark'].map(function (value) {
            var labels = {
                system: 'Follow my device',
                light: 'Always light',
                dark: 'Always dark'
            };
            return '<option value="' + value + '"' +
                (value === (p.theme || 'system') ? ' selected' : '') + '>' +
                labels[value] + '</option>';
        }).join('') +
        '</select>' +
        '<div class="field-hint">Saved to your account, so it follows you to another device.</div>' +
        '</div>' +

        '<div class="hr"></div>' +

        toggle('set-notif-email', 'Email me about important updates',
            'Password changes and security notices are always sent, whatever this says.',
            p.emailNotifications) +

        toggle('set-notif-sms', 'Text me about appointments',
            'Not wired up in this prototype - the preference is stored, nothing is sent.',
            p.smsNotifications) +

        toggle('set-speech', 'Read PRUWise suggestions aloud during a call',
            'Uses your browser\u2019s own speech, so nothing is sent anywhere to do it. ' +
            'It stays silent while your microphone is on, so the other person never ' +
            'hears it. Messages have their own "Read aloud" button and do not need ' +
            'this switch.',
            p.speechEnabled) +

        '<div id="set-prefs-status" class="t-xs muted"></div>' +
        '</div>'
    );
}


/* ==========================================================================
   SECURITY
   ========================================================================== */
function settingsSecurityCard(s) {
    return UI.card({ title: 'Security', icon: 'lock' },
        '<div class="stack-4">' +

        '<div class="stack-2" style="gap:2px">' +
        '<span class="t-sm semi">Signed in somewhere you should not be?</span>' +
        '<div class="t-xs muted">This ends every session, including this one, so you will need ' +
        'to sign in again.</div>' +
        '</div>' +
        UI.btn({
            label: 'Sign out everywhere', variant: 'outline', size: 'sm', icon: 'logOut',
            block: true, act: 'set-signout-all'
        }) +

        '<div class="hr"></div>' +

        UI.callout({
            tone: 'info', icon: 'shield', title: 'What we never do',
            text: 'Nobody, including an administrator, can see your password. It is stored only as ' +
                'a one-way hash. An administrator can send you a reset link, but they cannot read ' +
                'or choose your password for you.'
        }) +

        /* ------------------------------------------------- close account

           Last on the page, behind its own divider, in the danger colour.
           Deliberately the hardest thing to reach by accident: an administrator
           is refused outright by the endpoint, and everybody else has to type
           the word DELETE and give their password. */
        '<div class="hr"></div>' +

        '<div class="stack-2" style="gap:2px">' +
        '<span class="t-sm semi" style="color:var(--bad)">Close my account</span>' +
        '<div class="t-xs muted">Permanent. Your policies, messages, appointments and ' +
        'assessment are all removed, and this cannot be undone.</div>' +
        '</div>' +
        UI.btn({
            label: 'Close my account', variant: 'outline', size: 'sm', icon: 'trash',
            block: true, act: 'set-delete-account', cls: 'btn-danger-outline'
        }) +
        '</div>'
    );
}


/* ==========================================================================
   HANDLERS
   ========================================================================== */
$(function () {

    /* One place that shows a message under whichever form it belongs to. */
    function alertIn(where, text, tone) {
        $(where).html('<div class="login-alert ' + (tone || '') + '" role="alert">' +
            UI.icon(tone === 'ok' ? 'checkCircle' : 'alertCircle', 15) +
            '<span>' + FMT.esc(text) + '</span></div>');
    }

    /* After any successful change the server sends the whole account back, so
       we replace our copy rather than patching it and risking drift. */
    function adoptAccount(account) {
        STATE.session = account;

        if (account.prefs && account.prefs.theme) {
            STATE.theme = (account.prefs.theme === 'system') ? null : account.prefs.theme;
            saveState();
            applyTheme();
        }
    }


    /* ------------------------------------------------------- name + phone */

    $(document).on('submit', '#set-profile-form', function (e) {
        e.preventDefault();

        var $submit = $('.set-profile-submit');
        if ($submit.hasClass('is-loading')) { return; }

        $('#set-profile-alert').empty();
        $submit.addClass('is-loading').prop('disabled', true);

        API.updateProfile({
            name: $.trim($('#set-name').val()),
            phone: $.trim($('#set-phone').val())
        }).then(
            function (data) {
                $submit.removeClass('is-loading').prop('disabled', false);
                adoptAccount(data.account);

                UI.toast({ title: data.message, tone: 'ok' });

                // The name shows in the topbar and sidebar, so redraw those
                router();
            },
            function (err) {
                $submit.removeClass('is-loading').prop('disabled', false);
                alertIn('#set-profile-alert', err.error);

                if (err.field === 'phone') { $('#set-phone').trigger('focus'); }
                else { $('#set-name').trigger('focus'); }
            }
        );
    });


    /* ---------------------------------------------------- email address */

    $(document).on('submit', '#set-email-form', function (e) {
        e.preventDefault();

        var $submit = $('.set-email-submit');
        if ($submit.hasClass('is-loading')) { return; }

        var email = $.trim($('#set-email').val()).toLowerCase();
        var password = $('#set-email-pass').val();

        if (!email) {
            alertIn('#set-email-alert', 'Enter the new email address.');
            $('#set-email').trigger('focus');
            return;
        }
        if (!password) {
            alertIn('#set-email-alert', 'Enter your password to confirm the change.');
            $('#set-email-pass').trigger('focus');
            return;
        }

        $('#set-email-alert').empty();
        $submit.addClass('is-loading').prop('disabled', true);

        API.updateProfile({ email: email, currentPassword: password }).then(

            function (data) {
                $submit.removeClass('is-loading').prop('disabled', false);
                adoptAccount(data.account);

                // Never leave a password sitting in a form field
                $('#set-email-pass').val('');
                $('#set-email').val('');

                alertIn('#set-email-alert', data.message, 'ok');
                UI.toast({ title: 'Check your new inbox', message: data.message, tone: 'ok' });

                if (data.pendingEmail && data.pendingEmail.devLink) {
                    showEmailDevLink('Confirm ' + data.pendingEmail.email,
                        data.pendingEmail.devLink, data.pendingEmail.emailRoute);
                }
            },

            function (err) {
                $submit.removeClass('is-loading').prop('disabled', false);
                alertIn('#set-email-alert', err.error);

                if (err.field === 'currentPassword') {
                    $('#set-email-pass').val('').trigger('focus');
                } else {
                    $('#set-email').trigger('focus');
                }
            }
        );
    });

    $(document).on('click', '[data-act="set-resend-confirm"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        $btn.addClass('is-loading').prop('disabled', true);

        API.resendConfirmation().then(
            function (data) {
                $btn.removeClass('is-loading').prop('disabled', false);
                UI.toast({ title: 'Confirmation link sent', message: data.message, tone: 'ok' });

                if (data.devLink) {
                    showEmailDevLink('Confirm your email address', data.devLink, data.emailRoute);
                }
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                UI.toast({ title: 'Could not send it', message: err.error, tone: 'warn' });
            }
        );
    });


    /* ------------------------------------------------------------ password */

    $(document).on('click', '[data-act="set-reveal-new"]', function () {
        var $input = $('#set-pass-new');
        var nowText = ($input.attr('type') === 'password');

        $input.attr('type', nowText ? 'text' : 'password');
        $(this).html(UI.icon(nowText ? 'eyeOff' : 'eye', 16))
            .attr('aria-label', nowText ? 'Hide password' : 'Show password');
    });

    $(document).on('submit', '#set-password-form', function (e) {
        e.preventDefault();

        var $submit = $('.set-password-submit');
        if ($submit.hasClass('is-loading')) { return; }

        var current = $('#set-pass-old').val();
        var first = $('#set-pass-new').val();
        var second = $('#set-pass-new2').val();
        var signOutOthers = $('#set-pass-signout').is(':checked');

        if (!current) {
            alertIn('#set-password-alert', 'Enter your current password.');
            $('#set-pass-old').trigger('focus');
            return;
        }
        if (!first) {
            alertIn('#set-password-alert', 'Choose a new password.');
            $('#set-pass-new').trigger('focus');
            return;
        }

        /* The only check that genuinely belongs in the browser: the server is
           sent one password, so it cannot possibly tell whether two matched. */
        if (first !== second) {
            alertIn('#set-password-alert', 'Those two new passwords do not match.');
            $('#set-pass-new2').trigger('focus').trigger('select');
            return;
        }

        $('#set-password-alert').empty();
        $submit.addClass('is-loading').prop('disabled', true);

        API.changePassword(current, first, signOutOthers).then(

            function (data) {
                $submit.removeClass('is-loading').prop('disabled', false);

                // Clear all three, so nothing is left on screen
                $('#set-pass-old, #set-pass-new, #set-pass-new2').val('');

                alertIn('#set-password-alert', data.message, 'ok');
                UI.toast({ title: 'Password changed', message: data.message, tone: 'ok' });
            },

            function (err) {
                $submit.removeClass('is-loading').prop('disabled', false);
                alertIn('#set-password-alert', err.error);

                if (err.field === 'currentPassword') {
                    $('#set-pass-old').val('').trigger('focus');
                } else {
                    $('#set-pass-new').trigger('focus');
                }
            }
        );
    });


    /* --------------------------------------------------------- preferences

       Saved on change rather than behind a button. These are all reversible in
       one click, so asking somebody to confirm a toggle would be noise. */
    var prefsTimer = null;

    function savePrefs() {
        $('#set-prefs-status').text('Saving...');

        API.updateProfile({
            prefs: {
                theme:              $('#set-theme').val(),
                emailNotifications: $('#set-notif-email').is(':checked'),
                smsNotifications:   $('#set-notif-sms').is(':checked'),
                speechEnabled:      $('#set-speech').is(':checked')
            }
        }).then(
            function (data) {
                adoptAccount(data.account);
                $('#set-prefs-status').text('Saved at ' + FMT.time(new Date()));
            },
            function (err) {
                $('#set-prefs-status').text('');
                UI.toast({ title: 'Could not save that', message: err.error, tone: 'warn' });
            }
        );
    }

    $(document).on('change', '#set-theme, #set-notif-email, #set-notif-sms, #set-speech', function () {
        /* Debounced, so flicking three switches quickly is one request rather
           than three racing each other. */
        window.clearTimeout(prefsTimer);
        prefsTimer = window.setTimeout(savePrefs, 250);
    });


    /* ------------------------------------------------- sign out everywhere */

    $(document).on('click', '[data-act="set-signout-all"]', function () {
        UI.confirmModal({
            title: 'Sign out on every device?',
            message: 'Every session ends, including this one. You will need to sign in again here. ' +
                'Your password does not change.',
            confirmLabel: 'Sign out everywhere',
            tone: 'danger',
            confirmAct: 'set-confirm-signout-all'
        });
    });

    $(document).on('click', '[data-act="set-confirm-signout-all"]', function () {
        UI.closeModal();
        clearLocalSession();

        API.logout(true).then(finish, finish);

        function finish() {
            UI.toast({
                title: 'Signed out everywhere',
                message: 'Every device has been signed out.',
                tone: 'ok'
            });
            go('/login');
        }
    });


    /* ------------------------------------------------------ close account

       Two steps on purpose. This modal is the first: it says plainly what will
       be removed, and it asks for the password AND the typed word DELETE.

       A Google-only account has no password, so that field is hidden for them -
       the endpoint knows the difference and only checks what exists. */
    $(document).on('click', '[data-act="set-delete-account"]', function () {

        var isGoogleOnly = !!(STATE.session && STATE.session.googleOnly);

        UI.openModal({
            title: 'Close your account',
            sub: 'This cannot be undone',
            size: 'sm',
            body: '<div class="stack-4">' +

                UI.callout({
                    tone: 'bad', icon: 'alertTriangle',
                    title: 'Everything below is deleted permanently',
                    text: 'Your profile, messages, appointments, saved questions and your ' +
                        'Financial Needs Assessment. Your representative keeps their own ' +
                        'meeting notes, and the security log is kept as a record.'
                }) +

                (isGoogleOnly
                    ? ''
                    : '<div class="field"><label class="field-label" for="del-pass">' +
                      'Your password</label>' +
                      '<span class="input-wrap has-icon"><span class="input-icon">' +
                      UI.icon('lock', 16) + '</span>' +
                      '<input class="input" id="del-pass" type="password" ' +
                      'autocomplete="current-password" placeholder="To prove it is you"></span></div>') +

                '<div class="field"><label class="field-label" for="del-confirm">' +
                'Type <strong>DELETE</strong> to confirm</label>' +
                '<input class="input" id="del-confirm" type="text" autocomplete="off" ' +
                'placeholder="DELETE"></div>' +

                '<div id="del-alert"></div>' +
                '</div>',

            foot: UI.btn({ label: 'Keep my account', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Close my account permanently', variant: 'danger',
                         icon: 'trash', act: 'set-confirm-delete' })
        });

        window.setTimeout(function () {
            $(isGoogleOnly ? '#del-confirm' : '#del-pass').trigger('focus');
        }, 80);
    });

    $(document).on('click', '[data-act="set-confirm-delete"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        var password = $('#del-pass').length ? $('#del-pass').val() : '';
        var confirm  = $.trim($('#del-confirm').val());

        /* Checked here as a courtesy so an empty box does not need a round trip.
           The server checks the same things again, because this check can be
           skipped by anybody with the developer tools open. */
        if (confirm.toUpperCase() !== 'DELETE') {
            $('#del-alert').html(UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: 'Type DELETE in the box to confirm.'
            }));
            $('#del-confirm').trigger('focus');
            return;
        }

        $('#del-alert').empty();
        $btn.addClass('is-loading').prop('disabled', true);

        API.deleteAccount(password, confirm).then(

            function (data) {
                UI.closeModal();

                /* The server has already ended the session. Clear our copy so
                   nothing keeps polling for an account that no longer exists. */
                clearLocalSession();

                UI.toast({
                    title: 'Account closed',
                    message: data.message || 'Everything has been removed.',
                    tone: 'info'
                });
                go('/login');
            },

            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);

                $('#del-alert').html(UI.callout({
                    tone: 'warn', icon: 'alertTriangle', title: err.error
                }));

                if (err.field === 'password') { $('#del-pass').trigger('focus').trigger('select'); }
                if (err.field === 'confirm')  { $('#del-confirm').trigger('focus').trigger('select'); }
            }
        );
    });
});


/* ==========================================================================
   THE NOTIFICATION LOG   #/notifications
   --------------------------------------------------------------------------
   Everything the bell has ever said, for all three roles, on one screen.

   ==========================================================================
   WHY A DROPDOWN WAS NOT ENOUGH
   ==========================================================================

   The bell holds what fits in a panel. "When did PRUWise last say something
   about my income" and "what was that meeting it booked" are questions somebody
   asks days later, and a dropdown that shows the most recent handful is the wrong
   place to answer them - the row you want has already scrolled out of it.

   So this is the log: the same rows, in full, with filters, and every one of them
   still a link to the thing it is about. It is deliberately the same rendering
   function the bell uses (notifRow in js/app.js), because two lists of the same
   data drawn by two functions is how they end up disagreeing about what a row
   means.

   ==========================================================================
   IT IS THE SAME PAGE FOR EVERYBODY
   ==========================================================================

   A representative, a client and an administrator all see their own rows and
   nobody else's - /api/notifications scopes every statement by the account in the
   session, so there is nothing role-specific to build. One page rather than three
   is also one page to keep right.
   ========================================================================== */

/* Which kind is being shown. Module-level so it survives the results redraw. */
var notifFilter = 'all';

var NOTIF_FILTERS = [
    { id: 'all',      label: 'Everything' },
    { id: 'unread',   label: 'Unread' },
    { id: 'insight',  label: 'What PRUWise noticed' },
    { id: 'meeting',  label: 'Meetings' },
    { id: 'finance',  label: 'Financial details' }
];

PAGES['/notifications'] = {
    title: 'Notifications',
    sub: 'Everything PRUWise and the app have told you',

    render: function () {
        var chips = NOTIF_FILTERS.map(function (f) {
            return UI.chip({
                label: f.label, on: notifFilter === f.id,
                act: 'notif-filter', data: { filter: f.id }
            });
        }).join('');

        return UI.pageHead({
            eyebrow: 'Your log',
            title: 'Notifications',
            sub: 'Every one of these is a link to the screen where you can do something ' +
                'about it. Nothing here has changed anything on its own.',
            actions: UI.btn({
                label: 'Mark all read', variant: 'outline', icon: 'checkCheck',
                act: 'notif-read-all-page'
            })
        }) +
            UI.card({ cls: 'card-inset' }, '<div class="chips scroll-x">' + chips + '</div>') +
            '<div id="notif-log">' + UI.loadingState('Reading your notifications\u2026') + '</div>';
    },

    after: function () { loadNotifLog(); }
};

function loadNotifLog() {
    var $box = $('#notif-log');
    if (!$box.length) { return; }

    /* Asks for a hundred rather than the bell's forty. This is the screen somebody
       came to specifically to look back through. */
    API.notifications.list(100).then(

        function (data) {
            /* The bell's copy is refreshed from the same response. Two screens
               answering "how many are unread" from two fetches a second apart is
               the shape of bug this whole round has been about. */
            STATE.notifs = data.notifications || [];
            STATE.notifUnread = Number(data.unread) || 0;
            paintBellDot();

            drawNotifLog();
        },

        function (err) {
            $box.html(UI.errorState({
                title: 'Could not load your notifications',
                text: (err && err.error) ? err.error : 'Please try again.',
                actions: UI.btn({ label: 'Try again', variant: 'outline', icon: 'refresh',
                                  act: 'notif-reload' })
            }));
        }
    );
}

function drawNotifLog() {
    var $box = $('#notif-log');
    if (!$box.length) { return; }

    var rows = (STATE.notifs || []).filter(function (n) {
        if (notifFilter === 'all') { return true; }
        if (notifFilter === 'unread') { return !n.read; }
        return n.kind === notifFilter;
    });

    if (!rows.length) {
        /* "Nothing yet" and "nothing matching that filter" are different
           situations and get different words. The first is a new account; the
           second is a filter to clear. */
        $box.html(notifFilter === 'all'
            ? UI.emptyState({
                icon: 'bell',
                title: 'Nothing yet',
                text: 'PRUWise writes here when it notices something in a chat or a call, ' +
                    'when a meeting is booked or agreed, and when a financial detail changes.'
            })
            : UI.emptyState({
                icon: 'search',
                title: 'Nothing of that kind',
                text: 'Try another filter, or show everything.',
                actions: UI.btn({ label: 'Show everything', variant: 'outline',
                                  act: 'notif-filter', data: { filter: 'all' } })
            }));
        return;
    }

    /* Grouped by day, the same way the chat log is, because "when" is the first
       thing somebody scanning a history looks for. */
    var out = '';
    var lastDay = '';

    rows.forEach(function (n) {
        var day = FMT.dateLong(n.at);

        if (day !== lastDay) {
            var friendly = FMT.friendly(n.at);
            var label = friendly.indexOf('Today') === 0 ? 'Today'
                : (friendly.indexOf('Yesterday') === 0 ? 'Yesterday' : day);

            out += '<div class="day-sep"><span>' + FMT.esc(label) + '</span></div>';
            lastDay = day;
        }

        out += notifRow(n);
    });

    $box.html('<div class="notif-list is-page">' + out + '</div>');
}

$(function () {
    $(document).on('click', '[data-act="notif-reload"]', function () { loadNotifLog(); });

    $(document).on('click', '[data-act="notif-filter"]', function () {
        notifFilter = $(this).data('filter');

        $('[data-act="notif-filter"]').removeClass('is-on').attr('aria-pressed', 'false');
        $('[data-act="notif-filter"][data-filter="' + notifFilter + '"]')
            .addClass('is-on').attr('aria-pressed', 'true');

        drawNotifLog();
    });

    $(document).on('click', '[data-act="notif-read-all-page"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        $btn.addClass('is-loading').prop('disabled', true);

        API.notifications.readAll().then(

            function () {
                STATE.notifUnread = 0;
                STATE.notifs = (STATE.notifs || []).map(function (n) {
                    return $.extend({}, n, { read: true });
                });

                paintBellDot();
                drawNotifLog();

                $btn.removeClass('is-loading').prop('disabled', false);
                UI.toast({ title: 'All caught up', tone: 'ok' });
            },

            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                UI.toast({ tone: 'bad', title: 'Could not do that', message: err.error });
            }
        );
    });
});
