/* =============================================================================
   files.ts - attachments: taking them in, and giving them back
   -----------------------------------------------------------------------------
   Replaces the storage half of php/api/upload.php and php/api/file.php.

   =============================================================================
   UPLOADS ARE THE MOST DANGEROUS THING IN A WEB APP
   =============================================================================

   Somebody hands your server a file and asks you to keep it. Get it wrong and you
   have given them a way to run their own code on your machine. The PHP version
   relied on four defences; three of them survive the port, and the fourth stopped
   being necessary:

     1. THE NAME IS THROWN AWAY. The stored name is random and its extension comes
        from our own map, keyed on the SNIFFED type. A name like "../../index.php"
        or "shell.php" cannot survive contact with the server. The original is kept
        only as text, to display.

     2. THE TYPE IS SNIFFED, NOT ASKED. The browser's Content-Type is a claim, not
        evidence. sniffMime() reads the leading bytes and that is what gets checked
        against the allow-list.

     3. NOTHING IS SERVED DIRECTLY. Every read goes through /api/file, which checks
        the reader is in the conversation before sending a byte.

     4. (gone) "PHP cannot run in the upload folder". There is no upload folder and
        no PHP. The bytes live in Blob storage or in a bytea column, and neither is
        a place code can be executed from. This is the one respect in which the
        move to serverless made uploads safer rather than harder.

   =============================================================================
   WHERE THE BYTES GO
   =============================================================================

   Vercel Blob when BLOB_READ_WRITE_TOKEN is configured, Postgres otherwise. See
   the long note above attachment_bytes in db/schema.sql for why there are two.

   A NOTE ON BLOB AND PRIVACY, because it matters for a customer's documents. A
   Vercel Blob URL is PUBLIC to anybody holding it - there is no per-request
   authorisation on the storage itself. Two things keep that honest here:
   addRandomSuffix makes the URL unguessable, and the URL is never sent to a
   browser. /api/file streams the bytes through the function after checking
   permission, so the only thing that ever reaches the page is /api/file?id=42.
   That is weaker than a truly private store and stronger than a guessable path.
   ============================================================================= */

import { put, del } from '@vercel/blob';
import { randomBytes } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import { all, column, one, q, type Row } from './db.js';
import { env, has } from './env.js';
import { fail } from './http.js';
import { canSeeThread, type Thread } from './threads.js';
import type { User } from './auth.js';

/* Four megabytes.

   NOT A POLICY DECISION. Vercel caps a function's request body at about 4.5 MB,
   so a larger file cannot arrive here however generous we are - it is rejected by
   the platform with a response this code never gets to shape. Refusing it
   ourselves, just under the line, at least produces a sentence somebody can read.

   The PHP allowed 8 MB because a PHP process receives the whole body from disk. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/* What we will accept, by SNIFFED type. Keyed to the extension we will give it,
   because the two decisions are the same decision. */
const ALLOWED: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'text/csv': 'csv'
};

export function allowedTypeList(): string {
    return 'Images, PDFs, Word and Excel documents, CSV and plain text';
}


/* =============================================================================
   READING THE REQUEST BODY AS BYTES

   The browser posts the file as the raw request body with the name and type in
   the query string - see the note in js/api.js. That is a change from the PHP,
   which took multipart/form-data.

   WHY IT CHANGED. Multipart has to be parsed, and a function does not get a
   parser for it: @vercel/node handles JSON and form-urlencoded and hands anything
   else over as-is. Adding a multipart parser to decode a single field, when the
   request only ever carries one file, is a dependency and a class of bug in
   exchange for nothing. A raw body is unambiguous, and the XHR upload-progress
   events the paperclip UI relies on work exactly the same way.
   ============================================================================= */

