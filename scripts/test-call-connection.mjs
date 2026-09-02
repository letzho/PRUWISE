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
    console.log('\n🔍 Testing Call Connection Readiness\n');

    // Get Sarah and Kristin
    const people = await sql`
        SELECT p.id, p.name, p.kind, p.rep_id, a.email, a.email_verified
        FROM people p
        JOIN accounts a ON a.person_id = p.id
        WHERE p.name IN ('Sarah Tan', 'Kristin Henessy')
        ORDER BY p.kind
    `;

    const sarah = people.find(p => p.name === 'Sarah Tan');
    const kristin = people.find(p => p.name === 'Kristin Henessy');

    if (!sarah || !kristin) {
        console.log('❌ Missing accounts!');
        return;
    }

    console.log('✅ ACCOUNTS READY');
    console.log(`   Kristin: ${kristin.email} (${kristin.id})`);
    console.log(`   Sarah: ${sarah.email} (${sarah.id})`);
    console.log(`   Sarah's Rep: ${sarah.rep_id === kristin.id ? '✅ Kristin' : '❌ NOT SET'}`);
    console.log('');

    // Check for old active sessions
    const oldSessions = await sql`
        SELECT id, room_code, status, created_at
        FROM call_sessions
        WHERE fr_person_id = ${kristin.id}
          AND customer_person_id = ${sarah.id}
          AND status = 'active'
    `;

    if (oldSessions.length > 0) {
        console.log('⚠️  OLD ACTIVE SESSIONS FOUND:');
        oldSessions.forEach(s => {
            console.log(`   Room: ${s.room_code} (created: ${s.created_at})`);
        });
        console.log('\n   Cleaning up old sessions...');
        
        await sql`
            UPDATE call_sessions
            SET status = 'ended', ended_at = NOW()
            WHERE fr_person_id = ${kristin.id}
              AND customer_person_id = ${sarah.id}
              AND status = 'active'
        `;
        
        console.log('   ✅ Old sessions ended\n');
    } else {
        console.log('✅ No conflicting sessions\n');
    }

    // Check upcoming appointment
    const appt = await sql`
        SELECT id, start_at, location
        FROM appointments
        WHERE customer_person_id = ${sarah.id}
          AND rep_person_id = ${kristin.id}
          AND start_at > NOW() - interval '2 hours'
        ORDER BY start_at DESC
        LIMIT 1
    `;

    if (appt.length > 0) {
        console.log('✅ APPOINTMENT FOUND');
        console.log(`   ID: ${appt[0].id}`);
        console.log(`   Time: ${appt[0].start_at}`);
        console.log(`   Location: ${appt[0].location}\n`);
    } else {
        console.log('⚠️  No recent appointment (optional but helpful)\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 TWO-DEVICE TEST:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n🖥️  DEVICE 1 (Computer):');
    console.log(`   1. Go to: ${process.env.APP_URL || 'your-vercel-url'}`);
    console.log(`   2. Login: ${kristin.email} / studkris`);
    console.log('   3. Navigate to /fr/call');
    console.log('   4. Click "Join Call"');
    console.log('   5. WAIT for Sarah to join...\n');
    
    console.log('📱 DEVICE 2 (Phone/Tablet):');
    console.log(`   1. Go to: ${process.env.APP_URL || 'your-vercel-url'}`);
    console.log(`   2. Login: ${sarah.email} / studsarah`);
    console.log('   3. Navigate to /me/call');
    console.log('   4. Click "Join Call"');
    console.log('   5. Connection should establish in 2-3 seconds\n');
    
    console.log('✅ EXPECTED RESULT:');
    console.log('   - Both see each other\'s video');
    console.log('   - Live captions appear');
    console.log('   - Timer starts counting');
    console.log('   - AI co-pilot active on Kristin\'s side only\n');
    
    console.log('⚠️  IF IT DOESN\'T CONNECT:');
    console.log('   1. Check both devices have camera/mic permissions');
    console.log('   2. Ensure both are on HTTPS (not HTTP)');
    console.log('   3. Check browser console for errors');
    console.log('   4. Try refreshing both pages and rejoining\n');
}

main().catch(console.error);
