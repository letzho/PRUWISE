/* =============================================================================
   documents.ts - files the assistant has read
   -----------------------------------------------------------------------------
   New. There was no PHP equivalent.

   A customer uploads a payslip, a policy schedule from another insurer, or a CPF
   statement. The text is extracted (_lib/extract.ts), a neutral description is
   stored, and the representative can read both. The point is that the
   representative walks into the meeting already knowing what is in the file.

   =============================================================================
   WHAT THE MODEL IS AND IS NOT ALLOWED TO DO HERE
   =============================================================================

   This is the feature where the boundary in _lib/openai.ts is easiest to get
   wrong, because a model handed a payslip and a policy schedule will very happily
   write "you are under-insured by $200,000 and should consider a term plan". That
   sentence is investment advice, it is unlicensed, and it is in writing.

   So the split is:

     THE MODEL DESCRIBES.   What kind of document this is, what it appears to
                            cover, what a person might want to ask about it.

     THE RULES EXTRACT.     Every figure shown to anybody comes out of
                            findFigures() below - a regular expression over the
                            document's own text. The model is never asked for a
                            number and a number it volunteered would not be
                            displayed.

     THE REPRESENTATIVE     Nothing here recommends anything. The questions are
     DECIDES.               written FOR the customer TO ASK, which is the opposite
                            direction from advice.

   The stored summary is deliberately the same words for both sides. A customer and
   their representative reading different descriptions of the same document is how
   a conversation goes wrong.
   ============================================================================= */

import { all, column, one, q, type Row } from './db.js';
import { extractText } from './extract.js';
import { storeUpload } from './files.js';
import { chatComplete, takeAllowance, tidyModelText } from './openai.js';
import type { User } from './auth.js';
import { fail } from './http.js';

export const DOCUMENT_KINDS = ['policy', 'payslip', 'statement', 'id', 'other'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];

/* How much of the document the model is shown. Well under the 8000-character clamp
   in chatComplete, because a summary of the first few pages is what is wanted and
   sending forty pages costs forty pages. */
const PROMPT_CHARS = 6000;

export interface DocumentRow extends Row {
    id: number;
    person_id: string;
    uploaded_by: number | null;
    attachment_id: number | null;
    thread_id: number | null;
    original_name: string;
    stored_url: string;
    mime: string;
    size_bytes: number;
    kind: DocumentKind;
    extracted_text: string | null;
    ai_summary: string | null;
    ai_notes: DocumentNotes | null;
    status: 'pending' | 'ready' | 'failed';
    error: string | null;
    created_at: unknown;
    updated_at: unknown;
}

export interface DocumentNotes {
    /* What the document contains, in plain sentences. */
    points: string[];

    /* Things worth asking a representative about. Questions, never instructions. */
    questions: string[];

    /* Monetary amounts and dates found IN THE TEXT by findFigures(), quoted as they
       appear. Never anything the model produced. */
    figures: string[];

    /* Whether the wording came from the model or from the built-in rules, so the
       screen can say so rather than implying more intelligence than was used. */
    source: 'openai' | 'rules';
}


/* =============================================================================
   WHAT KIND OF DOCUMENT IS THIS?

   Keyword rules, not the model. Two reasons: the answer decides which icon and
   label the screen shows, so it must exist with no key configured; and `kind` is a
   CHECK-constrained column, so a model inventing 'insurance_policy' would fail the
   insert rather than degrade gracefully.
   ============================================================================= */

export function classifyKind(name: string, text: string | null): DocumentKind {
    const haystack = `${name}\n${(text ?? '').slice(0, 4000)}`.toLowerCase();

    const score = (...words: string[]): number =>
        words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);

    const scores: Array<[DocumentKind, number]> = [
        ['policy', score('policy number', 'sum assured', 'policyholder', 'premium',
            'certificate of insurance', 'schedule of benefits', 'prushield',
            'life assured', 'coverage', 'insurer')],

        ['payslip', score('payslip', 'pay slip', 'salary', 'gross pay', 'net pay',
            'basic pay', 'employer', 'employee', 'deductions', 'cpf contribution')],

        ['statement', score('statement', 'account balance', 'closing balance',
            'transaction', 'cpf', 'opening balance', 'interest earned',
            'contribution history')],

        ['id', score('nric', 'identity card', 'passport', 'date of birth',
            'identification no', 'fin no')]
    ];

    const best = scores.reduce((winner, entry) => entry[1] > winner[1] ? entry : winner,
        ['other', 0] as [DocumentKind, number]);

    /* Two independent hits before claiming a type. One word is a coincidence - the
       word "premium" appears in plenty of things that are not a policy. */
    return best[1] >= 2 ? best[0] : 'other';
}


