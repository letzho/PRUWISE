/* =============================================================================
   GET /api/admin/audit?action=login&page=1
   ->  { entries, failures, actions, page }
   -----------------------------------------------------------------------------
   Ported from php/api/admin/audit.php.

   The activity log: who did what, when, from where.

   Two sources, shown together:
     audit_log       deliberate actions - logins, password changes, admin work
     login_attempts  failed sign-ins, which is the interesting security signal

   READ-ONLY. There is no endpoint to edit or delete a log entry, which is the whole
   reason a log is worth keeping. An admin can see it and nothing else.
   ============================================================================= */

import { requireAdmin } from '../../_lib/auth.js';
import { all, column, toIso, type Param } from '../../_lib/db.js';
import { defineHandler, fail, ok } from '../../_lib/http.js';

export default defineHandler(async (req) => {
    await requireAdmin(req);

    /* READ-ONLY MEANS READ-ONLY, and it is worth saying so in the protocol rather
       than only in a comment.

       Without this the handler would happily answer a POST with the log, because it
       never looks at the method. Nothing would be written - there is no code here
       that writes - but "this endpoint accepts POST" is exactly the sort of thing
       somebody later takes as permission to add a delete action to. A 405 is the
       cheapest way to record that the decision was deliberate. */
    if (req.method !== 'GET') {
        fail(405, 'The activity log is read-only. There is no way to change an entry.');
    }

    const page = Math.max(1, Math.trunc(Number(req.query('page', '1'))) || 1);
    const perPage = Math.min(200, Math.max(10,
        Math.trunc(Number(req.query('perPage', '60'))) || 60));
    const offset = (page - 1) * perPage;

    const action = req.query('action');

    const where: string[] = ['1=1'];
    const args: Param[] = [];

    if (action !== '') {
        where.push('l.action ILIKE ?');
        args.push(`%${action}%`);
    }

    const whereSql = where.join(' AND ');

    /* LEFT JOIN because audit rows survive the account they refer to - account_id is
       ON DELETE SET NULL. A deleted user's history is exactly what you want to still
       be able to read. */
    const rows = await all(
        `SELECT l.id, l.action, l.detail, l.ip, l.created_at,
                l.account_id, a.username, a.name, a.role
           FROM audit_log l
           LEFT JOIN accounts a ON a.id = l.account_id
          WHERE ${whereSql}
          ORDER BY l.id DESC
          LIMIT ${perPage} OFFSET ${offset}`,
        args
    );

    const total = Number(await column(
        `SELECT COUNT(*) FROM audit_log l WHERE ${whereSql}`, args) ?? 0);

    /* Recent failures, worth seeing at a glance rather than hunting for. */
    const failures = await all<{ username: string; ip: string | null; created_at: unknown }>(
        `SELECT username, ip, created_at FROM login_attempts
          WHERE succeeded = false
            AND created_at > now() - INTERVAL '7 days'
          ORDER BY id DESC LIMIT 40`
    );

    /* The distinct action names actually present, so the filter dropdown lists what
       exists rather than a hard-coded guess that drifts out of date. */
    const actions = await all<{ action: string; n: string }>(
        'SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY action');

    return ok({
        entries: rows.map(row => ({
            id: Number(row.id),
            action: row.action,
            detail: row.detail,
            ip: row.ip,
            at: toIso(row.created_at),
            accountId: row.account_id === null ? null : Number(row.account_id),
            username: row.username,
            name: row.name,
            role: row.role
        })),

        failures: failures.map(row => ({
            username: row.username,
            ip: row.ip,
            at: toIso(row.created_at)
        })),

        actions: actions.map(row => ({ action: row.action, count: Number(row.n) })),

        page: { page, perPage, total, pages: Math.ceil(total / perPage) }
    });
});
