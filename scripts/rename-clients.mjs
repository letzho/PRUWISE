/* =============================================================================
   scripts/rename-clients.mjs  -  "customer" -> "client" in the INTERFACE only
   -----------------------------------------------------------------------------
       node scripts/rename-clients.mjs          list every change, write nothing
       node scripts/rename-clients.mjs --write  apply them

   =============================================================================
   WHY THIS IS A SCRIPT AND NOT FIND-AND-REPLACE
   =============================================================================

   The word appears about a thousand times across js/ and index.html, and most of
   those occurrences MUST NOT change:

     'customer'                 a role value, compared against the database
     kind: 'customer'           the people.kind column
     view: 'customer'           which side of a shared component is rendering
     data-act="open-customer"   an action name a handler is listening for
     customersForRep(...)       a function name
     customerId                 a field name in an API response
     '/fr/customers'            a route, and a bookmark somebody may hold
     .cust-grid                 a CSS class

   Renaming any of those breaks something silently - a role check that never
   matches, a button that stops responding, a route that 404s. The database
   columns and API field names are deliberately left alone too: renaming them is a
   migration with real risk and NO user-visible benefit, because nobody reads them.

   So this only rewrites text a person actually sees, and it prints every single
   change so the whole set can be read before anything is written.

   THE RULES, in order:
     1. Only inside string literals. Code outside them is never touched.
     2. Never a literal that is EXACTLY the word - that is a token, not a sentence.
     3. Never when glued to a word character, hyphen or slash on either side -
        that catches customerId, open-customer and /fr/customers.
     4. Possessive apostrophes are handled, including the escaped \u2019 form.
   ============================================================================= */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const write = process.argv.includes('--write');

const files = [
    ...readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
    'index.html'
];

/* Literals that are VALUES rather than prose. Left exactly as they are.

   LOWERCASE ONLY, and that distinction was a bug the first time round. 'Customer'
   and 'Customers' were in here too, which meant a literal that was exactly
   `'Customers'` got skipped - and the sidebar label is exactly that, so the one
   word most people actually read never changed.

   A capitalised bare word is display text: role values, enum members and action
   names in this codebase are all lowercase. So only the lowercase forms are
   protected. */
const TOKENS = new Set([
    'customer', 'customers',
    'customer-navigator', 'open-customer', 'row-customer', 'cust-filter',
    'cust-view', 'cust-search', 'customersForRep'
]);

/* The replacements, longest first so "Customers" is tried before "Customer". */
const WORDS = [
    ['Customers', 'Clients'],
    ['customers', 'clients'],
    ['Customer', 'Client'],
    ['customer', 'client'],
    ['CUSTOMERS', 'CLIENTS'],
    ['CUSTOMER', 'CLIENT']
];

/* Rule 3. A match is only prose if neither side is glued to an identifier, a
   hyphen or a slash. */
function rewrite(text) {
    let out = text;

    for (const [from, to] of WORDS) {
        out = out.replace(
            new RegExp(`(^|[^\\w/-])${from}(?![\\w-])`, 'g'),
            (_match, before) => `${before}${to}`
        );
    }

    return out;
}

/* Walk a file, finding string literals of all three quote styles, and rewrite
   only their contents. Escapes are respected so a literal containing \' does not
   end early. */
function processFile(source) {
    let out = '';
    let index = 0;
    const changes = [];

    while (index < source.length) {
        const ch = source[index];

        if (ch !== "'" && ch !== '"' && ch !== '`') {
            out += ch;
            index++;
            continue;
        }

        /* Read the whole literal. */
        const quote = ch;
        let body = '';
        let scan = index + 1;
        let closed = false;

        while (scan < source.length) {
            const c = source[scan];

            if (c === '\\') { body += c + (source[scan + 1] ?? ''); scan += 2; continue; }
            if (c === quote) { closed = true; break; }

            /* An unterminated literal means this quote was not a string at all -
               an apostrophe inside a comment, most likely. Bail out and treat it
               as an ordinary character. */
            if (c === '\n' && quote !== '`') { break; }

            body += c;
            scan++;
        }

        if (!closed) {
            out += ch;
            index++;
            continue;
        }

        const replaced = TOKENS.has(body) ? body : rewrite(body);

        if (replaced !== body) {
            changes.push({ from: body, to: replaced });
        }

        out += quote + replaced + quote;
        index = scan + 1;
    }

    return { out, changes };
}

let total = 0;
const perFile = [];

for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const { out, changes } = processFile(source);

    if (!changes.length) { continue; }

    total += changes.length;
    perFile.push({ file, count: changes.length, changes });

    if (write) { writeFileSync(file, out, 'utf8'); }
}

for (const entry of perFile) {
    console.log(`\n=== ${entry.file}  (${entry.count}) ===`);

    for (const change of entry.changes) {
        const short = (s) => s.length > 96 ? s.slice(0, 96) + '...' : s;
        console.log(`  - ${short(change.from)}`);
        console.log(`  + ${short(change.to)}`);
    }
}

console.log(`\n${total} string literal(s) across ${perFile.length} file(s)`);
console.log(write ? 'WRITTEN' : 'DRY RUN - pass --write to apply');
