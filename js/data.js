/* ==========================================================================
   data.js
   --------------------------------------------------------------------------
   ALL the fake ("mock") data for the prototype lives here, plus small helper
   functions for formatting money and dates.

   There is no server and no database - this file IS the database.
   Want to change a customer's name or add a policy? Edit it here and the
   whole app updates.

   This file creates two global variables:

     FMT   - formatting helpers, e.g. FMT.money(1000) -> "$1,000"
     DATA  - the data itself,     e.g. DATA.getCustomer("cus-001")

   HOW THE FILE IS ORGANISED
     1. FMT   - formatting helpers
     2. DATA  - representatives, customers, policies, products,
                recommendations, appointments, notifications, glossary,
                analytics, and lookup functions
   ========================================================================== */


/* ==========================================================================
   1. FMT - FORMATTING HELPERS
   ========================================================================== */
var FMT = {

    /* ---- Money ----------------------------------------------------------
       Intl.NumberFormat is built into every browser. It knows how to write
       numbers the way people in a country expect (commas, currency symbol).
       We use Singapore dollars for this demo.                              */

    // 1250000 -> "$1,250,000"
    money: function (value) {
        var n = Number(value) || 0;
        return new Intl.NumberFormat('en-SG', {
            style: 'currency',
            currency: 'SGD',
            maximumFractionDigits: 0
        }).format(n);
    },

    // Short version for tight spaces: 1250000 -> "$1.25M", 250000 -> "$250K"
    moneyShort: function (value) {
        var n = Number(value) || 0;
        var sign = n < 0 ? '-' : '';
        var abs = Math.abs(n);

        if (abs >= 1000000) {
            return sign + '$' + FMT.trim(abs / 1000000) + 'M';
        }
        if (abs >= 1000) {
            return sign + '$' + FMT.trim(abs / 1000) + 'K';
        }
        return sign + '$' + Math.round(abs);
    },

    // Helper for moneyShort: 1.25 stays 1.25, but 125.4 becomes 125
    trim: function (n) {
        return String(n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
    },

    // 1234 -> "1,234"
    num: function (value) {
        return new Intl.NumberFormat('en-SG').format(Number(value) || 0);
    },

    // 62 -> "62%"
    pct: function (value, decimals) {
        return (Number(value) || 0).toFixed(decimals || 0) + '%';
    },


    /* ---- Dates ----------------------------------------------------------

       ==================================================================
       EVERY DATE AND TIME IN THIS APPLICATION IS SINGAPORE TIME
       ==================================================================

       Not the browser's time. This used to format with the 'en-SG' LOCALE, which
       only decides the wording - "12 Mar" rather than "Mar 12" - and left the
       ZONE as wherever the laptop happened to be. So the same appointment read
       9:00 AM to the representative and 1:00 AM to somebody demonstrating the app
       from London, and "Good morning" arrived in the evening.

       The product is Singaporean, both people in every conversation are in
       Singapore, and the figures are in Singapore dollars. One zone, stated once,
       is the only version anybody can reason about.

       WHY A FIXED OFFSET IS SAFE HERE, AND WOULD NOT BE ANYWHERE ELSE:
       Singapore has had no daylight saving since 1935 and sits permanently at
       +08:00. So a wall-clock time can be turned into an instant by writing the
       offset on it. Do this for Europe/London and you are wrong for half the
       year.                                                                 */

    TZ: 'Asia/Singapore',
    TZ_OFFSET: '+08:00',

    // Turns anything (string, Date) into a real Date, or null if invalid
    toDate: function (input) {
        if (!input) { return null; }
        var d = (input instanceof Date) ? input : new Date(input);
        return isNaN(d.getTime()) ? null : d;
    },

    /* The calendar parts of an instant AS READ IN SINGAPORE.

       formatToParts is the only way to ask "what does the clock in Singapore say"
       without shipping a time-zone library. getFullYear() and friends answer for
       the machine the code is running on, which is the whole problem. */
    sgParts: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return null; }

        var parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: FMT.TZ,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(d);

        var out = {};

        parts.forEach(function (p) {
            if (p.type !== 'literal') { out[p.type] = p.value; }
        });

        return {
            year: Number(out.year),
            month: Number(out.month),
            day: Number(out.day),
            /* hour12:false still writes midnight as '24' in some engines. */
            hour: Number(out.hour) % 24,
            minute: Number(out.minute)
        };
    },

    /* 'YYYY-MM-DD' for the Singapore calendar day an instant falls on.

       NEVER use toISOString().slice(0,10) for this: it converts to UTC first, so
       anything after 8am UTC - i.e. after 4pm in Singapore - lands on the wrong
       day. That is the single most common calendar bug there is. */
    sgDayKey: function (input) {
        var p = FMT.sgParts(input || new Date());
        if (!p) { return ''; }

        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return p.year + '-' + pad(p.month) + '-' + pad(p.day);
    },

    // 0-23, on the clock in Singapore
    sgHour: function (input) {
        var p = FMT.sgParts(input || new Date());
        return p ? p.hour : 0;
    },

    /* A wall-clock date and time in Singapore -> the instant it refers to.
       Used by the booking form, so "3pm" means 3pm in Singapore no matter where
       the person filling it in is sitting. */
    sgInstant: function (dayKey, hhmm) {
        var d = new Date(String(dayKey) + 'T' + String(hhmm || '00:00') + ':00' + FMT.TZ_OFFSET);
        return isNaN(d.getTime()) ? null : d;
    },

    // "Good morning" / "Good afternoon" / "Good evening", by the Singapore clock
    greeting: function () {
        var hour = FMT.sgHour();
        if (hour < 12) { return 'Good morning'; }
        if (hour < 18) { return 'Good afternoon'; }
        return 'Good evening';
    },

    // "12 Mar 2026"
    dateLong: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return '-'; }
        return d.toLocaleDateString('en-SG', {
            timeZone: FMT.TZ, day: 'numeric', month: 'short', year: 'numeric'
        });
    },

    // "Mon, 12 Mar"
    dateShort: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return '-'; }
        return d.toLocaleDateString('en-SG', {
            timeZone: FMT.TZ, weekday: 'short', day: 'numeric', month: 'short'
        });
    },

    // "2:00 PM"
    time: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return '-'; }
        return d.toLocaleTimeString('en-SG', {
            timeZone: FMT.TZ, hour: 'numeric', minute: '2-digit', hour12: true
        });
    },

    // { month:"MAR", day:"12", weekday:"Mon" } - for the appointment date block
    dateParts: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return { month: '-', day: '-', weekday: '' }; }

        return {
            month: d.toLocaleDateString('en-SG', { timeZone: FMT.TZ, month: 'short' }).toUpperCase(),
            /* From sgParts, not getDate(). getDate() would say the 12th to a
               representative in Singapore and the 11th to anybody west of it. */
            day: String((FMT.sgParts(d) || {}).day || '-'),
            weekday: d.toLocaleDateString('en-SG', { timeZone: FMT.TZ, weekday: 'short' })
        };
    },

    // "Today, 2:00 PM" / "Tomorrow, 9:30 AM" / "Mon, 12 Mar, 2:00 PM"
    friendly: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return '-'; }

        /* Compared as Singapore calendar days. Doing this with local getters made
           "Today" wrong for the last eight hours of every Singapore day when the
           browser was further west. */
        var noon = function (key) { return new Date(key + 'T12:00:00' + FMT.TZ_OFFSET).getTime(); };

        var days = Math.round(
            (noon(FMT.sgDayKey(d)) - noon(FMT.sgDayKey(new Date()))) / 86400000
        );

        if (days === 0) { return 'Today, ' + FMT.time(d); }
        if (days === 1) { return 'Tomorrow, ' + FMT.time(d); }
        if (days === -1) { return 'Yesterday, ' + FMT.time(d); }
        return FMT.dateShort(d) + ', ' + FMT.time(d);
    },

    // "3 days ago" / "in 2 weeks".
    // Intl.RelativeTimeFormat handles the wording and pluralisation for us.
    relative: function (input) {
        var d = FMT.toDate(input);
        if (!d) { return '-'; }

        var diff = d.getTime() - Date.now();
        var abs = Math.abs(diff);
        var rtf = new Intl.RelativeTimeFormat('en-SG', { numeric: 'auto' });

        var units = [
            ['year', 31536000000],
            ['month', 2592000000],
            ['week', 604800000],
            ['day', 86400000],
            ['hour', 3600000],
            ['minute', 60000]
        ];

        for (var i = 0; i < units.length; i++) {
            var name = units[i][0];
            var ms = units[i][1];
            // Use this unit if the gap is big enough, or if it is our last option
            if (abs >= ms || name === 'minute') {
                return rtf.format(Math.round(diff / ms), name);
            }
        }
        return 'just now';
    },


    /* ---- People --------------------------------------------------------- */

    // "Sarah Tan" -> "ST"   (used for avatar circles)
    initials: function (name) {
        var parts = String(name || '').trim().split(/\s+/);
        if (!parts[0]) { return '?'; }
        if (parts.length === 1) { return parts[0].substring(0, 2).toUpperCase(); }
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    },

    // Picks one of 5 avatar colours based on the text given.
    // Same text always gives the same colour, so a person's colour never changes.
    avatarTint: function (seed) {
        var text = String(seed || '');
        var total = 0;
        for (var i = 0; i < text.length; i++) {
            total += text.charCodeAt(i);
        }
        var index = total % 5;
        return index === 0 ? '' : 'av-' + index;   // '' = the default red
    },

    // Makes text safe to drop into HTML.
    // Needed for anything the USER typed, so a stray "<" cannot break the page.
    esc: function (text) {
        return String(text === null || text === undefined ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
};


/* ==========================================================================
   2. DATA
   --------------------------------------------------------------------------
   Wrapped in an IIFE (Immediately Invoked Function Expression).
   That is just a function we write and run straight away:  (function(){...})()
   Why? Anything declared inside stays private. Only what we `return` becomes
   part of DATA. It keeps helper variables from leaking into the global scope.
   ========================================================================== */
var DATA = (function () {

    var DAY = 86400000;   // one day in milliseconds

    /* Dates are generated RELATIVE to today, so the demo always looks current.
       daysFromNow(0, 14, 0)  = today at 2:00 PM
       daysFromNow(-12, 15)   = 12 days ago at 3:00 PM                       */
    function daysFromNow(days, hour, minute) {
        var d = new Date(Date.now() + days * DAY);
        d.setHours(hour || 9, minute || 0, 0, 0);
        return d.toISOString();
    }

    function yearsAgo(years, month, day) {
        var d = new Date();
        d.setFullYear(d.getFullYear() - years, (month || 3) - 1, day || 12);
        d.setHours(9, 0, 0, 0);
        return d.toISOString();
    }

    function yearsAhead(years, month, day) {
        var d = new Date();
        d.setFullYear(d.getFullYear() + years, (month || 3) - 1, day || 12);
        d.setHours(9, 0, 0, 0);
        return d.toISOString();
    }


    /* ======================================================================
       FINANCIAL REPRESENTATIVES
       ====================================================================== */
    var reps = [
        {
            id: 'fr-001',
            name: 'Kristin Henessy',
            role: 'Senior Financial Representative',
            title: 'Retirement & Wealth Protection Specialist',
            email: 'kristin.henessy@navigator-demo.sg',
            phone: '+65 8123 4477',
            office: 'Marina Bay Financial Centre, Tower 2',
            rating: 4.9,
            reviews: 187,
            years: 9,
            licence: 'MAS Rep. No. KH2094817',
            languages: ['English', 'Mandarin', 'Bahasa Melayu'],
            replyTime: 'Typically replies within 2 hours',
            specialisations: [
                'Retirement planning and wealth accumulation',
                'Critical illness and hospitalisation protection',
                'Legacy and estate planning for families'
            ],
            highlights: [
                '9 years of experience in financial advisory',
                'Specialises in retirement planning and tax-efficient wealth strategies',
                'Clients on a full plan review see around 17% better retirement outcomes on average',
                'Known for a proactive and personalised advisory approach'
            ],
            bio: 'Kristin works with young families and mid-career professionals to build protection that keeps pace with real life. She prefers plain language over jargon, and always ties a recommendation back to a specific goal.',
            stats: { customers: 48, reviews: 6, satisfaction: 96 }
        },
        {
            id: 'fr-002',
            name: 'Marcus Lim',
            role: 'Financial Representative',
            title: 'Family Protection Specialist',
            email: 'marcus.lim@navigator-demo.sg',
            phone: '+65 8455 2210',
            office: 'Paya Lebar Quarter 3',
            rating: 4.7,
            reviews: 92,
            years: 5,
            licence: 'MAS Rep. No. ML1180032',
            languages: ['English', 'Mandarin'],
            replyTime: 'Typically replies within 4 hours',
            specialisations: ['Young family protection', 'Education funding', 'Income replacement'],
            highlights: ['5 years of advisory experience', 'Focus on first-time policy holders'],
            bio: 'Marcus helps first-time policy holders understand what they are buying before they buy it.',
            stats: { customers: 31, reviews: 4, satisfaction: 93 }
        }
    ];


    /* ======================================================================
       CUSTOMERS

       "coverage" is the heart of the demo. For each type of protection:
         current     = how much cover they have today
         recommended = how much a standard needs-calculation suggests
       The difference between the two is the "protection gap".
       ====================================================================== */
    var customers = [
        {
            id: 'cus-001',
            name: 'Sarah Tan',
            salutation: 'Mrs',
            firstName: 'Sarah',
            age: 38,
            occupation: 'Marketing Director',
            employer: 'Meridian Retail Group',
            maritalStatus: 'Married',
            dependants: 3,
            dependantDetail: '3 children, aged 6, 9 and 11',
            email: 'sarah.tan@example.sg',
            phone: '+65 9123 8871',
            location: 'Tampines, Singapore',
            repId: 'fr-001',
            clientSince: yearsAgo(4, 6, 2),
            status: 'active',
            segment: 'Growing family',
            riskProfile: 'Moderate',
            riskScore: 55,
            protectionScore: 28,
            priority: 'critical',
            tags: ['Critical gap', 'High priority', 'Underinsured'],
            money: {
                annualIncome: 250000,
                monthlyIncome: 20833,
                monthlyExpenses: 12000,
                monthlyCommitments: 4500,
                premiumBudget: 600,
                savings: 120000,
                cpf: 280000,
                mortgage: 850000,
                emergencyMonths: 3,
                retireAge: 62,
                retireMonthlyTarget: 10000
            },
            goals: [
                { label: 'Protect the family income until the children finish university', horizon: '15 years', priority: 'Critical' },
                { label: 'Cover the $850K mortgage if something happens', horizon: 'Immediate', priority: 'Critical' },
                { label: 'Ensure children\'s education is funded', horizon: '12 years', priority: 'High' }
            ],
            concerns: [
                'Current life cover of $25K is critically insufficient for family needs',
                'No critical illness coverage despite high-stress executive role',
                'Large mortgage with minimal protection in place'
            ],
            lifeEvents: [
                { label: 'Promoted to Senior Director, income up 89%', date: daysFromNow(-40, 9) },
                { label: 'Upgraded home, took larger mortgage', date: daysFromNow(-180, 11) },
                { label: 'Third child born', date: daysFromNow(-420, 9) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 25000, recommended: 2500000 },
                ci: { label: 'Critical illness', current: 0, recommended: 500000 },
                hospital: { label: 'Hospitalisation', text: 'Private wards, as charged' },
                tpd: { label: 'Total & permanent disability', current: 0, recommended: 500000 },
                income: { label: 'Monthly income replacement', current: 0, recommended: 12000, monthly: true }
            },
            policyIds: ['pol-001'],
            lastContact: daysFromNow(-12, 15),
            lastReview: daysFromNow(-402, 10),
            aiSummary: 'Sarah is the main income earner in a family of five with a large $850K mortgage. Her death benefit of $25K covers only 1% of what her family would need. With $250K annual income and three children, she needs roughly $2.5M in life coverage. She has room in her monthly budget and recent promotion, so comprehensive protection is both urgent and affordable.',
            talkingPoints: [
                'Income nearly doubled to $250K but protection remains at minimal $25K',
                'Critical illness cover is $0 against a suggested $500K for her income level',
                'No income replacement or disability cover despite being sole breadwinner',
                'Budget allows $600/month - enough for comprehensive family protection'
            ]
        },

        {
            id: 'cus-002',
            name: 'Daniel Wong',
            salutation: 'Mr',
            firstName: 'Daniel',
            age: 45,
            occupation: 'Operations Manager',
            employer: 'Keppel Logistics',
            maritalStatus: 'Married',
            dependants: 3,
            dependantDetail: '3 children, aged 8, 12 and 15',
            email: 'daniel.wong@example.sg',
            phone: '+65 9772 3310',
            location: 'Bukit Panjang, Singapore',
            repId: 'fr-001',
            clientSince: yearsAgo(7, 2, 18),
            status: 'active',
            segment: 'Established family',
            riskProfile: 'Conservative',
            riskScore: 32,
            protectionScore: 78,
            priority: 'medium',
            tags: ['Education funding', 'Well covered'],
            money: {
                annualIncome: 108000,
                monthlyIncome: 9000,
                monthlyExpenses: 6900,
                monthlyCommitments: 5100,
                premiumBudget: 560,
                savings: 96000,
                cpf: 132000,
                mortgage: 262000,
                emergencyMonths: 6,
                retireAge: 65,
                retireMonthlyTarget: 5200
            },
            goals: [
                { label: 'Fund three university educations', horizon: '3 to 10 years', priority: 'High' },
                { label: 'Clear the mortgage before retirement', horizon: '12 years', priority: 'Medium' }
            ],
            concerns: [
                'Education costs rising faster than his savings plan',
                'Wants to avoid increasing monthly outgoings'
            ],
            lifeEvents: [
                { label: 'Eldest child entering junior college', date: daysFromNow(-60, 9) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 750000, recommended: 900000 },
                ci: { label: 'Critical illness', current: 300000, recommended: 380000 },
                hospital: { label: 'Hospitalisation', text: 'Public wards, as charged' },
                tpd: { label: 'Total & permanent disability', current: 200000, recommended: 250000 },
                income: { label: 'Monthly income replacement', current: 3000, recommended: 4500, monthly: true }
            },
            policyIds: ['pol-003', 'pol-004', 'pol-005'],
            lastContact: daysFromNow(-4, 11),
            lastReview: daysFromNow(-118, 14),
            aiSummary: 'Daniel is well protected on the essentials. The open question is education funding: three children, with the eldest three years from university. An endowment or education savings track matters more here than additional protection.',
            talkingPoints: [
                'Protection is broadly adequate, so lead with education funding',
                'Eldest child needs funds in roughly 3 years',
                'Prefers no increase in monthly commitment, so consider a single premium option'
            ]
        },

        {
            id: 'cus-003',
            name: 'Priya Raman',
            salutation: 'Ms',
            firstName: 'Priya',
            age: 29,
            occupation: 'Software Engineer',
            employer: 'Sentinel Fintech',
            maritalStatus: 'Single',
            dependants: 0,
            dependantDetail: 'Supports her parents',
            email: 'priya.raman@example.sg',
            phone: '+65 8890 4412',
            location: 'Queenstown, Singapore',
            repId: 'fr-001',
            clientSince: yearsAgo(1, 8, 5),
            status: 'active',
            segment: 'Young professional',
            riskProfile: 'Growth',
            riskScore: 78,
            protectionScore: 41,
            priority: 'high',
            tags: ['First policy', 'High growth appetite', 'New client'],
            money: {
                annualIncome: 96000,
                monthlyIncome: 8000,
                monthlyExpenses: 3800,
                monthlyCommitments: 1900,
                premiumBudget: 300,
                savings: 62000,
                cpf: 41000,
                mortgage: 0,
                emergencyMonths: 8,
                retireAge: 55,
                retireMonthlyTarget: 5000
            },
            goals: [
                { label: 'Build a long-term investment base', horizon: '20+ years', priority: 'High' },
                { label: 'Cover her parents if anything happens to her', horizon: 'Immediate', priority: 'High' }
            ],
            concerns: ['Does not want to over-insure early', 'Prefers flexible, portable plans'],
            lifeEvents: [
                { label: 'Changed employer, salary up 22%', date: daysFromNow(-140, 10) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 150000, recommended: 500000 },
                ci: { label: 'Critical illness', current: 50000, recommended: 300000 },
                hospital: { label: 'Hospitalisation', text: 'Public wards' },
                tpd: { label: 'Total & permanent disability', current: 0, recommended: 200000 },
                income: { label: 'Monthly income replacement', current: 0, recommended: 4000, monthly: true }
            },
            policyIds: ['pol-006'],
            lastContact: daysFromNow(-19, 16),
            lastReview: daysFromNow(-190, 10),
            aiSummary: 'Priya has strong cash flow and no legal dependants, but she supports her parents financially. Critical illness cover is cheap at 29 and locks in her current health status. Her growth appetite suggests an investment-linked component would suit her.',
            talkingPoints: [
                'Premiums are lowest now, so locking in cover at 29 is a cost argument, not a fear argument',
                'She supports her parents, so income replacement is relevant even without dependants',
                'High risk appetite fits an investment-linked plan alongside basic protection'
            ]
        },

        {
            id: 'cus-004',
            name: 'Grace Chua',
            salutation: 'Mdm',
            firstName: 'Grace',
            age: 52,
            occupation: 'Business Owner',
            employer: 'Chua & Sons Trading',
            maritalStatus: 'Married',
            dependants: 1,
            dependantDetail: '1 child in university',
            email: 'grace.chua@example.sg',
            phone: '+65 9004 7781',
            location: 'Serangoon, Singapore',
            repId: 'fr-001',
            clientSince: yearsAgo(11, 4, 9),
            status: 'review-due',
            segment: 'Pre-retiree',
            riskProfile: 'Balanced',
            riskScore: 48,
            protectionScore: 70,
            priority: 'high',
            tags: ['Retirement income', 'Legacy planning', 'Review due'],
            money: {
                annualIncome: 186000,
                monthlyIncome: 15500,
                monthlyExpenses: 8200,
                monthlyCommitments: 4400,
                premiumBudget: 1200,
                savings: 420000,
                cpf: 210000,
                mortgage: 0,
                emergencyMonths: 12,
                retireAge: 60,
                retireMonthlyTarget: 9000
            },
            goals: [
                { label: 'Convert business proceeds into a retirement income stream', horizon: '8 years', priority: 'High' },
                { label: 'Leave a defined legacy for her child', horizon: 'Long term', priority: 'Medium' }
            ],
            concerns: ['The business is her main asset and it is not liquid', 'Long-term care costs for her mother'],
            lifeEvents: [
                { label: 'Sold a warehouse unit', date: daysFromNow(-45, 14) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 600000, recommended: 700000 },
                ci: { label: 'Critical illness', current: 250000, recommended: 400000 },
                hospital: { label: 'Hospitalisation', text: 'Private wards, as charged' },
                tpd: { label: 'Total & permanent disability', current: 150000, recommended: 300000 },
                income: { label: 'Monthly retirement income', current: 0, recommended: 9000, monthly: true }
            },
            policyIds: ['pol-007', 'pol-008'],
            lastContact: daysFromNow(-31, 10),
            lastReview: daysFromNow(-430, 15),
            aiSummary: 'Grace is eight years from her target retirement age with significant liquid savings after an asset sale. The priority is a guaranteed income structure, plus long-term care cover given her family history.',
            talkingPoints: [
                'The recent asset sale creates a single-premium opportunity',
                'A retirement income gap of roughly $9,000 a month is the headline number',
                'Long-term care for her mother is both an emotional and a practical driver'
            ]
        },

        {
            id: 'cus-005',
            name: 'Aaron Sim',
            salutation: 'Mr',
            firstName: 'Aaron',
            age: 34,
            occupation: 'Physiotherapist',
            employer: 'Self-employed',
            maritalStatus: 'Married',
            dependants: 1,
            dependantDetail: '1 child, aged 2',
            email: 'aaron.sim@example.sg',
            phone: '+65 8221 9903',
            location: 'Punggol, Singapore',
            repId: 'fr-002',
            clientSince: yearsAgo(2, 10, 22),
            status: 'active',
            segment: 'New family',
            riskProfile: 'Moderate',
            riskScore: 50,
            protectionScore: 55,
            priority: 'medium',
            tags: ['Self-employed', 'Income protection'],
            money: {
                annualIncome: 84000,
                monthlyIncome: 7000,
                monthlyExpenses: 4600,
                monthlyCommitments: 3300,
                premiumBudget: 280,
                savings: 38000,
                cpf: 22000,
                mortgage: 310000,
                emergencyMonths: 3,
                retireAge: 65,
                retireMonthlyTarget: 4500
            },
            goals: [
                { label: 'Protect a variable self-employed income', horizon: 'Immediate', priority: 'High' }
            ],
            concerns: ['No employer medical benefits', 'Income stops entirely if he cannot work'],
            lifeEvents: [
                { label: 'First child born', date: daysFromNow(-730, 8) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 300000, recommended: 620000 },
                ci: { label: 'Critical illness', current: 80000, recommended: 250000 },
                hospital: { label: 'Hospitalisation', text: 'Public wards' },
                tpd: { label: 'Total & permanent disability', current: 0, recommended: 200000 },
                income: { label: 'Monthly income replacement', current: 0, recommended: 3500, monthly: true }
            },
            policyIds: ['pol-009'],
            lastContact: daysFromNow(-8, 12),
            lastReview: daysFromNow(-260, 11),
            aiSummary: 'Aaron is self-employed with a thin emergency fund and no employer safety net. Disability income protection is the single highest-impact gap in his plan.',
            talkingPoints: [
                'Self-employed with a 3-month emergency fund, so income protection is urgent',
                'No employer medical cover to fall back on',
                'Tight budget, so sequence the recommendation rather than bundling everything'
            ]
        },

        {
            id: 'cus-006',
            name: 'Nadia Iskandar',
            salutation: 'Ms',
            firstName: 'Nadia',
            age: 41,
            occupation: 'Secondary School Teacher',
            employer: 'Ministry of Education',
            maritalStatus: 'Divorced',
            dependants: 2,
            dependantDetail: '2 children, aged 11 and 14',
            email: 'nadia.iskandar@example.sg',
            phone: '+65 9668 1204',
            location: 'Woodlands, Singapore',
            repId: 'fr-001',
            clientSince: yearsAgo(6, 1, 30),
            status: 'active',
            segment: 'Single parent',
            riskProfile: 'Conservative',
            riskScore: 28,
            protectionScore: 58,
            priority: 'high',
            tags: ['Sole breadwinner', 'Education funding', 'Protection gap'],
            money: {
                annualIncome: 92000,
                monthlyIncome: 7650,
                monthlyExpenses: 5300,
                monthlyCommitments: 4100,
                premiumBudget: 340,
                savings: 71000,
                cpf: 88000,
                mortgage: 198000,
                emergencyMonths: 5,
                retireAge: 63,
                retireMonthlyTarget: 4800
            },
            goals: [
                { label: 'Guarantee the children are provided for, as sole earner', horizon: '10 years', priority: 'High' },
                { label: 'Build an education fund for two children', horizon: '4 to 7 years', priority: 'High' }
            ],
            concerns: ['She is the only income earner', 'Cannot afford a large premium increase'],
            lifeEvents: [
                { label: 'Became the sole income earner', date: daysFromNow(-620, 10) }
            ],
            coverage: {
                life: { label: 'Life / death benefit', current: 350000, recommended: 800000 },
                ci: { label: 'Critical illness', current: 120000, recommended: 320000 },
                hospital: { label: 'Hospitalisation', text: 'Public wards, as charged' },
                tpd: { label: 'Total & permanent disability', current: 100000, recommended: 250000 },
                income: { label: 'Monthly income replacement', current: 0, recommended: 3800, monthly: true }
            },
            policyIds: ['pol-010', 'pol-011'],
            lastContact: daysFromNow(-22, 17),
            lastReview: daysFromNow(-300, 10),
            aiSummary: 'Nadia is the sole income earner for two school-age children. Term cover running to her youngest child\u2019s 25th birthday gives the largest protection increase per dollar of premium, given her tight budget.',
            talkingPoints: [
                'Sole earner, so the death benefit shortfall is the headline risk',
                'Term cover to age 25 of the youngest child is the efficient structure',
                'Keep any increase under about $80 a month'
            ]
        }
    ];


    /* ======================================================================
       POLICIES THE CUSTOMERS ALREADY HOLD
       ====================================================================== */
    var policies = [
        {
            id: 'pol-001', customerId: 'cus-001', name: 'PRUShield Premier',
            category: 'Hospitalisation', icon: 'shield', number: 'PS-4471-0092',
            coverText: 'As charged, private hospital',
            premium: { amount: 612, per: 'yearly' },
            start: yearsAgo(4, 6, 15), renewal: daysFromNow(96, 9),
            termText: 'Annually renewable', status: 'active',
            payment: 'GIRO - DBS ending 4471',
            benefits: [
                'Private hospital ward, as charged',
                'Pre- and post-hospitalisation treatment for 180 days',
                'Day surgery and selected outpatient cancer treatment'
            ],
            riders: [{ name: 'Extra Saver rider', detail: 'Reduces your share of the bill to 5%, capped at $3,000 a year' }],
            exclusions: ['Cosmetic procedures', 'Pre-existing conditions declared at underwriting']
        },
        {
            id: 'pol-002', customerId: 'cus-001', name: 'PRULife Secure Term',
            category: 'Life & Critical Illness', icon: 'heart', number: 'PL-8820-1174',
            sumAssured: 400000, ciSumAssured: 100000,
            coverText: '$400,000 death benefit',
            premium: { amount: 168, per: 'monthly' },
            start: yearsAgo(4, 6, 15), renewal: daysFromNow(188, 9), maturity: yearsAhead(21, 6, 15),
            termText: 'Term to age 60', status: 'active',
            payment: 'GIRO - DBS ending 4471',
            benefits: [
                '$400,000 paid on death or terminal illness',
                '$100,000 critical illness benefit covering 30 conditions',
                'Premiums stay level for the full term'
            ],
            riders: [{ name: 'Waiver of premium', detail: 'Premiums are waived if a critical illness claim is approved' }],
            exclusions: ['Suicide within the first 12 months', 'Pre-existing critical conditions']
        },
        {
            id: 'pol-003', customerId: 'cus-002', name: 'PRULife Secure Term',
            category: 'Life & Critical Illness', icon: 'heart', number: 'PL-7712-4408',
            sumAssured: 750000, ciSumAssured: 300000,
            coverText: '$750,000 death benefit',
            premium: { amount: 284, per: 'monthly' },
            start: yearsAgo(7, 2, 20), renewal: daysFromNow(140, 9), maturity: yearsAhead(18, 2, 20),
            termText: 'Term to age 63', status: 'active',
            payment: 'GIRO - OCBC ending 2210',
            benefits: ['$750,000 death and terminal illness benefit', '$300,000 critical illness benefit'],
            riders: [],
            exclusions: ['Pre-existing critical conditions']
        },
        {
            id: 'pol-004', customerId: 'cus-002', name: 'PRUShield Standard',
            category: 'Hospitalisation', icon: 'shield', number: 'PS-7712-3391',
            coverText: 'As charged, public hospital (B1 ward)',
            premium: { amount: 388, per: 'yearly' },
            start: yearsAgo(7, 2, 20), renewal: daysFromNow(52, 9),
            termText: 'Annually renewable', status: 'active',
            payment: 'MediSave',
            benefits: ['Public hospital B1 ward, as charged', 'Pre- and post-hospitalisation for 90 days'],
            riders: [],
            exclusions: ['Private hospital treatment above the plan limits']
        },
        {
            id: 'pol-005', customerId: 'cus-002', name: 'PRUWealth Endowment',
            category: 'Savings & Endowment', icon: 'layers', number: 'PW-7712-8802',
            sumAssured: 120000,
            coverText: '$120,000 maturity target',
            premium: { amount: 420, per: 'monthly' },
            start: yearsAgo(5, 8, 1), renewal: daysFromNow(76, 9), maturity: yearsAhead(5, 8, 1),
            termText: '10-year endowment', status: 'active',
            payment: 'GIRO - OCBC ending 2210',
            benefits: ['Guaranteed maturity value of $96,000', 'Projected total of $120,000 at the 4.25% illustration'],
            riders: [],
            exclusions: ['Cashing out in the first 3 years returns less than the premiums paid']
        },
        {
            id: 'pol-006', customerId: 'cus-003', name: 'PRUShield Standard',
            category: 'Hospitalisation', icon: 'shield', number: 'PS-9014-7723',
            coverText: 'As charged, public hospital (B1 ward)',
            premium: { amount: 268, per: 'yearly' },
            start: yearsAgo(1, 8, 10), renewal: daysFromNow(122, 9),
            termText: 'Annually renewable', status: 'active',
            payment: 'MediSave',
            benefits: ['Public hospital B1 ward, as charged', 'Day surgery cover'],
            riders: [],
            exclusions: ['Private hospital treatment above the plan limits']
        },
        {
            id: 'pol-007', customerId: 'cus-004', name: 'PRULegacy Whole Life',
            category: 'Whole Life', icon: 'award', number: 'PG-2280-1109',
            sumAssured: 600000, ciSumAssured: 250000,
            coverText: '$600,000 whole life cover',
            premium: { amount: 940, per: 'monthly' },
            start: yearsAgo(11, 4, 12), renewal: daysFromNow(30, 9),
            termText: 'Premiums to age 65', status: 'active',
            payment: 'GIRO - UOB ending 7781',
            benefits: ['$600,000 cover for life', '$250,000 critical illness cover to age 70', 'Shares in the participating fund bonuses'],
            riders: [{ name: 'Early stage CI rider', detail: 'Pays 25% of the sum assured on an early-stage diagnosis' }],
            exclusions: ['Information not disclosed at application']
        },
        {
            id: 'pol-008', customerId: 'cus-004', name: 'PRUShield Premier',
            category: 'Hospitalisation', icon: 'shield', number: 'PS-2280-4417',
            coverText: 'As charged, private hospital',
            premium: { amount: 1180, per: 'yearly' },
            start: yearsAgo(9, 4, 12), renewal: daysFromNow(18, 9),
            termText: 'Annually renewable', status: 'renewal-due',
            payment: 'GIRO - UOB ending 7781',
            benefits: ['Private hospital, as charged', 'Overseas emergency treatment'],
            riders: [{ name: 'Extra Saver rider', detail: 'Reduces your share of the bill to 5%' }],
            exclusions: ['Cosmetic procedures']
        },
        {
            id: 'pol-009', customerId: 'cus-005', name: 'PRULife Secure Term',
            category: 'Life & Critical Illness', icon: 'heart', number: 'PL-5530-9921',
            sumAssured: 300000, ciSumAssured: 80000,
            coverText: '$300,000 death benefit',
            premium: { amount: 122, per: 'monthly' },
            start: yearsAgo(2, 10, 25), renewal: daysFromNow(64, 9), maturity: yearsAhead(26, 10, 25),
            termText: 'Term to age 60', status: 'active',
            payment: 'Credit card ending 9903',
            benefits: ['$300,000 death and terminal illness benefit', '$80,000 critical illness benefit'],
            riders: [],
            exclusions: ['Pre-existing conditions']
        },
        {
            id: 'pol-010', customerId: 'cus-006', name: 'PRULife Secure Term',
            category: 'Life & Critical Illness', icon: 'heart', number: 'PL-3391-2204',
            sumAssured: 350000, ciSumAssured: 120000,
            coverText: '$350,000 death benefit',
            premium: { amount: 154, per: 'monthly' },
            start: yearsAgo(6, 2, 2), renewal: daysFromNow(112, 9), maturity: yearsAhead(19, 2, 2),
            termText: 'Term to age 60', status: 'active',
            payment: 'GIRO - POSB ending 1204',
            benefits: ['$350,000 death and terminal illness benefit', '$120,000 critical illness benefit'],
            riders: [],
            exclusions: ['Pre-existing conditions']
        },
        {
            id: 'pol-011', customerId: 'cus-006', name: 'PRUShield Standard',
            category: 'Hospitalisation', icon: 'shield', number: 'PS-3391-8830',
            coverText: 'As charged, public hospital (B1 ward)',
            premium: { amount: 342, per: 'yearly' },
            start: yearsAgo(6, 2, 2), renewal: daysFromNow(41, 9),
            termText: 'Annually renewable', status: 'active',
            payment: 'MediSave',
            benefits: ['Public hospital B1 ward, as charged', 'Pre- and post-hospitalisation for 90 days'],
            riders: [],
            exclusions: ['Private hospital treatment above the plan limits']
        }
    ];


    /* ======================================================================
       PRODUCT CATALOGUE (what can be recommended)

       SAVINGS PLANS COME FIRST, and the order is the point.

       This screen used to open with term life and hospitalisation, and the three
       savings-shaped plans (investment-linked, retirement income, education
       endowment) were the tail of the list. That made the range read as a
       protection range with some savings bolted on.

       The three at the top are new. They exist because the range had a real hole
       in it, not to pad the catalogue:

         - PRUSave Guaranteed answers "I want to save for something on a date I
           can name, and I do not want to risk it". Nothing in the old catalogue
           did. Somebody saving a flat deposit was offered TERM LIFE, because the
           only rule that fired on "saving for a home" was the one about a debt
           outliving you. True, and not an answer to the question they asked.

         - PRUFlexiCash Saver answers "I can only put aside a small amount". The
           cheapest savings plan in the old range started at $250 a month.

         - PRULegacy Builder answers "I want to build value over decades" without
           market exposure being the only way to do it.

       THE PROTECTION PLANS STAY. The needs analysis, the coverage bars, the
       protection shortfall and the representative's "biggest gap first" ordering
       are all built on them, and a savings plan cannot answer "what happens to my
       family if I die". A range that could only sell savings would be a worse
       tool, not a more focused one.
       ====================================================================== */
    var products = [
        {
            id: 'prd-save', name: 'PRUSave Guaranteed', category: 'Capital-Guaranteed Savings',
            icon: 'lock', badge: 'Nothing at risk',
            tagline: 'A known amount on a known date, guaranteed from the day you start',
            coverFrom: 10000, premiumFrom: 150,
            payout: 'Guaranteed lump sum at maturity',
            features: [
                'The maturity value is guaranteed in writing before you sign',
                'Choose a 3, 5 or 10 year term to match what you are saving for',
                'Your capital is never exposed to a market',
                'A small life benefit is included while you save'
            ],
            considerations: [
                'Cashing out before maturity returns less than you paid in',
                'Guaranteed returns are lower than a market-linked plan over long periods',
                'It is a savings plan, so the life cover in it is nominal rather than real protection'
            ],
            bestFor: ['A property deposit', 'A dated goal', 'Savers who want certainty']
        },
        {
            id: 'prd-flexi', name: 'PRUFlexiCash Saver', category: 'Regular Savings',
            icon: 'dollarSign', badge: 'Start from $100',
            tagline: 'Save a little every month and take a cash benefit each year, or leave it to grow',
            coverFrom: 5000, premiumFrom: 100,
            payout: 'Yearly cash benefit, plus a maturity value',
            features: [
                'Starts from $100 a month and can be increased at any anniversary',
                'A yearly cash benefit you can withdraw or leave to accumulate',
                'Premiums can be paused for up to 12 months without lapsing',
                'No health questions for the standard amount'
            ],
            considerations: [
                'Taking the cash benefit every year reduces the final maturity value',
                'The accumulating interest rate is reviewed annually and is not guaranteed',
                'Small monthly amounts take a long time to become a meaningful sum'
            ],
            bestFor: ['Building a savings habit', 'Small monthly budgets', 'First-time savers']
        },
        {
            id: 'prd-legacy', name: 'PRULegacy Builder', category: 'Participating Whole Life Savings',
            icon: 'award', badge: 'Long-term value',
            tagline: 'Builds cash value over decades and shares in the participating fund',
            coverFrom: 100000, premiumFrom: 320,
            payout: 'Cash value on surrender, or a lump sum on death',
            features: [
                'Cash value builds every year you hold it',
                'Shares in the participating fund bonuses',
                'Premiums finish at 65 but the plan continues for life',
                'Can be borrowed against rather than surrendered'
            ],
            considerations: [
                'Bonuses are not guaranteed and depend on fund performance',
                'The cash value in the first ten years is less than the premiums paid',
                'It is a long commitment - stopping early is where the losses are'
            ],
            bestFor: ['Long horizons', 'Leaving something behind', 'Savers who want more than guaranteed']
        },
        {
            id: 'prd-active', name: 'PRUActive Protect', category: 'Term Life & Critical Illness',
            icon: 'shieldCheck', badge: 'Most flexible',
            tagline: 'Flexible term protection you can adjust as life changes',
            coverFrom: 100000, premiumFrom: 96,
            payout: 'Lump sum',
            features: [
                'Adjust the cover amount each year without a new health check',
                'Critical illness benefit covering 37 conditions',
                'Optional early-stage critical illness rider',
                'Premiums waived if a critical illness claim is approved'
            ],
            considerations: [
                'Term plans build no cash value, so nothing is returned if you outlive the term',
                'Premiums rise if you renew after the initial term ends',
                'The early-stage rider adds roughly 18% to the premium'
            ],
            bestFor: ['Income replacement', 'Mortgage protection', 'High cover on a budget']
        },
        {
            id: 'prd-ci', name: 'PRUCritical First', category: 'Critical Illness',
            icon: 'heart', badge: 'Broadest CI cover',
            tagline: 'Multi-stage critical illness cover that can pay more than once',
            coverFrom: 50000, premiumFrom: 128,
            payout: 'Staged lump sums',
            features: [
                'Pays at early, intermediate and severe stages',
                'Up to three separate claims for unrelated conditions',
                'Cover continues after an early-stage claim',
                'Special benefit for angioplasty and diabetic complications'
            ],
            considerations: [
                'Costs more than adding critical illness to a term plan',
                'Does not include any death benefit',
                '90-day waiting period from the policy start date'
            ],
            bestFor: ['Cancer and heart risk', 'Income during recovery', 'Family medical history']
        },
        {
            id: 'prd-income', name: 'PRUIncome Guard', category: 'Disability Income',
            icon: 'umbrella', badge: 'Income safety net',
            tagline: 'Replaces up to 75% of your monthly income if you cannot work',
            coverFrom: 1000, premiumFrom: 74,
            payout: 'Monthly benefit',
            features: [
                'Judged on your own occupation, not any occupation',
                'Paid monthly until you recover or the term ends',
                'Half the benefit paid for partial disability',
                'Rehabilitation and retraining support'
            ],
            considerations: [
                'The benefit is capped at 75% of your verified income',
                'A 90-day waiting period means you still need an emergency fund',
                'Premiums are higher for manual or high-risk jobs'
            ],
            bestFor: ['Self-employed income', 'Sole breadwinners', 'Specialist professionals']
        },
        {
            id: 'prd-growth', name: 'PRUWealth Horizon', category: 'Investment-Linked',
            icon: 'trendingUp', badge: 'Growth potential',
            tagline: 'Protection combined with a market-linked growth engine',
            coverFrom: 100000, premiumFrom: 300,
            payout: 'Lump sum plus account value',
            features: [
                'Choice of more than 40 funds across risk levels',
                'Four free fund switches a year',
                'Premium holiday available after year 3',
                'Top-ups allowed from year 2'
            ],
            considerations: [
                'The account value is not guaranteed and can fall',
                'Exit charges apply for the first 8 years',
                'Charges are taken from your units, which reduces the protection element'
            ],
            bestFor: ['Long time horizons', 'Growth appetite', 'Protection plus investing']
        },
        {
            id: 'prd-retire', name: 'PRURetire Income', category: 'Retirement Income',
            icon: 'compass', badge: 'Income certainty',
            tagline: 'Turns savings into a predictable monthly retirement income',
            coverFrom: 50000, premiumFrom: 500,
            payout: 'Monthly income stream',
            features: [
                'Guaranteed monthly income for 20 years, or for life',
                'Single premium or regular premium',
                'Optional income that rises with inflation',
                'Death benefit protects the remaining income stream'
            ],
            considerations: [
                'Locking money in early reduces your flexibility',
                'Bonus income is not guaranteed and depends on fund performance',
                'Withdrawing before the income start age reduces the guaranteed income'
            ],
            bestFor: ['Pre-retirees', 'Predictable income', 'Single lump sums']
        },
        {
            id: 'prd-edu', name: 'PRUEducation Builder', category: 'Endowment',
            icon: 'bookOpen', badge: 'Goal-dated',
            tagline: 'Targets a known amount on a known date',
            coverFrom: 20000, premiumFrom: 250,
            payout: 'Lump sum at maturity',
            features: [
                'The guaranteed maturity value is known upfront',
                'Premiums are waived if the paying parent dies or is disabled',
                'The premium term can be shorter than the policy term',
                'Partial withdrawal from year 6'
            ],
            considerations: [
                'Cashing out early returns less than the premiums paid',
                'Returns are modest compared with investing directly',
                'Projected values are not guaranteed'
            ],
            bestFor: ['Education funding', 'Saving for a fixed date', 'Cautious savers']
        },
        {
            id: 'prd-shield', name: 'PRUShield Premier + Extra Saver', category: 'Hospitalisation',
            icon: 'shield', badge: 'Medical upgrade',
            tagline: 'Private hospital cover with a capped share of the bill',
            coverFrom: 0, premiumFrom: 51,
            payout: 'Pays the eligible bill',
            features: [
                'Private hospital and A-ward treatment, as charged',
                'Your share of the bill drops to 5%, capped at $3,000 a year',
                'Pre- and post-hospitalisation cover for 180 days',
                'Panel and non-panel specialist options'
            ],
            considerations: [
                'Premiums rise as you move into each new age band',
                'The rider part must be paid in cash, not from MediSave',
                'Pre-existing conditions may be excluded'
            ],
            bestFor: ['Private hospital preference', 'Predictable medical bills', 'Families']
        }
    ];


    /* ======================================================================
       RECOMMENDATIONS
       Grouped by customer id. Each one has the five parts the brief asks for:
         1 recommendation   2 reasons   3 needs (built automatically below)
         4 considerations    5 nextAction
       "fit" is a 0-100 score of how well the product matches the profile.
       ====================================================================== */
    var recBook = {

        'cus-001': [
            {
                productId: 'prd-active', fit: 92, cover: 750000, premium: 118,
                term: 'Term to age 60, steps down from year 12',
                headline: 'Add $750,000 of adjustable term cover, including $300,000 of critical illness',
                recommendation: 'Layer an adjustable term plan on top of the existing PRULife Secure Term rather than replacing it. That keeps the original policy\u2019s pricing and health assessment intact, while closing the shortfall created by the promotion and the remaining mortgage.',
                whyFits: 'It closes most of the gap for about $118 a month, and the cover amount can step down as the mortgage shrinks and the children become independent, so you are not paying for cover you no longer need in 2038.',
                reasons: [
                    { title: 'Income rose 18% but cover did not', text: 'Protection was last set when income was around $112,000. At $132,000 with two dependent children, the indicative need is about $1.15M against $400,000 in force.' },
                    { title: 'The mortgage outlasts the children\u2019s dependency', text: '$385,000 is outstanding to 2041. Current life cover either repays the loan or replaces income, but not both.' },
                    { title: 'Adjustable cover suits a shrinking need', text: 'The amount can be reduced at any policy anniversary with no new health check, so the premium tracks the real need.' }
                ],
                considerations: [
                    { title: 'No cash value', text: 'A term plan returns nothing if it is outlived. It buys the most protection per dollar, not savings.' },
                    { title: 'Budget impact', text: 'Total protection premium moves from about $219 to $337 a month. That is inside the stated $420 budget, but worth confirming against the mortgage refinance.' },
                    { title: 'Health assessment still applies', text: 'Cover is subject to underwriting, so the final terms may differ from this illustration.' }
                ],
                nextAction: 'Review the comparison together, and check the shortfall at retirement age 62 before signing anything.',
                benefits: [
                    { label: 'Death & terminal illness', value: '$750,000' },
                    { label: 'Critical illness', value: '$300,000' },
                    { label: 'Premium waiver on CI claim', value: 'Included' },
                    { label: 'Cover ends', value: 'Age 60' }
                ]
            },
            {
                productId: 'prd-ci', fit: 88, cover: 300000, premium: 164,
                term: 'To age 75',
                headline: 'Standalone critical illness cover that pays across three stages',
                recommendation: 'Take critical illness as a standalone plan instead of a rider. It pays at early, intermediate and severe stages, and up to three separate times, which matters more than the headline number when recovery takes eighteen months rather than three.',
                whyFits: 'Her stated concern is time off work, not the medical bill. Staged payouts start the money moving at diagnosis rather than only at the severe stage.',
                reasons: [
                    { title: 'The stated worry is income, not treatment', text: 'The hospital plan already covers private treatment. What is missing is money to live on during recovery.' },
                    { title: 'Current cover is about 9 months of income', text: '$100,000 against $132,000 a year. The usual planning range is 3 to 5 years, or $400,000 to $660,000.' },
                    { title: 'Early-stage payouts change the timing', text: '25% at early stage means funds arrive while treatment decisions are being made, not after.' }
                ],
                considerations: [
                    { title: 'Costs more than a rider', text: 'About $164 a month against roughly $46 for an equivalent rider. The difference buys multi-stage and multi-claim cover.' },
                    { title: 'No death benefit', text: 'This plan pays on diagnosis only, so life cover must come from elsewhere.' },
                    { title: '90-day waiting period', text: 'Conditions diagnosed within 90 days of the start date are not covered.' }
                ],
                nextAction: 'Compare side by side with the cheaper rider option, so the extra cost is a deliberate choice.',
                benefits: [
                    { label: 'Early stage', value: '$75,000' },
                    { label: 'Intermediate stage', value: '$150,000' },
                    { label: 'Severe stage', value: '$300,000' },
                    { label: 'Maximum total claims', value: '$900,000' }
                ]
            },
            {
                productId: 'prd-growth', fit: 71, cover: 250000, premium: 300,
                term: 'Whole of life, premiums to age 62',
                headline: 'Optional: combine protection with a retirement growth engine',
                recommendation: 'An investment-linked plan could serve the retirement goal alongside protection. It is the lowest priority here, because the cost of delaying protection is higher than the cost of delaying growth.',
                whyFits: 'Retirement at 62 needs about $6,500 a month. Current savings and CPF alone do not reach that, and a 24-year horizon is long enough for market exposure to be reasonable.',
                reasons: [
                    { title: '24-year time horizon', text: 'Long enough to ride out market cycles at a moderate risk appetite of 55 out of 100.' },
                    { title: 'A retirement shortfall exists', text: 'Projected income at 62 falls short of the $6,500 monthly target on current savings alone.' },
                    { title: 'One plan doing two jobs', text: 'Provides a $250,000 death benefit while building an account value.' }
                ],
                considerations: [
                    { title: 'The value is not guaranteed', text: 'The account value moves with the funds selected and can fall.' },
                    { title: 'Exit charges', text: 'Leaving in the first 8 years incurs charges.' },
                    { title: 'Order matters', text: 'Closing the protection gap first is the stronger use of the same $300 a month.' }
                ],
                nextAction: 'Park this until protection is settled, then revisit at the next annual review.',
                benefits: [
                    { label: 'Death benefit', value: 'Higher of $250,000 or account value' },
                    { label: 'Illustrated at 4%', value: 'About $214,000 at age 62' },
                    { label: 'Illustrated at 8%', value: 'About $412,000 at age 62' },
                    { label: 'Loyalty bonus', value: '0.4% a year from year 11' }
                ]
            }
        ],

        'cus-002': [
            {
                productId: 'prd-edu', fit: 86, cover: 180000, premium: 0, singlePremium: 60000,
                term: 'Two tranches: 3 years and 8 years',
                headline: 'Split an education fund into two goal-dated tranches',
                recommendation: 'Use two endowment tranches timed to when each child needs fees, funded from existing savings rather than new monthly commitments. This respects his stated preference for no increase in monthly outgoings.',
                whyFits: 'Protection is already broadly adequate. The real deadline is the eldest child\u2019s university fees in about three years.',
                reasons: [
                    { title: 'Protection is not the gap', text: 'Life and critical illness cover sit within 20% of the indicative need, so adding more would not be the best use of the next dollar.' },
                    { title: 'Three known deadlines', text: 'Children aged 15, 12 and 8 create funding dates roughly 3, 6 and 10 years out.' },
                    { title: 'No increase in monthly commitment', text: 'A single premium from the $96,000 in savings keeps monthly cash flow unchanged.' }
                ],
                considerations: [
                    { title: 'The money is committed', text: 'Cashing out early returns less than was paid in, so only commit funds not needed for emergencies.' },
                    { title: 'Modest returns', text: 'The guaranteed maturity value is around 80% of premiums, with the rest not guaranteed.' },
                    { title: 'Keep the emergency fund intact', text: 'Six months of expenses should stay liquid outside this plan.' }
                ],
                nextAction: 'Confirm how much of the $96,000 can be committed, then illustrate both tranches.',
                benefits: [
                    { label: 'Tranche 1 maturity (year 3)', value: 'About $64,000' },
                    { label: 'Tranche 2 maturity (year 8)', value: 'About $116,000' },
                    { label: 'Premium waiver benefit', value: 'Included' },
                    { label: 'Death benefit during the term', value: '105% of premiums' }
                ]
            },
            {
                productId: 'prd-active', fit: 64, cover: 150000, premium: 42,
                term: 'Term to age 63',
                headline: 'Optional: a small top-up to align cover with the mortgage',
                recommendation: 'A modest $150,000 top-up would align life cover with the indicative need, but it is secondary to education funding.',
                whyFits: 'It closes a $150,000 residual life cover gap for a small premium.',
                reasons: [
                    { title: 'Small residual gap', text: '$750,000 held against about $900,000 indicated.' },
                    { title: 'Inexpensive at this size', text: 'About $42 a month for the remaining cover.' }
                ],
                considerations: [
                    { title: 'Not the priority', text: 'Education funding has a hard deadline. This does not.' },
                    { title: 'Term to 63 only', text: 'It matches the existing plan\u2019s expiry rather than extending it.' }
                ],
                nextAction: 'Mention it, but lead the meeting with education funding.',
                benefits: [
                    { label: 'Death & terminal illness', value: '$150,000' },
                    { label: 'Cover ends', value: 'Age 63' }
                ]
            }
        ],

        'cus-003': [
            {
                productId: 'prd-ci', fit: 88, cover: 250000, premium: 96,
                term: 'To age 75',
                headline: 'Lock in $250,000 of critical illness cover at age 29',
                recommendation: 'Start critical illness cover now, while premiums and health status are at their most favourable. This is a pricing argument rather than a fear argument.',
                whyFits: 'At 29 the same cover costs roughly 40% less than it will at 40, and her current good health means standard terms.',
                reasons: [
                    { title: 'Age is the lever', text: 'Premiums are set at your entry age and stay level. Waiting ten years raises the cost of identical cover substantially.' },
                    { title: 'Her parents depend on her income', text: 'She has no legal dependants, but she supports her parents, so a payout protects them.' },
                    { title: 'Current cover is thin', text: '$50,000 against about $300,000 indicated for her income level.' }
                ],
                considerations: [
                    { title: 'It is a long commitment', text: 'Cover to 75 means decades of premiums, though the amount can be reviewed as income changes.' },
                    { title: '90-day waiting period', text: 'Cover for the listed conditions begins after 90 days.' },
                    { title: 'Budget check', text: '$96 a month sits inside the $300 stated budget, leaving room for growth plans.' }
                ],
                nextAction: 'Agree the cover amount together, then look at how the remaining budget could go to a growth plan.',
                benefits: [
                    { label: 'Early stage', value: '$62,500' },
                    { label: 'Intermediate stage', value: '$125,000' },
                    { label: 'Severe stage', value: '$250,000' },
                    { label: 'Maximum total claims', value: '$750,000' }
                ]
            },
            {
                productId: 'prd-growth', fit: 82, cover: 200000, premium: 400,
                term: 'Whole of life',
                headline: 'Pair protection with a long-horizon growth plan',
                recommendation: 'A growth appetite of 78 out of 100 and a 26-year runway to her target retirement age of 55 make an investment-linked plan a reasonable fit alongside basic protection.',
                whyFits: 'High risk tolerance, strong cash flow, and a very long time horizon.',
                reasons: [
                    { title: 'Long runway', text: '26 years to her stated retirement age of 55.' },
                    { title: 'Strong surplus', text: 'About $4,200 a month unallocated after expenses and commitments.' },
                    { title: 'Matches her appetite', text: 'A growth profile of 78 out of 100 is consistent with equity-weighted funds.' }
                ],
                considerations: [
                    { title: 'Capital is not guaranteed', text: 'Values can fall as well as rise.' },
                    { title: 'Charges are front-loaded', text: 'Leaving in the first 8 years incurs charges.' },
                    { title: 'Protection first', text: 'Confirm critical illness cover is in place before committing the full amount.' }
                ],
                nextAction: 'Illustrate at both 4% and 8%, so the range drives the decision rather than a single number.',
                benefits: [
                    { label: 'Death benefit', value: 'Higher of $200,000 or account value' },
                    { label: 'Illustrated at 4%', value: 'About $196,000 at age 55' },
                    { label: 'Illustrated at 8%', value: 'About $384,000 at age 55' },
                    { label: 'Fund switches', value: '4 free a year' }
                ]
            }
        ],

        'cus-004': [
            {
                productId: 'prd-retire', fit: 90, cover: 0, premium: 0, singlePremium: 300000,
                term: 'Income from age 60 for 20 years',
                headline: 'Convert the asset sale into a guaranteed monthly income from age 60',
                recommendation: 'Allocate $300,000 of the recent asset sale to a retirement income plan starting at 60. This creates a predictable floor under her retirement while the business remains hard to sell.',
                whyFits: 'The business is her main asset and cannot be relied on for monthly income. This converts a lump sum into certainty.',
                reasons: [
                    { title: 'A liquidity event is happening now', text: 'The warehouse sale creates a single-premium opportunity that will not repeat.' },
                    { title: 'Eight years to her target', text: 'Retiring at 60 leaves enough time for the plan to build up before income starts.' },
                    { title: 'Income certainty is the goal', text: 'A guaranteed floor removes reliance on business cash flow after she steps back.' }
                ],
                considerations: [
                    { title: 'The funds are committed', text: 'Withdrawing before the income start age reduces the guaranteed income.' },
                    { title: 'Bonuses are not guaranteed', text: 'Only the guaranteed portion is certain. The bonus layer varies.' },
                    { title: 'Long-term care is separate', text: 'This plan does not address her mother\u2019s care costs, which need their own conversation.' }
                ],
                nextAction: 'Model income starting at 60 versus 65 before committing, then address long-term care separately.',
                benefits: [
                    { label: 'Guaranteed monthly income', value: 'About $2,150 from age 60' },
                    { label: 'Projected total income', value: 'About $2,980 a month including bonuses' },
                    { label: 'Income period', value: '20 years' },
                    { label: 'Death benefit', value: 'Balance paid to beneficiaries' }
                ]
            },
            {
                productId: 'prd-ci', fit: 78, cover: 150000, premium: 318,
                term: 'To age 75',
                headline: 'Top up critical illness before the next age band',
                recommendation: 'A $150,000 top-up closes the critical illness gap before the next age-band increase, and adds the multi-stage payouts her whole life plan does not provide.',
                whyFits: 'A family history of long-term care needs makes staged and repeat claims valuable.',
                reasons: [
                    { title: 'A $150,000 gap', text: '$250,000 held against about $400,000 indicated.' },
                    { title: 'An age band increase is approaching', text: 'Premiums step up at her next birthday band.' },
                    { title: 'Family medical history', text: 'Her mother\u2019s long-term care needs raise the value she places on staged payouts.' }
                ],
                considerations: [
                    { title: 'The premium is significant', text: '$318 a month reflects an entry age of 52.' },
                    { title: 'Health assessment at 52', text: 'Underwriting may result in a higher premium or an exclusion.' }
                ],
                nextAction: 'Quote both $100,000 and $150,000 so the premium trade-off is visible.',
                benefits: [
                    { label: 'Early stage', value: '$37,500' },
                    { label: 'Intermediate stage', value: '$75,000' },
                    { label: 'Severe stage', value: '$150,000' }
                ]
            }
        ],

        'cus-005': [
            {
                productId: 'prd-income', fit: 94, cover: 3500, premium: 88,
                term: 'To age 65, with a 90-day waiting period',
                headline: 'Protect $3,500 a month of self-employed income',
                recommendation: 'Income protection is the highest-impact gap in this plan. As a self-employed physiotherapist, his income stops the day he cannot treat patients, and there is no employer safety net behind him.',
                whyFits: 'A three-month emergency fund covers the waiting period, and nothing at all covers what comes after it.',
                reasons: [
                    { title: 'No employer safety net', text: 'Self-employed, with no group medical cover and no paid sick leave.' },
                    { title: 'A thin emergency fund', text: 'Three months of expenses. A six-month absence would exhaust savings and start eating into the mortgage buffer.' },
                    { title: 'A physical occupation', text: 'His income depends on hands-on treatment, so injury risk maps directly to income risk.' }
                ],
                considerations: [
                    { title: 'The benefit is capped at 75%', text: 'The monthly benefit cannot exceed 75% of verified income.' },
                    { title: 'A 90-day wait', text: 'The emergency fund still needs to cover the first three months.' },
                    { title: 'Occupation loading', text: 'Manual occupations attract higher premiums than desk-based ones.' }
                ],
                nextAction: 'Quote both 60-day and 90-day waiting periods so the premium difference is explicit.',
                benefits: [
                    { label: 'Monthly benefit', value: '$3,500' },
                    { label: 'Partial disability', value: '$1,750 a month' },
                    { label: 'Waiting period', value: '90 days' },
                    { label: 'Benefit runs to', value: 'Age 65' }
                ]
            },
            {
                productId: 'prd-active', fit: 80, cover: 320000, premium: 64,
                term: 'Term to age 60',
                headline: 'Match life cover to the mortgage and a young child',
                recommendation: 'A $320,000 top-up aligns life cover with the outstanding mortgage plus the years until his child is independent.',
                whyFits: 'Cover currently sits at $300,000 against a $310,000 mortgage alone, before any income replacement.',
                reasons: [
                    { title: 'The mortgage exceeds the cover', text: '$310,000 outstanding against $300,000 of life cover.' },
                    { title: 'His child is 2', text: 'Around 23 years of dependency remain.' }
                ],
                considerations: [
                    { title: 'Tight budget', text: 'Sequence this after income protection rather than buying both at once.' },
                    { title: 'No cash value', text: 'Term cover returns nothing if it is outlived.' }
                ],
                nextAction: 'Stage this for about three months after the income protection plan starts.',
                benefits: [
                    { label: 'Death & terminal illness', value: '$320,000' },
                    { label: 'Cover ends', value: 'Age 60' }
                ]
            }
        ],

        'cus-006': [
            {
                productId: 'prd-active', fit: 89, cover: 450000, premium: 74,
                term: 'Term to 2037, when her youngest child turns 25',
                headline: 'Term cover sized to her youngest child\u2019s independence',
                recommendation: 'Set a $450,000 term plan expiring when the younger child turns 25. Matching the term to the actual dependency period is what makes the premium fit a $340 monthly budget.',
                whyFits: 'As sole earner, the death benefit shortfall is the single largest risk, and a defined term buys the most cover per dollar.',
                reasons: [
                    { title: 'Sole income earner', text: 'There is no second income to fall back on, so the whole household need rests on one set of policies.' },
                    { title: 'A $450,000 gap', text: '$350,000 held against about $800,000 indicated for two dependent children and the mortgage.' },
                    { title: 'Term matched to the need', text: 'Cover to 2037 rather than to age 65 keeps the premium at about $74 a month.' }
                ],
                considerations: [
                    { title: 'Cover ends in 2037', text: 'If protection is still needed after that, a new plan at older-age rates would be required.' },
                    { title: 'Budget headroom is small', text: 'Total protection premium moves to about $228 a month against a $340 budget.' },
                    { title: 'The nomination must be updated', text: 'Following the divorce, the beneficiary nomination should be reviewed at the same time.' }
                ],
                nextAction: 'Confirm the beneficiary nomination first, then submit the term application.',
                benefits: [
                    { label: 'Death & terminal illness', value: '$450,000' },
                    { label: 'Critical illness', value: '$150,000' },
                    { label: 'Cover ends', value: '2037' }
                ]
            },
            {
                productId: 'prd-edu', fit: 72, cover: 80000, premium: 220,
                term: '7-year endowment',
                headline: 'Build a modest education fund on a 7-year track',
                recommendation: 'A small endowment maturing when the younger child reaches university keeps education funding separate from everyday savings.',
                whyFits: 'A fixed maturity date makes it harder to spend the money on something else.',
                reasons: [
                    { title: 'Two funding dates', text: 'Children aged 14 and 11 need funds in roughly 4 and 7 years.' },
                    { title: 'The premium waiver matters here', text: 'As sole earner, premiums are waived if she dies or is disabled.' }
                ],
                considerations: [
                    { title: 'Protection comes first', text: 'Only start this once the term top-up is in force.' },
                    { title: 'Combined premium', text: 'Both plans together would take her close to her stated budget ceiling.' }
                ],
                nextAction: 'Revisit after the term plan is issued.',
                benefits: [
                    { label: 'Projected maturity', value: 'About $21,000' },
                    { label: 'Premium waiver benefit', value: 'Included' }
                ]
            }
        ]
    };


    /* ======================================================================
       APPOINTMENTS
       ====================================================================== */
    var appointments = [
        {
            id: 'apt-001', customerId: 'cus-001', repId: 'fr-001',
            title: 'Protection review, coverage gap discussion',
            type: 'AI-assisted video call', mode: 'video',
            start: daysFromNow(0, 14, 0), minutes: 45,
            location: 'PRUWise video room', status: 'confirmed',
            agenda: [
                'Walk through the updated needs analysis',
                'Compare PRUActive Protect and PRUCritical First',
                'Agree a staged premium plan within budget'
            ],
            preparedBy: 'PRUWise',
            notes: 'Sarah asked for the comparison to be sent ahead of the call.'
        },
        {
            id: 'apt-002', customerId: 'cus-002', repId: 'fr-001',
            title: 'Education funding planning session',
            type: 'In-person meeting', mode: 'in-person',
            start: daysFromNow(1, 9, 30), minutes: 60,
            location: 'Marina Bay Financial Centre, Tower 2, Level 12', status: 'confirmed',
            agenda: ['Review endowment maturity timing', 'Discuss single-premium top-up options'],
            preparedBy: 'Kristin Henessy', notes: ''
        },
        {
            id: 'apt-003', customerId: 'cus-003', repId: 'fr-001',
            title: 'First plan walkthrough',
            type: 'Video call', mode: 'video',
            start: daysFromNow(2, 18, 30), minutes: 30,
            location: 'PRUWise video room', status: 'confirmed',
            agenda: ['Explain how critical illness cover works', 'Set a starting budget'],
            preparedBy: 'PRUWise', notes: 'Prefers evening slots after 6pm.'
        },
        {
            id: 'apt-004', customerId: 'cus-004', repId: 'fr-001',
            title: 'Retirement income structuring',
            type: 'In-person meeting', mode: 'in-person',
            start: daysFromNow(4, 11, 0), minutes: 75,
            location: 'Client office, Serangoon North', status: 'pending',
            agenda: ['Single premium allocation from the asset sale', 'Long-term care options'],
            preparedBy: 'Kristin Henessy', notes: 'Bring the long-term care illustration.'
        },
        {
            id: 'apt-005', customerId: 'cus-006', repId: 'fr-001',
            title: 'Sole-earner protection top-up',
            type: 'Phone call', mode: 'phone',
            start: daysFromNow(6, 16, 0), minutes: 30,
            location: 'Phone', status: 'confirmed',
            agenda: ['Term cover to age 25 of the youngest child', 'Keep the increase under $80 a month'],
            preparedBy: 'PRUWise', notes: ''
        },
        {
            id: 'apt-006', customerId: 'cus-001', repId: 'fr-001',
            title: 'Annual policy review',
            type: 'Video call', mode: 'video',
            start: daysFromNow(-402, 10, 0), minutes: 45,
            location: 'PRUWise video room', status: 'completed',
            agenda: ['Confirm beneficiary details', 'Review the hospital plan'],
            preparedBy: 'Kristin Henessy',
            notes: 'Agreed to revisit critical illness cover after her promotion.'
        },
        {
            id: 'apt-007', customerId: 'cus-001', repId: 'fr-001',
            title: 'Onboarding and needs analysis',
            type: 'In-person meeting', mode: 'in-person',
            start: daysFromNow(-1460, 15, 0), minutes: 90,
            location: 'Marina Bay Financial Centre', status: 'completed',
            agenda: ['Fact find', 'First protection plan'],
            preparedBy: 'Kristin Henessy',
            notes: 'Started with PRUShield Premier and a $400K term plan.'
        }
    ];


    /* ======================================================================
       ACTIVITY FEED + NOTIFICATIONS
       ====================================================================== */
    var activity = [
        { id: 'act-1', icon: 'sparkles', customerId: 'cus-001', time: daysFromNow(0, 8, 12), title: 'AI flagged a protection gap for Sarah Tan', text: 'Critical illness cover is $100,000 against a suggested $400,000 after her income increase.' },
        { id: 'act-2', icon: 'fileText', customerId: 'cus-002', time: daysFromNow(-1, 17, 40), title: 'Comparison shared with Daniel Wong', text: 'PRUEducation Builder against a single-premium top-up, sent for review.' },
        { id: 'act-3', icon: 'checkCircle', customerId: 'cus-003', time: daysFromNow(-2, 21, 5), title: 'Priya Raman completed her fact find', text: 'Risk profile recorded as Growth. Ready for a first recommendation.' },
        { id: 'act-4', icon: 'alertTriangle', customerId: 'cus-004', time: daysFromNow(-3, 9, 15), title: 'Renewal due for Grace Chua', text: 'PRUShield Premier renews in 18 days at a higher age band.' },
        { id: 'act-5', icon: 'video', customerId: 'cus-006', time: daysFromNow(-4, 16, 30), title: 'AI-assisted call completed with Nadia Iskandar', text: 'Notes and follow-up actions saved to her profile.' },
        { id: 'act-6', icon: 'trendingUp', customerId: 'cus-005', time: daysFromNow(-5, 11, 50), title: 'Income protection reviewed for Aaron Sim', text: 'Options compared at a 90-day waiting period.' }
    ];

    var notifications = {
        fr: [
            { id: 'n-fr-1', icon: 'sparkles', tone: 'brand', time: daysFromNow(0, 8, 10), title: 'New AI insight ready', text: 'Sarah Tan\u2019s needs analysis was refreshed after her income update.', link: '#/fr/pruwise' },
            { id: 'n-fr-2', icon: 'calendar', tone: '', time: daysFromNow(0, 9, 0), title: 'Call starting soon', text: 'Protection review with Sarah Tan at 2:00 PM today.', link: '#/fr/call' },
            { id: 'n-fr-3', icon: 'alertTriangle', tone: 'warn', time: daysFromNow(-1, 9, 20), title: 'Renewal approaching', text: 'Grace Chua\u2019s hospital plan renews in 18 days.', link: '#/fr/customer/cus-004' },
            { id: 'n-fr-4', icon: 'checkCircle', tone: 'ok', time: daysFromNow(-2, 21, 6), title: 'Fact find completed', text: 'Priya Raman submitted her updated financial details.', link: '#/fr/customer/cus-003' }
        ],
        customer: [
            { id: 'n-cus-1', icon: 'sparkles', tone: 'brand', time: daysFromNow(0, 9, 30), title: 'A recommendation is ready for you', text: 'Kristin prepared a protection plan with an explanation you can read at your own pace.', link: '#/me/pruwise' },
            { id: 'n-cus-2', icon: 'calendar', tone: '', time: daysFromNow(0, 8, 0), title: 'Appointment today at 2:00 PM', text: 'Video call with Kristin Henessy about your protection review.', link: '#/me/appointments' },
            { id: 'n-cus-3', icon: 'shield', tone: 'ok', time: daysFromNow(-9, 10, 0), title: 'Your hospital plan renewed', text: 'PRUShield Premier is active for another year. No action needed.', link: '#/me/plans' }
        ]
    };


    /* ======================================================================
       GLOSSARY - insurance jargon explained in plain language
       ====================================================================== */
    var glossary = [
        { term: 'Sum assured', short: 'The amount the insurer pays out when a claim is approved.', plain: 'This is the headline number on your policy. If you have a $400,000 sum assured, that is what gets paid to your family if you pass away while the policy is active. It is not the amount you pay in.', example: 'A $400,000 sum assured pays $400,000 to the people you nominated.' },
        { term: 'Premium', short: 'What you pay to keep the policy running.', plain: 'Your premium is the regular payment that keeps your cover active. It can be monthly, quarterly or yearly. If premiums stop, cover usually stops too, though most plans give you a short grace period.', example: '$168 a month keeps a $400,000 term plan active.' },
        { term: 'Critical illness cover', short: 'A lump sum paid when you are diagnosed with a listed serious illness.', plain: 'This pays out while you are still alive, on diagnosis of a condition on the policy list, commonly cancer, heart attack or stroke. The money is yours to use for treatment, bills, or simply to replace income while you recover. It is separate from a hospital plan, which pays the hospital.', example: 'A $400,000 critical illness benefit is often set at 3 to 5 years of income.' },
        { term: 'Accelerated benefit', short: 'A critical illness payout that reduces your death benefit by the same amount.', plain: 'If your plan pays critical illness on an accelerated basis, the claim comes out of the same pot as the death benefit. Claim $100,000 for critical illness on a $400,000 plan and $300,000 remains as life cover.', example: '$400,000 life cover minus a $100,000 CI claim leaves $300,000.' },
        { term: 'Rider', short: 'An optional add-on that extends what your policy covers.', plain: 'Riders attach to a main policy for an extra premium. Common ones waive your premiums if you fall seriously ill, add early-stage illness cover, or reduce the amount you pay out of pocket on a medical claim.', example: 'A waiver-of-premium rider keeps a policy running without payments after an approved claim.' },
        { term: 'Term plan', short: 'Cover for a fixed number of years, with no cash value.', plain: 'Term insurance covers you for a defined period, such as to age 60 or for 25 years. It buys the most cover per dollar, but if you outlive the term nothing is returned. It suits temporary needs like a mortgage or raising children.', example: 'Term to age 60 protects the years when your family depends on your income.' },
        { term: 'Whole life plan', short: 'Lifelong cover that also builds a cash value.', plain: 'A whole life policy covers you for life and builds up a value you could cash in later. Premiums are higher than term for the same cover, because part of what you pay is being saved rather than spent on protection.', example: 'Often used for legacy planning or as a permanent cover floor.' },
        { term: 'As charged', short: 'The plan pays the actual eligible bill, up to a limit.', plain: 'Instead of a fixed daily payout, an as-charged hospital plan pays the eligible bill itself, subject to the yearly limit and your ward entitlement. Treatment above your entitlement, such as a private ward on a public-ward plan, leaves you paying the difference.', example: 'A private-ward as-charged plan with a $2,000,000 yearly limit.' },
        { term: 'Co-payment', short: 'The share of a medical bill you pay yourself.', plain: 'Most integrated hospital plans ask you to pay a percentage of the bill so that costs stay in check. A rider can cut that share, often to 5%, with a yearly cap on how much you can be asked to pay.', example: 'A 5% co-payment capped at $3,000 a year.' },
        { term: 'Deductible', short: 'The first slice of a claim you pay before cover starts.', plain: 'The deductible is a yearly amount you settle yourself before the insurer pays anything. For integrated Shield plans it is usually covered by MediSave.', example: 'A $3,500 deductible on a public-ward plan.' },
        { term: 'Total and permanent disability', short: 'A payout if you can never work again.', plain: 'TPD cover pays a lump sum if illness or injury permanently stops you working. Definitions vary, and some plans use "any occupation", which is stricter than "own occupation", so the wording matters more than the number.', example: 'A $300,000 TPD benefit alongside life cover.' },
        { term: 'Income replacement', short: 'A monthly payment while you are unable to work.', plain: 'Rather than one lump sum, this pays a monthly benefit, typically up to 75% of your income, while you cannot work. It matters most for the self-employed and for sole earners.', example: '$5,500 a month until recovery or age 65.' },
        { term: 'Participating fund', short: 'The pooled fund that pays non-guaranteed bonuses.', plain: 'Whole life and endowment plans invest premiums in a participating fund. Part of your return is guaranteed and part is declared each year as a bonus, which can move up or down with fund performance.', example: 'Illustrated at 3.00% and 4.25% projected returns.' },
        { term: 'Surrender value', short: 'What you receive if you end the policy early.', plain: 'The surrender value is the cash you get back if you cancel. In the early years it is usually less than the premiums you have paid, because the upfront costs are recovered first.', example: 'Cancelling an endowment in year 2 typically returns less than you paid in.' },
        { term: 'Underwriting', short: 'The health and lifestyle assessment before cover starts.', plain: 'Underwriting is how the insurer decides your terms. Full disclosure matters: an undeclared condition can void a claim later. Being younger and healthier usually means better terms, which is why locking in cover earlier tends to cost less.', example: 'Cover may be offered at standard rates, at a higher rate, or with an exclusion.' },
        { term: 'Beneficiary nomination', short: 'Who receives the payout, recorded formally.', plain: 'A nomination tells the insurer who should receive your payout. Without one, the money goes into your estate and can take much longer to reach your family.', example: 'A revocable nomination can be changed at any time.' },
        { term: 'Waiting period', short: 'The time before a benefit can be claimed.', plain: 'Many benefits do not start on day one. Critical illness plans commonly have a 90-day waiting period, and income protection has a waiting period before monthly payments begin.', example: '90 days from the policy start date.' },
        { term: 'Protection gap', short: 'The difference between the cover you have and the cover you need.', plain: 'Your protection gap is what your family would be short of if something happened today. It is worked out from income, dependants, debts and existing savings, then compared with your current cover.', example: 'A suggested $1,150,000 against $400,000 held is a $750,000 gap.' }
    ];


    /* ======================================================================
       ANALYTICS (numbers for the charts on the Analytics page)
       ====================================================================== */
    var monthLabels = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

    var analytics = {
        kpis: [
            { label: 'Active clients', value: 48, delta: 6.7, deltaLabel: 'vs last quarter', icon: 'users', spark: [38, 39, 41, 42, 44, 45, 48] },
            { label: 'Reviews completed', value: 27, delta: 22.7, deltaLabel: 'vs last quarter', icon: 'clipboard', spark: [14, 16, 19, 18, 22, 25, 27] },
            { label: 'Recommendations accepted', value: 68, suffix: '%', delta: 9.4, deltaLabel: 'since AI assist', icon: 'thumbsUp', spark: [52, 55, 58, 59, 63, 66, 68] },
            { label: 'Average gap closed', value: 41, suffix: '%', delta: 4.1, deltaLabel: 'per closed review', icon: 'target', spark: [30, 32, 33, 36, 38, 40, 41] }
        ],

        customerTrend: {
            labels: monthLabels,
            series: [
                { name: 'Active clients', color: 'var(--c1)', values: [38, 39, 41, 42, 44, 45, 48] },
                { name: 'Reviews completed', color: 'var(--c2)', values: [14, 16, 19, 18, 22, 25, 27] }
            ]
        },

        recommendationStats: {
            labels: monthLabels,
            series: [
                { name: 'Presented', color: 'var(--c1)', values: [9, 11, 12, 14, 16, 18, 19] },
                { name: 'Accepted', color: 'var(--c3)', values: [4, 6, 7, 8, 10, 12, 13] }
            ]
        },

        appointmentsByDay: {
            labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
            series: [{ name: 'Appointments', color: 'var(--c1)', values: [6, 9, 11, 8, 13, 4] }]
        },

        appointmentMix: [
            { label: 'AI-assisted video', value: 34, color: 'var(--c1)' },
            { label: 'In-person', value: 21, color: 'var(--c2)' },
            { label: 'Phone', value: 12, color: 'var(--c3)' },
            { label: 'Messages', value: 9, color: 'var(--c4)' }
        ],

        gapBreakdown: [
            { label: 'Critical illness', value: 62, color: 'var(--c1)' },
            { label: 'Income protection', value: 48, color: 'var(--c2)' },
            { label: 'Life cover', value: 35, color: 'var(--c3)' },
            { label: 'Retirement income', value: 29, color: 'var(--c4)' },
            { label: 'Hospitalisation', value: 12, color: 'var(--c5)' }
        ],

        segments: [
            { label: 'Growing families', value: 18, color: 'var(--c1)' },
            { label: 'Young professionals', value: 12, color: 'var(--c2)' },
            { label: 'Pre-retirees', value: 9, color: 'var(--c3)' },
            { label: 'Established families', value: 9, color: 'var(--c4)' }
        ],

        insights: [
            { icon: 'sparkles', title: 'Critical illness is your biggest book-wide gap', text: '62% of your clients hold less than half the suggested critical illness cover. Sarah Tan, Priya Raman and Nadia Iskandar are the three largest gaps.' },
            { icon: 'trendingUp', title: 'AI-prepared meetings convert better', text: 'Reviews opened with an AI needs summary were accepted 68% of the time, against 52% for meetings without one.' },
            { icon: 'clock', title: 'Friday afternoons are your strongest slot', text: 'Friday holds 13 of your last 51 appointments and has the lowest reschedule rate. Two slots are still open next week.' },
            { icon: 'alertTriangle', title: 'Four renewals land within 30 days', text: 'Grace Chua, Nadia Iskandar and two others renew soon. Age-band increases apply to three of them.' }
        ],

        recommendationLog: [
            { customer: 'Sarah Tan', customerId: 'cus-001', product: 'PRUActive Protect', fit: 92, presented: 'Today', status: 'Awaiting review' },
            { customer: 'Daniel Wong', customerId: 'cus-002', product: 'PRUEducation Builder', fit: 86, presented: '1 day ago', status: 'In discussion' },
            { customer: 'Priya Raman', customerId: 'cus-003', product: 'PRUCritical First', fit: 88, presented: '3 days ago', status: 'Accepted' },
            { customer: 'Grace Chua', customerId: 'cus-004', product: 'PRURetire Income', fit: 90, presented: '5 days ago', status: 'In discussion' },
            { customer: 'Aaron Sim', customerId: 'cus-005', product: 'PRUIncome Guard', fit: 94, presented: '6 days ago', status: 'Accepted' },
            { customer: 'Nadia Iskandar', customerId: 'cus-006', product: 'PRUActive Protect', fit: 89, presented: '8 days ago', status: 'Declined, budget' }
        ]
    };


    /* ======================================================================
       LOOKUP FUNCTIONS
       Small helpers so pages never have to loop through arrays themselves.
       ====================================================================== */

    // Generic "find the item with this id" helper
    function byId(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) { return list[i]; }
        }
        return null;
    }

    function getCustomer(id) { return byId(customers, id); }
    function getRep(id) { return byId(reps, id) || reps[0]; }
    function getProduct(id) { return byId(products, id); }

    // All policies belonging to one customer
    function policiesFor(customerId) {
        return policies.filter(function (p) { return p.customerId === customerId; });
    }

    // Total yearly premium across all of a customer's policies.
    // Monthly premiums are multiplied by 12 so everything is comparable.
    function annualPremium(customerId) {
        return policiesFor(customerId).reduce(function (total, p) {
            return total + p.premium.amount * (p.premium.per === 'monthly' ? 12 : 1);
        }, 0);
    }

    function monthlyPremium(customerId) {
        return Math.round(annualPremium(customerId) / 12);
    }

    // Only the coverage lines that have numbers (skips the hospital plan,
    // which is described in words rather than a dollar amount).
    function numericCoverage(customer) {
        if (!customer) { return []; }
        var out = [];
        for (var key in customer.coverage) {
            var line = customer.coverage[key];
            if (line && typeof line.current === 'number') {
                out.push({
                    key: key,
                    label: line.label,
                    current: line.current,
                    recommended: line.recommended,
                    monthly: !!line.monthly,
                    gap: Math.max(0, line.recommended - line.current)
                });
            }
        }
        return out;
    }

    // Total shortfall in dollars across every protection line
    function coverageGap(customer) {
        return numericCoverage(customer).reduce(function (total, line) {
            return total + line.gap;
        }, 0);
    }

    // What percentage of the recommended cover is actually in place (0-100)
    function coverageRatio(customer) {
        var lines = numericCoverage(customer);
        var have = 0;
        var need = 0;
        lines.forEach(function (line) {
            have += line.current;
            need += line.recommended;
        });
        if (need === 0) { return 100; }
        return Math.round((have / need) * 100);
    }

    /* Builds the full recommendation objects for a customer.
       The raw entries in recBook are kept short; this function fills in the
       product details, the ids, and the "relevant client needs" block. */
    function recsFor(customerId) {
        var customer = getCustomer(customerId);
        var raw = recBook[customerId] || [];
        if (!customer) { return []; }

        return raw.map(function (entry, index) {
            var product = getProduct(entry.productId);

            // Work out a readable cover label
            var coverLabel;
            if (!entry.cover) {
                coverLabel = entry.singlePremium ? FMT.money(entry.singlePremium) + ' single premium' : '-';
            } else if (product && product.category === 'Disability Income') {
                coverLabel = FMT.money(entry.cover) + ' / month';
            } else {
                coverLabel = FMT.money(entry.cover);
            }

            // And a readable premium label
            var premiumLabel = (entry.singlePremium && !entry.premium)
                ? FMT.money(entry.singlePremium) + ' once'
                : FMT.money(entry.premium) + '/mo';

            return {
                id: 'rec-' + customerId + '-' + entry.productId,
                customerId: customerId,
                customer: customer,
                product: product,
                productId: entry.productId,
                isTop: index === 0,
                fit: entry.fit,
                headline: entry.headline,
                recommendation: entry.recommendation,
                whyFits: entry.whyFits,
                cover: entry.cover,
                coverLabel: coverLabel,
                premium: entry.premium,
                singlePremium: entry.singlePremium || null,
                premiumLabel: premiumLabel,
                term: entry.term,
                reasons: entry.reasons,
                needs: needsFor(customer),
                considerations: entry.considerations,
                nextAction: entry.nextAction,
                benefits: entry.benefits
            };
        });
    }

    function topRec(customerId) {
        return recsFor(customerId)[0] || null;
    }

    /* ----------------------------------------------------------------------
       HOW ONE RECOMMENDATION COMPARES WITH THE OTHERS ON THE SAME SHORTLIST

       Answers "why this one and not the others" with arithmetic instead of
       assertion. Every line this returns is derived from figures already on the
       screen, so nothing here can be wrong in a way the reader cannot check.

       Returns:
         lines      sentences comparing this option with the rest
         onlyHere   product features none of the alternatives have
         others     the names of the options it was compared against

       Deliberately returns EMPTY LISTS rather than a cheerful sentence when
       there is only one option on the shortlist. "This is the best of the one
       thing we looked at" is not a comparison, and the card leaves the block out
       entirely rather than printing something hollow.
       ---------------------------------------------------------------------- */
    function recCompare(rec) {
        var empty = { lines: [], onlyHere: [], others: [] };

        if (!rec || !rec.customerId) { return empty; }

        var all = recsFor(rec.customerId);
        var others = all.filter(function (r) { return r.id !== rec.id; });

        if (!others.length) { return empty; }

        var lines = [];

        /* ---- match score ---- */
        var beaten = others.filter(function (r) { return rec.fit > r.fit; }).length;

        if (beaten === others.length) {
            lines.push('Closest match on the shortlist at ' + rec.fit + '%, against ' +
                others.map(function (r) { return r.fit + '%'; }).join(' and ') + '.');
        } else if (beaten === 0) {
            lines.push('Matches the record less closely than the other options at ' +
                rec.fit + '%, so it is here as a secondary consideration rather ' +
                'than the lead suggestion.');
        } else {
            lines.push('Matches at ' + rec.fit + '%, in the middle of the shortlist.');
        }

        /* ---- monthly cost ----

           Single-premium plans are excluded from this comparison rather than
           converted to a monthly figure. Turning a one-off $300,000 into "about
           $x a month" would need an assumed term and an assumed rate, and both
           would be invented. */
        var monthly = function (r) { return Number(r.premium) || 0; };

        if (monthly(rec) > 0) {
            var cheaperThan = others.filter(function (r) {
                return monthly(r) > 0 && monthly(r) > monthly(rec);
            });
            var dearerThan = others.filter(function (r) {
                return monthly(r) > 0 && monthly(r) < monthly(rec);
            });

            if (cheaperThan.length && !dearerThan.length) {
                var saving = Math.min.apply(null, cheaperThan.map(monthly)) - monthly(rec);
                lines.push('The cheapest monthly option here, ' + FMT.money(saving) +
                    ' a month less than the next one.');

            } else if (dearerThan.length && !cheaperThan.length) {
                var extra = monthly(rec) - Math.max.apply(null, dearerThan.map(monthly));
                lines.push('The most expensive of these, ' + FMT.money(extra) +
                    ' a month more than the next. The trade-offs below are what ' +
                    'that buys.');
            }
        }

        /* ---- how much cover, within the same category only ----

           Comparing a monthly income benefit against a lump sum death benefit
           would be meaningless, so this only compares like with like. */
        var sameKind = others.filter(function (r) {
            return r.product && rec.product && r.product.category === rec.product.category;
        });

        var biggerThan = sameKind.filter(function (r) {
            return Number(rec.cover) > Number(r.cover);
        });

        if (biggerThan.length) {
            lines.push('More cover than the other ' +
                String(rec.product.category).toLowerCase() +
                ' option on the list.');
        }

        /* ---- a different job from the rest ---- */
        if (rec.product && !sameKind.length) {
            lines.push('The only ' + String(rec.product.category).toLowerCase() +
                ' plan here - it covers a different risk from the others rather ' +
                'than being a cheaper or dearer version of them.');
        }

        /* ---- features nothing else on the list offers ---- */
        var theirs = {};

        others.forEach(function (r) {
            ((r.product && r.product.features) || []).forEach(function (f) {
                theirs[f] = true;
            });
        });

        var onlyHere = ((rec.product && rec.product.features) || [])
            .filter(function (f) { return !theirs[f]; });

        return {
            lines: lines,
            onlyHere: onlyHere,
            others: others.map(function (r) {
                return r.product ? r.product.name : 'another option';
            })
        };
    }

    function recById(recId) {
        // Recommendation ids look like "rec-cus-001-prd-active",
        // so we pull the customer id back out of the middle.
        var match = /^rec-(cus-\d+)-/.exec(recId || '');
        if (!match) { return null; }
        var list = recsFor(match[1]);
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === recId) { return list[i]; }
        }
        return null;
    }

    /* ======================================================================
       WHERE A BETTER PLAN COULD BE RECOMMENDED

       The one judgement behind every exclamation marker in the app. Both the
       client's own plans screen and the representative's view of that client call
       this, so the two can never disagree about whether there is a problem - the
       bug this round has already produced three times in other shapes.

       IT INVENTS NOTHING. Every finding comes from a line the SERVER already
       calculated in financesNeeds() and already wrote an explanation for. This
       function chooses which of them are worth a marker and which plan answers
       them; it does not decide the arithmetic. That matters because a warning a
       customer cannot check is just an alarm.

       -----------------------------------------------------------------------
       WHY IT CAN REFUSE TO SUGGEST ANYTHING
       -----------------------------------------------------------------------
       If their own figures say there is no money left at the end of the month,
       the honest finding is "your cover is short AND you have no room for another
       premium", not "here is something else to buy". A marker that recommends a
       purchase to somebody who cannot afford one is a sales prod wearing a
       warning triangle, and the first time a client notices that is the last time
       they trust any marker in the product.

       So `blocked` is set, the wording changes to talk about restructuring what
       they already pay for, and no product is named.

       Returns { count, tone, blocked, findings[] } where each finding is
         { key, title, detail, figure, productId, productName }
       and productId is null whenever naming one would be wrong.
       ====================================================================== */

    /* Which plan answers which shortfall. Deliberately explicit rather than
       inferred: a wrong product against a real gap is worse than no product. */
    var GAP_PRODUCT = {
        life:   'prd-active',
        ci:     'prd-ci',
        tpd:    'prd-active',
        income: 'prd-income'
    };

    function planWarnings(needs) {
        var empty = { count: 0, tone: 'ok', blocked: false, findings: [] };

        if (!needs || !needs.lines) { return empty; }

        var afford = needs.affordability || null;
        var blocked = !!(afford && afford.noHeadroom);
        var findings = [];

        /* ---- the quantified cover shortfalls ---- */
        needs.lines.forEach(function (l) {
            if (!l || !l.gap || l.gap <= 0) { return; }

            var product = blocked ? null : (GAP_PRODUCT[l.key] || null);
            var meta = product ? getProduct(product) : null;

            findings.push({
                key: l.key,
                title: l.label + ' is short by ' +
                    (l.monthly ? FMT.money(l.gap) + ' a month' : FMT.money(l.gap)),

                /* The server's own sentence about how the figure was reached, so
                   the hover explains the arithmetic rather than asserting it. */
                detail: l.why,

                figure: (l.monthly ? FMT.money(l.current) + ' a month' : FMT.money(l.current)) +
                    ' in place against ' +
                    (l.monthly ? FMT.money(l.recommended) + ' a month' : FMT.money(l.recommended)),

                productId: product,
                productName: meta ? meta.name : null
            });
        });

        /* ---- the emergency fund, which is a SAVINGS problem ----

           Listed separately because it is not an insurance gap at all, and until
           this round the catalogue had no sensible answer to it. It does now. */
        var e = needs.emergency;

        if (e && e.shortfall > 0) {
            var saver = blocked ? null : getProduct('prd-save');

            findings.push({
                key: 'emergency',
                title: 'Emergency fund short by ' + FMT.money(e.shortfall),
                detail: 'Six months of expenses is the usual target, and it is what ' +
                    'stops a short illness turning into a cancelled policy. This is ' +
                    'money to save rather than cover to buy.',
                figure: FMT.money(e.have) + ' saved, about ' +
                    e.monthsHeld + ' months of expenses',
                productId: saver ? 'prd-save' : null,
                productName: saver ? saver.name : null
            });
        }

        /* ---- the reason nothing is being suggested ---- */
        if (blocked && findings.length) {
            findings.push({
                key: 'affordability',
                title: 'No room for another premium, on your own figures',
                detail: 'Income less expenses and commitments leaves nothing spare, so ' +
                    'the useful conversation is about restructuring the cover already ' +
                    'paid for rather than adding to it.',
                figure: null,
                productId: null,
                productName: null
            });
        }

        /* Over-committed is worth saying even when there IS headroom: the stated
           budget being above what is actually spare is how a policy gets bought
           and then cancelled. */
        if (!blocked && afford && afford.overCommitted) {
            findings.push({
                key: 'budget',
                title: 'Stated budget is above what is actually spare',
                detail: 'The budget on the record is higher than income less expenses ' +
                    'and commitments. Worth agreeing a figure that survives a bad ' +
                    'month before anything is signed.',
                figure: FMT.money(afford.statedBudget) + ' stated against ' +
                    FMT.money(afford.spare) + ' spare',
                productId: null,
                productName: null
            });
        }

        return {
            count: findings.length,
            /* Two or more real shortfalls, or no headroom at all, is a stronger
               signal than a single line being a little under. */
            tone: findings.length === 0 ? 'ok' : (blocked || findings.length >= 2 ? 'bad' : 'warn'),
            blocked: blocked,
            findings: findings
        };
    }

    /* Block 3 of every recommendation: "relevant client needs".
       Built from the customer record so it always matches what is on screen. */
    function needsFor(customer) {
        var m = customer.money;
        var needs = [];

        if (customer.dependants > 0) {
            needs.push({
                title: customer.dependants + (customer.dependants > 1 ? ' dependants' : ' dependant'),
                text: customer.dependantDetail
            });
        }
        if (m.mortgage > 0) {
            needs.push({
                title: FMT.moneyShort(m.mortgage) + ' mortgage outstanding',
                text: 'A debt that would pass to the household if income stopped.'
            });
        }
        needs.push({
            title: FMT.money(m.monthlyIncome) + ' monthly income to protect',
            text: 'Stated premium budget of ' + FMT.money(m.premiumBudget) + ' a month.'
        });
        if (customer.goals.length) {
            needs.push({
                title: customer.goals[0].label,
                text: 'Priority: ' + customer.goals[0].priority + ' | Horizon: ' + customer.goals[0].horizon
            });
        }
        if (m.emergencyMonths < 6) {
            needs.push({
                title: m.emergencyMonths + '-month emergency fund',
                text: 'Below the usual 6-month guideline, which affects how long a waiting period can safely be.'
            });
        }
        return needs.slice(0, 4);
    }

    /* ---- Appointments --------------------------------------------------- */

    function apptsFor(customerId) {
        return appointments
            .filter(function (a) { return a.customerId === customerId; })
            .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    }

    // "Upcoming" = not completed, and not more than an hour in the past
    function isUpcoming(a) {
        return a.status !== 'completed' && new Date(a.start).getTime() > Date.now() - 3600000;
    }

    function nextApptFor(customerId) {
        return apptsFor(customerId).filter(isUpcoming)[0] || null;
    }

    function pastApptsFor(customerId) {
        return apptsFor(customerId)
            .filter(function (a) { return a.status === 'completed'; })
            .reverse();
    }

    function upcomingForRep(repId) {
        return appointments
            .filter(function (a) { return a.repId === repId && isUpcoming(a); })
            .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    }

    function customersForRep(repId) {
        return customers.filter(function (c) { return c.repId === repId; });
    }

    function findTerm(name) {
        var wanted = String(name || '').toLowerCase();
        for (var i = 0; i < glossary.length; i++) {
            if (glossary[i].term.toLowerCase() === wanted) { return glossary[i]; }
        }
        return null;
    }


    /* ======================================================================
       Everything listed here becomes available as DATA.something
       ====================================================================== */
    return {
        reps: reps,
        customers: customers,
        policies: policies,
        products: products,
        appointments: appointments,
        activity: activity,
        notifications: notifications,
        glossary: glossary,
        analytics: analytics,

        getCustomer: getCustomer,
        getRep: getRep,
        getProduct: getProduct,
        customersForRep: customersForRep,

        policiesFor: policiesFor,
        annualPremium: annualPremium,
        monthlyPremium: monthlyPremium,

        numericCoverage: numericCoverage,
        coverageGap: coverageGap,
        coverageRatio: coverageRatio,

        recsFor: recsFor,
        topRec: topRec,
        recCompare: recCompare,
        planWarnings: planWarnings,
        recById: recById,

        apptsFor: apptsFor,
        nextApptFor: nextApptFor,
        pastApptsFor: pastApptsFor,
        upcomingForRep: upcomingForRep,

        findTerm: findTerm,
        daysFromNow: daysFromNow
    };

})();
