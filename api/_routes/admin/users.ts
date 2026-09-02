/* =============================================================================
   GET /api/admin/users?q=sarah&role=customer&status=active&sort=created&page=1
   ->  { users, stats, reps, page }
   -----------------------------------------------------------------------------
   Ported from php/api/admin/users.php.

   The user database, as a list. Admins only.

   =============================================================================
   WHAT IS AND IS NOT RETURNED
   =============================================================================

   password_hash is never selected. Not filtered out afterwards - NEVER ASKED FOR
   in the first place, so it cannot be leaked by somebody later adding a "return
   the whole row" shortcut.

   =============================================================================
   WHY THE SEARCH IS SAFE
   =============================================================================

   The search term goes into the query as a bound parameter, wildcards included:

       WHERE username LIKE ?        with the value  '%sarah%'

   The value is never part of the SQL text, so a search for  ' OR 1=1--  finds
   nothing and does nothing. It is just a string with no matches.

   The SORT is different, because a sort direction cannot be a bound parameter. So
   it is a lookup in a fixed table of six known clauses, and anything unrecognised
   falls back to the default. There is no path where a request contributes SQL.
   ============================================================================= */

import { requireAdmin } from '../../_lib/auth.js';
import { all, column, toDateOnly, toIso, type Param } from '../../_lib/db.js';
import { defineHandler, fail, ok } from '../../_lib/http.js';

/* A whitelist, so "sort" can never become a piece of SQL.

   'lastseen' puts NULLs last. Postgres sorts NULLs FIRST on a DESC ordering by
   default, which would have filled the top of a "most recently seen" list with
   people who have never signed in - the MySQL original relied on
   `last_login_at IS NULL, last_login_at DESC`, and NULLS LAST says it directly. */
const SORTS: Record<string, string> = {
    created: 'a.created_at DESC',
    oldest: 'a.created_at ASC',
    name: 'a.name ASC',
    username: 'a.username ASC',
    lastseen: 'a.last_login_at DESC NULLS LAST',
    role: 'a.role ASC, a.name ASC'
};

