/* =============================================================================
   GET /api/file?id=42  ->  the file itself, if you are allowed to see it
   -----------------------------------------------------------------------------
   Ported from php/api/file.php.

   THE ONLY WAY AN ATTACHMENT IS EVER READ.

   =============================================================================
   WHY THIS ENDPOINT EXISTS AT ALL
   =============================================================================

   A URL somebody could read directly - /uploads/20260820-a1b2c3.pdf under the old
   arrangement, or a Vercel Blob URL under this one - is readable by anybody who
   guessed it or was sent it. That is fine for a public image and completely wrong
   for a customer's medical document. So the storage location is never published:
   you ask for an id, and the server decides.

   Three cases are allowed - see mayReadAttachment() in _lib/files.ts. Anything else
   is a 404, not a 403, because "you may not see file 42" still confirms file 42
   exists.

   =============================================================================
   NO JSON HERE, ON PURPOSE
   =============================================================================

   This endpoint returns bytes. A browser <img> tag can do nothing with a JSON
   error, so failures are plain text and a status code, which is the honest answer
   to a failed image request. That is also why it does not use fail() - that would
   produce the JSON envelope every other endpoint returns.
   ============================================================================= */

import { audit, currentUser } from '../_lib/auth.js';
import { defineHandler, type ApiResponse } from '../_lib/http.js';
import {
    attachmentById, mayReadAttachment, readAttachmentBytes
} from '../_lib/files.js';

function plain(status: number, message: string): ApiResponse {
    return {
        kind: 'text',
        status,
        contentType: 'text/plain; charset=utf-8',
        body: message,
        headers: { 'Cache-Control': 'no-store' }
    };
}

export default defineHandler(async (req, res) => {
    const user = await currentUser(req);

    if (!user) { return plain(401, 'Please sign in.'); }

    const id = Number(req.query('id', '0'));

    if (!Number.isInteger(id) || id <= 0) {
        return plain(404, 'Not found.');
    }

    const attachment = await attachmentById(id);

    if (!attachment) { return plain(404, 'Not found.'); }

    if (!await mayReadAttachment(user, attachment)) {
        await audit(user.id, 'file_access_denied', `attachment ${id}`, req.ip);
        return plain(404, 'Not found.');
    }

    const bytes = await readAttachmentBytes(attachment);

    if (bytes === null) {
        return plain(404, 'That file is no longer available.');
    }

    /* ---------------------------------------------------------------- send it */

    res.setHeader('Content-Type', attachment.mime);
    res.setHeader('Content-Length', String(bytes.length));

    /* inline for images so they preview in the chat, attachment for everything else
       so a document downloads rather than trying to render in a tab.

       The filename is stripped of quotes, backslashes and newlines: a filename
       containing a quote could otherwise close the one below and add its own
       header. The name was cleaned on upload too - this is the second place,
       because header injection is not something to rely on one check for. */
    const safeName = attachment.original_name.replace(/["\\\r\n]/g, '');

    res.setHeader('Content-Disposition',
        `${attachment.is_image ? 'inline' : 'attachment'}; filename="${safeName}"`);

    /* nosniff MATTERS MOST HERE. Without it a browser may decide a .txt is really
       HTML, render it, and run any script inside - turning an upload into a way to
       execute code in somebody else's session. vercel.json sets this globally; it
       is repeated because this is the one route where losing it would be serious. */
    res.setHeader('X-Content-Type-Options', 'nosniff');

    /* private, so no shared cache ever holds a copy of somebody's document. */
    res.setHeader('Cache-Control', 'private, max-age=3600');

    res.status(200).end(bytes);

    /* Already written, so the wrapper's send() sees headersSent and leaves it
       alone. Returned only because a handler must return something. */
    return { kind: 'empty', status: 200 };
});
