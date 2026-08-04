import * as fs from 'fs';
import * as path from 'path';
import { shortName } from './typeResolver';

/**
 * Indexes vanilla Mindustry content (built-in items, blocks, liquids,
 * units, ...) from the `allContent.json` file bundled in the schemas
 * directory, so that content references which aren't found in the mod's own
 * content folders (see ContentIndex) can still be recognized as valid,
 * rather than being flagged as unknown.
 *
 * allContent.json looks like:
 *   { "item": ["copper", "lead", ...], "block": [...], ...,
 *     "mappings": { "item": "mindustry.type.Item", "block": "mindustry.world.Block", ... } }
 *
 * The array keys ("item", "block", ...) are lower-case category names; the
 * `mappings` object converts each to the FQCN whose simple name (e.g.
 * "Item", "Block") is what the rest of the extension (CONTENT_TYPE_SIMPLE_NAMES)
 * uses to key content types. This class re-keys everything by that simple name.
 *
 * Unlike ContentIndex, there's no file location to jump to for vanilla
 * content - it isn't part of the mod - so this index only supports
 * name lookup/completion, not go-to-definition.
 */
export class VanillaContentIndex {
	/** simple type name (e.g. "Item") -> set of vanilla content names. */
	private byType = new Map<string, Set<string>>();
	loaded = false;

	/** Names known for a given content simple type name, e.g. "Item" -> ["copper", "lead", ...]. */
	namesFor(type: string): string[] {
		const s = this.byType.get(type);
		return s ? [...s].sort() : [];
	}

	/** True if `name` is known vanilla content of the given simple type name. */
	has(type: string, name: string): boolean {
		return this.byType.get(type)?.has(name) ?? false;
	}

	clear() {
		this.byType.clear();
		this.loaded = false;
	}

	/** Loads `allContent.json` from `schemaFolder`, if present. No-op (leaves the index empty) if the file doesn't exist or fails to parse. */
	load(schemaFolder: string) {
		this.clear();
		const file = path.join(schemaFolder, 'allContent.json');
		if (!fs.existsSync(file)) return;
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			const mappings: Record<string, string> = raw.mappings ?? {};
			for (const [key, fqcn] of Object.entries(mappings)) {
				const names = raw[key];
				if (!Array.isArray(names)) continue;
				const simple = shortName(fqcn);
				const set = this.byType.get(simple) ?? new Set<string>();
				for (const name of names) set.add(String(name));
				this.byType.set(simple, set);
			}
			this.loaded = true;
		} catch {
			// unreadable or malformed - leave the index empty
		}
	}
}
