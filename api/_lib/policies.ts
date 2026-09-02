/* =============================================================================
   policies.ts - applications, and the policies they turn into
   -----------------------------------------------------------------------------
   Ported from php/lib/policies.php.

   =============================================================================
   THE ONE RULE THAT SHAPES THIS FILE
   =============================================================================

   A row in `policies` means cover that really exists. Nothing writes one except
   issuePolicy(), and that runs as a single statement which also resolves the
   application it came from. There is no path that produces a policy nobody
   applied for, and no path that issues the same application twice.

   Everything else here is bookkeeping around that.

   =============================================================================
   WHY A REPRESENTATIVE ISSUES, AND NOT THE APP
   =============================================================================

   The customer applies; a licensed human decides. That ordering is not a
   limitation of the prototype, it is the honest model - cover is underwritten by
   somebody accountable for the decision, and an app that granted insurance on a
   button press would be misrepresenting how any of this works.

   =============================================================================
   PRODUCT IDS ARE VALIDATED HERE, BECAUSE SQL CANNOT
   =============================================================================

   policies.product_id and policy_applications.product_id have no foreign key,
   because the catalogue is not a table - it is js/data.js, mirrored by PRODUCTS in
   _lib/assessment.ts so the server can name a product without inventing one.

   So every entry point runs the id past policyProduct() first. A column with no
   constraint behind it is a column the code has to police.
   ============================================================================= */

import { all, column, one, q, toDateOnly, toIso, type Row } from './db.js';
import { PRODUCTS } from './assessment.js';

/* How long before the renewal date a policy starts saying "renewal due".

   Six weeks. Long enough that a representative has time to arrange a
   conversation, short enough that it still reads as news rather than background
   noise. */
const RENEWAL_WINDOW_DAYS = 45;


/* =============================================================================
   1. THE CATALOGUE, PLUS THE BITS THE SERVER DID NOT USED TO NEED

   PRODUCTS carries the id, name and category, because that is all scoring ever
   needed. Issuing a policy needs two more things: an icon, and the benefit lines
   to snapshot onto the row.

   These duplicate js/data.js, which is the same trade-off PRODUCTS already made
   deliberately: the server must be able to describe a product without trusting
   the browser to tell it what the product is. Benefit text arriving in a POST
   body would be benefit text an attacker chose.
   ============================================================================= */

const EXTRAS: Record<string, { icon: string; benefits: string[] }> = {
    'prd-save': {
        icon: 'lock',
        benefits: [
            'The maturity value is guaranteed in writing before you sign',
            'Choose a 3, 5 or 10 year term to match what you are saving for',
            'Your capital is never exposed to a market'
        ]
    },
    'prd-flexi': {
        icon: 'dollarSign',
        benefits: [
            'Starts from $100 a month and can be increased at any anniversary',
            'A yearly cash benefit you can withdraw or leave to accumulate',
            'Premiums can be paused for up to 12 months without lapsing'
        ]
    },
    'prd-legacy': {
        icon: 'award',
        benefits: [
            'Cash value builds every year you hold it',
            'Shares in the participating fund bonuses',
            'Premiums finish at 65 but the plan continues for life'
        ]
    },
    'prd-active': {
        icon: 'shieldCheck',
        benefits: [
            'Adjust the cover amount each year without a new health check',
            'Critical illness benefit covering 37 conditions',
            'Premiums waived if a critical illness claim is approved'
        ]
    },
    'prd-ci': {
        icon: 'heart',
        benefits: [
            'Pays at early, intermediate and severe stages',
            'Up to three separate claims for unrelated conditions',
            'Cover continues after an early-stage claim'
        ]
    },
    'prd-income': {
        icon: 'umbrella',
        benefits: [
            'Judged on your own occupation, not any occupation',
            'Paid monthly until you recover or the term ends',
            'Half the benefit paid for partial disability'
        ]
    },
    'prd-growth': {
        icon: 'trendingUp',
        benefits: [
            'Choice of more than 40 funds across risk levels',
            'Four free fund switches a year',
            'Top-ups allowed from year 2'
        ]
    },
    'prd-retire': {
        icon: 'compass',
        benefits: [
            'Guaranteed monthly income for 20 years, or for life',
            'Optional income that rises with inflation',
            'Death benefit protects the remaining income stream'
        ]
    },
    'prd-edu': {
        icon: 'bookOpen',
        benefits: [
            'The guaranteed maturity value is known upfront',
            'Premiums are waived if the paying parent dies or is disabled',
            'Partial withdrawal from year 6'
        ]
    },
    'prd-shield': {
        icon: 'shield',
        benefits: [
            'Private hospital and A-ward treatment, as charged',
            'Your share of the bill drops to 5%, capped at $3,000 a year',
            'Pre- and post-hospitalisation cover for 180 days'
        ]
    }
};

