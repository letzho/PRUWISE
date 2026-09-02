/* =============================================================================
   auth.ts - who is asking, and what they may do
   -----------------------------------------------------------------------------
   Replaces php/lib/auth.php plus the session half of php/lib/bootstrap.php.

   =============================================================================
   THE ONE REAL ARCHITECTURAL CHANGE IN THIS WHOLE PORT
   =============================================================================

   PHP had $_SESSION. A cookie carried an id, PHP found a matching file on the
   server's disk, and the array in it was the session. That works because every
   request for a site lands on the same machine.

   Serverless has no same machine. Consecutive requests can run on different
   instances in different regions with no shared disk, so a session on the
   filesystem is a session that vanishes at random. It has to be in the database.

   The upside is that things which were awkward before are now free. The idle
   timeout was enforced in js/app.js - a client-side timer, which is a courtesy,
   not a control. Here last_seen_at is on the row and checked by the server, so a
   stolen token expires whether or not the browser cooperates.

   There is also a side effect worth knowing: php/lib/bootstrap.php's
   require_login() held a session file LOCK, which is why the pollers used to
   queue up behind each other and why a slow request made the whole app feel
   stuck. Reading a row does not lock anything, so that queueing is simply gone.

   =============================================================================
   EXISTING PASSWORDS STILL WORK
   =============================================================================

   PHP's password_hash() writes bcrypt hashes prefixed $2y$. Node's bcryptjs
   writes $2b$. The prefix is a historical accident and the algorithm underneath
   is identical, so a $2y$ hash from the old database verifies here unchanged -
   see verifyPassword(). Nobody has to reset their password because of the move.
   ============================================================================= */

import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { VercelResponse } from '@vercel/node';
import { all, column, one, q, toIso } from './db.js';
import { fail, Req, setCookie, clearCookie } from './http.js';

export const SESSION_COOKIE = 'pruwise_session';

/* Twenty minutes of inactivity, matching the rule js/app.js already shows a
   warning for. Now enforced on the row rather than only in a browser timer. */
const IDLE_MINUTES = 20;

/* An absolute ceiling regardless of activity, so a session cannot live forever
   just because somebody keeps a tab open. */
const MAX_DAYS = 30;

const BCRYPT_ROUNDS = 12;


/* =============================================================================
   PASSWORDS
   ============================================================================= */

export async function hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/* Verify against a hash that may have come from either language.

   $2y$ is what PHP's password_hash() produces and it is byte-for-byte the same
   algorithm as $2b$ - the prefix was introduced to signal a fix to a bug in a C
   implementation that never affected anyone else. bcryptjs accepts $2y$, but the
   rewrite below removes the doubt entirely and costs nothing.

   NEVER compare hashes with ===. bcrypt.compare is constant-time; a plain string
   comparison returns faster on an early mismatch, which is measurable over enough
   attempts and leaks the answer one character at a time. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
    if (!hash || hash === 'NEEDS_SETUP') { return false; }

    const normalised = hash.startsWith('$2y$') ? `$2b$${hash.slice(4)}` : hash;

    try {
        return await bcrypt.compare(plain, normalised);
    } catch {
        /* A malformed hash in the database. Refuse, rather than letting an
           exception become a 500 that tells the caller the row exists. */
        return false;
    }
}


/* =============================================================================
   TOKENS

   Random, then stored only as a SHA-256. Anybody who reads the sessions or
   password_resets table must not be able to use what they find - the same
   reasoning as never storing a password.

   SHA-256 without a salt is correct HERE and would be wrong for a password. The
   input is 32 bytes of cryptographic randomness, so there is no dictionary to
   attack and no work factor needed. A password is low-entropy and human-chosen,
   which is why it gets bcrypt instead.
   ============================================================================= */

export function newToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}


/* =============================================================================
   THE SIGNED-IN USER

   Shape matches what php/lib/bootstrap.php's current_user() returned, because
   every ported endpoint reads these exact keys.
   ============================================================================= */

export interface User {
    id: number;
    person_id: string;
    role: 'fr' | 'customer' | 'admin';
    username: string;
    email: string;
    name: string;
    label: string | null;
    password_hash: string;
    google_sub: string | null;
    status: string;
    email_verified: boolean;
    onboarding_seen: boolean;
    session_epoch: number;
    created_at: unknown;
    last_login_at: unknown;

