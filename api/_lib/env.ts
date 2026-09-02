/* =============================================================================
   env.ts - typed access to configuration
   -----------------------------------------------------------------------------
   Replaces php/config.php and the config() helper.

   THE IMPORTANT DIFFERENCE. config.php was a FILE IN THE REPOSITORY holding the
   database password, the OpenAI key and the email password. It was kept out of
   git by a single .gitignore line, which is one mistake away from publishing
   every secret in the project.

   Here there is no file. Vercel holds the values and injects them into the
   process, so the secrets are never in source control at all.

   Everything is read through the helpers below rather than touching
   process.env directly, so a missing required variable produces one clear
   message at the point of use instead of the string "undefined" arriving
   somewhere far away as a connection error.
   ============================================================================= */

/* Required. Throws if absent, because there is no sensible fallback for a
   database URL or a signing secret - continuing would only fail later and less
   clearly. */
function required(name: string): string {
    const value = process.env[name];

    if (value === undefined || value.trim() === '') {
        throw new Error(
            `Missing required environment variable ${name}. ` +
            `Set it in the Vercel dashboard under Settings -> Environment Variables, ` +
            `or in .env.local for local development. See .env.example.`
        );
    }
    return value;
}

/* Optional. Returns '' when unset, and callers branch on that.

   Empty rather than undefined on purpose: every optional feature in this app
   already has a documented "not configured" behaviour - no OpenAI key means the
   built-in rules answer, no Resend key means email is logged instead of sent -
   so the absence needs to be a value that flows through, not an exception. */
function optional(name: string, fallback = ''): string {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? fallback : value;
}

export const env = {
    /* --- required --- */

    get databaseUrl(): string {
        return required('DATABASE_URL');
    },

    get sessionSecret(): string {
        const secret = required('SESSION_SECRET');

        /* A short secret is worse than no secret, because it looks configured.
           32 characters is not a cryptographic argument, it is a typo check -
           anything shorter is somebody having put a placeholder in. */
        if (secret.length < 32) {
            throw new Error(
                'SESSION_SECRET is too short. Generate one with: ' +
                'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
            );
        }
        return secret;
    },

    /* No trailing slash, ever. Every link built from this concatenates a path
         appUrl + '/index.html#/reset-password?token=...'
       and a trailing slash produces a double slash, which some mail clients
       mangle and some proxies redirect. Normalised here so no caller has to
       remember. */
    get appUrl(): string {
        return required('APP_URL').replace(/\/+$/, '');
    },

    /* --- optional --- */

    get openaiKey(): string {
        return optional('OPENAI_API_KEY');
    },

    get openaiModel(): string {
        return optional('OPENAI_MODEL', 'gpt-4o-mini');
    },

    get resendKey(): string {
        return optional('RESEND_API_KEY');
    },

    get resendFrom(): string {
        return optional('RESEND_FROM', 'PRUWise <onboarding@resend.dev>');
    },

    get blobToken(): string {
        return optional('BLOB_READ_WRITE_TOKEN');
    },

    get googleClientId(): string {
        return optional('GOOGLE_CLIENT_ID');
    },

    /* --- flags --- */

    /* Technical detail in error responses, and reset links shown on screen.

       Also true automatically when Vercel says this is a preview or development
       deployment, so a branch deploy is debuggable without anybody having to
       remember to set it - and, more importantly, production never is unless
       somebody sets DEV_MODE explicitly. */
    get devMode(): boolean {
        if (optional('DEV_MODE') === '1') { return true; }
        return optional('VERCEL_ENV', 'development') !== 'production';
    },

    /* True on the deployed site, false under `vercel dev`. Used for the Secure
       flag on the session cookie, which a browser will not accept over the plain
       http:// that local development uses. */
    get isProduction(): boolean {
        return optional('VERCEL_ENV') === 'production';
    }
};


/* Whether a feature is usable, so an endpoint can answer "not configured"
   honestly rather than failing halfway through. */
export const has = {
    openai: () => env.openaiKey !== '',
    email:  () => env.resendKey !== '',
    blob:   () => env.blobToken !== '',
    google: () => env.googleClientId !== ''
};
