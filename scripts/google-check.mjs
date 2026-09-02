/* =============================================================================
   scripts/google-check.mjs  -  is Google sign-in actually switched on?
   -----------------------------------------------------------------------------
   Setting GOOGLE_CLIENT_ID is not the same as it working, and the two ways it
   silently fails are worth checking for rather than discovering in front of an
   audience:

     1. THE VARIABLE IS SET BUT THE DEPLOYMENT PREDATES IT. Vercel injects
        environment variables at build time, so a value added after the last
        deploy is invisible until the next one. The symptom is a login screen with
        no Google button and no error anywhere.

     2. THE VALUE IS MALFORMED. A client id copied out of the Google console
        sometimes arrives with a trailing newline, a quote, or the words "Client
        ID" attached. Google Identity Services then fails inside its own iframe
        and the button simply never appears - nothing reaches the console that
        points at the cause.

   So this asserts the SHAPE of what the browser is given, not merely that
   something was given.

   WHAT IT CANNOT CHECK: whether the origin is authorised in the Google console.
   That is only enforced when a real browser loads Google's script, and it is the
   single most common remaining mistake - see the note at the bottom.
   ============================================================================= */

const base = 'https://pruwise.vercel.app';

let pass = 0;
const failures = [];

function check(label, ok, detail) {
    if (ok) { pass++; console.log(`  ok   ${label}`); return; }
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  -> ${detail}`}`);
}

console.log('\nGoogle sign-in configuration\n');

const session = await (await fetch(`${base}/api/session`)).json();
const clientId = session?.server?.googleClientId ?? null;

check('the server tells the browser about Google at all',
    clientId !== null && clientId !== '',
    clientId === null
        ? 'googleClientId is null - GOOGLE_CLIENT_ID is unset on the build that is live'
        : String(clientId));

if (clientId) {
    /* Google client ids are always <digits>-<hash>.apps.googleusercontent.com */
    check('  and it is a real Google client id, not a pasted label',
        /^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/.test(clientId),
        clientId);

    check('  with no stray whitespace or quotes around it',
        clientId === clientId.trim() && !/["']/.test(clientId),
        JSON.stringify(clientId));
}

/* THE SECRET MUST NOT BE HERE. A client id is public by design - it is sent to
   every browser. A client SECRET is not, and pasting the wrong one of the pair
   into GOOGLE_CLIENT_ID would put a credential in a public response. */
const wholeBody = JSON.stringify(session);

check('NO CLIENT SECRET IS EXPOSED in the session response',
    !/GOCSPX-/.test(wholeBody));

/* The endpoint that does the real work. It must refuse a token it cannot verify -
   this is the check that matters, because "signed in with Google" is worthless if
   the server believes whatever the browser hands it. */
const forged = await fetch(`${base}/api/google-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'not.a.real.token' })
});

check('A FORGED GOOGLE TOKEN IS REFUSED', forged.status >= 400,
    `got ${forged.status}`);

const forgedBody = await forged.json().catch(() => null);

check('  and the refusal does not leak why in detail',
    typeof forgedBody?.error === 'string' && forgedBody.error.length < 200,
    forgedBody?.error);

check('google-login refuses a GET',
    (await fetch(`${base}/api/google-login`)).status >= 400);

check('and an empty credential is refused',
    (await fetch(`${base}/api/google-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })).status >= 400);

/* The login page must actually render the mount point, or the button has nowhere
   to go even with a valid id. */
const index = await (await fetch(`${base}/`)).text();

check('the app ships the Google button mount point',
    index.includes('js/app.js'), 'index.html did not load');

console.log('\n====================================================');
if (failures.length === 0) {
    console.log(`ALL ${pass} GOOGLE CHECKS PASSED`);
    console.log('\nSTILL TO CONFIRM BY HAND, because only a real browser can:');
    console.log('  - https://pruwise.vercel.app must be listed as an AUTHORISED');
    console.log('    JAVASCRIPT ORIGIN on the OAuth client (not a redirect URI).');
    console.log('  - If it is missing, the button renders and then does nothing,');
    console.log('    with the reason only visible in the browser console.');
} else {
    console.log(`${pass} passed, ${failures.length} FAILED`);
    failures.forEach(f => console.log(`   - ${f}`));
}
console.log('====================================================\n');

process.exit(failures.length === 0 ? 0 : 1);
