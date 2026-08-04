import { Jval, JvalObject, JvalArray } from '../parser/mhjsonParser';
import { SchemaRegistry, unwrapGenericElementType, FieldSchema, ClassSchema } from './schemaLoader';

/**
 * Simple names of "content" classes that are looked up by name (as a bare
 * string field value) rather than declared inline as nested objects, and
 * which live under a well-known folder of the mod (see CONTENT_TYPE_FOLDERS
 * / the `mindustryHjson.contentTypeFolders` setting for the folder mapping).
 */
export const CONTENT_TYPE_SIMPLE_NAMES = new Set([
	'Item',
	'Block',
	'Liquid',
	'Planet',
	'SectorPreset',
	'StatusEffect',
	'UnitType',
	'Weather',
]);

/**
 * A field declared as the abstract `mindustry.ctype.UnlockableContent` (or
 * just the bare `UnlockableContent` simple name) isn't restricted to one
 * particular content class - it accepts *any* named content (an Item, a
 * Block, a Liquid, ...). `contentTypeSimpleName` returns this sentinel for
 * such fields; `ContentIndex` (schema/contentIndex.ts) knows to search
 * across every content type, rather than just one, whenever it sees it.
 */
export const ANY_CONTENT_TYPE_SIMPLE_NAME = 'UnlockableContent';

/**
 * If `type` (a field type, generic-element type, or map key/value type -
 * already unwrapped of any `Seq<...>`/`ObjectMap<...>` wrapper) names one of
 * the CONTENT_TYPE_SIMPLE_NAMES classes, returns that simple name. A field
 * typed as the abstract `UnlockableContent` returns ANY_CONTENT_TYPE_SIMPLE_NAME
 * instead, meaning "any content type" rather than one specific one.
 */
export function contentTypeSimpleName(type: string): string | undefined {
	const name = shortName(type);
	if (name === ANY_CONTENT_TYPE_SIMPLE_NAME) return ANY_CONTENT_TYPE_SIMPLE_NAME;
	return CONTENT_TYPE_SIMPLE_NAMES.has(name) ? name : undefined;
}

/**
 * Like `contentTypeSimpleName`, but for an *array*-of-content field, e.g.
 * `Seq<Item>`, `ObjectSet<Planet>`, or `Block[]`. Unwraps the array/generic
 * wrapper first (via `arrayElementSimpleName`) before checking the element
 * type against CONTENT_TYPE_SIMPLE_NAMES - `contentTypeSimpleName` itself
 * can't be used directly here since it only strips the text after the type's
 * *last* dot, which for a generic type like `arc.struct.ObjectSet<mindustry.
 * type.Planet>` lands inside the type parameter (yielding "Planet>", not
 * "Planet") rather than at the wrapper's own simple name.
 */
export function arrayContentTypeSimpleName(type: string): string | undefined {
	const el = arrayElementSimpleName(type);
	if (!el) return undefined;
	if (el === ANY_CONTENT_TYPE_SIMPLE_NAME) return ANY_CONTENT_TYPE_SIMPLE_NAME;
	return CONTENT_TYPE_SIMPLE_NAMES.has(el) ? el : undefined;
}

/**
 * Simple names of abstract/base classes that are never actually instantiated
 * bare - Mindustry substitutes a concrete default subclass when an object of
 * this declared type has no explicit `type: X` of its own. Keyed and valued
 * by simple class name; extend this map for any other abstract-with-a-
 * conventional-default types.
 */
const DEFAULT_TYPE_RESOLUTIONS: Record<string, string> = {
	BulletType: 'BasicBulletType',
	Effect: 'ParticleEffect',
	DrawPart: 'RegionPart',
};

/**
 * Resolves a (possibly FQCN) type name to its schema, substituting the
 * DEFAULT_TYPE_RESOLUTIONS default (if one is registered) whenever the type
 * itself has no schema, or the type is a known abstract base with a
 * conventional default concrete subclass - see DEFAULT_TYPE_RESOLUTIONS.
 */
function resolveClassForType(registry: SchemaRegistry, targetType: string): ClassSchema | undefined {
	const short = shortName(targetType);
	const defaultName = DEFAULT_TYPE_RESOLUTIONS[short];
	if (defaultName) {
		const resolved = registry.getBySimpleName(defaultName);
		if (resolved) return resolved;
	}
	return registry.getByFqcn(targetType) ?? registry.getBySimpleName(short);
}

/**
 * Figures out the implicit top-level type for a file based on its path,
 * e.g. content/weathers/foo.hjson -> "Weather".
 * `contentTypeFolders` maps a folder name (as it appears directly under
 * a `content/` directory, or anywhere in the path) to a simple type name.
 */
