// Live checklist, executed inside the Extension Development Host.
// Covers: activation, command wiring, Copy Prompt, the full apply flow
// (clipboard -> prepare -> preview -> commit -> disk), undo, the
// failure-report path, and the patch-history journal.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ORIGINAL = "function greet(name) {\n  console.log('Hello, ' + name);\n}\n";

const SAMPLE = [
  '**Location:** File: `hello.js` | Function: `greet`',
  '',
  '**BEFORE:**',
  '```js',
  'function greet(name) {',
  "  console.log('Hello, ' + name);",
  '}',
  '```',
  '',
  '**AFTER:**',
  '```js',
  'function greet(name) {',
  '  console.log(`Hi, ${name}!`);',
  '}',
  '```',
].join('\n');

async function main() {
  const checks = [];
  const ok = (name, cond) => checks.push([name, !!cond]);

  let ext = vscode.extensions.getExtension('undefined_publisher.ai-patch-apply');
  if (!ext) ext = vscode.extensions.all.find((e) => /ai-patch-apply/.test(e.id));
  ok('extension found', !!ext);
  if (ext && !ext.isActive) await ext.activate();
  ok('extension activated', !!(ext && ext.isActive));

  const cmds = await vscode.commands.getCommands(true);
  for (const id of [
    'aiPatchApply.applyFromClipboard',
    'aiPatchApply.applyPending',
    'aiPatchApply.cancelPending',
    'aiPatchApply.copyFailedReport',
    'aiPatchApply.clearFailedReport',
    'aiPatchApply.copyPrompt',
    'aiPatchApply.undoLastPatch',
    'aiPatchApply.acceptCurrentDiff',
    'aiPatchApply.openPending',
    'aiPatchApply.showHistory',
  ]) {
    ok('command registered: ' + id, cmds.includes(id));
  }

  // Copy Prompt
  await vscode.commands.executeCommand('aiPatchApply.copyPrompt');
  let clip = await vscode.env.clipboard.readText();
  ok('Copy Prompt -> clipboard holds the template', clip.includes('**Location:**') && clip.length > 2000);

  // Success path: prepare -> preview -> apply -> disk
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const file = path.join(ws, 'hello.js');
  fs.writeFileSync(file, ORIGINAL);
  await vscode.env.clipboard.writeText(SAMPLE);
  await vscode.commands.executeCommand('aiPatchApply.applyFromClipboard');
  await vscode.commands.executeCommand('aiPatchApply.applyPending');
  const after = fs.readFileSync(file, 'utf8');
  ok('apply flow modified the file on disk', after.includes('Hi, ${name}!'));

  // Undo restores the original byte-for-byte
  await vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
  const undone = fs.readFileSync(file, 'utf8');
  ok('undo restored the original content', undone === ORIGINAL);

  // Failure path: BEFORE that does not exist -> report, not a silent no-op
  const BAD = SAMPLE.replace("console.log('Hello, ' + name);", "console.log('GOODBYE ' + name);");
  await vscode.env.clipboard.writeText(BAD);
  await vscode.commands.executeCommand('aiPatchApply.applyFromClipboard');
  await vscode.commands.executeCommand('aiPatchApply.copyFailedReport');
  clip = await vscode.env.clipboard.readText();
  ok(
    'failed BEFORE -> report on clipboard (reason + current content)',
    clip.includes('please regenerate') && clip.includes('hello.js') && clip.includes('GOODBYE'),
  );
  ok('file untouched on failure', fs.readFileSync(file, 'utf8') === ORIGINAL);

  // Patch history: the flow above must have produced prepare, apply and
  // undo entries; Show History opens them as an untitled Markdown document.
  await vscode.commands.executeCommand('aiPatchApply.showHistory');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const hist = vscode.window.activeTextEditor
    ? vscode.window.activeTextEditor.document.getText()
    : '';
  ok('Show History opened a document', hist.includes('AI Patch Apply — history'));
  ok(
    'history recorded prepare / apply / undo',
    hist.includes('prepare:') && hist.includes('apply:') && hist.includes('undo:'),
  );
  ok('history shows the failure reason', hist.includes('BEFORE not found in file'));
  ok('history records the match strategy', hist.includes('matched: exact ×'));

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name);
    if (!pass) failed++;
  }
  console.log(failed === 0 ? 'ALL CHECKS PASSED (' + checks.length + ')' : failed + ' CHECKS FAILED');
  if (failed > 0) process.exitCode = 1;
}

module.exports = { run: main };
