/* =============================================================================
   sqlfile.ts - loading and splitting a .sql file
   -----------------------------------------------------------------------------
   Shared by api/setup.ts (which runs inside Vercel) and scripts/db-push.ts
   (which runs from a terminal), so the schema has exactly one definition and one
   parser rather than two that can drift.

   =============================================================================
   WHY SPLITTING ON ';' IS WRONG
   =============================================================================

   The Neon HTTP driver runs one statement per request, so a .sql file has to be
   cut up. The obvious approach fails on the very first thing in db/schema.sql:

       CREATE OR REPLACE FUNCTION touch_updated_at()
       RETURNS TRIGGER AS $$
       BEGIN
           NEW.updated_at = now();     <- a semicolon INSIDE the body
           RETURN NEW;                 <- and another
       END;
       $$ LANGUAGE plpgsql;

   A naive split produces three fragments, none of them valid SQL. So this tracks
   whether it is inside a dollar-quoted block, a single-quoted string, or a
   comment, and only treats a semicolon as a boundary when it is in none of them.
   ============================================================================= */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function splitStatements(text: string): string[] {
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

        /* Inside a dollar-quoted block, only its own tag ends it. */
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
            if (char === '*' && next === '/') {
                inBlockComment = false; current += '*/'; i += 2; continue;
            }
            current += char; i++; continue;
        }

        if (inSingle) {
            /* '' is an escaped quote inside a string, not the end of it. */
            if (char === "'" && next === "'") { current += "''"; i += 2; continue; }
            if (char === "'") { inSingle = false; }
            current += char; i++; continue;
        }

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

    /* Drop anything that is only a comment. Splitting leaves those behind and
       Postgres rejects an empty query. */
    return statements.filter(statement => {
        const stripped = statement
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/--[^\n]*/g, '')
            .trim();
        return stripped !== '';
    });
}


/* Read a file from db/.

   SEVERAL CANDIDATE PATHS, ON PURPOSE. A serverless function's working directory
   is not guaranteed to be the repository root, and it differs between `vercel
   dev` and the deployed runtime. Rather than guess, try the plausible ones and
   report all of them if none worked - a wrong path here produces a confusing
   "cannot find module"-shaped failure otherwise.

   The files reach the function because vercel.json lists the db folder's .sql
   files under includeFiles for api/setup.ts. Without that they would not be
   uploaded at all, since nothing imports them.

   (Written in words rather than as a glob on purpose - a glob containing a star
   followed by a slash would close this comment early, which is exactly the
   mistake that produced sixteen syntax errors the first time.) */
export function readDbFile(name: string): string {
    const tried: string[] = [];

    const candidates = [
        join(process.cwd(), 'db', name),
        join(process.cwd(), name),
        join('/var/task', 'db', name),
        join(process.cwd(), '..', 'db', name)
    ];

    for (const path of candidates) {
        tried.push(path);
        try {
            return readFileSync(path, 'utf8');
        } catch {
            /* Try the next one. */
        }
    }

    throw new Error(
        `Could not read db/${name}. Looked in: ${tried.join(', ')}. ` +
        `Check that vercel.json includes db/**/*.sql under functions.includeFiles.`
    );
}
