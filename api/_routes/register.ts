/* =============================================================================
   POST /api/register  {  name, email, username, password, terms  }
   -----------------------------------------------------------------------------
   Ported from php/api/register.php.

   CUSTOMERS ONLY. There is no role in the request and no way to supply one - the
   INSERT hard-codes 'customer'. So this endpoint cannot be talked into handing
   out staff access no matter what is posted to it. Representative accounts are
   created by an administrator; the first admin comes from the seed script.

   Registering creates two rows: the person, and the login. BOTH OR NEITHER - a
   person with no login is invisible and a login with no person breaks every
   join, so they go in together and roll back together.

   NO REPRESENTATIVE IS ASSIGNED HERE. people.rep_id stays NULL until a
   representative accepts the customer's consultation request, because that is
   the only moment an advisory relationship actually exists. The old code picked
   one automatically and it was wrong twice over: it ignored the "accepting new
   customers" switch, and it made Messages announce a representative the customer
   had never chosen.
   ============================================================================= */

import {
    audit, hashPassword, newPersonId, newToken, hashToken,
    publicAccount, startSession, type User
} from '../_lib/auth.js';
import { batch, column, one } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import { addMessage, aiThread } from '../_lib/threads.js';
import { firstNameOf, passwordProblem, validEmail, validUsername } from '../_lib/validate.js';

