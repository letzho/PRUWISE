/* =============================================================================
   POST /api/google-login  {  credential  }  ->  { account, created }
   -----------------------------------------------------------------------------
   Ported from php/api/google-login.php.

   "Sign in with Google". The browser gets an ID token from Google and posts it
   here. This file's whole job is to decide whether that token is genuine, and then
   to find or create the matching account.

   =============================================================================
   WHAT AN ID TOKEN IS, AND WHY WE CANNOT JUST READ IT
   =============================================================================

   The credential is a JWT: three base64url chunks joined by dots.

       header . payload . signature

   The payload is NOT encrypted. Anybody can decode it and read the email inside -
   including somebody who wrote the whole thing themselves five seconds ago.
   Decoding a JWT tells you what it CLAIMS. It tells you nothing about whether the
   claim is true.

   What makes it trustworthy is the signature. Google signs the first two chunks
   with a private key only Google has. We fetch Google's matching PUBLIC key and
   check the signature against it. If it verifies, the contents genuinely came from
   Google and have not been altered by a single byte.

   Skip that step and "sign in with Google" becomes "type any email address you like
   and be signed in as its owner". It is the entire security of the feature.

   =============================================================================
   THE FOUR CLAIMS THAT MATTER, AND WHY EACH ONE
   =============================================================================

     iss   Who issued it. Must be Google.

     aud   WHO IT WAS ISSUED FOR - our own client id. This one is easy to overlook
           and important: a token minted for some other website is perfectly valid
           and correctly signed by Google. Without this check, anybody could take
           the token another site gave them and use it here.

     exp   When it stops being valid. Google's last about an hour.

     email_verified
           Google itself confirms the address belongs to them. We refuse unverified
           addresses, because we are about to use the email to decide WHICH ACCOUNT
           this is - see the note on matching below.

   =============================================================================
   HOW WE DECIDE WHICH ACCOUNT THIS IS
   =============================================================================

   In order:

     1. google_sub matches -> that is them, sign them in.
     2. verified email matches an existing account -> LINK it: store the sub against
        that account, and from then on step 1 handles them.
     3. Nothing matches -> create a customer account.

   Step 2 is why email_verified matters so much. If we accepted unverified
   addresses, somebody could put sarah.tan@example.sg on a Google account they
   control and walk straight into Sarah's account.

   And after step 2 we never look at the email again, because 'sub' is permanent and
   an email address is not: people change them, and a released address can later
   belong to somebody else entirely.

   =============================================================================
   WHAT THE PORT CHANGED, AND WHAT IT DROPPED
   =============================================================================

   VERIFICATION IS NOW DONE FROM THE JWK ENDPOINT rather than the X.509 one. The
   PHP used certificates because openssl_pkey_get_public() reads those directly and
   assembling a key from a raw modulus and exponent would have been forty lines of
   byte packing. Node's crypto.createPublicKey() accepts a JWK as-is, so the
   simpler endpoint is now the simpler code.

   THE CERTIFICATE CACHE IS IN MEMORY, NOT A TEMP FILE. A warm function instance
   keeps it between requests, which is the same benefit for none of the file
   handling. A cold instance fetches once. Falling back to a stale copy when Google
   is unreachable is kept, because these keys are valid for days and a stale key is
   far more likely to be right than no key at all.

   THE NONCE CHECK IS GONE, and this is a real reduction. It worked by storing a
   random value in a PHP session BEFORE anybody signed in, then comparing it to the
   nonce Google embedded in the token. There is no equivalent here: a pre-login
   server session would mean a database row and a cookie for every visitor who
   merely looked at the sign-in button.

   What it protected against was replay - the same captured token being posted
   twice. What still stands in its place: the token is signed for this client id
   only, it expires within the hour, and it travels over TLS to a single endpoint.
   An attacker who can read it can already read the session cookie it produces, so
   the nonce was not the weakest link. Worth knowing it is absent rather than
   discovering it later.
   ============================================================================= */

import { createPublicKey, createVerify, randomBytes } from 'node:crypto';
import {
    audit, newPersonId, publicAccount, startSession, type User
} from '../_lib/auth.js';
import { batch, column, one, q } from '../_lib/db.js';
import { env, has } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { firstNameOf, validEmail } from '../_lib/validate.js';

/* Google's JWKS. The 'v3' endpoint is the JWK one; 'v1' returns X.509 certificates,
   which is what the PHP used. */
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const CERT_MAX_AGE_MS = 60 * 60 * 1000;

interface Jwk {
    kid: string;
    kty: string;
    n: string;
    e: string;
    alg?: string;
    use?: string;
}