/* =============================================================================
   FIGURES, PULLED OUT BY REGEX AND NOT BY THE MODEL

   This is where the "never state a figure that is not in the context" rule is
   actually enforced rather than merely requested. Everything returned here is a
   substring of the document.
   ============================================================================= */

export function findFigures(text: string | null): string[] {
    if (text === null) { return []; }

    const seen = new Set<string>();
    const out: string[] = [];

    /* An optional currency word or symbol, then an amount with thousands separators
       and optional cents. Requires either a currency marker or a decimal part, so
       that a policy number, a year or a phone number is not read as money. */
    const money = /(?:(?:S\$|US\$|SGD|USD|RM|\$|£|€)\s?)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)|(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/gi;

    for (const match of text.matchAll(money)) {
        const value = match[0].trim().replace(/\s+/g, ' ');

        /* Below a hundred it is far more likely a quantity, a page number or a
           percentage than an amount worth surfacing. */
        const numeric = Number((match[1] ?? match[2] ?? '').replace(/,/g, ''));
        if (!Number.isFinite(numeric) || numeric < 100) { continue; }

        if (!seen.has(value)) {
            seen.add(value);
            out.push(value);
        }
        if (out.length >= 12) { break; }
    }

    return out;
}


/* =============================================================================
   THE DESCRIPTION

   Returns the summary and the notes. Works with no key: the rules produce a
   shorter, blunter version of the same thing rather than nothing at all, which is
   the same instant-then-better arrangement /api/suggest-reply uses.
   ============================================================================= */

export async function describe(
    accountId: number,
    name: string,
    kind: DocumentKind,
    text: string | null
): Promise<{ summary: string; notes: DocumentNotes }> {
    const figures = findFigures(text);
    const fallback = describeByRules(name, kind, text, figures);

    if (text === null || text.length < 40) { return fallback; }

    const allowance = await takeAllowance(accountId, 'document');
    if (!allowance.allowed) { return fallback; }

    const answer = await chatComplete({
        system: [
            'You are describing a document a customer uploaded to an insurance app, so',
            'that they and their licensed representative both know what is in it.',
            '',
            'Reply in exactly this shape and nothing else:',
            'SUMMARY: two or three sentences saying what this document is and what it',
            'appears to cover.',
            'POINTS:',
            '- up to four short lines, each a fact stated in the document',
            'QUESTIONS:',
            '- up to three short questions the CUSTOMER could ask THEIR REPRESENTATIVE',
            '  about this document',
            '',
            'Hard rules for this task specifically:',
            '- Do NOT say whether the cover is enough, too much, good value or poor value.',
            '- Do NOT suggest buying, changing, cancelling or topping up anything.',
            '- Do NOT repeat monetary amounts. They are shown separately from the',
            '  document itself, so a figure from you would be a second, unverified copy.',
            '- Describe only what the text says. If it is unclear what the document is,',
            '  say that it is unclear.'
        ].join('\n'),

        user: `File name: ${name}\n\nDocument text:\n${text.slice(0, PROMPT_CHARS)}`,
        maxTokens: 500,
        temperature: 0.2
    });

    if (answer === null) { return fallback; }

    const parsed = parseDescription(tidyModelText(answer));

    /* An answer that came back in the wrong shape is not worth showing. The rules
       version is already correct, so fall back rather than display a fragment. */
    if (parsed.summary === '') { return fallback; }

    return {
        summary: parsed.summary,
        notes: {
            points: parsed.points.length > 0 ? parsed.points : fallback.notes.points,
            questions: parsed.questions.length > 0 ? parsed.questions : fallback.notes.questions,
            figures,
            source: 'openai'
        }
    };
}

function parseDescription(text: string): {
    summary: string; points: string[]; questions: string[];
} {
    const summary = /SUMMARY:\s*([\s\S]*?)(?=\nPOINTS:|\nQUESTIONS:|$)/i.exec(text);
    const points = /POINTS:\s*([\s\S]*?)(?=\nQUESTIONS:|$)/i.exec(text);
    const questions = /QUESTIONS:\s*([\s\S]*)$/i.exec(text);

    const lines = (block: string | undefined): string[] =>
        (block ?? '')
            .split('\n')
            .map((line) => line.replace(/^\s*[-*\d.)\s]+/, '').trim())
            .filter((line) => line.length > 3)
            .slice(0, 4);

    return {
        summary: (summary?.[1] ?? '').trim().replace(/\s*\n\s*/g, ' ').slice(0, 700),
        points: lines(points?.[1]),
        questions: lines(questions?.[1])
    };
}

