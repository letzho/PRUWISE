/* =============================================================================
   POST /api/suggest-reply  {  threadId  }  ->  { suggestions: [ ... ], source }
   -----------------------------------------------------------------------------
   Three short replies somebody might send next in a conversation, for the strip
   above the message box.

   =============================================================================
   THEY ARE DRAFTS. NOTHING IS EVER SENT FROM HERE.
   =============================================================================

   This endpoint writes nothing to the messages table. It reads the last few lines
   of a conversation the caller is already part of and hands back wording. Tapping
   one drops it into the box, where it can be edited or deleted like anything the
   person typed themselves.

   That is not a small distinction. A representative's message to a customer about
   their policies is a regulated communication written in their name - so the human
   presses send, always, and the draft saves them the typing rather than the
   responsibility. Same rule as the after-call summary.

   =============================================================================
   WHAT THE MODEL IS AND IS NOT ALLOWED TO WRITE
   =============================================================================

   The guardrail in _lib/openai.ts already forbids figures, product names and
   claims about what was agreed. This endpoint adds the one rule specific to a chat
   reply: A SUGGESTION MAY NOT COMMIT TO ANYTHING. "I'll check that and come back to
   you" is a fine suggestion. "Yes, we can do that for $180 a month" is not, and
   would be a promise made by a machine in a human's name.

   =============================================================================
   IT WORKS WITH NO KEY
   =============================================================================

   Without a key it returns fixed openers chosen by role and by who spoke last -
   less clever, still useful, and the strip does not disappear. The browser gets
   `source: 'rules' | 'openai'` so it can be honest about which it is showing.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { all, one } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { aiReady, chatComplete, takeAllowance, tidyModelText } from '../_lib/openai.js';
import { requireThread } from '../_lib/threads.js';
import { documentContextForThread } from '../_lib/documents.js';
import { financesFor, financesNeeds } from '../_lib/finances.js';

/* How much of the conversation the model sees. Enough for context, small enough
   that a long-running thread does not turn every suggestion into an expensive
   request. */
const HISTORY_LINES = 12;
const MAX_SUGGESTIONS = 3;

/* =============================================================================
   THE FALLBACK, AND WHY IT USED TO REPEAT ITSELF
   =============================================================================

   THE BUG: pressing Refresh gave back the same three sentences, every time,
   forever. Two separate causes, and the second is the one that mattered.

     THE MODEL WAS NOT TOLD IT WAS BEING ASKED AGAIN. Same conversation, same
     prompt, temperature 0.6 - so it produced near-identical wording and was
     right to. "Give me another" is information the request never carried.

     AND THE FALLBACK WAS THREE FIXED STRINGS. Once the hourly allowance ran out
     - forty model calls, and the transcript reading added in the last round spends
     from the same pot - every refresh returned this array verbatim. Not similar:
     identical. That is what somebody pressing the button five times was seeing.

   So there are now SIX per situation rather than three, the caller says which
   ones it is already showing, and both paths exclude those. Three fixed strings
   was never enough to refresh from.

   Deliberately all safe: none of them commits to anything, quotes a figure, or
   names a product. If the model is unavailable these still cannot cause harm.

   {name} is filled with the other person's first name. A draft that opens with
   the name of the person you are talking to is the cheapest personalisation there
   is, and its absence was the other half of "it does not feel personalised".
   ============================================================================= */
const FALLBACKS: Record<string, { waiting: string[]; opening: string[] }> = {
    fr: {
        waiting: [
            'Thanks for letting me know, {name} - let me look into that and come back to you.',
            'Good question. Can I check a couple of details on your file first?',
            'Would it help to go through this on a short call rather than by message?',
            'That is worth going through properly rather than in a message - shall I call you?',
            'Let me confirm that against your record and reply today.',
            'I want to make sure I answer that accurately, so give me a little time to check.'
        ],
        opening: [
            'Hello {name}, just checking in - is there anything you would like to go over?',
            'When you have a moment, could we look at your cover together?',
            'Let me know if any part of your plan is unclear and I will explain it.',
            'Is there anything that has changed for you recently that I should know about?',
            'Happy to walk through anything on your plan that does not read clearly.',
            'If it is easier to talk than type, say the word and I will call.'
        ]
    },
    customer: {
        waiting: [
            'Thanks, that makes sense.',
            'Could you explain that part again in simpler terms?',
            'What would you suggest as the next step?',
            'Could we go through this on a call instead?',
            'I think I follow - can I check one thing with you?',
            'Thank you. I will have a think and come back to you.'
        ],
        opening: [
            'Hello {name}, I have a question about my cover.',
            'Could we go through my plan when you have time?',
            'I would like to understand what I am currently covered for.',
            'Is there anything you think I should be looking at?',
            'Something has changed for me - can we talk it through?',
            'Could you explain what my plan does not cover?'
        ]
    }
};

