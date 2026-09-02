/* =============================================================================
   POST /api/ai
       { messages: [ { role:'system', content }, { role:'user', content } ],
         max_tokens?, temperature? }
   ->  { choices: [ { message: { content } } ] }
   -----------------------------------------------------------------------------
   Replaces php/openai-proxy.php.

   =============================================================================
   WHY THE REQUEST AND RESPONSE ARE OPENAI-SHAPED
   =============================================================================

   Because js/ai.js already speaks that shape - chat() in that file builds an OpenAI
   body and reads choices[0].message.content back. Keeping the shape meant the fix
   for the whole feature was one URL, rather than rewriting several hundred lines of
   working prompt-building in the browser.

   IT IS NOT A PASS-THROUGH, though, and the difference matters:

     - the key stays here. That is the entire point of a relay.
     - the MODEL comes from the server. The browser sends one because that is the
       request shape; it is ignored. Otherwise anybody signed in could point the key
       at the most expensive model available.
     - max_tokens and temperature are CLAMPED.
     - the guardrail system message is prepended ahead of whatever prompt the
       browser sent - see _lib/openai.ts, which is where the boundary is written
       down and argued for.
     - it requires a session, and it counts against an hourly allowance.

   A pass-through would be a public, authenticated-by-nothing OpenAI endpoint
   attached to somebody's credit card.

   =============================================================================
   IT ANSWERS 200 WITH A NULL BODY RATHER THAN AN ERROR
   =============================================================================

   js/ai.js falls back to its built-in keyword answers whenever this does not give
   it text - which is a working answer, immediately, with no key. So "no key
   configured", "allowance used up" and "OpenAI is down" all return 200 with an
   empty choices array and a `reason`, and the page carries on. Returning 500 would
   make the browser log a scary failure for something that is handled.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { aiModel, aiReady, chatComplete, takeAllowance, tidyModelText } from '../_lib/openai.js';

/* What the browser is allowed to say. Anything else in the body is ignored. */
interface IncomingMessage {
    role?: unknown;
    content?: unknown;
}

export default defineHandler(async (req) => {
    req.requirePost();

    /* A SESSION IS REQUIRED. Without it this is an open relay to a paid API. */
    const user = await requireLogin(req);

    if (!aiReady()) {
        return ok({
            choices: [],
            reason: 'not-configured',
            note: 'No OpenAI key is configured, so PRUWise is using its built-in answers.'
        });
    }

    /* ---------------------------------------------------------------------
       Read the two prompts out of the OpenAI-shaped body.

       Only the FIRST system message and the LAST user message are used. A body
       carrying six alternating turns would be a conversation this endpoint has not
       agreed to pay for, and js/ai.js only ever sends two.
       --------------------------------------------------------------------- */
    const raw = req.body.messages;

    if (!Array.isArray(raw) || raw.length === 0) {
        fail(400, 'Expected a messages array.');
    }

    let systemPrompt = '';
    let userPrompt = '';

    for (const entry of raw.slice(0, 8) as IncomingMessage[]) {
        if (typeof entry !== 'object' || entry === null) { continue; }
        if (typeof entry.content !== 'string') { continue; }

        if (entry.role === 'system' && systemPrompt === '') {
            systemPrompt = entry.content;
        } else if (entry.role === 'user') {
            userPrompt = entry.content;
        }
    }

    if (userPrompt.trim() === '') {
        fail(400, 'There was nothing to ask.');
    }

    /* ------------------------------------------------------- the allowance */
    const allowance = await takeAllowance(user.id, 'chat');

    if (!allowance.allowed) {
        return ok({ choices: [], reason: 'rate-limited', note: allowance.reason });
    }

    /* ------------------------------------------------------------ ask it */
    const text = await chatComplete({
        system: systemPrompt,
        user: userPrompt,
        maxTokens: Number(req.body.max_tokens) || 700,
        temperature: Number(req.body.temperature)
    });

    if (text === null) {
        return ok({
            choices: [],
            reason: 'unavailable',
            note: 'The assistant could not be reached, so PRUWise answered from its own rules.'
        });
    }

    return ok({
        model: aiModel(),
        choices: [{ message: { role: 'assistant', content: tidyModelText(text) } }]
    });
});