/* The no-key version. Says less, and everything it says is true. */
function describeByRules(
    name: string,
    kind: DocumentKind,
    text: string | null,
    figures: string[]
): { summary: string; notes: DocumentNotes } {
    const labels: Record<DocumentKind, string> = {
        policy: 'an insurance policy or benefits schedule',
        payslip: 'a payslip or salary statement',
        statement: 'an account or contribution statement',
        id: 'an identity document',
        other: 'a document'
    };

    const questions: Record<DocumentKind, string[]> = {
        policy: [
            'What exactly does this policy cover, and what does it exclude?',
            'How does this sit alongside the cover I already have with you?',
            'When does this policy need to be renewed or reviewed?'
        ],
        payslip: [
            'Does this change the income figure on my record?',
            'How much of my income would need replacing if I could not work?'
        ],
        statement: [
            'Does anything in this statement change my plan?',
            'Which of these balances should I be counting as savings?'
        ],
        id: [
            'Is this the identification you needed from me?'
        ],
        other: [
            'Is this the document you were expecting?',
            'Is there anything in here we should talk about?'
        ]
    };

    const words = text === null ? 0 : text.split(/\s+/).filter(Boolean).length;

    const summary = text === null
        ? `${name} was uploaded. Its text could not be read automatically, so your ` +
          'representative will look at it directly.'

        : `This looks like ${labels[kind]}. It contains about ${words} words` +
          (figures.length > 0
              ? ` and ${figures.length} amount${figures.length === 1 ? '' : 's'}.`
              : '.') +
          ' Your representative will confirm what it means for your cover.';

    const points: string[] = [];

    if (text !== null) {
        /* The first substantial line of a document is nearly always its title, and
           showing it makes the entry recognisable in a list. */
        const heading = text
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length >= 8 && line.length <= 120);

        if (heading !== undefined) { points.push(heading); }
    }

    return {
        summary,
        notes: {
            points,
            questions: questions[kind],
            figures,
            source: 'rules'
        }
    };
}


/* =============================================================================
   TAKING ONE IN

   The bytes go through storeUpload, exactly as a chat attachment does, so there is
   one storage path and one set of upload defences. See the note above
   documents.attachment_id in db/schema.sql.
   ============================================================================= */

export interface NewDocument {
    personId: string;
    accountId: number;
    bytes: Buffer;
    name: string;
    claimedType: string;
    kind?: string;
    threadId?: number | null;
}

export async function createDocument(input: NewDocument): Promise<DocumentRow> {
    const stored = await storeUpload(input.accountId, input.bytes, input.name,
        input.claimedType);

    const extraction = extractText(input.bytes, stored.type);

    const kind = isKind(input.kind)
        ? input.kind
        : classifyKind(stored.name, extraction.text);

    /* A row exists whatever happened, including when nothing could be read.

       An upload that vanishes because the parser did not like it is the worst
       outcome here: the person is left unsure whether it arrived, and their
       representative never learns a file was sent. So a failure is RECORDED, with
       the reason, and the original stays downloadable. */
    const created = await one<{ id: number }>(
        `INSERT INTO documents
             (person_id, uploaded_by, attachment_id, thread_id, original_name,
              stored_url, mime, size_bytes, kind, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         RETURNING id`,
        [input.personId, input.accountId, stored.attachmentId,
            input.threadId ?? null, stored.name, `/api/file?id=${stored.attachmentId}`,
            stored.type, stored.size, kind]
    );

    if (!created) {
        fail(500, 'That document could not be recorded. Please try again.');
    }

    const id = Number(created.id);

    if (extraction.text === null) {
        await q(
            `UPDATE documents
                SET status = 'failed', error = ?, ai_summary = ?, ai_notes = ?
              WHERE id = ?`,
            [extraction.reason.slice(0, 255),

                extraction.notTextual
                    ? `${stored.name} was uploaded. ${extraction.reason}`
                    : `${stored.name} was uploaded but could not be read automatically.`,

                JSON.stringify({
                    points: [], questions: [], figures: [], source: 'rules'
                } satisfies DocumentNotes),
                id]
        );

    } else {
        const described = await describe(input.accountId, stored.name, kind,
            extraction.text);

        await q(
            `UPDATE documents
                SET status = 'ready', extracted_text = ?, ai_summary = ?, ai_notes = ?
              WHERE id = ?`,
            [extraction.text, described.summary, JSON.stringify(described.notes), id]
        );
    }

    const row = await documentById(id);

    if (row === null) {
        fail(500, 'That document was saved but could not be read back.');
    }

    return row;
}

function isKind(value: unknown): value is DocumentKind {
    return typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);
}


/* =============================================================================
   READING THEM BACK
   ============================================================================= */

/* The list deliberately does NOT select extracted_text. A page showing twenty
   documents would otherwise transfer a megabyte of text nothing on it displays. */
