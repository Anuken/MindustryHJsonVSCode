import * as path from 'path';
import { Jval, JvalObject, JvalArray, JvalType } from '../parser/mhjsonParser';
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
 * Simple name of `mindustry.type.Research`, the class backing a content's
 * `research: {parent: ..., ...}` tech-tree placement. Its schema doc says it
 * "Also accepts a plain string, treated as 'parent'" - so a bare string in a
 * `research`-typed field is shorthand for `{parent: <that string>}`, and
 * `parent` itself is any UnlockableContent (an Item, Block, ...).
 * `contentTypeSimpleName` special-cases this below so that a bare string
 * value for a `research`-typed field is checked/completed as any
 * UnlockableContent, exactly as if the field itself were declared
 * `UnlockableContent`. This only affects the bare-string case: a `research:
 * {...}` object is unaffected and still resolves its own `parent` field
 * (typed `UnlockableContent`) normally.
 */
const RESEARCH_TYPE_SIMPLE_NAME = 'Research';

/**
 * If `type` (a field type, generic-element type, or map key/value type -
 * already unwrapped of any `Seq<...>`/`ObjectMap<...>` wrapper) names one of
 * the CONTENT_TYPE_SIMPLE_NAMES classes, returns that simple name. A field
 * typed as the abstract `UnlockableContent` returns ANY_CONTENT_TYPE_SIMPLE_NAME
 * instead, meaning "any content type" rather than one specific one. Likewise
 * for a field typed `Research` - see RESEARCH_TYPE_SIMPLE_NAME above.
 */
export function contentTypeSimpleName(type: string): string | undefined {
	const name = shortName(type);
	if (name === ANY_CONTENT_TYPE_SIMPLE_NAME) return ANY_CONTENT_TYPE_SIMPLE_NAME;
	if (name === RESEARCH_TYPE_SIMPLE_NAME) return ANY_CONTENT_TYPE_SIMPLE_NAME;
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
 * Structural interface for VanillaContentIndex's override lookup (declared
 * here rather than importing the class, to avoid a circular import - that
 * module already imports `shortName` from this one).
 */
export interface VanillaOverrideLookup {
	fqcnFor(simpleType: string, name: string): string | undefined;
}

/**
 * Resolves the root TypeContext for a whole file, given its implicit folder
 * type. A file whose base name (e.g. `arc` for `arc.hjson`) exactly matches
 * a piece of vanilla content of that implicit type is a *vanilla content
 * override* - it doesn't declare its own `type:`, so its effective type is
 * whatever concrete class that vanilla content actually is (e.g. `arc` ->
 * PowerTurret, not just any Block). Falls back to the plain implicit-folder
 * type (or no type at all) when there's no such override, or the resolved
 * class has no schema loaded.
 */
