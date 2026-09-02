/* =============================================================================
   PRUWise - seed data (Postgres)
   -----------------------------------------------------------------------------
   PEOPLE ONLY. No accounts.

   An account needs a bcrypt hash, which cannot be written in SQL, so the three
   logins are created by scripts/db-push.ts after this file has run.

   The ids match js/data.js exactly - 'cus-001' here is the same Sarah Tan that
   file describes in detail - because that is what joins the two halves of the
   project together.

   ON CONFLICT DO NOTHING throughout, so running this twice is harmless. It is
   the Postgres form of MySQL's INSERT IGNORE.

   Dates are relative to today, the same way js/data.js does it, so the demo
   never looks stale.
   ============================================================================= */


/* -----------------------------------------------------------------------------
   REPRESENTATIVES

   Seven, not two. The matching screen is supposed to be a ranked shortlist, and
   a shortlist of two is a list. Their specialisations are spread deliberately,
   and two of them are set up to be unavailable so that "has room to take you on"
   and "at capacity" mean something.
   ----------------------------------------------------------------------------- */
INSERT INTO people (id, kind, name, first_name, salutation, email, phone, rep_id, segment, client_since, status)
VALUES
    ('fr-001','fr','Kristin Henessy','Kristin','Ms','kristin.henessy@navigator-demo.sg','+65 8123 4477',NULL,NULL,NULL,'active'),
    ('fr-002','fr','Marcus Lim','Marcus','Mr','marcus.lim@navigator-demo.sg','+65 8455 2210',NULL,NULL,NULL,'active'),
    ('fr-003','fr','Lavanya Suresh','Lavanya','Ms','lavanya.suresh@navigator-demo.sg','+65 8221 9043',NULL,NULL,NULL,'active'),
    ('fr-004','fr','Ethan Chia','Ethan','Mr','ethan.chia@navigator-demo.sg','+65 9077 3318',NULL,NULL,NULL,'active'),
    ('fr-005','fr','Aisyah Rahman','Aisyah','Ms','aisyah.rahman@navigator-demo.sg','+65 8890 4127',NULL,NULL,NULL,'active'),
    ('fr-006','fr','Serene Wong','Serene','Ms','serene.wong@navigator-demo.sg','+65 9142 7756',NULL,NULL,NULL,'active'),
    ('fr-007','fr','Samuel Teo','Samuel','Mr','samuel.teo@navigator-demo.sg','+65 8334 6690',NULL,NULL,NULL,'active')
ON CONFLICT (id) DO NOTHING;


/* The administrator. */
INSERT INTO people (id, kind, name, first_name, salutation, email, phone, rep_id, segment, client_since, status)
VALUES
    ('adm-001','admin','System Administrator','Admin',NULL,'admin@navigator-demo.sg',NULL,NULL,NULL,NULL,'active')
ON CONFLICT (id) DO NOTHING;


/* -----------------------------------------------------------------------------
   THE SIX DEMO CUSTOMERS

   These are the ones js/data.js carries policies, coverage and recommendations
   for, and the only customer ids in publicAccount()'s hasSampleProfile list.
   ----------------------------------------------------------------------------- */
INSERT INTO people (id, kind, name, first_name, salutation, email, phone, rep_id, segment, client_since, status)
VALUES
    ('cus-001','customer','Sarah Tan','Sarah','Mrs','sarah.tan@example.sg','+65 9123 8871','fr-001','Growing family',      CURRENT_DATE - INTERVAL '4 years','active'),
    ('cus-002','customer','Daniel Wong','Daniel','Mr','daniel.wong@example.sg','+65 9772 3310','fr-001','Established family', CURRENT_DATE - INTERVAL '7 years','active'),
    ('cus-003','customer','Priya Raman','Priya','Ms','priya.raman@example.sg','+65 8890 4412','fr-001','Young professional', CURRENT_DATE - INTERVAL '1 year','active'),
    ('cus-004','customer','Grace Chua','Grace','Mdm','grace.chua@example.sg','+65 9004 7781','fr-001','Pre-retiree',        CURRENT_DATE - INTERVAL '11 years','review-due'),
    ('cus-005','customer','Aaron Sim','Aaron','Mr','aaron.sim@example.sg','+65 8221 9903','fr-002','New family',            CURRENT_DATE - INTERVAL '2 years','active'),
    ('cus-006','customer','Nadia Iskandar','Nadia','Ms','nadia.iskandar@example.sg','+65 9668 1204','fr-001','Single parent', CURRENT_DATE - INTERVAL '6 years','active')
ON CONFLICT (id) DO NOTHING;


/* -----------------------------------------------------------------------------
   BOOK FILL

   PEOPLE ROWS ONLY - no logins, no policies. They exist so customer counts
   differ between representatives, which is the whole reason the matching screen
   can say one has room and another is full. Giving each a login would be a dozen
   more passwords to manage for no benefit.

   The twelve against fr-007 are exactly his stated limit, so he reads as full.
   ----------------------------------------------------------------------------- */
