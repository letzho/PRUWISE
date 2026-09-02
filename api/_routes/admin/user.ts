/* =============================================================================
   GET  /api/admin/user?id=4          one account, in full
   POST /api/admin/user { id, action, ... }

   Actions:
     suspend        block sign-in, keep the data
     activate       undo a suspension
     signout        end their sessions on every device
     verify-email   mark the address confirmed by hand
     send-reset     email them a password reset link
     reassign-rep   move a customer to a different representative
     delete         remove the account and everything it owns
   -----------------------------------------------------------------------------
   Ported from php/api/admin/user.php.

   =============================================================================
   THE RULES THAT PROTECT AGAINST MISTAKES
   =============================================================================

   An admin console is where one careless click does real damage, so several things
   are refused outright:

     - you cannot suspend, delete or sign out your own account
       (locking yourself out of the only admin account is unrecoverable)
     - you cannot remove the last remaining admin
     - delete needs confirm:true AND the exact username typed back
     - an admin can never read or set a password, only send a reset link

   THAT LAST ONE MATTERS. There is deliberately no "set this user's password"
   action, because then an admin could sign in as a customer and act as them.
   Sending a reset link means only the account owner ever knows the password.
   ============================================================================= */

import {
    audit, hashToken, newToken, requireAdmin
} from '../../_lib/auth.js';
import { all, batch, column, one, q, toDateOnly, toIso } from '../../_lib/db.js';
import { env } from '../../_lib/env.js';
import { defineHandler, fail, ok } from '../../_lib/http.js';
import { emailLayout, sendMail } from '../../_lib/mail.js';

const RESET_MINUTES = 60;

/* One place that answers "would this leave us with no admins?", used by both
   suspend and delete. Counting the OTHER active admins is the clear way to ask. */
async function otherActiveAdmins(excludeAccountId: number): Promise<number> {
    return Number(await column(
        `SELECT COUNT(*) FROM accounts
          WHERE role = 'admin' AND status = 'active' AND id <> ?`,
        [excludeAccountId]
    ) ?? 0);
}

