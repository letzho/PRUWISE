/* =============================================================================
   insights.ts - what the assistant noticed in a conversation
   -----------------------------------------------------------------------------
   Reads a chat thread, a call transcript or an in-person meeting transcript and
   returns five kinds of finding:

     detail    a personal or financial detail that appears to have changed
     support   a sign this person may need more help than usual
     followup  a commitment or loose end
     meeting   they want to book something
     keypoint  a line worth keeping as the record of the conversation

   =============================================================================
   THE RULES FIND IT. THE MODEL ONLY EXPLAINS IT.
   =============================================================================

   Every finding below is produced by a regular expression or a keyword test over
   what was actually said, and carries the QUOTE that produced it. The model is
   then given those findings and asked to write the one-line note a human reads.

   That split is not stylistic, it is the only arrangement that is safe here:

     A MODEL ASKED "did anything change?" WILL SOMETIMES SAY YES. Over a long
     transcript of small talk it will find a salary that was never mentioned,
     because that is the shape of answer the question invites. A regex over
     "my salary is now ninety five thousand" cannot hallucinate a number that is
     not in the text.

     AND THE QUOTE HAS TO BE REAL. A representative confirms a change by reading
     the words that caused it. If the model wrote the quote it could paraphrase,
     and a paraphrase is not evidence.

   So: numbers, dates and life events come from the text. Wording comes from the
   model, or from a fixed sentence when there is no model.

   =============================================================================
   NOTHING IS APPLIED HERE
   =============================================================================

   This file returns proposals. Writing them to customer_finances or people
   happens only after a representative confirms - see api/_routes/insights.ts.
   Speech recognition mishears numbers constantly, and a figure silently rewritten
   from a mishearing would flow into the needs calculation and every
   recommendation drawn from it.
   ============================================================================= */

import { createHash } from 'node:crypto';
import { chatComplete, takeAllowance, tidyModelText } from './openai.js';

export type InsightKind = 'detail' | 'support' | 'followup' | 'meeting' | 'keypoint';

export interface Finding {
    kind: InsightKind;

    /* WHICH RULE FIRED. Part of the fingerprint, and it has to be, because the
       note is not stable: polish() rewrites it with a model, so the same
       observation comes back worded differently every time a growing transcript
       is re-read. Hashing the note meant one mention of a money worry became a
       new row on every pass - which is the exact pile-up the fingerprint exists
       to prevent. A rule id is the same on every pass, by construction. */
    ruleId: string;

    /* Only for a 'detail'. */
    field?: string;
    newValue?: string;

    /* The one-line note a human reads. Replaced by the model when one is
       available; never empty, because the rules always write one first. */
    note: string;

    /* The words that caused this, trimmed to something readable. */
    quote: string;
}

/* How much of a conversation is looked at. Long enough to catch something said a
   few minutes ago, short enough that re-analysis is cheap - this runs repeatedly
   as a call grows. */
const MAX_CHARS = 6000;


/* =============================================================================
   MONEY AND NUMBERS SPOKEN OUT LOUD

   Speech recognition writes numbers as words about half the time, so
   "ninety five thousand" has to be understood as well as "95,000". This is the
   part most likely to be subtly wrong, which is exactly why nothing it produces
   is applied without a human reading the quote.
   ============================================================================= */

const SMALL: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90
};

const SCALE: Record<string, number> = {
    hundred: 100, thousand: 1000, k: 1000, grand: 1000,
    million: 1000000, m: 1000000
};

/* "ninety five thousand" -> 95000. Returns null when the words do not add up to
   anything, which is the common case and must be cheap. */
export function wordsToNumber(text: string): number | null {
    const words = text.toLowerCase().replace(/[^a-z\s-]/g, ' ')
        .split(/[\s-]+/).filter(Boolean);

    let total = 0;
    let current = 0;
    let seen = false;

    for (const word of words) {
        if (word in SMALL) {
            current += SMALL[word] as number;
            seen = true;
            continue;
        }

        if (word in SCALE) {
            const scale = SCALE[word] as number;

            /* "a hundred" with no leading number means one of them. */
            if (current === 0) { current = 1; }

            if (scale === 100) {
                current *= 100;
            } else {
                total += current * scale;
                current = 0;
            }
            seen = true;
            continue;
        }

        /* Any other word breaks the run - "ninety five apples thousand" is not a
           number. Whatever was accumulated is kept. */
        if (seen && (total + current) > 0) { break; }
    }

    const value = total + current;
    return seen && value > 0 ? value : null;
}

