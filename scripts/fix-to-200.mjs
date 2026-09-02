/* =============================================================================
   scripts/fix-to-200.mjs  -  Force exactly 200 total clients
   -----------------------------------------------------------------------------
   Removes ALL generated clients, keeps only original demo clients,
   then generates NEW clients to reach exactly 200 total.

   Usage:
     node scripts/fix-to-200.mjs

   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import bcryptjs from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables
const envPath = join(process.cwd(), '.env.local');
try {
    const envFile = readFileSync(envPath, 'utf-8');
    envFile.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const eqIndex = trimmed.indexOf('=');
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            value = value.replace(/^["']|["']$/g, '');
            if (key) {
                process.env[key] = value;
            }
        }
    });
} catch (err) {
    console.error('❌ Could not load .env.local:', err.message);
    process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// Name lists
const firstNames = [
    'Wei', 'Ming', 'Jun', 'Hui', 'Ying', 'Li', 'Xin', 'Jia', 'Yi', 'Chen',
    'Kai', 'Zhi', 'Xuan', 'Wen', 'Rui', 'Hao', 'Jing', 'Mei', 'Lin', 'Yan',
    'Kumar', 'Raj', 'Priya', 'Deepak', 'Ananya', 'Ravi', 'Lakshmi', 'Arun', 'Meera', 'Sanjay',
    'Vikram', 'Kavya', 'Arjun', 'Nisha', 'Rahul', 'Divya', 'Karthik', 'Pooja', 'Suresh', 'Shreya',
    'Amir', 'Nur', 'Farah', 'Hafiz', 'Aishah', 'Irfan', 'Zainab', 'Idris', 'Nadia', 'Hasan',
    'Aziz', 'Siti', 'Ahmad', 'Fatimah', 'Razak', 'Mariam', 'Iskandar', 'Aminah', 'Yusof', 'Halimah',
    'David', 'Rachel', 'Michael', 'Emma', 'James', 'Sophie', 'Daniel', 'Olivia', 'Ryan', 'Chloe',
    'Ben', 'Alex', 'Lucy', 'Tom', 'Grace', 'Matt', 'Kate', 'Sam', 'Anna', 'Jack'
];

const lastNames = [
    'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Teo', 'Goh', 'Chua', 'Chan',
    'Koh', 'Yap', 'Sim', 'Low', 'Chong', 'Seah', 'Ang', 'Ho', 'Chia', 'Leong',
    'Kumar', 'Sharma', 'Singh', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Menon', 'Pillai',
    'Gupta', 'Verma', 'Desai', 'Krishnan', 'Murthy', 'Srinivasan', 'Bose', 'Das', 'Jain', 'Kapoor',
    'Rahman', 'Ali', 'Hassan', 'Ibrahim', 'Ismail', 'Yusof', 'Ahmad', 'Abdullah', 'Mohamed', 'Karim',
    'Aziz', 'Mahmud', 'Osman', 'Salleh', 'Hamid', 'Rahim', 'Idris', 'Jalil', 'Zakaria', 'Mansor',
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'Thomas',
    'Martin', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Young', 'King', 'Wright', 'Green'
];

function randomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAmount(min, max, roundTo = 1000) {
    const value = min + Math.random() * (max - min);
    return Math.round(value / roundTo) * roundTo;
}

function generateClient(index, usedNames) {
    let firstName, lastName, fullName;
    let attempts = 0;
    
    do {
        firstName = randomElement(firstNames);
        lastName = randomElement(lastNames);
        fullName = `${firstName} ${lastName}`;
        attempts++;
        if (attempts > 100) {
            firstName = `${firstName}${index}`;
            fullName = `${firstName} ${lastName}`;
            break;
        }
    } while (usedNames.has(fullName));
    
    usedNames.add(fullName);
    
    const age = randomInt(25, 60);
    const maritalStatus = randomElement(['single', 'married', 'married', 'divorced']);
    const dependents = maritalStatus === 'single' ? (Math.random() < 0.2 ? randomInt(1, 2) : 0) : randomInt(0, 3);
    const income = Math.round(randomAmount(36000, 180000, 12000) * (0.7 + (age - 25) / 100));

    return {
        id: `cus-new-${String(index).padStart(4, '0')}`,
        firstName,
        lastName,
        fullName,
        email: `${firstName.toLowerCase().replace(/[^a-z]/g, '')}.${lastName.toLowerCase().replace(/[^a-z]/g, '')}.${2000 + index}@${randomElement(['gmail.com', 'outlook.com', 'yahoo.com'])}`,
        phone: `${randomElement(['8', '9'])}${Array.from({ length: 7 }, () => randomInt(0, 9)).join('')}`,
        age,
        income
    };
}

async function main() {
    console.log('\n🎯 Setting Kristin to exactly 200 clients total...\n');

    const kristin = await sql`SELECT p.id FROM accounts a JOIN people p ON a.person_id = p.id WHERE a.username = 'kristin.henessy'`;
    if (!kristin.length) {
        console.error('❌ Kristin not found');
        process.exit(1);
    }
    const kristinPersonId = kristin[0].id;

    // Count current clients
    const current = await sql`SELECT COUNT(*) as total FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId}`;
    const currentTotal = parseInt(current[0].total);
    console.log(`📊 Kristin currently has ${currentTotal} clients`);

    // Get original demo client IDs (cus-001 through cus-006)
    const demoIds = await sql`SELECT id FROM people WHERE id LIKE 'cus-0%' AND kind = 'customer'`;
    const demoIdList = demoIds.map(r => r.id);
    console.log(`✓ Found ${demoIdList.length} original demo clients:`, demoIdList.join(', '));

    // Delete ALL non-demo clients
    if (currentTotal > demoIdList.length) {
        console.log(`\n🧹 Removing ${currentTotal - demoIdList.length} generated clients...`);
        
        // Build list of IDs to keep
        const keepIds = demoIdList.map(id => `'${id}'`).join(',');
        
        // Delete everything except demo clients
        await sql.unsafe(`DELETE FROM threads WHERE customer_person_id NOT IN (${keepIds}) AND customer_person_id IN (SELECT id FROM people WHERE rep_id = '${kristinPersonId}')`);
        await sql.unsafe(`DELETE FROM assessments WHERE account_id IN (SELECT id FROM accounts WHERE person_id NOT IN (${keepIds}) AND person_id IN (SELECT id FROM people WHERE rep_id = '${kristinPersonId}'))`);
        await sql.unsafe(`DELETE FROM accounts WHERE person_id NOT IN (${keepIds}) AND person_id IN (SELECT id FROM people WHERE rep_id = '${kristinPersonId}')`);
        await sql.unsafe(`DELETE FROM people WHERE id NOT IN (${keepIds}) AND rep_id = '${kristinPersonId}' AND kind = 'customer'`);
        
        console.log(`✓ Removed all generated clients`);
    }

    // Verify cleanup
    const afterCleanup = await sql`SELECT COUNT(*) as total FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId}`;
    const remaining = parseInt(afterCleanup[0].total);
    console.log(`✓ Now at ${remaining} clients (demo clients only)`);

    // Calculate how many to generate
    const needed = 200 - remaining;
    console.log(`\n📝 Generating ${needed} new clients with completed assessments...\n`);

    const usedNames = new Set();
    let inserted = 0;

    for (let i = 1; i <= needed; i++) {
        const client = generateClient(i, usedNames);
        
        try {
            // Insert person
            await sql`INSERT INTO people (id, kind, name, first_name, email, phone, rep_id, client_since) 
                VALUES (${client.id}, 'customer', ${client.fullName}, ${client.firstName}, ${client.email}, ${client.phone}, ${kristinPersonId}, CURRENT_DATE - (random() * 365 * 2)::int)`;
            
            // Insert account
            const tempPassword = await bcryptjs.hash('demo' + randomInt(1000, 9999), 10);
            const accountResult = await sql`INSERT INTO accounts (person_id, username, email, password_hash, role, name, email_verified, created_at) 
                VALUES (${client.id}, ${client.email}, ${client.email}, ${tempPassword}, 'customer', ${client.fullName}, true, now() - (random() * interval '730 days'))
                RETURNING id`;
            
            const accountId = accountResult[0].id;
            
            // Create realistic assessment answers based on age and income
            const answers = {
                goal: client.age < 35 ? randomElement(['home', 'protection', 'education']) : randomElement(['retirement', 'protection', 'investment']),
                age: client.age < 25 ? 'under25' : client.age < 35 ? '25to34' : client.age < 45 ? '35to44' : client.age < 55 ? '45to54' : '55plus',
                dependants: client.age < 30 ? randomElement(['nobody', 'partner']) : randomElement(['partner', 'children', 'extended']),
                budget: client.income < 50000 ? 'under50' : client.income < 80000 ? '50to150' : client.income < 120000 ? '150to400' : 'over400',
                risk: randomElement(['low', 'moderate', 'moderate', 'high']),
                cover: randomElement(['none', 'employer', 'some', 'comprehensive']),
                concern: randomElement(['illness', 'incomeloss', 'retirement', 'education', 'inflation'])
            };
            
            // Create profile from answers
            const profile = {
                goal: answers.goal,
                ageRange: answers.age,
                dependants: answers.dependants,
                budget: answers.budget,
                riskTolerance: answers.risk,
                existingCover: answers.cover,
                mainConcern: answers.concern,
                protectionPriority: ['children', 'extended'].includes(answers.dependants) ? 'high' : 'moderate',
                needsScore: randomInt(50, 85)
            };
            
            // Insert assessment
            await sql`INSERT INTO assessments (account_id, answers, profile, completed_at, updated_at)
                VALUES (${accountId}, ${JSON.stringify(answers)}, ${JSON.stringify(profile)}, now() - (random() * interval '365 days'), now() - (random() * interval '365 days'))`;
            
            // Insert thread
            await sql`INSERT INTO threads (kind, fr_person_id, customer_person_id, created_at) 
                VALUES ('human', ${kristinPersonId}, ${client.id}, now() - (random() * interval '729 days'))`;
            
            inserted++;
            if (inserted % 25 === 0) console.log(`  Created ${inserted}/${needed}...`);
        } catch (err) {
            console.error(`  ⚠️  Error with ${client.id}:`, err.message);
        }
    }

    // Final count
    const final = await sql`SELECT COUNT(*) as total FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId}`;
    const finalTotal = parseInt(final[0].total);

    console.log(`\n✅ Done!`);
    console.log(`\n📊 Final count: ${finalTotal} total clients`);
    console.log(`   • Demo clients: ${remaining}`);
    console.log(`   • New generated: ${inserted}`);
    console.log(`\n✨ All clients have:`);
    console.log(`   • Completed financial needs assessments`);
    console.log(`   • Realistic answers based on age and income`);
    console.log(`   • Unique names and contact details`);
    console.log(`\n✨ Ready to demo! Sign in as kristin.henessy to see exactly ${finalTotal} clients.\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