export default defineHandler(async (req) => {
    await requireAdmin(req);

    /* Read-only. Changing an account goes through /api/admin/user, which is where
       all the guards live - see the header there. Refusing anything but GET here
       means there is no second door to the same data with none of them. */
    if (req.method !== 'GET') {
        fail(405, 'This endpoint only lists accounts. Use /api/admin/user to change one.');
    }

    const search = req.query('q');
    const role = req.query('role');
    const status = req.query('status');
    const sort = req.query('sort', 'created');

    const page = Math.max(1, Math.trunc(Number(req.query('page', '1'))) || 1);
    const perPage = Math.min(100, Math.max(5,
        Math.trunc(Number(req.query('perPage', '25'))) || 25));
    const offset = (page - 1) * perPage;

    const orderBy = SORTS[sort] ?? SORTS.created as string;

    /* Build the WHERE clause. Each condition contributes a placeholder, so the
       values stay separate from the statement no matter which filters are on. */
    const where: string[] = ['1=1'];
    const args: Param[] = [];

    if (search !== '') {
        where.push('(a.username ILIKE ? OR a.name ILIKE ? OR a.email ILIKE ? ' +
                   'OR a.person_id ILIKE ?)');

        /* ILIKE rather than LIKE. MySQL's default collation is case-insensitive so
           the PHP got that behaviour for free; Postgres's LIKE is case-sensitive,
           and a search for "Sarah" that misses sarah.tan is a search box people
           stop trusting. */
        const like = `%${search}%`;
        args.push(like, like, like, like);
    }

    if (['fr', 'customer', 'admin'].includes(role)) {
        where.push('a.role = ?');
        args.push(role);
    }

    if (['active', 'suspended'].includes(status)) {
        where.push('a.status = ?');
        args.push(status);
    }

    const whereSql = where.join(' AND ');

    /* LEFT JOIN on the representative so a customer's adviser can be shown in the
       list without a second query per row. LEFT, not INNER, because a customer
       might have no representative assigned and should still appear. */
    const rows = await all(
        `SELECT a.id, a.person_id, a.role, a.username, a.email, a.name, a.label,
                a.status, a.email_verified, a.created_at, a.last_login_at,
                p.phone, p.rep_id, p.segment, p.client_since,
                rep.name AS rep_name,
                (SELECT COUNT(*) FROM people c WHERE c.rep_id = a.person_id) AS customer_count
           FROM accounts a
           JOIN people p        ON p.id = a.person_id
           LEFT JOIN people rep ON rep.id = p.rep_id
          WHERE ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${perPage} OFFSET ${offset}`,
        args
    );

    const total = Number(await column(
        `SELECT COUNT(*) FROM accounts a JOIN people p ON p.id = a.person_id
          WHERE ${whereSql}`,
        args
    ) ?? 0);

    /* Shape each row for the browser. Explicit field by field - see the note at the
       top about why this is a whitelist and not a filter. */
    const users = rows.map(row => ({
        accountId: Number(row.id),
        personId: row.person_id,
        role: row.role,
        username: row.username,
        name: row.name,
        email: row.email,
        phone: row.phone,
        label: row.label,
        status: row.status,
        emailVerified: row.email_verified === true,
        createdAt: toIso(row.created_at),
        lastLogin: toIso(row.last_login_at),
        repId: row.rep_id,
        repName: row.rep_name,
        segment: row.segment,
        clientSince: toDateOnly(row.client_since),
        customerCount: Number(row.customer_count)
    }));

    /* =====================================================================
       Summary counts for the cards at the top of the page.

       ONE QUERY, NOT EIGHT. The PHP ran a separate COUNT for each figure plus a
       GROUP BY for the roles - nine round trips to draw six numbers. Conditional
       aggregation gets all of it in one pass, which matters more here than it did
       on shared hosting: every round trip is latency a function is billed for.
       ===================================================================== */
    const summary = await all<Record<string, string>>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE role = 'fr')                AS reps,
                COUNT(*) FILTER (WHERE role = 'customer')          AS customers,
                COUNT(*) FILTER (WHERE role = 'admin')             AS admins,
                COUNT(*) FILTER (WHERE status = 'suspended')       AS suspended,
                COUNT(*) FILTER (WHERE email_verified = false)     AS unverified,
                COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')
                                                                   AS new_this_week,
                COUNT(*) FILTER (WHERE last_login_at > now() - INTERVAL '1 day')
                                                                   AS active_today
           FROM accounts`
    );

    const s = summary[0] ?? {};

    const stats = {
        total: Number(s.total ?? 0),
        byRole: {
            fr: Number(s.reps ?? 0),
            customer: Number(s.customers ?? 0),
            admin: Number(s.admins ?? 0)
        },
        suspended: Number(s.suspended ?? 0),
        unverified: Number(s.unverified ?? 0),
        newThisWeek: Number(s.new_this_week ?? 0),
        activeToday: Number(s.active_today ?? 0),

        openRequests: Number(await column(
            `SELECT COUNT(*) FROM rep_change_requests WHERE status = 'open'`) ?? 0),

        failedLogins24h: Number(await column(
            `SELECT COUNT(*) FROM login_attempts
              WHERE succeeded = false AND created_at > now() - INTERVAL '1 day'`) ?? 0)
    };

    /* Every representative, for the "reassign to" dropdown. Cheap, and it saves the
       browser a second request every time somebody opens a customer. */
    const repRows = await all<{ id: string; name: string; customer_count: string }>(
        `SELECT p.id, p.name,
                (SELECT COUNT(*) FROM people c WHERE c.rep_id = p.id) AS customer_count
           FROM people p
          WHERE p.kind = 'fr'
          ORDER BY p.name`
    );

    return ok({
        users,
        stats,
        reps: repRows.map(row => ({
            id: row.id,
            name: row.name,
            customerCount: Number(row.customer_count)
        })),
        page: {
            page,
            perPage,
            total,
            pages: Math.ceil(total / perPage)
        }
    });
});
