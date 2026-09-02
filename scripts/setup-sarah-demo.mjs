/* =============================================================================
   Complete Sarah setup for demo
   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment correctly
const envFile = readFileSync(join(process.cwd(), '.env.local'), 'utf-8');
envFile.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // Remove quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && value) process.env[key] = value;
    }
});

const sql = neon(process.env.DATABASE_URL);

async function main() {
    console.log('\n🎯 Setting up Sarah for demo...\n');

    // Get Sarah and Kristin
    const people = await sql`
        SELECT id, name, kind 
        FROM people 
        WHERE (name LIKE 'Sarah%' AND kind = 'customer') 
           OR (name LIKE 'Kristin%' AND kind = 'fr')
    `;

    const sarah = people.find(p => p.kind === 'customer');
    const kristin = people.find(p => p.kind === 'fr');

    if (!sarah || !kristin) {
        console.error('❌ Could not find Sarah or Kristin');
        process.exit(1);
    }

    console.log(`Found: ${sarah.name} and ${kristin.name}`);

    // Create appointment for 3 hours from now (so it shows in "today" section)
    const appointmentTime = new Date();
    appointmentTime.setHours(appointmentTime.getHours() + 3);
    
    const apptId = `appt-sarah-${Date.now()}`;
    
    await sql`
        INSERT INTO appointments 
            (id, customer_person_id, rep_person_id, title, type, mode, 
             start_at, minutes, status, ics_uid, created_at)
        VALUES 
            (${apptId}, ${sarah.id}, ${kristin.id}, 
             'Financial Review with Sarah Tan', 'review', 'video',
             ${appointmentTime.toISOString()}, 45, 'confirmed',
             ${apptId}, now())
        ON CONFLICT (id) DO UPDATE SET
            start_at = EXCLUDED.start_at,
            status = 'confirmed'
    `;

    console.log(`\n✅ Created appointment:`);
    console.log(`   📅 Time: ${appointmentTime.toLocaleTimeString()} today`);
    console.log(`   👤 With: ${sarah.name}`);
    console.log(`   📍 Mode: Video call`);
    console.log(`   ⏱️  Duration: 45 minutes`);

    console.log('\n✨ When you login as Kristin, you\'ll see:');
    console.log(`   "${sarah.name} in X minutes"`);
    console.log(`   (instead of "A client in X minutes")\n`);
    
    console.log('🚀 Now deploy with deploy-vercel.bat and hard refresh!\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
