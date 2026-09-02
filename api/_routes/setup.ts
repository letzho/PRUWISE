/* =============================================================================
   POST /api/setup?token=...   -  create the tables, seed the data
   -----------------------------------------------------------------------------
   The replacement for php/setup.php, and the reason it exists as an endpoint
   rather than only as a CLI script:

   Vercel stores the Neon connection string as a SENSITIVE environment variable
   and deliberately refuses to decrypt it into a local file. `vercel env pull`
   writes the literal text "encrypted" instead. So a laptop cannot reach the
   database, and the only place that can is a function running on Vercel - where
   the real value is injected at runtime.

   =============================================================================
   WHY THIS IS SAFE TO HAVE DEPLOYED
   =============================================================================

   php/setup.php was a web page that described your database connection to
   anybody who found it, which is why the old README had to tell people to delete
   it after use. This one is different in three ways:

     1. IT NEEDS A TOKEN. SETUP_TOKEN is an environment variable, compared in
        constant time. Without it the endpoint refuses and says nothing else.

     2. IT REFUSES TO RUN TWICE BY ACCIDENT. If accounts already exist it stops,
        unless ?force=1 is passed. Re-running is harmless in principle - every
        statement is IF NOT EXISTS or ON CONFLICT DO NOTHING - but "harmless in
        principle" is not a good enough reason to let a stray request touch a
        database with real rows in it.

     3. IT NEVER REPORTS CREDENTIALS. The response says how many tables exist and
        which accounts were created. It does not echo the connection string, and
        the passwords it returns are the demo ones that are already in the
        repository.

   Still worth deleting once the project is finished. It is a door that does not
   need to stay in the wall.
   ============================================================================= */

import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { all, column, q, raw } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { readDbFile, splitStatements } from '../_lib/sqlfile.js';

/* Constant-time comparison, so the token cannot be discovered one character at a
   time by measuring how long the rejection takes. Length is compared first
   because timingSafeEqual throws on a mismatch, and the length of a token is not
   the secret - its contents are. */
function tokenMatches(given: string, expected: string): boolean {
    if (given.length !== expected.length) { return false; }

    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}


/* The three starting logins, matching what php/setup.php used so the README and
   anybody who has seen the demo before are not surprised.

   THESE ARE DEMO CREDENTIALS IN A PUBLIC REPOSITORY and are worth nothing.
   Before showing the site to anybody, change them. */
const DEMO_ACCOUNTS = [
    { username: 'admin',           personId: 'adm-001', role: 'admin',
      email: 'admin@navigator-demo.sg',           name: 'System Administrator',
      label: 'Administrator',              password: 'studadmin' },

    { username: 'kristin.henessy', personId: 'fr-001',  role: 'fr',
      email: 'kristin.henessy@navigator-demo.sg', name: 'Kristin Henessy',
      label: 'Financial Representative',   password: 'studkris' },

    { username: 'sarah.tan',       personId: 'cus-001', role: 'customer',
      email: 'sarah.tan@example.sg',              name: 'Sarah Tan',
      label: 'Customer',                   password: 'studsarah' }
] as const;


