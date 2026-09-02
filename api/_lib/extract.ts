/* =============================================================================
   extract.ts - getting the words out of an uploaded file
   -----------------------------------------------------------------------------
   Turns the bytes of a PDF, a Word file, a spreadsheet or a text file into plain
   text, so the model has something to read. There was no PHP equivalent - this is
   new.

   =============================================================================
   WHY THIS IS HAND-WRITTEN INSTEAD OF `npm install pdf-parse`
   =============================================================================

   Because it can be, using only node:zlib, which ships with Node.

   A PDF text layer is parenthesised strings inside a compressed stream, and a
   .docx is a Zip archive with an XML file in it. Both of those are things zlib and
   a hundred lines of parsing can open. Against that, a PDF library is a large
   dependency traced into every cold start of the ONE function this whole API runs
   through, and the popular one reads a test fixture off disk when it is imported,
   which is a well-known footgun on a read-only filesystem.

   THE HONEST TRADE-OFF, because it is a real one: this reads the common case and
   not every case. A PDF written by Word, Excel, Google Docs, or a bank's statement
   generator will come out fine. A PDF that uses a custom font encoding with no
   ToUnicode map may come out as gibberish, and a SCANNED PDF - a photograph of
   paper - has no text layer at all and cannot be read by any amount of parsing;
   that needs OCR, which is a paid API call and out of scope.

   So the contract is deliberately narrow: return the text, or return null and a
   sentence saying why. `null` is not a failure to be logged and forgotten, it is a
   result the uploader gets shown. See the note on `status` in db/schema.sql - a
   document nobody could read must SAY it could not be read, rather than sitting
   there looking empty and successful.
   ============================================================================= */

import { inflateSync, inflateRawSync, gunzipSync } from 'node:zlib';

/* Enough text for the model to work with and for a person to search.

   The model prompt is capped separately and much lower (see documents.ts). This
   larger cap is what gets stored, because the extracted text is also what a future
   feature would search over, and throwing it away at prompt length would make that
   impossible without re-reading every file. */
const MAX_TEXT_CHARS = 60_000;

export interface Extraction {
    text: string | null;

    /* Why there is no text, in a sentence the person who uploaded the file can
       read. Empty when text was found. */
    reason: string;

    /* True when the file type genuinely has no text to get - an image, mainly.
       Distinguishes "we could not read this" from "there is nothing to read",
       which are different messages to show. */
    notTextual: boolean;
}

function found(text: string): Extraction {
    return { text: text.slice(0, MAX_TEXT_CHARS), reason: '', notTextual: false };
}

function nothing(reason: string, notTextual = false): Extraction {
    return { text: null, reason, notTextual };
}


/* =============================================================================
   THE ENTRY POINT

   Dispatches on the SNIFFED mime type from _lib/files.ts, never on the file name.
   Never throws: a malformed file is a result, not an exception, because the caller
   is in the middle of an upload somebody is waiting on.
   ============================================================================= */

export function extractText(bytes: Buffer, mime: string): Extraction {
    try {
        if (mime === 'text/plain' || mime === 'text/csv') {
            return fromPlainText(bytes);
        }

        if (mime === 'application/pdf') {
            return fromPdf(bytes);
        }

        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            return fromDocx(bytes);
        }

        if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
            return fromXlsx(bytes);
        }

        if (mime.startsWith('image/')) {
            return nothing(
                'This is an image, so there is no text in it to read. If it is a photo ' +
                'of a document, your representative can still look at it.',
                true);
        }

        /* .doc and .xls - the pre-2007 binary formats. Their text is embedded in a
           compound-file structure with no compression, so scavenging printable runs
           out of it is possible but produces enough junk to be worse than useless. */
        if (mime === 'application/msword' || mime === 'application/vnd.ms-excel') {
            return nothing(
                'This is an older Office format that cannot be read automatically. ' +
                'Saving it as a PDF or a .docx and uploading that will work.');
        }

        return nothing('This kind of file cannot be read automatically.');

    } catch (error) {
        /* A truncated Zip, a corrupt Flate stream, a PDF with a broken xref. All of
           them mean the same thing to the person waiting. */
        console.error(`Extracting text from a ${mime} failed:`, error);

        return nothing(
            'This file could not be read - it may be damaged, password-protected, ' +
            'or saved in an unusual way.');
    }
}


/* =============================================================================
   PLAIN TEXT AND CSV
   ============================================================================= */

