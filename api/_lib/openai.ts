/* =============================================================================
   openai.ts - the one place that talks to the language model
   -----------------------------------------------------------------------------
   Replaces php/openai-proxy.php, which could not exist here: Vercel does not run
   PHP, so js/ai.js was posting to a file that returned the 404 page. Every AI
   feature silently fell back to the built-in keyword rules and looked like it was
   "just not very good" rather than broken.

   =============================================================================
   THE BOUNDARY. THIS IS THE IMPORTANT PART OF THE FILE.
   =============================================================================

   The model IMPROVES WORDING. It never decides anything.

   Concretely, it is allowed to:
     - explain insurance in plain language
     - re-word a finding the rules engine already made
     - draft a reply a human is about to read, edit and send

   It is NOT allowed to:
     - decide which product somebody should buy
     - state a premium, a sum assured, or any other figure
     - assert what was agreed on a call
     - claim a policy is in force

   Why that line and not a looser one: a model asked to recommend will cheerfully
   name a plan that does not exist in this catalogue, and a model asked to summarise
   a sales call will write "the customer agreed to proceed" because that is what
   such summaries usually say. Either sentence, sent to a customer and logged, is a
   compliance problem rather than a bug.

   The line is enforced in three places, deliberately overlapping:

     1. GUARDRAIL below is prepended to every single request, ahead of whatever
        prompt the caller supplied. The caller cannot remove it.
     2. The features that decide things - the call co-pilot's triggers, the
        after-call summary's findings, the product recommendations - are RULES, in
        _lib/copilot.ts and _lib/assessment.ts, and run whether or not a key is
        configured. The model is only ever handed a finding that already exists.
     3. Anything the model writes for a customer to read goes to a representative
        as a DRAFT first. See /api/call-summary and /api/suggest-reply.

   Remove any one of the three and the other two still hold.

   =============================================================================
   IT NEVER THROWS
   =============================================================================

   Every caller has a working answer without the model - that is the whole design.
   So a timeout, a rate limit, a billing failure or a malformed response all return
   null, and the caller uses its rules. An AI feature that takes the page down when
   OpenAI has a bad afternoon is worse than one that quietly gets less clever.
   ============================================================================= */

import { all, column, q } from './db.js';
import { env, has } from './env.js';

/* Prepended to every request. The caller's own system prompt follows it, so this
   is what the model reads first and what any later instruction has to argue
   against. */
const GUARDRAIL = [
    'You are PRUWise, an assistant inside an insurance application used by customers',
    'and by licensed financial representatives in Singapore.',
    '',
    'RULES YOU MUST FOLLOW, in order of importance:',
    '',
    '1. NEVER state a specific premium, sum assured, payout, or any other monetary',
    '   figure unless that exact figure appears in the context you were given.',
    '   If you do not have the number, say that the representative will confirm it.',
    '2. NEVER say a customer has agreed to, decided on, applied for, or been issued',
    '   anything. You do not know what was agreed. Describe what was DISCUSSED.',
    '3. NEVER recommend or name a specific product unless it is named in the context',
    '   you were given. There is a fixed catalogue and you do not have it memorised;',
    '   inventing a plan name sends somebody looking for a policy that does not exist.',
    '4. Only a licensed representative decides what cover suits somebody. You explain',
    '   options and trade-offs. You do not advise.',
    '5. Be brief. Short paragraphs, plain words, no markdown headings, no emoji.',
    '   Use "- " at the start of a line for a bullet if you need a list.',
    '6. If you are unsure, say so and suggest asking the representative. A hedge is',
    '   always better than a confident invention.'
].join('\n');

/* Models this application will talk to. The BROWSER DOES NOT GET A VOTE: js/ai.js
   sends a model name in its request body because that is the OpenAI request shape,
   and /api/ai ignores it. Otherwise anybody signed in could point the key at the
   most expensive model available and spend somebody else's money doing it. */
const ALLOWED_MODELS = new Set([
    'gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5'
]);

const DEFAULT_MODEL = 'gpt-4o-mini';

/* Ceilings. See the note above ai_usage in db/schema.sql for why these exist at
   all - the short version is that a key is a spending authority. */
const PER_ACCOUNT_PER_HOUR = 40;
const GLOBAL_PER_HOUR = 400;

const TIMEOUT_MS = 20_000;


export function aiModel(): string {
    const wanted = env.openaiModel;
    return ALLOWED_MODELS.has(wanted) ? wanted : DEFAULT_MODEL;
}

/* Whether a real key is configured. Checked by /api/session so the front end knows
   whether to enable the feature at all, and re-checked here so a caller cannot
   reach OpenAI with an empty Authorization header. */
