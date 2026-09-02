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
    const result = await sql`
        SELECT 
            p.name,
            a.profile,
            a.answers,
            cf.annual_income,
            cf.dependants,
            cf.mortgage,
            cf.existing_life_cover
        FROM people p
        JOIN accounts acc ON acc.person_id = p.id
        JOIN assessments a ON a.account_id = acc.id
        LEFT JOIN customer_finances cf ON cf.person_id = p.id
        WHERE p.name LIKE 'Sarah%'
        LIMIT 1
    `;
    
    console.log('\n=== SARAH\'S DATA ===\n');
    console.log('Name:', result[0].name);
    console.log('\nFinancial Data (customer_finances):');
    console.log('  Income:', result[0].annual_income);
    console.log('  Dependants:', result[0].dependants);
    console.log('  Mortgage:', result[0].mortgage);
    console.log('  Existing Life Cover:', result[0].existing_life_cover);
    
    console.log('\nAssessment Answers:');
    console.log(JSON.stringify(result[0].answers, null, 2));
    
    console.log('\nAssessment Profile:');
    console.log(JSON.stringify(result[0].profile, null, 2));
}

main().catch(console.error);
