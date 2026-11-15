// Launches a real VS Code with the extension loaded and runs the checklist
// in scripts/verify-tests.js. Needs @vscode/test-electron (devDependency):
//   node scripts/verify-live.js
// Works locally and in CI (on Linux run it under xvfb-run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  // Throwaway workspace folder — the test writes and reverts a file there.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-patch-test-'));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'scripts', 'verify-tests.js'),
      launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust'],
    });
    console.log('host run finished');
  } catch (err) {
    console.error('HOST RUN FAILED:', (err && err.message) || err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
main();
