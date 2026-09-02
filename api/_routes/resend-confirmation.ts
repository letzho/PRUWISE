/* =============================================================================
   POST /api/resend-confirmation  {}
   -----------------------------------------------------------------------------
   Ported from php/api/resend-confirmation.php.

   Sends the "confirm your email address" link again, to the address already on the
   account. Needed because /api/confirm-email tells people to do exactly this when
   their link has expired.

   NO PASSWORD REQUIRED, unlike changing an email address. The link only ever goes
   to the address that is already on the account, so the worst somebody with a
   borrowed laptop can achieve is sending the real owner an email they were
   expecting anyway.

   Rate limited, because "send me an email" endpoints are how a server ends up being
   used to flood somebody's inbox - and how a sending domain's reputation gets
   destroyed.
   ============================================================================= */

import { audit, hashToken, newToken, requireLogin } from '../_lib/auth.js';
import { batch, column } from '../_lib/db.js';
import { env, has } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { firstNameOf } from '../_lib/validate.js';

const EMAILS_PER_HOUR = 5;

export default defineHandler(async (req) => {
    req.requirePost();

    const user = await requireLogin(req);

    if (user.email_verified === true) {
        fail(400, 'Your email address is already confirmed.');
    }

    /* The same question the reset limit answers - has this account triggered too
       many emails lately - counted over the table this endpoint writes to. */
    const recent = Number(await column(
        `SELECT COUNT(*) FROM email_change_requests
          WHERE account_id = ? AND created_at > now() - INTERVAL '1 hour'`,
        [user.id]
    ) ?? 0);

    if (recent >= EMAILS_PER_HOUR) {
        fail(429, 'We have sent several confirmation emails in the last hour. ' +
            'Please check your inbox and spam folder, then try again later.');
    }

    const token = newToken();

    /* Retire any earlier unused link, so only the newest email works - and do both
       writes together, because retiring the old one without issuing a new one would
       leave the account with no way to confirm at all. */
    await batch(sqlt => [
        sqlt`UPDATE email_change_requests SET used_at = now()
              WHERE account_id = ${user.id} AND used_at IS NULL`,

        sqlt`INSERT INTO email_change_requests
                 (account_id, new_email, token_hash, expires_at)
             VALUES (${user.id}, ${user.email}, ${hashToken(token)},
                     now() + INTERVAL '7 days')`
    ]);

    const confirmUrl = `${env.appUrl}/index.html#/confirm-email?token=${token}`;

    const route = await sendMail(
        user.email,
        'Confirm your PRUWise email address',
        emailLayout(
            'Confirm your email address',
            [
                `Hello ${firstNameOf(user.person_name || user.name)},`,
                'Please confirm this address so we can help you get back into your account ' +
                'if you ever forget your password.',
                'This link is valid for 7 days.'
            ],
            'Confirm my email address',
            confirmUrl,
            'If you did not ask for this, you can ignore it.'
        )
    );

    await audit(user.id, 'confirmation_resent',
        `route=${route === false ? 'failed' : route}`, req.ip);

    return ok({
        message: route === 'log'
            ? 'No mail provider is configured, so the link was written to the function log.'
            : `Sent. Check ${user.email} for the confirmation link.`,
        emailRoute: route === false ? 'failed' : route,
        emailConfigured: has.email(),
        devLink: env.devMode ? confirmUrl : null
    });
});