/* A figure written either way, from one sentence. Digits win when both appear. */
function amountIn(sentence: string): number | null {
    const digits = /(?:S?\$\s?)?(\d{1,3}(?:,\d{3})+|\d{4,9})(?:\s*(k|m|thousand|million))?/i
        .exec(sentence);

    if (digits) {
        let value = Number((digits[1] ?? '').replace(/,/g, ''));
        const scale = (digits[2] ?? '').toLowerCase();

        if (scale === 'k' || scale === 'thousand') { value *= 1000; }
        if (scale === 'm' || scale === 'million') { value *= 1000000; }

        if (Number.isFinite(value) && value > 0) { return value; }
    }

    return wordsToNumber(sentence);
}


/* =============================================================================
   WHEN DID THEY MEAN

   "Could we book a meeting next Tuesday" is only useful if something can be put in
   a diary, and putting it in a diary needs a moment in time.

   =============================================================================
   RULES, FOR THE SAME REASON AS EVERYTHING ELSE IN THIS FILE
   =============================================================================

   A model asked "what date did they mean" over a transcript will answer with a
   date whether or not one was mentioned - that is the shape of answer the question
   invites, and a confidently wrong Thursday put into two people's calendars is
   worse than no suggestion at all. A regex cannot invent a Tuesday that is not in
   the text.

   =============================================================================
   SINGAPORE TIME, COMPUTED FROM UTC, WITHOUT A LIBRARY
   =============================================================================

   This runs on a server whose clock is UTC. "Next Tuesday at 3pm" means 3pm on the
   Singapore clock, and the difference matters at both ends of the day: at 23:00 UTC
   it is already tomorrow in Singapore, so "tomorrow" computed from the server's
   date would be a day early.

   Singapore has had no daylight saving since 1935 and sits permanently at +08:00,
   so the whole conversion is one addition. The same reasoning, and the same
   constant, as FMT.TZ_OFFSET in js/data.js - and it is only safe BECAUSE the offset
   is fixed. Do this for Europe/London and you are wrong for half the year.
   ============================================================================= */

const SG_OFFSET_MS = 8 * 3600_000;

/* A default hour, for "can we meet on Thursday" with no time attached.

   10am rather than 9: 9am is the start of a working day and the likeliest hour to
   already be full, and this is a SUGGESTION somebody confirms - it should land
   somewhere plausible, not somewhere clever. */
const DEFAULT_HOUR = 10;

const WEEKDAYS: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6
};

/* The Singapore wall-clock parts of an instant. Add the offset, then read the UTC
   getters - which is what turns "what time is it there" into arithmetic. */
function sgClock(at: Date): { y: number; m: number; d: number; hour: number; weekday: number } {
    const shifted = new Date(at.getTime() + SG_OFFSET_MS);

    return {
        y: shifted.getUTCFullYear(),
        m: shifted.getUTCMonth(),
        d: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        weekday: shifted.getUTCDay()
    };
}

/* A Singapore wall-clock date and time -> the instant it refers to. */
function sgInstant(y: number, m: number, d: number, hour: number, minute: number): Date {
    return new Date(Date.UTC(y, m, d, hour, minute) - SG_OFFSET_MS);
}

