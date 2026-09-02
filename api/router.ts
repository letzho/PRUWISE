/* =============================================================================
   api/router.ts - the single function every API request goes through
   -----------------------------------------------------------------------------
   /api/login          ->  api/_routes/login.ts
   /api/admin/users    ->  api/_routes/admin/users.ts
   /api/anything-else  ->  404, from here, as JSON

   Reached through a rewrite in vercel.json:

       { "source": "/api/:slug*", "destination": "/api/router?slug=:slug*" }

   =============================================================================
   WHY A REWRITE AND NOT api/[...route].ts
   =============================================================================

   The obvious spelling of "one function catches every /api path" is a catch-all
   filename, and it was tried first. Vercel's build did not pick the file up at
   all: it completed in five seconds having compiled nothing, the deployment went
   out with ZERO functions, and every API call fell through to the catch-all
   rewrite and came back as the index.html page - which reads as 405 on a POST and
   as unparseable JSON on a GET.

   The failure is silent in both directions, so this uses a plain filename and an
   explicit rewrite instead. Nothing about it depends on how a bracketed filename
   is globbed or detected, and the routing is written down in vercel.json where
   somebody looking for it will find it.

   =============================================================================
   WHY THERE IS A ROUTER AT ALL, WHEN VERCEL ALREADY HAS FILE ROUTING
   =============================================================================

   Every .ts file directly under api/ becomes its own deployed function. That is
   the nicer arrangement and it is what this project had, right up to the moment
   there were thirteen of them.

   THE HOBBY PLAN ALLOWS TWELVE FUNCTIONS PER DEPLOYMENT. Going past it does not
   produce a build error - the build succeeds, every function is compiled, and then
   the deployment fails at "Deploying outputs" with no message at all. The previous
   deployment stays live, so the site keeps working and the new endpoints simply
   are not there. Every request to one gets 405, because the catch-all rewrite
   sends it to index.html and you cannot POST to a static file.

   That is a genuinely nasty failure to diagnose, so: this project has ONE function.
   Adding an endpoint now means adding a file and a line to ROUTES below, and the
   function count never changes. Thirty-eight endpoints fit as comfortably as five.

   =============================================================================
   WHY IT IS ALSO THE BETTER SHAPE HERE, LIMIT OR NO LIMIT
   =============================================================================

   This app polls. js/app.js checks for an incoming call every few seconds,
   js/messages.js every two, js/call.js every one while a call is up. Spread across
   a dozen separate functions, each of those pollers pays its own cold start and
   keeps its own instance warm. Through one function they all keep the SAME instance
   warm, which means the database client in _lib/db.ts is reused rather than rebuilt
   and the ring poll is what keeps the message poll fast.

   =============================================================================
   THE MAP HOLDS IMPORT FUNCTIONS, NOT MODULES
   =============================================================================

   Two reasons, and they are both deliberate.

   NO USER INPUT REACHES AN IMPORT PATH. Every path below is a literal written by
   hand. `import(`./_routes/${req.url}.js`)` would be far shorter and would let
   somebody load anything on the disk they could describe with ../ - the classic
   traversal, and the reason this is a lookup in a fixed table instead.

   AND ONLY THE ROUTE BEING CALLED IS EVALUATED. Static imports would run all
   nineteen modules on every cold start, pulling in bcryptjs, resend, openai and the
   whole assessment engine to answer a session check. The bundler still traces them
   all into the deployment - it has to - but at runtime one request loads one route.
   ============================================================================= */

import type { VercelRequest, VercelResponse } from '@vercel/node';

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void> | void;
type Route = () => Promise<{ default: Handler }>;

