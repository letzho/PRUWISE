/* =============================================================================
   POST /api/delete-account  {  password, confirm: 'DELETE'  }
   -----------------------------------------------------------------------------
   Ported from php/api/delete-account.php.

   Closes an account permanently and signs the person out.

   =============================================================================
   WHY THE PASSWORD IS REQUIRED
   =============================================================================

   Deletion is the one action that cannot be undone, so it must not be possible from
   a session somebody left open on a shared laptop. Asking for the password proves
   the person pressing the button is the account holder and not whoever sat down
   next.

   A Google-only account has no password to check. For those we require the typed
   confirmation only - there is nothing else to verify against, and refusing to let
   them delete at all would be worse.

   =============================================================================
   WHAT ACTUALLY HAPPENS TO THE DATA
   =============================================================================

   The `people` row is deleted, and every foreign key that points at it is ON DELETE
   CASCADE - so the account, preferences, sessions, assessments, consultation
   requests, policies, appointments, threads, messages and attachments all go with
   it. One DELETE, no orphans left behind.

   TWO THINGS ARE DELIBERATELY KEPT:

     audit_log   account_id is ON DELETE SET NULL, so the record that somebody
                 signed in from an address at a time survives the account. That is
                 the point of an audit log - it must not be erasable by the person
                 it describes.

     a representative's own meeting notes
                 Their working record. Messages themselves go, because they belong
                 to both people and the customer is entitled to have theirs removed.

   =============================================================================
   WHO MAY NOT DO THIS
   =============================================================================

   An ADMINISTRATOR cannot delete themselves here. Deleting the last admin would
   leave the system with nobody able to manage users, which is a hole you cannot
   climb out of without database access. Admins are removed by another admin.
   ============================================================================= */

import { audit, endSession, requireLogin, verifyPassword } from '../_lib/auth.js';
import { column, q } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

export default defineHandler(async (req, res) => {
    const user = await requireLogin(req);
    req.requirePost();

    /* ------------------------------------------------------------------------
       DEMO MODE: Protect demo accounts from deletion
       ------------------------------------------------------------------------ */
    const DEMO_ACCOUNTS = [
        'sarah.tan@example.sg',
        'kristin.henessy@navigator-demo.sg',
        'admin@navigator-demo.sg'
    ];

    if (DEMO_ACCOUNTS.includes(user.username.toLowerCase())) {
        fail(403, 
            'Demo accounts cannot be deleted. This account is protected for presentation purposes.');
    }

    /* ------------------------------------------------------------------------
       Refuse the cases that would break the system
       ------------------------------------------------------------------------ */

    if (user.role === 'admin') {
        fail(403,
            'An administrator cannot delete their own account. Ask another administrator ' +
            'to remove it, so the system is never left without one.');
    }

    /* A representative with customers assigned to them would leave those customers
       with a dangling rep_id. The customers have to be moved first, and only an
       admin can do that - so this is a refusal with an instruction, not a wall. */
    if (user.role === 'fr') {
        const customers = Number(await column(
            `SELECT COUNT(*) FROM people WHERE rep_id = ? AND kind = 'customer'`,
            [user.person_id]
        ) ?? 0);

        if (customers > 0) {
            fail(409,
                `You still have ${customers} customer${customers === 1 ? '' : 's'} ` +
                'assigned to you. An administrator needs to move them to another ' +
                'representative before your account can be closed.');
        }
    }

    /* ------------------------------------------------------------------------
       Prove it is really them
       ------------------------------------------------------------------------ */

    /* The typed word. Not a checkbox, on purpose: a checkbox next to a red button
       is something you tick without reading. Typing DELETE is a moment of thought. */
    const confirm = req.field('confirm', '').toUpperCase();

    if (confirm !== 'DELETE') {
        fail(400, 'Type DELETE in the box to confirm.', 'confirm');
    }

    /* A password account must give its password. A Google-only account has none -
       password_hash is a placeholder no password can ever match - so there is
       nothing to check and the typed confirmation stands on its own. */
    const hasPassword = user.password_hash !== '' && user.password_hash !== 'NEEDS_SETUP';

    if (hasPassword) {
        const password = req.field('password', '');

        if (password === '') {
            fail(400, 'Please enter your password to confirm.', 'password');
        }

        /* Constant-time, never ===. See the note in auth.ts. */
        if (!await verifyPassword(password, user.password_hash)) {
            fail(401, 'That password is not correct.', 'password');
        }
    }

    /* ------------------------------------------------------------------------
       Do it

       The audit entry is written BEFORE the delete. Afterwards there is no
       account_id left to attach it to - the row would be written with a null and
       lose the one detail that makes it worth having.
       ------------------------------------------------------------------------ */

    await audit(user.id, 'account_deleted',
        `role=${user.role} username=${user.username}`, req.ip);

    try {
        /* ONE DELETE. Every table that references this person cascades from here -
           see the foreign keys in db/schema.sql. Deleting the account row instead
           would leave the `people` row behind with nothing able to sign into it. */
        await q('DELETE FROM people WHERE id = ?', [user.person_id]);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Account deletion failed:', error);

        fail(500, env.devMode
            ? `Could not delete the account: ${message}`
            : 'Could not close the account right now. Please try again, or contact support.');
    }

    /* Drop the session last. Doing it before the delete would mean a failed delete
       left somebody signed out of an account that still exists.

       The session ROW is already gone with the cascade, so all this really does is
       clear the cookie - which still matters, because a browser holding a cookie
       for a session that no longer exists shows the signed-in shell for a moment
       before the first request comes back empty. */
    await endSession(req, res);

    return ok({
        message: 'Your account has been closed. Everything associated with it has been removed.'
    });
});
