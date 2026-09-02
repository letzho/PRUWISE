/* =============================================================================
   GET  /api/documents[?person=cus-001]
        ->  { documents: [...], accepts, maxBytes, kinds, aiEnabled }

   POST /api/documents?name=<filename>&type=<mime>[&kind=policy][&person=cus-001]
        body: the file's raw bytes
        ->  { document: {...} }
   -----------------------------------------------------------------------------
   New. The documents page - files uploaded so the assistant can read them, kept
   separately from chat attachments because a document belongs to a person and stays
   re-readable, while an attachment belongs to one message.

   RAW BODY, NOT MULTIPART, for the same reason as /api/upload - see the note at the
   top of that file.

   =============================================================================
   WHOSE DOCUMENTS
   =============================================================================

   ?person is how a representative reads a customer's shelf. It is CHECKED, not
   trusted: _lib/documents.ts mayReadDocument allows the person themselves and the
   representative that person is assigned to, and nobody else. Left off, it means
   "mine", which is what a customer always wants.

   An administrator gets 403 rather than an empty list. They manage accounts; the
   contents of somebody's payslip is not account administration, and an empty list
   would imply the documents are not there rather than not theirs to read.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { column } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { MAX_UPLOAD_BYTES, allowedTypeList, readBodyBytes } from '../_lib/files.js';
import { aiReady } from '../_lib/openai.js';
import {
    DOCUMENT_KINDS, createDocument, documentView, listDocuments
} from '../_lib/documents.js';

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403,
            'Administrators do not have access to customers\' documents. This screen ' +
            'is for a customer and the representative advising them.');
    }

    const method = req.raw.method ?? 'GET';

    if (method !== 'GET' && method !== 'POST') {
        fail(405, 'Use GET to list documents or POST to add one.');
    }

    /* Whose shelf. Resolved once and used by both branches, so a list and an upload
       cannot disagree about who the document belongs to. */
    const asked = req.query('person');
    const personId = asked === '' ? user.person_id : asked;

    if (personId !== user.person_id) {
        /* Only a representative may look at somebody else's, and only at their own
           customers'. 404 rather than 403 for an unassigned customer, so this cannot
           be used to check whether a person id exists. */
        const isMyCustomer = user.role === 'fr' && await column<number>(
            'SELECT 1 FROM people WHERE id = ? AND rep_id = ?',
            [personId, user.person_id]
        ) !== null;

        if (!isMyCustomer) {
            fail(404, 'There are no documents to show for that person.');
        }
    }

    /* ------------------------------------------------------------------- listing */
    if (method === 'GET') {
        const documents = await listDocuments(personId);

        return ok({
            personId,
            documents: documents.map((document) => documentView(document, user)),
            accepts: allowedTypeList(),
            maxBytes: MAX_UPLOAD_BYTES,
            kinds: DOCUMENT_KINDS,

            /* So the page can say whether the descriptions are written by the model or
               by the built-in rules, rather than implying the cleverer one. */
            aiEnabled: aiReady()
        });
    }

    /* ------------------------------------------------------------------ receiving */
    const name = req.query('name');

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

    /* A representative uploading on a customer's behalf is a real case - they have
       been sent a policy schedule by email and want it on the record. The document
       belongs to the CUSTOMER; uploaded_by records who put it there. */
    const document = await createDocument({
        personId,
        accountId: user.id,
        bytes,
        name,
        claimedType: req.query('type'),
        kind: req.query('kind') || undefined
    });

    await audit(user.id, 'document_uploaded',
        `document=${document.id} person=${personId} kind=${document.kind} ` +
        `status=${document.status}`,
        req.ip);

    return ok({ document: documentView(document, user) });
});
