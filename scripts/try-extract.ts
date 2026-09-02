/* Throwaway. Proves extract.ts on files built here, so a bug in the parser is
   found on this machine and not by a customer's payslip.
   Run:  node --experimental-strip-types scripts/try-extract.ts  */

import { deflateRawSync, deflateSync } from 'node:zlib';
import { extractText } from '../api/_lib/extract.ts';

let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
    if (!condition) { failed++; }
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   -> ' + detail : ''}`);
}

/* ---------------------------------------------------------------- plain text */
{
    const bytes = Buffer.from('Name: Sarah Tan\nAnnual income: 84000\nDependants: 2\n', 'utf8');
    const r = extractText(bytes, 'text/plain');

    check('text/plain is read', r.text !== null);
    check('text/plain keeps the numbers', (r.text ?? '').includes('84000'));
}

/* a BOM must not survive into the first line */
{
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('policy,amount\nPRUShield,120', 'utf8')]);
    const r = extractText(bytes, 'text/csv');

    check('a UTF-8 BOM is removed', (r.text ?? '').startsWith('policy'), JSON.stringify((r.text ?? '').slice(0, 12)));
}

/* --------------------------------------------------------- an image is not text */
{
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = extractText(png, 'image/png');

    check('an image reports notTextual', r.text === null && r.notTextual);
    check('and says why in a readable sentence', /image/i.test(r.reason));
}

/* ------------------------------------------------------------------ a real PDF

   Built by hand so the bytes are known. One uncompressed content stream and one
   Flate-compressed one, which are the two paths decodeStream has. */
function pdf(streams: Array<{ body: Buffer; flate: boolean }>): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];

    streams.forEach((s, index) => {
        const body = s.flate ? deflateSync(s.body) : s.body;
        const dict = s.flate
            ? `<< /Length ${body.length} /Filter /FlateDecode >>`
            : `<< /Length ${body.length} >>`;

        parts.push(Buffer.from(`${index + 1} 0 obj\n${dict}\nstream\n`, 'latin1'));
        parts.push(body);
        parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    });

    parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1'));
    return Buffer.concat(parts);
}

{
    const plain = Buffer.from(
        'BT /F1 12 Tf 72 720 Td (PRUShield annual statement) Tj 0 -18 Td (Policyholder: Sarah Tan) Tj ET',
        'latin1');

    const r = extractText(pdf([{ body: plain, flate: false }]), 'application/pdf');

    check('an uncompressed PDF stream is read', r.text !== null, r.reason);
    check('  and the words come out', (r.text ?? '').includes('PRUShield annual statement'));
    check('  and Td starts a new line', (r.text ?? '').includes('\nPolicyholder: Sarah Tan'),
        JSON.stringify(r.text));
}

{
    const compressed = Buffer.from(
        'BT /F1 12 Tf (Total annual premium payable for the coverage) Tj ET',
        'latin1');

    const r = extractText(pdf([{ body: compressed, flate: true }]), 'application/pdf');

    check('a FlateDecode PDF stream is inflated', r.text !== null, r.reason);
    check('  and reads correctly', (r.text ?? '').includes('Total annual premium payable'));
}

/* a TJ array with kerning must not run the words together */
{
    const kerned = Buffer.from(
        'BT [(Sum) -400 (assured) -400 (is) -400 (confirmed) -30 (separately)] TJ ET',
        'latin1');

    const r = extractText(pdf([{ body: kerned, flate: true }]), 'application/pdf');
    const text = r.text ?? '';

    check('a big negative kern becomes a space', text.includes('Sum assured is confirmed'), JSON.stringify(text));
    check('a small kern does not', text.includes('confirmedseparately'), JSON.stringify(text));
}

/* escapes and octal */
{
    const escaped = Buffer.from(
        'BT (Owner \\(joint\\) 50\\05750 split) Tj (a) Tj (b) Tj (c) Tj (defghijklmnopqrst) Tj ET',
        'latin1');

    const r = extractText(pdf([{ body: escaped, flate: true }]), 'application/pdf');

    check('escaped parentheses survive', (r.text ?? '').includes('Owner (joint)'), JSON.stringify(r.text));
    check('an octal escape decodes', (r.text ?? '').includes('50/50 split'), JSON.stringify(r.text));
}

