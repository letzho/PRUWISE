/* =============================================================================
   POST /api/upload?name=<filename>&type=<mime>
       body: the file's raw bytes
   ->  { attachmentId, name, size, type, isImage, url }
   -----------------------------------------------------------------------------
   Ported from php/api/upload.php.

   The paperclip. The file goes up as soon as it is picked, and the id comes back so
   /api/send-message can attach it when the message is finally sent. That way a slow
   upload never blocks somebody from finishing what they were typing.

   =============================================================================
   RAW BODY, NOT MULTIPART
   =============================================================================

   The PHP took multipart/form-data because that is what a <form> sends and PHP
   parses it for free. A function does not get that for free - @vercel/node handles
   JSON and form-urlencoded and passes anything else through untouched - so the
   browser now sends the bytes as the body with the name and type in the query
   string. js/api.js does that, and the XHR progress events the UI draws its bar
   from work identically.

   THE NAME AND TYPE IN THE QUERY STRING ARE CLAIMS, NOT FACTS. Both are treated as
   such: the type is checked against what the leading bytes actually say, and the
   name never touches a path. See _lib/files.ts, which is where all of that lives.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    MAX_UPLOAD_BYTES, allowedTypeList, readBodyBytes, storeUpload, sweepOrphans
} from '../_lib/files.js';
import { extractText } from '../_lib/extract.js';
import {
    classifyKind, describe, documentById, documentView
} from '../_lib/documents.js';
import { one, q } from '../_lib/db.js';
import { requireThread } from '../_lib/threads.js';

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, 'Administrators do not send attachments.');
    }

    const name = req.query('name');
    const claimedType = req.query('type');

    if (name === '') {
        fail(400, 'The upload did not say what the file is called.');
    }

    const bytes = await readBodyBytes(req.raw);

    if (bytes.length === 0) {
        fail(400,
            'No file was received. If the file is larger than ' +
            `${MAX_UPLOAD_BYTES / 1048576} MB it may have been rejected before it ` +
            'reached us.');
    }

    const stored = await storeUpload(user.id, bytes, name, claimedType);

    await audit(user.id, 'file_uploaded',
        `attachment=${stored.attachmentId} type=${stored.type} bytes=${stored.size}`,
        req.ip);

    /* =========================================================================
       READING WHAT WAS JUST ATTACHED
       =========================================================================

       ?thread=<id> means this file is going into a conversation, and the assistant
       should read it rather than treat it as an opaque blob. That was the whole
       point of asking: a customer attaches a payslip and their representative gets
       a reply suggestion that refers to what the payslip said.

       IT REUSES THE SAME BYTES. storeUpload has already put them away, so this adds
       a documents row pointing at that attachment and no second copy - see the note
       above documents.attachment_id in db/schema.sql.

       WHY THE FAILURES HERE ARE SWALLOWED. Somebody is watching an upload progress
       bar. Reading the file is a bonus on top of attaching it, so a parser that
       chokes, an exhausted AI allowance or a thread id that turns out not to be
       theirs must all leave a perfectly good attachment behind rather than failing
       the upload. The chip appears either way; only the "PRUWise read this" note is
       missing. */
    let document = null;

    const threadId = Math.trunc(Number(req.query('thread'))) || 0;

    if (threadId > 0) {
        try {
            /* 404s anything the caller is not a member of, so a guessed thread id
               cannot attach a document to somebody else's conversation. */
            const thread = await requireThread(user, threadId);

            const extraction = extractText(bytes, stored.type);

            /* An image has nothing to read. Recording a failed document for every
               photo somebody sends would fill the shelf with noise, so images are
               simply not made into documents here. The documents page is where
               somebody deliberately files one. */
            if (extraction.text !== null) {
                /* The document belongs to the CUSTOMER in the conversation, whoever
                   uploaded it. A policy schedule a representative forwards is still a
                   fact about the customer's cover and belongs on their shelf. */
                const personId = thread.customer_person_id;

                const kind = classifyKind(stored.name, extraction.text);

                const created = await one<{ id: number }>(
                    `INSERT INTO documents
                         (person_id, uploaded_by, attachment_id, thread_id,
                          original_name, stored_url, mime, size_bytes, kind, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                     RETURNING id`,
                    [personId, user.id, stored.attachmentId, threadId, stored.name,
                        `/api/file?id=${stored.attachmentId}`, stored.type,
                        stored.size, kind]
                );

                if (created) {
                    const id = Number(created.id);

                    const described = await describe(user.id, stored.name, kind,
                        extraction.text);

                    await q(
                        `UPDATE documents
                            SET status = 'ready', extracted_text = ?, ai_summary = ?,
                                ai_notes = ?
                          WHERE id = ?`,
                        [extraction.text, described.summary,
                            JSON.stringify(described.notes), id]
                    );

                    const row = await documentById(id);

                    if (row) { document = documentView(row, user); }
                }
            }

        } catch (error) {
            console.error('Reading an attached file failed; the attachment is fine:',
                error);
        }
    }

    /* Housekeeping, at the one moment somebody is already waiting for a write.
       Awaited rather than floated, because an unhandled rejection from a floating
       promise can take a function instance down - and it is a handful of rows.

       Runs AFTER the document row exists, or the sweeper's NOT EXISTS check would
       not yet see it. In practice the two-hour cutoff makes that impossible; the
       ordering is here so it stays impossible if the cutoff ever changes. */
    await sweepOrphans(user.id);

    return ok({
        ...stored,
        accepts: allowedTypeList(),
        maxBytes: MAX_UPLOAD_BYTES,

        /* Null unless the file went into a conversation and had readable text. The
           chat shows a short "PRUWise read this" note when it is present, and the
           figures inside it came from a regex over the document rather than from the
           model - see findFigures in _lib/documents.ts. */
        document
    });
});