function fromPlainText(bytes: Buffer): Extraction {
    let text = bytes.toString('utf8');

    /* A UTF-8 byte-order mark decodes to a zero-width character that then shows up
       at the start of the first line and breaks a comparison against the first
       column heading of a CSV. */
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); }

    const tidy = tidyWhitespace(text);

    return tidy === ''
        ? nothing('This file is empty.')
        : found(tidy);
}


/* =============================================================================
   PDF
   -----------------------------------------------------------------------------
   A PDF is a set of numbered objects. The words live in "content streams": blocks
   of `stream ... endstream`, usually Flate-compressed, holding drawing operators.
   The ones that matter here are the text-showing operators:

       (Hello) Tj              draw a string
       [(H) -20 (ello)] TJ     draw an array of strings with kerning between them
       (Hello) '               new line, then draw
       (Hello) "               new line with spacing, then draw

   So: find the streams, inflate them, and pull the strings out of the text blocks.
   Everything else in the file - fonts, images, the cross-reference table - is
   skipped without being understood, which is why this stays short.
   ============================================================================= */

function fromPdf(bytes: Buffer): Extraction {
    if (findAll(bytes, Buffer.from('/Encrypt')).length > 0) {
        return nothing(
            'This PDF is password-protected or encrypted, so its text cannot be read. ' +
            'Saving an unprotected copy and uploading that will work.');
    }

    const pieces: string[] = [];

    for (const stream of pdfStreams(bytes)) {
        const text = textFromContentStream(stream);
        if (text !== '') { pieces.push(text); }
    }

    const joined = tidyWhitespace(pieces.join('\n'));

    /* A handful of characters is not a document. A PDF of scanned pages typically
       yields nothing at all, or a stray page number from a header drawn as text
       over the image. */
    if (joined.replace(/\s/g, '').length < 24) {
        return nothing(
            'No readable text was found in this PDF. That usually means it is a scan ' +
            'or a photograph of paper rather than a document with a text layer - the ' +
            'words are a picture, so there is nothing to extract. Your representative ' +
            'can still open and read it.');
    }

    return found(joined);
}

/* Every `stream ... endstream` payload, inflated where it is compressed.

   Deliberately does NOT resolve the cross-reference table. Walking the xref is the
   correct way to find page content, and it is also the part of a PDF most likely to
   be subtly wrong in a file produced by something unusual. Scanning for the keyword
   finds the same streams and cannot be defeated by a broken index. */
function* pdfStreams(bytes: Buffer): Generator<Buffer> {
    const keyword = Buffer.from('stream');
    const terminator = Buffer.from('endstream');

    for (const at of findAll(bytes, keyword)) {
        /* 'endstream' contains 'stream'. Skip those hits - the payload before them
           has already been yielded by the opening keyword. */
        if (at >= 3 && bytes.subarray(at - 3, at).toString('latin1') === 'end') { continue; }

        /* The stream dictionary is immediately before the keyword. 400 bytes is more
           than enough to catch its /Filter, and bounding the window keeps this from
           being quadratic on a large file. */
        const dictionary = bytes
            .subarray(Math.max(0, at - 400), at)
            .toString('latin1');

        /* After the keyword comes CRLF, LF, or (against the spec, but it happens) CR
           or nothing. */
        let start = at + keyword.length;
        if (bytes[start] === 0x0d) { start++; }
        if (bytes[start] === 0x0a) { start++; }

        const end = indexOfFrom(bytes, terminator, start);
        if (end === -1) { continue; }

        const payload = bytes.subarray(start, end);
        if (payload.length === 0) { continue; }

        const decoded = decodeStream(payload, dictionary);
        if (decoded !== null) { yield decoded; }
    }
}

function decodeStream(payload: Buffer, dictionary: string): Buffer | null {
    /* Filters this cannot undo. A stream behind one of them is an image, an embedded
       font or a thumbnail, none of which hold the page's words. Skipped rather than
       attempted so the output is not polluted with binary noise. */
    if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode|LZWDecode)/
        .test(dictionary)) {
        return null;
    }

    if (dictionary.includes('/FlateDecode')) {
        /* zlib-wrapped is correct and overwhelmingly common; raw deflate appears in
           files from writers that got the header wrong. Try both before giving up,
           because one of them working is the difference between a readable document
           and an empty one. */
        for (const inflate of [inflateSync, inflateRawSync]) {
            try {
                return inflate(payload);
            } catch { /* try the next one */ }
        }
        return null;
    }

    /* Uncompressed content stream - unusual but legal, and the easy case. */
    if (!dictionary.includes('/Filter')) {
        return payload;
    }

    return null;
}

