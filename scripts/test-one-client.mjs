import { neon } from '@neondatabase/serverless';
import bcryptjs from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';

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

async function main() {
    try {
        console.log('Testing single client creation...');
        
        const kristin = await sql`SELECT p.id FROM accounts a JOIN people p ON a.person_id = p.id WHERE a.username = 'kristin.henessy'`;
        const kristinId = kristin[0].id;
        console.log('Kristin ID:', kristinId);
        
        const testId = 'cus-test-001';
        const testName = 'Test Client';
        const testEmail = 'test.client@test.com';
        
        console.log('1. Inserting person...');
        await sql`INSERT INTO people (id, kind, name, first_name, email, phone, rep_id, client_since)
            VALUES (${testId}, 'customer', ${testName}, 'Test', ${testEmail}, '91234567', ${kristinId}, '2024-01-01')`;
        console.log('✓ Person inserted');
        
        console.log('2. Inserting account...');
        const pwd = await bcryptjs.hash('demo1234', 10);
        const acc = await sql`INSERT INTO accounts (person_id, username, email, password_hash, role, name, email_verified, created_at)
            VALUES (${testId}, ${testEmail}, ${testEmail}, ${pwd}, 'customer', ${testName}, true, now())
            RETURNING id`;
        const accountId = acc[0].id;
        console.log('✓ Account inserted, ID:', accountId);
        
        console.log('3. Inserting assessment...');
        const answers = { goal: 'protection', age: '25to34', dependants: 'nobody', budget: 'under50', risk: 'moderate', cover: 'none', concern: 'illness' };
        const profile = { goal: 'protection', needsScore: 75, annualIncome: 50000, monthlyExpenses: 2000, dependentsCount: 0 };
        await sql`INSERT INTO assessments (account_id, answers, profile, completed_at, updated_at)
            VALUES (${accountId}, ${JSON.stringify(answers)}, ${JSON.stringify(profile)}, now(), now())`;
        console.log('✓ Assessment inserted');
        
        console.log('4. Inserting thread...');
        await sql`INSERT INTO threads (kind, fr_person_id, customer_person_id, created_at)
            VALUES ('human', ${kristinId}, ${testId}, now())`;
        console.log('✓ Thread inserted');
        
        console.log('5. Inserting customer_finances...');
        await sql`INSERT INTO customer_finances (
            person_id, annual_income, monthly_income, monthly_expenses, 
            monthly_commitments, premium_budget, savings, cpf, mortgage, 
            other_debt, dependants, existing_life_cover, existing_ci_cover
        ) VALUES (
            ${testId}, 50000, 4167, 2000, 500, 100, 10000, 50000, 0, 0, 0, 0, 0
        )`;
        console.log('✓ Customer finances inserted');
        
        console.log('\n✅ SUCCESS! Test client created with all data.');
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

main();