/* Module scope, so a warm instance reuses it. */
let cachedKeys: Jwk[] | null = null;
let cachedAt = 0;


/* base64url is base64 with two characters swapped so it is safe inside a URL, and
   with the trailing '=' padding removed. Node's Buffer understands 'base64url'
   directly, so both are undone for us. */
function b64urlToBuffer(text: string): Buffer {
    return Buffer.from(text, 'base64url');
}

async function googleKeys(forceRefresh = false): Promise<Jwk[]> {
    const fresh = cachedKeys !== null && (Date.now() - cachedAt) < CERT_MAX_AGE_MS;

    if (fresh && !forceRefresh) { return cachedKeys as Jwk[]; }

    let response: Response;

    try {
        /* TLS verification is on by default in fetch and MUST STAY ON.

           Switching it off is the advice you find everywhere for a local dev box,
           and it would quietly destroy the point of this entire file. We are here
           to check that Google signed the token; if we do not check who we are
           talking to when we fetch Google's key, anybody in a position to
           intercept the connection can hand us THEIR key, and every signature
           check that follows passes happily. */
        response = await fetch(GOOGLE_JWKS, {
            signal: AbortSignal.timeout(8000)
        });

    } catch (error) {
        /* Fall back to a stale cache if we have one. Keys are valid for days, so an
           expired cache is far more likely to be correct than nothing at all, and
           it keeps sign-in working through a brief network problem. */
        if (cachedKeys !== null) { return cachedKeys; }

        const message = error instanceof Error ? error.message : String(error);
        fail(502, `Could not reach Google to check that sign-in` +
            `${env.devMode ? ` (${message})` : ''}. Please try again.`);
    }

    if (!response.ok) {
        if (cachedKeys !== null) { return cachedKeys; }
        fail(502, 'Google returned an error while checking that sign-in. Please try again.');
    }

    const body = await response.json().catch(() => null) as { keys?: Jwk[] } | null;

    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
        if (cachedKeys !== null) { return cachedKeys; }
        fail(502, 'Google returned something unexpected while checking that sign-in.');
    }

    cachedKeys = body.keys;
    cachedAt = Date.now();

    return cachedKeys;
}


/* Google gives us no username, so invent one from the email.

   'sarah.tan@gmail.com' -> 'sarah.tan', or 'sarah.tan2' if that is taken. The
   result still has to satisfy validUsername(): 4-40 characters, lowercase letters,
   numbers and dots only. */
async function googleUsername(email: string): Promise<string> {
    let base = email.split('@')[0]?.toLowerCase() ?? '';

    /* Drop anything the rules do not allow, then collapse runs of dots. */
    base = base.replace(/[^a-z0-9.]/g, '').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');

    if (base.length < 4) { base = `user${base}`; }
    if (base.length > 32) { base = base.slice(0, 32); }

    if (!await column('SELECT 1 FROM accounts WHERE username = ?', [base])) {
        return base;
    }

    /* Taken. Try a few numbered variants, then fall back to something random. */
    for (let n = 2; n <= 60; n++) {
        const candidate = `${base}${n}`;

        if (!await column('SELECT 1 FROM accounts WHERE username = ?', [candidate])) {
            return candidate;
        }
    }

    return `user${randomBytes(4).toString('hex')}`;
}


const ACCOUNT_SELECT = `
    SELECT a.*, p.name AS person_name, p.rep_id, p.phone AS person_phone, p.kind
      FROM accounts a
      JOIN people p ON p.id = a.person_id
     WHERE a.id = ?
`;