/* Pull the drawn strings out of one inflated content stream.

   Walks the bytes once with a tiny state machine rather than using a regular
   expression, because a PDF string can contain unbalanced parentheses as long as
   they are escaped, and no regex handles that correctly. */
function textFromContentStream(stream: Buffer): string {
    const content = stream.toString('latin1');

    /* A content stream that is not text - a path-drawing or image-placing stream -
       has no text block at all, and skipping it early is most of the work avoided
       on a graphics-heavy page. */
    if (!content.includes('BT')) { return ''; }

    let out = '';
    let index = 0;

    /* Set when a positioning operator says the next string starts a new line, so
       that a paragraph does not run into the one below it. */
    let pendingBreak = false;

    while (index < content.length) {
        const character = content[index];

        /* ---- a literal string: ( ... ) ---- */
        if (character === '(') {
            let depth = 1;
            let raw = '';
            index++;

            while (index < content.length && depth > 0) {
                const c = content[index] as string;

                if (c === '\\') {
                    raw += c + (content[index + 1] ?? '');
                    index += 2;
                    continue;
                }
                if (c === '(') { depth++; }
                if (c === ')') {
                    depth--;
                    if (depth === 0) { index++; break; }
                }
                raw += c;
                index++;
            }

            const decoded = decodePdfString(unescapePdfString(raw));

            if (decoded !== '') {
                if (pendingBreak && out !== '' && !out.endsWith('\n')) { out += '\n'; }
                pendingBreak = false;
                out += decoded;
            }
            continue;
        }

        /* ---- a hex string: < ... > ---- */
        if (character === '<' && content[index + 1] !== '<') {
            const close = content.indexOf('>', index);
            if (close === -1) { break; }

            const hex = content.slice(index + 1, close).replace(/[^0-9a-fA-F]/g, '');
            index = close + 1;

            const decoded = decodePdfString(fromHex(hex));

            if (decoded !== '') {
                if (pendingBreak && out !== '' && !out.endsWith('\n')) { out += '\n'; }
                pendingBreak = false;
                out += decoded;
            }
            continue;
        }

        /* ---- operators that move to a new line ----

           Td and TD move the text position, T* starts the next line, and ' and "
           draw after a line break. Treated as a newline when they follow text. */
        if (character === 'T' && (content[index + 1] === 'd' || content[index + 1] === 'D'
            || content[index + 1] === '*')) {
            pendingBreak = true;
            index += 2;
            continue;
        }
        if ((character === "'" || character === '"') && out !== '') {
            pendingBreak = true;
            index++;
            continue;
        }

        /* ---- a large negative kern inside a TJ array means a space ----

           Word-spacing inside [ ... ] TJ is expressed as a negative number in
           thousandths of an em. Anything past about a third of an em is a word gap
           rather than letter kerning, and without this the whole line arrives as
           onelongrunofletters. */
        if (character === '-') {
            let digits = '';
            let scan = index + 1;

            while (scan < content.length) {
                const digit = content[scan];

                if (digit === undefined || digit < '0' || digit > '9') { break; }

                digits += digit;
                scan++;
            }

            if (digits !== '') {
                if (Number(digits) >= 300 && out !== '' && !/\s$/.test(out)) { out += ' '; }
                index = scan;
                continue;
            }
        }

        /* ---- ET closes a text block ---- */
        if (character === 'E' && content[index + 1] === 'T') {
            if (out !== '' && !out.endsWith('\n')) { out += '\n'; }
            index += 2;
            continue;
        }

        index++;
    }

    return out;
}

/* PDF string escapes: \n \r \t \b \f \( \) \\ , a backslash before a real newline
   meaning "no break", and \ddd octal. */
function unescapePdfString(raw: string): string {
    let out = '';

    for (let index = 0; index < raw.length; index++) {
        if (raw[index] !== '\\') {
            out += raw[index];
            continue;
        }

        const next = raw[++index];

        if (next === undefined) { break; }
        if (next === 'n') { out += '\n'; continue; }
        if (next === 'r') { out += '\r'; continue; }
        if (next === 't') { out += '\t'; continue; }
        if (next === 'b') { out += '\b'; continue; }
        if (next === 'f') { out += '\f'; continue; }
        if (next === '\n' || next === '\r') { continue; }

        if (next >= '0' && next <= '7') {
            let octal = next;

            while (octal.length < 3) {
                const digit = raw[index + 1];
                if (digit === undefined || digit < '0' || digit > '7') { break; }
                octal += digit;
                index++;
            }
            out += String.fromCharCode(parseInt(octal, 8));
            continue;
        }

        /* \( \) \\ and anything else: the character itself. */
        out += next;
    }

    return out;
}

