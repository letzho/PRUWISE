/* =============================================================================
   POST /api/call-copilot  {  roomCode, text  }  ->  { triggers: [ { ... } ] }
   -----------------------------------------------------------------------------
   Ported from php/api/call-copilot.php.

   The representative's co-pilot. It reads what the CUSTOMER just said during a live
   call and, when it hears something that changes their financial position, hands back
   an action card.

   =============================================================================
   WHO SEES THIS
   =============================================================================

   The representative, and only the representative. It is checked twice: the role has
   to be 'fr', AND they have to be the representative on THIS call - the room code is
   looked up against their own person id, so there is no way to ask about a
   conversation you are not in.

   The customer never receives these. A card reading "detected: new dependent, upsell
   education plan" appearing on the customer's screen would be, at best, unsettling.

   =============================================================================
   WHAT COUNTS AS A TRIGGER
   =============================================================================

   A LIFE EVENT, not a keyword. "Insurance" is a keyword and means nothing on its own.
   "My wife is pregnant" is a life event: there is about to be a new dependent, which
   changes protection need, education funding and probably budget all at once.

   The rules themselves are in _lib/copilot.ts, shared with the after-call summary so
   the two can never disagree about what was heard - and that file explains at length
   why this is a rules engine rather than a model call.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { one } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { copilotDetect } from '../_lib/copilot.js';
import { clientWords, humanThread } from '../_lib/threads.js';

/* A sentence, not a speech. Long input is almost always the transcript catching up
   after a pause, and scanning a paragraph produces four cards at once - which is
   noise at exactly the moment the representative needs one clear thing. */
const MAX_TEXT = 400;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    /* Representatives only. A customer posting here would be asking what to sell to
       themselves, which is not a thing this endpoint is for. */
    if (user.role !== 'fr') {
        fail(403, 'The call co-pilot is for financial representatives.');
    }

    const roomCode = req.field('roomCode', '');
    let text = req.field('text', '');

    if (roomCode === '' || text === '') {
        return ok({ triggers: [] });
    }

    /* Their own call, or nothing. THE ROOM CODE ALONE IS NOT AUTHORITY - it is checked
       against this representative's person id. */
    const call = await one<{ id: number; room_code: string; customer_person_id: string }>(
        `SELECT id, room_code, customer_person_id FROM call_sessions
          WHERE room_code = ? AND fr_person_id = ? AND status <> 'ended'`,
        [roomCode, user.person_id]
    );

    if (!call) {
        fail(403, 'That is not one of your calls.');
    }

    if (text.length > MAX_TEXT) {
        text = text.slice(-MAX_TEXT);
    }

    /* =========================================================================
       WHAT THEY TOLD YOU BEFORE THE CALL STARTED

       REQUESTED: "the AI should be giving recommendations based on the previous
       text and also the call".

       The co-pilot used to see one spoken sentence and nothing else, so anything
       the client had already typed - the pregnancy, the new job, the flat - was
       invisible the moment the call began. Their own conversation is the obvious
       place to look and it was right there.

       -------------------------------------------------------------------------
       THE TWO SOURCES ARE RETURNED SEPARATELY AND NEVER MERGED
       -------------------------------------------------------------------------
       A live card says heard: "pregnant" and puts quote marks round it. If a
       trigger found in a three-week-old message came back in that same list, the
       card would claim to have heard something in the room that nobody said. That
       is a small lie with a real cost: the representative would look up expecting
       the client to have just said it.

       So `fromChat` is its own list, and js/call.js labels those notes as coming
       from the earlier conversation.

       -------------------------------------------------------------------------
       READ ONCE PER CALL, NOT ONCE PER SENTENCE
       -------------------------------------------------------------------------
       askCopilot() fires on every sentence the client speaks. Reading the whole
       conversation each time would be a database round trip per sentence to
       compute an answer that cannot change during the call. The browser asks for
       it on its FIRST request for a room and not again - `includeChat`.
       ========================================================================= */
    let fromChat: ReturnType<typeof copilotDetect> = [];

    if (req.field('includeChat', false) === true) {
        const thread = await humanThread(user.person_id, call.customer_person_id);

        if (thread) {
            const words = await clientWords(Number(thread.id), call.customer_person_id, 40);

            if (words.length) {
                /* SIX, not two. The live limit exists because a representative
                   mid-sentence can act on one thing; this arrives once, at the
                   start, when there is time to read a short list of what the
                   client has already said matters. */
                fromChat = copilotDetect(words.join('\n'), 6);
            }
        }
    }

    /* Nothing heard is the normal answer. Most sentences in a conversation are not
       financial events, and returning an empty list keeps the browser side simple. */
    return ok({ triggers: copilotDetect(text), fromChat });
});
