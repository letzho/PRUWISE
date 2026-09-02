/* =============================================================================
   validate.ts - input rules
   -----------------------------------------------------------------------------
   Ported from the validation helpers in php/lib/bootstrap.php. Same rules, same
   messages, so the browser sees identical text and nothing in the UI has to
   change.
   ============================================================================= */

/* PHP used filter_var(FILTER_VALIDATE_EMAIL), which is stricter than most
   regexes people write by hand and looser than RFC 5322 - deliberately, because
   fully RFC-valid addresses include forms no mail provider accepts.

   This is a practical approximation of the same thing: one @, something either
   side, a dot in the domain, no spaces, no consecutive dots. Perfect email
   validation is impossible; the only real test is whether a message arrives,
   which is why confirmation links exist. */
export function validEmail(email: string): boolean {
    if (email.length === 0 || email.length > 190) { return false; }
    if (email.includes('..')) { return false; }

    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

/* Lowercase letters, digits and dots, 4 to 40 characters.

   Restricting the alphabet means a username can never look like an email
   address, a path, or a piece of SQL. That is defence in depth rather than the
   defence - queries are parameterised - but it also means a username can be put
   in a URL or a filename without escaping questions. */
export function validUsername(username: string): boolean {
    return /^[a-z0-9.]{4,40}$/.test(username);
}

const MIN_PASSWORD = 8;

/* Returns a message, or null when the password is acceptable.

   LENGTH ONLY, ON PURPOSE. Requiring symbols and capitals pushes people towards
   "Password1!" and a sticky note. Length is what actually helps, so that is the
   only rule, and the upper bound exists because bcrypt ignores everything past
   72 bytes and a megabyte-long password is a denial-of-service rather than a
   secure one. */
export function passwordProblem(password: string): string | null {
    if (password.length < MIN_PASSWORD) {
        return `Your password needs at least ${MIN_PASSWORD} characters.`;
    }
    if (password.length > 200) {
        return 'That password is too long.';
    }
    return null;
}

/* "Sarah Tan" -> "Sarah". Only used to address somebody warmly in the UI, so a
   single name or a leading space must not produce an empty string. */
export function firstNameOf(fullName: string): string {
    const first = fullName.trim().split(/\s+/)[0] ?? '';
    return first === '' ? fullName.trim() : first;
}


/* =============================================================================
   THE SHAPE OF A TOKEN

   Every emailed link - password reset, email confirmation - carries a token from
   auth.ts's newToken(). This says whether a string could possibly be one.

   IT IS A CHEAP REJECTION, NOT A SECURITY CONTROL. The database lookup is what
   actually decides; this only avoids hashing and querying for input that cannot
   match, and it keeps obviously-wrong values out of the query.

   =============================================================================
   WHY THIS IS NOT THE HEX PATTERN THE PHP USED
   =============================================================================

   php/lib/auth.php built tokens with bin2hex(), so every endpoint checked
   /^[a-f0-9]{32,128}$/. auth.ts uses base64url instead - shorter for the same 32
   bytes of randomness, and URL-safe without escaping.

   Copying the hex pattern across would have rejected every single real token, and
   the failure would have looked exactly like "the link expired". Worth spelling
   out, because that is a bug you can stare straight through.
   ============================================================================= */
export function looksLikeToken(token: string): boolean {
    return /^[A-Za-z0-9_-]{20,200}$/.test(token);
}