export function resolveImplicitTypeContext(
	registry: SchemaRegistry,
	filePath: string,
	contentTypeFolders: Record<string, string>,
	vanillaContent?: VanillaOverrideLookup,
): TypeContext {
	const implicitSimple = inferImplicitType(filePath, contentTypeFolders);
	if (implicitSimple && vanillaContent) {
		const base = path.basename(filePath);
		const dot = base.lastIndexOf('.');
		const name = dot > 0 ? base.slice(0, dot) : base;
		const overrideFqcn = vanillaContent.fqcnFor(implicitSimple, name);
		if (overrideFqcn) {
			const resolved = resolveClassForType(registry, overrideFqcn);
			if (resolved) return new TypeContext(registry, resolved.fqcn);
		}
	}
	return new TypeContext(registry, undefined).withExplicitType(implicitSimple);
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

	/** True if `simpleName` names an actual loaded class schema (a real subclass candidate). */
	namesKnownClass(simpleName: string): boolean {
		return this.registry.getBySimpleName(simpleName) !== undefined;
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
 *
 * The two cases are told apart by whether `explicitTypeValue` actually names a known class: a
 * genuine subclass selector like `FlakBulletType` or `ParticleWeather` resolves to a real loaded
 * schema, while an ordinary field's enum-style value (`missile`, `flying`, ...) normally doesn't
 * name any class at all. This matters because some base classes - e.g. `mindustry.type.Weather`,
 * whose own `type` field is an internal `Prov<WeatherState>` essentially never set from mod JSON -
 * declare a `type` field yet are still always meant to have `type: X` read as the subclass
 * selector in practice, so merely declaring a `type` field can't be the deciding factor on its own.
 */
export function resolveObjectType(baseCtx: TypeContext, explicitTypeValue: string | undefined): TypeContext {
	if (!explicitTypeValue) return baseCtx;
	if (baseCtx.schemaFields.has('type') && !baseCtx.namesKnownClass(explicitTypeValue)) return baseCtx;
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

/**
 * True if `type` names `mindustry.entities.Effect` (or just the bare simple
 * name `Effect`). A *string* value for such a field is a bare-name
 * reference to a vanilla effect (e.g. `hitEffect: hitBulletSmall`) - see
 * NameListIndex over schemas/allEffects.json. Any other JSON shape (object,
 * array, ...) for this field is a custom effect declared inline instead, and
 * is left to the ordinary object/array schema walk - see the module doc in
 * diagnostics.ts.
 */
export function isEffectType(type: string): boolean {
	return shortName(type) === 'Effect';
}

/**
 * True if `type` names `arc.audio.Sound` (or just the bare simple name
 * `Sound`). A *string* value is a bare-name reference to a sound - either
 * vanilla (NameListIndex over schemas/allSounds.json) or one of the mod's
 * own files under sounds/ (SoundIndex). Unlike Effect, a Sound field can
 * also legally be an *array* of such names - Mindustry samples one at
 * random each time (a "random sound") - see `isSoundArrayType`. Sound has
 * no legal object shape at all.
 */
export function isSoundType(type: string): boolean {
	return shortName(type) === 'Sound';
}

/** True if `type` is an array of `arc.audio.Sound` (a "random sound" - see `isSoundType`). */
export function isSoundArrayType(type: string): boolean {
	return arrayElementSimpleName(type) === 'Sound';
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

/**
 * ---------------------------------------------------------------------
 * Structural ("shape") type checking.
 *
 * Distinct from the content-name/enum-value checks above, which validate
 * the *contents* of a string value against a known set of legal strings,
 * the functions below validate that the *kind* of JSON value given (number,
 * boolean, array, object, ...) is even the right shape for the field's
 * declared Java type, for the handful of type categories whose shape we can
 * recognize purely from the type string: numeric primitives/wrappers,
 * booleans, arrays (bracket syntax or a single-type-param generic wrapper
 * like Seq/ObjectSet), and ObjectMap-style two-type-param maps.
 *
 * Any other declared type (an ordinary class like `Sound` or `Color`, a
 * content type, an enum, a bare generic type parameter, ...) is left
 * completely alone by this section - `checkPrimitiveShapeMismatch` simply
 * returns undefined for those, so behavior for types this plugin doesn't
 * know how to structurally validate is unchanged.
 * ---------------------------------------------------------------------
 */

const NUMERIC_TYPE_NAMES = new Set([
	'float',
	'double',
	'int',
	'long',
	'short',
	'byte',
	'Float',
	'Double',
	'Integer',
	'Int',
	'Long',
	'Short',
	'Byte',
]);

const BOOLEAN_TYPE_NAMES = new Set(['boolean', 'Boolean']);

/** True if `type` (simple name or FQCN) names a Java numeric primitive or boxed wrapper (float, int, long, ...). */
export function isNumericType(type: string): boolean {
	return NUMERIC_TYPE_NAMES.has(shortName(type));
}

/** True if `type` (simple name or FQCN) names a Java boolean primitive or boxed wrapper. */
export function isBooleanType(type: string): boolean {
	return BOOLEAN_TYPE_NAMES.has(shortName(type));
}

/**
 * Full (possibly FQCN) element type string of an array/Seq/ObjectSet-like
 * field, whether declared with bracket syntax (`Foo[]`) or a single-type-
 * param generic wrapper (`Seq<Foo>`, `ObjectSet<Foo>`, ...). Unlike
 * `arrayElementSimpleName`, this keeps the full type string (rather than
 * just its simple name) so callers can run further checks - e.g.
 * `isNumericType`/`isBooleanType` - on the element type itself. Returns
 * undefined for two-type-param generics (maps - see `isMapType`) or any
 * type that isn't array-shaped at all.
 */
export function arrayElementTypeString(type: string): string | undefined {
	const t = type.trim();
	if (t.endsWith('[]')) {
		const inner = t.slice(0, -2).trim();
		return inner.length > 0 ? inner : undefined;
	}
	return unwrapGenericElementType(t);
}

/** True if `type` is array-shaped: bracket syntax (`Foo[]`) or a single-type-param generic wrapper (`Seq<Foo>`, `ObjectSet<Foo>`, ...). Two-param generics (maps) are excluded - see `isMapType`. */
export function isArrayLikeType(type: string): boolean {
	return arrayElementTypeString(type) !== undefined;
}

/** True if `type` is a two-type-param generic map wrapper, e.g. `ObjectMap<K, V>`. */
export function isMapType(type: string): boolean {
	return unwrapMapTypes(type) !== undefined;
}

/** Short human-readable description of a parsed JSON value's kind, for diagnostic messages. */
export function describeJvalType(t: JvalType): string {
	switch (t) {
		case 'double':
		case 'long':
			return 'a number';
		case 'boolean':
			return 'a boolean';
		case 'string':
			return 'a string';
		case 'array':
			return 'an array';
		case 'object':
			return 'an object';
		case 'null':
			return 'null';
	}
}

/**
 * Checks a field's declared Java type against the *shape* of the JSON value
 * actually given for it, for the type categories `isNumericType`/
 * `isBooleanType`/`isArrayLikeType`/`isMapType` recognize. Returns a warning
 * message if the value's kind disagrees with the declared type, or
 * undefined if they agree - or if `fieldType` isn't one of these recognized
 * categories at all, which this function deliberately leaves unflagged (see
 * the section doc comment above).
 *
 * `null` is always accepted regardless of declared type: mods commonly
 * write `field: null` to explicitly clear/disable an inherited default, and
 * Mindustry's Json reader accepts a null for (almost) any field.
 */
export function checkPrimitiveShapeMismatch(fieldType: string, valueType: JvalType): string | undefined {
	if (valueType === 'null') return undefined;

	if (isBooleanType(fieldType)) {
		if (valueType === 'boolean') return undefined;
		return `Expected a boolean for type '${prettyType(fieldType)}', got ${describeJvalType(valueType)}`;
	}
	if (isNumericType(fieldType)) {
		if (valueType === 'double' || valueType === 'long') return undefined;
		return `Expected a number for type '${prettyType(fieldType)}', got ${describeJvalType(valueType)}`;
	}
	if (isMapType(fieldType)) {
		if (valueType === 'object') return undefined;
		return `Expected an object (map) for type '${prettyType(fieldType)}', got ${describeJvalType(valueType)}`;
	}
	if (isArrayLikeType(fieldType)) {
		if (valueType === 'array') return undefined;
		return `Expected an array for type '${prettyType(fieldType)}', got ${describeJvalType(valueType)}`;
	}
	return undefined;
}