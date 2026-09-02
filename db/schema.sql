/* =============================================================================
   PRUWise - Postgres schema (Neon)
   -----------------------------------------------------------------------------
   One file, not a schema plus nine migrations.

   The MySQL side needed migration history because real databases already
   existed and had to be moved forward without losing anything. A fresh Neon
   database has no history to respect, so this is the final shape of all 26
   tables folded together. The old MySQL files stay in the sql folder as the
   reference this was translated from.

   NOTE ON COMMENTS IN THIS FILE: Postgres NESTS block comments, unlike C or
   JavaScript. A slash-star sequence inside a comment opens a second one that
   also has to be closed, so writing a glob like the sql folder's file pattern
   inline silently breaks everything after it. That mistake stopped
   touch_updated_at() being created and took ten triggers down with it.

   Safe to run repeatedly: everything is IF NOT EXISTS or ON CONFLICT DO NOTHING.

   =============================================================================
   WHAT CHANGED IN TRANSLATION, AND WHY
   =============================================================================

   ENUM(...) -> TEXT + CHECK (x IN (...))
       Postgres has real enum types, but adding a value to one needs ALTER TYPE
       and they are awkward to change. A CHECK constraint is the same guarantee
       and can be replaced in one statement.

       This also removes a genuine MySQL footgun. sql/schema.sql warns, above
       call_signals.kind, that "an ENUM silently stores '' for a value it does
       not recognise, so a missing entry here does not fail loudly". A CHECK
       constraint rejects the row instead, which is what should have happened.

   TINYINT(1) -> BOOLEAN
       MySQL had no boolean, so the PHP read these back as 0/1 and compared with
       (int) casts everywhere. Postgres has the real type, and the driver hands
       JavaScript true/false.

   DATETIME -> TIMESTAMPTZ
       Every timestamp in the PHP was UTC by convention, written with
       UTC_TIMESTAMP() and converted on the way out by to_iso(). TIMESTAMPTZ
       makes that explicit rather than conventional, and the driver returns Date
       objects, so the convention can no longer be broken by forgetting.

       DATE columns stay DATE - client_since and the policy dates are days, not
       instants. That distinction is deliberate; see db/schema notes on policies.

   AUTO_INCREMENT -> GENERATED ALWAYS AS IDENTITY
       The standard spelling. ALWAYS rather than BY DEFAULT so nothing can insert
       an explicit id and desynchronise the sequence.

   UNSIGNED -> dropped
       Postgres has no unsigned integers. Where the range mattered the type went
       up a size; where a negative value would be nonsense there is a CHECK.

   ON UPDATE CURRENT_TIMESTAMP -> a trigger
       Postgres has no column-level equivalent. One shared trigger function is
       attached to each table that had it, which keeps the behaviour identical.

   KEY ... -> CREATE INDEX
       Inline index declarations are MySQL-only.
   ============================================================================= */


/* -----------------------------------------------------------------------------
   The updated_at trigger.

   Ten tables had ON UPDATE CURRENT_TIMESTAMP. One function, attached ten times,
   rather than ten copies of the same three lines.
   ----------------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


/* =============================================================================
   1. PEOPLE

   Representatives, customers and admins in one table, because a message, an
   appointment and a call all just need "a person" and one table keeps those
   foreign keys simple.

   rep_id is the customer's assigned representative, NULL for staff and NULL for
   a customer nobody has accepted yet. That NULL is a supported state, not a gap:
   it is set in exactly one place, when a representative accepts a consultation
   request.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS people (
    id            VARCHAR(24)  PRIMARY KEY,
    kind          TEXT         NOT NULL CHECK (kind IN ('fr','customer','admin')),
    name          VARCHAR(120) NOT NULL,
    first_name    VARCHAR(60),
    salutation    VARCHAR(12),
    email         VARCHAR(190) NOT NULL,
    phone         VARCHAR(40),
    rep_id        VARCHAR(24)  REFERENCES people (id) ON DELETE SET NULL,
    segment       VARCHAR(60),
    client_since  DATE,
    status        VARCHAR(30)  NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_people_kind ON people (kind);
CREATE INDEX IF NOT EXISTS idx_people_rep  ON people (rep_id);


/* =============================================================================
   2. ACCOUNTS - anything that can log in

   password_hash holds a bcrypt hash. The PHP wrote these with password_hash(),
   which produces the $2y$ prefix; bcryptjs reads $2y$ perfectly well once the
   prefix is normalised, so EXISTING PASSWORDS SURVIVE THE MIGRATION. See
   verifyPassword() in api/_lib/auth.ts.

   session_epoch is "sign out everywhere". Every session records the epoch it
   started with; bump this and every existing session stops matching.

   Only 'customer' can ever be self-registered - api/register.ts hard-codes it,
   so no amount of tampering with the request body can create staff access.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id       VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    role            TEXT         NOT NULL CHECK (role IN ('fr','customer','admin')),
    username        VARCHAR(60)  NOT NULL UNIQUE,
    email           VARCHAR(190) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,

    /* Google's 'sub' claim - a permanent opaque id for a Google account.

       DO NOT MATCH RETURNING USERS ON EMAIL INSTEAD. People change the address
       on a Google account, and a released address can later belong to somebody
       else, which would hand the new owner the old owner's account. Email is how
       a Google login is LINKED to an existing password account the first time;
       this is how they are recognised every time after.

       Nullable and UNIQUE with the default NULLS DISTINCT, so the many password
       accounts with no Google link do not collide with each other. */
    google_sub      VARCHAR(40)  UNIQUE,

    name            VARCHAR(120) NOT NULL,
    label           VARCHAR(60),
    note            VARCHAR(120),
    status          TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','suspended')),
    email_verified  BOOLEAN      NOT NULL DEFAULT false,
    onboarding_seen BOOLEAN      NOT NULL DEFAULT false,
    session_epoch   INTEGER      NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_accounts_person ON accounts (person_id);

DROP TRIGGER IF EXISTS trg_accounts_touch ON accounts;
CREATE TRIGGER trg_accounts_touch BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


