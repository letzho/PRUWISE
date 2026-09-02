/* =============================================================================
   copilot.ts - the one place that knows how to read a conversation
   -----------------------------------------------------------------------------
   Ported from php/lib/copilot.php.

   Two things use it, and they must not disagree:

     /api/call-copilot   during the call - "she just said she is pregnant, here is
                         what to do about it"
     /api/call-summary   after the call  - "here is what you discussed and what you
                         agreed"

   A summary that missed a trigger the live card had already flagged would be worse
   than no summary, because the representative has stopped watching by then and is
   trusting the write-up. Same rules, both ends.

   =============================================================================
   WHY THIS IS A RULES ENGINE AND NOT A LANGUAGE MODEL CALL
   =============================================================================

   It would be one HTTP request to ask a model "what should this adviser do?" and
   the answer would read beautifully. Four reasons it works this way instead:

     1. THE LIVE CARD HAS TO APPEAR IN UNDER A SECOND. It is only useful while the
        sentence is still hanging in the air. A round trip to a model is often two
        or three seconds - by which point the conversation has moved on and the
        card is an interruption.

     2. IT HAS TO WORK WITH NO API KEY. There is none configured on this
        deployment, and a demo feature that silently does nothing is worse than no
        feature at all.

     3. A MODEL WILL INVENT PRODUCTS. Asked to recommend, it cheerfully suggests
        plans that are not in this catalogue, and a card naming a policy the
        representative cannot find is actively harmful. Every product id below is
        really in PRODUCTS in _lib/assessment.ts.

     4. A SUMMARY MUST NOT INVENT AGREEMENTS. This is the serious one. A model
        asked to summarise a sales call will confidently write "the customer agreed
        to proceed" because that is what such summaries usually say. That sentence,
        sent to the customer and logged as a record, is a compliance problem.
        Everything below can only report phrases that were actually said.

   WHEN A KEY IS CONFIGURED it should be used to make a real finding READ BETTER,
   never to decide whether there is a finding. That ordering is the whole safety
   argument, and it is why there is no model call in this file.
   ============================================================================= */

import { PRODUCTS } from './assessment.js';

export interface CopilotProduct {
    productId: string;
    name: string;
    category: string;
}

export interface CopilotRule {
    id: string;
    weight: number;
    phrases: string[];
    detected: string;
    meaning: string;
    action: string;
    products: string[];
    ask: string;
    summary: string;
    next: string;
}

export interface CopilotHit {
    id: string;
    weight: number;
    detected: string;
    meaning: string;
    action: string;
    ask: string;
    summary: string;
    next: string;
    products: CopilotProduct[];
    heard: string;
}


/* =============================================================================
   THE RULES

   Each one is a LIFE EVENT, not a keyword. "Insurance" is a keyword and means
   nothing on its own. "My wife is pregnant" is a life event: there is about to be
   a new dependent, which changes protection need, education funding and probably
   budget all at once.

   The phrases are the ones people actually use, including the indirect ones -
   nobody says "I have acquired a dependent", they say "we're expecting".

   `weight` orders them by how much they change a financial plan. Only the
   strongest two are ever shown live, because a representative mid-sentence can act
   on one thing.
   ============================================================================= */

