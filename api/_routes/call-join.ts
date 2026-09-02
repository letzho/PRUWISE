/* =============================================================================
   POST /api/call-join  {  withPerson?, appointmentId?  }
   ->  { roomCode, callId, role, isOfferer, peer, peerPresent, status,
         iceServers, transcript, transcriptSince, pollMs }
   -----------------------------------------------------------------------------
   Ported from php/api/call-join.php.

   "Put me in the call with this person." Called once, when the call screen opens.
   Everything after it goes through /api/call-sync.

   A CUSTOMER DOES NOT GET TO CHOOSE. withPerson is ignored for a customer: they
   have exactly one representative and it is on their own record. For a
   representative it must name a customer who is actually theirs. Both rules live in
   resolvePair() - see _lib/calls.ts.

   =============================================================================
   WHO CALLS WHOM: THE OFFERER RULE
   =============================================================================

   One side has to make the WebRTC offer and the other has to answer. If both offer,
   the two connections talk past each other and nothing works.

   The rule here is: THE REPRESENTATIVE ALWAYS OFFERS. It is fixed rather than
   negotiated, it does not depend on who arrived first, and either side can reload
   without the roles swapping underneath them. The representative waits until
   presence says the customer is there and then offers; the customer waits for an
   offer and answers it.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { column } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    callPeer, callRole, callTranscript, latestLineId, openRoom,
    peerPresent, reloadCall, resolvePair, touchCall
} from '../_lib/calls.js';

/* =============================================================================
   ICE SERVERS

   A STUN server tells a browser what its own public address looks like from the
   outside, which is usually enough for two home connections to find each other.

   IT IS NOT ALWAYS ENOUGH. Behind a strict corporate firewall or a carrier-grade
   NAT, the two browsers cannot reach each other directly at all and the media has
   to be RELAYED by a TURN server. TURN carries the actual video, so nobody runs one
   for free - if this needs to work on every network, add TURN credentials.

   Sent from the server rather than hard-coded in the browser for exactly that
   reason: it is the one piece of call configuration somebody may need to change
   without touching the front end.

   TURN is included by default via Metered Open Relay so calls work on mobile
   data and locked-down networks. Override with TURN_URLS, TURN_USERNAME and
   TURN_CREDENTIAL for a production relay (Twilio, Cloudflare, self-hosted).
   ============================================================================= */

type IceServer = {
    urls: string | string[];
    username?: string;
    credential?: string;
};

/* Public relay for development and strict NAT fallback. Override via env vars. */
const DEFAULT_TURN: IceServer = {
    urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
};

function buildIceServers(): IceServer[] {
    const servers: IceServer[] = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    const turnUrls = env.turnUrls;
    const turnUsername = env.turnUsername;
    const turnCredential = env.turnCredential;

    if (turnUrls && turnUsername && turnCredential) {
        servers.push({
            urls: turnUrls.split(',').map((url) => url.trim()).filter(Boolean),
            username: turnUsername,
            credential: turnCredential
        });
    } else {
        servers.push(DEFAULT_TURN);
    }

    return servers;
}

/* How long the poller should wait between requests. Sent by the server so the pace
   can be changed in one place if it ever needs to. */
const POLL_MS = 1000;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not take calls.');
    }

    const pair = await resolvePair(user, req.body.withPerson);

    let appointmentId: string | null = req.field('appointmentId', '') || null;

    /* Only attach the appointment if it is real AND belongs to this pair. A bad id
       would otherwise fail on the foreign key with a 500, and a valid id belonging
       to somebody else has no business being recorded against this call.

       rep_person_id, NOT fr_person_id. The two names mean the same thing and the
       schema is not consistent about which it uses: `threads` and `call_sessions`
       say fr_person_id, while `appointments` and `consultation_requests` say
       rep_person_id. This query reads appointments, so it is rep_person_id.

       That was a real bug in the PHP - it threw "Unknown column 'fr_person_id'" on
       every attempt to join a call WITH an appointment attached, which is the normal
       path from a booked meeting. Joining without one skipped the block entirely and
       worked, which is why it looked intermittent. */
    if (appointmentId !== null) {
        const owns = await column(
            `SELECT id FROM appointments
              WHERE id = ? AND customer_person_id = ? AND rep_person_id = ?`,
            [appointmentId, pair.customer, pair.fr]
        );

        if (!owns) { appointmentId = null; }
    }

    let session = await openRoom(pair.fr, pair.customer, appointmentId);
    const role = callRole(user);

    /* "I am here" - this is also what lets the other side know to start connecting. */
    await touchCall(session, role);

    /* Re-read, because touchCall may have promoted the room to 'active'. */
    session = await reloadCall(Number(session.id));

    await audit(user.id, 'call.join', `room ${String(session.room_code)}`, req.ip);

    return ok({
        roomCode: session.room_code,
        callId: Number(session.id),
        role,

        /* See the header comment: fixed, not negotiated. */
        isOfferer: role === 'fr',

        peer: await callPeer(user, session),
        peerPresent: peerPresent(session, role),
        status: session.status,
        iceServers: buildIceServers(),

        /* Anything already said. A reload mid-call gets the transcript back rather
           than starting from an empty log. */
        transcript: await callTranscript(session, user.id, 0),
        transcriptSince: await latestLineId(Number(session.id)),

        pollMs: POLL_MS
    });
});
