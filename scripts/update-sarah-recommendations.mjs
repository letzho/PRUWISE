/* =============================================================================
   Update Sarah's recommendations to match her new financial situation
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
    console.log('\n🔄 Updating Sarah\'s recommendations and policies...\n');

    // Get Sarah's account
    const sarah = await sql`
        SELECT a.id as account_id, p.id as person_id, p.name
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        WHERE p.name LIKE 'Sarah%' AND p.kind = 'customer'
        LIMIT 1
    `;

    if (!sarah.length) {
        console.error('❌ Sarah not found');
        process.exit(1);
    }

    const accountId = sarah[0].account_id;
    const personId = sarah[0].person_id;
    console.log(`Found: ${sarah[0].name}`);

    // Update assessment answers to match her new situation
    console.log('\n📋 Updating assessment answers...');
    
    const answers = {
        goal: 'protection',
        age: '35to44',
        dependants: 'children',
        budget: 'over400',
        risk: 'moderate',
        cover: 'some',
        concern: 'incomeloss'
    };

    await sql`
        UPDATE assessments
        SET answers = ${JSON.stringify(answers)},
            updated_at = now()
        WHERE account_id = ${accountId}
    `;
    
    console.log('✅ Updated answers: high protection need, 3 children, moderate risk');

    // Clear old recommendations
    await sql`DELETE FROM policy_recommendations WHERE account_id = ${accountId}`;
    console.log('✅ Cleared old recommendations');

    // Create new recommendations based on her $250K income, 3 kids, $850K mortgage
    console.log('\n💡 Creating new recommendations...\n');

    const recommendations = [
        {
            product_id: 'prd-active',
            product_name: 'PRUActive Protect Plus',
            rec_reason: 'High coverage for your income level',
            sum_assured: 2500000,
            annual_premium: 7200,
            recommended_at: new Date().toISOString()
        },
        {
            product_id: 'prd-ci',
            product_name: 'PRUCritical Cover',
            rec_reason: 'No existing critical illness coverage',
            sum_assured: 500000,
            annual_premium: 3600,
            recommended_at: new Date().toISOString()
        },
        {
            product_id: 'prd-income',
            product_name: 'PRUIncome Guard',
            rec_reason: 'Replace monthly income if unable to work',
            sum_assured: 144000,
            annual_premium: 2400,
            recommended_at: new Date().toISOString()
        }
    ];

    for (const rec of recommendations) {
        await sql`
            INSERT INTO policy_recommendations 
                (account_id, product_id, product_name, rec_reason, sum_assured, 
                 annual_premium, recommended_at, status)
            VALUES 
                (${accountId}, ${rec.product_id}, ${rec.product_name}, ${rec.rec_reason},
                 ${rec.sum_assured}, ${rec.annual_premium}, ${rec.recommended_at}, 'pending')
        `;
        console.log(`   ✓ ${rec.product_name}: $${rec.sum_assured.toLocaleString()} coverage`);
    }

    // Update existing policies to show she's underinsured
    console.log('\n📄 Checking existing policies...');
    
    const existingPolicies = await sql`
        SELECT id, product_name, sum_assured 
        FROM policies 
        WHERE person_id = ${personId}
    `;

    if (existingPolicies.length === 0) {
        console.log('   ℹ️  Sarah has no existing policies - this shows she\'s critically underinsured');
    } else {
        console.log(`   Found ${existingPolicies.length} existing policies`);
        existingPolicies.forEach(p => {
            console.log(`   • ${p.product_name}: $${p.sum_assured?.toLocaleString() || 'N/A'}`);
        });
    }

    console.log('\n✅ COMPLETE! Sarah\'s profile now shows:');
    console.log('   📊 Income: $250,000/year');
    console.log('   👨‍👩‍👧‍👦 3 children to support');
    console.log('   🏠 $850K mortgage');
    console.log('   ⚠️  Only $25K existing life cover');
    console.log('   🎯 Recommended: $2.5M term life + $500K CI + income protection');
    console.log('   💰 Protection Gap: ~$2.5 MILLION\n');
    console.log('Hard refresh (Ctrl+Shift+R) to see updated recommendations!\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