/* The time of day, if one was said. Handles '3pm', '3.30pm', '15:00', 'at 3'. */
function timeIn(sentence: string): { hour: number; minute: number } | null {
    /* am/pm first, because it is unambiguous. '3pm' and '10.30 am' both land here. */
    const meridiem = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/.exec(sentence);

    if (meridiem) {
        let hour = Number(meridiem[1]);
        const minute = Number(meridiem[2] ?? 0);

        if (hour >= 1 && hour <= 12) {
            if (meridiem[3] === 'pm' && hour !== 12) { hour += 12; }
            if (meridiem[3] === 'am' && hour === 12) { hour = 0; }

            return { hour, minute: minute < 60 ? minute : 0 };
        }
    }

    /* A 24-hour clock, which speech recognition writes for '15:00'. */
    const clock = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(sentence);

    if (clock) {
        return { hour: Number(clock[1]), minute: Number(clock[2]) };
    }

    /* 'at 3' with nothing after it. Read as an AFTERNOON hour for 1 to 6, because
       nobody proposing a meeting means three in the morning - and 9 to 11 stay
       morning for the same reason. Anything outside those is left alone rather than
       guessed at. */
    const bare = /\bat\s+(\d{1,2})\b(?!\s*[:.]?\d)/.exec(sentence);

    if (bare) {
        const hour = Number(bare[1]);

        if (hour >= 1 && hour <= 6) { return { hour: hour + 12, minute: 0 }; }
        if (hour >= 9 && hour <= 11) { return { hour, minute: 0 }; }
        if (hour === 12) { return { hour: 12, minute: 0 }; }
    }

    return null;
}

/* When they seem to have meant, as an ISO instant, or null.

   `now` is a parameter rather than read from the clock so this is testable and so
   two findings in one pass cannot land on different sides of midnight. */
export function whenFrom(sentence: string, now: Date = new Date()): string | null {
    const text = sentence.toLowerCase();
    const clock = sgClock(now);
    const time = timeIn(text);

    /* ---------------------------------------------------------------- tomorrow */
    if (/\btomorrow\b/.test(text)) {
        return sgInstant(clock.y, clock.m, clock.d + 1,
            time ? time.hour : DEFAULT_HOUR, time ? time.minute : 0).toISOString();
    }

    /* ------------------------------------------------------------- a named day */
    const day = /\b(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/
        .exec(text);

    if (day) {
        const wanted = WEEKDAYS[day[1] as string] as number;

        /* Days ahead of today. 0 would be today, and somebody saying "shall we meet
           on Thursday" ON Thursday means next Thursday - so today counts as seven. */
        let ahead = (wanted - clock.weekday + 7) % 7;
        if (ahead === 0) { ahead = 7; }

        /* "NEXT Tuesday" is a real ambiguity in English and always has been: for
           some people it means the Tuesday of next week even when this Tuesday has
           not happened yet. It is left as the SOONER reading deliberately - a
           suggestion that is a week early gets corrected in one click, whereas one
           that is a week late has already been missed by the time anybody notices.
           And "this Tuesday" means the same thing, so both words fall through
           here. */
        return sgInstant(clock.y, clock.m, clock.d + ahead,
            time ? time.hour : DEFAULT_HOUR, time ? time.minute : 0).toISOString();
    }

    /* --------------------------------------------------------- next week, vaguely

       No day named. Monday of next week at the default hour, because "next week"
       with nothing else is a request to be pencilled in rather than a time. */
    if (/\bnext week\b/.test(text)) {
        const toMonday = ((1 - clock.weekday + 7) % 7) || 7;

        return sgInstant(clock.y, clock.m, clock.d + toMonday,
            time ? time.hour : DEFAULT_HOUR, time ? time.minute : 0).toISOString();
    }

    /* ------------------------------------------------------------ only a time

       "Can we speak at 3" with no day. TOMORROW, not today: by the time a
       transcript has been read the hour may already have passed, and proposing a
       time in the past would be refused by the appointment endpoint - correctly,
       and confusingly. */
    if (time) {
        return sgInstant(clock.y, clock.m, clock.d + 1, time.hour, time.minute).toISOString();
    }

    /* "Shall we book something" with nothing to go on. Deliberately null: an
       invented date is the failure this whole file is arranged to avoid, and the
       interface can still offer the calendar. */
    return null;
}


/* =============================================================================
   THE RULES
   ============================================================================= */

interface Rule {
    /* Stable, and never changed once shipped - it is hashed into the fingerprint
       of every row this rule has ever produced. Renaming one would orphan the
       existing rows and start the pile-up again from zero. */
    id: string;

    kind: InsightKind;
    field?: string;

    /* Words that have to be present for the rule to even look. Cheap first pass. */
    any: string[];

    /* And the shape that confirms it. */
    test: (sentence: string) => boolean;

    /* What to record. Returns null to decline after a closer look. */
    build: (sentence: string) => { note: string; newValue?: string } | null;
}

const money = (n: number) =>
    new Intl.NumberFormat('en-SG', {
        style: 'currency', currency: 'SGD', maximumFractionDigits: 0
    }).format(n);


/* =============================================================================
   DOES THIS SENTENCE MENTION THIS PHRASE - AS A WHOLE WORD

   =============================================================================
   THIS WAS A REAL FALSE POSITIVE, NOT A TIDY-UP
   =============================================================================

   The keyword lists were tested with `includes()`, which is a substring test. The
   health rule lists 'ill', and 'ill' is inside "will". So

       "I will send you the figures this week"

   raised A HEALTH SUPPORT SIGNAL on a client - "Health has come up, may affect
   what they can be underwritten for" - because of the word "will". That is
   exactly the kind of invented finding the whole rules-not-model design exists to
   rule out, arriving through the rules instead.

   Others waiting to happen: 'debt' in "indebted", 'died' in "studied", 'claim'
   in "reclaimed', 'book' in "bookkeeping'.

   So a phrase has to sit on word boundaries. The lists were already written with
   both 'earn' and 'earning', both 'policy' and 'policies', which says the author
   assumed whole words all along.

   The expressions are built once and cached: this runs for every rule against
   every sentence of every transcript, and compiling thirteen lists of patterns
   per sentence would be the slowest part of the request.
   ============================================================================= */

const patterns = new Map<string, RegExp>();

function mentions(lower: string, phrase: string): boolean {
    let re = patterns.get(phrase);

    if (re === undefined) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        /* Not \b: a phrase can start or end with an apostrophe or a slash, where
           \b does not mean what it looks like it means. "not a letter or digit,
           or the end of the string" is the test that is actually wanted. */
        re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
        patterns.set(phrase, re);
    }

    return re.test(lower);
}


