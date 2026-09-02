/* =============================================================================
   db.ts - the database layer
   -----------------------------------------------------------------------------
   Replaces the db() / q() / one() / all() / column() helpers in
   php/lib/bootstrap.php, and keeps their names and shapes on purpose.

   =============================================================================
   WHY THE ? PLACEHOLDERS SURVIVED THE PORT
   =============================================================================

   Postgres numbers its parameters - $1, $2 - where MySQL uses ?. Thirty-eight
   endpoints and eleven libraries of PHP are being translated, and every single
   one of them is full of queries written with ?.

   Renumbering them all by hand would be hundreds of edits whose mistakes are
   invisible: swap $2 and $3 in a WHERE clause and the query still runs, still
   returns rows, and returns the WRONG ones. That is the worst class of bug to
   introduce during a mechanical port, because nothing fails loudly.

   So toPositional() below rewrites ? into $1, $2 at call time. The queries stay
   character-for-character comparable with the PHP they came from, which means a
   reviewer can diff them, and the numbering is done by a function that cannot
   miscount.

   THE ONE LIMITATION: a literal question mark inside a quoted string in SQL
   would be rewritten too. No query in this project has one - user text always
   arrives as a parameter, never inlined - and buildQuery throws if the
   placeholder count and the parameter count disagree, which catches it.

   =============================================================================
   HTTP FOR READS, WEBSOCKET FOR TRANSACTIONS
   =============================================================================

   Neon offers two drivers and they are good at different things.

   neon() speaks HTTP: one round trip, no connection to establish, no pool to
   exhaust. That is what a serverless function wants, and it is what everything
   here uses by default. It matters more than usual for this app because the
   frontend polls - the ring check alone fires every few seconds per signed-in
   user - and a pooled TCP driver would spend its life opening connections.

   Pool() speaks the real Postgres protocol over a WebSocket, which is the only
   way to get an interactive transaction: BEGIN, look at what happened, then
   decide what to do next. withTransaction() below uses it, and almost nothing
   needs to - see the note there about doing it in one statement instead.
   ============================================================================= */

import { neon, types as pgTypes } from '@neondatabase/serverless';
import { env } from './env.js';

export type Row = Record<string, unknown>;
export type Param = string | number | boolean | null | Date | object;

/* What the driver hands back when fullResults is on. Matches node-postgres. */
interface FullResult {
    rows: Row[];
    rowCount: number;
    command: string;
}

/* One client per function instance. Vercel reuses a warm instance across
   requests, so building this once rather than per-call avoids re-parsing the
   connection string on every hit. It is lazy because module load happens before
   we know whether this endpoint even touches the database, and env.databaseUrl
   throws when unset.

   =============================================================================
   fullResults IS NOT OPTIONAL HERE. IT IS LOAD-BEARING.
   =============================================================================

   By default this driver returns ONLY the rows - a bare array. For a SELECT that
   is convenient. For an UPDATE with no RETURNING clause it is a disaster,
   because the array is empty whether the statement changed fifty rows or none,
   so any "did that actually do anything" check reads 0 forever.

   This project leans on exactly that check everywhere. The pattern throughout is
   to let the WHERE clause be the lock:

       UPDATE consultation_requests SET status = 'accepted'
        WHERE id = $1 AND status = 'pending'

   If two representatives accept the same request at the same instant, only one
   of them updates a row and the other must be told it has already been dealt
   with. Accepting policy applications, declining them, withdrawing them and
   marking them under review all work the same way.

   Without fullResults every one of those checks would quietly believe it had
   lost the race, and the app would report "already handled" for actions that had
   just succeeded. With it, rowCount is the real affected-row count and the ported
   PHP logic keeps its meaning.
   ============================================================================= */
let client: ReturnType<typeof neon> | null = null;

function sql() {
    if (!client) {
        client = neon(env.databaseUrl, { fullResults: true });
    }
    return client;
}

/* =============================================================================
   BIGINT COMES BACK AS A STRING UNLESS YOU SAY OTHERWISE
   =============================================================================

   Postgres int8 holds values larger than a JavaScript number can represent
   exactly, so every Postgres driver in every language hands it over as TEXT by
   default. That is the correct default and it is completely wrong for this
   project, where int8 is only ever used for an identity column.

   THE BUG IT CAUSED, so nobody reintroduces it. messages.id is BIGINT. An INSERT
   ... RETURNING id therefore produced the STRING "14", which then:

     - was returned to the browser as messageId: "14"
     - compared false against every message.id in the same response, because
       those went through Number() on the way out
     - and quietly worked anyway in arithmetic, because "14" - 1 is 13, so the
       follow-up query returned the right rows and nothing looked broken

   A value that is wrong, compares wrong, and computes right is the worst
   possible combination. Fixed here rather than with a Number() at each call
   site, because a call site that forgets is a bug nobody will see.

   SAFE FOR THIS SCHEMA: the largest int8 in it is an identity column, and
   Number.MAX_SAFE_INTEGER is about 9e15. A chat application would need to send
   nine quadrillion messages to reach it.
   ============================================================================= */
