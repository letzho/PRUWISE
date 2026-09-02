/* =============================================================================
   GET  /api/recommendations[?person=cus-001]
        ->  { personId, released: [...], canRelease }

   POST /api/recommendations
        { recId, productId, productName, note?, action: 'release' | 'withdraw' }
        ->  { released: {...} | null }
   -----------------------------------------------------------------------------
   New. Which recommendations a customer is allowed to see.

   =============================================================================
   THE RULE THIS ENDPOINT EXISTS TO ENFORCE
   =============================================================================

   A RECOMMENDATION IS NOT ADVICE UNTIL A REPRESENTATIVE DECIDES IT IS.

   The shortlist is computed - fit scores, gap arithmetic, comparisons against the
   other options. Computed output on a customer's screen, unreviewed, is a machine
   advising on insurance in a licensed human's name. So the representative
   releases one, and a customer only ever reads what was released.

   A CUSTOMER CANNOT RELEASE ANYTHING TO THEMSELVES. That is the whole point, so
   it is checked here and not merely hidden in the interface: POST is refused for
   any role that is not 'fr'.

   A REPRESENTATIVE CAN ONLY RELEASE TO THEIR OWN CUSTOMER. Checked against
   people.rep_id, the same rule the documents endpoints use.

   See the note above rec_releases in db/schema.sql for why a withdrawal is a
   timestamp rather than a delete.
   ============================================================================= */

import { audit, requireLogin } from '../_lib/auth.js';
import { all, column, one, q, type Row } from '../_lib/db.js';
import { defineHandler, fail, ok } from '../_lib/http.js';

interface ReleaseRow extends Row {
    id: number;
    customer_person_id: string;
    rec_id: string;
    product_id: string;
    product_name: string;
    note: string | null;
    released_by: number | null;
    released_at: unknown;
    withdrawn_at: unknown;
}

function view(row: ReleaseRow) {
    return {
        id: Number(row.id),
        recId: row.rec_id,
        productId: row.product_id,
        productName: row.product_name,
        note: row.note,
        at: row.released_at,
        withdrawnAt: row.withdrawn_at
    };
}

export default defineHandler(async (req) => {
    const user = await requireLogin(req);

    if (user.role === 'admin') {
        fail(403,
            'Administrators do not review recommendations. That is between a ' +
            'customer and the representative advising them.');
    }

    const method = req.raw.method ?? 'GET';

    /* ---------------------------------------------------------------- reading */
    if (method === 'GET') {
        const asked = req.query('person');
        const personId = asked === '' ? user.person_id : asked;

        if (personId !== user.person_id) {
            const mine = user.role === 'fr' && await column<number>(
                'SELECT 1 FROM people WHERE id = ? AND rep_id = ?',
                [personId, user.person_id]
            ) !== null;

            if (!mine) {
                fail(404, 'There are no recommendations to show for that person.');
            }
        }

        /* A CUSTOMER NEVER SEES A WITHDRAWN ROW. A representative does, because
           "I showed this and then took it back" is something they need to remember
           having done. Same table, two different truths, and the difference is
           whose screen it is. */
        const rows = user.role === 'fr'
            ? await all<ReleaseRow>(
                `SELECT * FROM rec_releases
                  WHERE customer_person_id = ?
                  ORDER BY released_at DESC`,
                [personId])

            : await all<ReleaseRow>(
                `SELECT * FROM rec_releases
                  WHERE customer_person_id = ?
                    AND withdrawn_at IS NULL
                  ORDER BY released_at DESC`,
                [personId]);

        return ok({
            personId,
            released: rows.map(view),

            /* So the interface can show the control rather than guessing at the
               rule. The server still checks on the way in. */
            canRelease: user.role === 'fr'
        });
    }

    if (method !== 'POST') {
        fail(405, 'Use GET to read released recommendations or POST to change one.');
    }

    /* -------------------------------------------------------------- releasing */
    if (user.role !== 'fr') {
        fail(403,
            'Only your representative can release a recommendation. This is what ' +
            'stops an automatically generated shortlist reaching you as advice ' +
            'before a licensed person has read it.');
    }

    const personId = String(req.body.person ?? req.body.personId ?? '').trim();
    const recId = String(req.body.recId ?? '').trim();
    const action = String(req.body.action ?? 'release').trim();

    if (personId === '') { fail(400, 'Say which customer.', 'person'); }
    if (recId === '') { fail(400, 'Say which recommendation.', 'recId'); }

    const isMine = await column<number>(
        'SELECT 1 FROM people WHERE id = ? AND kind = \'customer\' AND rep_id = ?',
        [personId, user.person_id]
    );

    if (isMine === null) {
        /* 404 rather than 403, so this cannot be used to find out who somebody
           else's customers are. */
        fail(404, 'That customer could not be found.');
    }

    /* ---- taking one back ---- */
    if (action === 'withdraw') {
        const updated = await one<ReleaseRow>(
            `UPDATE rec_releases
                SET withdrawn_at = now()
              WHERE customer_person_id = ? AND rec_id = ?
              RETURNING *`,
            [personId, recId]
        );

        if (!updated) {
            fail(404, 'That recommendation was not released, so there is nothing to withdraw.');
        }

        await audit(user.id, 'rec_withdrawn',
            `person=${personId} rec=${recId}`, req.ip);

        return ok({ released: view(updated) });
    }

    if (action !== 'release') {
        fail(400, 'A recommendation can be released or withdrawn.');
    }

    const productId = String(req.body.productId ?? '').trim();
    const productName = String(req.body.productName ?? '').trim();
    const note = String(req.body.note ?? '').trim();

    if (productId === '' || productName === '') {
        fail(400, 'Say which product the recommendation is for.', 'productId');
    }

    /* THE NOTE IS REQUIRED, and that is deliberate rather than fussy.

       Releasing with one click and no words would make this a rubber stamp on
       generated text - which is the thing the whole feature exists to prevent. A
       sentence in the representative's own words is the human judgement, and it is
       what the customer reads first. */
    if (note.length < 15) {
        fail(400,
            'Add a line in your own words about why you are recommending this. The ' +
            'customer reads it before anything the assistant wrote.',
            'note');
    }

    /* Releasing again updates the note and CLEARS any previous withdrawal, so
       changing your mind twice does not leave a row that is both released and
       withdrawn. */
    const released = await one<ReleaseRow>(
        `INSERT INTO rec_releases
             (customer_person_id, rec_id, product_id, product_name, note, released_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (customer_person_id, rec_id) DO UPDATE
            SET note         = EXCLUDED.note,
                product_id   = EXCLUDED.product_id,
                product_name = EXCLUDED.product_name,
                released_by  = EXCLUDED.released_by,
                released_at  = now(),
                withdrawn_at = NULL
         RETURNING *`,
        [personId, recId, productId, productName.slice(0, 120),
            note.slice(0, 2000), user.id]
    );

    if (!released) {
        fail(500, 'That recommendation could not be released. Please try again.');
    }

    await audit(user.id, 'rec_released',
        `person=${personId} rec=${recId} product=${productId}`, req.ip);

    return ok({ released: view(released) });
});
