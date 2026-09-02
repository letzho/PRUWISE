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
    console.log('\n🔍 Checking Active Call Sessions and Signals\n');

    // Get active call sessions
    const sessions = await sql`
        SELECT cs.id, cs.room_code, cs.status, cs.created_at,
               cs.fr_seen_at, cs.customer_seen_at,
               p1.name as fr_name, p2.name as customer_name
        FROM call_sessions cs
        JOIN people p1 ON p1.id = cs.fr_person_id
        JOIN people p2 ON p2.id = cs.customer_person_id
        WHERE cs.status = 'active'
          AND (p1.name LIKE 'Kristin%' OR p2.name LIKE 'Sarah%')
        ORDER BY cs.created_at DESC
        LIMIT 3
    `;

    if (sessions.length === 0) {
        console.log('❌ No active call sessions found!');
        console.log('   Both devices need to click "Join Call" first\n');
        return;
    }

    console.log(`✅ Found ${sessions.length} active session(s):\n`);
    
    for (const session of sessions) {
        console.log(`📞 Session: ${session.room_code}`);
        console.log(`   Status: ${session.status}`);
        console.log(`   FR: ${session.fr_name} (last seen: ${session.fr_seen_at || 'never'})`);
        console.log(`   Customer: ${session.customer_name} (last seen: ${session.customer_seen_at || 'never'})`);
        console.log(`   Created: ${session.created_at}\n`);

        // Check for signals in this room
        const signals = await sql`
            SELECT kind, created_at, consumed_at
            FROM call_signals
            WHERE room_code = ${session.room_code}
            ORDER BY created_at DESC
            LIMIT 10
        `;

        if (signals.length > 0) {
            console.log(`   📡 Recent signals (${signals.length}):`);
            signals.forEach(sig => {
                console.log(`      ${sig.kind} - ${sig.consumed_at ? '✅ consumed' : '⏳ pending'}`);
            });
        } else {
            console.log('   ⚠️  No WebRTC signals found! Connection cannot establish.');
        }
        
        // Check transcript
        const transcript = await sql`
            SELECT COUNT(*) as count
            FROM call_transcripts
            WHERE call_id = ${session.id}
        `;
        
        console.log(`   💬 Transcript lines: ${transcript[0].count}\n`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔧 TROUBLESHOOTING TIPS:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const now = new Date();
    const recentSeen = sessions.some(s => {
        const frSeen = s.fr_seen_at ? new Date(s.fr_seen_at) : null;
        const cusSeen = s.customer_seen_at ? new Date(s.customer_seen_at) : null;
        const frRecent = frSeen && (now - frSeen) < 10000;
        const cusRecent = cusSeen && (now - cusSeen) < 10000;
        return frRecent && cusRecent;
    });

    if (!recentSeen) {
        console.log('❌ ISSUE: One or both users not actively polling');
        console.log('   → Make sure BOTH devices are on the call screen');
        console.log('   → Check for JavaScript errors in browser console\n');
    }

    console.log('1️⃣  Clear old sessions and start fresh:');
    console.log('   Run: node scripts/clear-active-calls.mjs\n');
    
    console.log('2️⃣  Check browser console for errors');
    console.log('   → Press F12 on both devices');
    console.log('   → Look for red errors\n');
    
    console.log('3️⃣  Verify HTTPS (required for camera/mic)');
    console.log('   → URL must start with https://');
    console.log('   → localhost is OK for testing\n');
    
    console.log('4️⃣  Check network (WebRTC can fail on strict networks)');
    console.log('   → Try both devices on same WiFi');
    console.log('   → Avoid corporate/school networks with strict firewalls\n');
    
    console.log('5️⃣  Try the demo mode (Option 1 you chose earlier)');
    console.log('   → Shows simulated connected state');
    console.log('   → Good for presentation if WebRTC is blocked\n');
}

main().catch(console.error);
