/* ==========================================================================
   pages-admin.js
   --------------------------------------------------------------------------
   The administrator's screens:

     /admin/users        every account, searchable
     /admin/user/:id     one account, with the actions you can take on it
     /admin/requests     customers asking for a different representative
     /admin/audit        who did what, when

   THESE PAGES SHOW LIVE DATA, NOT MOCK DATA

   Everything here comes from php/api/admin/*.php, which means the numbers are
   real rows in MySQL. Unlike the rest of the app, none of it is seeded from
   js/data.js.

   THE PATTERN USED THROUGHOUT

   render() returns a placeholder immediately, then after() fetches and fills
   it in. The alternative - making the router wait for the network - would leave
   the whole app frozen on a slow connection with nothing on screen to explain
   why.

   WHAT PROTECTS THESE PAGES

   The router keeps non-admins out of /admin/, but that is only tidiness: it is
   JavaScript, and anybody can edit JavaScript. The real protection is
   require_admin() at the top of every endpoint. If somebody forces their way to
   this page, they get a screenful of error messages and no data.
   ========================================================================== */


/* Keeps the current filter between renders, so searching and then opening a
   user and coming back does not lose your place. */
var ADMIN_FILTER = { q: '', role: '', status: '', sort: 'created', page: 1 };


/* ==========================================================================
   SHARED PIECES
   ========================================================================== */

/* A coloured pill for a role. Admin is red because it is the one that should
   catch your eye in a long list. */
function adminRolePill(role) {
    var map = {
        admin:    { label: 'Administrator', tone: 'brand' },
        fr:       { label: 'Representative', tone: 'info' },
        customer: { label: 'Client', tone: '' }
    };
    var it = map[role] || { label: role, tone: '' };
    return UI.badge(it.label, it.tone);
}

function adminStatusPill(status) {
    return status === 'suspended'
        ? '<span class="tick bad">' + UI.icon('userX', 12) + '<span class="t-xs">Suspended</span></span>'
        : '<span class="tick ok">' + UI.icon('check', 12) + '<span class="t-xs">Active</span></span>';
}

// "3 days ago", or a clear "Never" rather than a blank cell
function adminWhen(iso) {
    return iso ? FMT.relative(iso) : '<span class="subtle">Never</span>';
}

/* One place that turns an API failure into something on screen. Used by every
   page here so a 403 or a dead server never shows as an empty page. */
function adminError(err, what) {
    return UI.errorState({
        title: err.status === 403
            ? 'Your account does not have administrator access'
            : 'Could not load ' + what,
        text: err.error
    });
}


/* ==========================================================================
   USERS
   ========================================================================== */
PAGES['/admin/users'] = {
    title: 'Users',
    sub: 'Every account in the database',

    render: function () {
        return UI.pageHead({
            eyebrow: 'Administration',
            title: 'Users',
            sub: 'Every account in the database, with the things you can do about them.',
            actions: UI.btn({ label: 'Add a representative', icon: 'userPlus', act: 'admin-new-user' }) +
                UI.btn({ label: 'Refresh', variant: 'outline', icon: 'refresh', act: 'admin-reload' })
        }) +
            '<div id="admin-stats" class="stack-4">' + UI.skeletonGrid(4) + '</div>' +
            '<div id="admin-filters"></div>' +
            '<div id="admin-users">' + UI.loadingState('Reading the database...') + '</div>';
    },

    after: function () {
        loadAdminUsers();
    }
};


function loadAdminUsers() {
    API.admin.users(ADMIN_FILTER).then(

        function (data) {
            drawAdminStats(data.stats);
            drawAdminFilters(data.stats);
            drawAdminUserTable(data);

            // Cached so the reassign dropdown does not need its own request
            ADMIN_REPS = data.reps || [];
        },

        function (err) {
            $('#admin-stats').empty();
            $('#admin-filters').empty();
            $('#admin-users').html(adminError(err, 'the user list'));
        }
    );
}

var ADMIN_REPS = [];


function drawAdminStats(s) {
    /* deltaLabel is the supporting line under the number - see UI.stat in
       js/ui.js. It takes no "sub" or "tone", so the wording carries the
       meaning instead of a colour. */
    var cards = [
        {
            label: 'Accounts', value: s.total, icon: 'users',
            deltaLabel: s.byRole.customer + ' clients, ' + s.byRole.fr +
                ' representatives, ' + s.byRole.admin + ' admin'
        },
        {
            label: 'New this week', value: s.newThisWeek, icon: 'userPlus',
            deltaLabel: 'Registered in the last 7 days'
        },
        {
            label: 'Active today', value: s.activeToday, icon: 'clock',
            deltaLabel: 'Signed in within 24 hours'
        },
        {
            label: 'Needs attention', value: s.suspended + s.openRequests, icon: 'alertTriangle',
            deltaLabel: s.suspended + ' suspended, ' + s.openRequests + ' open request(s)'
        }
    ];

    $('#admin-stats').html('<div class="grid grid-sm">' + cards.map(function (c) {
        return UI.stat({
            label: c.label, value: String(c.value),
            icon: c.icon, deltaLabel: c.deltaLabel
        });
    }).join('') + '</div>' +

        (s.failedLogins24h > 8
            ? UI.callout({
                tone: 'warn', icon: 'alertTriangle',
                title: s.failedLogins24h + ' failed sign-ins in the last 24 hours',
                text: 'That may just be forgotten passwords. If it keeps climbing, look at the ' +
                    'activity log to see whether one account or one address is being targeted.'
            })
            : '') +

        (s.unverified > 0
            ? '<div class="t-xs muted">' + s.unverified + ' account(s) have not confirmed their email ' +
              'address. They can still sign in, but a password reset will not reach them.</div>'
            : '')
    );
}