export const RULES: CopilotRule[] = [
    {
        id: 'new-dependent',
        weight: 100,
        phrases: [
            'pregnant', 'expecting', 'baby', 'newborn', 'having a child',
            'having a kid', 'on the way', 'due in', 'second child', 'first child',
            'adopting', 'twins'
        ],
        detected: 'New dependent on the way',
        meaning: 'Protection need rises immediately, and a new education goal starts today.',
        action: 'Highlight the education savings plan and a term life top-up.',
        products: ['prd-edu', 'prd-active'],
        ask: 'When are they due? That sets the date the education plan should mature.',
        summary: 'A new dependent is on the way, which changes both your protection need ' +
                 'and your education planning.',
        next: 'I will work out your revised protection figure with the extra dependent included.'
    },
    {
        id: 'income-drop',
        weight: 95,
        phrases: [
            'money might get tight', 'money is tight', 'lost my job', 'made redundant',
            'redundant', 'laid off', 'pay cut', 'reduced hours', 'between jobs',
            'struggling to pay', 'cannot afford', "can't afford", 'tighten'
        ],
        detected: 'Income under pressure',
        meaning: 'Affordability is the binding constraint. Anything added now has to be small.',
        action: 'Do not add premium. Check the existing cover is not at risk of lapsing first.',
        products: ['prd-active'],
        ask: 'Would a premium holiday or a reduced sum assured help more than a new plan?',
        summary: 'Affordability is tight at the moment, so anything we look at needs to keep ' +
                 'the monthly cost down.',
        next: 'Check your current premiums are still comfortable before we consider anything new.'
    },
    {
        id: 'health-event',
        weight: 94,
        phrases: [
            'diagnosed', 'cancer', 'heart attack', 'stroke', 'tumour', 'tumor',
            'in hospital', 'hospitalised', 'hospitalized', 'surgery', 'chemo',
            'my father had', 'my mother had', 'runs in the family', 'family history'
        ],
        detected: 'Health event or family history',
        meaning: 'Underwriting is affected, and critical illness cover becomes the priority.',
        action: 'Check what is already in force BEFORE suggesting anything new.',
        products: ['prd-ci', 'prd-shield'],
        ask: 'Was this before or after the current policy started? It changes what is covered.',
        summary: 'A health matter and family history came up, which affects both your cover ' +
                 'and any new application.',
        next: 'I will review what your existing policies cover for this.'
    },
    {
        id: 'self-employed',
        weight: 88,
        phrases: [
            'starting a business', 'started a business', 'self employed', 'self-employed',
            'freelance', 'freelancing', 'my own company', 'gig', 'no sick pay',
            'work for myself', 'own boss'
        ],
        detected: 'Self-employed income',
        meaning: 'No employer sick pay and no group cover behind them.',
        action: 'Disability income is the gap. Own-occupation wording matters here.',
        products: ['prd-income', 'prd-shield'],
        ask: 'If you could not work for six months, what would the household run on?',
        summary: 'Working for yourself means there is no employer sick pay or group cover ' +
                 'behind you.',
        next: 'Look at a disability income plan judged on your own occupation.'
    },
    {
        id: 'property',
        weight: 85,
        phrases: [
            'buying a house', 'buying a home', 'buying a flat', 'mortgage', 'home loan',
            'bto', 'resale flat', 'down payment', 'downpayment', 'new place',
            'moving house', 'renovation'
        ],
        detected: 'Taking on a mortgage',
        meaning: 'A debt that outlives them, and money that is needed soon rather than invested.',
        action: 'Term cover matched to the loan. Keep the deposit out of anything market-linked.',

        /* BOTH HALVES OF THE ANSWER. This rule used to offer term life only,
           which addressed the debt and ignored the deposit - and the deposit is
           usually the thing the client is actually worrying about. The
           guaranteed savings plan is what the second half of the action line
           has always been telling the representative to do. */
        products: ['prd-active', 'prd-save'],
        ask: 'What is the loan amount and the tenure? Cover should track it down.',
        summary: 'A property purchase is planned, which brings a debt that would outlive you.',
        next: 'Match term cover to your loan amount and tenure.'
    },
    {
        id: 'retirement-near',
        weight: 82,
        phrases: [
            'retire', 'retiring', 'retirement', 'stop working', 'wind down',
            'part time', 'part-time', 'pension', 'cpf life', 'draw down'
        ],
        detected: 'Retirement in view',
        meaning: 'The question changes from growing the pot to turning it into income.',
        action: 'Move the conversation to guaranteed income, and confirm the target age.',
        products: ['prd-retire', 'prd-legacy'],
        ask: "What monthly income would you want, in today's money?",
        summary: 'Retirement planning, including when you would like to stop working.',
        next: 'Agree your target retirement age and the monthly income it needs to produce.'
    },
    {
        id: 'marriage',
        weight: 78,
        phrases: [
            'getting married', 'engaged', 'wedding', 'my fiance', 'my fiancee',
            'we just got married', 'tying the knot'
        ],
        detected: 'Marriage',
        meaning: 'A second person now depends on this income, and beneficiaries are out of date.',
        action: 'Review the nomination first - it is free and it is usually wrong.',
        products: ['prd-active'],
        ask: 'Who is currently nominated on your existing policies?',
        summary: 'Marriage means someone else now depends on your income, and your nominations ' +
                 'need checking.',
        next: 'Update the beneficiary nomination on your existing policies.'
    },
    {
        id: 'education-cost',
        weight: 76,
        phrases: [
            'university', 'uni fees', 'school fees', 'tuition', 'college',
            'overseas study', 'studying abroad', 'poly', 'jc'
        ],
        detected: 'Education costs ahead',
        meaning: 'A known amount on a known date, which is the wrong shape for market exposure.',
        action: 'Goal-dated endowment, with a premium waiver on the paying parent.',
        products: ['prd-edu', 'prd-save'],
        ask: 'Which year would the first fee be due?',
        summary: 'Education costs are coming, with a known amount needed on a known date.',
        next: 'Fix the year the first fee falls due, and size the plan to it.'
    },
    {
        id: 'windfall',
        weight: 70,
        phrases: [
            'promotion', 'pay rise', 'payrise', 'raise', 'bonus', 'inheritance',
            'inherited', 'sold my', 'came into some money', 'lump sum'
        ],
        detected: 'Income or capital increase',
        meaning: 'Cover set at an old income is now a bigger shortfall than it looks.',
        action: 'Re-run the protection need at the new figure before discussing investment.',
        products: ['prd-active', 'prd-growth', 'prd-save'],
        ask: 'What is the new annual figure? The old cover was sized for the old one.',
        summary: 'Your income has increased, so your existing cover is sized for an older figure.',
        next: 'I will re-run the protection calculation at your new income.'
    },
    {
        /* THE CO-PILOT WAS DEAF TO SOMEBODY SAYING THEY WANT TO SAVE.

           Every rule above fires on a risk - a diagnosis, a redundancy, a debt.
           None of them fired when a client said the most ordinary thing a client
           says, which is that they are trying to put money aside. The
           representative got no card at the one moment the savings range is the
           answer.

           Weight 72, below 'property' at 85, so it cannot displace a life event
           that changes the plan more. */
        id: 'savings-goal',
        weight: 72,
        phrases: [
            'want to save', 'trying to save', 'saving up', 'save up',
            'put money aside', 'putting money aside', 'set money aside',
            'nest egg', 'rainy day', 'grow my savings', 'somewhere better than the bank',
            'fixed deposit', 'earning nothing in the bank', 'sitting in the bank'
        ],
        detected: 'They want to save, not to insure',
        meaning: 'The question is where money should sit, not what could go wrong.',
        action: 'Ask what the money is FOR and when it is needed. That decides ' +
                'guaranteed against participating - not their risk score.',
        products: ['prd-save', 'prd-flexi'],
        ask: 'What is the money for, and roughly when would you need it?',
        summary: 'You want to put money aside, so we looked at savings plans rather ' +
                 'than protection.',
        next: 'I will price a guaranteed plan and a regular savings plan against ' +
              'the date you need the money.'
    },
    {
        id: 'confusion',
        weight: 60,
        phrases: [
            "i don't understand", 'i dont understand', 'do not understand', 'confusing',
            'confused', 'what does that mean', 'too complicated', 'lost me', 'jargon',
            'not sure what', 'no idea what'
        ],
        detected: 'They are lost',
        meaning: 'Nothing agreed from here will be understood, and it will be regretted later.',
        action: 'Stop. Re-explain the last point without a single product name in it.',
        products: [],
        ask: 'Which part would be most useful to go over again?',
        summary: 'Some of my explanation was not clear, and is worth going over again.',
        next: 'I will send a plainer write-up of the part that was unclear.'
    },
    {
        id: 'price-objection',
        weight: 58,
        phrases: [
            'too expensive', 'how much does it cost', 'what is the premium',
            'cheaper option', 'monthly cost', 'can i pay less', 'out of my budget'
        ],
        detected: 'Cost is the concern',
        meaning: 'They are engaged but the number is the obstacle.',
        action: 'Show the same cover at a shorter term rather than dropping the amount.',
        products: ['prd-active'],
        ask: 'What monthly figure would feel comfortable to you?',
        summary: 'Cost is the main concern, so I will show options at different premium levels.',
        next: 'I will price the same cover over two or three different terms.'
    }
];


