/* =============================================================================
   GET  /api/admin/requests?status=open      the queue of change requests
   POST /api/admin/requests { id, action: 'approve', repId }
   POST /api/admin/requests { id, action: 'decline', reason }
   -----------------------------------------------------------------------------
   Ported from php/api/admin/requests.php.

   When a customer asks for a different representative, this is where it lands.

   APPROVING DOES TWO THINGS AT ONCE - resolve the request AND move the customer -
   so both happen atomically. A request marked approved without the reassignment
   actually happening would be the worst outcome: everybody believes it is done and
   nothing changed.
   ============================================================================= */

import { audit, requireAdmin } from '../../_lib/auth.js';
import { all, batch, one, q, toIso, type Param } from '../../_lib/db.js';
import { env } from '../../_lib/env.js';
import { defineHandler, fail, ok } from '../../_lib/http.js';
import { emailLayout, sendMail } from '../../_lib/mail.js';

export default defineHandler(async (req) => {
    const admin = await requireAdmin(req);

    /* =====================================================================
       GET - the queue
       ===================================================================== */
    if (req.method === 'GET') {
        const status = req.query('status', 'open');

        const known = ['open', 'approved', 'declined', 'withdrawn'].includes(status);

        const where = known ? 'r.status = ?' : '1=1';
        const args: Param[] = known ? [status] : [];

        const rows = await all(
            `SELECT r.*, c.name AS customer_name, c.email AS customer_email, c.first_name,
                    cur.name AS current_rep_name, pref.name AS preferred_rep_name,
                    a.id AS account_id
               FROM rep_change_requests r
               JOIN people c         ON c.id = r.customer_person_id
               LEFT JOIN people cur  ON cur.id = r.current_rep_id
               LEFT JOIN people pref ON pref.id = r.preferred_rep_id
               LEFT JOIN accounts a  ON a.person_id = r.customer_person_id
              WHERE ${where}
              ORDER BY (r.status = 'open') DESC, r.created_at DESC
              LIMIT 200`,
            args
        );

        /* One grouped query for the tab counts rather than four. */
        const counts: Record<string, number> = {
            open: 0, approved: 0, declined: 0, withdrawn: 0
        };

        for (const row of await all<{ status: string; n: string }>(
            'SELECT status, COUNT(*) AS n FROM rep_change_requests GROUP BY status')) {
            counts[row.status] = Number(row.n);
        }

        return ok({
            requests: rows.map(row => ({
                id: Number(row.id),
                reference: row.reference,
                status: row.status,
                customerPersonId: row.customer_person_id,
                customerAccountId: row.account_id === null ? null : Number(row.account_id),
                customerName: row.customer_name,
                customerEmail: row.customer_email,
                currentRepId: row.current_rep_id,
                currentRepName: row.current_rep_name,
                preferredRepId: row.preferred_rep_id,
                preferredRepName: row.preferred_rep_name,
                reason: row.reason,
                notes: row.notes,
                createdAt: toIso(row.created_at),
                resolvedAt: toIso(row.resolved_at)
            })),
            counts
        });
    }

    /* =====================================================================
       POST - resolve one
       ===================================================================== */
    req.requirePost();

    const id = Math.trunc(Number(req.body.id)) || 0;
    const action = req.field('action', '');

    const request = await one(
        `SELECT r.*, c.name AS customer_name, c.email AS customer_email, c.first_name
           FROM rep_change_requests r
           JOIN people c ON c.id = r.customer_person_id
          WHERE r.id = ?`,
        [id]
    );

    if (!request) { fail(404, 'No request with that id.'); }

    if (request.status !== 'open') {
        fail(409, `That request was already ${String(request.status)}.`);
    }

    const customerName = String(request.customer_name);
    const customerPersonId = String(request.customer_person_id);
    const firstName = String(request.first_name || request.customer_name);
    const reference = String(request.reference);


    /* --------------------------------------------------------------- approve */
    if (action === 'approve') {

        /* Use the representative the admin picked, falling back to the one the
           customer asked for. Either way it is validated before anything moves. */
        const repId = req.field('repId', '') || String(request.preferred_rep_id ?? '');

        const newRep = await one<{ id: string; name: string; email: string | null }>(
            `SELECT id, name, email FROM people WHERE id = ? AND kind = 'fr'`, [repId]);

        if (!newRep) {
            fail(400, 'Choose which representative to move them to.', 'repId');
        }
        if (repId === request.current_rep_id) {
            fail(400, 'That is the representative they asked to move away from.', 'repId');
        }

        try {
            await batch(sqlt => [
                sqlt`UPDATE people SET rep_id = ${repId} WHERE id = ${customerPersonId}`,

                /* request_id IS FILLED IN HERE, unlike the consultation accept path -
                   this request really is a rep_change_requests row, which is what that
                   foreign key points at. */
                sqlt`INSERT INTO rep_assignments
                         (customer_person_id, from_rep_id, to_rep_id, request_id)
                     VALUES (${customerPersonId}, ${request.current_rep_id ?? null},
                             ${repId}, ${id})`,

                sqlt`UPDATE rep_change_requests
                        SET status = 'approved', resolved_at = now()
                      WHERE id = ${id} AND status = 'open'`,

                sqlt`INSERT INTO threads (kind, fr_person_id, customer_person_id, last_message_at)
                     VALUES ('human', ${repId}, ${customerPersonId}, now())
                     ON CONFLICT DO NOTHING`
            ]);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Approve request failed:', error);

            fail(500, env.devMode
                ? `Could not approve: ${message}`
                : 'Could not approve that request right now. Please try again.');
        }

        await audit(admin.id, 'admin_approved_rep_change', `${reference} -> ${repId}`, req.ip);

        if (request.customer_email) {
            await sendMail(
                String(request.customer_email),
                `Your request has been approved - ${reference}`,
                emailLayout(
                    'You have a new representative',
                    [
                        `Hello ${firstName},`,
                        `Your request to change representative (${reference}) has been approved.`,
                        `${newRep.name} is now your financial representative.`,
                        'Nothing about your policies, premiums or cover changes. Your file has ' +
                        'been passed across so you will not need to repeat yourself.'
                    ],
                    'Open PRUWise', `${env.appUrl}/index.html`,
                    'If you have any questions, reply to this email or contact client care.'
                )
            );
        }

        return ok({
            message: `Approved. ${customerName} is now with ${newRep.name}.`
        });
    }


    /* --------------------------------------------------------------- decline */
    if (action === 'decline') {
        const reason = req.field('reason', '');

        /* A reason is required. Declining somebody's request without telling them why
           is how a complaint becomes a bigger complaint. */
        if (reason.length < 10) {
            fail(400,
                'Please give a reason of at least 10 characters. It is sent to the customer.',
                'reason');
        }

        const done = await q(
            `UPDATE rep_change_requests
                SET status = 'declined', resolved_at = now(),
                    notes = COALESCE(notes, '') || E'\\n\\nDeclined: ' || ?
              WHERE id = ? AND status = 'open'`,
            [reason, id]
        );

        if (done.rowCount === 0) {
            fail(409, 'That request has just been dealt with somewhere else.');
        }

        await audit(admin.id, 'admin_declined_rep_change', reference, req.ip);

        if (request.customer_email) {
            await sendMail(
                String(request.customer_email),
                `About your request - ${reference}`,
                emailLayout(
                    'We could not approve this request',
                    [
                        `Hello ${firstName},`,
                        'We have reviewed your request to change representative ' +
                        `(${reference}) and cannot approve it at this time.`,
                        `Reason: ${reason}`,
                        'You are welcome to raise this with client care, and you can request ' +
                        'a change again later.'
                    ],
                    null, null,
                    'Your cover, premiums and claim history are unaffected.'
                )
            );
        }

        return ok({ message: `Declined, and ${customerName} has been emailed.` });
    }

    fail(400, `Unknown action "${action}".`);
});