export function inferImplicitType(filePath: string, contentTypeFolders: Record<string, string>): string | undefined {
	const normalized = filePath.replace(/\\/g, '/');
	const segments = normalized.split('/');
	for (const [folder, type] of Object.entries(contentTypeFolders)) {
		if (segments.includes(folder)) return type;
	}
	return undefined;
}

/**
 * Given the root Jval of a document and its implicit type, find the FQCN
 * that applies to a nested object/array element by walking down from root
 * following the same path the caller used to reach that node.
 *
 * This resolver is path-based rather than a single global walk so it can be
 * reused both by the diagnostics pass (which visits every node) and by
 * completion/hover (which only need the type at the cursor).
 */
export interface MapFieldTypes {
	keyType: string;
	/** The map's raw (unresolved) value type, e.g. "mindustry.type.Item" - useful for content-type checks. */
	valueType: string;
	valueCtx: TypeContext;
}

/** Unwraps a two-type-parameter generic like "arc.struct.ObjectMap<K, V>" into { keyType, valueType }. */
export function unwrapMapTypes(type: string): { keyType: string; valueType: string } | undefined {
	const m = /^[\w.]+<\s*([\w.<>]+?)\s*,\s*([\w.<>]+?)\s*>$/.exec(type.trim());
	return m ? { keyType: m[1], valueType: m[2] } : undefined;
}

export class TypeContext {
	constructor(private registry: SchemaRegistry, public fqcn: string | undefined) {}

	get schemaFields(): Map<string, FieldSchema> {
		return this.fqcn ? this.registry.getEffectiveFields(this.fqcn) : new Map();
	}

	/** Resolve the TypeContext for a member's value, given the member's field schema (if known). */
	forField(field: FieldSchema | undefined): TypeContext {
		if (!field) return new TypeContext(this.registry, undefined);
		const elementType = unwrapGenericElementType(field.type);
		const targetType = elementType ?? field.type;
		const resolved = resolveClassForType(this.registry, targetType);
		return new TypeContext(this.registry, resolved?.fqcn);
	}

	/**
	 * Resolve the TypeContext for an array element. Handles both a generic
	 * array field type like `Seq<Weapon>` (element type = Weapon), and the
	 * special case of a bare `Effect`-typed field being given a JSON array
	 * directly - Mindustry treats each element of that array as its own
	 * Effect (the array *is* the MultiEffect shorthand, not a Seq<Effect>
	 * field), so every element resolves against the field's own type
	 * (defaulting to ParticleEffect per DEFAULT_TYPE_RESOLUTIONS, same as any
	 * other bare Effect, unless the element itself has an explicit `type:`).
	 */
	forArrayElement(field: FieldSchema | undefined): TypeContext {
		if (!field) return new TypeContext(this.registry, undefined);
		const elementType = unwrapGenericElementType(field.type);
		if (elementType) {
			const resolved = resolveClassForType(this.registry, elementType);
			return new TypeContext(this.registry, resolved?.fqcn);
		}
		if (shortName(field.type) === 'Effect') {
			const resolved = resolveClassForType(this.registry, field.type);
			return new TypeContext(this.registry, resolved?.fqcn);
		}
		return new TypeContext(this.registry, undefined);
	}

	/** If a member's field type is a two-arg generic like ObjectMap<Key, Value>, resolve the key/value type info. Returns undefined otherwise. */
	resolveMapField(field: FieldSchema | undefined): MapFieldTypes | undefined {
		if (!field) return undefined;
		const map = unwrapMapTypes(field.type);
		if (!map) return undefined;
		const resolved = resolveClassForType(this.registry, map.valueType);
		return { keyType: map.keyType, valueType: map.valueType, valueCtx: new TypeContext(this.registry, resolved?.fqcn) };
	}

	/** If an object literal has its own explicit `type: X`, that overrides the inferred/field type. */
	withExplicitType(explicitSimpleName: string | undefined): TypeContext {
		if (!explicitSimpleName) return this;
		const resolved = this.registry.getBySimpleName(explicitSimpleName);
		return resolved ? new TypeContext(this.registry, resolved.fqcn) : this;
	}
}

/**
 * Resolves the effective TypeContext for an object literal, given the "base" context implied by
 * its position (a field's target type, an array's element type, a file's implicit folder type,
 * ...) and its own `type: X` entry, if any. A `type: X` entry is normally a polymorphic subclass
 * selector (e.g. `type: FlakBulletType` overriding the base `BulletType`) - but some classes
 * declare `type` as an ordinary field of their own (e.g. UnitType.type: JsonUnitType, an enum of
 * unit archetypes), in which case `type: missile` is just that field's value, not a subclass
 * selector, and must not change the object's resolved class.
 */