    /* From the joined people row. person_name is the human's name; name is what
       the account was created with, and they can differ. */
    person_name: string;
    person_phone: string | null;
    rep_id: string | null;
    kind: string;
}

const USER_SELECT = `
    SELECT a.id, a.person_id, a.role, a.username, a.email, a.name, a.label,
           a.password_hash, a.google_sub, a.status, a.email_verified,
           a.onboarding_seen, a.session_epoch, a.created_at, a.last_login_at,
           p.name  AS person_name,
           p.phone AS person_phone,
           p.rep_id,
           p.kind
      FROM accounts a
      JOIN people p ON p.id = a.person_id
`;


/* Who is asking, or null.

   ONE QUERY does the whole check: the token matches, the session has not
   expired, it has not gone idle, the epoch still agrees, and the account is not
   suspended. Every one of those is a reason to refuse, and doing them together
   means there is no window between checking and using the answer.
   ============================================================================= */
export async function currentUser(req: Req): Promise<User | null> {
    const token = req.cookie(SESSION_COOKIE);
    if (!token) { return null; }

    const row = await one<User & { session_id: string }>(
        `${USER_SELECT}
           JOIN sessions s ON s.account_id = a.id
          WHERE s.token_hash = ?
            AND s.expires_at   > now()
            AND s.last_seen_at > now() - INTERVAL '${IDLE_MINUTES} minutes'
            AND s.session_epoch = a.session_epoch
            AND a.status = 'active'`,
        [hashToken(token)]
    );

    if (!row) { return null; }

    /* Re-stamp activity, which is what keeps an in-use session alive.

       Deliberately NOT awaited. It is a write nobody is waiting on, and holding
       every single request - including a poll that fires every few seconds - for
       an extra round trip to record "still here" is a poor trade. If it fails the
       session times out slightly early, which is the safe direction to be wrong
       in.

       The catch matters though: an unhandled rejection from a floating promise
       can take down the function instance. */
    void q('UPDATE sessions SET last_seen_at = now() WHERE token_hash = ?',
        [hashToken(token)]
    ).catch((error: unknown) => {
        console.error('Could not update session last_seen_at:', error);
    });

    return row;
}

export async function requireLogin(req: Req): Promise<User> {
    const user = await currentUser(req);

    if (!user) {
        fail(401, 'Please sign in to continue.');
    }
    return user;
}

/* 403 rather than 404.

   Hiding the existence of an admin area would be security through obscurity, and
   the endpoint paths are in the JavaScript anyway. What matters is that the
   answer is no, and that the attempt is recorded. */
export async function requireAdmin(req: Req): Promise<User> {
    const user = await requireLogin(req);

    if (user.role !== 'admin') {
        await audit(user.id, 'admin_access_denied', req.raw.url ?? null, req.ip);
        fail(403, 'That area is for administrators only.');
    }
    return user;
}

export async function requireRole(req: Req, role: User['role']): Promise<User> {
    const user = await requireLogin(req);

    if (user.role !== role) {
        fail(403, 'Your account does not have access to that.');
    }
    return user;
}


/* =============================================================================
   STARTING AND ENDING A SESSION
   ============================================================================= */

export async function startSession(
    res: VercelResponse,
    user: { id: number; session_epoch: number },
    req: Req
): Promise<string> {
    const token = newToken();
    const maxAgeSeconds = MAX_DAYS * 24 * 60 * 60;

    await q(
        `INSERT INTO sessions
             (account_id, token_hash, session_epoch, expires_at, user_agent, ip)
         VALUES (?, ?, ?, now() + INTERVAL '${MAX_DAYS} days', ?, ?)`,
        [user.id, hashToken(token), user.session_epoch, req.userAgent, req.ip]
    );

    setCookie(res, SESSION_COOKIE, token, maxAgeSeconds);

    /* Opportunistic cleanup, in place of the cron job this platform does not
       offer on the free plan. Expired rows are harmless - currentUser() will not
       match them - so this is housekeeping rather than a control, and it runs at
       the one moment somebody is already waiting for a write. */
    void q('DELETE FROM sessions WHERE expires_at < now()').catch(() => { /* housekeeping */ });

    return token;
}

