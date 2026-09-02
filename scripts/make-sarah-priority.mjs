/* =============================================================================
   scripts/make-sarah-priority.mjs  -  Make Sarah appear first for Kristin
   -----------------------------------------------------------------------------
   Updates Sarah's financial data so she has the biggest protection gap,
   making her appear first in Kristin's client list for demos.
   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment
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
    console.log('\n🎯 Making Sarah the top priority for Kristin...\n');

    // Find Sarah
    const sarah = await sql`SELECT id FROM people WHERE name LIKE 'Sarah%' AND kind = 'customer' LIMIT 1`;
    if (!sarah.length) {
        console.error('❌ Sarah not found');
        process.exit(1);
    }
    const sarahId = sarah[0].id;
    console.log(`Found Sarah: ${sarahId}`);

    // Update Sarah's financ data to create a large protection gap
    // High income but very low existing coverage = biggest gap
    await sql`INSERT INTO customer_finances (
        person_id, annual_income, monthly_income, monthly_expenses, 
        monthly_commitments, premium_budget, savings, cpf, mortgage, 
        other_debt, dependants, existing_life_cover, existing_ci_cover
    ) VALUES (
        ${sarahId},
        180000,
        15000,
        9000,
        3500,
        750,
        85000,
        220000,
        650000,
        0,
        3,
        50000,
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
        existing_ci_cover = EXCLUDED.existing_ci_cover`;

    console.log('✓ Updated Sarah\'s financial data:');
    console.log('  • Annual income: $180,000');
    console.log('  • 3 dependents');
    console.log('  • Mortgage: $650,000');
    console.log('  • Existing life cover: Only $50,000 (very low!)');
    console.log('  • This creates a large protection gap');

    console.log('\n✅ Done! Sarah will now appear at the top of Kristin\'s client list.');
    console.log('   Hard refresh browser (Ctrl+Shift+R) to see the change.\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