export function aiReady(): boolean {
    return has.openai() && env.openaiKey.startsWith('sk-') && env.openaiKey.length > 20;
}


/* =============================================================================
   THE ALLOWANCE

   Counted BEFORE the call, and the row is written before the request goes out.
   Writing it afterwards would mean a request that times out costs money and does
   not count, which is the wrong way round - a caller in a retry loop is exactly
   the case this is for.
   ============================================================================= */

export interface Allowance {
    allowed: boolean;
    reason?: string;
}

export async function takeAllowance(accountId: number, kind: string): Promise<Allowance> {
    const counts = await all<{ mine: string; everyone: string }>(
        `SELECT COUNT(*) FILTER (WHERE account_id = ?) AS mine,
                COUNT(*)                               AS everyone
           FROM ai_usage
          WHERE created_at > now() - INTERVAL '1 hour'`,
        [accountId]
    );

    const mine = Number(counts[0]?.mine ?? 0);
    const everyone = Number(counts[0]?.everyone ?? 0);

    if (mine >= PER_ACCOUNT_PER_HOUR) {
        return {
            allowed: false,
            reason: 'You have used the assistant a lot in the last hour. It will be ' +
                    'available again shortly - everything else on the page still works.'
        };
    }

    if (everyone >= GLOBAL_PER_HOUR) {
        return {
            allowed: false,
            reason: 'The assistant is busy across the whole site at the moment. ' +
                    'Please try again in a few minutes.'
        };
    }

    await q('INSERT INTO ai_usage (account_id, kind) VALUES (?, ?)',
        [accountId, kind.slice(0, 24)]);

    /* Housekeeping in place of a cron job the free plan does not offer often enough.
       Only ever deletes rows the counters above can no longer see. */
    void q(`DELETE FROM ai_usage WHERE created_at < now() - INTERVAL '2 days'`)
        .catch(() => { /* housekeeping */ });

    return { allowed: true };
}

/* How much of the allowance is left, for a screen that wants to say so. */
export async function allowanceLeft(accountId: number): Promise<number> {
    const used = Number(await column(
        `SELECT COUNT(*) FROM ai_usage
          WHERE account_id = ? AND created_at > now() - INTERVAL '1 hour'`,
        [accountId]
    ) ?? 0);

    return Math.max(0, PER_ACCOUNT_PER_HOUR - used);
}


/* =============================================================================
   THE CALL
   ============================================================================= */

export interface ChatOptions {
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
}

/* Returns the model's text, or null. NEVER THROWS - see the header. */
export async function chatComplete(options: ChatOptions): Promise<string | null> {
    if (!aiReady()) { return null; }

    /* Clamped, not trusted. maxTokens is what the response costs, and temperature
       above about 1 turns a careful answer into an unpredictable one. */
    const maxTokens = Math.min(1200, Math.max(64, Math.trunc(options.maxTokens ?? 700)));
    const temperature = Math.min(1, Math.max(0, options.temperature ?? 0.4));

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${env.openaiKey}`
            },
            body: JSON.stringify({
                model: aiModel(),
                temperature,
                max_tokens: maxTokens,
                messages: [
                    /* GUARDRAIL FIRST, always. The caller's prompt is context, not a
                       replacement for the rules. */
                    { role: 'system', content: GUARDRAIL },
                    { role: 'system', content: options.system.slice(0, 8000) },
                    { role: 'user', content: options.user.slice(0, 8000) }
                ]
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });

        if (!response.ok) {
            /* The body usually says exactly what is wrong - an expired key, an
               exhausted quota, a model that does not exist. Logged in full because
               that is the difference between "the AI is broken" and a fix, and NOT
               returned to the caller because it can name internals. */
            const detail = await response.text().catch(() => '');

            console.error(`OpenAI refused the request (${response.status}):`,
                detail.slice(0, 600));

            return null;
        }

        const body = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
        };

        const text = body.choices?.[0]?.message?.content;

        if (typeof text !== 'string' || text.trim() === '') {
            console.warn('OpenAI returned no usable text.');
            return null;
        }

        return text.trim();

    } catch (error) {
        /* A timeout lands here, and so does a DNS failure or a dropped connection.
           All of them mean "use the rules instead". */
        const message = error instanceof Error ? error.message : String(error);
        console.error('OpenAI request failed:', message);

        return null;
    }
}

/* Strip the markdown the model reaches for even when told not to.

   The browser renders our own message objects, not markdown, so a stray ** or a
   leading ### shows up as literal characters on the screen. Cleaned here rather
   than in js/ai.js so every caller gets it. */
export function tidyModelText(text: string): string {
    return text
        .replace(/\*\*/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[*•]\s+/gm, '- ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
