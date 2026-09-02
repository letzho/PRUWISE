/* =============================================================================
   POST /api/login  {  username, password  }
   -----------------------------------------------------------------------------
   Ported from php/api/login.php.

   =============================================================================
   THE ONE RULE OF A LOGIN ENDPOINT
   =============================================================================

   Never tell the caller which half was wrong. "No such user" and "wrong
   password" get the same message, because the difference between them is a free
   way to enumerate which usernames exist.

   That has to hold for TIMING as well as wording, which is why the password is
   verified against a decoy hash when the account does not exist. Without it a
   missing username answers in a millisecond and a real one takes the ~100ms
   bcrypt costs, and that gap is measurable over enough attempts.
   ============================================================================= */

import {
    audit, ensurePrefs, hashPassword, loginLock, publicAccount,
    recordAttempt, startSession, verifyPassword, type User
} from '../_lib/auth.js';
import { one, q, toIso } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

/* A real bcrypt hash of a value nobody knows, used only to burn the same amount
   of time as a genuine check. Cost 12, matching BCRYPT_ROUNDS, so the delay is
   the same as verifying a real password rather than merely non-zero. */
const DECOY_HASH = '$2b$12$K3JNi7VXfnH2vqCJ5vJ8ZuLQ0mF6dY1pR9wT4sX7cB2nA5gE8hM3O';

export default defineHandler(async (req, res) => {
    req.requirePost();

    const username = req.field('username', '').toLowerCase();
    const password = req.field('password', '');
    const ip = req.ip;

    if (username === '' || password === '') {
        fail(400, 'Please enter both a username and a password.',
            username === '' ? 'username' : 'password');
    }

    /* Locked out right now? Checked BEFORE the password is touched, so a locked
       account costs an attacker nothing to learn and gains them nothing. */
    const lock = await loginLock(username, ip);
    if (lock !== null) {
        fail(429, lock);
    }

    const account = await one<User>(
        `SELECT a.*, p.name AS person_name, p.rep_id, p.phone AS person_phone,
                p.kind, p.client_since
           FROM accounts a
           JOIN people p ON p.id = a.person_id
          WHERE a.username = ?`,
        [username]
    );

    const passwordOk = account
        ? await verifyPassword(password, account.password_hash)
        : await verifyPassword(password, DECOY_HASH);

    if (!account || !passwordOk) {
        await recordAttempt(username, ip, false);
        fail(401, 'That username or password is not recognised.', 'password');
    }

    if (account.status !== 'active') {
        await recordAttempt(username, ip, false);
        fail(403, 'This account has been suspended. Please contact client care.');
    }

    /* Quietly upgrade a hash made by the old PHP.

       Every password in the migrated database is a $2y$ hash from PHP's
       password_hash(). Those verify fine - see verifyPassword - but rewriting
       them as $2b$ at the one moment the plain password is in hand means the
       $2y$ compatibility path eventually has nothing left to support.

       Not awaited: nobody is waiting on it, and if it fails the hash simply stays
       as it was and works exactly as before. */
    if (account.password_hash.startsWith('$2y$')) {
        void hashPassword(password)
            .then(fresh => q('UPDATE accounts SET password_hash = ? WHERE id = ?',
                [fresh, account.id]))
            .catch((error: unknown) => {
                console.error('Could not rehash password on login:', error);
            });
    }

    await recordAttempt(username, ip, true);
    await ensurePrefs(account.id);

    /* Stamp the login and get the value back in the same statement.

       The PHP wrote last_login_at and then re-ran the whole account+person join
       purely so the response carried the fresh value - a second round trip to
       answer a question it already knew. RETURNING gives us the stored value
       directly, so the number in the database and the number in the response are
       the same one rather than two clocks that nearly agree. */
    const stamped = await one<{ last_login_at: unknown }>(
        'UPDATE accounts SET last_login_at = now() WHERE id = ? RETURNING last_login_at',
        [account.id]
    );

    account.last_login_at = stamped ? stamped.last_login_at : new Date();

    await startSession(res, account, req);
    await audit(account.id, 'login', null, ip);

    return ok({
        account: await publicAccount(account),

        /* Included so the browser can show "last signed in ..." without asking
           again. toIso because Postgres hands back a Date. */
        lastLogin: toIso(account.last_login_at)
    });
});
