import * as vscode from 'vscode';
import { PreparedChange } from './applier';

type PatchState = 'modified' | 'new' | 'deleted';

export class PatchDecorationProvider implements vscode.FileDecorationProvider {
  private state = new Map<string, PatchState>();
  private gitCache = new Map<string, boolean>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  async setFromPrepared(prepared: PreparedChange[]): Promise<void> {
    const changed = this.collectUris();
    this.state.clear();

    for (const p of prepared) {
      if (p.isDelete) {
        if (await this.isUnderGit(p.uri)) continue;
        this.state.set(p.uri.toString(), 'deleted');
        changed.push(p.uri);
      } else if (p.isNew) {
        const parent = await closestExistingParent(p.uri);
        if (!parent) continue;
        if (await this.isUnderGit(parent)) continue;
        this.state.set(parent.toString(), 'new');
        changed.push(parent);
      } else {
        if (await this.isUnderGit(p.uri)) continue;
        this.state.set(p.uri.toString(), 'modified');
        changed.push(p.uri);
      }
    }
    this._onDidChange.fire(changed);
  }

  clear(): void {
    const changed = this.collectUris();
    this.state.clear();
    if (changed.length > 0) this._onDidChange.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const s = this.state.get(uri.toString());
    if (!s) return undefined;
    if (s === 'new') {
      return {
        badge: '+',
        color: new vscode.ThemeColor('charts.blue'),
        tooltip: 'Will create new file here',
      };
    }
    if (s === 'deleted') {
      return {
        badge: '✗',
        color: new vscode.ThemeColor('charts.red'),
        tooltip: 'Will be deleted',
      };
    }
    return {
      badge: '✎',
      color: new vscode.ThemeColor('charts.purple'),
      tooltip: 'Will be modified',
    };
  }

  private collectUris(): vscode.Uri[] {
    return Array.from(this.state.keys()).map((s) => vscode.Uri.parse(s));
  }

  private async isUnderGit(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return false;
    const key = folder.uri.toString();
    const cached = this.gitCache.get(key);
    if (cached !== undefined) return cached;
    const gitDir = vscode.Uri.joinPath(folder.uri, '.git');
    let result = false;
    try {
      await vscode.workspace.fs.stat(gitDir);
      result = true;
    } catch {
      result = false;
    }
    this.gitCache.set(key, result);
    return result;
  }
}

async function closestExistingParent(
  uri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  let current = vscode.Uri.joinPath(uri, '..');
  for (let i = 0; i < 10; i++) {
    try {
      const stat = await vscode.workspace.fs.stat(current);
      if (stat.type === vscode.FileType.Directory) return current;
    } catch {
      // move up
    }
    const next = vscode.Uri.joinPath(current, '..');
    if (next.toString() === current.toString()) return undefined;
    current = next;
  }
  return undefined;
}