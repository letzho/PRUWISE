/* =============================================================================
   http.ts - request reading and response shaping
   -----------------------------------------------------------------------------
   Replaces json_ok(), json_fail(), field(), body() and require_post() from
   php/lib/bootstrap.php.

   =============================================================================
   HOW fail() KEEPS THE SHAPE OF THE PHP IT REPLACES
   =============================================================================

   json_fail() in PHP ended the request. It could be called from anywhere - from
   the middle of a validation helper three calls deep - and nothing after it ran.
   The ported code depends on that everywhere:

       function policy_amount($key, $max) {
           if (!is_numeric($raw)) { json_fail(400, 'That is not a number.'); }
           return (int) $raw;              // unreachable when it failed
       }

   TypeScript has no exit. So fail() THROWS, and the wrapper below catches it.
   Same property: it can be called from any depth, and nothing after it runs. Its
   return type is `never`, so the compiler also knows the code after it is
   unreachable and stops asking for a return value.

   ok() is the opposite: it RETURNS a response for the handler to return. It is
   not thrown, because a thrown success is the kind of cleverness that makes
   stack traces lie. The one cost is that ported code needs `return ok(...)`
   where the PHP had a bare json_ok(...) - which the compiler enforces, since a
   handler that forgets it will not typecheck.
   ============================================================================= */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from './env.js';

export type Json = Record<string, unknown>;

export type ApiResponse =
    | { kind: 'json'; status: number; body: Json }
    | { kind: 'text'; status: number; contentType: string; body: string;
        headers?: Record<string, string> }
    | { kind: 'empty'; status: number; headers?: Record<string, string> };


/* =============================================================================
   FAILURE
   ============================================================================= */

export class HttpError extends Error {
    readonly status: number;
    readonly field: string | null;

    constructor(status: number, message: string, field: string | null = null) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.field = field;
    }
}

/* Stop, with a message the user will read.

   `field` names the form input the problem belongs to, so the browser can put
   the message next to the box instead of in a toast. js/api.js already reads it. */
export function fail(status: number, message: string, field: string | null = null): never {
    throw new HttpError(status, message, field);
}

export function ok(data: Json = {}): ApiResponse {
    return { kind: 'json', status: 200, body: { ok: true, ...data } };
}

export function text(
    body: string,
    contentType = 'text/plain; charset=utf-8',
    headers?: Record<string, string>
): ApiResponse {
    return { kind: 'text', status: 200, contentType, body, ...(headers ? { headers } : {}) };
}


/* =============================================================================
   READING THE REQUEST
   ============================================================================= */

export class Req {
    readonly raw: VercelRequest;
    private readonly bodyData: Json;

    constructor(raw: VercelRequest) {
        this.raw = raw;
        this.bodyData = Req.parseBody(raw);
    }

    /* Vercel parses JSON bodies for us when the content type says so, but not
       always and not for form encoding, so all three shapes are handled.

       Never throws. A malformed body becomes an empty object and the endpoint's
       own validation produces a message about the missing field, which is more
       useful than "invalid JSON" - the caller usually sent something, just not
       what was expected. */
    private static parseBody(raw: VercelRequest): Json {
        const body = raw.body;

        if (body === undefined || body === null) { return {}; }

        if (typeof body === 'string') {
            const trimmed = body.trim();
            if (trimmed === '') { return {}; }

            try {
                const parsed: unknown = JSON.parse(trimmed);
                return (typeof parsed === 'object' && parsed !== null)
                    ? parsed as Json : {};
            } catch {
                /* Form encoding, which is what a plain <form> post sends. */
                const params = new URLSearchParams(trimmed);
                const out: Json = {};
                for (const [key, value] of params) { out[key] = value; }
                return out;
            }
        }

        if (typeof body === 'object') { return body as Json; }
        return {};
    }

    get method(): string {
        return (this.raw.method ?? 'GET').toUpperCase();
    }