const PG_INT8 = 20;

const typeParsers = {
    getTypeParser(oid: number, format?: 'text' | 'binary'): unknown {
        if (oid === PG_INT8) {
            return (value: string) => (value === null ? null : Number(value));
        }
        return pgTypes.getTypeParser(oid, format);
    }
};

/* One place that runs a statement, so the cast to FullResult and the type
   parsers live here rather than at four call sites.

   The parsers are passed PER QUERY rather than to neon(). Its constructor
   destructures the options it recognises and `types` is not among them, so a
   config handed over there is silently dropped - which is exactly how you end up
   believing this is fixed when it is not. */
async function run(text: string, params: readonly Param[]): Promise<FullResult> {
    const result = await sql().query(
        buildQuery(text, params),
        params as unknown[],
        { types: typeParsers as never }
    );
    return result as unknown as FullResult;
}


/* ?  ->  $1, $2, $3 ...

   Also validates the count, which is the check that makes the rewrite safe: if a
   query has three placeholders and two parameters arrive, that is a mistake in
   the caller and it is far better to hear about it here than to have Postgres
   report something vaguer. */
function toPositional(text: string, params: readonly Param[]): string {
    let index = 0;
    const converted = text.replace(/\?/g, () => `$${++index}`);

    if (index !== params.length) {
        throw new Error(
            `Query has ${index} placeholder(s) but ${params.length} parameter(s) were given. ` +
            `Query: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`
        );
    }
    return converted;
}

/* Already-numbered queries pass through untouched, so a query that genuinely
   needs $1 twice - which ? cannot express - can still be written directly. */
function looksPositional(text: string): boolean {
    return /\$\d/.test(text) && !text.includes('?');
}

function buildQuery(text: string, params: readonly Param[]): string {
    return looksPositional(text) ? text : toPositional(text, params);
}


/* =============================================================================
   THE FOUR HELPERS

   Same names as php/lib/bootstrap.php, so a ported function reads the same:

       one('SELECT * FROM accounts WHERE id = ?', [id])
       all('SELECT * FROM people WHERE kind = ?', ['customer'])
       column('SELECT COUNT(*) FROM messages WHERE thread_id = ?', [id])
       q('UPDATE accounts SET last_login_at = now() WHERE id = ?', [id])
   ============================================================================= */

/* Every row. */
export async function all<T = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
    const result = await run(text, params);
    return result.rows as T[];
}

/* The first row, or null.

   null rather than undefined because the PHP returned null and every ported
   caller checks `if (!row)`. Both are falsy, but keeping one of them means
   `row === null` comparisons that were correct stay correct. */
export async function one<T = Row>(text: string, params: readonly Param[] = []): Promise<T | null> {
    const rows = await all<T>(text, params);
    return rows.length > 0 ? (rows[0] as T) : null;
}

/* The first value of the first row, or null.

   Used for COUNT(*), for existence checks, and for pulling a single id. The PHP
   version returned false for "no row" and this returns null, which is the one
   deliberate difference - `false` was never distinguishable from a genuine
   falsy value like 0, and COUNT(*) legitimately returns 0. */
export async function column<T = string | number | null>(
    text: string,
    params: readonly Param[] = []
): Promise<T | null> {
    const row = await one(text, params);
    if (!row) { return null; }

    const values = Object.values(row);
    return (values.length > 0 ? values[0] : null) as T | null;
}

/* A write. Returns the affected row count so the ported code can keep its
   "did this actually change anything" checks.

   THAT COUNT IS LOAD-BEARING, not diagnostic. The pattern throughout this
   project is to let the WHERE clause do the locking:

       UPDATE consultation_requests SET status = 'accepted'
        WHERE id = ? AND status = 'pending'

   If two representatives accept the same request at the same moment, only one of
   them updates a row. The other sees 0 here and stops. A read-then-write check
   would let both through. */
export async function q(
    text: string,
    params: readonly Param[] = []
): Promise<{ rowCount: number; rows: Row[] }> {
    const result = await run(text, params);

    /* rowCount is the driver's real affected-row count - see the long note above
       sql(). rows is whatever RETURNING produced, or empty. */
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
}

/* A write that needs its result back.

   Postgres can RETURNING from an INSERT or UPDATE, which MySQL cannot. The PHP
   had to insert and then call lastInsertId(); here the new row comes back from
   the same statement, so there is no second query and no window between them. */
export async function returning<T = Row>(
    text: string,
    params: readonly Param[] = []
): Promise<T | null> {
    return one<T>(text, params);
}

/* Run a statement EXACTLY as written, with no placeholder rewriting.

   For schema DDL, which never has parameters and must not be reinterpreted.

   THIS EXISTS BECAUSE THE ? REWRITER BIT US. toPositional() turns every question
   mark into a numbered placeholder, which is right for the hand-written queries
   it was built for and wrong for a file of CREATE TABLE statements - because a
   comment in that file said "when did my email change?", the rewriter turned it
   into $1, then refused the statement for having one placeholder and no
   parameters. The audit_log table silently did not get created.

   The lesson generalises: a convenience that rewrites SQL must not be applied to
   SQL nobody wrote by hand. Anything reading a .sql file off disk goes through
   here instead. */