INSERT INTO people (id, kind, name, first_name, salutation, email, phone, rep_id, segment, client_since, status)
VALUES
    ('cus-101','customer','Wei Ling Chua','Wei Ling','Ms','weiling.chua@example.sg','+65 9112 0034','fr-003','Pre-retiree',      CURRENT_DATE - INTERVAL '7 years','active'),
    ('cus-102','customer','Harish Nair','Harish','Mr','harish.nair@example.sg','+65 8221 4590','fr-003','Pre-retiree',          CURRENT_DATE - INTERVAL '4 years','active'),
    ('cus-103','customer','Melissa Koh','Melissa','Ms','melissa.koh@example.sg','+65 9330 7781','fr-004','Medical focus',       CURRENT_DATE - INTERVAL '3 years','active'),
    ('cus-104','customer','Ridhwan Salim','Ridhwan','Mr','ridhwan.salim@example.sg','+65 8447 2216','fr-004','Family cover',    CURRENT_DATE - INTERVAL '5 years','active'),
    ('cus-105','customer','Joanne Tay','Joanne','Ms','joanne.tay@example.sg','+65 9008 5512','fr-004','Critical illness',       CURRENT_DATE - INTERVAL '2 years','active'),
    ('cus-106','customer','Kelvin Sim','Kelvin','Mr','kelvin.sim@example.sg','+65 8776 1103','fr-005','First policy',           CURRENT_DATE - INTERVAL '1 year','active'),

    ('cus-111','customer','Adeline Foo','Adeline','Ms','adeline.foo@example.sg',NULL,'fr-007','Investments',    CURRENT_DATE - INTERVAL '6 years','active'),
    ('cus-112','customer','Bryan Ng','Bryan','Mr','bryan.ng@example.sg',NULL,'fr-007','Investments',            CURRENT_DATE - INTERVAL '5 years','active'),
    ('cus-113','customer','Cheryl Lim','Cheryl','Ms','cheryl.lim@example.sg',NULL,'fr-007','Wealth',            CURRENT_DATE - INTERVAL '5 years','active'),
    ('cus-114','customer','Derrick Yap','Derrick','Mr','derrick.yap@example.sg',NULL,'fr-007','Wealth',         CURRENT_DATE - INTERVAL '4 years','active'),
    ('cus-115','customer','Eunice Chan','Eunice','Ms','eunice.chan@example.sg',NULL,'fr-007','Investments',      CURRENT_DATE - INTERVAL '4 years','active'),
    ('cus-116','customer','Farhan Aziz','Farhan','Mr','farhan.aziz@example.sg',NULL,'fr-007','Self-employed',    CURRENT_DATE - INTERVAL '3 years','active'),
    ('cus-117','customer','Gillian Toh','Gillian','Ms','gillian.toh@example.sg',NULL,'fr-007','Investments',     CURRENT_DATE - INTERVAL '3 years','active'),
    ('cus-118','customer','Hafiz Omar','Hafiz','Mr','hafiz.omar@example.sg',NULL,'fr-007','Wealth',              CURRENT_DATE - INTERVAL '2 years','active'),
    ('cus-119','customer','Irene Goh','Irene','Ms','irene.goh@example.sg',NULL,'fr-007','Investments',           CURRENT_DATE - INTERVAL '2 years','active'),
    ('cus-120','customer','Jason Pang','Jason','Mr','jason.pang@example.sg',NULL,'fr-007','Wealth',              CURRENT_DATE - INTERVAL '2 years','active'),
    ('cus-121','customer','Karen Lau','Karen','Ms','karen.lau@example.sg',NULL,'fr-007','Investments',           CURRENT_DATE - INTERVAL '1 year','active'),
    ('cus-122','customer','Lionel Heng','Lionel','Mr','lionel.heng@example.sg',NULL,'fr-007','Self-employed',    CURRENT_DATE - INTERVAL '1 year','active')
ON CONFLICT (id) DO NOTHING;


/* -----------------------------------------------------------------------------
   THE REMAINING REPRESENTATIVE PROFILES

   fr-001 and fr-002 are seeded by db/schema.sql. These five complete the set so
   the matching screen has something to rank, including the two that are switched
   OFF - which is the case most worth being able to demonstrate, because a
   representative who has said no must never be offered.
   ----------------------------------------------------------------------------- */
INSERT INTO rep_profiles (person_id, accepting_customers, headline, bio, specialisations, languages, years_experience, max_customers)
VALUES
    ('fr-003', true,
     'Retirement income and CPF planning',
     'Most of my clients are within ten years of stopping work and want to know what their monthly income will actually be.',
     '["Retirement","CPF","Income planning"]'::jsonb, '["English","Tamil","Hindi"]'::jsonb, 12, 40),

    ('fr-004', true,
     'Hospitalisation cover and family protection',
     'I spend most of my time on medical cover - what is actually claimable, and what the riders really change.',
     '["Hospitalisation","Family planning","Critical illness"]'::jsonb, '["English","Malay"]'::jsonb, 7, 40),

    ('fr-005', true,
     'First-time policy holders',
     'If you have never bought insurance before and would rather nobody talked down to you, that is what I do.',
     '["Protection","First policy","Education funding"]'::jsonb, '["English","Malay","Mandarin"]'::jsonb, 4, 30),

    /* NOT ACCEPTING. On sabbatical - the availability switch is off, so she must
       never appear on the matching screen however well she scores. */
    ('fr-006', false,
     'Estate planning and legacy cover',
     'Currently on sabbatical and not taking new clients.',
     '["Estate planning","Whole life","Legacy"]'::jsonb, '["English","Cantonese"]'::jsonb, 15, 25),

    /* ACCEPTING, BUT FULL. max_customers is 12 and the seed gives him exactly 12,
       so he is filtered out by capacity rather than by the switch. Two different
       reasons to be unavailable, both worth being able to show. */
    ('fr-007', true,
     'Investment-linked plans and wealth accumulation',
     'Longer-horizon money: investment-linked plans, and what to do with a lump sum.',
     '["Investments","Wealth accumulation","Self-employed"]'::jsonb, '["English","Mandarin"]'::jsonb, 10, 12)
ON CONFLICT (person_id) DO NOTHING;