const RULES: Rule[] = [
    /* ---------------------------------------------------- details that changed */
    {
        id: 'income',
        kind: 'detail', field: 'annual_income',
        any: ['salary', 'income', 'earn', 'earning', 'pay rise', 'raise', 'promoted', 'promotion'],
        test: (s) => /\b(now|new|just|increased|raised|going up|went up|changed to|up to)\b/.test(s),
        build: (s) => {
            const value = amountIn(s);
            if (value === null || value < 6000) { return null; }

            /* A monthly figure said as monthly, annualised - people describe income
               both ways and the record stores one of them. */
            const monthly = /\b(a month|per month|monthly|\/mo)\b/.test(s);
            const annual = monthly ? value * 12 : value;

            if (annual < 6000 || annual > 20000000) { return null; }

            return {
                note: `Income may have changed to ${money(annual)} a year`,
                newValue: String(Math.round(annual))
            };
        }
    },
    {
        id: 'dependant',
        kind: 'detail', field: 'dependants',
        any: ['baby', 'born', 'expecting', 'pregnant', 'newborn', 'child', 'daughter', 'son'],
        test: (s) => /\b(had|having|expecting|just had|new|born|arrived|on the way)\b/.test(s),
        build: () => ({ note: 'A new dependant may need adding to the record' })
    },
    {
        id: 'marital',
        kind: 'detail', field: 'marital_status',
        any: ['married', 'engaged', 'divorced', 'separated', 'widowed', 'wedding'],
        test: (s) => /\b(got|getting|just|now|recently|am)\b/.test(s),
        build: (s) => {
            const found = ['married', 'engaged', 'divorced', 'separated', 'widowed']
                .find((w) => s.includes(w));

            return found
                ? { note: `Marital status may now be ${found}`, newValue: found }
                : null;
        }
    },
    {
        id: 'employer',
        kind: 'detail', field: 'employer',
        any: ['new job', 'changed job', 'changing job', 'new employer', 'started at',
            'moved to', 'made redundant', 'redundant', 'left my job', 'resigned'],
        test: () => true,
        build: () => ({ note: 'Employment appears to have changed' })
    },
    {
        id: 'expenses',
        kind: 'detail', field: 'monthly_expenses',
        any: ['mortgage', 'rent', 'expenses', 'outgoings', 'instalment'],
        test: (s) => /\b(now|new|increased|went up|paying|changed)\b/.test(s),
        build: (s) => {
            const value = amountIn(s);
            if (value === null || value < 100 || value > 200000) { return null; }

            return {
                note: `Monthly commitments may now be around ${money(value)}`,
                newValue: String(Math.round(value))
            };
        }
    },

    /* ------------------------------------------------------- support signals

       THESE GO TO THE REPRESENTATIVE ONLY. The whole point is a quiet heads-up so
       a human can decide whether to raise it gently, or not at all. Every note is
       phrased as a possibility, never as a diagnosis - "may be under financial
       pressure", not "is struggling". */
    {
        id: 'pressure',
        kind: 'support',
        any: ['cannot afford', "can't afford", 'too expensive', 'tight', 'struggling',
            'lost my job', 'redundant', 'pay cut', 'behind on', 'debt', 'worried about money'],
        test: () => true,
        build: () => ({
            note: 'May be under financial pressure - worth being careful about cost ' +
                'before suggesting anything'
        })
    },
    {
        id: 'bereavement',
        kind: 'support',
        any: ['passed away', 'passed on', 'funeral', 'bereaved', 'lost my', 'died'],
        test: () => true,
        build: () => ({
            note: 'A bereavement may have been mentioned - worth acknowledging before ' +
                'anything else'
        })
    },
    {
        id: 'health',
        kind: 'support',
        /* 'ill' is the word that caused the false positive described above
           ("I will send you the figures"). It stays in the list, because somebody
           saying "I have been ill" is exactly what this rule is for - it is the
           matcher that changed, not the vocabulary. */
        any: ['diagnosed', 'cancer', 'surgery', 'hospital', 'chemo', 'treatment',
            'unwell', 'ill', 'illness'],
        test: () => true,
        build: () => ({
            note: 'Health has come up - may affect both what they need and what they ' +
                'can be underwritten for'
        })
    },
    {
        id: 'confusion',
        kind: 'support',
        any: ['confused', "don't understand", 'do not understand', 'no idea',
            'lost me', 'too complicated', 'jargon', 'what does that mean'],
        test: () => true,
        build: () => ({
            note: 'Signs of confusion - worth slowing down and checking understanding'
        })
    },
    {
        id: 'discomfort',
        kind: 'support',
        any: ['not sure about this', 'uncomfortable', 'pressured', 'pushy',
            'need to think', 'hesitant', 'rushed'],
        test: () => true,
        build: () => ({
            note: 'May be uncomfortable or feeling rushed - giving them room is ' +
                'likely to help more than more detail'
        })
    },

    /* --------------------------------------------------------------- follow-ups */
    {
        id: 'promise',
        kind: 'followup',
        any: ['i will send', "i'll send", 'i will check', "i'll check",
            'i will get back', "i'll get back", 'let me find out', 'i will confirm',
            "i'll confirm", 'send you', 'email you'],
        test: () => true,
        build: () => ({ note: 'Something was promised and should be followed up' })
    },
    {
        id: 'claim',
        kind: 'followup',
        any: ['claim', 'claiming', 'make a claim'],
        test: () => true,
        build: () => ({ note: 'A claim was mentioned - check whether one needs starting' })
    },

    /* ------------------------------------------------------------ meeting wanted */
    {
        id: 'meeting',
        kind: 'meeting',
        any: ['book', 'schedule', 'meet', 'meeting', 'appointment', 'catch up',
            'call next', 'see you', 'free on', 'available on'],
        test: (s) => /\b(can we|could we|shall we|let us|lets|let\u2019s|would like to|want to|how about|are you free|when are you)\b/.test(s)
            || /\b(next|this)\s+(week|month|monday|tuesday|wednesday|thursday|friday)\b/.test(s),

        /* newValue CARRIES THE PROPOSED START, as an ISO instant, when one can be
           read out of what was said.

           Reusing newValue for a kind that is not a 'detail' is a small overload
           and it is worth being explicit about: for a detail it means "what the
           record should say", and here it means "the moment they seem to have
           meant". Nothing writes it to a record - APPLY in _routes/insights.ts is
           an allow-list of two finance columns and this kind is not a detail, so
           there is no path from here into anybody's data. What it does is let the
           interface offer a real time to book rather than a link to the calendar.

           null when no day or time was mentioned. Better an offer to open the
           calendar than an invented Thursday. */
        build: (s) => {
            const when = whenFrom(s);

            return when === null
                ? { note: 'They seem to want a meeting booked' }
                : { note: 'They seem to want a meeting booked', newValue: when };
        }
    }
];


