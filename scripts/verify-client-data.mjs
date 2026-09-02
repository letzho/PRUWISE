/* =============================================================================
   scripts/verify-client-data.mjs  -  Verify client data is complete
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
    console.log('\n📊 Verifying Client Data for Kristin\n');

    // Get Kristin
    const kristin = await sql`SELECT p.id FROM accounts a JOIN people p ON a.person_id = p.id WHERE a.username = 'kristin.henessy'`;
    if (!kristin.length) {
        console.error('❌ Kristin not found');
        process.exit(1);
    }
    const kristinId = kristin[0].id;

    // Total count
    const total = await sql`SELECT COUNT(*) as c FROM people WHERE kind = 'customer' AND rep_id = ${kristinId}`;
    console.log(`Total clients: ${total[0].c}\n`);

    // Count with assessments
    const withAssessments = await sql`
        SELECT COUNT(*) as c 
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        JOIN assessments ass ON ass.account_id = a.id
        WHERE p.kind = 'customer' AND p.rep_id = ${kristinId}
    `;
    console.log(`Clients with completed assessments: ${withAssessments[0].c}\n`);

    // Sample 10 random clients with their data
    console.log('📋 Sample client data (showing 10 random clients):\n');
    
    const samples = await sql`
        SELECT 
            p.name,
            p.email,
            p.phone,
            p.client_since,
            ass.profile
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        JOIN assessments ass ON ass.account_id = a.id
        WHERE p.kind = 'customer' AND p.rep_id = ${kristinId}
        ORDER BY RANDOM()
        LIMIT 10
    `;

    samples.forEach((client, idx) => {
        const profile = client.profile;
        console.log(`${idx + 1}. ${client.name}`);
        console.log(`   Email: ${client.email}`);
        console.log(`   Phone: ${client.phone}`);
        console.log(`   Client since: ${client.client_since}`);
        console.log(`   Annual Income: $${profile.annualIncome?.toLocaleString() || 'N/A'}`);
        console.log(`   Monthly Expenses: $${profile.monthlyExpenses?.toLocaleString() || 'N/A'}`);
        console.log(`   Dependents: ${profile.dependentsCount ?? 'N/A'}`);
        console.log(`   Mortgage: ${profile.hasMortgage ? `$${profile.mortgageAmount?.toLocaleString()}` : 'None'}`);
        console.log(`   Risk Tolerance: ${profile.riskTolerance || 'N/A'}`);
        console.log(`   Needs Score: ${profile.needsScore || 'N/A'}/100`);
        console.log('');
    });

    // Stats summary
    console.log('\n📈 Portfolio Statistics:\n');
    
    const stats = await sql`
        SELECT 
            AVG((profile->>'annualIncome')::numeric) as avg_income,
            MIN((profile->>'annualIncome')::numeric) as min_income,
            MAX((profile->>'annualIncome')::numeric) as max_income,
            AVG((profile->>'needsScore')::numeric) as avg_needs_score,
            COUNT(CASE WHEN (profile->>'hasMortgage')::boolean = true THEN 1 END) as with_mortgage,
            COUNT(*) as total
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        JOIN assessments ass ON ass.account_id = a.id
        WHERE p.kind = 'customer' AND p.rep_id = ${kristinId}
    `;

    const s = stats[0];
    console.log(`Average Annual Income: $${Math.round(s.avg_income).toLocaleString()}`);
    console.log(`Income Range: $${Math.round(s.min_income).toLocaleString()} - $${Math.round(s.max_income).toLocaleString()}`);
    console.log(`Average Needs Score: ${Math.round(s.avg_needs_score)}/100`);
    console.log(`Clients with Mortgage: ${s.with_mortgage} (${Math.round(s.with_mortgage / s.total * 100)}%)`);
    
    console.log('\n✅ Verification Complete!\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