/* Product ids turned into names a representative can actually look up. Reuses the
   catalogue the assessment scores against, so nothing here can ever name a product
   that does not exist. */
export function copilotProducts(ids: string[]): CopilotProduct[] {
    const out: CopilotProduct[] = [];

    for (const id of ids) {
        const meta = PRODUCTS[id];
        if (meta) {
            out.push({ productId: id, name: meta.name, category: meta.category });
        }
    }
    return out;
}


/* Scan text. Returns at most `limit` cards, strongest first.

   CASE-INSENSITIVE SUBSTRING MATCHING, NOT A WORD-BOUNDARY REGEX, deliberately.
   Speech recognition produces "expecting" inside "we're expecting", and it also
   produces run-together fragments a boundary check would miss. A false positive
   costs a card the representative ignores; a missed one costs the moment. */
export function copilotDetect(text: string, limit = 2): CopilotHit[] {
    const haystack = text.toLowerCase();
    const hits: CopilotHit[] = [];

    for (const rule of RULES) {
        for (const phrase of rule.phrases) {
            if (!haystack.includes(phrase)) { continue; }

            hits.push({
                id: rule.id,
                weight: rule.weight,
                detected: rule.detected,
                meaning: rule.meaning,
                action: rule.action,
                ask: rule.ask,
                summary: rule.summary,
                next: rule.next,
                products: copilotProducts(rule.products),

                /* The words that fired it, so the representative can see WHY the
                   card appeared. A card that cannot explain itself gets distrusted
                   the first time it is wrong. */
                heard: phrase
            });

            break;      /* one card per rule, however many phrases matched */
        }
    }

    hits.sort((a, b) => b.weight - a.weight);

    return hits.slice(0, limit);
}