function drawAdminFilters(stats) {
    var roleOptions = [
        { value: '', label: 'All roles (' + stats.total + ')' },
        { value: 'customer', label: 'Clients (' + stats.byRole.customer + ')' },
        { value: 'fr', label: 'Representatives (' + stats.byRole.fr + ')' },
        { value: 'admin', label: 'Administrators (' + stats.byRole.admin + ')' }
    ];

    var sortOptions = [
        { value: 'created', label: 'Newest first' },
        { value: 'oldest', label: 'Oldest first' },
        { value: 'name', label: 'Name A to Z' },
        { value: 'username', label: 'Username A to Z' },
        { value: 'lastseen', label: 'Recently active' },
        { value: 'role', label: 'Grouped by role' }
    ];

    function select(id, options, current) {
        return '<select class="select" id="' + id + '">' + options.map(function (o) {
            return '<option value="' + o.value + '"' +
                (o.value === current ? ' selected' : '') + '>' + FMT.esc(o.label) + '</option>';
        }).join('') + '</select>';
    }

    $('#admin-filters').html(UI.card({ cls: 'card-inset' },
        '<div class="admin-filters">' +
        '<span class="search grow"><span class="input-icon">' + UI.icon('search', 16) + '</span>' +
        '<input class="input" id="admin-q" type="search" placeholder="Search name, username, email or id..." ' +
        'value="' + FMT.esc(ADMIN_FILTER.q) + '" aria-label="Search users"></span>' +
        select('admin-role', roleOptions, ADMIN_FILTER.role) +
        select('admin-status', [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active only' },
            { value: 'suspended', label: 'Suspended only (' + stats.suspended + ')' }
        ], ADMIN_FILTER.status) +
        select('admin-sort', sortOptions, ADMIN_FILTER.sort) +
        '</div>'
    ));
}


function drawAdminUserTable(data) {
    var table = UI.table({
        caption: 'User accounts',
        rows: data.users,
        rowAct: 'admin-open-user',
        rowData: function (u) { return { id: u.accountId }; },

        empty: {
            icon: 'search',
            title: ADMIN_FILTER.q ? 'Nobody matches "' + ADMIN_FILTER.q + '"' : 'No accounts yet',
            text: ADMIN_FILTER.q
                ? 'Try a shorter search, or clear the filters.'
                : 'Accounts appear here as people register.'
        },

        columns: [
            {
                key: 'name', label: 'Person',
                render: function (u) {
                    return '<div class="row-2">' +
                        UI.avatar(u.name, 'sm', { seed: u.personId }) +
                        '<span style="min-width:0">' +
                        '<span class="t-sm semi truncate" style="display:block">' + FMT.esc(u.name) + '</span>' +
                        '<span class="t-xs muted truncate" style="display:block">' +
                        FMT.esc(u.username) + '</span></span></div>';
                }
            },
            { key: 'role', label: 'Role', render: function (u) { return adminRolePill(u.role); } },
            {
                key: 'email', label: 'Email',
                render: function (u) {
                    return '<span class="t-xs">' + FMT.esc(u.email) + '</span>' +
                        (u.emailVerified ? '' :
                            ' <span class="t-xs" style="color:var(--warn)">unconfirmed</span>');
                }
            },
            {
                key: 'repName', label: 'Adviser', hideOnPhone: true,
                render: function (u) {
                    if (u.role === 'customer') {
                        return u.repName
                            ? '<span class="t-xs">' + FMT.esc(u.repName) + '</span>'
                            : '<span class="t-xs" style="color:var(--warn)">none</span>';
                    }
                    if (u.role === 'fr') {
                        return '<span class="t-xs muted">' + u.customerCount + ' clients</span>';
                    }
                    return '<span class="subtle">-</span>';
                }
            },
            { key: 'status', label: 'Status', render: function (u) { return adminStatusPill(u.status); } },
            {
                key: 'lastLogin', label: 'Last seen',
                render: function (u) { return '<span class="t-xs">' + adminWhen(u.lastLogin) + '</span>'; }
            }
        ]
    });

    var p = data.page;

    var pager = p.pages > 1
        ? '<div class="between" style="padding-top:12px">' +
        '<span class="t-xs muted">Page ' + p.page + ' of ' + p.pages + ', ' + p.total + ' accounts</span>' +
        '<span class="row-2">' +
        UI.btn({
            label: 'Previous', variant: 'outline', size: 'sm', icon: 'chevronLeft',
            act: 'admin-page', data: { page: p.page - 1 }, disabled: p.page <= 1
        }) +
        UI.btn({
            label: 'Next', variant: 'outline', size: 'sm', iconRight: 'chevronRight',
            act: 'admin-page', data: { page: p.page + 1 }, disabled: p.page >= p.pages
        }) +
        '</span></div>'
        : '<div class="t-xs muted" style="padding-top:10px">' + p.total + ' account(s)</div>';

    $('#admin-users').html(UI.card({}, table + pager));
}


