/* =============================================================================
   /api/policies
       GET                  ->  my policies and my applications
       GET ?personId=x      ->  a customer's, for THEIR representative only
       GET  (as a rep, no id) -> my queue of applications to decide

       POST { action: 'apply',    productId, cover?, ciCover?, monthlyBenefit?,
                                  premium, termYears?, note? }   customer
       POST { action: 'withdraw', id }                           customer
       POST { action: 'review',   id }                           representative
       POST { action: 'issue',    id, premium?, cover?, ... }    representative
       POST { action: 'decline',  id, reason }                   representative
   -----------------------------------------------------------------------------
   Ported from php/api/policies.php.

   =============================================================================
   WHO MAY DO WHAT
   =============================================================================

     A CUSTOMER applies for cover, withdraws their own application, and reads
     their own policies. They cannot issue anything - see the note in
     _lib/policies.ts about why a licensed human decides.

     A REPRESENTATIVE reviews, issues and declines, but only for applications
     that were sent TO THEM. Not to representatives in general. The application
     stores rep_person_id at submission time precisely so this check has
     something stable to compare against.

     AN ADMIN gets nothing here. Administrators manage accounts; they are not in
     the advisory relationship, and issuing insurance is not a support function.

   A REQUEST ABOUT SOMEBODY ELSE'S CUSTOMER RETURNS 404, NOT 403, so that "not
   yours" and "not real" look identical from outside. Same rule as /api/finances.

   =============================================================================
   WHY THE CUSTOMER'S OWN POLICIES ARE NOT GATED ON hasSampleProfile
   =============================================================================

   js/pages-me.js used to decide whether to show a policy list by asking
   hasSampleData(), a hard-coded list of eight seeded person ids. That was right
   while policies existed only as fixtures.

   It is wrong now. A self-registered customer who has been issued real cover is
   not on that list and never will be, so the old gate would show them an empty
   "no plans yet" screen while a row in `policies` said otherwise. This endpoint
   answers from the table, for anybody, and the browser merges the fixtures in on
   top for the seeded demo accounts.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { one } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { defineHandler, fail, ok, type Req } from '../_lib/http.js';
import { emailLayout, sendMail } from '../_lib/mail.js';
import {
    activePolicyFor,
    applicationJson,
    applicationsForCustomer,
    applicationsForRep,
    applyForPolicy,
    declineApplication,
    issuePolicy,
    openApplicationFor,
    policiesFor,
    policyApplication,
    policyById,
    policyJson,
    policyMoney,
    policyProduct,
    takeUpApplication,
    withdrawApplication
} from '../_lib/policies.js';
import { addMessage, humanThread } from '../_lib/threads.js';


/* The three keys policyJson() always fills that this file reads back. Declared
   so the announcement text and the email are not built out of `unknown`. */
interface ShapedPolicy extends Record<string, unknown> {
    number: string;
    coverText: string;
    premium: { amount: number; per: string };
}


/* -----------------------------------------------------------------------------
   A validator for every money figure below.

   Returns the integer, or fails and does not come back - which is why fail() is
   declared `never`. The upper bounds are not arbitrary: they are the point past
   which a number is certainly a typo, and a silly figure here becomes a silly
   policy somebody has to explain later.
   -------------------------------------------------------------------------- */
function policyAmount(req: Req, key: string, max: number, required = false): number | null {
    const raw = req.body[key];

    if (raw === undefined || raw === null || raw === '') {
        if (required) {
            fail(400, `Please give a figure for ${key}.`, key);
        }
        return null;
    }

    /* Numbers and numeric strings only. A boolean coerces to 1 in JavaScript,
       which PHP's is_numeric() would have rejected, so it is rejected here too -
       silently treating `true` as $1 is worse than saying no. */
    if (typeof raw !== 'number' && typeof raw !== 'string') {
        fail(400, 'That does not look like a number.', key);
    }

    const numeric = Number(typeof raw === 'string' ? raw.trim() : raw);

    if (!Number.isFinite(numeric)) {
        fail(400, 'That does not look like a number.', key);
    }

    const value = Math.round(numeric);

    if (value < 0) {
        fail(400, 'That cannot be a negative amount.', key);
    }

    if (value > max) {
        fail(400, 'That figure looks too large. Please check it.', key);
    }

    return value;
}


