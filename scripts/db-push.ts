/* =============================================================================
   scripts/db-push.ts  -  create the database, seed it, report on it
   -----------------------------------------------------------------------------
   The replacement for php/setup.php.

       npm run db:push

   Applies db/schema.sql, then db/seed.sql, then creates the three demo logins
   with real bcrypt hashes - which is the part that cannot be done in SQL and is
   why this is a script rather than another .sql file.

   Safe to run repeatedly. Everything is IF NOT EXISTS or ON CONFLICT DO NOTHING,
   and existing account passwords are left alone unless --reset-passwords is
   given.

   =============================================================================
   WHY THIS IS A CLI SCRIPT AND NOT AN ENDPOINT
   =============================================================================

   setup.php was a web page, which meant a file on the live site that would
   happily describe your database connection to anybody who found it. The README
   had to tell people to delete it after use, which is the kind of instruction
   that gets forgotten exactly once.

   This runs from a terminal against DATABASE_URL. There is nothing deployed, so
   there is nothing to delete and nothing to leave exposed.
   ============================================================================= */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.error(
        '\nDATABASE_URL is not set.\n\n' +
        'Put it in .env.local (see .env.example), then run with:\n' +
        '  node --env-file=.env.local --experimental-strip-types scripts/db-push.ts\n'
    );
    process.exit(1);
}

const sql = neon(databaseUrl, { fullResults: true });

const resetPasswords = process.argv.includes('--reset-passwords');


/* =============================================================================
   SPLITTING A .sql FILE INTO STATEMENTS

   The Neon HTTP driver runs one statement per request, so the file has to be cut
   up. Splitting on ';' is the obvious approach and it is wrong here, because
   db/schema.sql contains a plpgsql function whose body is dollar-quoted:

       CREATE OR REPLACE FUNCTION touch_updated_at()
       RETURNS TRIGGER AS $$
       BEGIN
           NEW.updated_at = now();     <- a semicolon INSIDE the body
           RETURN NEW;                 <- and another
       END;
       $$ LANGUAGE plpgsql;

   A naive split produces three fragments, none of which is valid SQL. So this
   tracks whether it is inside a dollar-quoted block, inside a single-quoted
   string, or inside a comment, and only treats a semicolon as a boundary when it
   is in none of them.
   ============================================================================= */
function splitStatements(text: string): string[] {
    const statements: string[] = [];
    let current = '';
    let i = 0;

    let inSingle = false;
    let inLineComment = false;
    let inBlockComment = false;
    let dollarTag: string | null = null;

    while (i < text.length) {
        const char = text[i] as string;
        const next = text[i + 1];

        /* --- inside a dollar-quoted block: only its own tag ends it --- */
        if (dollarTag !== null) {
            if (text.startsWith(dollarTag, i)) {
                current += dollarTag;
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            current += char; i++; continue;
        }

        if (inLineComment) {
            if (char === '\n') { inLineComment = false; }
            current += char; i++; continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') { inBlockComment = false; current += '*/'; i += 2; continue; }
            current += char; i++; continue;
        }

        if (inSingle) {
            /* '' is an escaped quote inside a string, not the end of it. */
            if (char === "'" && next === "'") { current += "''"; i += 2; continue; }
            if (char === "'") { inSingle = false; }
            current += char; i++; continue;
        }

        /* --- not inside anything: look for something starting --- */
        if (char === '-' && next === '-') { inLineComment = true; current += '--'; i += 2; continue; }
        if (char === '/' && next === '*') { inBlockComment = true; current += '/*'; i += 2; continue; }
        if (char === "'") { inSingle = true; current += char; i++; continue; }

        /* $$ or $tag$ opens a dollar-quoted block. */
        if (char === '$') {
            const match = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
            if (match) {
                dollarTag = match[0];
                current += dollarTag;
                i += dollarTag.length;
                continue;
            }
        }

        if (char === ';') {
            statements.push(current.trim());
            current = '';
            i++;
            continue;
        }

        current += char; i++;
    }

    if (current.trim() !== '') { statements.push(current.trim()); }

    /* Drop anything that is only a comment - splitting leaves those behind and
       Postgres rejects an empty query. */
    return statements.filter(s => {
        const stripped = s
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/--[^\n]*/g, '')
            .trim();
        return stripped !== '';
    });
}


async function runFile(name: string): Promise<number> {
    const path = join(root, 'db', name);
    const statements = splitStatements(readFileSync(path, 'utf8'));

    let applied = 0;

    for (const statement of statements) {
        try {
            await sql.query(statement, []);
            applied++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            console.error(`\n  FAILED in ${name}:\n  ${message}`);
            console.error(`  Statement was:\n  ${statement.replace(/\s+/g, ' ').slice(0, 220)}\n`);
            throw error;
        }
    }

    console.log(`  ${name}: ${applied} statement(s) applied`);
    return applied;
}


/* =============================================================================
   THE THREE STARTING LOGINS

   The same usernames and passwords php/setup.php used, so the README and anybody
   who has used the demo before are not surprised.

   These are DEMO CREDENTIALS IN A PUBLIC REPOSITORY and are worth exactly
   nothing. Before showing this to anybody, run with --reset-passwords, which
   generates random ones and prints them once.
   ============================================================================= */
