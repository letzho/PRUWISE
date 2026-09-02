/* =============================================================================
   GET    /api/document?id=42            ->  { document, text }
   POST   /api/document?id=42&act=reread ->  { document }   read it again
   POST   /api/document?id=42&act=kind&kind=policy -> { document }
   DELETE /api/document?id=42            ->  { deleted: true }
   -----------------------------------------------------------------------------
   New. One document: the full record including the extracted text, which
   /api/documents deliberately leaves out of its list.

   =============================================================================
   WHY re-read EXISTS
   =============================================================================

   Because the first read can fail for reasons that later stop being true. The
   hourly AI allowance can be spent at the moment somebody uploads, OpenAI can be
   having a bad afternoon, or a key can be configured for the first time a week
   after a document was added. In all three cases the bytes and the extracted text
   are already stored, so a second attempt costs one model call and no upload.

   It re-runs the DESCRIPTION, not the extraction: if the text could not be got out
   of the file the first time it will not come out the second time, because nothing
   about the parser changed. A document whose status is 'failed' therefore cannot be
   re-read, and says so.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { q } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import {
    DOCUMENT_KINDS, type DocumentKind, deleteDocument, describe, documentById,
    documentView, mayDeleteDocument, mayReadDocument
} from '../_lib/documents.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    /* param(), not query(): this endpoint answers GET, POST and DELETE, and jQuery
       puts the data in the query string for the first and in the body for the other
       two. See the note on param() in _lib/http.ts. */
    const id = Number(req.param('id'));

    if (!Number.isInteger(id) || id <= 0) {
        fail(400, 'That is not a document reference.');
    }

    const document = await documentById(id);

    /* 404, not 403, and the same 404 for "does not exist" and "not yours". A
       different answer for each would turn this into a way to count how many
       documents the site holds. */
    if (document === null || !await mayReadDocument(user, document)) {
        fail(404, 'That document could not be found.');
    }

    const method = req.raw.method ?? 'GET';

    /* ------------------------------------------------------------------- reading */
    if (method === 'GET') {
        return ok({
            document: documentView(document, user),

            /* The extracted text, capped. This is the one endpoint that returns it,
               and only for a single document somebody deliberately opened.

               It is what the model read, so showing it is the only way anybody can
               check whether a summary is a fair description or a misreading of a
               mangled PDF. A summary nobody can audit is worse than no summary. */
            text: document.extracted_text === null
                ? null
                : document.extracted_text.slice(0, 20_000)
        });
    }

    /* ------------------------------------------------------------------ deleting */
    if (method === 'DELETE') {
        if (!mayDeleteDocument(user, document)) {
            fail(403,
                'Only the person this document belongs to can remove it. You can still ' +
                'read it.');
        }

        await deleteDocument(id);

        await audit(user.id, 'document_deleted',
            `document=${id} person=${document.person_id}`, req.ip);

        return ok({ deleted: true });
    }

    if (method !== 'POST') {
        fail(405, 'Use GET to read a document, POST to change it, or DELETE to remove it.');
    }

    /* ------------------------------------------------------- changing what it is */
    const act = req.param('act');

    if (act === 'kind') {
        const kind = req.param('kind');

        if (!(DOCUMENT_KINDS as readonly string[]).includes(kind)) {
            fail(400, `A document can be ${DOCUMENT_KINDS.join(', ')}.`);
        }

        /* Either side may correct the type. classifyKind is keyword rules and will
           sometimes call a benefits summary a statement; the person looking at the
           document knows better than the keywords do. */
        await q('UPDATE documents SET kind = ? WHERE id = ?', [kind, id]);

        const updated = await documentById(id);

        return ok({ document: documentView(updated ?? document, user) });
    }

    /* -------------------------------------------------------------- reading again */
    if (act === 'reread') {
        if (document.extracted_text === null) {
            fail(400,
                document.error ??
                'There is no readable text in this document, so there is nothing to ' +
                'describe. Uploading a PDF saved from the original, rather than a scan, ' +
                'would work.');
        }

        const described = await describe(user.id, document.original_name,
            document.kind as DocumentKind, document.extracted_text);

        await q(
            `UPDATE documents
                SET ai_summary = ?, ai_notes = ?, status = 'ready', error = NULL
              WHERE id = ?`,
            [described.summary, JSON.stringify(described.notes), id]
        );

        const updated = await documentById(id);

        await audit(user.id, 'document_reread',
            `document=${id} source=${described.notes.source}`, req.ip);

        return ok({ document: documentView(updated ?? document, user) });
    }

    fail(400, 'That is not something that can be done to a document.');
});
