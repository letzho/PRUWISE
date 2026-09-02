import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && value) process.env[key] = value;
    }
});

const sql = neon(process.env.DATABASE_URL);

async function main() {
    console.log('\n🔍 Checking Sarah-Kristin connection...\n');

    const result = await sql`
        SELECT 
            p.name as person_name,
            p.id as person_id,
            p.kind,
            p.rep_id,
            rep.name as rep_name,
            t.id as thread_id
        FROM people p
        LEFT JOIN people rep ON rep.id = p.rep_id
        LEFT JOIN threads t ON (t.customer_person_id = p.id AND t.kind = 'human')
        WHERE p.name LIKE 'Sarah%' OR p.name LIKE 'Kristin%'
        ORDER BY p.kind, p.name
    `;

    console.log('📋 Connection Status:\n');
    result.forEach(r => {
        console.log(`${r.person_name} (${r.person_id})`);
        console.log(`  Kind: ${r.kind}`);
        if (r.rep_id) {
            console.log(`  Representative: ${r.rep_name} (${r.rep_id})`);
        }
        if (r.thread_id) {
            console.log(`  Thread exists: Yes (${r.thread_id})`);
        } else if (r.kind === 'customer') {
            console.log(`  Thread exists: ❌ NO - NEEDS THREAD!`);
        }
        console.log('');
    });

    // Check for call sessions
    const sarah = result.find(r => r.person_name.includes('Sarah'));
    const kristin = result.find(r => r.person_name.includes('Kristin'));

    if (sarah && kristin) {
        const sessions = await sql`
            SELECT * FROM call_sessions 
            WHERE (fr_person_id = ${kristin.person_id} AND customer_person_id = ${sarah.person_id})
               OR (fr_person_id = ${sarah.person_id} AND customer_person_id = ${kristin.person_id})
        `;

        console.log(`📞 Call sessions: ${sessions.length}`);
        if (sessions.length > 0) {
            sessions.forEach(s => {
                console.log(`  Room: ${s.room_code}, Status: ${s.status}`);
            });
        }
    }

    console.log('\n💡 For video calls to work:');
    console.log('   1. ✅ Sarah must be Kristin\'s client (rep_id set)');
    console.log('   2. ✅ A thread must exist between them');
    console.log('   3. ✅ Both join the call at same time');
    console.log('   4. ✅ Representative (Kristin) must be the "offerer"\n');
}

main().catch(console.error);
