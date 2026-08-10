import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Indexes the mod's own custom sound assets: any `.ogg` or `.mp3` file found
 * anywhere under a `sounds/` folder, recursively, keyed by its base file
 * name (without extension) - the same "name is the file's base name
 * regardless of nesting depth" convention ContentIndex uses for content.
 *
 * Unlike Effects (which mods only ever get via a vanilla name or an inline
 * custom Effect object - there's no "effects/" asset folder convention),
 * mods commonly ship their own sound files with no naming prefix, referenced
 * by bare file name from `shootSound:`/`sound:`-style fields. So a Sound
 * field's string value is only "unknown" when it matches neither a vanilla
 * name (see NameListIndex over schemas/allSounds.json) nor one of these
 * files.
 */
export class SoundIndex {
	/** sound name (file base name) -> file URIs (usually one, but nothing stops duplicates/multiple mods). */
	private byName = new Map<string, vscode.Uri[]>();

	/** Names known from the mod's own sounds/ folder(s) - for completion. */
	namesFor(): string[] {
		return [...this.byName.keys()].sort();
	}

	/** True if `name` matches a sound file found under a sounds/ folder. */
	has(name: string): boolean {
		return this.byName.has(name);
	}

	/** File locations for a given sound name. */
	lookup(name: string): vscode.Uri[] {
		return this.byName.get(name) ?? [];
	}

	clear() {
		this.byName.clear();
	}

	/** Rebuilds the whole index from scratch by scanning the workspace's sounds/ folder(s). */
	async refresh(): Promise<void> {
		const next = new Map<string, vscode.Uri[]>();
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (workspaceFolders && workspaceFolders.length > 0) {
			for (const wsFolder of workspaceFolders) {
				const pattern = new vscode.RelativePattern(wsFolder, '**/sounds/**/*.{ogg,mp3}');
				let uris: vscode.Uri[];
				try {
					uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
				} catch {
					uris = [];
				}
				for (const uri of uris) {
					const name = path.basename(uri.fsPath, path.extname(uri.fsPath));
					const arr = next.get(name) ?? [];
					arr.push(uri);
					next.set(name, arr);
				}
			}
		}

		this.byName = next;
	}
}
