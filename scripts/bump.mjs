/* Bump the cache buster in index.html and APP_BUILD in js/app.js together.
   node scripts/bump.mjs 15 16 */
import { readFileSync, writeFileSync } from 'node:fs';

const from = process.argv[2];
const to = process.argv[3];

if (!from || !to) { console.error('usage: bump.mjs <from> <to>'); process.exit(1); }

const html = readFileSync('index.html', 'utf8');
const hits = (html.match(new RegExp(`\\?v=${from}\\b`, 'g')) ?? []).length;
writeFileSync('index.html', html.replaceAll(`?v=${from}`, `?v=${to}`));

const app = readFileSync('js/app.js', 'utf8');
if (!app.includes(`APP_BUILD = ${from}`)) {
    console.error(`js/app.js does not say APP_BUILD = ${from}`);
    process.exit(1);
}
writeFileSync('js/app.js', app.replace(`APP_BUILD = ${from}`, `APP_BUILD = ${to}`));

const check = readFileSync('index.html', 'utf8');
const left = (check.match(new RegExp(`\\?v=${from}\\b`, 'g')) ?? []).length;

console.log(`index.html: ${hits} occurrences of ?v=${from} -> ?v=${to}, ${left} left`);
console.log(`js/app.js:  APP_BUILD = ${to}`);
process.exit(left === 0 ? 0 : 1);