/* Decide whether a decoded string is UTF-16 or single-byte, and normalise it.

   A PDF text string is either PDFDocEncoding (close enough to Latin-1) or UTF-16BE
   introduced by a byte-order mark. Getting this backwards turns readable text into
   CJK-looking noise, which is the single most obvious way a PDF extractor goes
   wrong. */
function decodePdfString(value: string): string {
    if (value.length >= 2 && value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
        let out = '';
        for (let index = 2; index + 1 < value.length; index += 2) {
            out += String.fromCharCode((value.charCodeAt(index) << 8) | value.charCodeAt(index + 1));
        }
        return cleanControl(out);
    }

    return cleanControl(value);
}

function fromHex(hex: string): string {
    const even = hex.length % 2 === 0 ? hex : hex + '0';
    let out = '';

    for (let index = 0; index < even.length; index += 2) {
        out += String.fromCharCode(parseInt(even.slice(index, index + 2), 16));
    }
    return out;
}


/* =============================================================================
   ZIP - shared by .docx and .xlsx
   -----------------------------------------------------------------------------
   Both formats are a Zip archive of XML files. This reads the CENTRAL DIRECTORY at
   the end of the archive rather than scanning for local file headers, because a
   local header is allowed to carry zeroes for the sizes and put the real values in
   a trailing data descriptor. The central directory always has them.
   ============================================================================= */

function zipEntry(bytes: Buffer, wanted: string): Buffer | null {
    /* End of central directory: 'PK\5\6'. Searched from the back because the
       archive comment, if any, comes after it. */
    const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let eocd = -1;

    for (let at = bytes.length - 22; at >= 0; at--) {
        if (bytes.subarray(at, at + 4).equals(signature)) { eocd = at; break; }
    }
    if (eocd === -1) { return null; }

    const entries = bytes.readUInt16LE(eocd + 10);
    let at = bytes.readUInt32LE(eocd + 16);

    for (let index = 0; index < entries; index++) {
        if (at + 46 > bytes.length) { return null; }

        /* 'PK\1\2' starts each central directory record. */
        if (bytes.readUInt32LE(at) !== 0x02014b50) { return null; }

        const method = bytes.readUInt16LE(at + 10);
        const compressed = bytes.readUInt32LE(at + 20);
        const nameLength = bytes.readUInt16LE(at + 28);
        const extraLength = bytes.readUInt16LE(at + 30);
        const commentLength = bytes.readUInt16LE(at + 32);
        const localAt = bytes.readUInt32LE(at + 42);
        const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('latin1');

        if (name === wanted) {
            /* The local header's extra field can be a different length from the
               central one, so it has to be read from the local header itself. */
            if (localAt + 30 > bytes.length) { return null; }

            const localNameLength = bytes.readUInt16LE(localAt + 26);
            const localExtraLength = bytes.readUInt16LE(localAt + 28);
            const from = localAt + 30 + localNameLength + localExtraLength;
            const payload = bytes.subarray(from, from + compressed);

            if (method === 0) { return payload; }
            if (method === 8) { return inflateRawSync(payload); }

            return null;
        }

        at += 46 + nameLength + extraLength + commentLength;
    }

    return null;
}


/* =============================================================================
   .docx
   ============================================================================= */

function fromDocx(bytes: Buffer): Extraction {
    const document = zipEntry(bytes, 'word/document.xml');

    if (document === null) {
        return nothing(
            'This does not look like a Word document inside, so its text could not ' +
            'be read.');
    }

    const xml = document.toString('utf8');

    const text = tidyWhitespace(
        xml
            /* Structure first, while the tags are still there to tell us about it. */
            .replace(/<w:tab\b[^>]*\/?>/g, '\t')
            .replace(/<w:br\b[^>]*\/?>/g, '\n')
            .replace(/<\/w:p>/g, '\n')
            .replace(/<\/w:tr>/g, '\n')
            .replace(/<\/w:tc>/g, '\t')
            .replace(/<[^>]+>/g, '')
    );

    return text === ''
        ? nothing('This Word document has no text in it.')
        : found(decodeXmlEntities(text));
}


