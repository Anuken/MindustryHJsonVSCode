import * as fs from 'fs';
import * as path from 'path';

/**
 * One entry in a schema file, e.g. for LiquidExplodeAbility.json:
 *   "amount": { "type": "float", "default": "120" }
 */
export interface FieldSchema {
	/** Fully-qualified java type, e.g. "float", "mindustry.type.Liquid", "arc.struct.Seq<mindustry.type.Weapon>" */
	type: string;
	doc?: string;
	default?: string;
}

export interface ClassSchema {
	/** Fully qualified class name, taken from the file name (minus .json). */
	fqcn: string;
	/** Simple (short) name, e.g. "LiquidExplodeAbility". */
	simpleName: string;
	superclass?: string;
	/** Optional class-level documentation, from a top-level "doc" key in the schema file. */
	doc?: string;
	fields: Record<string, FieldSchema>;
	/** For enum schemas (superclass "Enum"), the enum's legal value names, e.g. ["turret", "production", ...] for Category. */
	enumValues?: string[];
}

/** Synthetic field schema for the `type: SimpleName` field every content object can have. */
export const TYPE_FIELD: FieldSchema = {
	type: 'String',
	doc: 'Type of the object.',
};

/**
 * Holds every loaded schema, indexed both by FQCN and by simple name so we
 * can resolve `type: SomeType` (simple name) fields quickly, and also
 * resolves the effective field set for a class including inherited fields
 * from `superclass`.
 */
export class SchemaRegistry {
	private byFqcn = new Map<string, ClassSchema>();
	private bySimpleName = new Map<string, ClassSchema[]>();
	private effectiveFieldsCache = new Map<string, Map<string, FieldSchema>>();

	get size(): number {
		return this.byFqcn.size;
	}

	clear() {
		this.byFqcn.clear();
		this.bySimpleName.clear();
		this.effectiveFieldsCache.clear();
	}

	loadFolder(folder: string): { loaded: number; errors: string[] } {
		this.clear();
		const errors: string[] = [];
		let loaded = 0;
		if (!fs.existsSync(folder)) {
			return { loaded: 0, errors: [`Schema folder does not exist: ${folder}`] };
		}
		for (const file of fs.readdirSync(folder)) {
			if (!file.endsWith('.json')) continue;
			if (file === 'allContent.json') continue; // vanilla content index, not a class schema - see VanillaContentIndex
			const fqcn = file.slice(0, -'.json'.length);
			const full = path.join(folder, file);
			try {
				const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
				const schema = parseSchemaFile(fqcn, raw);
				this.add(schema);
				loaded++;
			} catch (e: any) {
				errors.push(`Failed to parse schema ${file}: ${e.message ?? e}`);
			}
		}
		return { loaded, errors };
	}

	private add(schema: ClassSchema) {
		this.byFqcn.set(schema.fqcn, schema);
		const list = this.bySimpleName.get(schema.simpleName) ?? [];
		list.push(schema);
		this.bySimpleName.set(schema.simpleName, list);
	}

	getByFqcn(fqcn: string): ClassSchema | undefined {
		return this.byFqcn.get(fqcn);
	}

	/** Resolve a *simple* type name (as used in `type: Foo`) to a schema. Ambiguous names return the first match. */
	getBySimpleName(simpleName: string): ClassSchema | undefined {
		const list = this.bySimpleName.get(simpleName);
		return list && list.length > 0 ? list[0] : undefined;
	}

	getAllSimpleNames(): string[] {
		return [...this.bySimpleName.keys()].sort();
	}

	/** Field set for a class, walking up the `superclass` chain, closest-wins on conflicts. */
	getEffectiveFields(fqcn: string): Map<string, FieldSchema> {
		const cached = this.effectiveFieldsCache.get(fqcn);
		if (cached) return cached;

		const chain: ClassSchema[] = [];
		const seen = new Set<string>();
		let cur = this.byFqcn.get(fqcn);
		while (cur && !seen.has(cur.fqcn)) {
			seen.add(cur.fqcn);
			chain.push(cur);
			cur = cur.superclass ? this.byFqcn.get(cur.superclass) : undefined;
		}

		const fields = new Map<string, FieldSchema>();
		// walk base -> derived so derived overrides base
		for (let i = chain.length - 1; i >= 0; i--) {
			for (const [name, f] of Object.entries(chain[i].fields)) {
				fields.set(name, f);
			}
		}
		this.effectiveFieldsCache.set(fqcn, fields);
		return fields;
	}
}

function parseSchemaFile(fqcn: string, raw: any): ClassSchema {
	const fields: Record<string, FieldSchema> = {};
	let superclass: string | undefined;
	let doc: string | undefined;
	let enumValues: string[] | undefined;
	for (const [key, val] of Object.entries<any>(raw)) {
		if (key === 'superclass') {
			superclass = String(val);
			continue;
		}
		if (key === 'doc' && typeof val === 'string') {
			doc = val;
			continue;
		}
		if (key === 'values' && Array.isArray(val)) {
			enumValues = val.map(String);
			continue;
		}
		if (val && typeof val === 'object' && typeof val.type === 'string') {
			fields[key] = {
				type: val.type,
				doc: typeof val.doc === 'string' ? val.doc : undefined,
				default: val.default !== undefined ? String(val.default) : undefined,
			};
		}
	}
	const simpleName = fqcn.includes('.') ? fqcn.slice(fqcn.lastIndexOf('.') + 1) : fqcn;
	return { fqcn, simpleName, superclass, doc, fields, enumValues };
}

/** Generic type helpers, e.g. "arc.struct.Seq<mindustry.type.Weapon>" -> element FQCN "mindustry.type.Weapon". */
export function unwrapGenericElementType(type: string): string | undefined {
	const m = /^[\w.]+<\s*([\w.]+)\s*>$/.exec(type.trim());
	return m ? m[1] : undefined;
}

export function isKnownPrimitive(type: string): boolean {
	return ['float', 'double', 'int', 'long', 'boolean', 'String', 'string', 'short', 'byte', 'char'].includes(type);
}
