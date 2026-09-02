/* =============================================================================
   scripts/generate-clients.ts  -  Generate 200 realistic clients for Kristin
   -----------------------------------------------------------------------------
   Creates 200 clients with randomized but realistic:
   - Names (Singapore context)
   - Financial profiles (income, dependents, existing coverage)
   - Contact information
   - Assessment data
   - All assigned to Kristin (fr-001)

   The recommendation engine will automatically calculate based on their figures.

   Usage:
     node --env-file=.env.local --experimental-strip-types scripts/generate-clients.ts

   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

const sql = neon(process.env.DATABASE_URL!);

// Singapore-appropriate names
const firstNames = [
    'Wei', 'Ming', 'Jun', 'Hui', 'Ying', 'Li', 'Xin', 'Jia', 'Yi', 'Chen',
    'Kumar', 'Raj', 'Priya', 'Deepak', 'Ananya', 'Ravi', 'Lakshmi', 'Arun', 'Meera', 'Sanjay',
    'Amir', 'Nur', 'Farah', 'Hafiz', 'Aishah', 'Irfan', 'Zainab', 'Idris', 'Nadia', 'Hasan',
    'David', 'Rachel', 'Michael', 'Emma', 'James', 'Sophie', 'Daniel', 'Olivia', 'Ryan', 'Chloe'
];

const lastNames = [
    'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Teo', 'Goh', 'Chua', 'Chan',
    'Kumar', 'Sharma', 'Singh', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Menon', 'Pillai',
    'Rahman', 'Ali', 'Hassan', 'Ibrahim', 'Ismail', 'Yusof', 'Ahmad', 'Abdullah', 'Mohamed', 'Karim',
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'Thomas'
];

function randomElement<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomAmount(min: number, max: number, roundTo: number = 1000): number {
    const value = min + Math.random() * (max - min);
    return Math.round(value / roundTo) * roundTo;
}

function generateEmail(firstName: string, lastName: string, num: number): string {
    const cleanFirst = firstName.toLowerCase().replace(/[^a-z]/g, '');
    const cleanLast = lastName.toLowerCase().replace(/[^a-z]/g, '');
    const domains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com'];
    return `${cleanFirst}.${cleanLast}${num}@${randomElement(domains)}`;
}

function generatePhone(): string {
    const prefix = randomElement(['8', '9']);
    const digits = Array.from({ length: 7 }, () => randomInt(0, 9)).join('');
    return `${prefix}${digits}`;
}

interface ClientData {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    age: number;
    maritalStatus: 'single' | 'married' | 'divorced';
    dependents: number;
    income: number;
    monthlyExpenses: number;
    existingLife: number;
    existingCI: number;
    existingPA: number;
    existingDisability: number;
    hasMortgage: boolean;
    mortgageBalance: number;
    hasEducationGoals: boolean;
    riskTolerance: 'low' | 'moderate' | 'high';
    healthConditions: boolean;
}

function generateClient(index: number): ClientData {
    const firstName = randomElement(firstNames);
    const lastName = randomElement(lastNames);
    const age = randomInt(25, 60);
    const maritalStatus = randomElement(['single', 'married', 'married', 'divorced']); // weighted toward married
    const dependents = maritalStatus === 'single' 
        ? (Math.random() < 0.2 ? randomInt(1, 2) : 0)
        : randomInt(0, 3);

    // Income scales with age somewhat
    const baseIncome = randomAmount(36000, 180000, 12000); // $3K-$15K monthly
    const income = Math.round(baseIncome * (0.7 + (age - 25) / 100)); // age multiplier

    const monthlyExpenses = Math.round(income * randomInt(40, 75) / 100); // 40-75% of income

    // Existing coverage - some have it, most don't have enough
    const hasExisting = Math.random() < 0.6;
    const existingLife = hasExisting ? randomAmount(50000, 500000, 50000) : 0;
    const existingCI = hasExisting && Math.random() < 0.4 ? randomAmount(25000, 200000, 25000) : 0;
    const existingPA = hasExisting && Math.random() < 0.3 ? randomAmount(10000, 100000, 10000) : 0;
    const existingDisability = hasExisting && Math.random() < 0.2 ? randomAmount(1000, 3000, 500) : 0;

    // Mortgage more likely for married/older
    const hasMortgage = age > 30 && maritalStatus === 'married' && Math.random() < 0.6;
    const mortgageBalance = hasMortgage ? randomAmount(200000, 800000, 50000) : 0;

    // Education goals if they have kids
    const hasEducationGoals = dependents > 0 && Math.random() < 0.7;

    const riskTolerance = randomElement(['low', 'moderate', 'moderate', 'high']); // weighted toward moderate

    // Health conditions more likely as age increases
    const healthConditions = Math.random() < (age - 25) / 100;

    return {
        id: `cus-gen-${String(index).padStart(3, '0')}`,
        firstName,
        lastName,
        email: generateEmail(firstName, lastName, 1000 + index),
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
    console.log('\n📊 Generating 200 clients for Kristin...\n');

    // Get Kristin's account ID
    const kristinAccount = await sql`
        SELECT a.id as account_id, p.id as person_id
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        WHERE a.username = 'kristin.henessy'
    `;

    if (kristinAccount.length === 0) {
        console.error('❌ Kristin account not found. Run db:push first.');
        process.exit(1);
    }

    const kristinPersonId = kristinAccount[0].person_id;
    console.log(`✓ Found Kristin (${kristinPersonId})\n`);

    // Generate 200 clients
    const clients: ClientData[] = [];
    for (let i = 1; i <= 200; i++) {
        clients.push(generateClient(i));
    }

    console.log(`✓ Generated ${clients.length} client profiles\n`);

    // Insert in batches
    let inserted = 0;
    const batchSize = 50;

    for (let i = 0; i < clients.length; i += batchSize) {
        const batch = clients.slice(i, i + batchSize);
        
        for (const client of batch) {
            try {
                // Create person record
                await sql`
                    INSERT INTO people (
                        id, kind, name, first_name, email, phone,
                        rep_id, client_since, accepting_clients
                    ) VALUES (
                        ${client.id},
                        'customer',
                        ${client.firstName + ' ' + client.lastName},
                        ${client.firstName},
                        ${client.email},
                        ${client.phone},
                        ${kristinPersonId},
                        CURRENT_DATE - (random() * 365 * 2)::int,
                        false
                    )
                    ON CONFLICT (id) DO NOTHING
                `;

                // Create account
                const tempPassword = await bcrypt.hash('demo' + randomInt(1000, 9999), 10);
                await sql`
                    INSERT INTO accounts (
                        person_id, username, password_hash, role,
                        confirmed, created_at
                    ) VALUES (
                        ${client.id},
                        ${client.email},
                        ${tempPassword},
                        'customer',
                        true,
                        now() - (random() * interval '730 days')
                    )
                    ON CONFLICT (username) DO NOTHING
                `;

                // Create financial needs assessment
                const needsScore = randomInt(45, 85);
                await sql`
                    INSERT INTO needs_assessments (
                        person_id, age, marital_status, dependents,
                        annual_income, monthly_expenses,
                        existing_life_cover, existing_ci_cover,
                        existing_pa_cover, existing_disability_income,
                        has_mortgage, mortgage_balance,
                        has_education_goals, risk_tolerance,
                        health_conditions, needs_score,
                        status, completed_at, created_at
                    ) VALUES (
                        ${client.id},
                        ${client.age},
                        ${client.maritalStatus},
                        ${client.dependents},
                        ${client.income},
                        ${client.monthlyExpenses},
                        ${client.existingLife},
                        ${client.existingCI},
                        ${client.existingPA},
                        ${client.existingDisability},
                        ${client.hasMortgage},
                        ${client.mortgageBalance},
                        ${client.hasEducationGoals},
                        ${client.riskTolerance},
                        ${client.healthConditions},
                        ${needsScore},
                        'completed',
                        now() - (random() * interval '730 days'),
                        now() - (random() * interval '730 days')
                    )
                `;

                // Create a consultation record (already accepted by Kristin)
                await sql`
                    INSERT INTO consultations (
                        customer_id, rep_id, status,
                        requested_at, decided_at
                    ) VALUES (
                        ${client.id},
                        ${kristinPersonId},
                        'accepted',
                        now() - (random() * interval '730 days'),
                        now() - (random() * interval '729 days')
                    )
                    ON CONFLICT DO NOTHING
                `;

                // Create a thread for communication
                await sql`
                    INSERT INTO threads (
                        person_a, person_b, kind, created_at
                    ) VALUES (
                        ${client.id},
                        ${kristinPersonId},
                        'human',
                        now() - (random() * interval '729 days')
                    )
                    ON CONFLICT DO NOTHING
                `;

                inserted++;
                if (inserted % 50 === 0) {
                    console.log(`  Inserted ${inserted}/${clients.length} clients...`);
                }

            } catch (err: any) {
                console.error(`  ⚠️  Error inserting ${client.id}:`, err.message);
            }
        }
    }

    console.log(`\n✓ Successfully created ${inserted} clients`);
    console.log(`✓ All assigned to Kristin Henessy (${kristinPersonId})`);
    console.log(`✓ Financial profiles vary from $36K-$180K+ annual income`);
    console.log(`✓ Ages range from 25-60 years old`);
    console.log(`✓ Mix of single/married, 0-3 dependents`);
    console.log(`✓ Varied existing coverage (most under-insured)`);
    console.log(`\n📊 The recommendation engine will automatically calculate based on each client's figures.`);
    console.log(`\n🔐 Accounts created with temporary passwords (not for login, just for data integrity)`);
    console.log(`\n✅ Done! Kristin now has ${inserted} clients in her book.\n`);
}

main().catch((err) => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