/* =============================================================================
   .xlsx
   -----------------------------------------------------------------------------
   Cell text lives in xl/sharedStrings.xml and the numbers in the sheet. Reading
   both, without reconstructing the grid: the model is being asked what the
   document is about, not to recalculate it, and a faithful grid would need the
   column widths, merged ranges and number formats to mean anything.
   ============================================================================= */

function fromXlsx(bytes: Buffer): Extraction {
    const parts: string[] = [];

    const shared = zipEntry(bytes, 'xl/sharedStrings.xml');

    if (shared !== null) {
        const labels = shared.toString('utf8')
            .split(/<si>/)
            .slice(1)
            .map((chunk) => decodeXmlEntities(
                chunk.split('</si>')[0]?.replace(/<[^>]+>/g, '') ?? '').trim())
            .filter((label) => label !== '');

        if (labels.length > 0) {
            parts.push('Labels used in this spreadsheet:', labels.join(' | '));
        }
    }

    /* The first three sheets. A workbook with forty tabs would otherwise fill the
       whole text budget with the first one's neighbours. */
    for (let index = 1; index <= 3; index++) {
        const sheet = zipEntry(bytes, `xl/worksheets/sheet${index}.xml`);
        if (sheet === null) { continue; }

        const values = [...sheet.toString('utf8').matchAll(/<v>([^<]*)<\/v>/g)]
            .map((match) => decodeXmlEntities(match[1] ?? '').trim())
            .filter((value) => value !== '')
            .slice(0, 2000);

        if (values.length > 0) {
            parts.push(`Sheet ${index} values:`, values.join(' | '));
        }
    }

    const text = tidyWhitespace(parts.join('\n'));

    return text === ''
        ? nothing('This spreadsheet appears to be empty.')
        : found(text);
}


/* =============================================================================
   SHARED TIDYING
   ============================================================================= */

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))

        /* LAST, or an &amp;lt; in the original becomes a real < and the document can
           carry markup into somewhere that did not expect any. */
        .replace(/&amp;/g, '&');
}

/* Strip the control characters that survive extraction. Postgres rejects a NUL in
   a text column outright, so this is what stops a document with one byte of noise
   in it from failing to save at all. */
function cleanControl(text: string): string {
    let out = '';

    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;

        if (code === 9 || code === 10 || code === 13) { out += character; continue; }
        if (code < 32 || code === 127) { continue; }
        if (code >= 0xfffe) { continue; }

        out += character;
    }

    return out;
}

/* TABS ARE KEPT ON PURPOSE, and this function used to destroy them.

   A table cell boundary and a paragraph break are the only structure that survives
   extraction, and they are what tell the model that "Annual income" and "84,000"
   are a label and its value rather than four words in a row. Collapsing tabs into
   spaces - which `[ \t]+` -> ' ' did - turned every payslip and every statement
   into an undifferentiated sentence. */
function tidyWhitespace(text: string): string {
    return cleanControl(text)
        .replace(/\r\n?/g, '\n')

        /* Every kind of horizontal whitespace EXCEPT a tab or a newline, collapsed.
           Written as a negated class so a non-breaking space - which PDFs and Word
           both emit freely - is included without being listed. */
        .replace(/[^\S\n\t]+/g, ' ')

        /* A tab, plus any spaces or further tabs padding it, is one tab. */
        .replace(/ *\t[ \t]*/g, '\t')

        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}


/* =============================================================================
   BUFFER SEARCHING

   Buffer.indexOf exists; what is missing is "every occurrence", and a generator
   over a large PDF is worth not building an array for.
   ============================================================================= */

function findAll(haystack: Buffer, needle: Buffer): number[] {
    const hits: number[] = [];
    let at = haystack.indexOf(needle);

    while (at !== -1) {
        hits.push(at);
        at = haystack.indexOf(needle, at + 1);

        /* A pathological file will not be allowed to produce a million hits. */
        if (hits.length >= 5000) { break; }
    }

    return hits;
}

function indexOfFrom(haystack: Buffer, needle: Buffer, from: number): number {
    return haystack.indexOf(needle, from);
}


/* =============================================================================
   A GZIP HELPER, EXPORTED FOR COMPLETENESS OF THE .gz CASE

   Not reachable from extractText - .gz is not in the upload allow-list. Kept
   because a compressed statement export is a plausible thing for somebody to try
   next, and it is two lines.
   ============================================================================= */

export function gunzipText(bytes: Buffer): string | null {
    try {
        return tidyWhitespace(gunzipSync(bytes).toString('utf8'));
    } catch {
        return null;
    }
}
