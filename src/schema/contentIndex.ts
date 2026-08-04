import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMHJson, JvalObject } from '../parser/mhjsonParser';
import { ANY_CONTENT_TYPE_SIMPLE_NAME } from './typeResolver';

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
 *
 * Some references are written with the mod's own name prefixed, e.g.
 * `allure-wandura` for a planet whose file is just `wandura.hjson` - this
 * happens because Mindustry namespaces every piece of content by its
 * defining mod internally, and mod authors sometimes reference their own
 * content by that full namespaced id instead of the bare file name. When a
 * lookup by the name as written fails, and it starts with `<mod name>-`
 * (the mod's own `name:` from its mod.hjson/mod.json, lower-cased), it's
 * retried with that prefix stripped.
 */
export class ContentIndex {
	/** simple type name (e.g. "Item") -> content name -> file URIs (usually one, but nothing stops duplicates). */
	private byType = new Map<string, Map<string, vscode.Uri[]>>();
	/** This mod's own `name:` from mod.hjson/mod.json, lower-cased - used to strip a self-referential `modname-` prefix on lookup misses. */
	private modName: string | undefined;

	/**
	 * Names known for a given content simple type name, e.g. "Item" ->
	 * ["copper", "lead", ...]. Passing ANY_CONTENT_TYPE_SIMPLE_NAME
	 * ("UnlockableContent") returns the union of names across every content
	 * type - for fields declared as the abstract UnlockableContent base,
	 * which accept any kind of content.
	 */
	namesFor(type: string): string[] {
		if (type === ANY_CONTENT_TYPE_SIMPLE_NAME) return this.allNames();
		const m = this.byType.get(type);
		return m ? [...m.keys()].sort() : [];
	}

	/**
	 * File locations for a given content simple type name + name, e.g.
	 * ("Item", "copper"). Passing ANY_CONTENT_TYPE_SIMPLE_NAME
	 * ("UnlockableContent") searches every content type for that name. If
	 * `name` isn't found as written and it carries this mod's own name as a
	 * prefix (e.g. "allure-wandura" for mod "allure"), retries with the
	 * prefix stripped.
	 */
	lookup(type: string, name: string): vscode.Uri[] {
		const direct = type === ANY_CONTENT_TYPE_SIMPLE_NAME ? this.lookupAny(name) : (this.byType.get(type)?.get(name) ?? []);
		if (direct.length > 0) return direct;

		const stripped = this.stripModPrefix(name);
		if (stripped === undefined) return [];
		return type === ANY_CONTENT_TYPE_SIMPLE_NAME ? this.lookupAny(stripped) : (this.byType.get(type)?.get(stripped) ?? []);
	}

	/** If `name` starts with this mod's own name + '-' (case-insensitively), returns the rest of `name` after that prefix. Undefined if there's no known mod name or `name` doesn't have it. */
	private stripModPrefix(name: string): string | undefined {
		if (!this.modName) return undefined;
		const prefix = `${this.modName}-`;
		if (name.length <= prefix.length || !name.toLowerCase().startsWith(prefix)) return undefined;
		return name.slice(prefix.length);
	}

	/** Union of every content name across all content types, deduplicated. */
	private allNames(): string[] {
		const names = new Set<string>();
		for (const m of this.byType.values()) {
			for (const name of m.keys()) names.add(name);
		}
		return [...names].sort();
	}

	/** Union of file locations for `name` across every content type. */
	private lookupAny(name: string): vscode.Uri[] {
		const uris: vscode.Uri[] = [];
		for (const m of this.byType.values()) {
			const found = m.get(name);
			if (found) uris.push(...found);
		}
		return uris;
	}

	clear() {
		this.byType.clear();
		this.modName = undefined;
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
		this.modName = findModName(workspaceFolders);
	}
}

/** Reads the mod's own `name:` field from mod.hjson or mod.json at each workspace folder's root, lower-cased. */
function findModName(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): string | undefined {
	if (!workspaceFolders) return undefined;
	for (const wsFolder of workspaceFolders) {
		for (const filename of ['mod.hjson', 'mod.json']) {
			const filePath = path.join(wsFolder.uri.fsPath, filename);
			if (!fs.existsSync(filePath)) continue;
			try {
				const text = fs.readFileSync(filePath, 'utf8');
				const parse = parseMHJson(text);
				if (!parse.root || parse.root.type !== 'object') continue;
				for (const member of (parse.root as JvalObject).entries) {
					if (member.key === 'name' && member.value.type === 'string') {
						return (member.value as any).value.toLowerCase();
					}
				}
			} catch {
				// unreadable or malformed - try the next candidate file
			}
		}
	}
	return undefined;
}