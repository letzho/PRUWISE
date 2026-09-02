/* =============================================================================
   POST /api/call-end  {  roomCode  }  ->  { seconds, lines, transcript }
   -----------------------------------------------------------------------------
   Ported from php/api/call-end.php.

   Hanging up. EITHER SIDE MAY END THE CALL - a customer is not trapped in one
   because the representative has not pressed the button.

   WHY THE DURATION COMES FROM HERE. The browser knows how long its own clock ran,
   but that is the time since the page opened, not the time the two of them were
   connected - and it is a number the person on the keyboard could change. started_at
   and ended_at are stamped by the database, so the figure in the summary is the real
   one.

   THE TRANSCRIPT IS NOT DELETED. The signalling mailbox is thrown away, because a
   list of expired network routes is worthless. The transcript is the record of the
   conversation and stays, which is what lets it be attached to the customer's file
   afterwards.

   HOW THE OTHER SIDE FINDS OUT: not with a "bye" message. /api/call-sync already
   reports the room's status on every poll, so the other browser sees ended:true
   within about a second and tears its connection down tidily.

   A bye row would also be pointless here - finishCall empties the mailbox, which
   would delete the message on the way out. One source of truth, the status on the
   session, beats a message that has to survive its own cleanup.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { column } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    callDuration, callTranscript, finishCall, loadCall, reloadCall
} from '../_lib/calls.js';
import { addMessage, resolveThread } from '../_lib/threads.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not take calls.');
    }

    const session = await loadCall(user, req.body.roomCode);

    await finishCall(session);

    const finished = await reloadCall(Number(session.id));
    const seconds = callDuration(finished);

    await audit(user.id, 'call.end',
        `room ${String(finished.room_code)}, ${seconds}s`, req.ip);

    const lines = Number(await column(
        `SELECT COUNT(*) FROM call_transcripts WHERE call_id = ? AND who = 'person'`,
        [Number(finished.id)]
    ) ?? 0);

    /* =========================================================================
       THE CALL LOG, WHERE PEOPLE WILL ACTUALLY SEE IT

       /api/calls has always returned a call history and the representative's call
       screen has always drawn it. That is a list on a screen you have to go to,
       and nobody goes to it - so in practice a call left no trace at all in the
       place both people already read every day.

       So every call that ends now writes a LINE IN THE CONVERSATION, the way a
       phone shows a missed call in the message thread. It is a 'system' message,
       so it renders as the grey centred note rather than as anybody's words, and
       BOTH SIDES SEE THE SAME ROW because there is only one row.

       WHY THE DURATION AND THE LINE COUNT AND NOTHING ELSE. What was said is in
       the transcript, and the transcript is not something to paste into a
       conversation - it is long, it is imperfect, and one side may have had a
       private assistant note in their copy. "You spoke for four minutes" is the
       part that is true for both of them.

       clientRef IS THE ROOM CODE, which makes this idempotent. Either side may
       hang up, and both browsers may post to this endpoint - a customer pressing
       End at the same moment as the representative. The unique constraint on
       client_ref turns the second one into a no-op instead of a second entry.
       ========================================================================= */
    /* A call that never connected is not worth a line. Somebody dialling and
       hanging up before the other side answered has not had a conversation, and a
       log full of "0 seconds" entries buries the real ones. */
    if (seconds >= 10) {
        const minutes = Math.round(seconds / 60);

        const howLong = seconds < 60
            ? `${seconds} seconds`
            : `${minutes} minute${minutes === 1 ? '' : 's'}`;

        /* call_sessions holds the two person ids, not a thread id - a room is
           created from a diary entry or from a name, never from a conversation. So
           the thread is resolved from the OTHER person, which is the same lookup
           the chat screen does when a representative clicks a client's name. */
        const otherPersonId = String(finished.fr_person_id) === user.person_id
            ? String(finished.customer_person_id)
            : String(finished.fr_person_id);

        try {
            const thread = await resolveThread(user, { withPerson: otherPersonId });

            await addMessage(thread.id, {
                senderKind: 'system',
                clientRef: `call-ended-${String(finished.room_code)}`,
                body: `Video call ended - ${howLong}` +
                      (lines > 0
                          ? `, ${lines} line${lines === 1 ? '' : 's'} transcribed.`
                          : '. Nothing was transcribed.')
            });

        } catch {
            /* NEVER FAILS THE HANG-UP. The call is over either way, and refusing to
               close the screen because a log line could not be written would be the
               tail wagging the dog. resolveThread() throws an HTTP error for a pair
               that cannot have a conversation, which is not a state this endpoint
               should be discovering - but if it ever is, the caller still gets its
               duration back. */
        }
    }

    return ok({
        seconds,
        lines,

        /* The whole thing, so the summary can offer it for the notes without another
           request. */
        transcript: await callTranscript(finished, user.id, 0)
    });
});
