/* =============================================================================
   /api/appointment - one appointment: booking it, moving it, changing its state
   -----------------------------------------------------------------------------
   GET  ?id=apt-001                                  -> { appointment, googleUrl, icsUrl }

   POST { action: 'create',     ...details }         -> { appointment }
   POST { action: 'reschedule', id, start, minutes } -> { appointment }
   POST { action: 'confirm',    id }                 -> { appointment }
   POST { action: 'cancel',     id }                 -> { appointment }
   POST { action: 'complete',   id }                 -> { appointment }
   POST { action: 'reopen',     id }                 -> { appointment }
   POST { action: 'regenerate-feed' }                -> { feedUrl }

   Ported from php/api/appointment.php.

   ONE ENDPOINT, ONE APPOINTMENT. Every action loads the row through
   loadAppointment(), which refuses anything that is not the caller's with a 404 -
   so there is no path in here that skips the ownership check, and no chance of one
   being added later by accident.

   THE RULES LIVE IN _lib/appointments.ts, not here. This file reads the request,
   calls the right function, and sends back the fresh row. That is why the response
   always includes the updated appointment: the browser never has to guess what
   changed, or re-derive which buttons should now be available.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    appointmentJson, createAppointment, googleCalendarUrl, loadAppointment,
    regenerateFeedToken, rescheduleAppointment, setAppointmentStatus
} from '../_lib/appointments.js';

const MESSAGES: Record<string, string> = {
    reschedule: 'New time proposed. The other person needs to confirm it.',
    confirm: 'Confirmed. It is in both your calendars.',
    cancel: 'Cancelled. Anybody subscribed to your calendar will see it disappear.',
    complete: 'Marked as done.',
    reopen: 'Reopened. It is back on the calendar as confirmed.'
};

function icsUrlFor(id: unknown): string {
    return `${env.appUrl}/api/calendar?id=${encodeURIComponent(String(id))}`;
}

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not hold appointments.');
    }

    /* ==================================================================
       GET: read one, with its calendar links
       ================================================================== */
    if (req.method === 'GET') {
        const row = await loadAppointment(user, req.query('id'));

        return ok({
            appointment: appointmentJson(row, user),

            /* Built here rather than in the browser. The Google link needs the
               times formatted exactly the way Google expects, and the .ics link has
               to point at the endpoint that checks who is asking - neither is
               something the front end should be assembling by hand. */
            googleUrl: googleCalendarUrl(row),
            icsUrl: icsUrlFor(row.id)
        });
    }

    req.requirePost();

    const action = req.field('action', '');

    /* ==================================================================
       Regenerating the feed token

       Handled before the others because it is the only action with no appointment
       id - it is about the calendar as a whole.

       WHAT IT IS FOR: the feed URL is a password in disguise. Anybody holding it
       can read this person's diary. If it has been shared by accident, this is the
       only way to undo that, and it instantly breaks every copy of the old address.
       ================================================================== */
    if (action === 'regenerate-feed') {
        const token = await regenerateFeedToken(user.id);
        const feedUrl = `${env.appUrl}/api/calendar?feed=${token}`;

        return ok({
            feedUrl,
            webcalUrl: feedUrl.replace(/^https?:/, 'webcal:'),
            message: 'Your old calendar links have stopped working. Subscribe again with ' +
                     'the new address to keep seeing your appointments.'
        });
    }

    /* ==================================================================
       Booking a new one
       ================================================================== */
    if (action === 'create') {
        const id = await createAppointment(user, req.body);
        const row = await loadAppointment(user, id);

        return ok({
            appointment: appointmentJson(row, user),
            googleUrl: googleCalendarUrl(row),
            icsUrl: icsUrlFor(row.id),

            /* Said plainly, because it is the bit people get wrong: proposing a
               time is not the same as agreeing one. */
            message: user.role === 'fr'
                ? 'Sent to your customer to confirm.'
                : 'Sent to your representative to confirm.'
        });
    }

    /* ==================================================================
       Everything else needs an existing appointment
       ================================================================== */
    const row = await loadAppointment(user, req.body.id);

    if (action === 'reschedule') {
        await rescheduleAppointment(user, row, req.body.start, req.body.minutes);

    } else if (['confirm', 'cancel', 'complete', 'reopen'].includes(action)) {
        await setAppointmentStatus(user, row, action);

    } else {
        fail(400, 'Unknown action.');
    }

    /* Re-read, so the browser gets the row as it now is rather than as it was. */
    const fresh = await loadAppointment(user, row.id);

    return ok({
        appointment: appointmentJson(fresh, user),
        googleUrl: googleCalendarUrl(fresh),
        icsUrl: icsUrlFor(fresh.id),
        message: MESSAGES[action] ?? 'Saved.'
    });
});
