/* =============================================================================
   GET /api/appointments?from=2026-03-01&to=2026-03-31
   GET /api/appointments?upcoming=5
   ->  { appointments, feedUrl, webcalUrl, people, serverTime }
   -----------------------------------------------------------------------------
   Ported from php/api/appointments.php.

   Everything the calendar screen needs in one request.

   =============================================================================
   WHY A DATE RANGE RATHER THAN "ALL"
   =============================================================================

   A month grid only shows a month. Sending an account's entire history to draw
   thirty-one days would get slower every year it was used, for no benefit - and
   the query is an indexed range scan either way.

   `upcoming` is the other shape anybody wants: "what is next", for a dashboard
   that has no grid to fill.

   =============================================================================
   WHAT ELSE COMES BACK
   =============================================================================

     feedUrl    the subscribable calendar address, so the screen can offer it
                without a second request
     webcalUrl  the same address under the webcal:// scheme, which is what makes a
                calendar app offer to SUBSCRIBE rather than a browser offer to
                download. Both are sent so the screen can show a clickable one and
                a copyable one.
     people     who this person can book WITH. For a customer that is exactly one
                representative; for a representative it is their own customers. It
                must come from here rather than from js/data.js - that file is mock
                insurance data and does not know about real accounts.
   ============================================================================= */

import { requireLogin } from '../_lib/auth.js';
import { all, one } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    feedToken, listAppointments, upcomingAppointments
} from '../_lib/appointments.js';

/* YYYY-MM-DD, and nothing else. The value reaches SQL as a ?::date cast, so a
   malformed one would be a database error rather than a message anybody can read -
   and rebuilding it through Date means whatever arrives comes out as a real date or
   the request is refused. */
function readDate(value: string, fallback: Date): { iso: string; ms: number } {
    if (value === '') {
        return { iso: fallback.toISOString().slice(0, 10), ms: fallback.getTime() };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        fail(400, 'Those dates could not be read. Use YYYY-MM-DD.');
    }

    const ms = new Date(`${value}T00:00:00Z`).getTime();

    if (Number.isNaN(ms)) {
        fail(400, 'Those dates could not be read. Use YYYY-MM-DD.');
    }

    return { iso: value, ms };
}

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not hold appointments.');
    }

    /* ------------------------------------------------- which appointments */
    const upcoming = Number(req.query('upcoming', '0')) || 0;

    let appointments: Array<Record<string, unknown>>;

    if (upcoming > 0) {
        appointments = await upcomingAppointments(user, upcoming);

    } else {
        /* Default to the month around today, so a request with no dates still
           returns something sensible rather than an error. */
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

        const from = readDate(req.query('from'), monthStart);
        const to = readDate(req.query('to'), monthEnd);

        if (to.ms < from.ms) {
            fail(400, 'The end date is before the start date.');
        }

        /* A cap, so nobody can ask for a decade in one go. */
        if (to.ms - from.ms > 400 * 86_400_000) {
            fail(400, 'That range is too long. Ask for a year at a time.');
        }

        appointments = await listAppointments(user, from.iso, to.iso);
    }

    /* --------------------------------------------- who they can book with */
    const people: Array<{ personId: string; name: string; sub: string | null }> = [];

    if (user.role === 'fr') {
        const rows = await all<{ id: string; name: string; segment: string | null }>(
            `SELECT id, name, segment FROM people
              WHERE rep_id = ? AND kind = 'customer' AND status <> 'inactive'
              ORDER BY name`,
            [user.person_id]
        );

        for (const row of rows) {
            people.push({ personId: row.id, name: row.name, sub: row.segment });
        }

    } else if (user.rep_id) {
        const rep = await one<{ id: string; name: string }>(
            'SELECT id, name FROM people WHERE id = ?', [user.rep_id]);

        if (rep) {
            people.push({
                personId: rep.id,
                name: rep.name,
                sub: 'Your financial representative'
            });
        }
    }

    const token = await feedToken(user.id);
    const feedUrl = `${env.appUrl}/api/calendar?feed=${token}`;

    return ok({
        appointments,

        feedUrl,

        /* webcal:// is the same URL with a different scheme. A calendar app claims
           it and offers to subscribe; a browser would just download the file once. */
        webcalUrl: feedUrl.replace(/^https?:/, 'webcal:'),

        people,

        /* So the browser can say "today" against the same day the server would. */
        serverTime: new Date().toISOString()
    });
});
