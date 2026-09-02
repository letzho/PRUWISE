/* =============================================================================
   POST /api/call-sync
       { roomCode,
         signals?: [ { kind, payload } ],   outgoing WebRTC signalling
         lines?:   [ { who, text, ref } ],  things just said out loud
         sinceLine?: 42 }                   newest transcript id I hold

   ->  { signals, transcript, transcriptSince, peerPresent, status, ended }
   -----------------------------------------------------------------------------
   Ported from php/api/call-sync.php.

   THE WHOLE CALL LOOP, IN ONE REQUEST PER SECOND.

   It does four jobs at once, which looks like too many until you notice they all
   have the same period. Splitting them would mean three or four requests a second
   instead of one, for no gain:

     1. "I am still here"      - the heartbeat, so the other side knows
     2. post my signalling     - offer / answer / ICE candidates
     3. collect their signalling
     4. post and collect the shared transcript

   ON THIS PLATFORM THAT MATTERS MORE THAN IT DID. Every request is a function
   invocation, billed by the millisecond, and four of them a second per participant
   would be four times the cost for the same call. It is also why all of them share
   one warm instance - see the note in api/router.ts.

   =============================================================================
   WHAT GOES OVER THIS AND WHAT DOES NOT
   =============================================================================

   The signalling goes over this. THE VIDEO DOES NOT. Once the two browsers have
   swapped an offer, an answer and some candidates, the audio and video flow directly
   between them and never touch this server again. This endpoint is the introduction,
   not the phone line.

   =============================================================================
   THE TRANSCRIPT IS HERE RATHER THAN ON A DATA CHANNEL
   =============================================================================

   WebRTC can carry text too, and that would be instant. But it would be a second
   delivery path to write and debug, and it would vanish the moment the peer
   connection wobbled - taking the record of the conversation with it. Riding this
   poll instead means the transcript is saved as it happens, survives a reload, and
   still arrives while people are talking, because each side shows its OWN words the
   instant the recogniser settles them.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    addLine, callInbox, callRole, callTranscript, loadCall,
    peerPresent, reloadCall, sendSignal, touchCall
} from '../_lib/calls.js';

/* Caps, so one request cannot be used to write an unbounded number of rows. */
const MAX_SIGNALS = 40;
const MAX_LINES = 30;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not take calls.');
    }

    let session = await loadCall(user, req.body.roomCode);
    const role = callRole(user);

    const sinceLine = Math.trunc(Number(req.body.sinceLine)) || 0;

    /* A call somebody has already hung up. Say so plainly rather than letting the
       browser poll a dead room forever. */
    if (session.status === 'ended') {
        return ok({
            signals: [],
            transcript: [],
            transcriptSince: sinceLine,
            peerPresent: false,
            status: 'ended',
            ended: true
        });
    }

    /* 1. I am still here. */
    await touchCall(session, role);

    /* ---------------------------------------------------------------------
       2. Post my outgoing signalling
       --------------------------------------------------------------------- */
    const outgoing = req.body.signals;

    if (Array.isArray(outgoing)) {
        for (const signal of outgoing.slice(0, MAX_SIGNALS)) {
            if (typeof signal !== 'object' || signal === null) { continue; }

            const kind = (signal as { kind?: unknown }).kind;
            if (typeof kind !== 'string' || kind === '') { continue; }

            await sendSignal(session, role, kind, (signal as { payload?: unknown }).payload ?? '');
        }
    }

    /* ---------------------------------------------------------------------
       3. Post anything just said

       `who` is 'person' for a spoken line and 'pruwise' for one of the assistant's
       nudges. THE ACCOUNT IS TAKEN FROM THE SESSION, never from the request, so a
       line can only ever be attributed to the person who actually sent it - which is
       the whole basis of the speaker labels in the log.
       --------------------------------------------------------------------- */
    const lines = req.body.lines;

    if (Array.isArray(lines)) {
        for (const line of lines.slice(0, MAX_LINES)) {
            if (typeof line !== 'object' || line === null) { continue; }

            const entry = line as { who?: unknown; text?: unknown; ref?: unknown };

            if (typeof entry.text !== 'string') { continue; }

            await addLine(
                session,
                user.id,
                entry.who === 'pruwise' ? 'pruwise' : 'person',
                entry.text,
                entry.ref === undefined || entry.ref === null
                    ? null
                    : String(entry.ref).slice(0, 40)
            );
        }
    }

    /* ---------------------------------------------------------------------
       4. Collect everything waiting for me
       --------------------------------------------------------------------- */
    const transcript = await callTranscript(session, user.id, sinceLine);

    let newest = sinceLine;
    for (const line of transcript) {
        const id = Number(line.id);
        if (id > newest) { newest = id; }
    }

    /* Re-read the session: touchCall may have promoted it, and the peer's own
       heartbeat may have landed between the top of this handler and here. */
    session = await reloadCall(Number(session.id));

    return ok({
        signals: await callInbox(session, role),
        transcript,
        transcriptSince: newest,
        peerPresent: peerPresent(session, role),
        status: session.status,
        ended: session.status === 'ended'
    });
});
