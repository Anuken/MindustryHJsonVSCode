import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads a flat list of legal names from a schema JSON file shaped like
 * `{ "values": ["name1", "name2", ...] }` - used for vanilla Effect names
 * (schemas/allEffects.json) and vanilla Sound names (schemas/allSounds.json).
 *
 * Unlike VanillaContentIndex, there's no per-type FQCN bookkeeping here:
 * effects and sounds are each resolved against one flat namespace apiece
 * (there's no notion of a mod "overriding" a vanilla effect/sound by name
 * the way it can override a Block or Item), so a single Set of known names
 * is all either one needs.
 */
export class NameListIndex {
	private names = new Set<string>();
	loaded = false;

	/** Every known name, sorted - for completion. */
	namesFor(): string[] {
		return [...this.names].sort();
	}

	/** True if `name` is a known vanilla name. */
	has(name: string): boolean {
		return this.names.has(name);
	}

	clear() {
		this.names.clear();
		this.loaded = false;
	}

	/** Loads `fileName` (e.g. "allEffects.json") from `schemaFolder`, if present. No-op (leaves the index empty) if the file doesn't exist or fails to parse. */
	load(schemaFolder: string, fileName: string) {
		this.clear();
		const file = path.join(schemaFolder, fileName);
		if (!fs.existsSync(file)) return;
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			const values = raw?.values;
			if (!Array.isArray(values)) return;
			for (const v of values) this.names.add(String(v));
			this.loaded = true;
		} catch {
			// unreadable or malformed - leave the index empty
		}
	}
}