export default defineHandler(async (req, res) => {
    req.requirePost();

    const clientId = env.googleClientId;

    /* Not configured. Say so plainly - this is the single most likely reason for
       this endpoint to be reached and fail, and "invalid token" would send somebody
       hunting in completely the wrong place. */
    if (!has.google() || clientId.includes('REPLACE')) {
        fail(503,
            'Google sign-in is not set up on this deployment. Add GOOGLE_CLIENT_ID to the ' +
            'project environment variables - the README explains where to get one.');
    }

    const credential = req.field('credential', '');

    if (credential === '') {
        fail(400, 'No Google credential was sent.');
    }

    /* ===================================================================
       1. SPLIT AND DECODE
       =================================================================== */
    const parts = credential.split('.');

    if (parts.length !== 3) {
        fail(400, 'That Google credential is not a valid token.');
    }

    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    let signature: Buffer;

    try {
        header = JSON.parse(b64urlToBuffer(headerPart).toString('utf8')) as Record<string, unknown>;
        payload = JSON.parse(b64urlToBuffer(payloadPart).toString('utf8')) as Record<string, unknown>;
        signature = b64urlToBuffer(signaturePart);
    } catch {
        fail(400, 'That Google credential could not be decoded.');
    }

    if (typeof header !== 'object' || header === null
        || typeof payload !== 'object' || payload === null) {
        fail(400, 'That Google credential is not readable.');
    }

    /* RS256 ONLY.

       WHY REFUSE ANYTHING ELSE: there is a well-known attack where the token says
       alg:"none" and carries no signature at all, and a library that trusts the
       header happily accepts it. There is a second one where the attacker switches
       to a symmetric algorithm so the PUBLIC key becomes the signing secret - and
       public keys are, by definition, public. We decide the algorithm here; the
       token does not get a vote. */
    if (header.alg !== 'RS256') {
        fail(400, 'That Google credential uses an unexpected signing algorithm.');
    }

    const kid = typeof header.kid === 'string' ? header.kid : '';

    if (kid === '') {
        fail(400, 'That Google credential does not say which key signed it.');
    }

    /* ===================================================================
       2. GET GOOGLE'S PUBLIC KEY AND CHECK THE SIGNATURE
       =================================================================== */
    let keys = await googleKeys();
    let jwk = keys.find(key => key.kid === kid);

    if (!jwk) {
        /* The key id is not one we know. Usually this means our cache is older than
           a key rotation, so throw it away and ask again before giving up. */
        keys = await googleKeys(true);
        jwk = keys.find(key => key.kid === kid);
    }

    if (!jwk) {
        fail(401, 'That Google sign-in could not be verified. Please try again.');
    }

    let verified = false;

    try {
        const publicKey = createPublicKey({
            key: jwk as unknown as import('node:crypto').JsonWebKey,
            format: 'jwk'
        });

        /* THE CHECK EVERYTHING ELSE RESTS ON.

           Note what is signed: the first two chunks, joined by a dot, EXACTLY as
           they arrived. Not the decoded payload - re-encoding it would produce
           different bytes and the signature would never match. */
        verified = createVerify('RSA-SHA256')
            .update(`${headerPart}.${payloadPart}`)
            .verify(publicKey, signature);

    } catch (error) {
        console.error('Google signature check failed:', error);
        fail(500, "Could not read Google's signing key.");
    }

    if (!verified) {
        fail(401, 'That Google sign-in could not be verified. Please try again.');
    }

    /* ===================================================================
       3. THE CLAIMS

       The signature proves Google wrote this. It does NOT prove Google wrote it
       FOR US, or that it is still valid. That is what these checks are for.
       =================================================================== */
    const issuer = String(payload.iss ?? '');

    if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
        fail(401, 'That sign-in did not come from Google.');
    }

    /* The one that stops a token minted for another website working here. */
    if (String(payload.aud ?? '') !== clientId) {
        fail(401, 'That Google sign-in was issued for a different application.');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    /* 60 seconds of slack, because the two machines' clocks are never exactly
       together and a token that expired half a second ago is not an attack. */
    if (typeof payload.exp !== 'number' || payload.exp < nowSeconds - 60) {
        fail(401, 'That Google sign-in has expired. Please try again.');
    }

    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + 300) {
        fail(401, 'That Google sign-in is dated in the future and cannot be used.');
    }

    const sub = String(payload.sub ?? '');
    const email = String(payload.email ?? '').trim().toLowerCase();
    let name = String(payload.name ?? '').trim();

    if (sub === '') {
        fail(401, 'That Google sign-in is missing its account id.');
    }
    if (!validEmail(email)) {
        fail(400, 'That Google account has no usable email address.');
    }

    /* email_verified can arrive as true or as the string "true" depending on the
       flow, so both are accepted - but it is still REQUIRED. See the header
       comment: this address is about to decide which account somebody gets. */
    if (payload.email_verified !== true && payload.email_verified !== 'true') {
        fail(403,
            'Google has not verified the email address on that account, so it cannot be ' +
            'used to sign in here. Verify it with Google first.');
    }

    /* ===================================================================
       4. FIND OR CREATE THE ACCOUNT
       =================================================================== */
    let created = false;
    let accountId = Number(await column('SELECT id FROM accounts WHERE google_sub = ?', [sub]) ?? 0);

    /* --- 2. No, but is there an account on this verified address? Link it. --- */
    if (!accountId) {
        const existing = await one<{ id: number; google_sub: string | null }>(
            'SELECT id, google_sub FROM accounts WHERE email = ?', [email]
        );

        if (existing) {
            /* Somebody else's Google account already claims this login. Extremely
               unlikely, but the alternative is silently moving the link, so refuse
               and let a human sort it out. */
            if (existing.google_sub !== null && existing.google_sub !== sub) {
                fail(409,
                    'That email address is already linked to a different Google account. ' +
                    'Please sign in with your username and password.');
            }

            accountId = Number(existing.id);

            await q('UPDATE accounts SET google_sub = ?, email_verified = true WHERE id = ?',
                [sub, accountId]);

            await audit(accountId, 'google.link',
                'linked Google sign-in to an existing account', req.ip);
        }
    }

    /* --- 3. Still nothing. Create a customer account. --- */
    if (!accountId) {
        if (name === '') { name = email.split('@')[0] ?? 'Customer'; }
        if (name.length > 120) { name = name.slice(0, 120); }

        const firstName = firstNameOf(name);

        /* No representative yet - same rule as /api/register. rep_id stays NULL
           until a representative accepts a consultation request. */
        const personId = await newPersonId('cus');
        const username = await googleUsername(email);

        try {
            await batch(sqlt => [
                sqlt`INSERT INTO people
                         (id, kind, name, first_name, email, rep_id, segment,
                          client_since, status)
                     VALUES (${personId}, 'customer', ${name}, ${firstName}, ${email},
                             NULL, 'New customer', CURRENT_DATE, 'active')`,

                /* THERE IS NO PASSWORD, and that is the point.

                   password_hash is NOT NULL, so it gets a deliberately impossible
                   value. 'NEEDS_SETUP' is not a bcrypt hash, and verifyPassword()
                   refuses it by name before bcrypt is even asked - so this account
                   cannot be signed into with a password at all until its owner sets
                   one through the forgotten-password flow. It fails closed rather
                   than leaving a guessable placeholder. */
                sqlt`INSERT INTO accounts
                         (person_id, role, username, email, password_hash, google_sub,
                          name, label, note, email_verified)
                     VALUES (${personId}, 'customer', ${username}, ${email}, 'NEEDS_SETUP',
                             ${sub}, ${name}, 'Customer', 'Google sign-in', true)`,

                sqlt`INSERT INTO account_prefs (account_id)
                     SELECT id FROM accounts WHERE username = ${username}`,

                sqlt`INSERT INTO threads (kind, owner_account_id, last_message_at)
                     SELECT 'ai', id, now() FROM accounts WHERE username = ${username}
                     ON CONFLICT DO NOTHING`,

                /* One conversation to arrive into, in the PRUWise thread rather than
                   a human one - there is no representative to have a thread with
                   yet. Identical to /api/register on purpose: both doors into a new
                   account should leave it in the same state. */
                sqlt`INSERT INTO messages (thread_id, sender_kind, body)
                     SELECT t.id, 'system',
                            ${`Welcome to PRUWise, ${firstName}. You do not have a financial ` +
                              `representative yet. Take the Financial Needs Assessment and we ` +
                              `will show you the representatives who fit what you are looking ` +
                              `for - you choose one, and they confirm. In the meantime you can ` +
                              `ask me anything about insurance in plain language.`}
                       FROM threads t
                       JOIN accounts a ON a.id = t.owner_account_id
                      WHERE a.username = ${username} AND t.kind = 'ai'`
            ]);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Google sign-up failed:', error);

            fail(500, env.devMode
                ? `Could not create the account: ${message}`
                : 'Could not create the account right now. Please try again shortly.');
        }

        accountId = Number(await column('SELECT id FROM accounts WHERE username = ?',
            [username]) ?? 0);

        if (!accountId) {
            fail(500, 'The account was created but could not be read back. Please try again.');
        }

        created = true;
        await audit(accountId, 'register', 'created through Google sign-in', req.ip);
    }

    /* ------------------------------------------------------------------ sign in */
    const account = await one<User>(ACCOUNT_SELECT, [accountId]);

    if (!account) {
        fail(500, 'That account could not be loaded.');
    }

    if (account.status === 'suspended') {
        fail(403, 'That account has been suspended. Please contact your representative.');
    }

    /* A Google account can change its display name; ours should follow, but only
       when it actually differs - an UPDATE on every sign-in is pure write traffic. */
    if (name !== '' && name !== account.name) {
        await q('UPDATE accounts SET name = ? WHERE id = ?', [name, accountId]);
        await q('UPDATE people SET name = ? WHERE id = ?', [name, account.person_id]);

        account.name = name;
        account.person_name = name;
    }

    await startSession(res, account, req);
    await audit(accountId, 'login', 'google', req.ip);

    return ok({
        account: await publicAccount(account),

        /* Lets the browser say "welcome" rather than "welcome back". */
        created
    });
});