    /* One field from the body, coerced to match the type of the fallback.

       Same contract as PHP's field(): never trust it, validate after reading.

       WHY THE OVERLOADS. A single generic signature - field<T>(name, fallback: T) -
       infers T from the ARGUMENT, so field('terms', false) returned the literal
       type `false` rather than `boolean`, and `=== true` became a compile error
       for comparing two types that "have no overlap". field('name', '') was worse:
       it inferred the literal '', so after `name === ''` was ruled out TypeScript
       narrowed it to `never` and `.length` stopped existing.

       The overloads widen each case to its ordinary type, which is what every
       caller actually meant.

       THE COERCION IS NOT JUST COSMETIC. Declaring a boolean return and then
       handing back whatever JSON contained would be a lie the compiler cannot
       catch. A form-encoded post sends terms as the STRING "true", and the PHP
       compared it with === true and silently failed. Coercing per the fallback's
       type makes the annotation honest and fixes that case at the same time. */
    field(name: string, fallback: string): string;
    field(name: string, fallback: boolean): boolean;
    field(name: string, fallback: number): number;
    field<T>(name: string, fallback: T): T;
    field(name: string, fallback: unknown): unknown {
        const value = this.bodyData[name];

        if (value === undefined || value === null) { return fallback; }

        if (typeof fallback === 'boolean') {
            /* JSON sends true; a form sends "true"; a checkbox might send "1". */
            return value === true || value === 'true' || value === 1 || value === '1';
        }

        if (typeof fallback === 'string') {
            return typeof value === 'string' ? value.trim() : String(value);
        }

        if (typeof fallback === 'number') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        }

        /* Objects and arrays come back untouched, so a nested payload survives. */
        if (typeof value === 'string') { return value.trim(); }
        return value;
    }

    /* Was this key present at all?

       The distinction matters for partial updates. finances_save() and
       update-profile both treat "absent" as leave alone and "empty string" as
       clear it - two different instructions that must not be collapsed. */
    has(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.bodyData, name);
    }

    get body(): Json {
        return this.bodyData;
    }

    /* A query string value. Vercel hands over string | string[]; the array form
       happens when a parameter repeats, and taking the first is what PHP did. */
    query(name: string, fallback = ''): string {
        const value = this.raw.query[name];

        if (value === undefined) { return fallback; }
        if (Array.isArray(value)) { return (value[0] ?? fallback).trim(); }
        return String(value).trim();
    }

    /* A value that may arrive EITHER in the query string or in the JSON body.

       WHY THIS EXISTS, because "read it from both" normally deserves suspicion.

       jQuery decides where to put a request's data based on the verb, and the rule
       is not the obvious one: GET and HEAD get a query string, and EVERY other
       method - POST, PUT, DELETE - gets a body. So one endpoint that answers GET,
       POST and DELETE, which /api/document does, receives the SAME id in two
       different places depending on which verb the browser used.

       The alternative was to make each call site in js/api.js hand-build a query
       string for the non-GET cases. That works and it is what the endpoint would
       need if it were only ever called from one place, but it puts the knowledge of
       jQuery's verb rule into every future caller, where forgetting it produces a
       400 on a screen nobody tested rather than a compile error.

       This is NOT a way to smuggle a body value into somewhere that wants a query
       parameter for a security reason. Nothing here is a credential: the session is
       a cookie, and every id read through this is authorised afterwards. */
    param(name: string, fallback = ''): string {
        const fromQuery = this.query(name, '');

        if (fromQuery !== '') { return fromQuery; }

        const body = this.bodyData as unknown;

        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
            const value = (body as Record<string, unknown>)[name];

            /* Objects and arrays are refused rather than String()-ed, which would
               turn a nested value into '[object Object]' and then compare it against
               something. A scalar or nothing. */
            if (value !== undefined && value !== null
                && (typeof value === 'string' || typeof value === 'number'
                    || typeof value === 'boolean')) {
                return String(value).trim();
            }
        }

        return fallback;
    }

    /* The caller's IP, for login throttling and the audit log.

       x-forwarded-for is a LIST when there are proxies in front, and the first
       entry is the original client. Vercel appends to it, so taking the last one
       would give us Vercel's own edge address for every request in the world. */
    get ip(): string | null {
        const header = this.raw.headers['x-forwarded-for'];
        const raw = Array.isArray(header) ? header[0] : header;

        if (!raw) { return this.raw.socket?.remoteAddress ?? null; }
        return (raw.split(',')[0] ?? '').trim() || null;
    }

    get userAgent(): string | null {
        const value = this.raw.headers['user-agent'];
        return typeof value === 'string' ? value.slice(0, 255) : null;
    }

    cookie(name: string): string | null {
        const header = this.raw.headers.cookie;
        if (!header) { return null; }

        for (const part of header.split(';')) {
            const index = part.indexOf('=');
            if (index === -1) { continue; }

            if (part.slice(0, index).trim() === name) {
                return decodeURIComponent(part.slice(index + 1).trim());
            }
        }
        return null;
    }

    requirePost(): void {
        if (this.method !== 'POST') {
            fail(405, 'That endpoint expects a POST request.');
        }
    }
}