export default defineHandler(async (req) => {
    const expected = process.env.SETUP_TOKEN ?? '';

    if (expected === '') {
        fail(503,
            'Setup is not available: SETUP_TOKEN is not configured on this deployment.');
    }

    const given = req.query('token') || req.field('token', '');

    if (given === '' || !tokenMatches(given, expected)) {
        fail(403, 'Not authorised.');
    }

    const force = req.query('force') === '1' || req.field('force', false) === true;
    const tidy  = req.query('tidy')  === '1' || req.field('tidy',  false) === true;

    /* --------------------------------------------------------------- guard */
    let existingAccounts = 0;

    try {
        const count = await column<string>('SELECT COUNT(*) FROM accounts');
        existingAccounts = Number(count ?? 0);

    } catch {
        /* The table does not exist yet, which is the normal first run. */
        existingAccounts = 0;
    }

    /* &tidy=1 also gets past this, because tidying is the reason somebody would
       call this endpoint against a database that is already set up. */
    if (existingAccounts > 0 && !force && !tidy) {
        return ok({
            alreadySetUp: true,
            accounts: existingAccounts,
            message:
                `This database already has ${existingAccounts} account(s), so nothing was ` +
                `changed. Add &force=1 to run anyway - it is safe, every statement is ` +
                `IF NOT EXISTS or ON CONFLICT DO NOTHING. Add &tidy=1 to collapse ` +
                `duplicate demo policies without reseeding.`
        });
    }

    const report: string[] = [];
    const problems: string[] = [];

    /* =====================================================================
       ?tidy=1  -  ENFORCE "ONE ACTIVE POLICY PER PRODUCT" RETROSPECTIVELY
       ---------------------------------------------------------------------
       WHY THIS EXISTS. scripts/smoke.mjs applies for a plan, has the
       representative issue it, and applies for a second one to be declined -
       every single run, against the seeded demo customer, with no cleanup.
       Sixteen runs later cus-001 held SIXTEEN identical PRUActive Protect
       policies and her own "My plans" screen added them up and told her she
       was paying $3,600 a month. That is the reported bug.

       activePolicyFor() in _lib/policies.ts now refuses the second one, so
       the pile cannot grow again. This clears the pile that already exists.

       IT IS NOT A WIPE. It applies exactly the rule the code now enforces:
       for each (person, product) keep the LOWEST id and drop the rest. If
       the data already satisfies the rule it deletes nothing, which makes it
       safe to run twice.

       KEEPING THE LOWEST ID IN BOTH TABLES IS DELIBERATE, not arbitrary. The
       oldest policy came from the oldest issued application, so keeping the
       first of each group in both tables keeps policies.application_id
       pointing at a row that still exists. Keeping the newest would have
       nulled that link on the way past.

       SCOPED TO THE SEEDED DEMO PEOPLE. The same list as SAMPLE_PROFILE_IDS
       in _lib/auth.ts. A self-registered customer's cover is real as far as
       this app is concerned and a setup endpoint has no business touching it.
       ===================================================================== */
    if (tidy) {
        const demoPeople =
            "('cus-001','cus-002','cus-003','cus-004','cus-005','cus-006')";

        try {
            /* Policies first. Applications are deleted second so that the
               surviving policy's application_id is still resolvable while this
               runs, and so a failure half way through leaves the more valuable
               table correct. */
            const deadPolicies = await q(
                `DELETE FROM policies
                  WHERE id IN (
                      SELECT id FROM (
                          SELECT id, row_number() OVER (
                                     PARTITION BY person_id, product_id
                                     ORDER BY id
                                 ) AS seat
                            FROM policies
                           WHERE status = 'active'
                             AND person_id IN ${demoPeople}
                      ) ranked
                       WHERE ranked.seat > 1
                  )`
            );

            report.push(`tidy: removed ${deadPolicies.rowCount} duplicate active polic` +
                        `${deadPolicies.rowCount === 1 ? 'y' : 'ies'}`);

            /* Applications: one per (person, product, status). A single issued
               row and a single declined row per product is demo content worth
               having - it is what proves the apply/issue/decline path works.
               Fifteen copies of each is noise on somebody's screen.

               Undecided ones ('submitted','under_review') are LEFT ALONE. They
               are somebody waiting for an answer, and there should never be
               more than one anyway - openApplicationFor() has always seen to
               that. */
            const deadApps = await q(
                `DELETE FROM policy_applications
                  WHERE id IN (
                      SELECT id FROM (
                          SELECT id, row_number() OVER (
                                     PARTITION BY customer_person_id, product_id, status
                                     ORDER BY id
                                 ) AS seat
                            FROM policy_applications
                           WHERE status IN ('issued','declined','withdrawn')
                             AND customer_person_id IN ${demoPeople}
                      ) ranked
                       WHERE ranked.seat > 1
                  )`
            );

            report.push(`tidy: removed ${deadApps.rowCount} duplicate resolved application` +
                        `${deadApps.rowCount === 1 ? '' : 's'}`);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            problems.push(`tidy: ${message}`);
        }
    }

    /* ------------------------------------------------------- schema + seed

       SKIPPED FOR A TIDY-ONLY CALL. Somebody asking to collapse duplicate demo
       policies has not asked for ninety DDL statements to be replayed, and a
       narrow request should do the narrow thing. */
    const seeding = force || existingAccounts === 0;

    for (const file of seeding ? ['schema.sql', 'seed.sql'] : []) {
        let statements: string[];

        try {
            statements = splitStatements(readDbFile(file));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            fail(500, message);
        }

        let applied = 0;

        for (const statement of statements) {
            try {
                /* raw(), NOT q(). These statements came off disk and must be run
                   exactly as written - see the note above raw() in _lib/db.ts
                   about a question mark in a comment silently costing us the
                   audit_log table. */
                await raw(statement);
                applied++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                /* Report and keep going. One failing statement should not stop the
                   other ninety - and the report names it, so a real problem is
                   visible rather than hidden behind an early return. */
                problems.push(
                    `${file}: ${message} | ${statement.replace(/\s+/g, ' ').slice(0, 120)}`
                );
            }
        }

        report.push(`${file}: ${applied}/${statements.length} statements applied`);
    }

    /* ----------------------------------------------------------- accounts */
    const created: Array<{ username: string; password: string; role: string }> = [];

    for (const account of DEMO_ACCOUNTS) {
        try {
            const exists = await column('SELECT id FROM accounts WHERE username = ?',
                [account.username]);

            if (exists) {
                report.push(`${account.username}: already exists, left alone`);
                continue;
            }

            const hash = await bcrypt.hash(account.password, 12);

            await q(
                `INSERT INTO accounts
                     (person_id, role, username, email, password_hash, name, label,
                      email_verified, onboarding_seen)
                 VALUES (?, ?, ?, ?, ?, ?, ?, true, true)`,
                [account.personId, account.role, account.username, account.email,
                 hash, account.name, account.label]
            );

            await q(
                `INSERT INTO account_prefs (account_id)
                 SELECT id FROM accounts WHERE username = ?
                 ON CONFLICT (account_id) DO NOTHING`,
                [account.username]
            );

            /* One PRUWise conversation to arrive into, so Messages is not an empty
               screen on the first visit. */
            await q(
                `INSERT INTO threads (kind, owner_account_id, last_message_at)
                 SELECT 'ai', id, now() FROM accounts WHERE username = ?
                 ON CONFLICT DO NOTHING`,
                [account.username]
            );

            created.push({
                username: account.username,
                password: account.password,
                role: account.role
            });

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            problems.push(`account ${account.username}: ${message}`);
        }
    }

    /* ------------------------------------------------------------- report */
    const tables = await all<{ n: string }>(
        `SELECT COUNT(*) AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );

    const counts = await all<Record<string, string>>(
        `SELECT (SELECT COUNT(*) FROM people)       AS people,
                (SELECT COUNT(*) FROM accounts)     AS accounts,
                (SELECT COUNT(*) FROM rep_profiles) AS profiles`
    );

    return ok({
        tables: Number(tables[0]?.n ?? 0),
        people: Number(counts[0]?.people ?? 0),
        accounts: Number(counts[0]?.accounts ?? 0),
        repProfiles: Number(counts[0]?.profiles ?? 0),

        created,
        report,
        problems,

        message: problems.length === 0
            ? 'Setup completed with no problems. You can sign in now.'
            : `Setup ran, but ${problems.length} statement(s) failed - see problems.`
    });
});