/* Three from the pool, skipping anything the caller already has on screen, and
   starting from a different place each time so a second press moves along.

   NOT Math.random(): with a pool of six and three picks, random repeats a whole
   set often enough to look broken - which is the thing being fixed. Rotating by
   how many have already been rejected is the behaviour somebody pressing Refresh
   expects, which is "show me the next ones". */
/* =============================================================================
   AND THEN IT REVERTED, WHICH WAS THIS FUNCTION'S FAULT
   =============================================================================

   REPORTED, one round later: "upon tapping it will load but then show the same
   suggested reply - I see a bit after tapping but it reverts back."

   Precisely what the arithmetic did. Six in the pool, three shown at a time:

     first ask     already = 0   offset 0        -> lines 0, 1, 2
     refresh       already = 3   fresh has 3     -> lines 3, 4, 5      good
     refresh again already = 6   fresh has 0
                                 usable = all 6
                                 offset = 6 % 6 = 0  -> LINES 0, 1, 2

   The third press landed exactly back on the first set. The comment above it
   cheerfully described that as "start the rotation over", which is what it does -
   and starting over from the top of a six-item pool is indistinguishable from the
   button not working.

   THE HONEST FIX IS TO SAY SO. There genuinely is no more built-in wording; the
   pool is a fallback for when a model is unavailable, not an infinite supply. So
   the exhausted case now RETURNS THAT FACT, the interface says "that is all the
   built-in wording", and nobody presses a fourth time expecting something new.

   Silently cycling was the worse choice twice over: it wasted somebody's time and
   it made a working button look broken.
   ============================================================================= */
/* =============================================================================
   A REPHRASE IS A REPEAT, AND SAMENESS IS JUDGED ON THE OPENING WORDS

   Exact-string comparison is not enough, and a test proved it rather than a hunch.
   Asked for a different set, the model came back with

       "I will calculate the revised protection figure and provide options at
        different premium levels..."

   against a first set that opened

       "I will calculate the revised protection figure with the new dependent..."

   Two different strings. The same sentence. Somebody pressing Refresh and reading
   that has been given nothing, which is the complaint this feature has now been
   reported for twice.

   SIX WORDS is the useful length: long enough that two genuinely different replies
   almost never collide, short enough to catch a tail that has been reworded.
   Punctuation is stripped first, so an apostrophe or a comma cannot defeat it -
   "Let's discuss" and "Lets discuss" must not read as different openings.

   ONE HELPER, USED BY BOTH PATHS. It lived inside the model branch first, and the
   pool fallback kept its old exact-match test - so a fixed pool line beginning
   "What specific concerns do you have about your current cover" was served against
   a model line beginning "What specific concerns do you have about the new baby",
   and the bug came straight back through the other door. Two filters for one rule
   is how a rule gets half-applied.
   ============================================================================= */
function opener(line: string): string {
    return line.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join(' ');
}

