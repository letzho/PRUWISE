/* =============================================================================
   GET  /api/call-summary?roomCode=abc123   ->  { summary: { draft, discussed, ... } }
   POST /api/call-summary { roomCode, body } ->  { sent: true }   approve and send
   -----------------------------------------------------------------------------
   Ported from php/api/call-summary.php.

   The end of a call, and the paperwork that normally follows it.

   =============================================================================
   THE PROBLEM THIS SOLVES
   =============================================================================

   A representative finishes a call and now owes two things: a note on the customer
   record, and a message to the customer confirming what was agreed. Both are boring,
   both are done late, and the second one is frequently not done at all - which is how
   a good conversation turns into a customer who is not sure what happens next.

   So the transcript is read, a draft is written, and the representative gets one
   screen with an editable message and a Send button.

   =============================================================================
   WHY IT IS A DRAFT AND NOT AN AUTOMATIC SEND
   =============================================================================

   Nothing leaves without somebody reading it. Two reasons, and the second is the
   serious one:

     1. Speech recognition mis-hears things. A summary built on "I want to cancel" when
        they said "I want to can-, well, actually keep it" would be a disaster to send
        unreviewed.

     2. A MESSAGE FROM A REPRESENTATIVE TO A CUSTOMER ABOUT THEIR POLICIES IS A
        REGULATED COMMUNICATION. It is written in their name and lands in their
        conversation. The representative is accountable for it, so the representative
        approves it. The draft saves them the typing, not the responsibility.

   The wording is deliberately conservative for the same reason - see summaryBuild() in
   _lib/copilot.ts, which reports what was discussed and never asserts what was agreed.

   =============================================================================
   WHAT SENDING ACTUALLY DOES
   =============================================================================

   Two writes, atomically:

     messages    the summary as a normal message in the thread they already use, so it
                 is still there in a month next to everything else.
     call_notes  the representative's own record of the call.

   Nothing bespoke, nothing that only exists while the call screen is open.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { batch, one, toIso } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { callDuration, callTranscript, loadCall } from '../_lib/calls.js';
import { summaryBuild } from '../_lib/copilot.js';
import { humanThread } from '../_lib/threads.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* Representatives only.

       A customer has no summary to write - they are the one being written to. They DO
       see the result, because it arrives as an ordinary message in their thread, which
       is the right way for them to receive it. */
    if (user.role !== 'fr') {
        fail(403, 'Call summaries are written by the financial representative.');
    }

    const roomCode = req.method === 'GET'
        ? req.query('roomCode')
        : req.field('roomCode', '');

    if (roomCode === '') {
        fail(400, 'Which call?', 'roomCode');
    }

    /* loadCall() refuses a room this account is not part of, and does it by returning
       nothing rather than explaining - see the note on it in _lib/calls.ts about why
       "no such call" and "not your call" should look identical. */
    const session = await loadCall(user, roomCode);

    /* The other person. Needed for the name in the draft, and for which thread the
       message goes into. */
    const customer = await one<{ id: string; name: string; first_name: string | null }>(
        'SELECT id, name, first_name FROM people WHERE id = ?',
        [String(session.customer_person_id)]
    );

    if (!customer) {
        fail(404, 'The customer on that call no longer exists.');
    }

    /* THE KEY THAT DECIDES WHETHER A SECOND SEND REPLACES THE FIRST.

       The appointment id when the call came from a booked meeting, the room code
       otherwise. A re-send for the same meeting is a correction and replaces the note;
       two ad-hoc calls are two separate events and both are kept. See the long note
       above call_notes in db/schema.sql - getting this wrong loses notes silently. */
    const callKey = session.appointment_id
        ? String(session.appointment_id)
        : String(session.room_code);

    /* =====================================================================
       GET - build the draft
       ===================================================================== */
    if (req.method === 'GET') {

        /* The representative's own view of the transcript. callTranscript() filters
           PRUWise lines to the account they were generated for, so this is what THEY
           saw - which is the honest thing to summarise. */
        const lines = await callTranscript(session, user.id, 0, 400);

        const minutes = Math.round(callDuration(session) / 60);

        const summary = summaryBuild(lines, customer.name, minutes);

        /* Whether a summary has already been sent for this call. Sending twice is
           allowed - a correction is a legitimate thing - but the screen should say so
           rather than letting somebody do it by accident. */
        const note = await one<{ updated_at: unknown }>(
            'SELECT updated_at FROM call_notes WHERE account_id = ? AND call_key = ?',
            [user.id, callKey]
        );

        return ok({
            summary,
            customerName: customer.name,
            alreadySent: note ? toIso(note.updated_at) : null
        });
    }

    /* =====================================================================
       POST - approve and send
       ===================================================================== */
    req.requirePost();

    /* The body AS THE REPRESENTATIVE EDITED IT, not as we generated it.

       Re-generating here and ignoring what was submitted would silently discard their
       corrections, which is the worst possible behaviour for a feature whose entire
       premise is "check this before it goes". */
    const body = req.field('body', '');

    if (body === '') {
        fail(400, 'The summary is empty. Write something, or cancel.', 'body');
    }
    if (body.length > 4000) {
        fail(400, 'That is too long for a message. Keep it under 4000 characters.', 'body');
    }

    /* One resolved thread for the pair, created on first use. humanThread() is the same
       helper the messages screen uses, so this cannot end up in a different
       conversation from the one they actually read. */
    const thread = await humanThread(user.person_id, String(session.customer_person_id));

    if (!thread) {
        fail(500, 'Could not open the conversation to send this into.');
    }

    try {
        await batch(sqlt => [
            /* 1. The message. Marked with a client_ref built from the room code so a
                  double-tap on a slow connection cannot post it twice.

                  ON CONFLICT DO NOTHING rather than letting the unique constraint
                  throw, because inside a batch a raised error rolls back the note as
                  well - and a second send is a correction, which should update the
                  note even when the message is already there. */
            sqlt`INSERT INTO messages
                     (thread_id, sender_account_id, sender_kind, body, client_ref)
                 VALUES (${thread.id}, ${user.id}, 'account', ${body},
                         ${`summary-${String(session.room_code)}`})
                 ON CONFLICT (client_ref) DO NOTHING`,

            sqlt`UPDATE threads SET last_message_at = now() WHERE id = ${thread.id}`,

            /* 2. The representative's own record. ON CONFLICT because a second send
                  for the same call is a correction and should replace the note rather
                  than fail. */
            sqlt`INSERT INTO call_notes (account_id, appointment_id, call_key, body)
                 VALUES (${user.id}, ${session.appointment_id ?? null}, ${callKey}, ${body})
                 ON CONFLICT (account_id, call_key)
                 DO UPDATE SET body = EXCLUDED.body, updated_at = now()`
        ]);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Call summary failed:', error);

        fail(500, env.devMode
            ? `Could not send the summary: ${message}`
            : 'Could not send the summary. Your notes have not been saved - please try again.');
    }

    await audit(user.id, 'call_summary_sent', `room=${String(session.room_code)}`, req.ip);

    return ok({
        sent: true,
        threadId: thread.id,
        message: `Summary sent to ${customer.first_name ?? customer.name} ` +
                 'and saved to your notes.'
    });
});