/* =============================================================================
   COOKIES

   Set-Cookie can appear more than once, so these accumulate onto the response
   rather than overwriting.
   ============================================================================= */

export function setCookie(
    res: VercelResponse,
    name: string,
    value: string,
    maxAgeSeconds: number
): void {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        `Max-Age=${maxAgeSeconds}`,

        /* HttpOnly: JavaScript cannot read it, so an XSS bug cannot steal the
           session. This is the whole reason the token is in a cookie rather than
           localStorage, which any script on the page can read.

           SameSite=Lax: sent on normal navigation, withheld on cross-site form
           posts, which is CSRF protection for every state-changing endpoint here.
           Lax rather than Strict because a password-reset link arriving from an
           email client is a cross-site navigation and must still work. */
        'HttpOnly',
        'SameSite=Lax'
    ];

    /* Secure would make the browser refuse the cookie over the plain http:// that
       `vercel dev` serves, so it is set only where it can be honoured. */
    if (env.isProduction) { parts.push('Secure'); }

    append(res, parts.join('; '));
}

export function clearCookie(res: VercelResponse, name: string): void {
    const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
    if (env.isProduction) { parts.push('Secure'); }
    append(res, parts.join('; '));
}

function append(res: VercelResponse, cookie: string): void {
    const existing = res.getHeader('Set-Cookie');

    if (existing === undefined) {
        res.setHeader('Set-Cookie', cookie);
    } else if (Array.isArray(existing)) {
        res.setHeader('Set-Cookie', [...existing, cookie]);
    } else {
        res.setHeader('Set-Cookie', [String(existing), cookie]);
    }
}


/* =============================================================================
   THE WRAPPER

   Every endpoint is `export default defineHandler(async (req, res) => ...)`.

   It exists to put the error handling in ONE place. In the PHP that was spread
   across every file: each one checked the method, caught its own PDOException,
   and decided how much to say. Here an endpoint throws or returns, and this
   decides what the caller sees.
   ============================================================================= */

type Handler = (req: Req, res: VercelResponse) => Promise<ApiResponse>;

export function defineHandler(handler: Handler) {
    return async function (raw: VercelRequest, res: VercelResponse): Promise<void> {
        const req = new Req(raw);

        try {
            send(res, await handler(req, res));

        } catch (error) {
            if (error instanceof HttpError) {
                send(res, {
                    kind: 'json',
                    status: error.status,
                    body: {
                        ok: false,
                        error: error.message,
                        ...(error.field ? { field: error.field } : {})
                    }
                });
                return;
            }

            /* Anything else is a bug, not a refusal.

               Logged in full so it lands in the Vercel function log, and reported
               to the caller only as much as DEV_MODE allows. A database error
               message can name tables, columns and sometimes values, which is not
               something to hand to whoever asked. */
            const message = error instanceof Error ? error.message : String(error);
            console.error('Unhandled error in API handler:', error);

            send(res, {
                kind: 'json',
                status: 500,
                body: {
                    ok: false,
                    error: env.devMode
                        ? `Server error: ${message}`
                        : 'Something went wrong at our end. Please try again.'
                }
            });
        }
    };
}

function send(res: VercelResponse, response: ApiResponse): void {
    /* Already sent - an endpoint that streamed or redirected itself. Writing
         again would throw ERR_HTTP_HEADERS_SENT and mask whatever it did. */
    if (res.headersSent) { return; }

    if (response.kind === 'json') {
        res.status(response.status).json(response.body);
        return;
    }

    if (response.kind === 'text') {
        for (const [key, value] of Object.entries(response.headers ?? {})) {
            res.setHeader(key, value);
        }
        res.setHeader('Content-Type', response.contentType);
        res.status(response.status).send(response.body);
        return;
    }

    for (const [key, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(key, value);
    }
    res.status(response.status).end();
}