export default defineHandler(async (req) => {
    const admin = await requireAdmin(req);

    /* =====================================================================
       GET - the full picture of one account
       ===================================================================== */
    if (req.method === 'GET') {
        const id = Math.trunc(Number(req.query('id', '0'))) || 0;

        const row = await one(
            `SELECT a.id, a.person_id, a.role, a.username, a.email, a.name, a.label, a.note,
                    a.status, a.email_verified, a.session_epoch, a.created_at, a.updated_at,
                    a.last_login_at,
                    p.kind, p.first_name, p.phone, p.rep_id, p.segment, p.client_since,
                    rep.name AS rep_name
               FROM accounts a
               JOIN people p        ON p.id = a.person_id
               LEFT JOIN people rep ON rep.id = p.rep_id
              WHERE a.id = ?`,
            [id]
        );

        if (!row) { fail(404, 'No account with that id.'); }

        const personId = String(row.person_id);

        /* Everything this person is connected to. Useful on its own, and it is also
           what a delete would destroy - so it doubles as the warning.

           ONE QUERY, not six. Six scalar sub-selects in a single statement cost one
           round trip instead of six, and they read as a list of the same question
           asked six ways. */
        const counts = await one<Record<string, string>>(
            `SELECT
                (SELECT COUNT(*) FROM appointments
                  WHERE customer_person_id = ? OR rep_person_id = ?)      AS appointments,
                (SELECT COUNT(*) FROM messages WHERE sender_account_id = ?) AS messages_sent,
                (SELECT COUNT(*) FROM threads
                  WHERE owner_account_id = ? OR fr_person_id = ?
                     OR customer_person_id = ?)                          AS conversations,
                (SELECT COUNT(*) FROM people WHERE rep_id = ?)           AS customers,
                (SELECT COUNT(*) FROM ratings WHERE customer_person_id = ?) AS ratings_given,
                (SELECT COUNT(*) FROM ratings WHERE rep_person_id = ?)    AS ratings_got`,
            [personId, personId, id, id, personId, personId, personId, personId, personId]
        );

        const activity = {
            appointments: Number(counts?.appointments ?? 0),
            messagesSent: Number(counts?.messages_sent ?? 0),
            conversations: Number(counts?.conversations ?? 0),
            customers: Number(counts?.customers ?? 0),
            ratingsGiven: Number(counts?.ratings_given ?? 0),
            ratingsGot: Number(counts?.ratings_got ?? 0)
        };

        /* Recent sign-in attempts, so "why can they not get in?" has an answer. */
        const attempts = await all<{ succeeded: boolean; ip: string | null; created_at: unknown }>(
            `SELECT succeeded, ip, created_at FROM login_attempts
              WHERE username = ? ORDER BY id DESC LIMIT 10`,
            [String(row.username)]
        );

        const auditRows = await all(
            `SELECT action, detail, ip, created_at FROM audit_log
              WHERE account_id = ? ORDER BY id DESC LIMIT 20`,
            [id]
        );

        const assignments = await all(
            `SELECT ra.from_rep_id, ra.to_rep_id, ra.changed_at,
                    f.name AS from_name, t.name AS to_name
               FROM rep_assignments ra
               LEFT JOIN people f ON f.id = ra.from_rep_id
               LEFT JOIN people t ON t.id = ra.to_rep_id
              WHERE ra.customer_person_id = ?
              ORDER BY ra.id DESC LIMIT 10`,
            [personId]
        );

        return ok({
            user: {
                accountId: Number(row.id),
                personId,
                role: row.role,
                kind: row.kind,
                username: row.username,
                name: row.name,
                firstName: row.first_name,
                email: row.email,
                phone: row.phone,
                label: row.label,
                note: row.note,
                status: row.status,
                emailVerified: row.email_verified === true,
                sessionEpoch: Number(row.session_epoch),
                createdAt: toIso(row.created_at),
                updatedAt: toIso(row.updated_at),
                lastLogin: toIso(row.last_login_at),
                repId: row.rep_id,
                repName: row.rep_name,
                segment: row.segment,
                clientSince: toDateOnly(row.client_since),
                isSelf: Number(row.id) === admin.id
            },
            activity,
            attempts: attempts.map(a => ({
                succeeded: a.succeeded === true,
                ip: a.ip,
                at: toIso(a.created_at)
            })),
            audit: auditRows.map(a => ({
                action: a.action, detail: a.detail, ip: a.ip, at: toIso(a.created_at)
            })),
            assignments: assignments.map(a => ({
                from: a.from_name, to: a.to_name, at: toIso(a.changed_at)
            }))
        });
    }

    /* =====================================================================
       POST - change something
       ===================================================================== */
    req.requirePost();

    const id = Math.trunc(Number(req.body.id)) || 0;
    const action = req.field('action', '');

    const target = await one(
        `SELECT a.*, p.name AS person_name, p.rep_id, p.first_name, p.kind
           FROM accounts a JOIN people p ON p.id = a.person_id
          WHERE a.id = ?`,
        [id]
    );

    if (!target) { fail(404, 'No account with that id.'); }

    const isSelf = Number(target.id) === admin.id;
    const username = String(target.username);
    const name = String(target.name);
    const personId = String(target.person_id);
    const firstName = String(target.first_name || target.name);


    /* ------------------------------------------------------------ suspend */
    if (action === 'suspend') {
        if (isSelf) {
            fail(400, 'You cannot suspend your own account.');
        }
        if (target.role === 'admin' && await otherActiveAdmins(id) === 0) {
            fail(400, 'That is the only active administrator. Create another one first.');
        }

        /* Bump the epoch AND delete the session rows, or a suspended person keeps
           working until their browser tab is closed. Suspension has to take effect
           now.

           The PHP could only bump the epoch, because sessions were files on disk it
           had no index into. Rows can be deleted. */
        await q(
            `UPDATE accounts SET status = 'suspended', session_epoch = session_epoch + 1
              WHERE id = ?`, [id]);

        await q('DELETE FROM sessions WHERE account_id = ?', [id]);

        await audit(admin.id, 'admin_suspended_user', username, req.ip);

        return ok({ message: `${name} has been suspended and signed out.` });
    }

    /* ----------------------------------------------------------- activate */
    if (action === 'activate') {
        await q(`UPDATE accounts SET status = 'active' WHERE id = ?`, [id]);

        await audit(admin.id, 'admin_activated_user', username, req.ip);

        return ok({ message: `${name} can sign in again.` });
    }

    /* ------------------------------------------------------------ signout */
    if (action === 'signout') {
        if (isSelf) {
            fail(400, 'To sign yourself out everywhere, use Settings.');
        }

        await q('UPDATE accounts SET session_epoch = session_epoch + 1 WHERE id = ?', [id]);
        await q('DELETE FROM sessions WHERE account_id = ?', [id]);

        await audit(admin.id, 'admin_signed_out_user', username, req.ip);

        return ok({ message: `${name} has been signed out on every device.` });
    }

    /* ------------------------------------------------------- verify-email */
    if (action === 'verify-email') {
        await q('UPDATE accounts SET email_verified = true WHERE id = ?', [id]);

        await audit(admin.id, 'admin_verified_email', username, req.ip);

        return ok({ message: 'Email address marked as confirmed.' });
    }

    /* --------------------------------------------------------- send-reset

       Exactly the same token mechanism as the public forgot-password flow: random
       token, only its hash stored, single use, expires. THE ADMIN NEVER SEES IT -
       the email goes to the account holder. */
    if (action === 'send-reset') {
        const token = newToken();

        await batch(sqlt => [
            sqlt`UPDATE password_resets SET used_at = now()
                  WHERE account_id = ${id} AND used_at IS NULL`,

            sqlt`INSERT INTO password_resets (account_id, token_hash, expires_at, request_ip)
                 VALUES (${id}, ${hashToken(token)},
                         now() + INTERVAL '60 minutes', ${req.ip})`
        ]);

        const resetUrl = `${env.appUrl}/index.html#/reset-password?token=${token}`;

        const route = await sendMail(
            String(target.email),
            'Set a new PRUWise password',
            emailLayout(
                'Set a new password',
                [
                    `Hello ${firstName},`,
                    'An administrator has started a password reset for your PRUWise account ' +
                    `(${username}).`,
                    'Use the button below to choose a new password. The link works once and ' +
                    `expires in ${RESET_MINUTES} minutes.`
                ],
                'Choose a new password',
                resetUrl,
                'If you were not expecting this, contact client care before using the link.'
            )
        );

        await audit(admin.id, 'admin_sent_reset',
            `${username} route=${route === false ? 'failed' : route}`, req.ip);

        return ok({
            message: route === 'log'
                ? 'Reset link created. No mail provider is configured, so it was written to ' +
                  'the function log.'
                : `A reset link has been emailed to ${String(target.email)}.`,
            emailRoute: route === false ? 'failed' : route,
            devLink: env.devMode ? resetUrl : null
        });
    }

    /* ------------------------------------------------------ reassign-rep

       Writes history as well as the new value. rep_assignments is what makes the
       "at most one change in 12 months" rule checkable - without it, the rule had
       nothing to read. */
    if (action === 'reassign-rep') {
        if (target.role !== 'customer') {
            fail(400, 'Only customers are assigned to a representative.');
        }

        const newRepId = req.field('repId', '');

        const newRep = await one<{ id: string; name: string }>(
            `SELECT id, name FROM people WHERE id = ? AND kind = 'fr'`, [newRepId]);

        if (!newRep) {
            fail(400, 'That is not a valid representative.', 'repId');
        }
        if (newRepId === target.rep_id) {
            fail(400, `${name} is already assigned to ${newRep.name}.`);
        }

        try {
            await batch(sqlt => [
                sqlt`UPDATE people SET rep_id = ${newRepId} WHERE id = ${personId}`,

                sqlt`INSERT INTO rep_assignments (customer_person_id, from_rep_id, to_rep_id)
                     VALUES (${personId}, ${target.rep_id ?? null}, ${newRepId})`,

                /* Open the conversation with the new representative, so the handover
                   does not land them in an empty Messages screen. ON CONFLICT DO
                   NOTHING because the pair may have talked before. */
                sqlt`INSERT INTO threads (kind, fr_person_id, customer_person_id, last_message_at)
                     VALUES ('human', ${newRepId}, ${personId}, now())
                     ON CONFLICT DO NOTHING`
            ]);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Reassign failed:', error);

            fail(500, env.devMode
                ? `Could not reassign: ${message}`
                : 'Could not reassign right now. Please try again.');
        }

        await audit(admin.id, 'admin_reassigned_rep', `${username} -> ${newRepId}`, req.ip);

        /* Tell the customer, because this changes who advises them. */
        await sendMail(
            String(target.email),
            'Your PRUWise representative has changed',
            emailLayout(
                'You have a new representative',
                [
                    `Hello ${firstName},`,
                    `${newRep.name} is now your financial representative.`,
                    'Nothing about your policies, premiums or cover changes. Your file has ' +
                    'been passed across so you will not need to repeat yourself.'
                ],
                'Open PRUWise', `${env.appUrl}/index.html`,
                'If you have questions about this change, contact client care.'
            )
        );

        return ok({ message: `${name} is now assigned to ${newRep.name}.` });
    }

    /* ------------------------------------------------------------- delete

       Destructive and not undoable. The foreign keys cascade, so this also removes
       their messages, their threads, their appointments and their ratings. Three
       separate guards, because the cost of getting it wrong is somebody's data. */
    if (action === 'delete') {
        if (isSelf) {
            fail(400, 'You cannot delete your own account.');
        }
        if (target.role === 'admin' && await otherActiveAdmins(id) === 0) {
            fail(400, 'That is the only other administrator. Create another one first.');
        }
        if (req.body.confirm !== true) {
            fail(400, 'Deletion needs to be confirmed.');
        }

        /* THE USERNAME HAS TO BE TYPED BACK EXACTLY. A confirm flag alone can be sent
           by a mis-wired button; typing the name cannot happen by accident. */
        if (req.field('confirmUsername', '') !== username) {
            fail(400, 'The username you typed does not match. Nothing was deleted.',
                'confirmUsername');
        }

        try {
            /* Hand any customers to another representative rather than orphaning
               them. ON DELETE SET NULL on people.rep_id would leave them
               adviserless with no record of why.

               ONE STATEMENT, and it is safe when there is no replacement: the
               UPDATE's FROM finds no row, so it changes nothing and the DELETE still
               runs. The PHP read the replacement first and branched. */
            if (target.kind === 'fr') {
                await q(
                    `UPDATE people
                        SET rep_id = replacement.id
                       FROM (SELECT id FROM people
                              WHERE kind = 'fr' AND id <> ? ORDER BY id LIMIT 1) AS replacement
                      WHERE people.rep_id = ?`,
                    [personId, personId]
                );
            }

            /* accounts cascades from people, and everything else cascades from those. */
            await q('DELETE FROM people WHERE id = ?', [personId]);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Admin delete failed:', error);

            fail(500, env.devMode
                ? `Could not delete: ${message}`
                : 'Could not delete that account. Please try again.');
        }

        await audit(admin.id, 'admin_deleted_user', username, req.ip);

        return ok({ message: `${username} and all their data have been deleted.` });
    }

    fail(400, `Unknown action "${action}".`);
});