export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403, "Administrators do not have access to customers' policies.");
    }

    /* ===================================================================== GET */
    if (req.method === 'GET') {

        /* -------------------------------------------- a customer, themselves

           ?personId is not consulted, for the same reason as /api/finances: a
           rule enforced by comparison is a rule that can be compared the wrong
           way round. A customer's own id comes from their session, always. */
        if (user.role === 'customer') {
            const policies = (await policiesFor(user.person_id)).map(policyJson);
            const applications = (await applicationsForCustomer(user.person_id))
                .map(applicationJson);

            return ok({
                policies,
                applications,
                canApply: user.rep_id !== null,
                whose: 'self'
            });
        }

        /* --------------------------- a representative, one of their customers */
        const personId = req.query('personId');

        if (personId === '') {
            /* No id given means "my whole queue", which is what the dashboard
               wants. Applications only - a representative's landing screen is
               about what needs deciding, not a catalogue of everything already
               issued. */
            const queue = (await applicationsForRep(user.person_id)).map(applicationJson);

            return ok({ applications: queue, whose: 'queue' });
        }

        /* Existence and ownership in one query, so there is no window between
           them and no way to tell the two failures apart. */
        const customer = await one<{ id: string; name: string; first_name: string | null }>(
            `SELECT id, name, first_name FROM people
              WHERE id = ? AND kind = 'customer' AND rep_id = ?`,
            [personId, user.person_id]
        );

        if (!customer) {
            fail(404, 'That customer could not be found.');
        }

        const policies = (await policiesFor(personId)).map(policyJson);
        const applications = (await applicationsForCustomer(personId)).map(applicationJson);

        return ok({
            policies,
            applications,
            canApply: false,
            whose: 'customer',
            customerName: customer.name,
            firstName: customer.first_name ?? customer.name
        });
    }

    /* ==================================================================== POST */
    req.requirePost();

    const action = req.field('action', '');


    /* =====================================================================
       APPLY - the customer asking for cover
       ===================================================================== */
    if (action === 'apply') {

        if (user.role !== 'customer') {
            fail(403, 'Only a customer can apply for cover.');
        }

        /* No representative, no application. There would be nobody to decide it,
           and a row with a NULL rep_person_id could never leave 'submitted'.

           A customer in this state is normally kept away from the screens that
           would offer this at all - see CUSTOMER_OPEN_PATHS in js/app.js - so
           this is the backstop rather than the message most people would see. */
        if (user.rep_id === null) {
            fail(409,
                'You need a financial representative before you can apply. Complete the ' +
                'assessment and choose one, and they will be able to take this forward.');
        }

        const productId = req.field('productId', '');
        const product = policyProduct(productId);

        /* The catalogue is the authority on what exists. See the note at the top
           of _lib/policies.ts about why this check lives here and not in a
           foreign key. */
        if (!product) {
            fail(400, 'That is not a plan we offer.', 'productId');
        }

        /* One open application per product. A second one is almost always an
           impatient refresh, and two identical rows in a queue confuse both
           sides. */
        const existing = await openApplicationFor(user.person_id, productId);

        if (existing) {
            fail(409,
                `You already have an application open for ${product.name}. ` +
                'Your representative is looking at it.');
        }

        /* And one ACTIVE POLICY per product. See the long note above
           activePolicyFor() in _lib/policies.ts: without this the demo customer
           collected sixteen identical PRUActive Protect policies and was told she
           paid $3,600 a month for them. */
        const held = await activePolicyFor(user.person_id, productId);

        if (held) {
            fail(409,
                `You already hold ${product.name} - policy ` +
                `${String(held.policy_number ?? '')}. If you want more cover, message ` +
                'your representative and they can raise it on the plan you have rather ' +
                'than starting a second one.');
        }

        const premium = policyAmount(req, 'premium', 100_000, true) as number;

        if (premium < 1) {
            fail(400, 'A plan needs a premium.', 'premium');
        }

        const note = req.field('note', '');

        if (note.length > 500) {
            fail(400, 'Please keep your note under 500 characters.', 'note');
        }

        const id = await applyForPolicy(user.person_id, user.rep_id, productId, {
            cover: policyAmount(req, 'cover', 100_000_000),
            ciCover: policyAmount(req, 'ciCover', 100_000_000),
            monthlyBenefit: policyAmount(req, 'monthlyBenefit', 1_000_000),
            premium,
            termYears: policyAmount(req, 'termYears', 60),
            note
        });

        if (id === null) {
            fail(500, 'That application could not be saved. Please try again.');
        }

        await audit(user.id, 'policy_applied', `product=${productId}`, req.ip);

        /* Tell the representative. Same reasoning as a consultation request: a
           queue nobody looks at for a week is the same as a refusal, and this one
           has somebody waiting on an answer about their own protection.

           The send is deliberately not checked - the row is committed either way
           and the dashboard will show it. */
        const rep = await one<{ name: string; first_name: string | null; email: string | null }>(
            'SELECT name, first_name, email FROM people WHERE id = ?',
            [user.rep_id]
        );

        if (rep && rep.email) {
            const customerName = user.person_name || user.name;

            await sendMail(
                rep.email,
                `${customerName} has applied for ${product.name}`,
                emailLayout(
                    'A customer has applied for cover',
                    [
                        `Hello ${rep.first_name ?? rep.name},`,
                        `${customerName} has applied for ${product.name} at about ` +
                        `${policyMoney(premium)} a month.`,
                        note === ''
                            ? 'They did not leave a note.'
                            : `They wrote: "${note}"`,
                        'Nothing is in force until you issue it. Open your dashboard to ' +
                        'review the application against their assessment and financial record.'
                    ],
                    'Review the application', `${env.appUrl}/index.html`,
                    'Cover begins only when you issue the policy.'
                )
            );
        }

        return ok({
            application: applicationJson(await policyApplication(id)),
            message: `Sent. ${rep ? rep.name : 'Your representative'} will review this and ` +
                     'come back to you. Nothing is in force yet.'
        });
    }


    /* =====================================================================
       WITHDRAW - the customer changing their mind
       ===================================================================== */
    if (action === 'withdraw') {

        const id = req.field('id', 0);
        const application = await policyApplication(id);

        if (!application) {
            fail(404, 'That application could not be found.');
        }

        if (user.role !== 'customer' || user.person_id !== application.customer_person_id) {
            fail(403, 'That is not your application.');
        }

        if (!await withdrawApplication(id)) {
            fail(409, `That application was already ${String(application.status)}.`);
        }

        await audit(user.id, 'policy_withdrawn', `application=${id}`, req.ip);

        return ok({ message: 'Withdrawn. You can apply again whenever you are ready.' });
    }


    /* =====================================================================
       Everything below belongs to the representative the application was sent
       to. Both checks matter: the role check stops a customer calling these at
       all, and the id comparison stops one representative deciding another's
       applications.
       ===================================================================== */

    const id = req.field('id', 0);
    const application = await policyApplication(id);

    if (!application) {
        fail(404, 'That application could not be found.');
    }

    if (user.role !== 'fr' || user.person_id !== application.rep_person_id) {
        fail(403, 'That application was not sent to you.');
    }

    const product = policyProduct(application.product_id);
    const productName = product ? product.name : String(application.product_id);
    const customerFirstName = String(
        application.customer_first_name || application.customer_name
    );


    /* =====================================================================
       REVIEW - "I am looking at this"

       Reversible and purely informational, but it is what stops two people
       working the same request, so it is a real transition rather than a UI flag.
       ===================================================================== */
    if (action === 'review') {

        if (!await takeUpApplication(id)) {
            fail(409, `That application is already ${String(application.status)}.`);
        }

        await audit(user.id, 'policy_under_review', `application=${id}`, req.ip);

        return ok({
            application: applicationJson(await policyApplication(id)),
            message: 'Marked as under review.'
        });
    }


    /* =====================================================================
       ISSUE - accept it, and create the cover

       The representative may issue on different terms from those applied for,
       which is the normal outcome once the figures have been looked at properly.
       Anything not sent here is taken from the application.
       ===================================================================== */
    if (action === 'issue') {

        const policyId = await issuePolicy(application, user.person_id, {
            cover: policyAmount(req, 'cover', 100_000_000),
            ciCover: policyAmount(req, 'ciCover', 100_000_000),
            monthlyBenefit: policyAmount(req, 'monthlyBenefit', 1_000_000),
            premium: policyAmount(req, 'premium', 100_000) ?? undefined,
            termYears: policyAmount(req, 'termYears', 60)
        });

        /* null means the row was no longer issuable - either somebody else just
           dealt with it, or the write failed. Both are 409s from here: nothing
           was created, and the caller should reload rather than retry blindly. */
        if (policyId === null) {
            fail(409,
                'That application could not be issued. It may have just been dealt with ' +
                'somewhere else - reload to see where it got to.');
        }

        await audit(user.id, 'policy_issued',
            `application=${id} policy=${policyId} ` +
            `customer=${String(application.customer_person_id)}`, req.ip);

        const policy = policyJson(await policyById(policyId)) as ShapedPolicy | null;

        if (!policy) {
            fail(500, 'The policy was created but could not be read back. Please reload.');
        }

        /* Put it in the conversation they already read, rather than only in an
           email.

           clientRef makes this idempotent: a double-tap on a slow connection
           cannot post the same announcement twice, because addMessage() lets the
           unique constraint reject the second one and returns null. */
        const thread = await humanThread(
            user.person_id, String(application.customer_person_id)
        );

        if (thread) {
            await addMessage(thread.id, {
                senderAccountId: user.id,
                senderKind: 'system',
                clientRef: `policy-issued-${id}`,
                body:
                    `Your ${productName} policy is now in force. Policy number ` +
                    `${policy.number}, ${policy.coverText}, at ` +
                    `${policyMoney(policy.premium.amount)} a month. ` +
                    'It is on your My plans screen with the full details.'
            });
        }

        if (application.customer_email) {
            await sendMail(
                String(application.customer_email),
                `Your ${productName} policy is in force`,
                emailLayout(
                    'Your cover has started',
                    [
                        `Hello ${customerFirstName},`,
                        `${user.person_name} has issued your ${productName} policy.`,
                        `Policy number ${policy.number}. It covers ${policy.coverText}, ` +
                        `and the premium is ${policyMoney(policy.premium.amount)} a month.`,
                        'The full details - what is included, when it renews - are on the ' +
                        'My plans screen in PRUWise.'
                    ],
                    'See my plans', `${env.appUrl}/index.html`,
                    'Keep your policy number somewhere safe. You will need it if you ever claim.'
                )
            );
        }

        return ok({
            policy,
            application: applicationJson(await policyApplication(id)),
            message: `Issued. ${String(application.customer_name)} now holds ${productName}, ` +
                     `policy number ${policy.number}.`
        });
    }


    /* =====================================================================
       DECLINE - refuse it, with a reason the customer reads

       The reason is required, and it is shown to them. Same rule as a declined
       consultation request and a declined admin change request, for the same
       reason: a silent no is the most frustrating possible outcome, and this
       particular no is about somebody's protection.
       ===================================================================== */
    if (action === 'decline') {

        const reason = req.field('reason', '');

        if (reason.length < 10) {
            fail(400,
                'Please give a short reason - at least 10 characters. The customer sees it.',
                'reason');
        }

        if (reason.length > 200) {
            fail(400, 'Please keep the reason under 200 characters.', 'reason');
        }

        if (!await declineApplication(id, reason)) {
            fail(409, `That application was already ${String(application.status)}.`);
        }

        await audit(user.id, 'policy_declined', `application=${id}`, req.ip);

        const thread = await humanThread(
            user.person_id, String(application.customer_person_id)
        );

        if (thread) {
            await addMessage(thread.id, {
                senderAccountId: user.id,
                senderKind: 'system',
                clientRef: `policy-declined-${id}`,
                body:
                    `Your application for ${productName} was not taken forward. ` +
                    `${user.person_name} wrote: "${reason}" ` +
                    'Ask them here about anything you would like explained.'
            });
        }

        if (application.customer_email) {
            await sendMail(
                String(application.customer_email),
                `About your ${productName} application`,
                emailLayout(
                    'Your application was not taken forward',
                    [
                        `Hello ${customerFirstName},`,
                        `${user.person_name} has looked at your application for ` +
                        `${productName} and has not taken it forward for now.`,
                        `They wrote: "${reason}"`,
                        'This is not the end of it. Message them in PRUWise and they can ' +
                        'talk you through what would work better.'
                    ],
                    'Open PRUWise', `${env.appUrl}/index.html`,
                    'No cover was started, and nothing has been charged.'
                )
            );
        }

        return ok({
            application: applicationJson(await policyApplication(id)),
            message: `Declined, and ${customerFirstName} has been told why.`
        });
    }

    fail(400, 'Unknown action.', 'action');
});