export interface PolicyProduct {
    productId: string;
    name: string;
    category: string;
    icon: string;
    benefits: string[];
}

/* One product, merged. Returns null for anything not in the catalogue, which is
   what every caller checks before doing anything else. */
export function policyProduct(productId: unknown): PolicyProduct | null {
    const id = String(productId);
    const base = PRODUCTS[id];

    if (!base) { return null; }

    const extra = EXTRAS[id] ?? { icon: 'shield', benefits: [] };

    return {
        productId: id,
        name: base.name,
        category: base.category,
        icon: extra.icon,
        benefits: extra.benefits
    };
}

/* A policy number in the same style as the fixtures: two letters from the
   product, then two groups of digits.

   Loops until it finds one nothing is using. The unique constraint on the column
   is the real guarantee; this just avoids walking into it. */
export async function policyReference(productId: string): Promise<string> {
    const prefixes: Record<string, string> = {
        'prd-active': 'PA', 'prd-ci': 'PC', 'prd-income': 'PI',
        'prd-growth': 'PW', 'prd-retire': 'PR', 'prd-edu': 'PE',
        'prd-shield': 'PS',

        /* The savings range. PG collides with the PG-2280-1109 number on one of
           the js/data.js fixtures, which is harmless - the fixtures are not rows
           in this table, and the loop below checks the real column for a clash
           either way. */
        'prd-save': 'PG', 'prd-flexi': 'PF', 'prd-legacy': 'PB'
    };

    const prefix = prefixes[productId] ?? 'PL';
    const digits = () => String(Math.floor(1000 + Math.random() * 9000));

    for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = `${prefix}-${digits()}-${digits()}`;

        const taken = await column('SELECT 1 FROM policies WHERE policy_number = ?', [candidate]);
        if (!taken) { return candidate; }
    }

    /* Practically unreachable. Falling back to something certainly unique beats
       returning a duplicate, and beats failing the issue outright. */
    return `${prefix}-${String(Date.now()).slice(-8)}`;
}


/* =============================================================================
   2. APPLYING

   openApplicationFor() is the "one at a time, per product" rule. Applying twice
   for the same plan is almost always a double-click or an impatient refresh, and
   two identical rows in a representative's queue is confusing for both sides.

   Deliberately scoped to the PRODUCT rather than the customer: somebody may
   reasonably have an application open for term life and another for
   hospitalisation at the same time. And it only counts the undecided statuses, so
   a declined application can be resubmitted after a conversation - which is the
   normal way a decline gets resolved.
   ============================================================================= */

export async function openApplicationFor(
    customerPersonId: string,
    productId: string
): Promise<Row | null> {
    return one(
        `SELECT * FROM policy_applications
          WHERE customer_person_id = ?
            AND product_id = ?
            AND status IN ('submitted','under_review')
          ORDER BY id DESC
          LIMIT 1`,
        [customerPersonId, productId]
    );
}

/* =============================================================================
   ALREADY HOLDING IT IS ALSO A DUPLICATE.

   openApplicationFor() above only looks at UNDECIDED applications, so nothing
   stopped a customer applying for a plan they already hold. That is not a
   theoretical hole: the demo customer accumulated SIXTEEN identical PRUActive
   Protect policies, one per run of scripts/smoke.mjs, each with the same cover
   and the same $225 premium and a different policy number. Her own "My plans"
   screen added them up and told her she was paying $3,600 a month.

   So the rule is now the obvious one: one ACTIVE policy per product per person.

   WHY REFUSE RATHER THAN WARN. Somebody can genuinely want a second life policy
   - more cover, a different term - but the way to get that is a conversation with
   their representative, who can raise the cover on the policy that exists or
   write a new one deliberately. A self-service button that silently creates a
   second identical plan produces a duplicate far more often than it produces what
   anybody wanted, and the customer pays twice in the meantime.

   Scoped to ACTIVE. A lapsed or matured policy is not cover, so re-applying for
   that product is a reasonable thing to do and is allowed.
   ============================================================================= */
export async function activePolicyFor(
    customerPersonId: string,
    productId: string
): Promise<Row | null> {
    return one(
        `SELECT * FROM policies
          WHERE person_id = ?
            AND product_id = ?
            AND status = 'active'
          ORDER BY id DESC
          LIMIT 1`,
        [customerPersonId, productId]
    );
}

