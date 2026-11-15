import * as vscode from 'vscode';
import { PreparedChange, diffStat } from './applier';

const t = vscode.l10n.t;

// Activity Bar view: a live "Pending changes" section on top (one entry per
// file waiting in the diff tabs), quick actions below. One view on purpose —
// the whole extension is a single flow (copy → review → apply), so a tree
// with two sections reads better than two separate views.

type Node =
  | { kind: 'header'; label: string }
  | { kind: 'hint'; label: string }
  | { kind: 'pending'; change: PreparedChange }
  | { kind: 'action'; label: string; icon: string; command: string };

const ACTIONS: Node[] = [
  { kind: 'action', label: 'Apply from Clipboard', icon: '$(play)', command: 'aiPatchApply.applyFromClipboard' },
  { kind: 'action', label: 'Accept Current Diff and Go to Next', icon: '$(debug-step-over)', command: 'aiPatchApply.acceptCurrentDiff' },
  { kind: 'action', label: 'Apply Pending', icon: '$(check)', command: 'aiPatchApply.applyPending' },
  { kind: 'action', label: 'Cancel Pending', icon: '$(close)', command: 'aiPatchApply.cancelPending' },
  { kind: 'action', label: 'Copy Prompt', icon: '$(copy)', command: 'aiPatchApply.copyPrompt' },
  { kind: 'action', label: 'Copy Failed Report', icon: '$(report)', command: 'aiPatchApply.copyFailedReport' },
  { kind: 'action', label: 'Undo Last Patch', icon: '$(discard)', command: 'aiPatchApply.undoLastPatch' },
];

export class PatchViewProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private pending: PreparedChange[] | null = null;
  private treeView: vscode.TreeView<Node> | undefined;

  register(id: string): vscode.Disposable {
    this.treeView = vscode.window.createTreeView(id, {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    return this.treeView;
  }

  // Called from updateStatusBar() — the single place where pending/failed
  // state already converges, so the view cannot drift out of sync.
  setPending(pending: PreparedChange[] | null, failedCount: number): void {
    this.pending = pending;
    if (this.treeView) {
      this.treeView.badge =
        pending && pending.length > 0
          ? { value: pending.length, tooltip: t('{0} pending edits', pending.length) }
          : failedCount > 0
            ? { value: failedCount, tooltip: t('Some edits failed — copy the report for the AI.') }
            : undefined;
    }
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'header') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'aiPatchHeader';
      return item;
    }
    if (node.kind === 'hint') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'aiPatchHint';
      return item;
    }
    if (node.kind === 'pending') {
      const p = node.change;
      const item = new vscode.TreeItem(p.file, vscode.TreeItemCollapsibleState.None);
      item.description = p.isNew
        ? t('New file')
        : p.isDelete
          ? t('Deleted')
          : diffStat(p.originalContent, p.newContent);
      item.tooltip = t('Click to open diff');
      item.iconPath = new vscode.ThemeIcon(p.isNew ? 'new-file' : p.isDelete ? 'trash' : 'diff');
      item.command = {
        command: 'aiPatchApply.openPending',
        title: t('Open diff'),
        arguments: [p],
      };
      item.contextValue = 'aiPatchPending';
      return item;
    }
    const item = new vscode.TreeItem(`${node.icon} ${node.label}`, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'aiPatchAction';
    item.command = { command: node.command, title: node.label };
    return item;
  }

  getChildren(): Node[] {
    const nodes: Node[] = [];

    const hasPending = !!this.pending && this.pending.length > 0;
    nodes.push({
      kind: 'header',
      label: hasPending
        ? t('Pending changes ({0})', this.pending!.length)
        : t('Pending changes'),
    });
    if (hasPending) {
      for (const p of this.pending!) nodes.push({ kind: 'pending', change: p });
    } else {
      nodes.push({ kind: 'hint', label: t('No pending edits') });
    }

    nodes.push({ kind: 'header', label: t('Actions') });
    nodes.push(...ACTIONS);
    return nodes;
  }
}