function fromPool(
    pool: string[],
    already: string[],
    name: string
): { items: string[]; exhausted: boolean } {
    const filled = pool.map(line => line.replace(/\{name\}/g, name));
    const seen = new Set(already.map(s => s.trim().toLowerCase()));
    const seenOpeners = new Set(already.map(opener));

    const fresh = filled.filter(line =>
        !seen.has(line.trim().toLowerCase()) && !seenOpeners.has(opener(line)));

    /* Nothing new to offer. The last set is returned unchanged rather than
       shuffled back to the beginning, and `exhausted` is what stops that reading
       as a fault - see the note above. */
    if (fresh.length === 0) {
        return { items: filled.slice(0, MAX_SUGGESTIONS), exhausted: true };
    }

    /* Fewer than a full set left. Show what is left rather than padding it out
       with lines that were already turned down. */
    return {
        items: fresh.slice(0, MAX_SUGGESTIONS),
        exhausted: fresh.length <= MAX_SUGGESTIONS
    };
}

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not have conversations.');
    }

    const threadId = Math.trunc(Number(req.body.threadId)) || 0;

    if (!threadId) {
        fail(400, 'Say which conversation.', 'threadId');
    }

    /* requireThread() 404s anything the caller is not a member of, so there is no
       way to read somebody else's conversation through this. */
    const thread = await requireThread(user, threadId);

    /* PRUWise's own thread already answers for itself through /api/ai. Suggesting
       replies to the assistant would be the assistant talking to itself. */
    if (thread.kind !== 'human') {
        fail(400, 'Suggested replies are for a conversation with a person.');
    }

    /* --------------------------------------------------------------------- */
    const history = await all<{ body: string | null; mine: boolean; sender_kind: string }>(
        `SELECT m.body, m.sender_kind,
                (m.sender_account_id = ?) AS mine
           FROM messages m
          WHERE m.thread_id = ?
            AND m.body IS NOT NULL AND m.body <> ''
          ORDER BY m.id DESC
          LIMIT ${HISTORY_LINES}`,
        [user.id, threadId]
    );

    /* Newest-first out of the database so the LIMIT takes the RECENT lines; flipped
       here so the model reads the conversation in the order it happened. */
    const lines = history.reverse();

    const last = lines[lines.length - 1];
    const theyreWaiting = !!last && last.mine !== true;

    const role = user.role === 'fr' ? 'fr' : 'customer';
    const fallback = FALLBACKS[role] as { waiting: string[]; opening: string[] };

    /* WHAT THE CALLER ALREADY HAS ON SCREEN. This is the whole fix for Refresh:
       without it the request that means "give me different ones" is byte-identical
       to the one that produced what is already there. */
    const already = Array.isArray(req.body.previous)
        ? (req.body.previous as unknown[])
            .map(v => String(v ?? '').slice(0, 300))
            .filter(s => s.length > 0)
            .slice(0, 12)
        : [];

    /* Who the other person is, so a draft can use a name rather than "the
       customer" - which reads like a form letter. Read BEFORE the allowance check,
       because the fallback wants the name just as much as the model does. */
    const otherId = thread.fr_person_id === user.person_id
        ? thread.customer_person_id
        : thread.fr_person_id;

    const other = await one<{ first_name: string | null; name: string }>(
        'SELECT first_name, name FROM people WHERE id = ?', [String(otherId)]);

    const otherName = other ? (other.first_name ?? other.name) : 'them';

    const pool = theyreWaiting ? fallback.waiting : fallback.opening;
    const rules = fromPool(pool, already, otherName);

    /* `exhausted` travels with the answer so the strip can say "that is all the
       built-in wording I have" instead of the reader concluding Refresh is
       broken. */
    const rulesReply = {
        suggestions: rules.items,
        source: 'rules' as const,
        exhausted: rules.exhausted
    };

    /* ---------------------------------------------------- no key, no problem */
    if (!aiReady() || lines.length === 0) {
        return ok(rulesReply);
    }

    const allowance = await takeAllowance(user.id, 'suggest');

    if (!allowance.allowed) {
        return ok({ ...rulesReply, note: allowance.reason });
    }

    const transcript = lines
        .map(line => `${line.mine === true ? 'ME' : otherName.toUpperCase()}: ${line.body}`)
        .join('\n');

    /* WHAT ANY FILES IN THIS CONVERSATION SAID.

       Summaries only - see documentContextForThread in _lib/documents.ts. This is
       what makes a reply to "here is my payslip" refer to what the payslip showed
       instead of being a polite acknowledgement of an unopened attachment.

       The summaries went through the same guardrail on the way in, so nothing here
       reintroduces a figure or a product name. */
    const documents = await documentContextForThread(threadId);

    /* =========================================================================
       WHOSE CONVERSATION THIS IS, IN WORDS AND NEVER IN NUMBERS

       "It should give personalised responses" was the other half of the report,
       and the reason it did not was that the model was given the last twelve lines
       and nothing else. Two different clients in the same short exchange got the
       same three drafts, because from the model's side they were the same request.

       So it is now told the SITUATION - has this person filled in their figures,
       is their cover short of what those figures suggest - which is what changes
       what is worth saying next.

       QUALITATIVE ONLY. Not one number crosses into the prompt. The guardrail in
       _lib/openai.ts forbids the model quoting a figure, and handing it figures to
       be tempted by while forbidding their use is a rule waiting to be broken.
       "Well below the suggested level" is enough to steer a sentence and cannot be
       misquoted as a premium.
       ========================================================================= */
    const customerId = String(thread.customer_person_id ?? '');
    const finances = customerId === '' ? null : await financesFor(customerId);
    const needs = financesNeeds(finances);

    let situation: string;

    if (!finances || !needs) {
        situation = role === 'fr'
            ? `${otherName} has not entered their financial details yet, so no protection ` +
              'calculation is possible for them.'
            : 'I have not entered my financial details yet.';
    } else if (Number(needs.ratio) < 55) {
        situation = 'Their cover is well below the level their own figures suggest.';
    } else if (Number(needs.ratio) < 80) {
        situation = 'Their cover is a little below the level their own figures suggest.';
    } else {
        situation = 'Their cover is at or above the level their own figures suggest.';
    }

    /* A RE-ASK IS A DIFFERENT REQUEST AND HAS TO LOOK LIKE ONE. */
    /* A RE-ASK IS A DIFFERENT REQUEST AND HAS TO LOOK LIKE ONE.

       "Do not rephrase" was not specific enough on its own - the model obeyed it
       at the level of words and broke it at the level of meaning, opening a
       "different" reply with the same six words as one already on screen. So the
       instruction now names what has to change: the SUBJECT, not the phrasing. It
       is also told what the alternatives are, because "say something else" is not
       actionable and "ask about a different thing / offer a different next step"
       is.

       The filter after the response is what actually guarantees it. This is here to
       make the filter rarely needed, because every line the filter drops is a line
       written by the model replaced by one from a fixed pool. */
    const avoid = already.length > 0
        ? '\n\nThe person has already been shown the replies below and has asked for ' +
          'DIFFERENT ONES.\n\n' +
          already.map(s => `- ${s}`).join('\n') +
          '\n\nEach new reply must be about a DIFFERENT SUBJECT from all of those - ' +
          'not the same point in different words. Do not begin a reply with the same ' +
          'opening words as any of them. If one of those offers to work something ' +
          'out, do not offer to work something out again: ask about something you ' +
          'have not asked about, acknowledge a different part of what they said, or ' +
          'propose a different next step.'
        : '';

    const system = [
        role === 'fr'
            ? `You are helping a licensed financial representative in Singapore reply to ` +
              `their client ${otherName}.`
            : `You are helping a client in Singapore reply to their financial ` +
              `representative ${otherName}.`,
        '',
        `Context you may use to make the replies specific: ${situation}`,
        '',
        `Write exactly ${MAX_SUGGESTIONS} alternative replies they could send next.`,
        '',
        'Hard rules for these suggestions:',
        '- One or two sentences each. No greetings unless the conversation is starting.',
        '- NEVER commit to anything. Do not promise a price, a payout, an approval,',
        '  a date, or that something will be done. Offer to check, explain or discuss.',
        '- NEVER mention a monetary figure or a product name.',
        '- Make the three genuinely different: one that answers, one that asks a',
        '  question back, and one that offers to talk it through.',
        '- Plain British English. No emoji. No markdown.',
        '',
        'Output format: exactly three lines, each starting with "- ". Nothing else.'
    ].join('\n');

    const text = await chatComplete({
        system,
        user: `The conversation so far:\n\n${transcript}\n${documents}${avoid}\n` +
              'Write the three replies.',
        maxTokens: 250,

        /* Warmer on a re-ask. At 0.6 the same prompt lands on the same wording,
           which is correct behaviour and useless when the button says Refresh. */
        temperature: already.length > 0 ? 0.95 : 0.6
    });

    if (text === null) {
        return ok(rulesReply);
    }

    /* Parse the three lines back out. The model is told to use "- " and mostly does;
       anything that does not parse into at least two usable suggestions falls back
       rather than putting a stray fragment in somebody's message box. */
    const seen = new Set(already.map(s => s.trim().toLowerCase()));

    /* Same opener rule the pool uses - see the note above opener(). */
    const seenOpeners = new Set(already.map(opener));

    const parsed = tidyModelText(text)
        .split('\n')
        .map(line => line.replace(/^\s*[-–]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
        .filter(line => line.length > 8 && line.length <= 300)

        /* ANYTHING IT REPEATED IS DROPPED HERE. The prompt asks for different
           wording; this is what makes it true. Asked politely and checked
           afterwards is the same arrangement as everywhere else in this codebase -
           a prompt is a request, a filter is a rule. */
        .filter(line => !seen.has(line.trim().toLowerCase()))
        .filter(line => !seenOpeners.has(opener(line)))

        /* And not two near-identical lines within one answer either, which the
           model does when it has run out of angles. */
        .filter((line, index, all) =>
            all.findIndex(other => opener(other) === opener(line)) === index)

        .slice(0, MAX_SUGGESTIONS);

    /* Fewer than two usable lines falls back rather than putting a stray fragment
       in somebody's message box - and the fallback has itself already skipped what
       is on screen, so a refresh still visibly changes something.

       THIS IS NOW A REAL PATH, not a theoretical one: the opener filter above
       rejects more than the exact-match one did, so a model that has genuinely run
       out of distinct things to say ends up here. That is the correct outcome - the
       built-in pool is six deep per situation and says so when it is spent, which
       is better than a fourth press returning a reworded third. */
    if (parsed.length < 2) {
        return ok(rulesReply);
    }

    return ok({ suggestions: parsed, source: 'openai', exhausted: false });
});
