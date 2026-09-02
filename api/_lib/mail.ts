/* =============================================================================
   mail.ts - outbound email
   -----------------------------------------------------------------------------
   Replaces php/lib/mailer.php.

   =============================================================================
   THIS IS A FEATURE THAT WAS SILENTLY BROKEN BEFORE
   =============================================================================

   The PHP tried SMTP, fell back to mail(), and fell back again to writing a
   .txt file into php/mail-log/. On InfinityFree that mattered more than it
   looks: that host blocks PHP's mail() entirely, and no SMTP was configured, so
   every password reset on the live site went into a folder on the server that
   nobody ever read. The feature appeared to work and did nothing.

   Resend needs no SMTP credentials, has a free tier, and returns an error you
   can actually see. The log fallback is kept for local development, where not
   having a key is normal - but now it logs to the function output, which shows
   up in the Vercel dashboard, rather than to a file behind a .htaccess.

   RETURN VALUE. 'resend' | 'log' | false, matching the PHP's contract, because
   register.ts reports it back as emailRoute and the browser shows a different
   hint depending on which happened.
   ============================================================================= */

import { Resend } from 'resend';
import { env, has } from './env.js';
import { validEmail } from './validate.js';

export type MailRoute = 'resend' | 'log' | false;

let resend: Resend | null = null;

export async function sendMail(
    to: string,
    subject: string,
    html: string,
    text?: string
): Promise<MailRoute> {
    /* Refuse rather than throw. Every caller treats sending as best-effort - the
       account was created, the request was recorded, the policy was issued, and
       none of that should be undone because an address was malformed. */
    if (!validEmail(to)) {
        console.warn(`Refusing to send to an invalid address: ${to}`);
        return false;
    }

    if (!has.email()) {
        /* No key configured. Log it so a developer can follow the link, and say
           so loudly enough that it is obvious this is not a real send.

           THE LINK IS IN HERE. That is the point - it is how password reset is
           tested with no mail provider at all. It is also why this must never
           happen in production, and why env.devMode being false does not
           suppress it: silently dropping the mail would be worse. */
        console.log(
            '\n=== EMAIL (not sent - no RESEND_API_KEY configured) ===\n' +
            `To:      ${to}\n` +
            `Subject: ${subject}\n\n` +
            `${text ?? stripHtml(html)}\n` +
            '======================================================\n'
        );
        return 'log';
    }

    try {
        if (!resend) { resend = new Resend(env.resendKey); }

        const result = await resend.emails.send({
            from: env.resendFrom,
            to,
            subject,
            html,
            ...(text ? { text } : {})
        });

        if (result.error) {
            console.error('Resend refused the message:', result.error);
            return false;
        }
        return 'resend';

    } catch (error) {
        /* Never rethrow. See the note above about best-effort. */
        console.error('Sending email failed:', error);
        return false;
    }
}


/* A crude plain-text version for the log fallback and for the text/plain part.
   Not trying to be a renderer - just enough that a link in the log is clickable
   and the sentences are readable. */
function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2: $1')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h1|h2|h3|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}


/* =============================================================================
   THE LAYOUT

   INLINE STYLES ONLY. Gmail strips <style> blocks, so a stylesheet in the head
   is a stylesheet that works everywhere except the client most people use. Every
   rule here is on the element it applies to, which is ugly to write and is the
   only thing that renders reliably.

   Tables rather than flexbox, for the same reason: Outlook renders with Word's
   engine, which does not do modern layout.
   ============================================================================= */

const BRAND = '#E4002B';

export function emailLayout(
    heading: string,
    paragraphs: string[],
    buttonLabel?: string | null,
    buttonUrl?: string | null,
    footNote?: string | null
): string {
    const body = paragraphs
        .map(p =>
            `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2B3240">${esc(p)}</p>`
        )
        .join('');

    const button = (buttonLabel && buttonUrl)
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
             <tr><td style="border-radius:8px;background:${BRAND}">
               <a href="${escAttr(buttonUrl)}"
                  style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;
                         color:#ffffff;text-decoration:none;border-radius:8px">${esc(buttonLabel)}</a>
             </td></tr>
           </table>

           <p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:#6B7280">
             If the button does not work, copy this address into your browser:<br>
             <span style="color:#2B3240;word-break:break-all">${esc(buttonUrl)}</span>
           </p>`
        : '';

    const foot = footNote
        ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#6B7280">${esc(footNote)}</p>`
        : '';

    return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F4F5F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#F4F5F7;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:12px;
                    font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
        <tr><td style="padding:24px 28px 0">
          <div style="font-size:19px;font-weight:800;color:#111827;letter-spacing:-.3px">
            PRU<span style="color:${BRAND}">Wise</span>
          </div>
        </td></tr>
        <tr><td style="padding:18px 28px 28px">
          <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#111827">${esc(heading)}</h1>
          ${body}
          ${button}
          ${foot}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#9CA3AF">
        PRUWise is a student project and is not a real insurance service.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/* Every value that reaches the template goes through this.

   An email body carries names, notes a customer typed and decline reasons a
   representative wrote. Unescaped, a name containing a tag would break the
   layout at best - and at worst the message becomes a way to put markup in
   somebody else's inbox from our domain. */
function esc(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* For a URL going into an attribute. Quotes are the dangerous character here,
   because breaking out of href="..." is how you add another attribute. */
function escAttr(value: string): string {
    return esc(value).replace(/'/g, '&#39;');
}
