/* =============================================================================
   finances.ts - the customer's own financial record, and the needs analysis
   -----------------------------------------------------------------------------
   Ported from php/lib/finances.php.

   =============================================================================
   WHY THE CALCULATION IS HERE AND NOT IN THE BROWSER
   =============================================================================

   Two screens show these numbers - the customer's dashboard and the
   representative's view of that customer - and they must never disagree. A
   protection gap of $610,000 on one screen and $580,000 on the other is worse
   than showing nothing, because it makes both untrustworthy and there is no way
   for either person to tell which is right.

   One function, on the server, called by both. The browser formats; it does not
   compute.

   It also means the rule is written down in one place where it can be read and
   argued with, which matters for something shown to a customer.

   =============================================================================
   WHAT THIS IS NOT
   =============================================================================

   It is NOT advice. It is a textbook capital-needs calculation with its
   assumptions stated: replace income for a number of years, clear what is owed,
   subtract what is already there. Every figure is traceable to a number the
   customer typed and a multiplier written below.
   ============================================================================= */

import { all, one, q, toIso, type Row } from './db.js';

/* One list, used for validating a POST, for building the UPDATE, and for shaping
   the JSON. Adding a field means adding one line here.

   `max` is not arbitrary - it is the point past which a number is certainly a
   typo rather than a fortune, and a silly figure in a needs calculation produces
   a silly recommendation. */
export const FIELDS: Record<string, { col: string; max: number; label: string }> = {
    annualIncome:        { col: 'annual_income',          max: 100_000_000, label: 'annual income' },
    monthlyIncome:       { col: 'monthly_income',         max: 10_000_000,  label: 'monthly income' },
    monthlyExpenses:     { col: 'monthly_expenses',       max: 10_000_000,  label: 'monthly expenses' },
    monthlyCommitments:  { col: 'monthly_commitments',    max: 10_000_000,  label: 'monthly commitments' },
    premiumBudget:       { col: 'premium_budget',         max: 1_000_000,   label: 'premium budget' },
    savings:             { col: 'savings',                max: 1_000_000_000, label: 'savings' },
    cpf:                 { col: 'cpf',                    max: 1_000_000_000, label: 'CPF' },
    mortgage:            { col: 'mortgage',               max: 1_000_000_000, label: 'mortgage' },
    otherDebt:           { col: 'other_debt',             max: 1_000_000_000, label: 'other debt' },
    dependants:          { col: 'dependants',             max: 20,          label: 'dependants' },
    retireAge:           { col: 'retire_age',             max: 100,         label: 'retirement age' },
    retireMonthlyTarget: { col: 'retire_monthly_target',  max: 1_000_000,   label: 'retirement income target' },
    existingLifeCover:   { col: 'existing_life_cover',    max: 1_000_000_000, label: 'existing life cover' },
    existingCiCover:     { col: 'existing_ci_cover',      max: 1_000_000_000, label: 'existing critical illness cover' }
};


export async function financesFor(personId: string | null): Promise<Row | null> {
    if (!personId) { return null; }

    return one('SELECT * FROM customer_finances WHERE person_id = ?', [personId]);
}


/* Write only the fields that were sent.

   A Settings form that posts three values must not blank the other eleven - and
   it would, if this built a full UPDATE from whatever happened to be in the
   request.

   So a field ABSENT from the payload is left exactly as it was, and a field sent
   as an EMPTY STRING is set to NULL, which is how somebody clears one. Those are
   deliberately different: "I did not touch it" and "I want that removed" are not
   the same instruction.

   Returns an error message, or null when it wrote cleanly.
   ============================================================================= */