/* =============================================================================
   SPLITTING WHAT WAS SAID

   Sentences, but speech has almost no punctuation, so a long unpunctuated run is
   also broken on length. Without that a five-minute monologue is one "sentence"
   and every rule matches it at once.
   ============================================================================= */

function sentences(text: string): string[] {
    const out: string[] = [];

    for (const chunk of text.slice(-MAX_CHARS).split(/(?<=[.!?])\s+|\n+/)) {
        const clean = chunk.trim();
        if (clean.length < 4) { continue; }

        if (clean.length <= 240) { out.push(clean); continue; }

        /* Too long to be one thought. Break on filler words speech uses where
           punctuation would be. */
        const parts = clean.split(/\s+(?:and then|and so|but|because|so then|okay so)\s+/i);

        for (const part of parts) {
            const p = part.trim();
            if (p.length >= 4) { out.push(p.slice(0, 240)); }
        }
    }

    return out;
}


/* =============================================================================
   THE PASS
   ============================================================================= */

export function findByRules(text: string): Finding[] {
    const found: Finding[] = [];
    const seen = new Set<string>();

    for (const sentence of sentences(text)) {
        const lower = sentence.toLowerCase();

        for (const rule of RULES) {
            if (!rule.any.some((phrase) => mentions(lower, phrase))) { continue; }
            if (!rule.test(lower)) { continue; }

            const built = rule.build(lower);
            if (built === null) { continue; }

            /* ONE PER RULE PER PASS. A salary mentioned three times in one call is
               one proposal, not three. Keyed on the rule rather than on its
               wording, so two rules that happen to say something similar stay
               separate and one rule cannot split in two. */
            const key = `${rule.kind}:${rule.field ?? rule.id}`;
            if (seen.has(key)) { continue; }
            seen.add(key);

            found.push({
                ruleId: rule.id,
                kind: rule.kind,
                ...(rule.field ? { field: rule.field } : {}),
                ...(built.newValue ? { newValue: built.newValue } : {}),
                note: built.note,
                quote: sentence.slice(0, 300)
            });
        }
    }

    return found;
}


