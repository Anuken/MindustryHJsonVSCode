import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Indexes the mod's own content files (items/, blocks/, liquids/, planets/,
 * sectors/, status/, units/, weathers/ - as configured by
 * `mindustryHjson.contentTypeFolders`) so that bare-string references to
 * content (e.g. `liquid: water`, a bullet's `status: burning`, an item in a
 * `Seq<Item>` field, or an `ObjectMap<Item, float>` key) can be
 * autocompleted, hovered, and jumped-to.
 *
 * A content's *name* is its file's base name (without the .hjson
 * extension), regardless of how deeply nested the file is under its type
 * folder - this matches how Mindustry mods actually name content.
 */
export class ContentIndex {
	/** simple type name (e.g. "Item") -> content name -> file URIs (usually one, but nothing stops duplicates). */
	private byType = new Map<string, Map<string, vscode.Uri[]>>();

	/** Names known for a given content simple type name, e.g. "Item" -> ["copper", "lead", ...]. */
	namesFor(type: string): string[] {
		const m = this.byType.get(type);
		return m ? [...m.keys()].sort() : [];
	}

	/** File locations for a given content simple type name + name, e.g. ("Item", "copper"). */
	lookup(type: string, name: string): vscode.Uri[] {
		return this.byType.get(type)?.get(name) ?? [];
	}

	clear() {
		this.byType.clear();
	}

	/** Rebuilds the whole index from scratch by scanning the workspace. */
	async refresh(contentTypeFolders: Record<string, string>): Promise<void> {
		const next = new Map<string, Map<string, vscode.Uri[]>>();
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (workspaceFolders && workspaceFolders.length > 0) {
			// Invert folder->type into type->folders, since several folders could
			// (in theory, via user config) map to the same type.
			const foldersByType = new Map<string, string[]>();
			for (const [folder, type] of Object.entries(contentTypeFolders)) {
				const list = foldersByType.get(type) ?? [];
				list.push(folder);
				foldersByType.set(type, list);
			}

			for (const [type, folders] of foldersByType) {
				const nameMap = new Map<string, vscode.Uri[]>();
				for (const folder of folders) {
					for (const wsFolder of workspaceFolders) {
						const pattern = new vscode.RelativePattern(wsFolder, `**/${folder}/**/*.hjson`);
						let uris: vscode.Uri[];
						try {
							uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
						} catch {
							uris = [];
						}
						for (const uri of uris) {
							const name = path.basename(uri.fsPath, path.extname(uri.fsPath));
							const arr = nameMap.get(name) ?? [];
							arr.push(uri);
							nameMap.set(name, arr);
						}
					}
				}
				next.set(type, nameMap);
			}
		}

		this.byType = next;
	}
}