export interface ApplyInput {
    cover?: number | null;
    ciCover?: number | null;
    monthlyBenefit?: number | null;
    premium: number;
    termYears?: number | null;
    note?: string;
}

/* Creates the application and returns its id.

   RETURNING, so there is no second query and no window between insert and read -
   which the PHP needed because MySQL has no RETURNING. */
export async function applyForPolicy(
    customerPersonId: string,
    repPersonId: string,
    productId: string,
    input: ApplyInput
): Promise<number | null> {
    const row = await one<{ id: number }>(
        `INSERT INTO policy_applications
             (customer_person_id, rep_person_id, product_id,
              cover, ci_cover, monthly_benefit, premium, term_years, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
            customerPersonId, repPersonId, productId,
            input.cover ?? null,
            input.ciCover ?? null,
            input.monthlyBenefit ?? null,
            Math.round(input.premium),
            input.termYears ?? null,
            input.note && input.note !== '' ? input.note : null
        ]
    );

    return row ? Number(row.id) : null;
}


/* =============================================================================
   3. READING APPLICATIONS
   ============================================================================= */

export async function policyApplication(id: number): Promise<Row | null> {
    return one(
        `SELECT a.*, c.name AS customer_name, c.first_name AS customer_first_name,
                c.email AS customer_email, r.name AS rep_name
           FROM policy_applications a
           JOIN people c ON c.id = a.customer_person_id
           JOIN people r ON r.id = a.rep_person_id
          WHERE a.id = ?`,
        [id]
    );
}

export async function applicationsForCustomer(personId: string): Promise<Row[]> {
    return all(
        `SELECT a.*, r.name AS rep_name
           FROM policy_applications a
           JOIN people r ON r.id = a.rep_person_id
          WHERE a.customer_person_id = ?
          ORDER BY a.created_at DESC`,
        [personId]
    );
}

/* A representative's queue.

   Undecided first and oldest-first within that, because the thing most likely to
   need attention is the request that has been waiting longest. Everything already
   dealt with follows, newest first, as history. */
export async function applicationsForRep(repPersonId: string): Promise<Row[]> {
    return all(
        `SELECT a.*, c.name AS customer_name, c.first_name AS customer_first_name
           FROM policy_applications a
           JOIN people c ON c.id = a.customer_person_id
          WHERE a.rep_person_id = ?
          ORDER BY array_position(
                       ARRAY['submitted','under_review','issued','declined','withdrawn'],
                       a.status),
                   CASE WHEN a.status IN ('submitted','under_review')
                        THEN a.created_at END ASC,
                   a.created_at DESC`,
        [repPersonId]
    );
}


/* =============================================================================
   4. DECIDING

   All three transitions use the WHERE clause to do the locking: update the row
   only if it is still in a state that allows it, then check rowCount. Two
   representatives with the same dashboard open, or one with two tabs, is normal -
   and the second one has to lose cleanly rather than both proceeding.
   ============================================================================= */

/* "I am looking at this." Reversible, informational, and it is what stops two
   people working the same request. */
export async function takeUpApplication(id: number): Promise<boolean> {
    const done = await q(
        `UPDATE policy_applications SET status = 'under_review'
          WHERE id = ? AND status = 'submitted'`,
        [id]
    );
    return done.rowCount > 0;
}

export async function declineApplication(id: number, reason: string): Promise<boolean> {
    const done = await q(
        `UPDATE policy_applications
            SET status = 'declined', decline_reason = ?, resolved_at = now()
          WHERE id = ? AND status IN ('submitted','under_review')`,
        [reason, id]
    );
    return done.rowCount > 0;
}

export async function withdrawApplication(id: number): Promise<boolean> {
    const done = await q(
        `UPDATE policy_applications
            SET status = 'withdrawn', resolved_at = now()
          WHERE id = ? AND status IN ('submitted','under_review')`,
        [id]
    );
    return done.rowCount > 0;
}


/* Accept it, and create the cover.

   =============================================================================
   ONE STATEMENT, NOT A TRANSACTION
   =============================================================================

   The PHP opened a transaction: update the application, check rowCount, then
   insert the policy. Postgres expresses the whole thing as one statement with a
   data-modifying CTE, which is atomic by construction and cannot half-apply.

   If the UPDATE matches nothing - because somebody else got there first - the CTE
   yields no rows, the INSERT inserts nothing, and no policy comes back. That is
   exactly the signal the caller wanted, with no explicit locking and no rollback
   path to get wrong.

   $overrides lets the representative issue on different terms from those asked
   for, which is the common real outcome: the premium moves after underwriting.
   ============================================================================= */
export async function issuePolicy(
    application: Row,
    issuerPersonId: string,
    overrides: Partial<ApplyInput> = {}
): Promise<number | null> {
    const product = policyProduct(application.product_id);
    if (!product) { return null; }

    const pick = <T>(value: T | null | undefined, fallback: unknown): unknown =>
        value !== null && value !== undefined ? value : fallback;

    const cover = pick(overrides.cover, application.cover);
    const ciCover = pick(overrides.ciCover, application.ci_cover);
    const monthlyBenefit = pick(overrides.monthlyBenefit, application.monthly_benefit);
    const premium = Number(pick(overrides.premium, application.premium));
    const termYearsRaw = pick(overrides.termYears, application.term_years);
    const termYears = termYearsRaw === null || termYearsRaw === undefined
        ? null : Number(termYearsRaw);

    const number = await policyReference(String(application.product_id));

    /* Cover starts today. Renewal is a year out - every product in this catalogue
       is either annually renewable or has an annual premium review.

       MATURITY ONLY EXISTS WHERE THERE IS A TERM to mature at the end of. A
       hospitalisation plan has no maturity date and must not be given one, because
       the card would then display a date that means nothing. */
    const row = await one<{ id: number }>(
        `WITH resolved AS (
             UPDATE policy_applications
                SET status = 'issued', resolved_at = now()
              WHERE id = ? AND status IN ('submitted','under_review')
          RETURNING id, customer_person_id, product_id
         )
         INSERT INTO policies
             (person_id, application_id, product_id, policy_number,
              cover, ci_cover, monthly_benefit, premium, premium_per, term_years,
              payment_method, benefits, start_date, renewal_date, maturity_date,
              status, issued_by)
         SELECT resolved.customer_person_id, resolved.id, resolved.product_id, ?,
                ?, ?, ?, ?, 'monthly', ?,
                ?, ?::jsonb, CURRENT_DATE, CURRENT_DATE + INTERVAL '1 year',
                CASE WHEN ?::int IS NULL THEN NULL
                     ELSE CURRENT_DATE + (?::int * INTERVAL '1 year') END,
                'active', ?
           FROM resolved
        RETURNING id`,
        [
            Number(application.id),
            number,
            cover === null || cover === undefined ? null : Number(cover),
            ciCover === null || ciCover === undefined ? null : Number(ciCover),
            monthlyBenefit === null || monthlyBenefit === undefined ? null : Number(monthlyBenefit),
            premium,
            termYears,
            'To be arranged with your representative',
            JSON.stringify(product.benefits),
            termYears,
            termYears,
            issuerPersonId
        ]
    );

    return row ? Number(row.id) : null;
}


/* =============================================================================
   5. READING POLICIES
   ============================================================================= */

export async function policiesFor(personId: string | null): Promise<Row[]> {
    if (!personId) { return []; }

    return all(
        `SELECT * FROM policies
          WHERE person_id = ?
          ORDER BY array_position(ARRAY['active','lapsed','cancelled'], status),
                   renewal_date ASC`,
        [personId]
    );
}

export async function policyById(id: number): Promise<Row | null> {
    return one('SELECT * FROM policies WHERE id = ?', [id]);
}


/* =============================================================================
   6. THE SHAPE THE BROWSER GETS

   THIS MUST MATCH THE FIXTURES IN js/data.js, FIELD FOR FIELD.

   UI.policyCard() renders both, and it reads policy.benefits.slice(),
   policy.riders.length and policy.exclusions.length WITH NO GUARDS AT ALL. A row
   from here arriving without those three keys does not degrade - it throws, the
   router catches it, and the customer gets the "Page error" screen instead of
   their policy list. So they are always arrays, even when empty.
   ============================================================================= */

export function policyJson(row: Row | null): Record<string, unknown> | null {
    if (!row) { return null; }

    let product = policyProduct(row.product_id);

    /* Unknown product id - possible only if the catalogue lost an entry that a
       policy still references. Degrade to the stored facts rather than dropping
       somebody's cover off their own screen. */
    if (!product) {
        product = {
            productId: String(row.product_id),
            name: `Policy ${String(row.policy_number)}`,
            category: 'Insurance',
            icon: 'shield',
            benefits: []
        };
    }

    /* JSONB arrives already parsed. The string branch is for safety. */
    let benefits: unknown = row.benefits;
    if (typeof benefits === 'string') {
        try { benefits = JSON.parse(benefits); } catch { benefits = null; }
    }
    if (!Array.isArray(benefits)) { benefits = product.benefits; }

    const num = (value: unknown): number | null =>
        value === null || value === undefined ? null : Number(value);

    return {
        id: `pol-db-${Number(row.id)}`,
        policyId: Number(row.id),
        customerId: row.person_id,
        productId: row.product_id,

        name: product.name,
        category: product.category,
        icon: product.icon,
        number: row.policy_number,

        sumAssured: num(row.cover),
        ciSumAssured: num(row.ci_cover),
        coverText: coverText(row),

        premium: {
            amount: Number(row.premium),
            per: row.premium_per
        },

        start: toDateOnly(row.start_date),
        renewal: toDateOnly(row.renewal_date),
        maturity: toDateOnly(row.maturity_date),

        termText: termText(row),

        /* Derived, never stored - see the note at the top of db/schema.sql. */
        status: displayStatus(row),
        daysToRenewal: daysToRenewal(row),

        payment: row.payment_method ?? 'Not set up yet',

        /* ALWAYS ARRAYS. See the warning above this function. */
        benefits: benefits as unknown[],
        riders: [],
        exclusions: [],

        /* Marks it as a real record rather than demo content, so a screen can say
           so honestly where that matters. */
        isReal: true
    };
}

/* "Renewal due" is a fact about today, not about the policy, so it is worked out
   on every read instead of being written down.

   A date already in the past still reads as "renewal due" rather than "lapsed".
   Lapsing is a decision somebody makes, with consequences for whether a claim
   would be paid, and inferring it from a date nobody acted on would be the app
   inventing an outcome. */
export function displayStatus(row: Row): string {
    if (row.status !== 'active') { return String(row.status); }

    const days = daysToRenewal(row);
    if (days === null) { return 'active'; }

    return days <= RENEWAL_WINDOW_DAYS ? 'renewal-due' : 'active';
}

/* Days until renewal. Negative when it has already passed. */
export function daysToRenewal(row: Row): number | null {
    const date = toDateOnly(row.renewal_date);
    if (!date) { return null; }

    const renewal = new Date(`${date}T00:00:00Z`).getTime();
    const today = Date.now();

    return Math.floor((renewal - today) / 86_400_000);
}

/* The one-line description of what the cover actually is. Built from whichever
   figures the product uses, because they differ: a lump sum, a monthly benefit,
   or neither. */
function coverText(row: Row): string {
    const money = (amount: unknown) => `$${Number(amount).toLocaleString('en-US')}`;

    if (row.cover !== null && Number(row.cover) > 0) {
        return `${money(row.cover)} death benefit`;
    }
    if (row.monthly_benefit !== null && Number(row.monthly_benefit) > 0) {
        return `${money(row.monthly_benefit)} a month while you cannot work`;
    }
    if (row.ci_cover !== null && Number(row.ci_cover) > 0) {
        return `${money(row.ci_cover)} critical illness cover`;
    }
    return 'Pays the eligible bill';
}

function termText(row: Row): string {
    const years = row.term_years === null || row.term_years === undefined
        ? 0 : Number(row.term_years);

    return years > 0 ? `${years}-year term` : 'Annually renewable';
}

export function applicationJson(row: Row | null): Record<string, unknown> | null {
    if (!row) { return null; }

    const product = policyProduct(row.product_id);
    const num = (value: unknown): number | null =>
        value === null || value === undefined ? null : Number(value);

    return {
        id: Number(row.id),
        productId: row.product_id,
        name: product ? product.name : row.product_id,
        category: product ? product.category : '',
        icon: product ? product.icon : 'shield',

        customerId: row.customer_person_id,
        customerName: row.customer_name ?? null,
        repId: row.rep_person_id,
        repName: row.rep_name ?? null,

        cover: num(row.cover),
        ciCover: num(row.ci_cover),
        monthlyBenefit: num(row.monthly_benefit),
        premium: Number(row.premium),
        termYears: num(row.term_years),

        note: row.note,
        status: row.status,
        declineReason: row.decline_reason,

        createdAt: toIso(row.created_at),
        resolvedAt: toIso(row.resolved_at)
    };
}

/* Whole dollars with thousands separators. The browser has FMT.money for this;
   the server needs it too because coverText is assembled here, and two formatters
   that disagree would show two different numbers for one figure. */
export function policyMoney(amount: unknown): string {
    return `$${Number(amount).toLocaleString('en-US')}`;
}
