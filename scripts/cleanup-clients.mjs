/* =============================================================================
   scripts/cleanup-clients.mjs  -  Clean up generated clients
   -----------------------------------------------------------------------------
   Removes all generated clients (cus-gen-*) but keeps original demo clients.
   Then regenerates exactly 200 new clients.

   Usage:
     node scripts/cleanup-clients.mjs

   ============================================================================= */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables manually
const envPath = join(process.cwd(), '.env.local');
try {
    const envFile = readFileSync(envPath, 'utf-8');
    envFile.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const eqIndex = trimmed.indexOf('=');
            const key = trimmed.substring(0, eqIndex).trim();
            let value = trimmed.substring(eqIndex + 1).trim();
            value = value.replace(/^["']|["']$/g, '');
            if (key) {
                process.env[key] = value;
            }
        }
    });
    console.log('✓ Loaded environment variables from .env.local');
} catch (err) {
    console.error('❌ Could not load .env.local:', err.message);
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in .env.local');
    process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function main() {
    console.log('\n🧹 Cleaning up generated clients...\n');

    // First, count how many we have
    const countResult = await sql`
        SELECT COUNT(*) as total
        FROM people
        WHERE id LIKE 'cus-gen-%'
    `;

    const currentCount = parseInt(countResult[0].total);
    console.log(`Found ${currentCount} generated clients`);

    if (currentCount === 0) {
        console.log('✓ No generated clients to remove');
        return;
    }

    console.log(`Removing all ${currentCount} generated clients...`);

    // Delete threads first (foreign key dependency)
    await sql`
        DELETE FROM threads
        WHERE customer_person_id LIKE 'cus-gen-%'
    `;

    // Delete accounts (will cascade to other tables)
    await sql`
        DELETE FROM accounts
        WHERE person_id LIKE 'cus-gen-%'
    `;

    // Delete people
    await sql`
        DELETE FROM people
        WHERE id LIKE 'cus-gen-%'
    `;

    console.log(`✓ Removed ${currentCount} generated clients`);

    // Check what's left
    const remainingResult = await sql`
        SELECT COUNT(*) as total
        FROM people
        WHERE kind = 'customer' AND rep_id = 'fr-001'
    `;

    const remaining = parseInt(remainingResult[0].total);
    console.log(`✓ Kristin now has ${remaining} clients (demo clients only)`);
    console.log(`\n✅ Cleanup complete!\n`);
    console.log(`To generate exactly 200 new clients, run:`);
    console.log(`  node scripts/generate-clients.mjs\n`);
}

main().catch((err) => {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
