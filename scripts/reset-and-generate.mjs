/* =============================================================================
   scripts/reset-and-generate.mjs  -  Reset to exactly 200 clients
   -----------------------------------------------------------------------------
   1. Removes all previously generated clients (cus-gen-*)
   2. Keeps original demo clients (Sarah, etc.)
   3. Generates exactly 200 NEW unique clients
   4. Prevents duplicates

   Usage:
     node scripts/reset-and-generate.mjs

   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
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

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in .env.local');
    process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// Expanded name lists for uniqueness
const firstNames = [
    // Chinese/Singaporean
    'Wei', 'Ming', 'Jun', 'Hui', 'Ying', 'Li', 'Xin', 'Jia', 'Yi', 'Chen',
    'Kai', 'Zhi', 'Xuan', 'Wen', 'Rui', 'Hao', 'Jing', 'Mei', 'Lin', 'Yan',
    // Indian
    'Kumar', 'Raj', 'Priya', 'Deepak', 'Ananya', 'Ravi', 'Lakshmi', 'Arun', 'Meera', 'Sanjay',
    'Vikram', 'Kavya', 'Arjun', 'Nisha', 'Rahul', 'Divya', 'Karthik', 'Pooja', 'Suresh', 'Shreya',
    // Malay
    'Amir', 'Nur', 'Farah', 'Hafiz', 'Aishah', 'Irfan', 'Zainab', 'Idris', 'Nadia', 'Hasan',
    'Aziz', 'Siti', 'Ahmad', 'Fatimah', 'Razak', 'Mariam', 'Iskandar', 'Aminah', 'Yusof', 'Halimah',
    // Western
    'David', 'Rachel', 'Michael', 'Emma', 'James', 'Sophie', 'Daniel', 'Olivia', 'Ryan', 'Chloe',
    'Ben', 'Sarah', 'Alex', 'Lucy', 'Tom', 'Grace', 'Matt', 'Kate', 'Sam', 'Anna'
];

const lastNames = [
    // Chinese
    'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Teo', 'Goh', 'Chua', 'Chan',
    'Koh', 'Yap', 'Sim', 'Low', 'Chong', 'Seah', 'Ang', 'Ho', 'Chia', 'Leong',
    // Indian
    'Kumar', 'Sharma', 'Singh', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Menon', 'Pillai',
    'Gupta', 'Verma', 'Desai', 'Krishnan', 'Murthy', 'Srinivasan', 'Bose', 'Das', 'Jain', 'Kapoor',
    // Malay
    'Rahman', 'Ali', 'Hassan', 'Ibrahim', 'Ismail', 'Yusof', 'Ahmad', 'Abdullah', 'Mohamed', 'Karim',
    'Aziz', 'Mahmud', 'Osman', 'Salleh', 'Hamid', 'Rahim', 'Idris', 'Jalil', 'Zakaria', 'Mansor',
    // Western
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

function generateEmail(firstName, lastName, num) {
    const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, '');
    const cleanLast = lastName.toLowerCase().replace(/[^a-z]/g, '');
    const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'singnet.com.sg'];
    return `${cleanFirst}.${cleanLast}.${num}@${randomElement(domains)}`;
}

function generatePhone() {
    const prefix = randomElement(['8', '9']);
    const digits = Array.from({ length: 7 }, () => randomInt(0, 9)).join('');
    return `${prefix}${digits}`;
}

function generateClient(index, usedNames) {
    let firstName, lastName, fullName;
    let attempts = 0;
    
    // Generate unique name
    do {
        firstName = randomElement(firstNames);
        lastName = randomElement(lastNames);
        fullName = `${firstName} ${lastName}`;
        attempts++;
        if (attempts > 100) {
            // If we can't find unique combo, add index to first name
            firstName = `${firstName}${index}`;
            fullName = `${firstName} ${lastName}`;
            break;
        }
    } while (usedNames.has(fullName));
    
    usedNames.add(fullName);
    
    const age = randomInt(25, 60);
    const maritalStatus = randomElement(['single', 'married', 'married', 'divorced']);
    const dependents = maritalStatus === 'single' 
        ? (Math.random() < 0.2 ? randomInt(1, 2) : 0)
        : randomInt(0, 3);

    const baseIncome = randomAmount(36000, 180000, 12000);
    const income = Math.round(baseIncome * (0.7 + (age - 25) / 100));
    const monthlyExpenses = Math.round(income * randomInt(40, 75) / 100);

    const hasExisting = Math.random() < 0.6;
    const existingLife = hasExisting ? randomAmount(50000, 500000, 50000) : 0;
    const existingCI = hasExisting && Math.random() < 0.4 ? randomAmount(25000, 200000, 25000) : 0;
    const existingPA = hasExisting && Math.random() < 0.3 ? randomAmount(10000, 100000, 10000) : 0;
    const existingDisability = hasExisting && Math.random() < 0.2 ? randomAmount(1000, 3000, 500) : 0;

    const hasMortgage = age > 30 && maritalStatus === 'married' && Math.random() < 0.6;
    const mortgageBalance = hasMortgage ? randomAmount(200000, 800000, 50000) : 0;
    const hasEducationGoals = dependents > 0 && Math.random() < 0.7;
    const riskTolerance = randomElement(['low', 'moderate', 'moderate', 'high']);
    const healthConditions = Math.random() < (age - 25) / 100;

    return {
        id: `cus-gen-${String(index).padStart(3, '0')}`,
        firstName,
        lastName,
        fullName,
        email: generateEmail(firstName, lastName, 2000 + index),
        phone: generatePhone(),
        age,
        maritalStatus,
        dependents,
        income,
        monthlyExpenses,
        existingLife,
        existingCI,
        existingPA,
        existingDisability,
        hasMortgage,
        mortgageBalance,
        hasEducationGoals,
        riskTolerance,
        healthConditions
    };
}

async function main() {
    console.log('\n🔄 Resetting Kristin\'s client list to exactly 200...\n');

    // Get Kristin's ID
    const kristinAccount = await sql`
        SELECT a.id as account_id, p.id as person_id
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        WHERE a.username = 'kristin.henessy'
    `;

    if (kristinAccount.length === 0) {
        console.error('❌ Kristin account not found.');
        process.exit(1);
    }

    const kristinPersonId = kristinAccount[0].person_id;

    // Step 1: Clean up all previously generated clients
    console.log('📊 Checking existing clients...');
    
    const existingGenerated = await sql`
        SELECT COUNT(*) as total
        FROM people
        WHERE id LIKE 'cus-gen-%'
    `;

    const existingCount = parseInt(existingGenerated[0].total);
    
    if (existingCount > 0) {
        console.log(`🧹 Removing ${existingCount} previously generated clients...`);
        
        // Delete in correct order (respect foreign keys)
        await sql`DELETE FROM threads WHERE customer_person_id LIKE 'cus-gen-%'`;
        await sql`DELETE FROM accounts WHERE person_id LIKE 'cus-gen-%'`;
        await sql`DELETE FROM people WHERE id LIKE 'cus-gen-%'`;
        
        console.log(`✓ Removed ${existingCount} old generated clients`);
    }

    // Check demo clients
    const demoClients = await sql`
        SELECT COUNT(*) as total
        FROM people
        WHERE kind = 'customer' AND rep_id = ${kristinPersonId} AND id NOT LIKE 'cus-gen-%'
    `;

    const demoCount = parseInt(demoClients[0].total);
    console.log(`✓ Found ${demoCount} original demo clients (will keep these)`);

    // Step 2: Generate exactly 200 NEW clients
    console.log(`\n📝 Generating 200 new unique clients...\n`);

    const usedNames = new Set();
    const clients = [];
    
    for (let i = 1; i <= 200; i++) {
        clients.push(generateClient(i, usedNames));
    }

    console.log(`✓ Generated 200 unique client profiles`);
    console.log(`\n💾 Inserting into database...\n`);

    let inserted = 0;
    let skipped = 0;

    for (const client of clients) {
        try {
            // Insert person
            const personResult = await sql`
                INSERT INTO people (
                    id, kind, name, first_name, email, phone,
                    rep_id, client_since
                ) VALUES (
                    ${client.id},
                    'customer',
                    ${client.fullName},
                    ${client.firstName},
                    ${client.email},
                    ${client.phone},
                    ${kristinPersonId},
                    CURRENT_DATE - (random() * 365 * 2)::int
                )
                ON CONFLICT (id) DO NOTHING
                RETURNING id
            `;

            if (personResult.length === 0) {
                skipped++;
                continue;
            }

            // Insert account
            const tempPassword = await bcryptjs.hash('demo' + randomInt(1000, 9999), 10);
            await sql`
                INSERT INTO accounts (
                    person_id, username, email, password_hash, role, name,
                    email_verified, created_at
                ) VALUES (
                    ${client.id},
                    ${client.email},
                    ${client.email},
                    ${tempPassword},
                    'customer',
                    ${client.fullName},
                    true,
                    now() - (random() * interval '730 days')
                )
                ON CONFLICT (username) DO NOTHING
            `;

            // Insert thread
            await sql`
                INSERT INTO threads (
                    kind, fr_person_id, customer_person_id, created_at
                ) VALUES (
                    'human',
                    ${kristinPersonId},
                    ${client.id},
                    now() - (random() * interval '729 days')
                )
                ON CONFLICT DO NOTHING
            `;

            inserted++;
            if (inserted % 25 === 0) {
                console.log(`  Inserted ${inserted}/200 clients...`);
            }

        } catch (err) {
            console.error(`  ⚠️  Error inserting ${client.id}:`, err.message);
        }
    }

    // Final count
    const finalCount = await sql`
        SELECT COUNT(*) as total
        FROM people
        WHERE kind = 'customer' AND rep_id = ${kristinPersonId}
    `;

    const total = parseInt(finalCount[0].total);

    console.log(`\n✅ Complete!`);
    console.log(`\n📊 Summary:`);
    console.log(`   • Original demo clients: ${demoCount}`);
    console.log(`   • New generated clients: ${inserted}`);
    console.log(`   • Total clients for Kristin: ${total}`);
    console.log(`   • Skipped (duplicates): ${skipped}`);
    
    console.log(`\n✨ All clients have:`);
    console.log(`   • Unique names`);
    console.log(`   • Random financial figures ($36K-$180K+ income)`);
    console.log(`   • Ages 25-60 years`);
    console.log(`   • Varied dependents, mortgage, existing coverage`);
    
    console.log(`\n✅ Ready to demo! Sign in as kristin.henessy to see ${total} clients.\n`);
}

main().catch((err) => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