export async function readBodyBytes(req: VercelRequest): Promise<Buffer> {
    const body: unknown = req.body;

    /* The platform may have buffered it for us already. */
    if (Buffer.isBuffer(body)) { return body; }

    if (body instanceof Uint8Array) { return Buffer.from(body); }

    /* A STRING BODY. This happens when something decoded the bytes as text before
       we saw them, and whether that is recoverable depends entirely on what the
       file was.

       FOR A TEXT FILE IT IS LOSSLESS. A .txt or .csv that arrived as a string was
       decoded as UTF-8, and encoding it back produces the same bytes. Refusing it
       would mean a customer cannot upload a CSV bank statement - which is one of
       the main things this feature is for.

       FOR ANYTHING ELSE IT IS NOT. A JPEG decoded as text has already had every
       invalid byte sequence replaced with U+FFFD; the original is gone, and storing
       it would produce a file that fails to open days later with no explanation. So
       that case is still refused, loudly.

       The declared type is only a claim, and it is used here ONLY to choose between
       failing and re-encoding. The bytes are still sniffed afterwards by
       sniffMime(), so claiming text/plain for a JPEG does not get it past the
       allow-list - it just gets it re-encoded first and then rejected on its
       signature. */
    if (typeof body === 'string') {
        const declared = String(req.headers['content-type'] ?? '').toLowerCase();

        if (declared.startsWith('text/')) {
            return Buffer.from(body, 'utf8');
        }

        fail(400,
            'That file arrived as text rather than as bytes, so it would have been ' +
            'corrupted. Please try again.');
    }

    /* An OBJECT means the platform parsed it as JSON or as form fields. Neither is
       a file, and neither can be turned back into the bytes that were sent. */
    if (body !== null && body !== undefined && typeof body === 'object') {
        fail(400,
            'That upload was read as form data rather than as a file. Please try ' +
            'again.');
    }

    /* Nothing buffered - read the stream ourselves, stopping if it turns out to be
       larger than we accept rather than holding it all first. */
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;

        if (total > MAX_UPLOAD_BYTES) {
            fail(400, `That file is larger than the ${MAX_UPLOAD_BYTES / 1048576} MB limit.`);
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks);
}


/* =============================================================================
   WHAT IS IT REALLY?

   finfo is a C library reading a database of thousands of signatures. This is
   twelve of them, which is the twelve we accept - anything not recognised is
   refused, so the list being short makes it stricter rather than looser.

   THE CLAIMED TYPE IS ONLY USED TO BREAK A TIE, never to decide. An Office file
   and a .docx are both Zip archives, and their real type is a manifest inside the
   archive; unzipping to find out is not worth it, so a Zip signature plus a
   claimed Office type is accepted as that Office type. Everything else is decided
   by the bytes alone.
   ============================================================================= */

export function sniffMime(bytes: Buffer, claimed: string): string | null {
    const startsWith = (...signature: number[]): boolean =>
        signature.every((byte, index) => bytes[index] === byte);

    if (startsWith(0xff, 0xd8, 0xff)) { return 'image/jpeg'; }
    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) { return 'image/png'; }
    if (startsWith(0x47, 0x49, 0x46, 0x38)) { return 'image/gif'; }

    /* WEBP is 'RIFF' .... 'WEBP' - the four bytes at offset 8 are what
       distinguishes it from a WAV, which is also a RIFF container. */
    if (startsWith(0x52, 0x49, 0x46, 0x46)
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }

    if (startsWith(0x25, 0x50, 0x44, 0x46)) { return 'application/pdf'; }

    /* Zip. Could be .docx or .xlsx, both of which are Zip archives. */
    if (startsWith(0x50, 0x4b, 0x03, 0x04)
        || startsWith(0x50, 0x4b, 0x05, 0x06)
        || startsWith(0x50, 0x4b, 0x07, 0x08)) {

        const office = [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ];
        return office.includes(claimed) ? claimed : null;
    }

    /* The old binary Office format, and .msi and a few others, share this. */
    if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
        const legacy = ['application/msword', 'application/vnd.ms-excel'];
        return legacy.includes(claimed) ? claimed : null;
    }

    /* Text has no signature, so it is defined by exclusion: valid UTF-8 with no
       control characters other than tab, newline and carriage return. A binary
       file almost always fails this within the first few hundred bytes.

       Checked LAST, so a real signature always wins. */
    if (looksLikeText(bytes)) {
        return claimed === 'text/csv' ? 'text/csv' : 'text/plain';
    }

    return null;
}

function looksLikeText(bytes: Buffer): boolean {
    const sample = bytes.subarray(0, 4096);

    for (const byte of sample) {
        if (byte === 0x09 || byte === 0x0a || byte === 0x0d) { continue; }
        if (byte < 0x20) { return false; }
    }

    /* Round-tripping through UTF-8 catches invalid sequences: the decoder replaces
       them with U+FFFD, so re-encoding produces different bytes. */
    const decoded = sample.toString('utf8');
    return Buffer.from(decoded, 'utf8').equals(sample) || !decoded.includes('\uFFFD');
}


/* =============================================================================
   ACCEPTING ONE FILE

   Returns the new attachment id. Throws (via fail) with a message the user reads
   for anything it will not take.
   ============================================================================= */