const ROUTES: Record<string, Route> = {
    /* --- who is asking --- */
    'session': () => import('./_routes/session.js'),
    'login': () => import('./_routes/login.js'),
    'logout': () => import('./_routes/logout.js'),
    'register': () => import('./_routes/register.js'),
    'google-login': () => import('./_routes/google-login.js'),

    /* --- the account itself --- */
    'forgot-password': () => import('./_routes/forgot-password.js'),
    'reset-password': () => import('./_routes/reset-password.js'),
    'change-password': () => import('./_routes/change-password.js'),
    'confirm-email': () => import('./_routes/confirm-email.js'),
    'resend-confirmation': () => import('./_routes/resend-confirmation.js'),
    'update-profile': () => import('./_routes/update-profile.js'),
    'delete-account': () => import('./_routes/delete-account.js'),

    /* --- the advisory relationship --- */
    'assessment': () => import('./_routes/assessment.js'),
    'representatives': () => import('./_routes/representatives.js'),
    'consultation': () => import('./_routes/consultation.js'),
    'finances': () => import('./_routes/finances.js'),
    'policies': () => import('./_routes/policies.js'),

    /* Which recommendations a customer is allowed to see. A representative
       releases them; nothing reaches a customer unreviewed. */
    'recommendations': () => import('./_routes/recommendations.js'),

    /* What the assistant noticed in a conversation - detail changes, support
       signals, follow-ups, a meeting somebody wants. PROPOSALS ONLY: nothing is
       written to a client's record until a representative confirms it. See the
       header of _routes/insights.ts. */
    'insights': () => import('./_routes/insights.js'),

    /* The bell. Fed by whatever noticed the thing, at the moment it noticed - see
       _lib/notify.ts. Before this the bell counted a hard-coded activity feed and
       therefore could not report anything the assistant had just read out of a
       conversation. */
    'notifications': () => import('./_routes/notifications.js'),

    /* --- conversations and files --- */
    'threads': () => import('./_routes/threads.js'),
    'thread': () => import('./_routes/thread.js'),
    'send-message': () => import('./_routes/send-message.js'),

    /* Editing or deleting something you already said. Your OWN message only, and
       deleting leaves a tombstone rather than removing the row - see the header of
       _routes/message.ts for why rewriting the other person's history quietly is
       not an option. */
    'message': () => import('./_routes/message.js'),
    'store-ai-message': () => import('./_routes/store-ai-message.js'),
    'upload': () => import('./_routes/upload.js'),
    'file': () => import('./_routes/file.js'),

    /* --- documents the assistant has read. See _lib/documents.ts. --- */
    'documents': () => import('./_routes/documents.js'),
    'document': () => import('./_routes/document.js'),

    /* --- appointments and the calendar feed --- */
    'appointments': () => import('./_routes/appointments.js'),
    'appointment': () => import('./_routes/appointment.js'),
    'calendar': () => import('./_routes/calendar.js'),

    /* --- video calls --- */
    'call-join': () => import('./_routes/call-join.js'),
    'call-sync': () => import('./_routes/call-sync.js'),
    'call-ring': () => import('./_routes/call-ring.js'),
    'call-end': () => import('./_routes/call-end.js'),
    'calls': () => import('./_routes/calls.js'),
    'call-copilot': () => import('./_routes/call-copilot.js'),
    'call-summary': () => import('./_routes/call-summary.js'),

    /* --- the admin console ---

       Nested paths work because the slug segments are joined with '/' above, so
       /api/admin/users arrives here as the key 'admin/users'. */
    'admin/users': () => import('./_routes/admin/users.js'),
    'admin/user': () => import('./_routes/admin/user.js'),
    'admin/create-user': () => import('./_routes/admin/create-user.js'),
    'admin/requests': () => import('./_routes/admin/requests.js'),
    'admin/audit': () => import('./_routes/admin/audit.js'),

    /* --- the language model, behind a boundary. See _lib/openai.ts. --- */
    'ai': () => import('./_routes/ai.js'),
    'suggest-reply': () => import('./_routes/suggest-reply.js'),

    /* --- operations --- */
    'setup': () => import('./_routes/setup.js')
};


export default async function router(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    /* The rewrite puts the path in ?slug=, so Vercel has already dealt with the
       query string, the trailing slash and any percent-encoding. Reading the
       parameter rather than parsing req.url matters because after a rewrite
       req.url is the DESTINATION - it says /api/router, not the path the caller
       actually asked for.

       It can arrive as a string ('login'), as a string with slashes in it
       ('admin/users'), or as an array if the parameter somehow repeats. All three
       flatten to the same thing. */
    const raw = req.query.slug;
    const segments = Array.isArray(raw) ? raw : (raw === undefined ? [] : [raw]);

    /* '.php' IS STRIPPED HERE AS WELL AS IN js/api.js.

       The frontend still names endpoints the way the PHP did - api.js rewrites
       them on the way out - but a bookmark, a cached script or somebody's saved
       .ics feed URL can still arrive asking for /api/calendar.php. Accepting both
       costs one replace and turns a confusing 404 into a working request. */
    const path = segments.join('/').replace(/\.php$/, '');

    const route = ROUTES[path];

    if (!route) {
        /* JSON, not the HTML 404 page. Everything calling this expects JSON and
           js/api.js will try to parse whatever comes back - an HTML body produces
           "Unexpected token <" instead of a message anybody can act on. */
        res.status(404).json({
            ok: false,
            error: `There is no API endpoint at /api/${path}.`
        });
        return;
    }

    /* Any failure inside a handler is already dealt with by defineHandler in
       _lib/http.ts. This catch is for the import itself - a module that throws
       while being evaluated, which is what a missing environment variable looks
       like, because _lib/env.ts throws on a required() that is not set.

       Without this the request would hang until the platform timed it out, and the
       reason would only be visible in the function log. */
    try {
        const module = await route();
        await module.default(req, res);

    } catch (error) {
        console.error(`Failed to load or run the /api/${path} route:`, error);

        if (!res.headersSent) {
            res.status(500).json({
                ok: false,
                error: 'That endpoint could not start. Please try again shortly.'
            });
        }
    }
}
