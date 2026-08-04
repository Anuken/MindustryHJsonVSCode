import * as fs from 'fs';
import * as path from 'path';
import { shortName, ANY_CONTENT_TYPE_SIMPLE_NAME } from './typeResolver';

/**
 * Indexes vanilla Mindustry content (built-in items, blocks, liquids,
 * units, ...) from the `allContent.json` file bundled in the schemas
 * directory, so that content references which aren't found in the mod's own
 * content folders (see ContentIndex) can still be recognized as valid,
 * rather than being flagged as unknown.
 *
 * allContent.json looks like:
 *   { "item": { "copper": "mindustry.type.Item", "lead": "mindustry.type.Item", ... },
 *     "block": { "arc": "mindustry.world.blocks.defense.turrets.PowerTurret", ... },
 *     ...,
 *     "mappings": { "item": "mindustry.type.Item", "block": "mindustry.world.Block", ... } }
 *
 * The top-level keys ("item", "block", ...) are lower-case category names,
 * each mapping a vanilla content name to the fully-qualified class name of
 * *that specific piece of content* (e.g. "arc" is actually a PowerTurret,
 * not a generic Block). The `mappings` object separately gives the category's
 * own base FQCN, whose simple name (e.g. "Item", "Block") is what the rest of
 * the extension (CONTENT_TYPE_SIMPLE_NAMES) uses to key content types. This
 * class re-keys everything by that simple name, while also retaining each
 * name's specific FQCN so a mod file that overrides vanilla content by name
 * alone (no `type:` of its own) can be resolved to the right concrete class -
 * see `fqcnFor`.
 *
 * Unlike ContentIndex, there's no file location to jump to for vanilla
 * content - it isn't part of the mod - so this index only supports
 * name lookup/completion, not go-to-definition.
 */
export class VanillaContentIndex {
	/** simple type name (e.g. "Item") -> vanilla content name -> that content's own FQCN. */
	private byType = new Map<string, Map<string, string>>();
	loaded = false;

	/** Names known for a given content simple type name, e.g. "Item" -> ["copper", "lead", ...]. */
	namesFor(type: string): string[] {
		const m = this.byType.get(type);
		return m ? [...m.keys()].sort() : [];
	}

	/**
	 * True if `name` is known vanilla content of the given simple type name.
	 * Passing ANY_CONTENT_TYPE_SIMPLE_NAME (e.g. for a field typed as the
	 * abstract `UnlockableContent`, like `research.parent`) searches every
	 * category instead of one specific bucket.
	 */
	has(type: string, name: string): boolean {
		if (type === ANY_CONTENT_TYPE_SIMPLE_NAME) {
			for (const m of this.byType.values()) if (m.has(name)) return true;
			return false;
		}
		return this.byType.get(type)?.has(name) ?? false;
	}

	/**
	 * The fully-qualified class name of the vanilla content named `name`
	 * under simple type `type` (e.g. ("Block", "arc") ->
	 * "mindustry.world.blocks.defense.turrets.PowerTurret"), or undefined if
	 * unknown. Used to resolve the implicit type of a mod file that overrides
	 * vanilla content by name without declaring its own `type:`.
	 * ANY_CONTENT_TYPE_SIMPLE_NAME searches every category, same as `has`.
	 */
	fqcnFor(type: string, name: string): string | undefined {
		if (type === ANY_CONTENT_TYPE_SIMPLE_NAME) {
			for (const m of this.byType.values()) {
				const fqcn = m.get(name);
				if (fqcn) return fqcn;
			}
			return undefined;
		}
		return this.byType.get(type)?.get(name);
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
			for (const [key, baseFqcn] of Object.entries(mappings)) {
				const entries = raw[key];
				if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
				const simple = shortName(baseFqcn);
				const map = this.byType.get(simple) ?? new Map<string, string>();
				for (const [name, fqcn] of Object.entries<any>(entries)) {
					map.set(name, String(fqcn));
				}
				this.byType.set(simple, map);
			}
			this.loaded = true;
		} catch {
			// unreadable or malformed - leave the index empty
		}
	}
}