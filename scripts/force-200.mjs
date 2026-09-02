/* =============================================================================
   scripts/force-200.mjs  -  FORCE exactly 200 clients (nuclear option)
   -----------------------------------------------------------------------------
   Deletes EVERYTHING except Sarah and original demos, then creates exactly 200.

   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import bcryptjs from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load .env.local
const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
        if (key) process.env[key] = value;
    }
});

const sql = neon(process.env.DATABASE_URL);

function randomElement(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const firstNames = ['Wei', 'Ming', 'Jun', 'Hui', 'Ying', 'Li', 'Kumar', 'Raj', 'Priya', 'Amir', 'Nur', 'Farah', 'David', 'Rachel', 'Michael', 'Emma', 'James', 'Sophie'];
const lastNames = ['Tan', 'Lim', 'Lee', 'Ng', 'Wong', 'Kumar', 'Singh', 'Rahman', 'Ali', 'Smith', 'Johnson', 'Brown'];

async function main() {
    console.log('\n🔥 FORCE RESET TO 200 CLIENTS\n');

    // Get Kristin's ID
    const kristin = await sql`SELECT p.id FROM accounts a JOIN people p ON a.person_id = p.id WHERE a.username = 'kristin.henessy'`;
    if (!kristin.length) {
        console.error('❌ Kristin not found');
        process.exit(1);
    }
    const kristinId = kristin[0].id;

    // Count current
    const before = await sql`SELECT COUNT(*) as c FROM people WHERE kind = 'customer' AND rep_id = ${kristinId}`;
    console.log(`Before: ${before[0].c} clients`);

    // Nuclear delete - remove EVERYTHING except cus-001 through cus-006
    console.log('\n🧹 Deleting all generated clients...');
    
    await sql`DELETE FROM threads WHERE customer_person_id IN (
        SELECT id FROM people WHERE rep_id = ${kristinId} AND kind = 'customer' AND id NOT LIKE 'cus-00%'
    )`;
    
    await sql`DELETE FROM assessments WHERE account_id IN (
        SELECT id FROM accounts WHERE person_id IN (
            SELECT id FROM people WHERE rep_id = ${kristinId} AND kind = 'customer' AND id NOT LIKE 'cus-00%'
        )
    )`;
    
    await sql`DELETE FROM accounts WHERE person_id IN (
        SELECT id FROM people WHERE rep_id = ${kristinId} AND kind = 'customer' AND id NOT LIKE 'cus-00%'
    )`;
    
    await sql`DELETE FROM people WHERE rep_id = ${kristinId} AND kind = 'customer' AND id NOT LIKE 'cus-00%'`;

    // Verify
    const after = await sql`SELECT COUNT(*) as c FROM people WHERE kind = 'customer' AND rep_id = ${kristinId}`;
    const remaining = parseInt(after[0].c);
    console.log(`✓ Deleted! Now: ${remaining} clients (demos only)`);

    // Generate exactly 200 total
    const needed = 200 - remaining;
    console.log(`\n📝 Creating ${needed} new clients with assessments...\n`);

    const usedNames = new Set();
    let created = 0;

    for (let i = 1; i <= needed; i++) {
        let firstName, lastName, fullName;
        do {
            firstName = randomElement(firstNames);
            lastName = randomElement(lastNames);
            fullName = `${firstName} ${lastName}`;
        } while (usedNames.has(fullName) && usedNames.size < 100);
        
        if (usedNames.has(fullName)) {
            fullName = `${firstName}${i} ${lastName}`;
        }
        usedNames.add(fullName);

        const age = randomInt(25, 60);
        const income = randomInt(40000, 150000);
        const email = `${firstName.toLowerCase()}${i}@example.com`;
        const clientId = `cus-2024-${String(i).padStart(4, '0')}`;

        try {
            // Person
            await sql`INSERT INTO people (id, kind, name, first_name, email, phone, rep_id, client_since)
                VALUES (${clientId}, 'customer', ${fullName}, ${firstName}, ${email}, 
                ${`9${randomInt(1000000, 9999999)}`}, ${kristinId}, CURRENT_DATE - ${randomInt(1, 730)})`;

            // Account
            const pwd = await bcryptjs.hash('demo1234', 10);
            const acc = await sql`INSERT INTO accounts (person_id, username, email, password_hash, role, name, email_verified, created_at)
                VALUES (${clientId}, ${email}, ${email}, ${pwd}, 'customer', ${fullName}, true, now() - interval '${randomInt(1, 730)} days')
                RETURNING id`;
            
            // Assessment
            const answers = {
                goal: randomElement(['home', 'retirement', 'protection']),
                age: age < 35 ? '25to34' : age < 45 ? '35to44' : '45to54',
                dependants: randomElement(['nobody', 'partner', 'children']),
                budget: income < 60000 ? 'under50' : income < 100000 ? '50to150' : '150to400',
                risk: randomElement(['low', 'moderate', 'high']),
                cover: randomElement(['none', 'employer', 'some']),
                concern: randomElement(['illness', 'retirement', 'education'])
            };

            const profile = {
                goal: answers.goal,
                ageRange: answers.age,
                dependants: answers.dependants,
                needsScore: randomInt(55, 85)
            };

            await sql`INSERT INTO assessments (account_id, answers, profile, completed_at)
                VALUES (${acc[0].id}, ${JSON.stringify(answers)}, ${JSON.stringify(profile)}, now() - interval '${randomInt(1, 365)} days')`;

            // Thread
            await sql`INSERT INTO threads (kind, fr_person_id, customer_person_id, created_at)
                VALUES ('human', ${kristinId}, ${clientId}, now() - interval '${randomInt(1, 729)} days')`;

            created++;
            if (created % 20 === 0) console.log(`  Created ${created}/${needed}...`);

        } catch (err) {
            console.error(`  ⚠️  ${clientId}: ${err.message}`);
        }
    }

    // Final verification
    const final = await sql`SELECT COUNT(*) as c FROM people WHERE kind = 'customer' AND rep_id = ${kristinId}`;
    console.log(`\n✅ DONE! Final count: ${final[0].c} clients`);
    console.log(`   • Demo clients: ${remaining}`);
    console.log(`   • Created: ${created}`);
    console.log(`\n✨ All clients have completed assessments!`);
    console.log(`\n🔄 Now HARD REFRESH your browser (Ctrl+Shift+R) to see changes.\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
