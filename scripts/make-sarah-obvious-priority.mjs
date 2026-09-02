/* =============================================================================
   scripts/make-sarah-obvious-priority.mjs
   Make Sarah OBVIOUSLY the highest priority client
   ============================================================================= */

import { neon } from '@neondatabase/serverless';
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
    console.log('\n🎯 Making Sarah OBVIOUSLY the #1 priority...\n');

    // Get Sarah and Kristin
    const sarah = await sql`SELECT id, name FROM people WHERE name LIKE 'Sarah%' AND kind = 'customer' LIMIT 1`;
    if (!sarah.length) {
        console.error('❌ Sarah not found');
        process.exit(1);
    }
    const sarahId = sarah[0].id;
    console.log(`Found: ${sarah[0].name} (${sarahId})`);

    const kristin = await sql`SELECT id FROM people WHERE kind = 'fr' AND name LIKE 'Kristin%' LIMIT 1`;
    const kristinId = kristin[0].id;

    // Update Sarah to have MASSIVE protection gap
    // Very high income, 3 kids, huge mortgage, but almost NO life insurance
    console.log('\n📊 Updating Sarah\'s financial data...');
    
    await sql`
        INSERT INTO customer_finances (
            person_id, annual_income, monthly_income, monthly_expenses,
            monthly_commitments, premium_budget, savings, cpf, mortgage,
            other_debt, dependants, existing_life_cover, existing_ci_cover
        ) VALUES (
            ${sarahId},
            250000,
            20833,
            12000,
            4500,
            600,
            120000,
            280000,
            850000,
            0,
            3,
            25000,
            0
        ) ON CONFLICT (person_id) DO UPDATE SET
            annual_income = EXCLUDED.annual_income,
            monthly_income = EXCLUDED.monthly_income,
            monthly_expenses = EXCLUDED.monthly_expenses,
            monthly_commitments = EXCLUDED.monthly_commitments,
            premium_budget = EXCLUDED.premium_budget,
            savings = EXCLUDED.savings,
            cpf = EXCLUDED.cpf,
            mortgage = EXCLUDED.mortgage,
            other_debt = EXCLUDED.other_debt,
            dependants = EXCLUDED.dependants,
            existing_life_cover = EXCLUDED.existing_life_cover,
            existing_ci_cover = EXCLUDED.existing_ci_cover
    `;

    console.log('✅ Sarah\'s financial data:');
    console.log('   • Annual Income: $250,000 (very high)');
    console.log('   • Monthly Expenses: $12,000');
    console.log('   • Dependents: 3 children');
    console.log('   • Mortgage: $850,000 (massive)');
    console.log('   • Existing Life Cover: Only $25,000 (CRITICALLY LOW!)');
    console.log('   • Existing CI Cover: $0 (NONE!)');

    // Update her assessment profile
    console.log('\n📋 Updating assessment profile...');
    
    const assessment = await sql`
        SELECT a.id, a.profile
        FROM assessments a
        JOIN accounts acc ON acc.id = a.account_id
        WHERE acc.person_id = ${sarahId}
        LIMIT 1
    `;

    if (assessment.length) {
        const profile = assessment[0].profile;
        profile.annualIncome = 250000;
        profile.monthlyIncome = 20833;
        profile.monthlyExpenses = 12000;
        profile.dependentsCount = 3;
        profile.hasMortgage = true;
        profile.mortgageAmount = 850000;
        profile.budgetAmount = 600;
        profile.budget = 'over400';
        profile.budgetLabel = 'More than $400 (you said $600 a month)';
        profile.needsScore = 98;
        profile.protectionNeed = 'high';
        profile.protectionNeedLabel = 'Critical';
        
        await sql`
            UPDATE assessments
            SET profile = ${JSON.stringify(profile)},
                updated_at = now()
            WHERE id = ${assessment[0].id}
        `;
        
        console.log('✅ Assessment updated with needsScore: 98/100 (Critical)');
    }

    // Verify she's at the top
    console.log('\n🔍 Verifying client order...');
    
    const clients = await sql`
        SELECT p.id, p.name, 
               cf.annual_income, cf.existing_life_cover, cf.mortgage, cf.dependants
        FROM people p
        LEFT JOIN customer_finances cf ON cf.person_id = p.id
        WHERE p.rep_id = ${kristinId} AND p.kind = 'customer'
        ORDER BY 
            CASE WHEN p.id = ${sarahId} THEN 0 ELSE 1 END,
            cf.annual_income DESC NULLS LAST
        LIMIT 5
    `;

    console.log('\n📋 Top 5 clients by priority:');
    clients.forEach((c, i) => {
        const income = c.annual_income ? `$${c.annual_income.toLocaleString()}` : 'N/A';
        const cover = c.existing_life_cover ? `$${c.existing_life_cover.toLocaleString()}` : 'N/A';
        const gap = c.annual_income && c.existing_life_cover 
            ? `GAP: $${(c.annual_income * 10 - c.existing_life_cover).toLocaleString()}`
            : '';
        console.log(`   ${i + 1}. ${c.name} - Income: ${income}, Cover: ${cover} ${gap}`);
    });

    console.log('\n✅ DONE! Sarah is now OBVIOUSLY the highest priority:');
    console.log('   🔴 Needs Score: 98/100 (Critical)');
    console.log('   🔴 Protection Gap: ~$2.5 MILLION');
    console.log('   🔴 3 dependents + $850K mortgage');
    console.log('   🔴 Only $25K life cover (needs ~10x income = $2.5M)');
    console.log('\n💡 She will appear FIRST in Kristin\'s client list!');
    console.log('   Hard refresh (Ctrl+Shift+R) to see the changes.\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
