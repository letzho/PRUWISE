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
    console.log('\n🧹 Clearing all active call sessions...\n');

    const result = await sql`
        UPDATE call_sessions
        SET status = 'ended', ended_at = NOW()
        WHERE status = 'active'
        RETURNING room_code
    `;

    if (result.length > 0) {
        console.log(`✅ Ended ${result.length} active session(s):`);
        result.forEach(r => console.log(`   - ${r.room_code}`));
    } else {
        console.log('✅ No active sessions to clear');
    }

    console.log('\n💡 Now try joining the call again on both devices\n');
}

main().catch(console.error);
