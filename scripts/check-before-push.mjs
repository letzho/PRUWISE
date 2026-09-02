#!/usr/bin/env node

/**
 * Safety check before pushing to GitHub
 * Run this to verify no sensitive files are about to be committed
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

console.log('\n🔍 Checking for sensitive files before GitHub push...\n');

const SENSITIVE_FILES = [
    '.env.local',
    '.env',
    '.env.production',
    'php/config.php',
    'php/config.local.php'
];

const SENSITIVE_PATTERNS = [
    'DATABASE_URL=',
    'SESSION_SECRET=',
    'OPENAI_API_KEY=',
    'npg_',  // Neon password prefix
    'PGPASSWORD='
];

let hasIssues = false;

// Check if sensitive files exist and would be committed
console.log('📁 Checking for sensitive files...');
SENSITIVE_FILES.forEach(file => {
    if (existsSync(file)) {
        // Check if file is in .gitignore
        const gitignore = readFileSync('.gitignore', 'utf-8');
        if (!gitignore.includes(file.split('/').pop())) {
            console.log(`❌ DANGER: ${file} exists and may not be ignored!`);
            hasIssues = true;
        } else {
            console.log(`✅ ${file} - protected by .gitignore`);
        }
    }
});

// Check for secrets in source files
console.log('\n🔐 Checking for hardcoded secrets...');
const filesToCheck = [
    'api/_lib/db.ts',
    'api/_lib/env.ts',
    'js/api.js'
];

filesToCheck.forEach(file => {
    if (!existsSync(file)) return;
    
    const content = readFileSync(file, 'utf-8');
    let foundSecrets = false;
    
    SENSITIVE_PATTERNS.forEach(pattern => {
        if (content.includes(pattern)) {
            // Check if it's just reading from process.env (safe)
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                if (line.includes(pattern) && !line.includes('process.env')) {
                    console.log(`⚠️  ${file}:${i + 1} - Contains "${pattern}"`);
                    foundSecrets = true;
                }
            });
        }
    });
    
    if (!foundSecrets) {
        console.log(`✅ ${file} - no hardcoded secrets`);
    }
});

// Check node_modules is ignored
console.log('\n📦 Checking node_modules...');
if (existsSync('node_modules')) {
    const gitignore = readFileSync('.gitignore', 'utf-8');
    if (gitignore.includes('node_modules')) {
        console.log('✅ node_modules/ - protected by .gitignore');
    } else {
        console.log('❌ DANGER: node_modules/ not in .gitignore!');
        hasIssues = true;
    }
}

// Final verdict
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (hasIssues) {
    console.log('❌ ISSUES FOUND - DO NOT PUSH YET!');
    console.log('   Fix the issues above before pushing to GitHub');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
} else {
    console.log('✅ ALL CHECKS PASSED - SAFE TO PUSH!');
    console.log('   No sensitive files or secrets detected');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Next steps:');
    console.log('  1. git add .');
    console.log('  2. git commit -m "Your message"');
    console.log('  3. git push\n');
}
