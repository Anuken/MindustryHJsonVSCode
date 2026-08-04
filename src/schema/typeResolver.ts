import { Jval, JvalObject, JvalArray } from '../parser/mhjsonParser';
import { SchemaRegistry, unwrapGenericElementType, FieldSchema } from './schemaLoader';

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
		const resolved = this.registry.getByFqcn(targetType) ?? this.registry.getBySimpleName(shortName(targetType));
		return new TypeContext(this.registry, resolved?.fqcn);
	}

	/** Resolve the TypeContext for an array element, when the array's own field type is a generic like Seq<Weapon>. */
	forArrayElement(field: FieldSchema | undefined): TypeContext {
		if (!field) return new TypeContext(this.registry, undefined);
		const elementType = unwrapGenericElementType(field.type);
		if (!elementType) return new TypeContext(this.registry, undefined);
        const resolved = this.registry.getByFqcn(elementType) ?? this.registry.getBySimpleName(shortName(elementType));
		return new TypeContext(this.registry, resolved?.fqcn);
	}

	/** If a member's field type is a two-arg generic like ObjectMap<Key, Value>, resolve the key/value type info. Returns undefined otherwise. */
	resolveMapField(field: FieldSchema | undefined): MapFieldTypes | undefined {
		if (!field) return undefined;
		const map = unwrapMapTypes(field.type);
		if (!map) return undefined;
		const resolved = this.registry.getByFqcn(map.valueType) ?? this.registry.getBySimpleName(shortName(map.valueType));
		return { keyType: map.keyType, valueCtx: new TypeContext(this.registry, resolved?.fqcn) };
	}

	/** If an object literal has its own explicit `type: X`, that overrides the inferred/field type. */
	withExplicitType(explicitSimpleName: string | undefined): TypeContext {
		if (!explicitSimpleName) return this;
		const resolved = this.registry.getBySimpleName(explicitSimpleName);
		return resolved ? new TypeContext(this.registry, resolved.fqcn) : this;
	}
}

export function shortName(fqcnOrSimple: string): string {
	return fqcnOrSimple.includes('.') ? fqcnOrSimple.slice(fqcnOrSimple.lastIndexOf('.') + 1) : fqcnOrSimple;
}

export function findExplicitTypeField(obj: JvalObject): string | undefined {
	for (const m of obj.entries) {
		if (m.key === 'type' && m.value.type === 'string') return (m.value as any).value;
	}
	return undefined;
}
