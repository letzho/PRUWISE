/* =============================================================================
   assessment.ts - the questionnaire, the scoring, and the matching
   -----------------------------------------------------------------------------
   Ported from php/lib/assessment.php.

   Four things live here and they are deliberately together, because changing one
   without the others produces a result that is subtly wrong rather than broken:

       the QUESTIONS         seven of them, and the only allowed answers
       the PROFILE           what the answers add up to about this person
       the RECOMMENDATIONS   which products earned a place, and why
       the MATCHING          which representatives fit, and why

   THE QUESTIONS ARE DUPLICATED IN js/pages-onboarding.js as BUILT_IN_QUESTIONS,
   so question one appears the instant the screen opens with no request. The
   server's copy always wins if they differ. The `value` strings are the contract:
   cleanAnswers() rejects anything not in this list, so a typo in the JS copy lets
   somebody answer all seven questions and then fail on submit.
   ============================================================================= */

import { all, column, one, q, toIso, type Row } from './db.js';

export interface Option {
    value: string;
    label: string;
    hint?: string;
}

export interface Question {
    id: string;
    type: 'single' | 'multi';
    title: string;
    help: string;
    options: Option[];
}

/* ============================================================================
   1. THE QUESTIONS
   ============================================================================ */

export const QUESTIONS: Question[] = [
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

const QUESTION_MAP = new Map(QUESTIONS.map(question => [question.id, question]));

/* The label for one stored value: ('goal','retirement') -> 'Retirement'.

   Falls back to the raw value, so an answer stored by an older version of the
   questions still displays as something rather than vanishing. */
export function optionLabel(questionId: string, value: string): string {
    const question = QUESTION_MAP.get(questionId);

    if (question) {
        for (const option of question.options) {
            if (option.value === value) { return option.label; }
        }
    }
    return String(value);
}


/* ============================================================================
   2. CHECKING THE ANSWERS

   Never trust the browser. Not because the form is untrustworthy, but because
   the form is not the only thing that can post here - anybody can send whatever
   JSON they like.

   Every question must be answered, and every answer must be one of the values
   offered. Returns the clean answers, or a problem describing what was wrong and
   which question it belongs to.
   ============================================================================ */

export type Answers = Record<string, string | string[]>;

export interface CleanResult {
    answers?: Answers;
    error?: string;
    field?: string | null;
}

export function cleanAnswers(submitted: unknown): CleanResult {
    if (typeof submitted !== 'object' || submitted === null) {
        return { error: 'No answers were received.', field: null };
    }

    const input = submitted as Record<string, unknown>;
    const clean: Answers = {};

    for (const question of QUESTIONS) {
        const id = question.id;
        const allowed = question.options.map(option => option.value);
        let given = input[id];

        if (question.type === 'multi') {
            /* A single value posted where a list belongs is a common and harmless
               mistake, so accept it rather than failing. */
            if (typeof given === 'string') { given = [given]; }

            if (!Array.isArray(given) || given.length === 0) {
                return { error: `Please answer: ${question.title}`, field: id };
            }

            const picked: string[] = [];

            for (const value of given) {
                if (typeof value !== 'string' || !allowed.includes(value)) {
                    return {
                        error: `That is not one of the options for: ${question.title}`,
                        field: id
                    };
                }
                if (!picked.includes(value)) { picked.push(value); }
            }

            /* "None" alongside three specifics is a contradiction, almost always
               from clicking it first and then changing their mind. Take the
               specific answers as the real one. */
            clean[id] = picked.length > 1
                ? picked.filter(value => value !== 'none')
                : picked;

        } else {
            if (typeof given !== 'string' || given === '') {
                return { error: `Please answer: ${question.title}`, field: id };
            }
            if (!allowed.includes(given)) {
                return {
                    error: `That is not one of the options for: ${question.title}`,
                    field: id
                };
            }
            clean[id] = given;
        }
    }

    /* Anything posted that is not a question we asked is dropped, simply by
       building the result from the question list rather than from the input. */
    return { answers: clean };
}

function answer(answers: Answers, id: string, fallback = ''): string {
    const value = answers[id];
    if (typeof value === 'string') { return value; }
    return fallback;
}


/* ============================================================================
   3. SUPPORTING CONVERSIONS
   ============================================================================ */

/* A dollar figure placed into the same five brackets the question offers, so
   everything downstream keeps comparing against option values it already knows.
   The boundaries are the question's own boundaries. */
export function budgetBand(amount: number): string {
    if (amount < 50)  { return 'under50'; }
    if (amount < 150) { return '50to150'; }
    if (amount < 400) { return '150to400'; }
    return 'over400';
}

/* Rough years until 65, from the age band. The midpoint is close enough for
   choosing between a 10-year and a 30-year plan, and it avoids asking for a date
   of birth we have no reason to hold. */
export function horizonYears(ageRange: string): number {
    const midpoints: Record<string, number> = {
        under25: 22, '25to34': 30, '35to44': 40, '45to54': 50, '55plus': 58
    };
    const age = midpoints[ageRange] ?? 40;

    return Math.max(5, 65 - age);
}

function goalLabel(goal: string): string {
    const labels: Record<string, string> = {
        home: 'Buying a home',
        retirement: 'Retirement planning',
        protection: 'Family protection',
        education: 'Education funding',
        investment: 'Wealth accumulation'
    };
    return labels[goal] ?? 'Financial planning';
}

function riskLabel(level: string): string {
    const labels: Record<string, string> = {
        conservative: 'Conservative',
        moderate: 'Moderate',
        growth: 'Growth-focused'
    };
    return labels[level] ?? 'Moderate';
}

function ucfirst(text: string): string {
    return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function lcfirst(text: string): string {
    return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}


/* ============================================================================
   WHAT THEY CAN AFFORD EACH MONTH

   Two possible sources, and they are not equally good.

   The QUESTIONNAIRE asks for a bracket, because a bracket can be answered in two
   seconds. SETTINGS asks for the actual number. A person who typed "300" has told
   us more than a person who tapped "$150 to $400", and if they later changed it to
   120 then the bracket they ticked months ago is out of date.

   So the typed figure wins when there is one. Not precision for its own sake:
   recommendations() gives points to cheaper products on a small budget, and
   suggesting a $400 plan to somebody whose own record says $120 is the kind of
   mistake that ends in a lapsed policy.

   NOTHING IS DISCARDED - `source` says which was used, so a representative can
   see that the two disagreed.
   ============================================================================ */

interface Budget {
    band: string;
    label: string;
    amount: number | null;
    source: 'answer' | 'figures';
}

async function assessmentBudget(answers: Answers, personId: string | null): Promise<Budget> {
    const answered = answer(answers, 'budget', 'unsure');

    const out: Budget = {
        band: answered,
        label: optionLabel('budget', answered),
        amount: null,
        source: 'answer'
    };

    if (!personId) { return out; }

    /* Queried directly rather than through a finances helper, to keep this file
       free of a dependency it needs one column from. */
    const raw = await column<number>(
        'SELECT premium_budget FROM customer_finances WHERE person_id = ?',
        [personId]
    );

    /* NULL means "did not say", which is not the same as zero and must not
       out-rank an answered bracket. Zero is treated the same way: somebody who
       typed 0 is saying they cannot afford anything right now, and there is no
       bracket for that, so the honest move is to fall back to what they ticked
       rather than invent "under $50". */
    if (raw === null) { return out; }

    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) { return out; }

    out.band = budgetBand(amount);
    out.label = `${optionLabel('budget', out.band)} (you said $${amount.toLocaleString('en-US')} a month)`;
    out.amount = amount;
    out.source = 'figures';

    return out;
}


/* ============================================================================
   4. THE PROFILE
   ============================================================================ */

export interface Profile {
    primaryGoal: string;
    primaryGoalLabel: string;
    riskLevel: string;
    riskLevelLabel: string;
    protectionNeed: string;
    protectionNeedLabel: string;
    experience: string;
    experienceLabel: string;
    ageRange: string;
    ageRangeLabel: string;
    dependants: string;
    dependantsLabel: string;
    budget: string;
    budgetLabel: string;
    budgetAmount: number | null;
    budgetSource: string;
    concern: string;
    concernLabel: string;
    horizonYears: number;
    signals: string[];
    scores: { protection: number; risk: number };
}

export async function buildProfile(
    answers: Answers,
    personId: string | null = null
): Promise<Profile> {
    const goal = answer(answers, 'goal', 'protection');
    const age = answer(answers, 'age', '35to44');
    const dependants = answer(answers, 'dependants', 'nobody');
    const cover = answer(answers, 'cover', 'none');
    const concern = answer(answers, 'concern', 'illness');
    const riskAnswer = answer(answers, 'risk', 'moderate');

    /* EXPERIENCE IS INFERRED, NOT ASKED. There used to be a question for it; it
       went, because the assessment being SHORT matters more than this one field
       being precise - a questionnaire nobody finishes tells you nothing.

       Derived from the risk answer, the closest honest proxy: somebody who
       knowingly picks "I will take risk for higher returns" has almost always
       seen a market fall, and somebody who picks "I want my money to be safe" is
       usually telling you they have not.

       IT ONLY DECIDES HOW MUCH TO EXPLAIN, never what somebody may buy - so a
       wrong guess costs a paragraph, not a mis-sale. */
    let experience: string;

    if (riskAnswer === 'low') { experience = 'none'; }
    else if (riskAnswer === 'moderate') { experience = 'some'; }
    else { experience = 'experienced'; }

    /* Under 25 and bold is usually optimism rather than experience, so it comes
       down one step. Never below beginner, and never up. */
    if (age === 'under25' && experience === 'experienced') { experience = 'some'; }

    /* The plain-language trail of how we got here. Shown to the customer under
       their profile, and it is the difference between a result that feels
       personalised and one that feels like a horoscope. */
    const signals: string[] = [];

    /* ------------------------------------------------------- protection need

       Points, not rules. Somebody with children, no cover of their own and a
       fear of serious illness should score higher than any one of those alone,
       and adding up is the simplest way to get that. */
    let protection = 0;

    const coverPoints: Record<string, number> = {
        none: 3, employer: 2, some: 1, comprehensive: 0
    };
    protection += coverPoints[cover] ?? 1;

    if (cover === 'none') {
        signals.push('You have no cover in place at the moment.');
    } else if (cover === 'employer') {
        /* Worth saying out loud. Group cover feels like being insured right up
           until the day the job ends, which is often the same day the income
           problem starts. */
        signals.push('Your only cover comes through your employer, which usually ends when the job does.');
    }

    const dependantPoints: Record<string, number> = {
        nobody: 0, partner: 1, children: 2, extended: 3
    };
    protection += dependantPoints[dependants] ?? 0;

    if (dependants === 'children' || dependants === 'extended') {
        signals.push('Other people depend on your income, so losing it would affect more than just you.');
    }

    /* The worry itself is evidence. People are usually anxious about the right
       thing. */
    if (concern === 'illness' || concern === 'incomeloss') { protection += 2; }
    else if (concern === 'education') { protection += 1; }

    if (goal === 'protection') {
        protection += 2;
        signals.push('You told us protecting your family is the priority right now.');
    }

    if (goal === 'home') {
        protection += 1;
        signals.push('A home loan is a commitment that would outlive you, so it changes what protection means for you.');
    }

    const protectionNeed = protection >= 6 ? 'high' : (protection >= 3 ? 'medium' : 'low');

    /* ------------------------------------------------------------ risk level

       Starts from what they said, then nudges - never overrules.

       ONE RULE DECIDES THIS WHOLE BLOCK: WE MAY BE MORE CAUTIOUS THAN SOMEBODY
       ASKED FOR. WE MAY NEVER BE BOLDER.

       It would be easy to write scoring that turns "some ups and downs are fine"
       into a growth profile because they are young. That is a quiet override of
       what a person actually told us, and it is how a tool loses trust - or
       worse, talks somebody into a fund that falls 30% in a year they never
       agreed to risk.

       So the points below can only move the result DOWN from the stated answer.
       Which means the upward nudges are not pointless: they are what stops a
       cautious signal dragging somebody below where they said they were. */
    const riskPoints: Record<string, number> = { low: 0, moderate: 3, high: 5 };
    let risk = riskPoints[riskAnswer] ?? 3;

    const experiencePoints: Record<string, number> = {
        none: -1, little: 0, some: 1, experienced: 2
    };
    risk += experiencePoints[experience] ?? 0;

    /* Time is what makes market risk survivable. Thirty years can sit through a
       crash; five cannot. */
    const horizon = horizonYears(age);

    if (horizon >= 25) { risk += 1; }
    else if (horizon <= 10) { risk -= 1; }

    /* Money needed soon should not be exposed to a market, whatever the
       appetite. Saving for a home is the clearest near-term need. */
    if (goal === 'home') { risk -= 1; }

    const bands = ['conservative', 'moderate', 'growth'];
    let band = risk <= 2 ? 0 : (risk <= 4 ? 1 : 2);

    /* Now apply the rule. The band they chose is the ceiling. */
    const statedBands: Record<string, number> = { low: 0, moderate: 1, high: 2 };
    const stated = statedBands[riskAnswer] ?? 1;

    band = Math.min(band, stated);

    /* One exception, in the other direction: somebody who deliberately chose the
       most adventurous option should not be filed as conservative because of two
       small deductions. Moderate at the lowest, and their representative can have
       the conversation about the rest. */
    if (riskAnswer === 'high') { band = Math.max(band, 1); }

    const level = bands[band] as string;

    if (level === 'conservative') {
        signals.push('You would rather have certainty than the chance of a higher return.');
    } else if (level === 'growth') {
        signals.push('You are comfortable with market movement in exchange for growth.');
    }

    /* ------------------------------------------------------------ experience */
    const experienceLevel = experience === 'experienced'
        ? 'experienced'
        : (experience === 'some' ? 'intermediate' : 'beginner');

    if (experienceLevel === 'beginner') {
        signals.push('You are new to investing, so anything recommended should be explained in plain terms.');
    }

    if (horizon <= 10) {
        signals.push(
            `You are within about ${horizon} years of retirement age, ` +
            `which shortens the runway for anything long-term.`
        );
    }

    /* Worked out last because it reads the database. Everything above this line
       is pure arithmetic on the answers. */
    const budget = await assessmentBudget(answers, personId);

    if (budget.source === 'figures') {
        signals.push('Your budget comes from the figures you saved, not the bracket you ticked.');
    }

    return {
        primaryGoal: goal,
        primaryGoalLabel: goalLabel(goal),
        riskLevel: level,
        riskLevelLabel: riskLabel(level),
        protectionNeed,
        protectionNeedLabel: ucfirst(protectionNeed),
        experience: experienceLevel,
        experienceLabel: ucfirst(experienceLevel),

        ageRange: age,
        ageRangeLabel: optionLabel('age', age),
        dependants,
        dependantsLabel: optionLabel('dependants', dependants),

        budget: budget.band,
        budgetLabel: budget.label,
        budgetAmount: budget.amount,
        budgetSource: budget.source,

        concern,
        concernLabel: optionLabel('concern', concern),
        horizonYears: horizon,

        signals,

        /* Kept so a screen can show its working, and so an odd result is
           debuggable without re-running the scoring by hand. */
        scores: { protection, risk }
    };
}


/* ============================================================================
   5. THE PRODUCTS

   Only the name and category. The full catalogue - features, premiums, things to
   consider - lives in js/data.js because that is what the product pages render
   and it is mock data.

   This exists for a specific reason: what we recommended is SAVED and sent to a
   representative. A stored row reading ["prd-retire"] means nothing to anybody
   reading it on the server. Keeping the display name with it makes the record
   self-describing.
   ============================================================================ */

/* SAVINGS FIRST, and the order is load-bearing: recommendations() sorts by score
   and Object.keys preserves insertion order, so a savings plan wins a tie against
   a protection plan. See the long note above the same list in js/data.js for why
   the three savings plans were added and why the protection plans stayed. */
export const PRODUCTS: Record<string, { name: string; category: string }> = {
    'prd-save':   { name: 'PRUSave Guaranteed',  category: 'Capital-Guaranteed Savings' },
    'prd-flexi':  { name: 'PRUFlexiCash Saver',  category: 'Regular Savings' },
    'prd-legacy': { name: 'PRULegacy Builder',   category: 'Participating Whole Life Savings' },
    'prd-active': { name: 'PRUActive Protect',   category: 'Term Life & Critical Illness' },
    'prd-ci':     { name: 'PRUCritical First',   category: 'Critical Illness' },
    'prd-income': { name: 'PRUIncome Guard',     category: 'Disability Income' },
    'prd-growth': { name: 'PRUWealth Horizon',   category: 'Investment-Linked' },
    'prd-retire': { name: 'PRURetire Income',    category: 'Retirement Income' },
    'prd-edu':    { name: 'PRUEducation Builder', category: 'Endowment' },
    'prd-shield': { name: 'PRUShield Premier + Extra Saver', category: 'Hospitalisation' }
};


/* ============================================================================
   6. RECOMMENDATIONS

   Each product collects points and, more importantly, REASONS. The points decide
   the order; the reasons are what make the screen worth reading. A card saying
   "recommended for you" is marketing. A card saying "because you have children
   and no cover of your own" is a conversation.

   At most four, always at least two, best fit first.
   ============================================================================ */

/* How much a product must earn before it is shown at all.

   WHY A FLOOR AND NOT JUST A TOP FOUR: without one, a card can appear whose
   single reason is something incidental like "premiums are cheaper if you start
   young". That is true of every product, has nothing to do with the person
   reading it, and one filler card makes the other three look like filler too.
   Better to show two cards that were genuinely earned. */
const RECOMMEND_MIN_SCORE = 20;

export interface Recommendation {
    productId: string;
    name: string;
    category: string;
    fit: number;
    reasons: string[];
}

export function recommendations(profile: Profile, answers: Answers): Recommendation[] {
    const scores: Record<string, number> = {};
    const reasons: Record<string, string[]> = {};

    for (const id of Object.keys(PRODUCTS)) {
        scores[id] = 0;
        reasons[id] = [];
    }

    const add = (id: string, points: number, why: string) => {
        scores[id] = (scores[id] ?? 0) + points;
        reasons[id]?.push(why);
    };

    const goal = profile.primaryGoal;
    const risk = profile.riskLevel;
    const need = profile.protectionNeed;
    const horizon = profile.horizonYears;
    const dependants = profile.dependants;
    const concern = profile.concern;
    const cover = answer(answers, 'cover', 'none');
    const budget = profile.budget;
    const age = profile.ageRange;

    /* ==================================================================
       SAVINGS FIRST

       These three rules exist because the engine had a hole where a savings
       answer should have been.

       "Saving for a home" used to score TERM LIFE - the reason being that a
       home loan is a debt somebody else would inherit. That is true, and it
       is not an answer to the question that was asked. Somebody putting a
       deposit together was told about death cover and offered nothing at all
       to put the deposit in.
       ================================================================== */

    /* Capital-guaranteed savings. The right shape whenever money is needed on a
       date and losing any of it is unacceptable. */
    if (goal === 'home') {
        add('prd-save', 45,
            'A deposit is money you will need on a date you can name, so the ' +
            'amount you get back should not depend on a market.');
    }
    if (risk === 'conservative') {
        add('prd-save', 25,
            'You told us you would rather have certainty. The maturity value here ' +
            'is guaranteed in writing before you sign.');
    }
    if (horizon <= 10) {
        add('prd-save', 15,
            `With around ${horizon} years to go there is no time to recover from a ` +
            `bad year, which is the argument for a guaranteed return.`);
    }

    /* ---------------------------------------------------------------------
       THE LEAK THIS CLOSES.

       riskLevel is deliberately capped at the band somebody chose - see the
       long note in profile() about never being bolder than they asked. But
       the investment-linked plan had a SECOND door: `goal === 'investment'`
       scored it 25 points regardless of risk appetite, which is over the
       20-point floor on its own.

       So somebody who ticked "I want my money to be safe" and "growing my
       money" was recommended a plan whose own considerations say the value
       "is not guaranteed and can fall". Exactly the outcome the cap was
       written to prevent, reached by going round it.

       A cautious person with a growth goal wants a guaranteed savings plan.
       That is what this scores now.
       --------------------------------------------------------------------- */
    if (goal === 'investment' && risk === 'conservative') {
        add('prd-save', 30,
            'You want your money to grow but not to be at risk, which is what a ' +
            'guaranteed savings plan is for.');
    }

    /* Regular savings. The plan for a small budget - and the old range had
       nothing under $250 a month that was not protection. */
    if (budget === 'under50' || budget === '50to150') {
        add('prd-flexi', 35,
            'It starts from $100 a month, so a savings plan is possible on the ' +
            'budget you gave rather than something you would cancel.');
    }
    if (goal === 'investment') {
        add('prd-flexi', 20,
            'Putting money aside every month is the part of growing it that is ' +
            'in your control.');
    }
    if (age === 'under25' || age === '25to34') {
        add('prd-flexi', 20,
            'Starting early is the whole advantage of a savings plan, and the ' +
            'amount can go up as your income does.');
    }

    /* Participating whole life savings. Long horizons only, and NOT for anybody
       who asked for certainty - the bonuses are not guaranteed, so offering it as
       a safe option would be the same mistake the block above just fixed. */
    if (horizon >= 25 && risk !== 'conservative') {
        add('prd-legacy', 35,
            `Around ${horizon} years is long enough for the cash value to build ` +
            `and for the fund bonuses to matter.`);
    }
    if (goal === 'retirement') {
        add('prd-legacy', 18,
            'The cash value can be drawn on in retirement, or left where it is.');
    }
    if (dependants === 'extended' && risk !== 'conservative') {
        add('prd-legacy', 15,
            'Supporting two generations usually means wanting to leave something ' +
            'behind as well as saving.');
    }
    if (concern === 'inflation' && risk !== 'conservative') {
        add('prd-legacy', 20,
            'Participating bonuses are intended to keep pace with prices, which is ' +
            'the worry you named - though they are not guaranteed.');
    }

    /* ---------------------------------------------- term life with CI: the
       workhorse. Recommended whenever there is a protection gap, because it buys
       the most cover per dollar - which is also why it suits a small budget. */
    if (need === 'high' || need === 'medium') {
        add('prd-active', need === 'high' ? 45 : 30,
            `Your answers point to a ${need} protection need, and this is the most cover you can get for the money.`);
    }
    if (dependants === 'children' || dependants === 'extended') {
        add('prd-active', 20, 'It replaces your income for the people who depend on it.');
    }
    if (budget === 'under50' || budget === '50to150') {
        add('prd-active', 10, 'Cover can start small and be increased later without another health check.');
    }
    if (goal === 'home') {
        add('prd-active', 15, 'A home loan is a debt somebody else would inherit, and this is what clears it.');
    }

    /* ---------------------------------------------- critical illness. Driven by
       the worry rather than the goal - a fear of serious illness is a specific
       fear, and this is the specific answer. */
    if (concern === 'illness') {
        add('prd-ci', 45, 'You said a serious illness is what worries you most. This pays out on diagnosis, not on death.');
    }
    if (cover === 'none' || cover === 'employer') {
        add('prd-ci', 15, 'Employer cover rarely includes a critical illness payout you can spend as you choose.');
    }
    if (horizon >= 20) {
        add('prd-ci', 10, 'Taken out young, the premium is locked in at a lower age band for the whole term.');
    }

    /* ---------------------------------------------- disability income. The gap
       almost nobody thinks about: not dying, and not being able to work either. */
    if (concern === 'incomeloss') {
        add('prd-income', 45, 'You are worried about losing your income. This pays a monthly benefit while you cannot work.');
    }
    if (dependants !== 'nobody' && (cover === 'none' || cover === 'employer')) {
        add('prd-income', 20, 'Your household runs on your income, and a long illness stops it well before a claim on a life policy.');
    }
    if (budget === 'under50' || budget === '50to150') {
        add('prd-income', 10, 'A monthly benefit costs less than the equivalent lump-sum cover, so it fits a smaller budget.');
    }

    /* ---------------------------------------------- investment-linked. Needs
       BOTH an appetite for risk and the time to ride it out. */
    if ((risk === 'growth' || risk === 'moderate') && horizon >= 15) {
        add('prd-growth', risk === 'growth' ? 45 : 28,
            `You have around ${horizon} years and a ${profile.riskLevelLabel.toLowerCase()} ` +
            `attitude to risk, which is the combination this plan is built for.`);
    }
    /* THE RISK APPETITE GATES THIS, not just the goal. See the note above the
       prd-save rules: this line used to fire on the goal alone, which put a
       market-linked plan in front of somebody who had asked for safety. */
    if (goal === 'investment' && risk !== 'conservative') {
        add('prd-growth', 25, 'Growing your money is your stated goal, and this keeps a protection element alongside it.');
    }
    if (profile.experience === 'experienced') {
        add('prd-growth', 10, 'You already follow investments, so the fund choice will not be unfamiliar.');
    }

    /* ---------------------------------------------- retirement income. Either
       the stated goal, or simply being close enough that it becomes the goal
       whether or not it was named. */
    if (goal === 'retirement') {
        add('prd-retire', 45, 'Retirement is your main goal, and this turns savings into a predictable monthly income.');
    }
    if (horizon <= 20) {
        add('prd-retire', 20,
            `With around ${horizon} years to go, certainty about the income matters more than the last percent of growth.`);
    }
    if (concern === 'retirement' || concern === 'inflation') {
        add('prd-retire', 15, 'The optional rising-income version is aimed at exactly the worry you named.');
    }

    /* ---------------------------------------------- education endowment. A known
       amount on a known date - which is what school fees are, and why a
       market-linked plan is the wrong shape for them. */
    if (goal === 'education') {
        add('prd-edu', 45, 'You are saving for education, which has a date attached. This targets a known amount by that date.');
    }
    if (concern === 'education') {
        add('prd-edu', 20, 'Affording education is what you told us worries you most.');
    }
    if (dependants === 'children' || dependants === 'extended') {
        add('prd-edu', 12, 'Premiums are waived if the paying parent dies or is disabled, so the plan finishes either way.');
    }
    if (risk === 'conservative' && goal === 'education') {
        add('prd-edu', 8, 'The maturity value is known upfront, which suits your preference for certainty.');
    }

    /* ---------------------------------------------- hospitalisation. The one
       everybody should have before anything else, and the cheapest on the list. */
    if (cover === 'none') {
        add('prd-shield', 35, 'With no cover at all, a hospital plan is the first thing worth putting in place.');
    } else if (cover === 'employer') {
        add('prd-shield', 22, 'A plan of your own does not disappear when you change jobs.');
    }
    if (concern === 'illness') {
        add('prd-shield', 18, 'It caps your share of a private hospital bill, which is the part that gets frightening.');
    }
    if (dependants === 'extended') {
        add('prd-shield', 8, 'Family cover can be arranged on the same plan.');
    }

    /* ---------------------------------------------- order and trim */
    const ordered = Object.keys(PRODUCTS).sort(
        (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)
    );

    const picked: Recommendation[] = [];

    for (const id of ordered) {
        if (picked.length >= 4) { break; }
        if ((scores[id] ?? 0) < RECOMMEND_MIN_SCORE) { continue; }
        if ((reasons[id]?.length ?? 0) === 0) { continue; }   // no reason, no card

        picked.push({
            productId: id,
            name: PRODUCTS[id]!.name,
            category: PRODUCTS[id]!.category,

            /* A 0-100 fit for the badge. The raw total can exceed 100 when
               several rules fire, so it is capped - and floored at 55, because a
               product we chose to show is not a 12% match, and showing one as if
               it were makes the whole screen look broken. */
            fit: Math.max(55, Math.min(97, 55 + Math.round((scores[id] ?? 0) * 0.42))),
            reasons: reasons[id] ?? []
        });
    }

    /* A safety net rather than an expectation. Somebody well covered, with no
       dependants, no worries and no goals could in principle earn nothing - and
       an empty results screen looks like a bug even when it is the truth. */
    if (picked.length < 2) {
        /* A hospital plan first, because it is the one thing worth having before
           anything else and the cheapest on the list. Then guaranteed savings
           rather than term life: somebody who earned no protection points is by
           definition somebody the protection plans have nothing to say to, and
           putting money aside is a sensible thing for almost anybody. */
        for (const id of ['prd-shield', 'prd-save']) {
            if (picked.length >= 2) { break; }
            if (picked.some(item => item.productId === id)) { continue; }

            picked.push({
                productId: id,
                name: PRODUCTS[id]!.name,
                category: PRODUCTS[id]!.category,
                fit: 60,
                reasons: ['A sensible starting point for most people, and worth reviewing even if you are already covered.']
            });
        }
    }

    return picked;
}


/* ============================================================================
   7. MATCHING A REPRESENTATIVE

   Two rules come before any scoring, and both are absolute:

     1. A representative who has switched OFF "accepting new customers" is not
        offered. That is the whole point of the setting. Suggesting somebody who
        has said no is how you get a customer who never hears back.

     2. A representative at their own stated capacity is treated the same way.
        Being available is not the same as having room.

   Everything after that is a preference, not a rule.
   ============================================================================ */

export interface RepMatch {
    id: string;
    name: string;
    headline: string | null;
    bio: string | null;
    specialisations: string[];
    languages: string[];
    yearsExperience: number | null;
    acceptingCustomers: boolean;
    customerCount: number;
    maxCustomers: number | null;
    atCapacity: boolean;
    fit?: number;
    whyMatched?: string[];
    score?: number;
}

/* Always returns a list. A null column, invalid JSON or a JSON object all come
   back as an empty array, because the browser rendering these should never have
   to null-check before looping.

   JSONB arrives already parsed, unlike MySQL's JSON which came back as a string
   the PHP had to decode. The string branch is kept for safety. */
function jsonList(raw: unknown): string[] {
    let value = raw;

    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(value)) { return []; }

    return value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map(item => item.trim());
}