/* ==========================================================================
   ONE USER
   ========================================================================== */
PAGES['/admin/user/:id'] = {
    title: 'Account',
    sub: '',

    render: function (ctx) {
        return '<div id="admin-user">' + UI.loadingState('Loading the account...') + '</div>';
    },

    after: function (ctx) {
        var id = Number(ctx.params.id);

        API.admin.user(id).then(
            function (data) { drawAdminUser(data); },
            function (err) { $('#admin-user').html(adminError(err, 'that account')); }
        );
    }
};


function drawAdminUser(data) {
    var u = data.user;
    var a = data.activity;

    /* ------------------------------------------------------------ header */
    var header = UI.pageHead({
        eyebrow: 'Account ' + u.accountId,
        title: u.name,
        sub: u.username + ' | ' + u.email,
        actions: UI.btn({ label: 'Back to users', variant: 'ghost', icon: 'arrowLeft', href: '#/admin/users' })
    });

    var summary = UI.card({ cls: 'card-soft' },
        '<div class="row top wrap" style="gap:20px">' +
        UI.avatar(u.name, 'xl', { seed: u.personId }) +
        '<div class="grow stack-3">' +
        '<div class="chips">' +
        adminRolePill(u.role) +
        adminStatusPill(u.status) +
        (u.emailVerified
            ? UI.badge('Email confirmed', 'ok')
            : UI.badge('Email not confirmed', 'warn')) +
        (u.isSelf ? UI.badge('This is you', 'brand') : '') +
        '</div>' +
        UI.kv([
            ['Username', u.username],
            ['Email', u.email],
            ['Phone', u.phone || 'Not given'],
            ['Person id', u.personId],
            ['Registered', FMT.dateLong(u.createdAt) + ' (' + FMT.relative(u.createdAt) + ')'],
            ['Last signed in', u.lastLogin ? FMT.relative(u.lastLogin) : 'Never'],
            u.role === 'customer' ? ['Representative', u.repName || 'None assigned'] : null,
            u.role === 'customer' && u.segment ? ['Segment', u.segment] : null,
            ['Created by', u.note || 'Unknown']
        ]) +
        '</div></div>'
    );

    /* ------------------------------------------------------- what they own */
    var owns = UI.card({ title: 'What this account is connected to', icon: 'layers' },
        UI.facts([
            ['Conversations', String(a.conversations)],
            ['Messages sent', String(a.messagesSent)],
            ['Appointments', String(a.appointments)]
        ]) +
        (u.role === 'fr'
            ? '<div class="t-sm muted">' + a.customers + ' client(s) are assigned to this ' +
              'representative, and have given ' + a.ratingsGot + ' rating(s).</div>'
            : '<div class="t-sm muted">Has given ' + a.ratingsGiven + ' rating(s).</div>')
    );

    /* --------------------------------------------------------- the actions */
    var actionRows = [];

    if (u.status === 'active') {
        actionRows.push(adminActionRow(
            'Suspend this account', 'userX',
            'They cannot sign in, and are signed out immediately. Nothing is deleted.',
            UI.btn({
                label: 'Suspend', variant: 'outline', size: 'sm', icon: 'userX',
                act: 'admin-act', data: { id: u.accountId, do: 'suspend' },
                disabled: u.isSelf
            })
        ));
    } else {
        actionRows.push(adminActionRow(
            'Reactivate this account', 'userCheck',
            'They can sign in again with their existing password.',
            UI.btn({
                label: 'Reactivate', size: 'sm', icon: 'userCheck',
                act: 'admin-act', data: { id: u.accountId, do: 'activate' }
            })
        ));
    }

    actionRows.push(adminActionRow(
        'Send a password reset', 'mail',
        'Emails them a one-time link. You never see or set their password.',
        UI.btn({
            label: 'Send reset link', variant: 'outline', size: 'sm', icon: 'mail',
            act: 'admin-act', data: { id: u.accountId, do: 'send-reset' }
        })
    ));

    actionRows.push(adminActionRow(
        'Sign out everywhere', 'logOut',
        'Ends every session on every device. Useful if a device was lost.',
        UI.btn({
            label: 'Sign out', variant: 'outline', size: 'sm', icon: 'logOut',
            act: 'admin-act', data: { id: u.accountId, do: 'signout' },
            disabled: u.isSelf
        })
    ));

    if (!u.emailVerified) {
        actionRows.push(adminActionRow(
            'Mark the email as confirmed', 'checkCircle',
            'Only do this if you have confirmed the address another way.',
            UI.btn({
                label: 'Mark confirmed', variant: 'outline', size: 'sm', icon: 'check',
                act: 'admin-act', data: { id: u.accountId, do: 'verify-email' }
            })
        ));
    }

    if (u.role === 'customer') {
        var repOptions = ADMIN_REPS.length
            ? ADMIN_REPS
            : [{ id: u.repId, name: u.repName || 'Current', customerCount: 0 }];

        actionRows.push(adminActionRow(
            'Change their representative', 'refresh',
            'Moves the client and emails them. Their policies are unaffected.',
            '<div class="row-2 wrap">' +
            '<select class="select" id="admin-rep-select" aria-label="New representative">' +
            repOptions.map(function (r) {
                return '<option value="' + r.id + '"' + (r.id === u.repId ? ' disabled' : '') + '>' +
                    FMT.esc(r.name) + ' (' + r.customerCount + ')' +
                    (r.id === u.repId ? ' - current' : '') + '</option>';
            }).join('') + '</select>' +
            UI.btn({
                label: 'Reassign', variant: 'outline', size: 'sm', icon: 'refresh',
                act: 'admin-reassign', data: { id: u.accountId }
            }) +
            '</div>'
        ));
    }

    var actions = UI.card({ title: 'Actions', sub: 'Each one takes effect straight away', icon: 'settings' },
        '<div class="stack-3">' + actionRows.join('<div class="hr"></div>') + '</div>');

    /* ----------------------------------------------------- danger zone */
    var danger = UI.card({ title: 'Delete this account', icon: 'alertTriangle', cls: 'card-danger' },
        UI.callout({
            tone: 'warn', icon: 'alertTriangle', title: 'This cannot be undone',
            text: 'Deleting removes the person, their login, their ' + a.conversations +
                ' conversation(s), ' + a.messagesSent + ' message(s) and ' + a.appointments +
                ' appointment(s). Suspending is almost always the better answer.'
        }) +
        UI.btn({
            label: 'Delete permanently', variant: 'danger', size: 'sm', icon: 'trash',
            act: 'admin-delete',
            data: { id: u.accountId, username: u.username, name: u.name },
            disabled: u.isSelf
        })
    );

    /* -------------------------------------------------------- the history */
    var attempts = data.attempts.length
        ? UI.card({ title: 'Recent sign-in attempts', sub: 'Newest first', icon: 'logIn' },
            '<div class="stack-2">' + data.attempts.map(function (t) {
                return '<div class="between t-xs">' +
                    '<span class="tick ' + (t.succeeded ? 'ok' : 'bad') + '">' +
                    UI.icon(t.succeeded ? 'check' : 'x', 11) +
                    '<span>' + (t.succeeded ? 'Signed in' : 'Failed') + '</span></span>' +
                    '<span class="muted">' + FMT.esc(t.ip || '') + '</span>' +
                    '<span class="subtle">' + FMT.relative(t.at) + '</span>' +
                    '</div>';
            }).join('') + '</div>')
        : '';

    var history = data.audit.length
        ? UI.card({ title: 'Account history', icon: 'clock' },
            UI.timeline(data.audit.map(function (e) {
                return {
                    title: adminActionLabel(e.action),
                    text: e.detail || '',
                    time: e.at,
                    icon: adminActionIcon(e.action)
                };
            })))
        : '';

    var moves = data.assignments.length
        ? UI.card({ title: 'Representative changes', icon: 'refresh' },
            UI.timeline(data.assignments.map(function (m) {
                return {
                    title: (m.from || 'Unassigned') + ' to ' + (m.to || 'Unassigned'),
                    time: m.at, icon: 'userCheck'
                };
            })))
        : '';

    $('#admin-user').html(
        header + summary +
        '<div class="split split-rail">' +
        '<div class="stack">' + actions + attempts + history + moves + '</div>' +
        '<div class="stack">' + owns + danger + '</div>' +
        '</div>'
    );
}