/* =============================================================================
   THE AFTER-CALL SUMMARY
   -----------------------------------------------------------------------------
   Built from the whole transcript rather than one sentence.

   THE RULE THAT SHAPES ALL OF THIS: REPORT, NEVER CONCLUDE.

   It says "critical illness cover was discussed" and never "the customer agreed to
   proceed". The first is a fact about the recording. The second is an assertion
   about somebody's intent, and putting it in a record that gets sent to that
   person - and logged - is how a summary becomes a complaint.

   Everything below traces back to a phrase that was really said.
   ============================================================================= */

export interface TranscriptLine {
    who?: string;
    text?: string;
    mine?: boolean;
}

export interface CallSummary {
    minutes: number;
    lineCount: number;
    discussed: string[];
    nextSteps: string[];
    questions: string[];
    products: CopilotProduct[];
    namedOutLoud: string[];
    triggerIds: string[];
    draft: string;
}

const QUESTION_OPENERS = [
    'what ', 'how ', 'why ', 'when ', 'can i ', 'do i ', 'is it ', 'does it ', 'will i '
];

export function summaryBuild(
    lines: TranscriptLine[],
    customerName: string,
    minutes: number
): CallSummary {
    /* ONLY WHAT WAS SPOKEN. PRUWise's own suggestions are in the transcript too
       (who = 'pruwise'), and they are the assistant talking to one side - not part
       of the conversation the two people had. Summarising our own nudges back to
       the customer would be nonsense. */
    const spoken = lines.filter(line =>
        line.who !== 'pruwise' && typeof line.text === 'string' && line.text.trim() !== '');

    const whole = spoken.map(line => line.text).join(' ');

    /* Every trigger in the whole call, not just the top two. The live cards are
       rationed because attention is; a written summary is read at leisure. */
    const triggers = copilotDetect(whole, 99);

    /* ------------------------------------------------------------------
       WHAT WAS DISCUSSED

       One line per trigger, in the words of the rule rather than the customer's,
       because a quote out of context reads oddly in a summary.
       ------------------------------------------------------------------ */
    const discussed: string[] = [];
    const nextSteps: string[] = [];
    const products = new Map<string, CopilotProduct>();

    for (const trigger of triggers) {
        discussed.push(trigger.summary);
        nextSteps.push(trigger.next);

        /* Keyed by id so a product mentioned by two triggers appears once. */
        for (const product of trigger.products) {
            products.set(product.productId, product);
        }
    }

    /* ------------------------------------------------------------------
       PRODUCTS NAMED OUT LOUD

       Separate from the ones the rules inferred. If somebody actually said
       "PRUShield" then it was genuinely on the table, which is stronger evidence
       than a keyword suggesting it might be relevant.
       ------------------------------------------------------------------ */
    const named: string[] = [];
    const haystack = whole.toLowerCase();

    for (const [id, meta] of Object.entries(PRODUCTS)) {
        /* Match on the distinctive part of the name. "PRUShield Premier + Extra
           Saver" is never said in full out loud, but "shield" is. */
        const key = (meta.name.split(' ')[0] ?? '').replace(/^PRU/, '').toLowerCase();

        if (key !== '' && haystack.includes(key)) {
            named.push(meta.name);
            products.set(id, { productId: id, name: meta.name, category: meta.category });
        }
    }

    /* ------------------------------------------------------------------
       QUESTIONS THE CUSTOMER ASKED

       Anything they said that ends in a question mark, or opens with a question
       word. These are the most useful thing in a summary and the easiest to forget:
       an unanswered question from a customer is the thing that loses them, and it
       is invisible in a transcript nobody re-reads.
       ------------------------------------------------------------------ */
    const questions: string[] = [];

    for (const line of spoken) {
        if (line.mine) { continue; }        /* the representative's own words */

        const text = String(line.text).trim();
        const lower = text.toLowerCase();

        const isQuestion = text.endsWith('?')
            || QUESTION_OPENERS.some(opener => lower.startsWith(opener));

        if (isQuestion && text.length > 8 && !questions.includes(text)) {
            questions.push(text);
        }
    }

    /* Three at most. A summary is not a transcript. */
    const topQuestions = questions.slice(0, 3);

    return {
        minutes: Math.trunc(minutes),
        lineCount: spoken.length,
        discussed,
        nextSteps,
        questions: topQuestions,
        products: [...products.values()],
        namedOutLoud: named,
        triggerIds: triggers.map(trigger => trigger.id),

        /* The message the representative will actually send, already worded.
           Editable before it goes - see /api/call-summary. */
        draft: summaryDraft(customerName, discussed, nextSteps, topQuestions, minutes)
    };
}