export default defineHandler(async (req, res) => {
    req.requirePost();

    const name = req.field('name', '');
    const email = req.field('email', '').toLowerCase();
    const username = req.field('username', '').toLowerCase();
    const password = req.field('password', '');
    const agreed = req.field('terms', false) === true;

    /* Validated in the order somebody fills the form in, so the error always
       points at the first thing that is actually wrong rather than the last. */
    if (name === '' || name.length < 2) {
        fail(400, 'Please enter your full name.', 'name');
    }
    if (name.length > 120) {
        fail(400, 'That name is too long.', 'name');
    }
    if (!validEmail(email)) {
        fail(400, 'Please enter a valid email address.', 'email');
    }
    if (!validUsername(username)) {
        fail(400,
            'Usernames are 4 to 40 characters, using lowercase letters, numbers and dots.',
            'username');
    }

    const passwordIssue = passwordProblem(password);
    if (passwordIssue !== null) {
        fail(400, passwordIssue, 'password');
    }
    if (!agreed) {
        fail(400, 'Please accept the terms to continue.', 'terms');
    }

    /* Already taken?

       The UNIQUE constraints are what actually guarantee this - two requests
       arriving together would both pass a check like this one. Checked anyway so
       the normal case gets a message next to the right field instead of a 500,
       with the constraint violation caught below for the race. */
    if (await column('SELECT 1 FROM accounts WHERE username = ?', [username])) {
        fail(409, 'That username is already taken. Please choose another.', 'username');
    }
    if (await column('SELECT 1 FROM accounts WHERE email = ?', [email])) {
        fail(409,
            'There is already an account with that email address. ' +
            'Try signing in, or reset your password.',
            'email');
    }

    const personId = await newPersonId('cus');
    const firstName = firstNameOf(name);
    const passwordHash = await hashPassword(password);
    const confirmToken = newToken();

    let accountId: number;

    try {
        /* All five writes, atomically, in one round trip.

           The PHP opened a transaction and issued five separate statements. This
           is the same guarantee - the driver wraps the batch in a real
           transaction - with a fifth of the network cost.

           The two CTE-style inserts chain off each other by returning ids, which
           also removes the lastInsertId() call the PHP needed between them. */
        await batch(sqlt => [
            sqlt`INSERT INTO people
                     (id, kind, name, first_name, email, rep_id, segment, client_since, status)
                 VALUES (${personId}, 'customer', ${name}, ${firstName}, ${email},
                         NULL, 'New customer', CURRENT_DATE, 'active')`,

            sqlt`INSERT INTO accounts
                     (person_id, role, username, email, password_hash, name,
                      label, note, email_verified)
                 VALUES (${personId}, 'customer', ${username}, ${email}, ${passwordHash},
                         ${name}, 'Customer', 'Self-registered', false)`,

            /* These three find the account they belong to by username rather than
               by a returned id. Inside one transaction the row is already visible,
               and username is UNIQUE, so this is exact - and it avoids depending on
               the driver's batch result shape, which its own documentation warns is
               awkward to type. */
            sqlt`INSERT INTO account_prefs (account_id)
                 SELECT id FROM accounts WHERE username = ${username}`,

            sqlt`INSERT INTO threads (kind, owner_account_id, last_message_at)
                 SELECT 'ai', id, now() FROM accounts WHERE username = ${username}
                 ON CONFLICT DO NOTHING`,

            sqlt`INSERT INTO email_change_requests
                     (account_id, new_email, token_hash, expires_at)
                 SELECT id, ${email}, ${hashToken(confirmToken)}, now() + INTERVAL '7 days'
                   FROM accounts WHERE username = ${username}`
        ]);

        /* One indexed lookup on a unique column, after the transaction committed.
           Cheaper than being clever about the batch's return type, and it also
           confirms the whole batch actually landed. */
        const created = await column<number>(
            'SELECT id FROM accounts WHERE username = ?', [username]
        );

        if (created === null) {
            throw new Error('The account was written but could not be read back.');
        }
        accountId = Number(created);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        /* 23505 is unique_violation. Reaching here means the race the checks above
           cannot close actually happened. */
        if (message.includes('duplicate key') || message.includes('23505')) {
            fail(409, 'That username or email was just taken. Please try again.', 'username');
        }

        console.error('Register failed:', error);
        fail(500, env.devMode
            ? `Could not create the account: ${message}`
            : 'Could not create the account right now. Please try again shortly.');
    }

    /* The welcome message.

       IT GOES IN THE PRUWISE THREAD, NOT A HUMAN ONE. There is no human to have a
       conversation with yet. This is the message that used to read "<somebody> is
       your financial representative" about a representative the customer had never
       chosen; now it says the true thing, in the one conversation that always
       exists. */
    const welcome = await aiThread(accountId);

    if (welcome) {
        await addMessage(welcome.id, {
            senderKind: 'system',
            body:
                `Welcome to PRUWise, ${firstName}. You do not have a financial ` +
                `representative yet. Take the Financial Needs Assessment and we will show ` +
                `you the representatives who fit what you are looking for - you choose one, ` +
                `and they confirm. In the meantime you can ask me anything about insurance ` +
                `in plain language.`
        });
    }

    /* Signed in immediately.

       NO EMAIL CONFIRMATION GATE. Making somebody check their inbox before they
       can look around loses most of them, and a brand new account owns nothing
       sensitive. A confirmation link is still sent and email_verified stays false
       until it is used, which is what the password reset flow cares about. */
    const account = await one<User>(
        `SELECT a.*, p.name AS person_name, p.rep_id, p.phone AS person_phone,
                p.kind, p.client_since
           FROM accounts a
           JOIN people p ON p.id = a.person_id
          WHERE a.id = ?`,
        [accountId]
    );

    if (!account) {
        fail(500, 'The account was created but could not be read back. Please try signing in.');
    }

    await startSession(res, account, req);
    await audit(accountId, 'register', 'self-registered customer', req.ip);

    const confirmUrl = `${env.appUrl}/index.html#/confirm-email?token=${confirmToken}`;

    /* A failure here must not fail the registration - the account exists and
       works, so we report how it went and move on. */
    const sent = await sendMail(
        email,
        'Welcome to PRUWise',
        emailLayout(
            `Welcome, ${firstName}`,
            [
                `Your PRUWise account is ready. You can sign in with the username ${username}.`,
                'Please confirm this email address so we can help you get back in if you ever ' +
                'forget your password.'
            ],
            'Confirm my email address',
            confirmUrl,
            'If you did not create this account, you can ignore this email.'
        )
    );

    return ok({
        account: await publicAccount(account),
        emailRoute: sent === false ? 'failed' : sent,

        /* In development the link is handed back so the flow can be tested with no
           mail provider at all. NEVER in production - a confirmation link in an
           API response is readable by anything watching the page. */
        devLink: env.devMode ? confirmUrl : null
    });
});