// One row in the actions card: what it does, why, and the button
function adminActionRow(title, icon, explanation, buttonHtml) {
    return '<div class="admin-action">' +
        '<div class="grow" style="min-width:0">' +
        '<div class="row-2"><span style="color:var(--brand)">' + UI.icon(icon, 15) + '</span>' +
        '<span class="t-sm semi">' + FMT.esc(title) + '</span></div>' +
        '<div class="t-xs muted" style="margin-top:2px">' + FMT.esc(explanation) + '</div>' +
        '</div>' + buttonHtml + '</div>';
}

// Turn 'admin_suspended_user' into 'Suspended user'
function adminActionLabel(action) {
    var words = String(action).replace(/^admin_/, '').replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function adminActionIcon(action) {
    if (action.indexOf('login') !== -1) { return 'logIn'; }
    if (action.indexOf('logout') !== -1) { return 'logOut'; }
    if (action.indexOf('password') !== -1 || action.indexOf('reset') !== -1) { return 'lock'; }
    if (action.indexOf('email') !== -1) { return 'mail'; }
    if (action.indexOf('denied') !== -1) { return 'alertTriangle'; }
    if (action.indexOf('register') !== -1) { return 'userPlus'; }
    if (action.indexOf('suspend') !== -1) { return 'userX'; }
    if (action.indexOf('reassign') !== -1) { return 'refresh'; }
    return 'clock';
}


/* ==========================================================================
   CHANGE REQUESTS
   ========================================================================== */
PAGES['/admin/requests'] = {
    title: 'Change requests',
    sub: 'Clients asking for a different representative',

    render: function () {
        return UI.pageHead({
            eyebrow: 'Administration',
            title: 'Representative change requests',
            sub: 'Each one is a client who asked to be reassigned. Approving moves them and ' +
                'emails them; declining needs a reason, which is also emailed.',
            actions: UI.btn({ label: 'Refresh', variant: 'outline', icon: 'refresh', act: 'admin-reload' })
        }) + '<div id="admin-requests">' + UI.loadingState('Loading the queue...') + '</div>';
    },

    after: function () {
        loadAdminRequests();
    }
};


function loadAdminRequests() {
    API.admin.requests('all').then(

        function (data) {
            if (!data.requests.length) {
                $('#admin-requests').html(UI.emptyState({
                    icon: 'checkCircle',
                    title: 'Nothing waiting',
                    text: 'When a client asks for a different representative, it appears here.'
                }));
                return;
            }

            var open = data.requests.filter(function (r) { return r.status === 'open'; });
            var done = data.requests.filter(function (r) { return r.status !== 'open'; });

            var html = '';

            if (open.length) {
                html += '<div class="stack-4">' +
                    UI.secHead({ title: 'Waiting for a decision', sub: open.length + ' open' }) +
                    open.map(adminRequestCard).join('') + '</div>';
            }

            if (done.length) {
                html += '<div class="stack-4">' +
                    UI.secHead({ title: 'Already decided', sub: done.length + ' resolved' }) +
                    done.map(adminRequestCard).join('') + '</div>';
            }

            $('#admin-requests').html(html);
        },

        function (err) {
            $('#admin-requests').html(adminError(err, 'the request queue'));
        }
    );
}


function adminRequestCard(r) {
    var isOpen = (r.status === 'open');

    var tones = { open: 'warn', approved: 'ok', declined: '', withdrawn: '' };

    var body =
        UI.kv([
            ['Reference', r.reference],
            ['Client', r.customerName],
            ['Current representative', r.currentRepName || 'None'],
            ['They asked for', r.preferredRepName || 'No preference'],
            ['Reason given', r.reason],
            ['Raised', FMT.relative(r.createdAt)],
            r.resolvedAt ? ['Decided', FMT.relative(r.resolvedAt)] : null
        ]) +
        (r.notes ? '<div class="t-xs muted" style="white-space:pre-wrap">' +
            FMT.esc(r.notes) + '</div>' : '');

    if (!isOpen) {
        return UI.card({
            title: r.customerName,
            sub: 'Request ' + r.status,
            icon: r.status === 'approved' ? 'checkCircle' : 'x',
            actions: UI.badge(r.status.charAt(0).toUpperCase() + r.status.slice(1), tones[r.status])
        }, body);
    }

    /* An open request gets the decision controls. The representative dropdown
       defaults to the one the customer asked for, if they named one. */
    var repChoices = ADMIN_REPS.filter(function (rep) { return rep.id !== r.currentRepId; });

    var controls =
        '<div class="hr"></div>' +
        '<div class="stack-3">' +
        '<div class="field">' +
        '<label class="field-label" for="rq-rep-' + r.id + '">Move them to</label>' +
        '<select class="select" id="rq-rep-' + r.id + '">' +
        (repChoices.length
            ? repChoices.map(function (rep) {
                return '<option value="' + rep.id + '"' +
                    (rep.id === r.preferredRepId ? ' selected' : '') + '>' +
                    FMT.esc(rep.name) + ' (' + rep.customerCount + ' clients)</option>';
            }).join('')
            : '<option value="">No other representative exists</option>') +
        '</select></div>' +

        '<div class="field">' +
        '<label class="field-label" for="rq-reason-' + r.id + '">If declining, why?</label>' +
        '<textarea class="textarea" id="rq-reason-' + r.id + '" ' +
        'placeholder="This is emailed to the client, so write it for them to read."></textarea>' +
        '<div class="field-hint">At least 10 characters. Only needed when declining.</div></div>' +

        '<div id="rq-alert-' + r.id + '"></div>' +

        '<div class="card-actions">' +
        UI.btn({
            label: 'Approve and reassign', size: 'sm', icon: 'check',
            act: 'admin-approve-request', data: { id: r.id },
            disabled: !repChoices.length
        }) +
        UI.btn({
            label: 'Decline', variant: 'outline', size: 'sm', icon: 'x',
            act: 'admin-decline-request', data: { id: r.id }
        }) +
        (r.customerAccountId
            ? UI.btn({
                label: 'Open the account', variant: 'ghost', size: 'sm', icon: 'user',
                href: '#/admin/user/' + r.customerAccountId
            })
            : '') +
        '</div></div>';

    return UI.card({
        title: r.customerName,
        sub: 'Reference ' + r.reference,
        icon: 'userX',
        actions: UI.badge('Waiting', 'warn')
    }, body + controls);
}


/* ==========================================================================
   ACTIVITY LOG
   ========================================================================== */
var ADMIN_AUDIT_FILTER = { action: '', page: 1 };

PAGES['/admin/audit'] = {
    title: 'Activity log',
    sub: 'Who did what, and when',

    render: function () {
        return UI.pageHead({
            eyebrow: 'Administration',
            title: 'Activity log',
            sub: 'A read-only record. Nothing in the app can edit or delete an entry, which is ' +
                'the only reason a log like this is worth having.',
            actions: UI.btn({ label: 'Refresh', variant: 'outline', icon: 'refresh', act: 'admin-reload' })
        }) + '<div id="admin-audit">' + UI.loadingState('Reading the log...') + '</div>';
    },

    after: function () {
        loadAdminAudit();
    }
};


function loadAdminAudit() {
    API.admin.audit(ADMIN_AUDIT_FILTER).then(

        function (data) {
            var filter = UI.card({ cls: 'card-inset' },
                '<div class="admin-filters">' +
                '<select class="select grow" id="audit-action" aria-label="Filter by action">' +
                '<option value="">Everything (' + data.page.total + ' entries)</option>' +
                data.actions.map(function (a) {
                    return '<option value="' + FMT.esc(a.action) + '"' +
                        (a.action === ADMIN_AUDIT_FILTER.action ? ' selected' : '') + '>' +
                        FMT.esc(adminActionLabel(a.action)) + ' (' + a.count + ')</option>';
                }).join('') +
                '</select></div>');

            var rows = UI.table({
                caption: 'Activity log',
                rows: data.entries,
                empty: { icon: 'clock', title: 'Nothing logged yet' },
                columns: [
                    {
                        key: 'action', label: 'What happened',
                        render: function (e) {
                            return '<div class="row-2">' +
                                '<span style="color:var(--brand);flex-shrink:0">' +
                                UI.icon(adminActionIcon(e.action), 14) + '</span>' +
                                '<span class="t-sm">' + FMT.esc(adminActionLabel(e.action)) + '</span></div>';
                        }
                    },
                    {
                        key: 'username', label: 'Who',
                        render: function (e) {
                            if (!e.username) {
                                return '<span class="subtle t-xs">deleted account</span>';
                            }
                            return e.accountId
                                ? '<a class="link t-xs" href="#/admin/user/' + e.accountId + '">' +
                                  FMT.esc(e.username) + '</a>'
                                : '<span class="t-xs">' + FMT.esc(e.username) + '</span>';
                        }
                    },
                    {
                        key: 'detail', label: 'Detail', hideOnPhone: true,
                        render: function (e) {
                            return '<span class="t-xs muted">' + FMT.esc(e.detail || '-') + '</span>';
                        }
                    },
                    {
                        key: 'ip', label: 'From', hideOnPhone: true,
                        render: function (e) { return '<span class="t-xs subtle">' + FMT.esc(e.ip || '-') + '</span>'; }
                    },
                    {
                        key: 'at', label: 'When',
                        render: function (e) {
                            return '<span class="t-xs" title="' + FMT.esc(e.at) + '">' +
                                FMT.relative(e.at) + '</span>';
                        }
                    }
                ]
            });

            var p = data.page;
            var pager = p.pages > 1
                ? '<div class="between" style="padding-top:12px">' +
                '<span class="t-xs muted">Page ' + p.page + ' of ' + p.pages + '</span>' +
                '<span class="row-2">' +
                UI.btn({
                    label: 'Newer', variant: 'outline', size: 'sm', icon: 'chevronLeft',
                    act: 'admin-audit-page', data: { page: p.page - 1 }, disabled: p.page <= 1
                }) +
                UI.btn({
                    label: 'Older', variant: 'outline', size: 'sm', iconRight: 'chevronRight',
                    act: 'admin-audit-page', data: { page: p.page + 1 }, disabled: p.page >= p.pages
                }) +
                '</span></div>'
                : '';

            /* Failed sign-ins get their own card. Buried in the main list they
               are easy to miss, and they are the thing worth noticing. */
            var failures = data.failures.length
                ? UI.card({
                    title: 'Recent failed sign-ins',
                    sub: data.failures.length + ' in the last 7 days',
                    icon: 'alertTriangle'
                },
                    '<div class="stack-2">' + data.failures.map(function (f) {
                        return '<div class="between t-xs">' +
                            '<span class="semi">' + FMT.esc(f.username) + '</span>' +
                            '<span class="muted">' + FMT.esc(f.ip || '') + '</span>' +
                            '<span class="subtle">' + FMT.relative(f.at) + '</span></div>';
                    }).join('') + '</div>' +
                    '<div class="t-xs muted">Repeated failures against one username are usually a ' +
                    'forgotten password. Many usernames from one address is worth a closer look.</div>')
                : '';

            $('#admin-audit').html(
                filter +
                '<div class="split split-rail">' +
                '<div class="stack">' + UI.card({}, rows + pager) + '</div>' +
                '<div class="stack">' + failures + '</div>' +
                '</div>'
            );
        },

        function (err) {
            $('#admin-audit').html(adminError(err, 'the activity log'));
        }
    );
}


/* ==========================================================================
   HANDLERS
   ========================================================================== */
$(function () {

    /* ---------------------------------------------------- list controls */

    $(document).on('click', '[data-act="admin-reload"]', function () {
        router();
    });

    $(document).on('click', '[data-act="admin-open-user"]', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter') { return; }
        go('/admin/user/' + $(this).data('id'));
    });

    $(document).on('click', '[data-act="admin-page"]', function () {
        ADMIN_FILTER.page = Number($(this).data('page'));
        loadAdminUsers();
    });

    /* Search as you type, but wait until the typing stops. Without the delay
       every keystroke would be a database query. */
    var searchTimer = null;

    $(document).on('input', '#admin-q', function () {
        var value = $(this).val();

        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
            ADMIN_FILTER.q = value;
            ADMIN_FILTER.page = 1;
            loadAdminUsers();
        }, 300);
    });

    $(document).on('change', '#admin-role, #admin-status, #admin-sort', function () {
        ADMIN_FILTER.role   = $('#admin-role').val();
        ADMIN_FILTER.status = $('#admin-status').val();
        ADMIN_FILTER.sort   = $('#admin-sort').val();
        ADMIN_FILTER.page   = 1;
        loadAdminUsers();
    });

    $(document).on('change', '#audit-action', function () {
        ADMIN_AUDIT_FILTER.action = $(this).val();
        ADMIN_AUDIT_FILTER.page = 1;
        loadAdminAudit();
    });

    $(document).on('click', '[data-act="admin-audit-page"]', function () {
        ADMIN_AUDIT_FILTER.page = Number($(this).data('page'));
        loadAdminAudit();
    });


    /* ------------------------------------------------------ user actions */

    /* The simple ones all go through one handler. The server is the thing that
       decides whether each is allowed, so this only has to send it and report. */
    $(document).on('click', '[data-act="admin-act"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        var id = Number($btn.data('id'));
        var what = $btn.data('do');

        $btn.addClass('is-loading').prop('disabled', true);

        API.admin.act(id, what).then(
            function (data) {
                UI.toast({ title: data.message, tone: 'ok' });

                if (data.devLink) {
                    showEmailDevLink('Password reset link', data.devLink, data.emailRoute);
                }
                router();      // redraw with the new state
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                UI.toast({ title: 'Could not do that', message: err.error, tone: 'warn' });
            }
        );
    });

    $(document).on('click', '[data-act="admin-reassign"]', function () {
        var id = Number($(this).data('id'));
        var repId = $('#admin-rep-select').val();

        if (!repId) {
            UI.toast({ title: 'Choose a representative first', tone: 'info' });
            return;
        }

        API.admin.act(id, 'reassign-rep', { repId: repId }).then(
            function (data) {
                UI.toast({ title: data.message, tone: 'ok' });
                router();
            },
            function (err) {
                UI.toast({ title: 'Could not reassign', message: err.error, tone: 'warn' });
            }
        );
    });


    /* ------------------------------------------------------------ delete

       Two steps on purpose. The dialog makes them type the username, and the
       server checks it again - so a mis-wired button cannot delete anybody. */
    $(document).on('click', '[data-act="admin-delete"]', function () {
        var id = Number($(this).data('id'));
        var username = $(this).data('username');
        var name = $(this).data('name');

        UI.openModal({
            title: 'Delete ' + name + '?',
            sub: 'This cannot be undone',
            body: '<div class="stack-4">' +
                UI.callout({
                    tone: 'warn', icon: 'alertTriangle',
                    title: 'Everything belonging to this account goes with it',
                    text: 'Their messages, conversations, appointments and ratings are all removed. ' +
                        'If you only want to stop them signing in, suspend them instead.'
                }) +
                '<div class="field">' +
                '<label class="field-label" for="del-confirm">Type <code>' + FMT.esc(username) +
                '</code> to confirm</label>' +
                '<input class="input" id="del-confirm" type="text" autocomplete="off" ' +
                'placeholder="' + FMT.esc(username) + '"></div>' +
                '<div id="del-alert"></div>' +
                '</div>',
            foot: UI.btn({ label: 'Keep the account', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({
                    label: 'Delete permanently', variant: 'danger', icon: 'trash',
                    act: 'admin-confirm-delete', data: { id: id, username: username }
                })
        });

        window.setTimeout(function () { $('#del-confirm').trigger('focus'); }, 80);
    });

    $(document).on('click', '[data-act="admin-confirm-delete"]', function () {
        var $btn = $(this);
        var id = Number($btn.data('id'));
        var username = $btn.data('username');
        var typed = $('#del-confirm').val();

        if (typed !== username) {
            $('#del-alert').html('<div class="login-alert" role="alert">' +
                UI.icon('alertCircle', 15) +
                '<span>That does not match. Type ' + FMT.esc(username) + ' exactly.</span></div>');
            return;
        }

        $btn.addClass('is-loading').prop('disabled', true);

        API.admin.act(id, 'delete', { confirm: true, confirmUsername: typed }).then(
            function (data) {
                UI.closeModal();
                UI.toast({ title: data.message, tone: 'ok' });
                go('/admin/users');
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                $('#del-alert').html('<div class="login-alert" role="alert">' +
                    UI.icon('alertCircle', 15) + '<span>' + FMT.esc(err.error) + '</span></div>');
            }
        );
    });


    /* ---------------------------------------------------- new staff account */

    $(document).on('click', '[data-act="admin-new-user"]', function () {
        UI.openModal({
            title: 'Add a staff account',
            sub: 'Clients register themselves, so this is for representatives and administrators',
            body: '<form id="admin-new-form" class="stack-4" novalidate>' +

                '<div class="field"><label class="field-label" for="nu-role">Role</label>' +
                '<select class="select" id="nu-role">' +
                '<option value="fr">Financial Representative</option>' +
                '<option value="admin">Administrator</option>' +
                '</select>' +
                '<div class="field-hint">An administrator can see and change every account.</div></div>' +

                '<div class="field"><label class="field-label" for="nu-name">Full name</label>' +
                '<input class="input" id="nu-name" type="text" placeholder="e.g. Marcus Lim"></div>' +

                '<div class="field"><label class="field-label" for="nu-email">Work email</label>' +
                '<input class="input" id="nu-email" type="email" placeholder="name@company.com">' +
                '<div class="field-hint">The invitation goes here, so it has to be an address they ' +
                'can read.</div></div>' +

                '<div class="field"><label class="field-label" for="nu-user">Username</label>' +
                '<input class="input" id="nu-user" type="text" placeholder="e.g. marcus.lim" ' +
                'autocomplete="off">' +
                '<div class="field-hint">Lowercase letters, numbers and dots.</div></div>' +

                '<div class="field"><label class="field-label" for="nu-phone">Phone (optional)</label>' +
                '<input class="input" id="nu-phone" type="tel" placeholder="+65 8123 4567"></div>' +

                '<div id="nu-alert"></div>' +

                UI.callout({
                    tone: 'info', icon: 'lock', title: 'You will not set their password',
                    text: 'The account is created without a usable password and they get an emailed ' +
                        'link to choose their own. Nobody else ever knows it.'
                }) +
                '</form>',
            foot: UI.btn({ label: 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                UI.btn({ label: 'Create and invite', icon: 'userPlus', act: 'admin-do-new-user' })
        });

        window.setTimeout(function () { $('#nu-name').trigger('focus'); }, 80);
    });

    // Enter inside the form submits it
    $(document).on('submit', '#admin-new-form', function (e) {
        e.preventDefault();
        $('[data-act="admin-do-new-user"]').trigger('click');
    });

    $(document).on('click', '[data-act="admin-do-new-user"]', function () {
        var $btn = $(this);
        if ($btn.hasClass('is-loading')) { return; }

        var details = {
            role:     $('#nu-role').val(),
            name:     $.trim($('#nu-name').val()),
            email:    $.trim($('#nu-email').val()).toLowerCase(),
            username: $.trim($('#nu-user').val()).toLowerCase(),
            phone:    $.trim($('#nu-phone').val())
        };

        $('#nu-alert').empty();
        $btn.addClass('is-loading').prop('disabled', true);

        API.admin.createUser(details).then(

            function (data) {
                UI.closeModal();
                UI.toast({ title: data.message, tone: 'ok' });

                if (data.devLink) {
                    showEmailDevLink('Invitation link for ' + data.username,
                        data.devLink, data.emailRoute);
                }
                loadAdminUsers();
            },

            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);

                $('#nu-alert').html('<div class="login-alert" role="alert">' +
                    UI.icon('alertCircle', 15) + '<span>' + FMT.esc(err.error) + '</span></div>');

                var fieldIds = {
                    role: '#nu-role', name: '#nu-name', email: '#nu-email',
                    username: '#nu-user', phone: '#nu-phone'
                };
                if (err.field && fieldIds[err.field]) { $(fieldIds[err.field]).trigger('focus'); }
            }
        );
    });


    /* ------------------------------------------------- request decisions */

    $(document).on('click', '[data-act="admin-approve-request"]', function () {
        var $btn = $(this);
        var id = Number($btn.data('id'));
        var repId = $('#rq-rep-' + id).val();

        if (!repId) {
            requestAlert(id, 'Choose which representative to move them to.');
            return;
        }

        $btn.addClass('is-loading').prop('disabled', true);

        API.admin.resolveRequest(id, 'approve', { repId: repId }).then(
            function (data) {
                UI.toast({ title: data.message, tone: 'ok' });
                loadAdminRequests();
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                requestAlert(id, err.error);
            }
        );
    });

    $(document).on('click', '[data-act="admin-decline-request"]', function () {
        var $btn = $(this);
        var id = Number($btn.data('id'));
        var reason = $.trim($('#rq-reason-' + id).val());

        if (reason.length < 10) {
            requestAlert(id, 'Please write at least 10 characters. This is emailed to the client.');
            $('#rq-reason-' + id).trigger('focus');
            return;
        }

        $btn.addClass('is-loading').prop('disabled', true);

        API.admin.resolveRequest(id, 'decline', { reason: reason }).then(
            function (data) {
                UI.toast({ title: data.message, tone: 'info' });
                loadAdminRequests();
            },
            function (err) {
                $btn.removeClass('is-loading').prop('disabled', false);
                requestAlert(id, err.error);
            }
        );
    });
});

function requestAlert(id, text) {
    $('#rq-alert-' + id).html('<div class="login-alert" role="alert">' +
        UI.icon('alertCircle', 15) + '<span>' + FMT.esc(text) + '</span></div>');
}