/* The draft message, in the representative's voice.

   Written to be SENT, not to be filed. That is why it opens with a name and closes
   with an offer rather than a heading and a table - it lands in a chat thread the
   customer already uses, next to ordinary messages.

   IT DELIBERATELY CONTAINS NO FIGURES. Any number in here would be one somebody
   half-remembered from a conversation, and a wrong premium in writing is worse than
   no premium at all. */
export function summaryDraft(
    customerName: string,
    discussed: string[],
    nextSteps: string[],
    questions: string[],
    minutes: number
): string {
    const first = String(customerName ?? '').trim().split(/\s+/)[0] || 'there';

    const parts: string[] = [];

    parts.push(`Hi ${first}, thanks for your time just now` +
        (minutes > 0 ? ` - here is a summary of our ${minutes}-minute call.` : '.'));

    if (discussed.length > 0) {
        parts.push('', 'What we covered:');
        discussed.forEach((line, index) => parts.push(`${index + 1}. ${line}`));
    }

    if (questions.length > 0) {
        parts.push('', 'You asked:');
        for (const question of questions) { parts.push(`- ${question}`); }
    }

    if (nextSteps.length > 0) {
        parts.push('', 'Next steps:');

        /* De-duplicated, because two triggers can produce the same next step and a
           list that repeats itself looks automated. */
        for (const step of [...new Set(nextSteps)]) { parts.push(`- ${step}`); }
    }

    if (discussed.length === 0 && questions.length === 0) {
        parts.push('',
            'We did not get into detail this time. Happy to pick it up whenever suits you.');
    }

    parts.push('', 'If I have missed anything or got something wrong, tell me and I will correct it.');

    return parts.join('\n');
}
