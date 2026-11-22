// Writable in-memory file system backing the RIGHT side of a patch preview
// diff (`ai-patch-mem:` URIs). The previous right side was a
// TextDocumentContentProvider, which VS Code serves read-only by design —
// "Cannot edit in read-only editor". A FileSystemProvider that implements
// writeFile makes the diff editor editable, so the user can touch up the
// AI's code before accepting; the edited text flows into
// PreparedChange.newContent via review.ts's onDidChangeTextDocument wiring.
// The LEFT side keeps the read-only provider on purpose: undo snapshots
// store originalContent verbatim, so the original side must not be editable.
import * as vscode from 'vscode';

export const MEMFS_SCHEME = 'ai-patch-mem';

const contents = new Map<string, Uint8Array>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PatchFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  stat(uri: vscode.Uri): vscode.FileStat {
    const data = this.readData(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: data.byteLength };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return this.readData(uri);
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void {
    const key = uri.toString();
    const existing = contents.get(key);
    if (existing && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!existing && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    contents.set(key, content);
    this.emitter.fire([
      {
        uri,
        type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
      },
    ]);
  }

  delete(uri: vscode.Uri): void {
    if (!contents.delete(uri.toString())) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.emitter.fire([{ uri, type: vscode.FileChangeType.Deleted }]);
  }

  // Flat virtual fs: files live at the scheme root, no directories or moves.
  readDirectory(): Array<[string, vscode.FileType]> {
    throw vscode.FileSystemError.FileNotFound(vscode.Uri.parse(`${MEMFS_SCHEME}:/`));
  }

  createDirectory(): void {
    // Nothing to create — writeFile seeds the entry itself.
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  watch(): vscode.Disposable {
    // No watchers on virtual preview content.
    return { dispose: () => {} };
  }

  private readData(uri: vscode.Uri): Uint8Array {
    const data = contents.get(uri.toString());
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }
}

export function makeEditableUri(file: string, content: string): vscode.Uri {
  // Same slug as the read-only preview: extension preserved so VS Code
  // infers the language from the path; query keeps re-previews unique.
  const slug = file.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uri = vscode.Uri.parse(
    `${MEMFS_SCHEME}:/${slug}?ts=${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  contents.set(uri.toString(), encoder.encode(content));
  return uri;
}

export function clearEditable(): void {
  contents.clear();
}