export async function financesSave(
    personId: string,
    payload: Record<string, unknown>,

    /* WHO IS DOING THIS, for the change log. Optional so the two callers that do
       not have an account to hand (a migration, a recalculation) still compile -
       but every real edit passes it, and an entry with no author is what makes a
       log useless. */
    by: { accountId: number | null; source: 'self' | 'ai' | 'rep' | 'system' } | null = null
): Promise<string | null> {
    if (typeof payload !== 'object' || payload === null) {
        return 'No figures were received.';
    }

    const columns: string[] = [];
    const values: Array<number | null> = [];

    for (const [key, spec] of Object.entries(FIELDS)) {
        /* Absent means "leave alone", which is not the same as "clear". */
        if (!Object.prototype.hasOwnProperty.call(payload, key)) { continue; }

        const raw = payload[key];

        if (raw === null || raw === '' || raw === undefined) {
            columns.push(spec.col);
            values.push(null);
            continue;
        }

        const value = Number(raw);

        if (!Number.isFinite(value)) {
            return `That does not look like a number for ${spec.label}.`;
        }
        if (value < 0) {
            return `${spec.label[0]!.toUpperCase()}${spec.label.slice(1)} cannot be negative.`;
        }
        if (value > spec.max) {
            return `That figure for ${spec.label} looks too large. Please check it.`;
        }

        columns.push(spec.col);
        values.push(Math.round(value));
    }

    if (columns.length === 0) { return 'No figures were received.'; }

    /* WHAT IT SAID BEFORE, read BEFORE the write.

       This is the only moment the old value exists anywhere. customer_finances
       holds the current figure and nothing else, so a change log written after the
       update could only ever record what it changed TO - which is the half you can
       already see by looking at the record. */
    const before = by === null ? null : await financesFor(personId);

    /* One upsert. The row may not exist yet, and checking first would be a second
       round trip plus a race. */
    const placeholders = columns.map(() => '?').join(', ');
    const updates = columns.map(col => `${col} = EXCLUDED.${col}`).join(', ');

    await q(
        `INSERT INTO customer_finances (person_id, ${columns.join(', ')})
         VALUES (?, ${placeholders})
         ON CONFLICT (person_id) DO UPDATE SET ${updates}, updated_at = now()`,
        [personId, ...values]
    );

    /* =========================================================================
       THE CHANGE LOG

       One row per field that ACTUALLY MOVED. A Settings form posts fourteen boxes
       whether or not any of them were touched, so logging everything sent would
       fill the log with "annual income: 96000 -> 96000" and bury the one line
       somebody came looking for.

       AFTER the write and never blocking it. If this fails, the figure is still
       saved - which is the right way round. A save refused because its own audit
       trail could not be written would be a worse product than a save with a gap
       in the trail.
       ========================================================================= */
    if (by !== null) {
        for (let i = 0; i < columns.length; i++) {
            const col = columns[i] as string;
            const next = values[i];

            const prev = before === null || before[col] === undefined || before[col] === null
                ? null
                : String(before[col]);

            const nextText = next === null ? null : String(next);

            /* Compared as text, because that is how both ends are stored - and
               '96000' from the database and 96000 from the form are the same
               figure however Postgres chose to hand back a NUMERIC. */
            if (prev === nextText) { continue; }

            try {
                await q(
                    `INSERT INTO finance_changes
                         (person_id, field, old_value, new_value, source, changed_by)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [personId, col, prev, nextText, by.source, by.accountId]
                );
            } catch {
                /* See above. The figure is saved; the log entry is not worth
                   failing the request over. */
            }
        }
    }

    return null;
}


/* =============================================================================
   READING THE CHANGE LOG

   Who changed what, when, and how. The customer can read their own; their
   representative can read it for a client of theirs - both enforced by the route,
   not here.
   ============================================================================= */

export interface FinanceChangeView {
    id: number;
    field: string;
    label: string;
    oldValue: string | null;
    newValue: string | null;
    source: string;
    by: string | null;
    quote: string | null;
    at: unknown;
}

/* column name -> the label the form uses, so the log reads in the same words as
   the boxes it is about. Built by inverting FIELDS rather than written out again,
   which is what stops the two lists drifting. */
const LABEL_BY_COLUMN: Record<string, string> = Object.fromEntries(
    Object.values(FIELDS).map(spec => [spec.col, spec.label])
);

export async function financeChanges(
    personId: string,
    limit = 60
): Promise<FinanceChangeView[]> {
    const rows = await all(
        `SELECT c.*, a.name AS by_name
           FROM finance_changes c
           LEFT JOIN accounts a ON a.id = c.changed_by
          WHERE c.person_id = ?
          ORDER BY c.created_at DESC
          LIMIT ${Math.min(200, Math.max(1, Math.trunc(limit)))}`,
        [personId]
    );

    return rows.map(row => ({
        id: Number(row.id),
        field: String(row.field),
        label: LABEL_BY_COLUMN[String(row.field)] ?? String(row.field).replace(/_/g, ' '),
        oldValue: row.old_value === null ? null : String(row.old_value),
        newValue: row.new_value === null ? null : String(row.new_value),
        source: String(row.source),
        by: row.by_name === null || row.by_name === undefined ? null : String(row.by_name),
        quote: row.quote === null || row.quote === undefined ? null : String(row.quote),
        at: row.created_at
    }));
}


/* =============================================================================
   THE NEEDS ANALYSIS
   ============================================================================= */

export interface NeedsLine {
    key: string;
    label: string;
    current: number;
    recommended: number;
    monthly: boolean;
    gap: number;
    why: string;
}

function line(
    key: string, label: string, recommended: number,
    current: number, monthly: boolean, why: string
): NeedsLine {
    return {
        key, label,
        current: Math.round(current),
        recommended: Math.round(recommended),
        monthly,
        gap: Math.max(0, Math.round(recommended) - Math.round(current)),
        why
    };
}

const num = (value: unknown): number => {
    if (value === null || value === undefined) { return 0; }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

export function financesNeeds(row: Row | null): Record<string, unknown> | null {
    if (!row) { return null; }

    let annual = num(row.annual_income);

    /* Annual income is load-bearing for every line. Without it there is nothing
       to calculate, so say so rather than returning zeros that look like an
       answer. Falls back to monthly x 12 if that is what they gave us. */
    if (annual <= 0) {
        const monthly = num(row.monthly_income);
        if (monthly > 0) { annual = monthly * 12; }
    }

    if (annual <= 0) { return null; }

    const monthlyIncome = row.monthly_income !== null && row.monthly_income !== undefined
        ? num(row.monthly_income)
        : Math.round(annual / 12);

    const savings = num(row.savings);
    const cpf = num(row.cpf);
    const mortgage = num(row.mortgage);
    const otherDebt = num(row.other_debt);
    const deps = num(row.dependants);

    const haveLife = num(row.existing_life_cover);
    const haveCi = num(row.existing_ci_cover);

    /* CPF is counted as liquid for a DEATH benefit because it is paid out to
       nominees, and NOT counted for disability, because you are still alive and
       still need it. That distinction is the sort of thing a customer will ask
       about, so it is deliberate rather than convenient. */
    const liquidOnDeath = savings + cpf;
    const liquidAlive = savings;

    /* 5 years with nobody depending on you, rising to 15 with three or more. */
    const years = 5 + Math.min(deps, 3) * 3 + (deps > 3 ? 1 : 0);

    const lines: NeedsLine[] = [
        line('life', 'Life / death benefit',
            Math.max(0, (annual * years) + mortgage + otherDebt - liquidOnDeath),
            haveLife, false,
            `${years} years of your income, plus what you owe, less your savings and CPF`),

        line('ci', 'Critical illness',
            Math.max(0, annual * 3), haveCi, false,
            'Three years of income - not for the bills, for the time you would not be working'),

        line('tpd', 'Total and permanent disability',
            Math.max(0, (annual * 5) - liquidAlive), 0, false,
            'Five years of income less your savings. CPF is not counted here, because you would still need it'),

        line('income', 'Monthly income replacement',
            Math.max(0, Math.round(monthlyIncome * 0.5)), 0, true,
            'Half your monthly income, which is the usual starting point for a monthly benefit')
    ];

    /* Totals across the LUMP-SUM lines only. Adding a monthly benefit to a lump
       sum would be adding two different units, and the result would be
       meaningless. */
    let need = 0;
    let have = 0;

    for (const item of lines) {
        if (item.monthly) { continue; }
        need += item.recommended;
        have += item.current;
    }

    /* An emergency fund is not insurance, but it is the first thing a
       representative checks and the customer can see it for themselves. */
    const expenses = num(row.monthly_expenses);
    let emergency: Record<string, unknown> | null = null;

    if (expenses > 0) {
        const target = expenses * 6;
        emergency = {
            targetMonths: 6,
            target,
            have: savings,
            monthsHeld: Math.round((savings / expenses) * 10) / 10,
            shortfall: Math.max(0, target - savings)
        };
    }

    /* Affordability, if they told us. What is left after everything already
       committed is the honest ceiling on a new premium - and if their stated
       budget is above it, that is worth flagging BEFORE a plan is recommended
       rather than after they cancel it. */
    let affordability: Record<string, unknown> | null = null;
    const budget = num(row.premium_budget);
    const commitments = num(row.monthly_commitments);

    if (monthlyIncome > 0 && (expenses > 0 || commitments > 0)) {
        const spare = monthlyIncome - expenses - commitments;

        affordability = {
            spare,
            statedBudget: budget > 0 ? budget : null,
            overCommitted: budget > 0 && spare > 0 && budget > spare,
            noHeadroom: spare <= 0
        };
    }

    return {
        lines,
        totalNeed: need,
        totalHave: have,
        gap: Math.max(0, need - have),

        /* 100 when nothing is needed, so an unusually well-covered person does
           not divide by zero and score 0. */
        ratio: need > 0 ? Math.round(Math.min(100, (have / need) * 100)) : 100,
        yearsOfIncome: years,
        emergency,
        affordability
    };
}


/* =============================================================================
   THE JSON SHAPE

   camelCase keys, matching the rest of the API and the mock records in
   js/data.js, so the browser needs no translation layer.

   NULL IS PRESERVED as null rather than flattened to 0. The whole point of the
   nullable columns is that "not told us" and "zero" are different, and casting
   here would throw that away at the last moment.
   ============================================================================= */
export function financesJson(row: Row | null): {
    finances: Record<string, unknown> | null;
    needs: Record<string, unknown> | null;
    hasAny: boolean;
} {
    if (!row) {
        return { finances: null, needs: null, hasAny: false };
    }

    const out: Record<string, unknown> = {};
    let hasAny = false;

    for (const [key, spec] of Object.entries(FIELDS)) {
        const value = row[spec.col];

        if (value === null || value === undefined) {
            out[key] = null;
        } else {
            out[key] = Number(value);
            hasAny = true;
        }
    }

    out.updatedAt = toIso(row.updated_at);

    return {
        finances: out,
        needs: financesNeeds(row),
        hasAny
    };
}
