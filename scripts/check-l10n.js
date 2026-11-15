// Cross-checks l10n bundle keys against keys actually used in compiled code.
// Run after compiling: `npm run compile && npm run check-l10n`.
// Gate for contributors: every t('...') literal in out/*.js must have an
// entry in every l10n/bundle.l10n.<locale>.json, and bundles must not carry
// dead keys.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['extension.js', 'applier.js', 'parser.js', 'decorations.js', 'view.js'];

let code = '';
for (const f of files) {
  const p = path.join(root, 'out', f);
  if (!fs.existsSync(p)) {
    console.error(`out/${f} not found — run \`npm run compile\` first.`);
    process.exit(1);
  }
  code += fs.readFileSync(p, 'utf8');
}

const used = new Set();
// literal string passed to l10n.t(...) or its alias t(...)
for (const m of code.matchAll(/\bl10n\.t\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g)) {
  used.add(m[2]);
}
for (const m of code.matchAll(/(?<![.\w])t\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g)) {
  used.add(m[2]);
}

console.log('keys referenced in code:', used.size);
let bad = 0;
for (const f of fs.readdirSync(path.join(root, 'l10n'))) {
  if (!f.endsWith('.json')) continue;
  const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', f), 'utf8'));
  const missing = [...used].filter((k) => !(k in bundle));
  const extra = Object.keys(bundle).filter((k) => !used.has(k));
  console.log(f, '| missing:', missing.length, '| extra:', extra.length);
  if (missing.length) console.log('  MISSING:', JSON.stringify(missing));
  if (extra.length) console.log('  EXTRA:', JSON.stringify(extra));
  bad += missing.length + extra.length;
}
console.log(bad === 0 ? 'ALL KEYSETS MATCH' : 'MISMATCHES FOUND: ' + bad);
process.exitCode = bad === 0 ? 0 : 1;
