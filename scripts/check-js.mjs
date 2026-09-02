/* Throwaway: parses every browser script and reports leftover references.

   js/ is plain ES5 + jQuery and is deliberately excluded from tsconfig, so a
   syntax error in it would otherwise only surface as a blank page in the browser
   after a deploy. `new Function` compiles without executing, which is exactly the
   check wanted here - no DOM, no jQuery, no side effects. */

import { readFileSync, readdirSync } from 'node:fs';

const files = readdirSync('js').filter((f) => f.endsWith('.js'));

let bad = 0;

for (const file of files) {
    const source = readFileSync(`js/${file}`, 'utf8');

    try {
        new Function(source);
        console.log(`ok    js/${file} parses`);
    } catch (error) {
        bad++;
        console.log(`FAIL  js/${file}: ${error.message}`);
    }
}

/* Nothing may still point at the removed simulator. */
const all = files.map((f) => readFileSync(`js/${f}`, 'utf8')).join('\n')
    + readFileSync('index.html', 'utf8');

const gone = ['/fr/simulation', 'SIM_SCENARIOS', 'runSimulation', 'simSlider',
    'simDefaults', 'renderSimResults', 'sim-input', 'sim-scenario', 'sim-reset',
    'sim-customer', 'STATE.sim', 'Run simulation', 'Simulate this',
    'Open the simulator', 'Scenario simulation'];

console.log('');

for (const name of gone) {
    const n = all.split(name).length - 1;
    if (n > 0) { bad++; }
    console.log(`${n === 0 ? 'ok  ' : 'LEFT'}  ${name}: ${n}`);
}

/* And the things that must still be present after this round of edits. */
const wanted = [
    ['demoBlock', 'demo sign-in block'],
    ['data-act="demo-login"', 'demo sign-in handler hook'],
    ['thread-call', 'labelled video call button in chat'],
    ['suggest-btn', 'real Refresh/Hide buttons'],
    ['appt-consult', 'Consult button on appointment cards'],
    ['openWith: openWith', 'MESSAGES.openWith is exported'],
    ['wantPerson', 'firstSpec honours an explicit person'],
    ['pageIsHidden', 'polling pauses when the tab is hidden']
];

console.log('');

for (const [needle, label] of wanted) {
    const n = all.split(needle).length - 1;
    if (n === 0) { bad++; }
    console.log(`${n > 0 ? 'ok  ' : 'MISS'}  ${label}`);
}

console.log(bad === 0 ? '\nJS OK' : `\n${bad} PROBLEM(S)`);
process.exit(bad === 0 ? 0 : 1);