CREATE TABLE IF NOT EXISTS account_prefs (
    account_id          INTEGER     PRIMARY KEY
                                    REFERENCES accounts (id) ON DELETE CASCADE,
    theme               TEXT        NOT NULL DEFAULT 'system'
                                    CHECK (theme IN ('light','dark','system')),
    email_notifications BOOLEAN     NOT NULL DEFAULT true,
    sms_notifications   BOOLEAN     NOT NULL DEFAULT false,
    speech_enabled      BOOLEAN     NOT NULL DEFAULT false,
    speech_voice        VARCHAR(120),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_prefs_touch ON account_prefs;
CREATE TRIGGER trg_prefs_touch BEFORE UPDATE ON account_prefs
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* =============================================================================
   3. SESSIONS - new, and the one table with no MySQL counterpart

   PHP had $_SESSION: a cookie plus a file on the server. Serverless has no such
   thing. Each request may land on a different machine with no shared disk, so
   the session has to live in the database.

   WHY AN OPAQUE TOKEN AND NOT A JWT. A JWT cannot be revoked without keeping a
   denylist, which is a table - so it would be this table plus signature
   verification, for no gain. A random token looked up in Postgres logs out
   instantly, supports "sign out everywhere" through session_epoch, and lets the
   idle timeout be enforced server-side rather than only in js/app.js.

   ONLY THE HASH IS STORED, for the same reason as password_resets: anybody who
   reads this table must not be able to use what they find.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS sessions (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id    INTEGER     NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    token_hash    VARCHAR(64) NOT NULL UNIQUE,

    /* The epoch this session was created under. Compared with accounts.
       session_epoch on every request; a mismatch means it has been revoked. */
    session_epoch INTEGER     NOT NULL,

    /* Re-stamped on each request, so the 20-minute idle rule is enforced by the
       server instead of trusted from the browser. */
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    user_agent    VARCHAR(255),
    ip            VARCHAR(45),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_session_expiry  ON sessions (expires_at);


/* =============================================================================
   4. PASSWORD RESETS AND EMAIL CHANGES

   The token goes in an email, so only a SHA-256 of it is stored - the same
   reasoning as never storing a password. On the way back in, the token from the
   URL is hashed and looked up.

   used_at makes a token single-use; expires_at makes it short-lived. Neither an
   expired nor a used token can do anything, so old rows are harmless.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER     NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    request_ip VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reset_account ON password_resets (account_id);


/* An email change is verified by emailing the NEW address and only moving it
   across once the link is clicked. Otherwise a typo, or somebody on a borrowed
   laptop, could lock the real owner out. */
CREATE TABLE IF NOT EXISTS email_change_requests (
    id         INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    new_email  VARCHAR(190) NOT NULL,
    token_hash VARCHAR(64)  NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ  NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emailchange_account ON email_change_requests (account_id);


/* =============================================================================
   5. LOGIN ATTEMPTS AND AUDIT

   Every attempt is recorded, successful or not, and the recent failures are
   counted per username and per IP. Without this a public login form is a free
   password-guessing service.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   VARCHAR(60) NOT NULL,
    ip         VARCHAR(45),
    succeeded  BOOLEAN     NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempt_user_time ON login_attempts (username, created_at);
CREATE INDEX IF NOT EXISTS idx_attempt_ip_time   ON login_attempts (ip, created_at);


/* Security-relevant events, so there is an answer to when an email last changed.
   Deliberately never stores the values themselves. */
CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER     REFERENCES accounts (id) ON DELETE SET NULL,
    action     VARCHAR(60) NOT NULL,
    detail     VARCHAR(255),
    ip         VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log (account_id, created_at);


/* =============================================================================
   6. CONVERSATIONS

   A conversation between a representative and a customer is ONE row. The
   representative opens it and sees the customer's name; the customer opens it
   and sees the representative's. Same row, same messages, both sides in sync.

       kind='human'  fr_person_id + customer_person_id set, owner_account_id NULL
       kind='ai'     owner_account_id set - a PRUWise conversation is private to
                     one account. customer_person_id records WHO is being
                     discussed, so a representative's PRUWise thread about Sarah
                     is separate from the one about Daniel.

   NULLS NOT DISTINCT IS A DELIBERATE UPGRADE, NOT A TRANSLATION.

   In MySQL this key never actually worked. A UNIQUE index treats NULLs as
   distinct, so for kind='ai' - where fr_person_id is NULL - the constraint did
   not apply at all and duplicate PRUWise threads were possible. The INSERT
   IGNORE that relied on it was quietly doing nothing.

   Postgres 15+ can treat NULLs as equal for uniqueness, which is what this
   constraint was always meant to say. It also makes ON CONFLICT DO NOTHING - the
   replacement for INSERT IGNORE - behave correctly here.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS threads (
    id                 INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind               TEXT        NOT NULL CHECK (kind IN ('human','ai')),
    fr_person_id       VARCHAR(24) REFERENCES people (id) ON DELETE CASCADE,
    customer_person_id VARCHAR(24) REFERENCES people (id) ON DELETE CASCADE,
    owner_account_id   INTEGER     REFERENCES accounts (id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at    TIMESTAMPTZ,

    CONSTRAINT uq_thread_pair UNIQUE NULLS NOT DISTINCT
        (kind, fr_person_id, customer_person_id, owner_account_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_fr       ON threads (fr_person_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_thread_customer ON threads (customer_person_id, last_message_at);
CREATE INDEX IF NOT EXISTS idx_thread_owner    ON threads (owner_account_id);


/* =============================================================================
   7. MESSAGES

   sender_account_id is NULL when PRUWise or the system wrote the message, so
   sender_kind is what you branch on rather than a null check.

   payload carries the parts of a PRUWise answer plain text cannot hold: bullets,
   chips, callouts, a glossary term, a recommendation id, follow-up questions.
   The browser already has a message object with those fields, so it is stored as
   JSONB and handed straight back. Nothing in SQL reads inside it.

   client_ref is generated by the browser before sending. If the connection drops
   and it retries, the unique constraint rejects the second attempt instead of
   posting twice. Left NULLS DISTINCT on purpose - system messages have no ref
   and there will be many of them.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS messages (
    id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id         INTEGER     NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    sender_account_id INTEGER     REFERENCES accounts (id) ON DELETE SET NULL,
    sender_kind       TEXT        NOT NULL DEFAULT 'account'
                                  CHECK (sender_kind IN ('account','ai','system')),
    body              TEXT,
    payload           JSONB,
    client_ref        VARCHAR(64) UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_message_thread ON messages (thread_id, id);
CREATE INDEX IF NOT EXISTS idx_message_unread ON messages (thread_id, read_at);

/* -----------------------------------------------------------------------------
   EDITING AND DELETING A MESSAGE - added later, hence the ALTERs

   ADD COLUMN IF NOT EXISTS rather than editing the CREATE above, because the
   CREATE is guarded by IF NOT EXISTS and therefore does nothing at all on a
   database that already has the table. A column added to the CREATE would exist
   only on a fresh install, which is the worst of the two outcomes: it works on
   your laptop and 500s in production.

   =============================================================================
   A DELETED MESSAGE LEAVES A MARK. IT DOES NOT VANISH.
   =============================================================================

   The row survives with body set to NULL and deleted_at set, and both sides see
   "This message was deleted". That is not squeamishness about data, it is the
   only honest option in a two-person conversation:

     REMOVING THE ROW WOULD REWRITE HISTORY FOR THE OTHER PERSON. They read it.
     They may have replied to it. A conversation where the other side can silently
     make things they said stop having been said is not a record of anything, and
     in a regulated advisory relationship that is a serious property to give away.

     AND A TOMBSTONE IS INFORMATION. "They deleted something here" is true, is
     visible to both, and is what every messenger people already use does.

   THE BODY IS ACTUALLY GONE, though - set to NULL, not hidden by a flag. Somebody
   who deletes a message containing their bank details has to be able to rely on
   that. What remains is that a message existed and was withdrawn.

   edited_at is NULL until the first edit, and non-null forever after. The
   interface says "edited" from it, because a silently altered message is the same
   problem as a silently deleted one in a smaller size.
   ----------------------------------------------------------------------------- */
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER
    REFERENCES accounts (id) ON DELETE SET NULL;


/* Uploaded files.

   stored_path NOW HOLDS A VERCEL BLOB URL, not a path. Serverless filesystems
   are ephemeral - anything written to disk is gone when the function instance
   is recycled - so uploads go to Blob storage and this column holds what came
   back. The column name is kept because every ported query references it.

   original_name is display only. The stored object's name is generated by the
   server, because an attacker-chosen filename is how you get path traversal. */
CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* NULL while the file is uploaded but the message has not been sent yet.
       Real chat uploads as you pick the file, not when you press send. */
    message_id    BIGINT       REFERENCES messages (id) ON DELETE CASCADE,
    uploaded_by   INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,

    original_name VARCHAR(255) NOT NULL,
    stored_path   VARCHAR(512) NOT NULL,
    mime          VARCHAR(100) NOT NULL,
    size_bytes    INTEGER      NOT NULL CHECK (size_bytes >= 0),
    is_image      BOOLEAN      NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attach_message ON attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_attach_pending ON attachments (uploaded_by, message_id);


/* The file itself, when there is nowhere else to put it.
   -----------------------------------------------------------------------------
   attachments.stored_path says WHERE the bytes are:

       'https://...'   a Vercel Blob URL. Used whenever BLOB_READ_WRITE_TOKEN is
                       configured, which is the arrangement this project wants.
       'db'            the bytes are in the row below.

   WHY THE SECOND OPTION EXISTS. A serverless filesystem is read-only, so the old
   php/uploads/ folder has no equivalent - the bytes have to go somewhere off the
   machine. Vercel Blob is that somewhere, but creating a Blob store is a manual
   step in the dashboard, and until somebody does it every upload would fail. A
   feature that is broken until an unrelated button is pressed is a feature that
   looks broken.

   So this is the fallback, and it is deliberately a SEPARATE TABLE rather than a
   column on attachments. Every listing query does SELECT ... FROM attachments to
   draw file chips in a conversation; a bytea column there would be dragged into
   Postgres's working set by all of them. Here the bytes are only ever read by
   /api/file, which asks for exactly one row.

   The 4 MB cap in _lib/files.ts is not about this table. It is the platform's
   request body limit - about 4.5 MB - so nothing larger can reach a function in
   the first place, whichever store it would end up in. */
CREATE TABLE IF NOT EXISTS attachment_bytes (
    attachment_id INTEGER PRIMARY KEY REFERENCES attachments (id) ON DELETE CASCADE,
    bytes         BYTEA   NOT NULL
);


/* One row per call to the language model, and it exists to cost money slowly.
   -----------------------------------------------------------------------------
   An OpenAI key is a spending authority. Anybody signed in can make this
   application call the model, and without a counter a single loop in somebody's
   browser - or one leaked session - runs up a bill with nothing to stop it.

   So every request is recorded here first and refused if the account has already
   had its allowance this hour. Two ceilings, because they catch different things:
   per account stops one person, and the global count stops "a hundred accounts
   each behaving reasonably" from adding up to a surprise.

   NOT A CACHE AND NOT AN AUDIT LOG. It holds no prompt and no answer - just that a
   call happened, by whom, and of what kind. A prompt contains whatever the customer
   typed about their finances, and there is no reason to keep a second copy of that
   here. Rows older than a day are swept on write. */
CREATE TABLE IF NOT EXISTS ai_usage (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER     REFERENCES accounts (id) ON DELETE CASCADE,
    kind       VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_account ON ai_usage (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_time    ON ai_usage (created_at);


/* =============================================================================
   8. APPOINTMENTS

   ics_uid is the permanent identity of the event for calendar apps. An edited
   appointment is reissued with the SAME uid and a higher sequence, so Google or
   Apple Calendar updates the existing entry instead of adding a second one.
   Change the uid and you get duplicates, which is the classic calendar bug.

   NOTE THE COLUMN NAME: rep_person_id, not fr_person_id. This table and
   consultation_requests say rep_; threads and call_sessions say fr_. They mean
   the same thing and the inconsistency is inherited. It caused a real bug - a
   query in call-join used fr_person_id against this table and threw on every
   attempt to join a call from a booked meeting.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS appointments (
    id                   VARCHAR(36)  PRIMARY KEY,
    customer_person_id   VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    rep_person_id        VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    title                VARCHAR(190) NOT NULL,
    type                 VARCHAR(60)  NOT NULL,
    mode                 TEXT         NOT NULL DEFAULT 'video'
                                      CHECK (mode IN ('video','in-person','phone')),
    start_at             TIMESTAMPTZ  NOT NULL,
    minutes              SMALLINT     NOT NULL DEFAULT 30 CHECK (minutes > 0),
    location             VARCHAR(190),
    status               TEXT         NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','confirmed','completed','cancelled')),

    /* An appointment finishes in one of two ways, and they are NOT the same:
         somebody pressed "mark as done" -> completed_by_account is set
         its end time simply passed      -> completed_by_account is NULL
       The second is a guess - it might have been a no-show - so the screen says
       "closed automatically" rather than claiming somebody confirmed it. */
    completed_at         TIMESTAMPTZ,

    /* SET NULL, not CASCADE: deleting a staff account must not delete the
       history of the meetings they held. */
    completed_by_account INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,

    agenda               JSONB,
    prepared_by          VARCHAR(60),
    notes                TEXT,
    ics_uid              VARCHAR(36)  NOT NULL UNIQUE,
    ics_sequence         INTEGER      NOT NULL DEFAULT 0,
    created_by_account   INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appt_customer ON appointments (customer_person_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appt_rep      ON appointments (rep_person_id, start_at);

DROP TRIGGER IF EXISTS trg_appt_touch ON appointments;
CREATE TRIGGER trg_appt_touch BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* A private token per account for the read-only calendar feed. Anyone holding
   the URL can read that person's appointments, so it is per-account, random and
   revocable by regenerating - never the account id in the URL.

   This feature was BROKEN on the old host: InfinityFree's bot check blocked
   inbound requests, so Google Calendar could never fetch the URL. It works here. */
CREATE TABLE IF NOT EXISTS calendar_feeds (
    account_id INTEGER     PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    token      VARCHAR(40) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


/* =============================================================================
   9. RATINGS AND REPRESENTATIVE CHANGES
   ============================================================================= */

/* One rating per customer per representative, so "update my rating" is a single
   upsert with no read-then-write race.

   Worth noting for later: nothing on the representative's side reads these back.
   Customers are rating their reps and no screen shows it to them. */
CREATE TABLE IF NOT EXISTS ratings (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    rep_person_id      VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    score              SMALLINT     NOT NULL CHECK (score BETWEEN 1 AND 5),
    highlight          VARCHAR(120),
    comment            TEXT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_rating_pair UNIQUE (customer_person_id, rep_person_id)
);

CREATE INDEX IF NOT EXISTS idx_rating_rep ON ratings (rep_person_id);

DROP TRIGGER IF EXISTS trg_rating_touch ON ratings;
CREATE TRIGGER trg_rating_touch BEFORE UPDATE ON ratings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


CREATE TABLE IF NOT EXISTS rep_change_requests (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference          VARCHAR(24)  NOT NULL UNIQUE,
    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    current_rep_id     VARCHAR(24)  NOT NULL,
    preferred_rep_id   VARCHAR(24),
    reason             VARCHAR(120) NOT NULL,
    notes              TEXT,
    status             TEXT         NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','approved','declined','withdrawn')),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_repchange_customer
    ON rep_change_requests (customer_person_id, status);


/* Every reassignment, kept as history. This is what gives the "at most one
   change in 12 months" rule something real to check. */
CREATE TABLE IF NOT EXISTS rep_assignments (
    id                 INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_person_id VARCHAR(24) NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    from_rep_id        VARCHAR(24),
    to_rep_id          VARCHAR(24) NOT NULL,
    request_id         INTEGER     REFERENCES rep_change_requests (id) ON DELETE SET NULL,
    changed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assign_customer
    ON rep_assignments (customer_person_id, changed_at);


/* =============================================================================
   10. VIDEO CALLS

   HOW TWO BROWSERS FIND EACH OTHER WITHOUT A REALTIME SERVER

   WebRTC sends video directly between browsers, but first the two sides must
   swap an offer, an answer and a list of network routes. That is signalling, and
   it normally uses a WebSocket - which needs a process running permanently.

   call_signals is a mailbox instead: each side posts its messages in and asks
   about once a second whether anything arrived. A second or two slower to
   connect, and the video itself is still direct peer-to-peer at full speed.

   That choice was made for cheap PHP hosting and it turns out to be right for
   serverless too, for the same reason: no long-lived process.

   Rows are worthless once delivered, so this table is safe to empty at any time.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS call_sessions (
    id                 INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_code          VARCHAR(12) NOT NULL UNIQUE,
    appointment_id     VARCHAR(36) REFERENCES appointments (id) ON DELETE SET NULL,
    fr_person_id       VARCHAR(24) NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    customer_person_id VARCHAR(24) NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    status             TEXT        NOT NULL DEFAULT 'waiting'
                                   CHECK (status IN ('waiting','active','ended')),

    /* JOINED is a moment; SEEN is a heartbeat. A laptop that sleeps never says
       "I left", it just stops talking - so each side re-stamps its seen_at on
       every poll and the other treats "seen recently" as present. It is also
       what decides when to place the call: no point sending an offer into an
       empty room. */
    fr_joined_at       TIMESTAMPTZ,
    fr_seen_at         TIMESTAMPTZ,
    customer_joined_at TIMESTAMPTZ,
    customer_seen_at   TIMESTAMPTZ,
    started_at         TIMESTAMPTZ,
    ended_at           TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_pair
    ON call_sessions (fr_person_id, customer_person_id, status);


CREATE TABLE IF NOT EXISTS call_signals (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_code    VARCHAR(12) NOT NULL,
    to_role      TEXT        NOT NULL CHECK (to_role   IN ('fr','customer')),
    from_role    TEXT        NOT NULL CHECK (from_role IN ('fr','customer')),

    /* 'pin' is not part of the WebRTC handshake - it is the policy drawer,
       carrying the list of policies the representative has put on the customer's
       screen. It travels here because this mailbox already delivers once a
       second and already drains itself.

       Under MySQL an ENUM silently stored '' for an unrecognised value, so a
       missing entry here failed silently and delivered an empty kind. A CHECK
       constraint rejects the row instead. */
    kind         TEXT        NOT NULL
                             CHECK (kind IN ('offer','answer','candidate','bye','pin')),
    payload      TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ
);

/* The exact query the poller runs: undelivered mail for me, in order. */
CREATE INDEX IF NOT EXISTS idx_signal_inbox
    ON call_signals (room_code, to_role, delivered_at, id);


/* The spoken transcript, so it survives the call.

   account_id is the speaker. Each browser transcribes its OWN microphone and
   posts the finished sentences, so the account that sent a line is the person who
   said it - no guessing at who is talking from one mixed stream. Both sides poll
   and see a merged log with real names.

   who='pruwise' rows are the assistant's suggestions, stored against the account
   they were shown to, and only ever returned to that account. A nudge telling a
   representative to stop pushing is not something the customer should read. */
CREATE TABLE IF NOT EXISTS call_transcripts (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    call_id    INTEGER     NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
    account_id INTEGER     REFERENCES accounts (id) ON DELETE SET NULL,
    who        TEXT        NOT NULL DEFAULT 'person'
                           CHECK (who IN ('person','pruwise')),
    text       TEXT        NOT NULL,
    client_ref VARCHAR(64) UNIQUE,
    said_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcript_call ON call_transcripts (call_id, id);


/* =============================================================================
   11. SMALL PER-ACCOUNT THINGS

   These replace localStorage keys, so they follow the person to another device
   instead of living in one browser.
   ============================================================================= */

CREATE TABLE IF NOT EXISTS saved_questions (
    id         INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    question   VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_question_account ON saved_questions (account_id, created_at);


/* Notes typed during a call. One row per account per appointment, so the
   representative's record notes and the customer's private notes never mix.

   NULLS NOT DISTINCT because appointment_id is nullable and the summary sender
   upserts on this pair. With NULLs treated as distinct, every ad-hoc call with no
   appointment would create another row instead of updating the one that exists. */
CREATE TABLE IF NOT EXISTS call_notes (
    id             INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id     INTEGER     NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    appointment_id VARCHAR(36),
    body           TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* WHAT MAKES A NOTE UNIQUE, and why it is not (account_id, appointment_id).
       -------------------------------------------------------------------------
       A second summary for the same meeting is a CORRECTION and should replace
       the note. Two ad-hoc calls with no meeting behind them are two separate
       events and must both be kept.

       MySQL got the second half right by accident: its unique keys treat NULLs as
       distinct, so rows with a NULL appointment_id simply accumulated. Postgres
       defaults the same way, and this schema originally said NULLS NOT DISTINCT to
       close what looked like a gap - which would have made every ad-hoc call
       overwrite the previous one's note. Silent data loss, in the one table that
       exists to be a record.

       So the key is explicit instead: call_key is the appointment id when there is
       one, and the room code when there is not. No NULLs are involved, so there is
       no NULL-comparison rule to get right, and both intentions hold at once. */
    call_key       VARCHAR(36),

    CONSTRAINT uq_notes_account_call UNIQUE (account_id, call_key)
);

/* Idempotent upgrade for a database created before call_key existed.
   ALTER ... IF NOT EXISTS makes the column safe to re-run; the constraint is
   dropped and re-added because ADD CONSTRAINT has no IF NOT EXISTS. */
ALTER TABLE call_notes ADD COLUMN IF NOT EXISTS call_key VARCHAR(36);

UPDATE call_notes
   SET call_key = COALESCE(appointment_id, 'legacy-' || id::text)
 WHERE call_key IS NULL;

ALTER TABLE call_notes DROP CONSTRAINT IF EXISTS uq_notes_account_appt;
ALTER TABLE call_notes DROP CONSTRAINT IF EXISTS uq_notes_account_call;
ALTER TABLE call_notes ADD  CONSTRAINT uq_notes_account_call UNIQUE (account_id, call_key);

DROP TRIGGER IF EXISTS trg_notes_touch ON call_notes;
CREATE TRIGGER trg_notes_touch BEFORE UPDATE ON call_notes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* =============================================================================
   12. THE CUSTOMER'S FINANCIAL RECORD

   What they earn, hold, owe and can afford. Entered by them in Settings, read by
   their representative, and the basis of the protection needs calculation.

   EVERY COLUMN IS NULLABLE, AND THAT IS THE POINT. NULL means "not told us",
   which is a different fact from 0. "I have no savings" and "I did not say" must
   not look the same, because one changes the recommendation and the other means
   we should not be calculating yet.

   ONE ROW PER PERSON, not per account: these are facts about a human being, and
   person_id is what the representative side already joins on.

   Whole dollars in INTEGER. Nobody enters cents for a sum assured, and binary
   floating point cannot hold 0.1.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS customer_finances (
    person_id             VARCHAR(24) PRIMARY KEY
                                      REFERENCES people (id) ON DELETE CASCADE,

    annual_income         INTEGER  CHECK (annual_income        >= 0),
    monthly_income        INTEGER  CHECK (monthly_income       >= 0),
    monthly_expenses      INTEGER  CHECK (monthly_expenses     >= 0),
    monthly_commitments   INTEGER  CHECK (monthly_commitments  >= 0),
    premium_budget        INTEGER  CHECK (premium_budget       >= 0),

    savings               INTEGER  CHECK (savings              >= 0),
    cpf                   INTEGER  CHECK (cpf                  >= 0),

    mortgage              INTEGER  CHECK (mortgage             >= 0),
    other_debt            INTEGER  CHECK (other_debt           >= 0),

    dependants            SMALLINT CHECK (dependants BETWEEN 0 AND 20),

    retire_age            SMALLINT CHECK (retire_age BETWEEN 0 AND 100),
    retire_monthly_target INTEGER  CHECK (retire_monthly_target >= 0),

    existing_life_cover   INTEGER  CHECK (existing_life_cover  >= 0),
    existing_ci_cover     INTEGER  CHECK (existing_ci_cover    >= 0),

    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_finances_touch ON customer_finances;
CREATE TRIGGER trg_finances_touch BEFORE UPDATE ON customer_finances
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* =============================================================================
   13. ONBOARDING - rep profiles, assessments, consultation requests
   ============================================================================= */

/* A representative's public profile, and the two settings that control whether
   they are offered to new customers at all.

   accepting_customers defaults true, and a MISSING ROW means available. That is
   deliberate: defaulting a representative created before this table existed to
   "not accepting" would quietly hide real staff. */
CREATE TABLE IF NOT EXISTS rep_profiles (
    person_id           VARCHAR(24)  PRIMARY KEY
                                     REFERENCES people (id) ON DELETE CASCADE,
    accepting_customers BOOLEAN      NOT NULL DEFAULT true,
    headline            VARCHAR(160),
    bio                 TEXT,
    specialisations     JSONB,
    languages           JSONB,
    years_experience    SMALLINT     CHECK (years_experience BETWEEN 0 AND 80),
    max_customers       INTEGER      CHECK (max_customers >= 0),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_repprofile_touch ON rep_profiles;
CREATE TRIGGER trg_repprofile_touch BEFORE UPDATE ON rep_profiles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* One assessment per account, overwritten on retake.

   `recommended` is stored display material - the scored product list. Note that
   nothing currently reads it back to act on it, which matters if recommendations
   are to become representative-controlled. */
CREATE TABLE IF NOT EXISTS assessments (
    id           INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   INTEGER     NOT NULL UNIQUE
                             REFERENCES accounts (id) ON DELETE CASCADE,
    answers      JSONB       NOT NULL,
    profile      JSONB       NOT NULL,
    recommended  JSONB,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_assessment_touch ON assessments;
CREATE TRIGGER trg_assessment_touch BEFORE UPDATE ON assessments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* A request, not an assignment. Nothing about the account changes until a
   representative accepts - that acceptance is the only place people.rep_id is
   ever set. */
CREATE TABLE IF NOT EXISTS consultation_requests (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    rep_person_id      VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    assessment_id      INTEGER      REFERENCES assessments (id) ON DELETE SET NULL,
    note               VARCHAR(500),
    status             TEXT         NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','accepted','declined','withdrawn')),
    decline_reason     VARCHAR(200),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_consult_rep
    ON consultation_requests (rep_person_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_consult_customer
    ON consultation_requests (customer_person_id, status);


/* =============================================================================
   14. POLICY APPLICATIONS AND ISSUED POLICIES

   An application is not a policy. It is a request that might be refused.

   Two tables rather than one status column, so that a row in `policies` ALWAYS
   means cover that really exists. Collapsing them would mean every query asking
   "what is this person covered for" had to remember to exclude the pending ones,
   and getting that wrong once tells somebody they are insured when they are not.
   The schema makes it unrepresentable instead.

   NOTHING WRITES `policies` EXCEPT THE ISSUE PATH, and that runs inside a
   transaction which also resolves the application it came from.

   THERE IS NO 'renewal-due' STATUS HERE, DELIBERATELY. It is only ever true
   relative to today, so storing it would need something waking up nightly to
   flip rows as dates pass. Vercel's Hobby plan runs cron at most once a day, and
   the old host had no reliable cron at all. So the date is stored - a fact - and
   renewal state is derived from it on every read. The only statuses in the column
   are the ones a human decided.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS policy_applications (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    /* Denormalised from people.rep_id on purpose: if the customer later moves to
       a different representative, this application was still submitted to - and
       judged by - the one named here. Reading it live would rewrite history. */
    rep_person_id      VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    /* No foreign key, because the product catalogue is not a table - it lives in
       js/data.js and is mirrored in api/_lib/products.ts so the server can name a
       product without inventing one. Validated in code on every entry point. */
    product_id         VARCHAR(24)  NOT NULL,

    /* All nullable because the shape differs by product: a disability income plan
       has a monthly benefit and no sum assured; a hospitalisation plan neither. */
    cover              INTEGER      CHECK (cover           >= 0),
    ci_cover           INTEGER      CHECK (ci_cover        >= 0),
    monthly_benefit    INTEGER      CHECK (monthly_benefit >= 0),

    premium            INTEGER      NOT NULL CHECK (premium > 0),
    term_years         SMALLINT     CHECK (term_years BETWEEN 1 AND 60),
    note               VARCHAR(500),

    status             TEXT         NOT NULL DEFAULT 'submitted'
                                    CHECK (status IN ('submitted','under_review','issued','declined','withdrawn')),
    decline_reason     VARCHAR(200),

    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_papp_rep
    ON policy_applications (rep_person_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_papp_customer
    ON policy_applications (customer_person_id, status);

DROP TRIGGER IF EXISTS trg_papp_touch ON policy_applications;
CREATE TRIGGER trg_papp_touch BEFORE UPDATE ON policy_applications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


CREATE TABLE IF NOT EXISTS policies (
    id              INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id       VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    /* SET NULL rather than CASCADE: if the application record is ever removed the
       POLICY MUST SURVIVE. Cover does not stop existing because the paperwork was
       tidied up. */
    application_id  INTEGER      REFERENCES policy_applications (id) ON DELETE SET NULL,
    product_id      VARCHAR(24)  NOT NULL,

    policy_number   VARCHAR(32)  NOT NULL UNIQUE,

    cover           INTEGER      CHECK (cover           >= 0),
    ci_cover        INTEGER      CHECK (ci_cover        >= 0),
    monthly_benefit INTEGER      CHECK (monthly_benefit >= 0),

    premium         INTEGER      NOT NULL CHECK (premium > 0),
    premium_per     TEXT         NOT NULL DEFAULT 'monthly'
                                 CHECK (premium_per IN ('monthly','yearly')),
    term_years      SMALLINT     CHECK (term_years BETWEEN 1 AND 60),
    payment_method  VARCHAR(60),

    /* A snapshot taken at issue, not a live read of the catalogue. What a policy
       covers is what was agreed when it was written - if the catalogue copy is
       reworded next month, existing policies must not silently change. */
    benefits        JSONB,

    /* DATE, not TIMESTAMPTZ. A policy starts on a day, not at 14:32:07, and
       storing a time would imply a precision the business does not have. */
    start_date      DATE         NOT NULL,
    renewal_date    DATE         NOT NULL,
    maturity_date   DATE,

    status          TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','lapsed','cancelled')),

    issued_by       VARCHAR(24)  REFERENCES people (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_person  ON policies (person_id, status);
CREATE INDEX IF NOT EXISTS idx_policy_renewal ON policies (renewal_date, status);

DROP TRIGGER IF EXISTS trg_policy_touch ON policies;
CREATE TRIGGER trg_policy_touch BEFORE UPDATE ON policies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* =============================================================================
   15. DOCUMENTS - new

   Files a customer or representative uploads for the assistant to read, kept
   separately from chat attachments because the lifecycle is different: an
   attachment belongs to a message, a document belongs to a person and is
   re-readable.

   extracted_text is what came out of the file. ai_summary and ai_notes are what
   the model made of it, stored rather than regenerated so the representative and
   the customer read the SAME words - the same reason the needs calculation lives
   on the server.

   ai_summary IS NOT ADVICE AND MUST NOT READ AS A DECISION. It summarises what
   the document contains. It does not conclude what the person should buy.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS documents (
    id             INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id      VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    uploaded_by    INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,

    /* WHERE THE BYTES ACTUALLY ARE.

       A document does not store its own bytes. It points at an attachments row,
       which already knows how to be either a Vercel Blob URL or a row in
       attachment_bytes, and which /api/file already knows how to stream with a
       permission check in front of it.

       Reusing that instead of adding document_bytes means ONE storage path to get
       right rather than two that drift. It is also what lets a file somebody
       dropped into a chat become a readable document without being uploaded twice:
       the attachment is already there, so analysing it adds a row here and no bytes
       anywhere.

       ON DELETE SET NULL, not CASCADE: if the bytes are swept away the extracted
       text and the summary are still worth keeping, and the row can say the
       original is no longer downloadable. */
    attachment_id  INTEGER      REFERENCES attachments (id) ON DELETE SET NULL,

    /* Set when the file arrived in a conversation rather than through the documents
       page. /api/suggest-reply reads it, so that a representative replying to
       "here is my payslip" gets drafts that refer to what the payslip said. */
    thread_id      INTEGER      REFERENCES threads (id) ON DELETE SET NULL,

    original_name  VARCHAR(255) NOT NULL,
    stored_url     VARCHAR(512) NOT NULL,
    mime           VARCHAR(100) NOT NULL,
    size_bytes     INTEGER      NOT NULL CHECK (size_bytes >= 0),

    kind           TEXT         NOT NULL DEFAULT 'other'
                                CHECK (kind IN ('policy','payslip','statement','id','other')),

    extracted_text TEXT,
    ai_summary     TEXT,
    ai_notes       JSONB,

    /* pending -> ready, or failed with a reason the uploader can read. Extraction
       happens in the request that receives the file; this records the outcome so a
       failure is visible rather than looking like an empty document. */
    status         TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','ready','failed')),
    error          VARCHAR(255),

    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_person ON documents (person_id, created_at);

/* Idempotent upgrade for a database created before the two link columns existed.
   Same reasoning as the call_key block above - ALTER ... IF NOT EXISTS is safe to
   re-run, and db/schema.sql is run in full on every migration. */
ALTER TABLE documents ADD COLUMN IF NOT EXISTS attachment_id INTEGER
    REFERENCES attachments (id) ON DELETE SET NULL;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS thread_id INTEGER
    REFERENCES threads (id) ON DELETE SET NULL;

/* Looking a document up BY its attachment is what /api/file does on every download
   to decide whether the reader is allowed the bytes, and what sweepOrphans does to
   avoid deleting a document's only copy. Both are on the hot path. */
CREATE INDEX IF NOT EXISTS idx_document_attachment ON documents (attachment_id);
CREATE INDEX IF NOT EXISTS idx_document_thread ON documents (thread_id, created_at);

DROP TRIGGER IF EXISTS trg_document_touch ON documents;
CREATE TRIGGER trg_document_touch BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


/* =============================================================================
   15b. RELEASED RECOMMENDATIONS - new

   WHICH RECOMMENDATIONS A CUSTOMER IS ALLOWED TO SEE.

   The product rule this exists to enforce: a recommendation is not advice until a
   licensed representative decides it is. The shortlist is generated - fit scores,
   gap arithmetic, comparisons - and a generated shortlist appearing on a
   customer's screen unreviewed would be a machine advising on insurance in a
   representative's name.

   So the representative RELEASES one, and only released rows reach the customer.

   WHAT THIS REPLACED. A "Share with customer" button that set STATE.sharedRecId
   in localStorage, showed a modal saying "Sent" and naming the customer's email
   address, and did nothing else. Per-device, invisible to the customer, and the
   confirmation was untrue. That is worse than no feature, because everyone
   involved believed it worked.

   rec_id is a catalogue identifier rather than a foreign key, because the
   shortlist itself is computed from the customer record and js/data.js rather than
   stored - see the note on assessments. What is stored here is the DECISION,
   which is the part that has to survive and be auditable.

   WITHDRAWAL IS A TIMESTAMP, NOT A DELETE. "This was shown and then taken back"
   is a materially different fact from "this was never shown", and a regulated
   conversation needs to be able to tell them apart afterwards.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS rec_releases (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    rec_id             VARCHAR(48)  NOT NULL,
    product_id         VARCHAR(48)  NOT NULL,
    product_name       VARCHAR(120) NOT NULL,

    /* What the representative wants the customer to read first. Their words, not
       the model's - this is the one piece of the recommendation a human wrote. */
    note               TEXT,

    released_by        INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,
    released_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    withdrawn_at       TIMESTAMPTZ,

    /* One row per recommendation per customer. Releasing twice updates the note
       and clears any withdrawal rather than stacking duplicates. */
    CONSTRAINT uq_rec_release UNIQUE (customer_person_id, rec_id)
);

CREATE INDEX IF NOT EXISTS idx_rec_release_person
    ON rec_releases (customer_person_id, released_at);


/* =============================================================================
   15c. WHAT THE ASSISTANT NOTICED - new

   Everything the assistant works out from a conversation, a call transcript or an
   in-person meeting, waiting for a human to act on it.

   Five kinds, and they are deliberately in ONE table because they share a
   lifecycle - noticed, then confirmed or dismissed by a person - and differ only
   in what the payload means:

     detail      a personal or financial detail that appears to have changed
     support     a sign the client may need more help than usual
     followup    a commitment or loose end somebody should come back to
     meeting     they want to book something
     keypoint    a summary line from a meeting, kept as the record

   =============================================================================
   NOTHING HERE IS TRUE UNTIL A PERSON SAYS SO
   =============================================================================

   THE ASSISTANT PROPOSES. THE REPRESENTATIVE DECIDES. That is why `status`
   starts at 'open' and why a detail change writes NOTHING to customer_finances or
   people until it is confirmed - see api/_routes/insights.ts.

   The reason is not caution for its own sake. Speech recognition mishears numbers
   constantly: "ninety five thousand" and "nineteen five thousand" differ by one
   syllable, and an income silently rewritten from a mishearing would flow into the
   needs calculation, the shortfall, and every recommendation drawn from it. A wrong
   figure nobody chose is far worse than a proposal nobody actioned.

   `quote` IS THE EVIDENCE AND IS NOT OPTIONAL IN PRACTICE. It is the words that
   caused the proposal, so a representative can judge it without replaying the
   call. A proposal with no quote is unreviewable, which makes it useless.

   A CLIENT NEVER READS THE 'support' ROWS. "This person sounds distressed" is a
   note for the human advising them, not something to show the person it is about.
   The endpoint enforces that, not the interface.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS ai_insights (
    id                 INTEGER      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    customer_person_id VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    kind               TEXT         NOT NULL
                                    CHECK (kind IN ('detail','support','followup',
                                                    'meeting','keypoint')),

    /* Where it came from, so a representative can go back and read the source. */
    source             TEXT         NOT NULL DEFAULT 'chat'
                                    CHECK (source IN ('chat','call','meeting')),
    thread_id          INTEGER      REFERENCES threads (id) ON DELETE SET NULL,
    room_code          VARCHAR(12),

    /* For a 'detail': which field, what it says now, what was heard. The rest of
       the kinds leave these null and use `note`. */
    field              VARCHAR(48),
    old_value          VARCHAR(200),
    new_value          VARCHAR(200),

    note               TEXT         NOT NULL,

    /* The words that caused this. See the header - without it nobody can judge
       the proposal. */
    quote              TEXT,

    /* 'rules' or 'openai', so a screen can say which produced it rather than
       implying more intelligence than was used. */
    engine             TEXT         NOT NULL DEFAULT 'rules',

    status             TEXT         NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','confirmed','dismissed','done')),

    decided_by         INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,
    decided_at         TIMESTAMPTZ,

    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

    /* THE SAME OBSERVATION MUST NOT PILE UP.

       A call transcript is analysed repeatedly as it grows, so the same sentence
       is seen many times. Without this, one mention of a new salary becomes
       fourteen identical proposals.

       fingerprint is a hash of kind + field + new_value + the room or thread, so
       re-analysing the same conversation updates one row instead of adding
       another. NULLS NOT DISTINCT is not needed: the fingerprint is always set. */
    fingerprint        VARCHAR(64)  NOT NULL,

    CONSTRAINT uq_insight_fingerprint UNIQUE (customer_person_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_insight_open
    ON ai_insights (customer_person_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_insight_thread
    ON ai_insights (thread_id, created_at);


/* =============================================================================
   15d. NOTIFICATIONS - new

   What the bell shows, and the log behind it.

   =============================================================================
   THE BELL USED TO BE A LIE, AND THIS TABLE IS WHY IT EXISTS
   =============================================================================

   The notification bell counted two things: a hard-coded activity feed in
   js/data.js, and pending appointments. So the assistant could read a call
   transcript, work out that somebody's income had changed and that they wanted a
   meeting booked, write both to ai_insights - and the bell would sit there
   showing a number about sample data. The one place a person looks to find out
   "has anything happened" knew nothing about the most important thing that had.

   So a notification is now a row. It is created by whatever noticed the thing, at
   the moment it noticed, and it carries a LINK to the screen where the thing can
   be dealt with. That last part is the whole point: a notification you cannot act
   on is a nag.

   =============================================================================
   ONE ROW PER PERSON WHO NEEDS TELLING, NOT ONE PER EVENT
   =============================================================================

   When a meeting is booked from a conversation, both sides are told - so that is
   two rows, one per account, each with its own read_at. The alternative, one row
   with a list of recipients, means "read" has to be stored somewhere else anyway
   and the query for "my unread count" stops being a single WHERE.

   `link` IS A HASH ROUTE, not a URL. The application is a single page and every
   destination is '#/fr/customer/cus-001' or similar. Storing a full URL would
   bake the deployment's hostname into the database.

   `dedupe` STOPS THE SAME THING BEING ANNOUNCED TWICE. A growing call transcript
   is re-read every ninety seconds; without this, one mention of a new salary would
   ring the bell on every pass. Same reasoning as ai_insights.fingerprint, and it
   is NULL when there is nothing to deduplicate - a booked meeting is an event, not
   an observation, and two of them really are two.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS notifications (
    id          BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    account_id  INTEGER      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

    /* What sort of thing happened. Drives the icon and lets a screen filter.
         insight    the assistant noticed something in a conversation
         meeting    a meeting was booked, moved or cancelled
         finance    somebody's financial record changed
         policy     an application moved, or cover was issued
         message    a message arrived that needs more than a chat badge
         system     everything else */
    kind        TEXT         NOT NULL DEFAULT 'system'
                             CHECK (kind IN ('insight','meeting','finance',
                                             'policy','message','system')),

    title       VARCHAR(190) NOT NULL,
    body        TEXT,

    /* Where to go to deal with it. '#/fr/customer/cus-001' and the like. */
    link        VARCHAR(190),

    /* The thing it is about, when there is one, so opening the notification can
       take somebody to the exact row rather than the general area. */
    insight_id  BIGINT       REFERENCES ai_insights (id) ON DELETE CASCADE,

    dedupe      VARCHAR(64),

    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_notification_dedupe UNIQUE (account_id, dedupe)
);

/* The two queries that matter: "my unread count" and "my last fifty". */
CREATE INDEX IF NOT EXISTS idx_notif_unread
    ON notifications (account_id, read_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notif_recent
    ON notifications (account_id, created_at DESC);


/* =============================================================================
   15e. THE FINANCIAL CHANGE LOG - new

   Every change to a customer_finances row: which field, from what, to what, who
   did it, and how.

   =============================================================================
   WHY A RECORD OF WHO CHANGED A FIGURE IS NOT OPTIONAL
   =============================================================================

   Three different actors can now move these numbers. The customer edits them in
   Settings. The representative confirms a change the assistant proposed from a
   conversation. And the assistant is the thing that proposed it.

   customer_finances holds only the CURRENT value, so without this table the answer
   to "why does it say ninety-five thousand when I told you a hundred and ten" is
   nobody knows. Every one of those three routes is a legitimate way for the figure
   to change, which is exactly why the record has to say which one it was.

   THE CUSTOMER CAN READ THEIR OWN LOG. It is a statement about their own money and
   there is no version of this where they are the party not allowed to see it - and
   an entry reading "your representative confirmed this from your call on Tuesday"
   is the thing that makes an AI-assisted record trustworthy rather than spooky.

   old_value AND new_value ARE TEXT. They hold money, a count of dependants and an
   age, and the log's job is to reproduce what was displayed, not to be arithmetic
   on. A numeric column here would need a type per field.
   ============================================================================= */
CREATE TABLE IF NOT EXISTS finance_changes (
    id          BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    person_id   VARCHAR(24)  NOT NULL REFERENCES people (id) ON DELETE CASCADE,

    /* The customer_finances column, e.g. 'annual_income'. Not a foreign key to
       anything - it names a column, and there is no table of columns. */
    field       VARCHAR(48)  NOT NULL,

    old_value   VARCHAR(200),
    new_value   VARCHAR(200),

    /* HOW it changed, and this is the column the whole table is for.
         self       the customer edited their own record
         ai         a representative confirmed something the assistant proposed
         rep        a representative changed it directly
         system     a migration or a recalculation */
    source      TEXT         NOT NULL DEFAULT 'self'
                             CHECK (source IN ('self','ai','rep','system')),

    /* WHO. Null only if the account has since been deleted - the change still
       happened and the log outlives the account, same rule as audit_log. */
    changed_by  INTEGER      REFERENCES accounts (id) ON DELETE SET NULL,

    /* The evidence, when the change came from a conversation. The words that were
       said. Without it an 'ai' entry is unreviewable. */
    quote       TEXT,

    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finchange_person
    ON finance_changes (person_id, created_at DESC);


/* =============================================================================
   16. THE TWO SEEDED REPRESENTATIVE PROFILES

   Only the profiles, not the people. People and accounts are seeded by
   db/seed.sql, which needs password hashes and therefore runs from Node.

   ON CONFLICT DO NOTHING is the replacement for MySQL's INSERT IGNORE, and it
   only fires if people 'fr-001' and 'fr-002' already exist - so this is a no-op
   on an empty database and correct after seeding.
   ============================================================================= */
INSERT INTO rep_profiles
    (person_id, accepting_customers, headline, bio, specialisations, languages,
     years_experience, max_customers)
SELECT * FROM (VALUES
    ('fr-001', true,
     'Protection and retirement planning for growing families',
     'I work mostly with families who want to know exactly what would happen to their income if something went wrong.',
     '["Protection","Retirement","Family planning"]'::jsonb,
     '["English","Mandarin"]'::jsonb,
     9::smallint, 40),
    ('fr-002', true,
     'Investment-linked plans and education funding',
     'I specialise in longer-horizon goals - education funding and investment-linked plans.',
     '["Investments","Education funding","Wealth accumulation"]'::jsonb,
     '["English","Malay"]'::jsonb,
     6::smallint, 40)
) AS v(person_id, accepting_customers, headline, bio, specialisations, languages,
       years_experience, max_customers)
WHERE EXISTS (SELECT 1 FROM people p WHERE p.id = v.person_id)
ON CONFLICT (person_id) DO NOTHING;