export interface StoredFile {
    attachmentId: number;
    name: string;
    size: number;
    type: string;
    isImage: boolean;
    url: string;
}

export async function storeUpload(
    accountId: number,
    bytes: Buffer,
    claimedName: string,
    claimedType: string
): Promise<StoredFile> {
    if (bytes.length === 0) {
        fail(400, 'That file is empty.');
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
        fail(400,
            `That file is ${(bytes.length / 1048576).toFixed(1)} MB. ` +
            `The limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`);
    }

    const mime = sniffMime(bytes, claimedType);

    if (mime === null || !(mime in ALLOWED)) {
        fail(400, `That kind of file is not accepted. ${allowedTypeList()} are.`);
    }

    const extension = ALLOWED[mime] as string;
    const isImage = mime.startsWith('image/');

    /* The displayed name is cleaned but kept recognisable. It is only ever shown
       as escaped text and never used as a path. */
    let name = claimedName.replace(/[\r\n\t\x00/\\]/g, '').trim();
    if (name === '') { name = `file.${extension}`; }
    name = name.slice(0, 200);

    /* Random name, our extension. Nothing from the upload appears in it. */
    const storedName =
        `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-` +
        `${randomBytes(12).toString('hex')}.${extension}`;

    /* THE ROW FIRST, THE BYTES SECOND, and in that order deliberately.

       The bytes need somewhere to be recorded before they mean anything, and an
       attachment row with no bytes is a broken chip in a conversation - visible,
       obvious, and easy to clear up. Bytes with no row would be storage nobody can
       find or delete. Of the two ways to fail halfway, this is the recoverable one. */
    const created = await one<{ id: number }>(
        `INSERT INTO attachments
             (message_id, uploaded_by, original_name, stored_path, mime, size_bytes, is_image)
         VALUES (NULL, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [accountId, name, has.blob() ? 'pending' : 'db', mime, bytes.length, isImage]
    );

    if (!created) {
        fail(500, 'That file could not be recorded. Please try again.');
    }

    const attachmentId = Number(created.id);

    try {
        if (has.blob()) {
            const uploaded = await put(`attachments/${storedName}`, bytes, {
                access: 'public',
                token: env.blobToken,
                contentType: mime,

                /* Vercel adds random characters to the pathname. Belt and braces
                   over our already-random name, and it means two uploads of the
                   same file never collide. */
                addRandomSuffix: true
            });

            await q('UPDATE attachments SET stored_path = ? WHERE id = ?',
                [uploaded.url, attachmentId]);

        } else {
            /* base64 in, decode in Postgres.

               Handing a Buffer to the driver as a bytea parameter would rely on how
               it serialises binary over its HTTP protocol, which is not something to
               guess at with somebody's document. base64 is text, text is unambiguous,
               and decode() does the conversion where the type is known. */
            await q(
                'INSERT INTO attachment_bytes (attachment_id, bytes) VALUES (?, decode(?, \'base64\'))',
                [attachmentId, bytes.toString('base64')]
            );
        }

    } catch (error) {
        /* Take the row back out, so a failed upload leaves no broken chip. */
        await q('DELETE FROM attachments WHERE id = ?', [attachmentId]).catch(() => { });

        console.error('Storing an attachment failed:', error);
        fail(500, 'That file could not be stored. Please try again.');
    }

    return {
        attachmentId,
        name,
        size: bytes.length,
        type: mime,
        isImage,
        url: `/api/file?id=${attachmentId}`
    };
}


/* =============================================================================
   GIVING ONE BACK
   ============================================================================= */

export interface AttachmentRow extends Row {
    id: number;
    message_id: number | null;
    uploaded_by: number | null;
    original_name: string;
    stored_path: string;
    mime: string;
    size_bytes: number;
    is_image: boolean;
    thread_id: number | null;
}

export async function attachmentById(id: number): Promise<AttachmentRow | null> {
    return one<AttachmentRow>(
        `SELECT a.*, m.thread_id
           FROM attachments a
           LEFT JOIN messages m ON m.id = a.message_id
          WHERE a.id = ?`,
        [id]
    );
}

/* Four cases are allowed:
     - the attachment is on a message in a conversation the reader is part of
     - it is on a message in the reader's own PRUWise conversation
     - the reader uploaded it and has not sent it yet (the preview chip)
     - it holds the bytes of a DOCUMENT the reader is allowed to see

   Anything else is a 404 rather than a 403, because "you may not see file 42"
   still confirms file 42 exists. */
export async function mayReadAttachment(
    user: User,
    attachment: AttachmentRow
): Promise<boolean> {
    /* The document case is checked FIRST and independently of the message case.

       A document uploaded through the documents page has no message, so without
       this it would fall into the "did you upload it" branch below and a
       representative could never open a document their own customer sent them -
       which is the entire point of the feature. */
    if (await backsAReadableDocument(user, Number(attachment.id))) {
        return true;
    }

    if (attachment.message_id === null) {
        return Number(attachment.uploaded_by) === user.id;
    }

    const thread = await one<Thread>('SELECT * FROM threads WHERE id = ?',
        [Number(attachment.thread_id)]);

    return canSeeThread(user, thread);
}

/* Does this attachment hold the bytes of a document this reader may see?

   Written as SQL here rather than by importing from _lib/documents.ts, which
   imports storeUpload from this file - that would be a cycle. The rule itself is
   stated once, in documents.ts; this is the same rule expressed where the byte
   check needs it, and the smoke test covers both paths so they cannot drift
   silently.

   An administrator is deliberately absent. They manage accounts, not the contents
   of somebody's payslip. */
async function backsAReadableDocument(user: User, attachmentId: number): Promise<boolean> {
    if (user.role === 'admin') { return false; }

    const readable = await column<number>(
        `SELECT 1
           FROM documents d
           JOIN people  p ON p.id = d.person_id
          WHERE d.attachment_id = ?
            AND (d.person_id = ? OR (p.rep_id = ? AND ? = 'fr'))
          LIMIT 1`,
        [attachmentId, user.person_id, user.person_id, user.role]
    );

    return readable !== null;
}

/* The bytes. Reads from whichever store the row points at. */
export async function readAttachmentBytes(attachment: AttachmentRow): Promise<Buffer | null> {
    if (attachment.stored_path === 'db') {
        const encoded = await column<string>(
            `SELECT encode(bytes, 'base64') FROM attachment_bytes WHERE attachment_id = ?`,
            [Number(attachment.id)]
        );

        return encoded === null ? null : Buffer.from(encoded, 'base64');
    }

    if (!attachment.stored_path.startsWith('https://')) {
        /* 'pending' - the row was written but the upload never finished. */
        return null;
    }

    /* Fetched server-side and streamed on, so the Blob URL never reaches the
       browser. See the privacy note at the top of this file. */
    const response = await fetch(attachment.stored_path);

    if (!response.ok) { return null; }

    return Buffer.from(await response.arrayBuffer());
}


/* =============================================================================
   SWEEPING UP

   A file picked and then never sent would otherwise sit in storage forever. Run
   on upload rather than on a schedule, because the free plan's cron runs once a
   day and this keeps itself tidy without one.

   Two hours, so a slow conversation cannot lose an attachment the sender is still
   composing a message around.
   ============================================================================= */

export async function sweepOrphans(accountId: number): Promise<void> {
    try {
        /* NOT EXISTS (SELECT ... FROM documents) IS LOAD-BEARING.

           A document keeps its bytes in an attachments row that deliberately has no
           message - see the note above documents.attachment_id in db/schema.sql.
           Without this clause every document somebody uploaded more than two hours
           ago would have its file deleted out from under it by the next person to
           use the paperclip, leaving a row that lists a document and cannot open it.

           Silent, delayed, and triggered by an unrelated action, which is close to
           the worst shape a data-loss bug can have. */
        const orphans = await all<{ id: number; stored_path: string }>(
            `SELECT a.id, a.stored_path
               FROM attachments a
              WHERE a.message_id IS NULL
                AND a.uploaded_by = ?
                AND a.created_at < now() - INTERVAL '2 hours'
                AND NOT EXISTS (
                    SELECT 1 FROM documents d WHERE d.attachment_id = a.id
                )`,
            [accountId]
        );

        for (const orphan of orphans) {
            if (orphan.stored_path.startsWith('https://') && has.blob()) {
                await del(orphan.stored_path, { token: env.blobToken }).catch(() => { });
            }

            /* attachment_bytes cascades from this. */
            await q('DELETE FROM attachments WHERE id = ?', [Number(orphan.id)]);
        }

    } catch (error) {
        /* Housekeeping must never fail the upload somebody is waiting on. */
        console.error('Sweeping abandoned attachments failed:', error);
    }
}