export function repProfileJson(row: Row): RepMatch {
    /* A missing rep_profiles row means "no preferences set yet", which is
       available - see the LEFT JOIN note in matchReps(). Defaulting it to "not
       accepting" would quietly hide real staff. */
    const accepting = row.accepting_customers === null || row.accepting_customers === undefined
        ? true
        : row.accepting_customers === true;

    const max = row.max_customers === null || row.max_customers === undefined
        ? null : Number(row.max_customers);
    const count = row.customer_count === undefined ? 0 : Number(row.customer_count);

    return {
        id: String(row.id),
        name: String(row.name),
        headline: (row.headline as string | null) ?? null,
        bio: (row.bio as string | null) ?? null,
        specialisations: jsonList(row.specialisations),
        languages: jsonList(row.languages),
        yearsExperience: row.years_experience === null || row.years_experience === undefined
            ? null : Number(row.years_experience),
        acceptingCustomers: accepting,
        customerCount: count,
        maxCustomers: max,
        atCapacity: max !== null && count >= max
    };
}

/* What to look for in a specialisation, and how much each is worth.

   Built from the profile rather than hard-coded per goal, so a customer whose
   goal is education AND whose protection need is high matches a representative
   who does either. */
export function matchKeywords(profile: Profile): Record<string, number> {
    const byGoal: Record<string, Record<string, number>> = {
        home:       { protection: 14, family: 10, mortgage: 14 },
        retirement: { retirement: 16, wealth: 10 },
        protection: { protection: 16, family: 12, income: 8 },
        education:  { education: 16, family: 10, children: 10 },
        investment: { investment: 16, wealth: 12, growth: 8 }
    };

    const keywords: Record<string, number> = { ...(byGoal[profile.primaryGoal] ?? {}) };

    /* Then the derived need, which the customer did not state but we concluded.
       Lower weight for exactly that reason. */
    if (profile.protectionNeed === 'high') {
        keywords.protection = (keywords.protection ?? 2) + 6;
    }
    if (profile.riskLevel === 'growth') {
        keywords.investment = (keywords.investment ?? 2) + 4;
    }

    /* THE WORRY THEY NAMED, which is often more specific than their goal.

       Somebody whose goal is "protect my family" but whose stated fear is a
       serious illness should reach the representative who specialises in critical
       illness - not merely one of several who list "protection". Their goal says
       what they want; their concern says what keeps them awake, and the second is
       usually the better guide to who they should be talking to.

       Weighted below the goal, because it is one answer rather than the whole
       reason they came. */
    const byConcern: Record<string, Record<string, number>> = {
        illness:    { 'critical illness': 14, hospitalisation: 10, medical: 10 },
        incomeloss: { income: 14, disability: 12, 'self-employed': 8 },
        retirement: { retirement: 10, legacy: 6 },
        education:  { education: 12, children: 8 },
        inflation:  { investment: 8, wealth: 8 }
    };

    for (const [word, weight] of Object.entries(byConcern[profile.concern] ?? {})) {
        keywords[word] = (keywords[word] ?? 0) + weight;
    }

    return keywords;
}

