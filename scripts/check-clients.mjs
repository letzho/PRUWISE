/* Check how many clients Kristin actually has */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

const envPath = join(process.cwd(), '.env.local');
const envFile = readFileSync(envPath, 'utf-8');
envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        value = value.replace(/^["']|["']$/g, '');
        if (key) process.env[key] = value;
    }
});

const sql = neon(process.env.DATABASE_URL);

const kristin = await sql`SELECT p.id FROM accounts a JOIN people p ON a.person_id = p.id WHERE a.username = 'kristin.henessy'`;
const kristinPersonId = kristin[0].id;

const total = await sql`SELECT COUNT(*) as count FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId}`;
const demo = await sql`SELECT COUNT(*) as count FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId} AND id LIKE 'cus-0%'`;
const generated = await sql`SELECT COUNT(*) as count FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId} AND id NOT LIKE 'cus-0%'`;

console.log('\n📊 Database Status:\n');
console.log(`Total clients for Kristin: ${total[0].count}`);
console.log(`Demo clients (cus-0XX): ${demo[0].count}`);
console.log(`Generated clients: ${generated[0].count}`);
console.log('');

// Sample of generated IDs
const samples = await sql`SELECT id, name FROM people WHERE kind = 'customer' AND rep_id = ${kristinPersonId} AND id NOT LIKE 'cus-0%' ORDER BY id LIMIT 5`;
console.log('Sample generated client IDs:');
samples.forEach(s => console.log(`  ${s.id} - ${s.name}`));
console.log('');