export function resolveObjectType(baseCtx: TypeContext, explicitTypeValue: string | undefined): TypeContext {
	if (!explicitTypeValue || baseCtx.schemaFields.has('type')) return baseCtx;
	return baseCtx.withExplicitType(explicitTypeValue);
}

/**
 * Simple name of an array field's element type, whether the field is
 * declared with bracket syntax (`Foo[]`, used e.g. for `ItemStack[]`,
 * `Color[]`) or a generic wrapper (`Seq<Foo>`). Returns undefined if `type`
 * isn't an array of a single named type.
 */
export function arrayElementSimpleName(type: string): string | undefined {
	const t = type.trim();
	if (t.endsWith('[]')) return shortName(t.slice(0, -2));
	const el = unwrapGenericElementType(t);
	return el ? shortName(el) : undefined;
}

/**
 * "Stack" classes that are written in mod HJSON as shorthand strings
 * `"name/amount"` (e.g. `territe-alloy/1200`, `water/12.5`) rather than
 * nested `{item/liquid, amount}` objects. Maps the stack's simple class name
 * to the simple name of the content type its left-hand side names.
 */
const STACK_TYPE_CONTENT_TYPES: Record<string, string> = {
	ItemStack: 'Item',
	LiquidStack: 'Liquid',
};

/** If `type` names one of STACK_TYPE_CONTENT_TYPES itself (not an array of it), returns the content type its name portion refers to (e.g. "Item" for `ItemStack`). */
export function stackContentType(type: string): string | undefined {
	return STACK_TYPE_CONTENT_TYPES[shortName(type)];
}

/** If `type` is an array of one of STACK_TYPE_CONTENT_TYPES, returns the content type its elements' name portions refer to (e.g. "Liquid" for `LiquidStack[]`). */
export function stackArrayContentType(type: string): string | undefined {
	const el = arrayElementSimpleName(type);
	return el !== undefined ? STACK_TYPE_CONTENT_TYPES[el] : undefined;
}

/** True if `type` names `arc.graphics.Color`. */
export function isColorType(type: string): boolean {
	return shortName(type) === 'Color';
}

/** True if `type` is an array of `arc.graphics.Color`. */
export function isColorArrayType(type: string): boolean {
	return arrayElementSimpleName(type) === 'Color';
}

export function shortName(fqcnOrSimple: string): string {
	return fqcnOrSimple.includes('.') ? fqcnOrSimple.slice(fqcnOrSimple.lastIndexOf('.') + 1) : fqcnOrSimple;
}

/** Matches a dotted FQCN-looking identifier anywhere in a type string, e.g. both "arc.struct.Seq" and "mindustry.type.Weapon" inside "arc.struct.Seq<mindustry.type.Weapon>". */
const FQCN_IN_TYPE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;

/**
 * Shortens every fully-qualified class name embedded in a (possibly generic
 * or array) type string down to its simple name, for display purposes -
 * `arc.graphics.Color` -> `Color`, `arc.struct.Seq<mindustry.type.Weapon>` ->
 * `Seq<Weapon>`. Unlike `shortName`, this is safe to use on generic types
 * since it shortens every dotted segment, not just text after the last dot.
 */
export function prettyType(type: string): string {
	return type.replace(FQCN_IN_TYPE, (m) => shortName(m));
}

/** Info about an Enum-superclass schema: its FQCN and legal value names. */
export interface EnumInfo {
	fqcn: string;
	values: string[];
}

/** If `type` (FQCN or simple name) resolves to a schema whose superclass is "Enum", returns its FQCN + legal values. */
export function resolveEnumInfo(registry: SchemaRegistry, type: string): EnumInfo | undefined {
	const schema = registry.getByFqcn(type) ?? registry.getBySimpleName(shortName(type));
	if (schema && schema.superclass === 'Enum' && schema.enumValues) {
		return { fqcn: schema.fqcn, values: schema.enumValues };
	}
	return undefined;
}

/** Like `resolveEnumInfo`, but for an array-of-enum field, e.g. `Seq<Category>` or `Category[]`. */
export function arrayEnumInfo(registry: SchemaRegistry, type: string): EnumInfo | undefined {
	const el = arrayElementSimpleName(type);
	return el ? resolveEnumInfo(registry, el) : undefined;
}

export function findExplicitTypeField(obj: JvalObject): string | undefined {
	for (const m of obj.entries) {
		if (m.key === 'type' && m.value.type === 'string') return (m.value as any).value;
	}
	return undefined;
}