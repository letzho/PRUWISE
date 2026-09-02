/* =============================================================================
   GET /api/call-ring
   ->  { ringing: { roomCode, fromName, fromPersonId, waitingSeconds } }
   ->  { ringing: null }
   -----------------------------------------------------------------------------
   Ported from php/api/call-ring.php.

   "Is somebody trying to call me right now?"

   =============================================================================
   WHY THIS NEEDS TO EXIST AT ALL
   =============================================================================

   A video call is the one thing in PRUWise that is URGENT. A message can wait an
   hour; an appointment request can wait a day. But somebody sitting in an empty call
   room staring at "waiting for Kristin to join" is waiting in real time, and if the
   other side never finds out, they simply give up.

   Everything else in this project is pull-based and that is fine. This is the one
   case where the person who needs to know is not looking at the screen that knows.

   =============================================================================
   HOW "RINGING" IS WORKED OUT WITHOUT A RINGING COLUMN
   =============================================================================

   There is no "is ringing" flag, and adding one would mean something has to remember
   to clear it - which is exactly the sort of state that gets stuck on after a browser
   crash and leaves a phantom call ringing forever.

   Instead it is derived from the heartbeats that already exist:

       THEY are present    their seen_at is within PRESENCE_SECONDS
       I am not            my joined_at is null, or my seen_at has gone stale
       the call is open    status is not 'ended'

   All three have to be true. Because it is derived, IT CANNOT GET STUCK: the moment
   they close the tab their heartbeat stops and the ringing stops with it, with
   nothing to clean up.

   =============================================================================
   WHY THE POLL IS CHEAP
   =============================================================================

   One indexed lookup on (fr_person_id, customer_person_id, status), returning at
   most one row. It is called every few seconds by anybody signed in, so it is
   deliberately the smallest query in the project - no joins except the one name
   needed to say who is calling.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { one, toIso } from '../_lib/db.js';
import { defineHandler, ok } from '../_lib/http.js';
import { PRESENCE_SECONDS } from '../_lib/calls.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* An administrator holds no calls, so there is nothing to answer. Returning an
       empty answer rather than a 403 keeps the browser side simple - it can poll
       this for anybody without checking the role first. */
    if (user.role === 'admin') {
        return ok({ ringing: null });
    }

    /* Which column is me and which is the other person. Working this out once means
       the query below is written a single time rather than twice.

       These are fixed literals chosen by role, never anything from the request. */
    const isRep = user.role === 'fr';

    const mineJoined = isRep ? 'fr_joined_at' : 'customer_joined_at';
    const mineSeen = isRep ? 'fr_seen_at' : 'customer_seen_at';
    const theirSeen = isRep ? 'customer_seen_at' : 'fr_seen_at';
    const mineColumn = isRep ? 'fr_person_id' : 'customer_person_id';
    const theirColumn = isRep ? 'customer_person_id' : 'fr_person_id';

    /* The window. Their heartbeat has to be fresh, and mine has to be absent or
       stale - if I am in the room too, this is a call in progress, not a ring.

       The cutoff is computed in SQL rather than in JavaScript, so it is the
       DATABASE's clock on both sides of the comparison. A function instance whose
       clock has drifted would otherwise decide presence against a different "now"
       from the one that wrote the heartbeat. */
    const row = await one<{
        room_code: string; created_at: unknown; their_name: string; their_id: string;
    }>(
        `SELECT c.room_code, c.created_at,
                p.name AS their_name, p.id AS their_id
           FROM call_sessions c
           JOIN people p ON p.id = c.${theirColumn}
          WHERE c.${mineColumn} = ?
            AND c.status <> 'ended'
            AND c.${theirSeen} IS NOT NULL
            AND c.${theirSeen} >= now() - INTERVAL '${PRESENCE_SECONDS} seconds'
            AND (c.${mineJoined} IS NULL
                 OR c.${mineSeen} IS NULL
                 OR c.${mineSeen} < now() - INTERVAL '${PRESENCE_SECONDS} seconds')
          ORDER BY c.created_at DESC
          LIMIT 1`,
        [user.person_id]
    );

    if (!row) {
        return ok({ ringing: null });
    }

    /* How long they have been waiting. Sent so the browser can say "waiting 40
       seconds" rather than a bare "incoming call" - the number is what turns a
       notification into something somebody actually hurries for. */
    const createdMs = new Date(String(toIso(row.created_at))).getTime();
    const waited = Math.max(0, Math.round((Date.now() - createdMs) / 1000));

    return ok({
        ringing: {
            roomCode: row.room_code,
            fromPersonId: row.their_id,
            fromName: row.their_name,
            waitingSeconds: waited
        }
    });
});