/* =============================================================================
   IS THIS EVEN WORTH LOOKING AT?

   The relevance gate. A conversation about the weather should produce nothing at
   all, and in particular must not produce a recommendation.

   Two things have to be true: enough was said to be a conversation, and at least
   one sentence touches something this application is about. Otherwise the answer
   is an empty list, cheaply, with no model call.
   ============================================================================= */

const RELEVANT = [
    'cover', 'policy', 'policies', 'premium', 'insurance', 'insured', 'claim',
    'income', 'salary', 'earn', 'mortgage', 'rent', 'savings', 'cpf', 'retire',
    'retirement', 'child', 'children', 'baby', 'dependant', 'dependent',
    'married', 'divorced', 'job', 'work', 'employer', 'redundant', 'ill',
    'illness', 'hospital', 'diagnosed', 'surgery', 'afford', 'budget', 'cost',
    'expensive', 'plan', 'protection', 'shortfall', 'meeting', 'appointment',
    'book', 'schedule', 'review'
];

export function worthAnalysing(text: string): boolean {
    const clean = text.trim();

    /* Under a couple of sentences there is nothing to read. */
    if (clean.length < 40) { return false; }

    const lower = clean.toLowerCase();

    /* Whole words, for the same reason as the rules - see mentions(). A gate that
       opened on "will" because the list contains 'ill' would be no gate. */
    return RELEVANT.some((word) => mentions(lower, word));
}


/* =============================================================================
   THE MODEL PASS - WORDING ONLY

   Given the findings the rules already made, rewrite each note so it reads like a
   colleague wrote it. It is NOT asked to add findings, and anything it returns
   that does not line up with a finding by index is ignored.
   ============================================================================= */