/* a UTF-16BE string with a byte-order mark */
{
    const utf16 = Buffer.concat([
        Buffer.from('BT (', 'latin1'),
        Buffer.from([0xfe, 0xff]),
        /* Long enough to clear the "this is a scan" floor, so a failure here can
           only mean the UTF-16 decode itself is wrong. */
        Buffer.from([...'Policy schedule enclosed for your records']
            .flatMap((c) => [0x00, c.charCodeAt(0)])),
        Buffer.from(') Tj ET', 'latin1')
    ]);

    const r = extractText(pdf([{ body: utf16, flate: true }]), 'application/pdf');

    check('a UTF-16BE PDF string decodes', (r.text ?? '').includes('Policy schedule enclosed'), JSON.stringify(r.text));
}

/* a scan - an image stream and no text layer */
{
    const image = Buffer.from('\xff\xd8\xff\xe0 not really a jpeg but long enough to look like one', 'latin1');
    const parts = Buffer.concat([
        Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + image.length + ' /Filter /DCTDecode >>\nstream\n', 'latin1'),
        image,
        Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')
    ]);

    const r = extractText(parts, 'application/pdf');

    check('a scanned PDF is refused, not returned empty', r.text === null);
    check('  and the message explains it is a scan', /scan/i.test(r.reason), r.reason);
}

/* encryption is detected before anything else */
{
    const enc = Buffer.from('%PDF-1.4\ntrailer << /Encrypt 9 0 R >>\n%%EOF', 'latin1');
    const r = extractText(enc, 'application/pdf');

    check('an encrypted PDF says so', r.text === null && /password|encrypt/i.test(r.reason), r.reason);
}

/* ----------------------------------------------------------------- a real .docx

   A minimal Zip built by hand: one deflated entry, a central directory, an EOCD.
   This is what proves zipEntry reads the central directory correctly. */
function zip(name: string, content: Buffer): Buffer {
    const nameBytes = Buffer.from(name, 'latin1');
    const deflated = deflateRawSync(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    /* Deliberately give the LOCAL header an extra field the central one does not
       have. A reader that uses the central extra length to find the payload lands
       in the middle of the data - this is the exact bug the code comments call out. */
    const extra = Buffer.from([0x99, 0x99, 0x04, 0x00, 1, 2, 3, 4]);
    local.writeUInt16LE(extra.length, 28);

    const localBlock = Buffer.concat([local, nameBytes, extra, deflated]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 42);

    const centralBlock = Buffer.concat([central, nameBytes]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralBlock.length, 12);
    eocd.writeUInt32LE(localBlock.length, 16);

    return Buffer.concat([localBlock, centralBlock, eocd]);
}

{
    const xml = Buffer.from(
        '<?xml version="1.0"?><w:document><w:body>' +
        '<w:p><w:r><w:t>Financial review notes</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Income</w:t></w:r><w:tab/><w:r><w:t>84,000</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Cover is decided by the representative &amp; confirmed in writing</w:t></w:r></w:p>' +
        '</w:body></w:document>', 'utf8');

    const r = extractText(
        zip('word/document.xml', xml),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    const text = r.text ?? '';

    check('a .docx is read', r.text !== null, r.reason);
    check('  paragraphs become lines', text.includes('Financial review notes\nIncome'), JSON.stringify(text));
    check('  a tab separates a label from its value', text.includes('Income\t84,000'), JSON.stringify(text));
    check('  &amp; is decoded', text.includes('representative & confirmed'), JSON.stringify(text));
}

/* a .docx that is not one */
{
    const r = extractText(
        zip('hello.txt', Buffer.from('nope', 'utf8')),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    check('a Zip with no document.xml is refused', r.text === null, r.reason);
}

/* ---------------------------------------------------------------- a real .xlsx */
{
    const shared = Buffer.from(
        '<sst><si><t>Premium</t></si><si><t>Sum assured</t></si></sst>', 'utf8');

    const r = extractText(
        zip('xl/sharedStrings.xml', shared),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    check('an .xlsx shared-string table is read', (r.text ?? '').includes('Premium | Sum assured'),
        JSON.stringify(r.text));
}

/* --------------------------------------------------------------- damaged input */
{
    const r = extractText(Buffer.from('PK\x03\x04 truncated rubbish', 'latin1'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    check('a truncated Zip does not throw', r.text === null, r.reason);
}

{
    const r = extractText(Buffer.alloc(0), 'text/plain');
    check('an empty file says it is empty', r.text === null && /empty/i.test(r.reason), r.reason);
}

/* a NUL byte must never reach Postgres */
{
    const r = extractText(Buffer.from('before\x00after', 'utf8'), 'text/plain');

    check('a NUL byte is stripped', (r.text ?? '').indexOf('\x00') === -1, JSON.stringify(r.text));
    check('  and the text either side survives', (r.text ?? '').includes('beforeafter'), JSON.stringify(r.text));
}

console.log(failed === 0 ? '\nEXTRACTION OK' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
