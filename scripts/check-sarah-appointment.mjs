import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(0, eqIndex).trim().replace(/^["']|["']$/g, '');
        if (key) process.env[key] = value;
    }
});

const sql = neon(process.env.DATABASE_URL);

async function main() {
    const appointments = await sql`
        SELECT a.title, a.start_at, a.status, 
               cp.name as customer_name,
               rp.name as rep_name
        FROM appointments a
        JOIN people cp ON cp.id = a.customer_person_id
        JOIN people rp ON rp.id = a.rep_person_id
        WHERE cp.name LIKE 'Sarah%'
        ORDER BY a.start_at DESC
        LIMIT 5
    `;
    
    console.log('\n📅 Sarah\'s appointments:\n');
    if (appointments.length === 0) {
        console.log('❌ No appointments found for Sarah');
        console.log('\nTo see the meeting message, you need to create an appointment for Sarah with Kristin for today!');
    } else {
        appointments.forEach(a => {
            console.log(`${a.title}`);
            console.log(`  When: ${a.start_at}`);
            console.log(`  Status: ${a.status}`);
            console.log(`  With: ${a.rep_name}`);
            console.log('');
        });
    }
}

main().catch(console.error);