export async function polish(
    accountId: number,
    findings: Finding[],
    firstName: string
): Promise<{ findings: Finding[]; engine: 'openai' | 'rules' }> {
    if (findings.length === 0) { return { findings, engine: 'rules' }; }

    const allowance = await takeAllowance(accountId, 'insight');
    if (!allowance.allowed) { return { findings, engine: 'rules' }; }

    const numbered = findings
        .map((f, index) => `${index + 1}. [${f.kind}] ${f.note}\n   heard: "${f.quote}"`)
        .join('\n');

    const answer = await chatComplete({
        system: [
            `You are helping a licensed financial representative review notes about a`,
            `client called ${firstName}. Each numbered item was found by a keyword rule`,
            `over what was actually said, and the quote is the real wording.`,
            '',
            'Rewrite each item as ONE short sentence a colleague would write. Reply with',
            'the same numbers, one per line, nothing else.',
            '',
            'Hard rules:',
            '- Do NOT add items. Do NOT remove items. Same count, same order.',
            '- Do NOT state anything the quote does not support.',
            '- Do NOT recommend a product, name a plan, or quote a figure that is not',
            '  already in the item.',
            '- For a [support] item, phrase it as a POSSIBILITY the representative may',
            '  want to be aware of, never as a diagnosis or a certainty. It is a',
            '  private heads-up, not a conclusion about somebody.',
            '- For a [detail] item, make clear it needs confirming rather than',
            '  asserting it is now true.',
            '- Plain British English. No emoji, no markdown.'
        ].join('\n'),

        user: numbered,
        maxTokens: 500,
        temperature: 0.3
    });

    if (answer === null) { return { findings, engine: 'rules' }; }

    /* Line up by leading number. Anything that does not parse keeps its rules
       wording, so a partial reply improves what it can and breaks nothing. */
    const lines = tidyModelText(answer).split('\n');
    const rewritten = [...findings];
    let matched = 0;

    for (const line of lines) {
        const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
        if (!m) { continue; }

        const index = Number(m[1]) - 1;
        const text = (m[2] ?? '').trim();

        if (index < 0 || index >= rewritten.length) { continue; }
        if (text.length < 8 || text.length > 300) { continue; }

        /* A rewritten [detail] must not have lost its "needs confirming" framing
           into a flat assertion. Cheap check: it should still read as tentative. */
        const finding = rewritten[index] as Finding;

        if (finding.kind === 'detail'
            && !/\b(may|might|appears|seems|possibly|check|confirm|sounds like)\b/i.test(text)) {
            continue;
        }

        rewritten[index] = { ...finding, note: text };
        matched++;
    }

    return { findings: rewritten, engine: matched > 0 ? 'openai' : 'rules' };
}


/* =============================================================================
   KEY POINTS - the record of what was discussed

   Sentences that carried something, in the order they were said. Rules again, and
   for the same reason: a summary is something both sides may rely on later, so
   every line in it should be traceable to a thing somebody actually said.
   ============================================================================= */

export function keyPoints(text: string, limit = 6): string[] {
    const scored: Array<{ line: string; score: number; at: number }> = [];

    sentences(text).forEach((sentence, index) => {
        const lower = sentence.toLowerCase();
        const score = RELEVANT.reduce((n, w) => n + (mentions(lower, w) ? 1 : 0), 0);

        /* Two topic words before a sentence counts as a point. One is usually an
           aside. */
        if (score >= 2 && sentence.length >= 25) {
            scored.push({ line: sentence, score, at: index });
        }
    });

    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .sort((a, b) => a.at - b.at)
        .map((s) => s.line.slice(0, 220));
}


/* The stable identity of a finding, so re-analysing a growing transcript updates
   one row instead of adding another. See the note above ai_insights.fingerprint
   in db/schema.sql.

   =============================================================================
   THE NOTE IS NOT IN HERE, AND THAT WAS A BUG WORTH RECORDING
   =============================================================================

   It used to be, for everything except a detail. But polish() rewrites the note
   with a model, and a model does not produce the same sentence twice - so the
   same money worry hashed differently on every pass and became a new row every
   time a live transcript grew. scripts/insights-check.mjs caught it as
   "6 before, 10 after".

   The rule id is what makes two observations the same observation, and it is
   fixed in the source. newValue stays in: a salary heard as 95,000 and later as
   105,000 really are two different proposals. */
export function fingerprintOf(
    finding: Finding,
    scope: string
): string {
    return createHash('sha256')
        .update([finding.ruleId, finding.kind, finding.field ?? '',
            finding.newValue ?? '', scope].join('|'))
        .digest('hex')
        .slice(0, 64);
}
