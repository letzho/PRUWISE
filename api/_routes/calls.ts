/* =============================================================================
   GET /api/calls?limit=20  ->  { calls: [ { ... } ] }
   -----------------------------------------------------------------------------
   Ported from php/api/calls.php.

   The call history, for whichever side is asking.

   =============================================================================
   WHY THIS IS WORTH HAVING
   =============================================================================

   Everything else a customer and a representative do together leaves a trace:
   messages sit in a thread, appointments sit in a calendar. A video call left nothing
   at all - it happened, it ended, and the only evidence was a transcript nobody could
   reach.

   So "when did we last speak, and for how long" had no answer, which is a strange gap
   in a record of a working relationship.

   =============================================================================
   WHAT COUNTS AS A CALL THAT HAPPENED
   =============================================================================

   started_at is only set when BOTH sides were present, so it is the honest test of
   whether anybody actually spoke. A row with no started_at is somebody who opened the
   screen and gave up - reported as "no answer" rather than as a zero-length call,
   because those are different facts and a list full of 0:00 entries would be noise.

   Duration is worked out from the timestamps by callDuration(), never trusted from
   the browser - a number the client sends is a number the client can invent.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { all, toIso } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { callDuration, spokenLength } from '../_lib/calls.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not take calls.');
    }

    /* Which column is me. A room only ever has two sides, so "mine" is the one this
       person is on and the other name comes from the opposite column. Fixed literals
       chosen by role, never anything from the request. */
    const isRep = user.role === 'fr';
    const mineColumn = isRep ? 'fr_person_id' : 'customer_person_id';
    const theirColumn = isRep ? 'customer_person_id' : 'fr_person_id';

    /* LIMIT is interpolated after a Number() and a clamp. That cast is the whole
       defence, and it is a complete one - there is no string left to inject with. */
    let limit = Math.trunc(Number(req.query('limit', '20'))) || 20;
    if (limit < 1) { limit = 20; }
    if (limit > 100) { limit = 100; }

    const rows = await all(
        `SELECT c.*, p.name AS their_name, p.id AS their_id,
                (SELECT COUNT(*) FROM call_transcripts t WHERE t.call_id = c.id) AS line_count
           FROM call_sessions c
           JOIN people p ON p.id = c.${theirColumn}
          WHERE c.${mineColumn} = ?
          ORDER BY c.created_at DESC
          LIMIT ${limit}`,
        [user.person_id]
    );

    const calls = rows.map(row => {
        /* Only a call with a started_at had two people in it. See the header note. */
        const connected = !!row.started_at;
        const seconds = connected ? callDuration(row) : 0;

        return {
            id: Number(row.id),
            withName: row.their_name,
            withId: row.their_id,

            connected,
            seconds,

            /* Pre-formatted, because "4m 12s" is the same everywhere it is shown and
               three screens formatting it themselves would drift. */
            duration: connected ? spokenLength(seconds) : 'No answer',

            lineCount: Number(row.line_count),
            startedAt: toIso(row.started_at),
            endedAt: toIso(row.ended_at),
            createdAt: toIso(row.created_at),
            status: row.status,

            /* Whether this call still has a room somebody could rejoin. Only the very
               latest one ever will, but the browser should not have to work that out
               from the status string. */
            live: row.status !== 'ended'
        };
    });

    return ok({ calls });
});