export async function raw(text: string): Promise<{ rowCount: number; rows: Row[] }> {
    const raw = await sql().query(text, [], { types: typeParsers as never });
    const result = raw as unknown as FullResult;

    return { rowCount: result.rowCount ?? 0, rows: result.rows };
}


/* =============================================================================
   TRANSACTIONS

   READ THIS BEFORE USING IT.

   Most of what looked like it needed a transaction in the PHP does not need one
   here, because Postgres can do the whole thing in a single statement. Issuing a
   policy is the example: the PHP opened a transaction, updated the application,
   checked rowCount, then inserted the policy. In Postgres that is one statement:

       WITH resolved AS (
           UPDATE policy_applications SET status = 'issued', resolved_at = now()
            WHERE id = $1 AND status IN ('submitted','under_review')
        RETURNING id, customer_person_id, product_id, cover, ci_cover, premium
       )
       INSERT INTO policies (application_id, person_id, product_id, ...)
       SELECT id, customer_person_id, product_id, ... FROM resolved
       RETURNING *;

   That is atomic by construction, cannot half-apply, and needs no transaction at
   all. If `resolved` selects nothing - because somebody else got there first -
   the INSERT inserts nothing and returns no row, which is exactly the signal the
   caller wanted. Prefer that.

   THERE IS DELIBERATELY NO INTERACTIVE TRANSACTION HELPER.

   An interactive transaction - BEGIN, inspect the result, decide what to do next,
   COMMIT - needs a real Postgres connection, which over this driver means a
   WebSocket, which in Node means supplying a WebSocket implementation and
   accepting a connection setup cost on a platform that charges by the
   millisecond. It also does not pool across invocations, so every call pays it.

   Nothing in this application actually needs one. Every place the PHP opened a
   transaction was doing the same thing: a conditional UPDATE followed by an
   INSERT that depended on whether the UPDATE matched. Postgres expresses that in
   one statement, atomically, as shown above.

   If you find yourself wanting one, look first at whether a CTE or batch() will
   do. It almost always will, and the result is both faster and harder to get
   wrong than manual BEGIN/COMMIT with error handling around it.
   ============================================================================= */

/* Several statements, all or nothing, in one round trip.

   For the case where two or more writes must not half-apply but no decision has
   to be made between them - so there is nothing to inspect mid-flight and a CTE
   would be contorted. The driver wraps them in a real transaction.

   Takes pre-built template queries rather than strings, because that is what the
   driver's transaction() accepts:

       await batch(sqlt => [
           sqlt`UPDATE people SET rep_id = ${repId} WHERE id = ${customerId}`,
           sqlt`INSERT INTO rep_assignments (customer_person_id, to_rep_id)
                VALUES (${customerId}, ${repId})`
       ]);

   Note the template form. Values interpolated with ${} are parameterised by the
   driver, not concatenated, so this is not a SQL injection hazard despite looking
   like string building. */
export async function batch<T = unknown[]>(
    build: (sqlt: ReturnType<typeof neon>) => unknown[]
): Promise<T> {
    const client = sql();
    const queries = build(client);

    return client.transaction(queries as never) as Promise<T>;
}


/* =============================================================================
   SMALL CONVERSIONS

   Two things the PHP did with SQL that Postgres does differently, wrapped so the
   difference is written down once.
   ============================================================================= */

/* MySQL: INSERT IGNORE. Postgres: ON CONFLICT DO NOTHING.

   Not a function - there is nothing to abstract - but the mapping is here so
   anybody grepping for "INSERT IGNORE" while reading the PHP finds the answer:

       INSERT IGNORE INTO threads (...)          becomes
       INSERT INTO threads (...) ON CONFLICT DO NOTHING

   And MySQL's INSERT ... ON DUPLICATE KEY UPDATE becomes
       INSERT ... ON CONFLICT (col) DO UPDATE SET x = EXCLUDED.x
   ============================================================================= */

/* Timestamps out of Postgres arrive as Date objects. The browser expects the ISO
   strings that php/lib/bootstrap.php's to_iso() produced, so this is the same
   function under the same name.

   Accepts what the driver might actually hand over - a Date, a string if the
   column was text, or null - because being strict here would mean a cast at
   every call site. */
export function toIso(value: unknown): string | null {
    if (value === null || value === undefined) { return null; }
    if (value instanceof Date) { return value.toISOString(); }

    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/* A DATE column, as YYYY-MM-DD with no time and no timezone shifting.

   toIso() would be wrong for these. A policy's start_date is a day, and pushing
   it through a UTC timestamp can move it to the previous one for anybody east of
   Greenwich - which is how a policy issued on the 1st starts showing as the 31st. */
export function toDateOnly(value: unknown): string | null {
    if (value === null || value === undefined) { return null; }

    if (value instanceof Date) {
        const y = value.getUTCFullYear();
        const m = String(value.getUTCMonth() + 1).padStart(2, '0');
        const d = String(value.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}