export async function matchReps(profile: Profile, limit = 4): Promise<RepMatch[]> {
    /* One query for everybody. There are a handful of representatives, so loading
       them all and scoring in TypeScript is both fast enough and far easier to
       read than expressing the weighting in SQL.

       LEFT JOIN deliberately: a representative created before rep_profiles
       existed has no row there, and defaulting that to "not accepting" would
       quietly hide real staff. */
    const rows = await all<Row>(
        `SELECT p.id, p.name, p.email,
                rp.accepting_customers, rp.headline, rp.bio,
                rp.specialisations, rp.languages, rp.years_experience, rp.max_customers,
                (SELECT COUNT(*) FROM people c
                  WHERE c.rep_id = p.id AND c.kind = 'customer') AS customer_count
           FROM people p
           LEFT JOIN rep_profiles rp ON rp.person_id = p.id
          WHERE p.kind = 'fr' AND p.status = 'active'
          ORDER BY p.id ASC`
    );

    const wanted = matchKeywords(profile);
    const matched: RepMatch[] = [];

    for (const row of rows) {
        const rep = repProfileJson(row);

        // Rules 1 and 2. Not scored, not ranked last - excluded.
        if (!rep.acceptingCustomers) { continue; }
        if (rep.atCapacity) { continue; }

        let score = 0;
        const why: string[] = [];

        /* Specialisation overlap. Each matching keyword is worth a lot, because
           this is the thing a customer would actually choose on. */
        for (const specialisation of rep.specialisations) {
            const haystack = specialisation.toLowerCase();

            for (const [keyword, weight] of Object.entries(wanted)) {
                if (haystack.includes(keyword)) {
                    score += weight;

                    /* Quote the representative's own wording back rather than our
                       keyword. "Retirement planning for families" reads like a
                       person; "matched: retirement" reads like a database. */
                    why.push(`Works in ${lcfirst(specialisation)}.`);
                    break;                  // one credit per specialisation
                }
            }
        }

        /* Experience, gently. Worth something, but it must not outweigh actually
           specialising in what you need - so it is capped well below a single
           keyword match. */
        if (rep.yearsExperience) {
            score += Math.min(8, rep.yearsExperience);

            if (rep.yearsExperience >= 5) {
                why.push(`${rep.yearsExperience} years of experience.`);
            }
        }

        /* A beginner benefits more from an experienced representative than an
           already-confident investor does. */
        if (profile.experience === 'beginner' && (rep.yearsExperience ?? 0) >= 5) {
            score += 6;
            why.push('Used to explaining things from the beginning.');
        }

        /* Spread the load. A NUDGE, not a rule - it can only reorder people who
           already passed the availability and capacity checks. Signup used to hand
           out representatives by load alone, which is exactly how the one who had
           switched off ended up with every new customer. */
        score += Math.max(0, 6 - Math.floor(rep.customerCount / 5));

        if (rep.customerCount < 5) {
            why.push('Has room to take you on properly.');
        }

        /* SCALED RATHER THAN ADDED, because raw scores bunch up at the top once
           there are several well-matched representatives: three people scoring 53,
           47 and 44 all hit the cap and displayed as 98%, which makes the number
           look decorative. Multiplying spreads them into the high eighties and
           nineties while keeping the order.

           Floored at 62 - somebody we chose to show is not a 12% match. */
        rep.fit = Math.max(62, Math.min(97, 62 + Math.round(score * 0.62)));

        /* Never leave a card with nothing under it. If nothing specific matched,
           say the honest thing instead of inventing a reason. */
        if (why.length === 0) {
            why.push('Available now and able to take on new customers.');
        }

        rep.whyMatched = why.slice(0, 3);
        rep.score = score;

        matched.push(rep);
    }

    /* An explicit tie-break on id. Without it two equal scores could come back in
       either order on different requests, and a list that reshuffles itself
       between page loads looks broken. */
    matched.sort((a, b) => {
        if ((a.score ?? 0) === (b.score ?? 0)) { return a.id.localeCompare(b.id); }
        return (b.score ?? 0) - (a.score ?? 0);
    });

    return matched.slice(0, limit);
}


