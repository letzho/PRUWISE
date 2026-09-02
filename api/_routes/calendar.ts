/* =============================================================================
   GET /api/calendar?feed=<40 characters>   the whole subscribable calendar
   GET /api/calendar?id=apt-001             one event, as a download
   -----------------------------------------------------------------------------
   Ported from php/api/calendar.php.

   The only endpoint in this project that does not answer in JSON. It serves
   iCalendar text, because that is what calendar apps read.

   =============================================================================
   TWO DIFFERENT CALLERS, TWO DIFFERENT WAYS IN
   =============================================================================

   ?id= IS FOR A PERSON. They are signed in and clicked "download", so the session
   cookie is there and we use it. Nothing new needed.

   ?feed= IS FOR A MACHINE. Google Calendar, Outlook or Apple Calendar comes back to
   this URL every few hours, on its own, from its own servers. It has no cookie and
   never will - so THE TOKEN IN THE ADDRESS IS THE AUTHENTICATION.

   That makes the token a password. Which is why:

     - it is 40 random characters, not the account id. An id would let anybody read
       anybody's diary by counting upwards.
     - it can be regenerated through /api/appointment, which instantly kills every
       copy of the old URL. That is the only way to undo sharing one by accident.
     - this endpoint is READ-ONLY and returns nothing but appointments. No name, no
       email, no policy figures - if the URL does leak, what leaks is a diary and
       not an account.
     - there is no "wrong token" message worth having. Anything that is not a live
       token gets the same flat 404.

   =============================================================================
   WHY CANCELLED EVENTS ARE INCLUDED IN THE FEED
   =============================================================================

   Because leaving them out is how a subscribed calendar ends up showing a meeting
   that is not happening. The app does not diff two versions of a file; it reads
   what it is given. An event that simply vanishes may quietly stay put, so it is
   sent with STATUS:CANCELLED and the app strikes it through or removes it.
   ============================================================================= */

import { currentUser } from '../_lib/auth.js';
import { one } from '../_lib/db.js';
import { defineHandler, type ApiResponse } from '../_lib/http.js';
import { buildIcs, feedOwner, feedRows, sweepAppointments } from '../_lib/appointments.js';

/* A plain 404 in plain text. Not JSON: whoever is asking wants a calendar, and the
   JSON envelope would also be a lie about what this endpoint serves. */
function missing(): ApiResponse {
    return {
        kind: 'text',
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: 'Not found.\n',
        headers: { 'Cache-Control': 'no-store' }
    };
}

function calendar(text: string, filename: string): ApiResponse {
    return {
        kind: 'text',
        status: 200,
        contentType: 'text/calendar; charset=utf-8',
        body: text,
        headers: {
            /* attachment makes a browser download it and hand it to the calendar
               app. A subscribed app ignores this header entirely, so it is safe for
               both callers. */
            'Content-Disposition': `attachment; filename="${filename}"`,

            /* NEVER let a proxy or a browser cache a calendar. A stale copy is
               worse than a slow one: it shows somebody a meeting at the wrong time. */
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache'
        }
    };
}

export default defineHandler(async (req) => {

    /* =================================================================
       1. THE SUBSCRIBABLE FEED  (no session - the token is the authentication)
       ================================================================= */
    const feed = req.query('feed');

    if (feed !== '') {
        const owner = await feedOwner(feed);

        /* Unknown token, or the account has gone, or it is suspended. Same answer
           for all three - see the header note. */
        if (!owner || owner.status !== 'active') { return missing(); }

        const scope = {
            role: String(owner.role),
            person_id: String(owner.person_id)
        };

        /* Close anything whose time has passed, so a subscribed calendar reflects
           the same state the app does. Cheap, and it means the two never disagree. */
        await sweepAppointments(scope);

        const rows = await feedRows(scope);

        const text = buildIcs(rows, {
            name: `PRUWise - ${String(owner.name)}`,

            /* See the header comment: silence is how a cancelled meeting lingers. */
            cancelledToo: true
        });

        return calendar(text, 'pruwise.ics');
    }

    /* =================================================================
       2. ONE EVENT, AS A DOWNLOAD  (a signed-in person clicked a button)
       ================================================================= */
    const id = req.query('id');

    if (id !== '') {
        const user = await currentUser(req);

        /* No JSON 401 here. Somebody following a link in a browser should be told
           in words, not handed an API error they cannot read. */
        if (!user) {
            return {
                kind: 'text',
                status: 401,
                contentType: 'text/plain; charset=utf-8',
                body: 'Please sign in to PRUWise first, then use the download button again.\n',
                headers: { 'Cache-Control': 'no-store' }
            };
        }

        const row = await one(
            `SELECT a.*, c.name AS customer_name, r.name AS rep_name
               FROM appointments a
               JOIN people c ON c.id = a.customer_person_id
               JOIN people r ON r.id = a.rep_person_id
              WHERE a.id = ?`,
            [id]
        );

        /* Same 404-not-403 rule as everywhere else. Note this does NOT use
           loadAppointment(), because that fails with a JSON envelope and this
           endpoint must answer in text either way. */
        if (!row) { return missing(); }

        const isMine = row.customer_person_id === user.person_id
            || row.rep_person_id === user.person_id;

        if (!isMine) { return missing(); }

        const text = buildIcs([row], {
            name: String(row.title),
            cancelledToo: true
        });

        /* A filename that means something in a downloads folder. */
        return calendar(text, `pruwise-${String(row.id)}.ics`);
    }

    return missing();
});
