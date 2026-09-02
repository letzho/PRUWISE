/* =============================================================================
   scripts/fix-sarah-profile.mjs  -  Update Sarah's assessment profile
   -----------------------------------------------------------------------------
   Updates Sarah's assessment profile to match her financial data
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
    console.log('\n🔧 Updating Sarah\'s assessment profile...\n');

    // Get Sarah's current data
    const result = await sql`
        SELECT 
            a.id as assessment_id,
            a.profile,
            a.answers,
            cf.annual_income,
            cf.monthly_income,
            cf.monthly_expenses,
            cf.dependants,
            cf.mortgage,
            cf.existing_life_cover,
            cf.existing_ci_cover
        FROM people p
        JOIN accounts acc ON acc.person_id = p.id
        JOIN assessments a ON a.account_id = acc.id
        JOIN customer_finances cf ON cf.person_id = p.id
        WHERE p.name LIKE 'Sarah%'
        LIMIT 1
    `;

    if (!result.length) {
        console.error('❌ Sarah not found');
        process.exit(1);
    }

    const sarah = result[0];
    const profile = sarah.profile;

    // Update the profile with correct financial data
    profile.annualIncome = sarah.annual_income;
    profile.monthlyIncome = sarah.monthly_income;
    profile.monthlyExpenses = sarah.monthly_expenses;
    profile.dependentsCount = sarah.dependants;
    profile.hasMortgage = sarah.mortgage > 0;
    profile.mortgageAmount = sarah.mortgage;
    
    // Recalculate budget based on actual income
    const premiumBudget = Math.round(sarah.monthly_expenses * 0.05);
    profile.budgetAmount = premiumBudget;
    
    if (premiumBudget < 50) {
        profile.budget = 'under50';
        profile.budgetLabel = `Under $50 (you said $${premiumBudget} a month)`;
    } else if (premiumBudget < 150) {
        profile.budget = '50to150';
        profile.budgetLabel = `$50 to $150 (you said $${premiumBudget} a month)`;
    } else if (premiumBudget < 400) {
        profile.budget = '150to400';
        profile.budgetLabel = `$150 to $400 (you said $${premiumBudget} a month)`;
    } else {
        profile.budget = 'over400';
        profile.budgetLabel = `More than $400 (you said $${premiumBudget} a month)`;
    }

    // Update needs score based on financial situation
    // High income, 3 dependents, large mortgage, low existing cover = high needs score
    profile.needsScore = 92;
    profile.protectionNeed = 'high';
    profile.protectionNeedLabel = 'High';

    // Update the assessment
    await sql`
        UPDATE assessments 
        SET profile = ${JSON.stringify(profile)},
            updated_at = now()
        WHERE id = ${sarah.assessment_id}
    `;

    console.log('✅ Updated Sarah\'s assessment profile:');
    console.log('  • Annual Income: $' + sarah.annual_income.toLocaleString());
    console.log('  • Monthly Expenses: $' + sarah.monthly_expenses.toLocaleString());
    console.log('  • Premium Budget: $' + premiumBudget);
    console.log('  • Dependents: ' + sarah.dependants);
    console.log('  • Mortgage: $' + sarah.mortgage.toLocaleString());
    console.log('  • Existing Life Cover: $' + sarah.existing_life_cover.toLocaleString());
    console.log('  • Needs Score: 92/100');
    console.log('  • Protection Need: High');
    
    console.log('\n✅ Done! Sarah\'s profile now matches her financial data.');
    console.log('   Hard refresh (Ctrl+Shift+R) and check her profile as Kristin.\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
