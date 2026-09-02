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
    console.log('\n🔍 Checking Video Call Readiness...\n');

    // Check Sarah's credentials
    const sarah = await sql`
        SELECT p.id, p.name, p.kind, p.rep_id, a.email, a.email_verified
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        WHERE p.name LIKE 'Sarah%'
        LIMIT 1
    `;

    if (sarah.length === 0) {
        console.log('❌ Sarah not found!');
        return;
    }

    console.log('✅ Sarah Account:');
    console.log(`   Email: ${sarah[0].email}`);
    console.log(`   Email Verified: ${sarah[0].email_verified ? 'Yes' : 'No'}`);
    console.log(`   Person ID: ${sarah[0].id}`);
    console.log(`   Rep ID: ${sarah[0].rep_id || 'NOT SET ❌'}`);
    console.log('');

    // Check Kristin
    const kristin = await sql`
        SELECT p.id, p.name, p.kind, a.email
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        WHERE p.name LIKE 'Kristin%'
        LIMIT 1
    `;

    if (kristin.length === 0) {
        console.log('❌ Kristin not found!');
        return;
    }

    console.log('✅ Kristin Account:');
    console.log(`   Email: ${kristin[0].email}`);
    console.log(`   Person ID: ${kristin[0].id}`);
    console.log('');

    // Check thread between them
    const thread = await sql`
        SELECT id, kind, created_at
        FROM threads
        WHERE customer_person_id = ${sarah[0].id}
          AND fr_person_id = ${kristin[0].id}
    `;

    if (thread.length === 0) {
        console.log('❌ No thread found between Sarah and Kristin!');
    } else {
        console.log('✅ Thread exists:');
        console.log(`   Thread ID: ${thread[0].id}`);
        console.log(`   Type: ${thread[0].kind}`);
        console.log('');
    }

    // Check active call sessions
    const activeCalls = await sql`
        SELECT room_code, status, created_at
        FROM call_sessions
        WHERE fr_person_id = ${kristin[0].id}
          AND customer_person_id = ${sarah[0].id}
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
    `;

    if (activeCalls.length > 0) {
        console.log('⚠️  Active Call Session Found:');
        console.log(`   Room: ${activeCalls[0].room_code}`);
        console.log(`   Status: ${activeCalls[0].status}`);
        console.log('   You may need to end this before starting a fresh call');
        console.log('');
    }

    // Check upcoming appointment
    const appointment = await sql`
        SELECT id, scheduled_for, location
        FROM appointments
        WHERE customer_person_id = ${sarah[0].id}
          AND rep_person_id = ${kristin[0].id}
          AND scheduled_for > now() - interval '1 hour'
        ORDER BY scheduled_for DESC
        LIMIT 1
    `;

    if (appointment.length > 0) {
        console.log('✅ Upcoming Appointment:');
        console.log(`   ID: ${appointment[0].id}`);
        console.log(`   Time: ${appointment[0].scheduled_for}`);
        console.log(`   Location: ${appointment[0].location}`);
    } else {
        console.log('⚠️  No upcoming appointment found');
        console.log('   (Not required, but helps for demo)');
    }

    console.log('\n📱 Two-Device Demo Instructions:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Device 1 (Computer): Login as Kristin');
    console.log(`   Email: ${kristin[0].email}`);
    console.log('   Go to /fr/call and start the call');
    console.log('');
    console.log('Device 2 (Phone): Login as Sarah');
    console.log(`   Email: ${sarah[0].email}`);
    console.log('   Go to /me/call and join');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(console.error);