const DEMO_ACCOUNTS = [
    { username: 'admin',           personId: 'adm-001', role: 'admin',
      email: 'admin@navigator-demo.sg',            name: 'System Administrator',
      label: 'Administrator', password: 'studadmin' },

    { username: 'kristin.henessy', personId: 'fr-001',  role: 'fr',
      email: 'kristin.henessy@navigator-demo.sg',  name: 'Kristin Henessy',
      label: 'Financial Representative', password: 'studkris' },

    { username: 'sarah.tan',       personId: 'cus-001', role: 'customer',
      email: 'sarah.tan@example.sg',               name: 'Sarah Tan',
      label: 'Customer', password: 'studsarah' }
] as const;

function randomPassword(): string {
    /* No l, 1, I, O or 0. Somebody is going to read this off a screen and type
       it, and those are the characters that get mistyped. */
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 14; i++) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

async function seedAccounts(): Promise<void> {
    const created: Array<{ username: string; password: string; role: string }> = [];

    for (const account of DEMO_ACCOUNTS) {
        const existing = await sql.query(
            'SELECT id FROM accounts WHERE username = $1', [account.username]
        ) as unknown as { rows: Array<{ id: number }> };

        const plain = resetPasswords ? randomPassword() : account.password;
        const hash = await bcrypt.hash(plain, 12);

        if (existing.rows.length > 0) {
            if (!resetPasswords) {
                console.log(`  ${account.username}: already exists, left alone`);
                continue;
            }

            const id = existing.rows[0]!.id;

            /* Bump the epoch as well as the hash. A password reset that leaves old
               sessions signed in has not actually locked anybody out. */
            await sql.query(
                `UPDATE accounts
                    SET password_hash = $1, session_epoch = session_epoch + 1
                  WHERE id = $2`,
                [hash, id]
            );
            await sql.query('DELETE FROM sessions WHERE account_id = $1', [id]);

            created.push({ username: account.username, password: plain, role: account.role });
            continue;
        }

        await sql.query(
            `INSERT INTO accounts
                 (person_id, role, username, email, password_hash, name, label,
                  email_verified, onboarding_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)`,
            [account.personId, account.role, account.username, account.email,
             hash, account.name, account.label]
        );

        await sql.query(
            `INSERT INTO account_prefs (account_id)
             SELECT id FROM accounts WHERE username = $1
             ON CONFLICT (account_id) DO NOTHING`,
            [account.username]
        );

        /* One PRUWise conversation to arrive into, so Messages is not an empty
           screen on the first visit. */
        await sql.query(
            `INSERT INTO threads (kind, owner_account_id, last_message_at)
             SELECT 'ai', id, now() FROM accounts WHERE username = $1
             ON CONFLICT DO NOTHING`,
            [account.username]
        );

        created.push({ username: account.username, password: plain, role: account.role });
    }

    if (created.length > 0) {
        console.log('\n  ' + '-'.repeat(52));
        console.log('  SIGN-IN DETAILS' + (resetPasswords ? ' (shown once)' : ''));
        console.log('  ' + '-'.repeat(52));
        for (const row of created) {
            console.log(`  ${row.username.padEnd(20)} ${row.password.padEnd(16)} ${row.role}`);
        }
        console.log('  ' + '-'.repeat(52));
    }
}


/* =============================================================================
   THE REPORT

   The useful half of what setup.php's page did: say what is actually there, so a
   missing table or an empty seed is visible now rather than as a 500 later.
   ============================================================================= */
async function report(): Promise<void> {
    const tables = await sql.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`, []
    ) as unknown as { rows: Array<{ n: string }> };

    const counts = await sql.query(
        `SELECT
             (SELECT COUNT(*) FROM people)        AS people,
             (SELECT COUNT(*) FROM accounts)      AS accounts,
             (SELECT COUNT(*) FROM rep_profiles)  AS profiles,
             (SELECT COUNT(*) FROM people WHERE kind = 'fr')       AS reps,
             (SELECT COUNT(*) FROM people WHERE kind = 'customer') AS customers`, []
    ) as unknown as { rows: Array<Record<string, string>> };

    const c = counts.rows[0] ?? {};

    console.log('\n  Database now holds:');
    console.log(`    ${tables.rows[0]?.n ?? '?'} tables`);
    console.log(`    ${c.people ?? '?'} people (${c.reps ?? '?'} representatives, ${c.customers ?? '?'} customers)`);
    console.log(`    ${c.accounts ?? '?'} accounts, ${c.profiles ?? '?'} representative profiles`);

    /* The two things most likely to be wrong, and both are silent failures. */
    if (Number(c.accounts ?? 0) === 0) {
        console.warn('\n  WARNING: no accounts exist, so nobody can sign in.');
    }
    if (!process.env.SESSION_SECRET) {
        console.warn('\n  WARNING: SESSION_SECRET is not set. Signing in will fail with a 500 ' +
                     'until it is - see .env.example.');
    }
}


async function main(): Promise<void> {
    console.log('\nPRUWise database push\n');

    console.log('  Applying schema...');
    await runFile('schema.sql');

    console.log('\n  Seeding people...');
    await runFile('seed.sql');

    console.log('\n  Accounts...');
    await seedAccounts();

    await report();

    console.log('\nDone.\n');
}

main().catch((error: unknown) => {
    console.error('\ndb:push failed.\n', error);
    process.exit(1);
});