export async function endSession(req: Req, res: VercelResponse): Promise<void> {
    const token = req.cookie(SESSION_COOKIE);

    if (token) {
        await q('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
    }
    clearCookie(res, SESSION_COOKIE);
}

/* Sign out everywhere: bump the epoch and every existing session stops matching
   on its next request. Used by the admin "sign out" action, and after a password
   change, because a password change that leaves old sessions alive has not
   actually locked anybody out. */
export async function revokeAllSessions(accountId: number): Promise<void> {
    await q('UPDATE accounts SET session_epoch = session_epoch + 1 WHERE id = ?', [accountId]);
    await q('DELETE FROM sessions WHERE account_id = ?', [accountId]);
}


/* =============================================================================
   WHAT THE BROWSER IS ALLOWED TO KNOW

   A WHITELIST, NOT A BLACKLIST. Returning the row with a few fields deleted
   means every column added later is published by default, and one day that
   column is password_hash or google_sub. This names what goes out, so a new
   column is invisible until somebody decides otherwise.
   ============================================================================= */

export interface PublicAccount {
    accountId: number;
    role: string;
    personId: string;
    username: string;
    name: string;
    email: string;
    phone: string | null;
    label: string | null;
    repId: string | null;
    emailVerified: boolean;
    onboardingSeen: boolean;
    googleOnly: boolean;
    createdAt: string | null;
    lastLogin: string | null;
    hasSampleProfile: boolean;
    prefs: {
        theme: string;
        emailNotifications: boolean;
        smsNotifications: boolean;
        speechEnabled: boolean;
        speechVoice: string | null;
    };
}

/* Which person ids js/data.js carries sample insurance figures for.

   INHERITED, AND IT SHOULD NOT SURVIVE MUCH LONGER. This is a hard-coded list of
   eight, and it is how the UI decides whether to show a policy list at all. Now
   that policies are real rows, a self-registered customer holding genuine cover
   is not on this list and never will be. api/policies already answers from the
   table for anybody; this flag only still gates the DEMO fixtures and the
   coverage bars that read them. Deleting it is a frontend job. */
const SAMPLE_PROFILE_IDS = new Set([
    'cus-001', 'cus-002', 'cus-003', 'cus-004', 'cus-005', 'cus-006',
    'fr-001', 'fr-002'
]);

export async function publicAccount(user: User): Promise<PublicAccount> {
    const prefs = await one<{
        theme: string;
        email_notifications: boolean;
        sms_notifications: boolean;
        speech_enabled: boolean;
        speech_voice: string | null;
    }>('SELECT * FROM account_prefs WHERE account_id = ?', [user.id]);

    return {
        accountId: user.id,
        role: user.role,
        personId: user.person_id,
        username: user.username,
        name: user.name,
        email: user.email,
        phone: user.person_phone,
        label: user.label,
        repId: user.rep_id,
        emailVerified: user.email_verified === true,
        onboardingSeen: user.onboarding_seen === true,

        /* Signed up with Google and never set a password. The "close my account"
           dialog reads this to hide a password box there is nothing to check
           against - asking for one they never had is a dead end. */
        googleOnly: !!user.google_sub &&
            (user.password_hash === '' || user.password_hash === 'NEEDS_SETUP'),

        createdAt: toIso(user.created_at),
        lastLogin: toIso(user.last_login_at),
        hasSampleProfile: SAMPLE_PROFILE_IDS.has(user.person_id),

        prefs: {
            theme:              prefs ? prefs.theme : 'system',
            emailNotifications: prefs ? prefs.email_notifications === true : true,
            smsNotifications:   prefs ? prefs.sms_notifications === true : false,
            speechEnabled:      prefs ? prefs.speech_enabled === true : false,
            speechVoice:        prefs ? prefs.speech_voice : null
        }
    };
}

export async function ensurePrefs(accountId: number): Promise<void> {
    await q(
        `INSERT INTO account_prefs (account_id) VALUES (?)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId]
    );
}


/* =============================================================================
   LOGIN THROTTLING

   Two counts, because they defend against different things:

       per username  somebody guessing at one particular account
       per IP        somebody working through a list from one machine

   The IP allowance is higher on purpose. A whole school behind one address would
   otherwise lock each other out just by mistyping.

   Returns a message when the attempt must be refused, or null to proceed.
   ============================================================================= */

const MAX_FAILURES_PER_USER = 8;
const MAX_FAILURES_PER_IP = 30;
const LOCKOUT_MINUTES = 15;

export async function loginLock(username: string, ip: string | null): Promise<string | null> {
    /* BOTH COUNTS IN ONE QUERY.

       Conditional aggregation instead of two round trips, because this runs on
       every login attempt including the successful ones. COALESCE because SUM()
       over no rows is NULL, not 0 - which would compare NULL >= 8 and evaluate
       false. That happens to be the answer we want, for the wrong reason, and
       relying on it is how something breaks later. */
    const row = await one<{ by_user: string; by_ip: string }>(
        `SELECT COALESCE(SUM(CASE WHEN username = ? THEN 1 ELSE 0 END), 0) AS by_user,
                COALESCE(SUM(CASE WHEN ip       = ? THEN 1 ELSE 0 END), 0) AS by_ip
           FROM login_attempts
          WHERE succeeded = false
            AND created_at > now() - INTERVAL '${LOCKOUT_MINUTES} minutes'
            AND (username = ? OR ip = ?)`,
        [username, ip, username, ip]
    );

    const byUser = row ? Number(row.by_user) : 0;
    const byIp = row ? Number(row.by_ip) : 0;

    if (byUser >= MAX_FAILURES_PER_USER) {
        return `Too many failed attempts for that account. Please wait ${LOCKOUT_MINUTES} ` +
               `minutes, or use "Forgot password?" to reset it.`;
    }

    if (byIp >= MAX_FAILURES_PER_IP) {
        return `Too many failed sign-in attempts from this connection. ` +
               `Please wait ${LOCKOUT_MINUTES} minutes.`;
    }
    return null;
}

export async function recordAttempt(
    username: string,
    ip: string | null,
    succeeded: boolean
): Promise<void> {
    await q(
        'INSERT INTO login_attempts (username, ip, succeeded) VALUES (?, ?, ?)',
        [username.slice(0, 60), ip, succeeded]
    );
}


/* =============================================================================
   AUDIT

   Records that something happened, never what the value was. "Email changed" is
   worth knowing; writing the address into a table with different access rules
   from the one that is supposed to hold it is not.

   Never throws. An audit failure must not turn a successful operation into an
   error the user sees - the thing they asked for already happened.
   ============================================================================= */
export async function audit(
    accountId: number | null,
    action: string,
    detail: string | null = null,
    ip: string | null = null
): Promise<void> {
    try {
        await q(
            'INSERT INTO audit_log (account_id, action, detail, ip) VALUES (?, ?, ?, ?)',
            [accountId, action.slice(0, 60), detail === null ? null : detail.slice(0, 255), ip]
        );
    } catch (error) {
        console.error('Audit write failed:', error);
    }
}


/* =============================================================================
   IDS

   Short strings in the same style as the seeded ones, so they sit alongside
   'cus-001' from js/data.js without looking foreign.

   Loops until it finds an unused one. Twelve attempts against 40 bits of
   randomness will not realistically collide; the loop is there so that if it
   somehow does, the result is a retry rather than a duplicate.
   ============================================================================= */
export async function newPersonId(prefix = 'cus'): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = `${prefix}-${randomBytes(5).toString('hex').slice(0, 8)}`;

        const exists = await column('SELECT 1 FROM people WHERE id = ?', [candidate]);
        if (!exists) { return candidate; }
    }
    fail(500, 'Could not allocate an account id. Please try again.');
}


/* A rate limit for anything that sends email, counted per account and per IP.
   Without it, a "forgot password" form is a way to have somebody's inbox flooded
   from your domain, which is how a sender reputation gets destroyed. */
const EMAILS_PER_HOUR = 5;

export async function emailRateExceeded(
    accountId: number | null,
    ip: string | null
): Promise<boolean> {
    const rows = await all<{ n: string }>(
        `SELECT COUNT(*) AS n FROM password_resets
          WHERE created_at > now() - INTERVAL '1 hour'
            AND (account_id = ? OR request_ip = ?)`,
        [accountId, ip]
    );

    return Number(rows[0]?.n ?? 0) >= EMAILS_PER_HOUR;
}