const LIST_COLUMNS = `
    d.id, d.person_id, d.uploaded_by, d.attachment_id, d.thread_id,
    d.original_name, d.stored_url, d.mime, d.size_bytes, d.kind,
    d.ai_summary, d.ai_notes, d.status, d.error, d.created_at, d.updated_at`;

export async function listDocuments(personId: string): Promise<DocumentRow[]> {
    return all<DocumentRow>(
        `SELECT ${LIST_COLUMNS}
           FROM documents d
          WHERE d.person_id = ?
          ORDER BY d.created_at DESC
          LIMIT 200`,
        [personId]
    );
}

export async function documentById(id: number): Promise<DocumentRow | null> {
    return one<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
}

/* THE ONE STATEMENT OF WHO MAY SEE A DOCUMENT.

   Mirrored in SQL by backsAReadableDocument() in _lib/files.ts, which guards the
   bytes rather than the row. Both are covered by the smoke test.

   An administrator is absent on purpose: they manage accounts, not the contents of
   somebody's payslip. */
export async function mayReadDocument(user: User, document: DocumentRow): Promise<boolean> {
    if (user.role === 'admin') { return false; }

    if (document.person_id === user.person_id) { return true; }

    if (user.role !== 'fr') { return false; }

    const isMyCustomer = await column<number>(
        'SELECT 1 FROM people WHERE id = ? AND rep_id = ?',
        [document.person_id, user.person_id]
    );

    return isMyCustomer !== null;
}

/* Only the uploader, or the person the document is about, can delete one. A
   representative can read a customer's document and cannot destroy it - the
   customer's own record is not the representative's to edit. */
export function mayDeleteDocument(user: User, document: DocumentRow): boolean {
    return document.person_id === user.person_id
        || Number(document.uploaded_by) === user.id;
}

export async function deleteDocument(id: number): Promise<void> {
    /* The attachments row is left behind on purpose. sweepOrphans picks it up two
       hours later along with its bytes, in whichever store they are in, and doing it
       there means the Blob delete is retried by a later sweep if it fails now. */
    await q('DELETE FROM documents WHERE id = ?', [id]);
}


/* =============================================================================
   WHAT A CONVERSATION HAS FILES ABOUT

   Used by /api/suggest-reply so that a representative answering "here is my
   payslip" gets drafts that mention what the payslip actually said, rather than
   drafts about a file they have not opened.

   Summaries only, never the extracted text. A reply suggestion needs to know the
   document is a payslip showing a salary; it does not need six pages of it in the
   prompt.
   ============================================================================= */

export async function documentContextForThread(threadId: number): Promise<string> {
    const rows = await all<{ original_name: string; kind: string; ai_summary: string | null }>(
        `SELECT original_name, kind, ai_summary
           FROM documents
          WHERE thread_id = ?
            AND status = 'ready'
          ORDER BY created_at DESC
          LIMIT 3`,
        [threadId]
    );

    if (rows.length === 0) { return ''; }

    return `\nFiles shared in this conversation:\n${rows
        .map((row) => `- ${row.original_name} (${row.kind}): ${row.ai_summary ?? 'not yet read'}`)
        .join('\n')}\n`;
}


/* =============================================================================
   THE SHAPE THE BROWSER GETS

   extracted_text is NOT included. It is the raw contents of somebody's payslip;
   the page displays the summary, and shipping the full text to every list render
   would put it in the browser cache and the network log for no benefit.
   ============================================================================= */

export interface DocumentView {
    id: number;
    name: string;
    kind: DocumentKind;
    mime: string;
    size: number;
    status: string;
    error: string | null;
    summary: string | null;
    notes: DocumentNotes;
    url: string | null;
    threadId: number | null;
    mine: boolean;
    at: unknown;
}

export function documentView(document: DocumentRow, user: User): DocumentView {
    const notes: DocumentNotes = document.ai_notes ?? {
        points: [], questions: [], figures: [], source: 'rules'
    };

    return {
        id: Number(document.id),
        name: document.original_name,
        kind: document.kind,
        mime: document.mime,
        size: Number(document.size_bytes),
        status: document.status,
        error: document.error,
        summary: document.ai_summary,

        notes: {
            points: Array.isArray(notes.points) ? notes.points : [],
            questions: Array.isArray(notes.questions) ? notes.questions : [],
            figures: Array.isArray(notes.figures) ? notes.figures : [],
            source: notes.source === 'openai' ? 'openai' : 'rules'
        },

        /* Null when the bytes have gone - a document whose attachment was swept or
           whose upload failed halfway. The page then shows the summary without a
           download button, rather than a button that 404s. */
        url: document.attachment_id === null
            ? null
            : `/api/file?id=${Number(document.attachment_id)}`,

        threadId: document.thread_id === null ? null : Number(document.thread_id),
        mine: Number(document.uploaded_by) === user.id,
        at: document.created_at
    };
}
