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

  // VS Code saves documents asynchronously — poll the file instead of a
  // single read so the checks do not race the write.
  const waitForFile = async (path, predicate, timeoutMs = 5000) => {
    const t0 = Date.now();
    for (;;) {
      if (predicate(fs.readFileSync(path, 'utf8'))) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  let ext = vscode.extensions.getExtension('undefined_publisher.ai-patch-apply');
  if (!ext) ext = vscode.extensions.all.find((e) => /ai-patch-apply/.test(e.id));
  ok('extension found', !!ext);
  if (ext && !ext.isActive) await ext.activate();
  ok('extension activated', !!(ext && ext.isActive));

  // History checks need clean runs recorded too — switch to `all` for the
  // main flow, then verify the default `failuresOnly` filtering below.
  const cfg = vscode.workspace.getConfiguration('aiPatch');
  await cfg.update('patchHistory', 'all', vscode.ConfigurationTarget.Global);

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

  // Resumable review: mid-review the pending edits are persisted and
  // restorable (after a reload, activate() runs the same restore path).
  const restored = await vscode.commands.executeCommand('aiPatchApply.restorePendingReview');
  ok('pending review persisted and restorable', restored === 1);
  let diffTabs = 0;
  for (const g of vscode.window.tabGroups.all) {
    for (const tab of g.tabs) {
      const l = typeof tab.label === 'string' ? tab.label : '';
      if (l.startsWith('🟣') || l.startsWith('🔵') || l.startsWith('🔴')) diffTabs++;
    }
  }
  ok('restore re-opened the diff tabs', diffTabs >= 1);

  await vscode.commands.executeCommand('aiPatchApply.applyPending');
  ok(
    'apply flow modified the file on disk',
    await waitForFile(file, (t) => t.includes('Hi, ${name}!')),
  );

  // Undo restores the original byte-for-byte
  await vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
  ok(
    'undo restored the original content',
    await waitForFile(file, (t) => t === ORIGINAL),
  );

  // Redo re-applies the patch; the second undo restores the original again.
  await vscode.commands.executeCommand('aiPatchApply.redoLastPatch');
  ok(
    'redo re-applied the patch',
    await waitForFile(file, (t) => t.includes('Hi, ${name}!')),
  );
  await vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
  ok(
    'second undo restored the original',
    await waitForFile(file, (t) => t === ORIGINAL),
  );

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
  ok('file untouched on failure', await waitForFile(file, (t) => t === ORIGINAL));

  // Patch history: the flow above must have produced prepare, apply and
  // undo entries; Show History opens them as an untitled Markdown document.
  const showHistoryText = async (waitMs = 500) => {
    await vscode.commands.executeCommand('aiPatchApply.showHistory');
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.getText()
      : '';
  };
  const hist = await showHistoryText();
  ok('Show History opened a document', hist.includes('AI Patch Apply — history'));
  ok(
    'history recorded prepare / apply / undo',
    hist.includes('prepare:') && hist.includes('apply:') && hist.includes('undo:'),
  );
  ok('history shows the failure reason', hist.includes('BEFORE not found in file'));
  ok('history records the match strategy', hist.includes('matched: exact ×'));
  ok('history stores the failed BEFORE fragment', hist.includes("console.log('GOODBYE ' + name);"));

  // failuresOnly mode (the default): clean runs are not recorded, failures are.
  const countEntries = (md) => {
    const m = md.match(/(\d+) entries/);
    return m ? parseInt(m[1], 10) : -1;
  };
  const nAll = countEntries(hist);
  ok('journal entry count parsed', nAll >= 3);

  await cfg.update('patchHistory', 'failuresOnly', vscode.ConfigurationTarget.Global);
  await vscode.env.clipboard.writeText(SAMPLE);
  await vscode.commands.executeCommand('aiPatchApply.applyFromClipboard');
  await vscode.commands.executeCommand('aiPatchApply.applyPending');
  // Restore the original content so the BAD sample below fails again —
  // against the AFTER version it would count as "already applied".
  await vscode.commands.executeCommand('aiPatchApply.undoLastPatch');
  const hist2 = await showHistoryText();
  ok(
    'failuresOnly: clean run and undo not recorded',
    countEntries(hist2) === nAll,
  );
  await vscode.env.clipboard.writeText(BAD);
  await vscode.commands.executeCommand('aiPatchApply.applyFromClipboard');
  const hist3 = await showHistoryText();
  ok(
    'failuresOnly: failure recorded with fragments',
    countEntries(hist3) === nAll + 1 && hist3.includes("console.log('GOODBYE ' + name);"),
  );

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name);
    if (!pass) failed++;
  }
  console.log(failed === 0 ? 'ALL CHECKS PASSED (' + checks.length + ')' : failed + ' CHECKS FAILED');
  if (failed > 0) process.exitCode = 1;
}

module.exports = { run: main };