/* ============================================================================
   8. READING AND WRITING AN ASSESSMENT
   ============================================================================ */

export async function assessmentForAccount(accountId: number): Promise<Row | null> {
    return one('SELECT * FROM assessments WHERE account_id = ?', [accountId]);
}

/* Score the answers and store them.

   ON CONFLICT DO UPDATE rather than delete-then-insert, and that choice matters:
   consultation_requests.assessment_id points at this row. Deleting and
   re-inserting would give it a new id and cut the link from any request already
   sent - the representative would open a request attached to nothing. Updating in
   place keeps the id, so retaking updates what the representative sees instead of
   orphaning it. */
export async function assessmentSave(
    accountId: number,
    answers: Answers,
    personId: string | null = null
): Promise<Row | null> {
    const profile = await buildProfile(answers, personId);
    const recommended = recommendations(profile, answers);

    await q(
        `INSERT INTO assessments (account_id, answers, profile, recommended)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE
            SET answers      = EXCLUDED.answers,
                profile      = EXCLUDED.profile,
                recommended  = EXCLUDED.recommended,
                completed_at = now()`,
        [
            accountId,
            JSON.stringify(answers),
            JSON.stringify(profile),
            JSON.stringify(recommended)
        ]
    );

    return assessmentForAccount(accountId);
}

/* One stored assessment, shaped for the browser.

   withAnswers is off by default. A customer looking at their own profile wants
   the conclusions; a representative opening a request wants to see what was
   actually said, question by question. Same row, two audiences, one function. */
export function assessmentJson(
    row: Row | null,
    withAnswers = false
): Record<string, unknown> | null {
    if (!row) { return null; }

    /* JSONB comes back already parsed. The string branch is for safety. */
    const parse = (value: unknown): unknown => {
        if (typeof value === 'string') {
            try { return JSON.parse(value); } catch { return null; }
        }
        return value ?? null;
    };

    const answers = (parse(row.answers) ?? {}) as Answers;
    const profile = (parse(row.profile) ?? {}) as Record<string, unknown>;
    const recommended = (parse(row.recommended) ?? []) as unknown[];

    const out: Record<string, unknown> = {
        id: Number(row.id),
        profile,
        recommended: Array.isArray(recommended) ? recommended : [],
        completedAt: toIso(row.completed_at)
    };

    if (withAnswers) {
        out.answers = answers;
        out.answerLines = answerLines(answers);
    }

    return out;
}

/* The answers as readable pairs, in the order they were asked. This is the part
   that means a representative does not start from zero.

   Built from the question definitions at read time, so the wording shown is
   always the current wording, and a stored value we no longer offer still
   displays as itself rather than disappearing. */
export function answerLines(answers: Answers): Array<{ question: string; answer: string }> {
    const lines: Array<{ question: string; answer: string }> = [];

    for (const question of QUESTIONS) {
        const given = answers[question.id];
        if (given === undefined || given === null) { continue; }

        const text = Array.isArray(given)
            ? given.map(value => optionLabel(question.id, value)).join(', ')
            : optionLabel(question.id, given);

        if (text === '') { continue; }

        lines.push({ question: question.title, answer: text });
    }

    return lines;
}
