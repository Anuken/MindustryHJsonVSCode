import { Jval, JvalObject, JvalMember, ParseResult } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { TypeContext, findExplicitTypeField, inferImplicitType } from '../schema/typeResolver';

export interface LocateResult {
	/** The innermost object containing the offset (the object we'd be completing/hovering a key in). */
	object: JvalObject | undefined;
	/** Schema context for that object (its own type). */
	ctx: TypeContext;
	/** If the offset sits inside a member's key token, that member. */
	onKey: JvalMember | undefined;
	/** If the offset sits inside a member's value token, that member. */
	onValue: JvalMember | undefined;
	/**
	 * True when `object` is the literal object of an ObjectMap<Key, Value>-typed field: its
	 * entries are arbitrary map keys rather than fixed schema fields, so field-name completion
	 * and unknown-field warnings don't apply to it.
	 */
	isMapEntries: boolean;
	/** When `onKey` is a map entry's key, the map's declared Key type (for hover). */
	mapKeyType: string | undefined;
}

export function locate(
	parse: ParseResult,
	offset: number,
	registry: SchemaRegistry,
	filePath: string,
	contentTypeFolders: Record<string, string>,
): LocateResult {
	const implicitSimple = inferImplicitType(filePath, contentTypeFolders);
	let rootCtx = new TypeContext(registry, undefined);
	if (parse.root && parse.root.type === 'object') {
		const explicit = findExplicitTypeField(parse.root as JvalObject) ?? implicitSimple;
		rootCtx = rootCtx.withExplicitType(explicit);
	}

	const result: LocateResult = { object: undefined, ctx: rootCtx, onKey: undefined, onValue: undefined, isMapEntries: false, mapKeyType: undefined };
	if (!parse.root) return result;
	visit(parse.root, rootCtx, offset, result, registry);
	return result;
}

function contains(range: { start: number; end: number }, offset: number): boolean {
	return offset >= range.start && offset <= range.end;
}

function visit(node: Jval, ctx: TypeContext, offset: number, result: LocateResult, registry: SchemaRegistry) {
	if (!contains(node.range, offset)) return;

	if (node.type === 'object') {
		result.object = node;
		result.ctx = ctx;
		result.isMapEntries = false;
		const fields = ctx.schemaFields;
		for (const member of node.entries) {
			if (contains(member.keyRange, offset)) {
				result.onKey = member;
				return;
			}
			if (contains(member.value.range, offset)) {
				result.onValue = member;
				const field = fields.get(member.key);
				let childCtx: TypeContext;
				if (member.value.type === 'object') {
					const mapField = ctx.resolveMapField(field);
					if (mapField) {
						visitMapEntries(member.value as JvalObject, mapField.keyType, mapField.valueCtx, offset, result, registry);
						return;
					}
					const explicit = findExplicitTypeField(member.value as JvalObject);
					childCtx = ctx.forField(field).withExplicitType(explicit);
				} else if (member.value.type === 'array') {
					childCtx = ctx.forArrayElement(field);
				} else {
					childCtx = new TypeContext(registry, undefined);
				}
				visit(member.value, childCtx, offset, result, registry);
				return;
			}
		}
	} else if (node.type === 'array') {
		for (const el of node.elements) {
			if (contains(el.range, offset)) {
				let elCtx = ctx;
				if (el.type === 'object') {
					const explicit = findExplicitTypeField(el as JvalObject);
					elCtx = ctx.withExplicitType(explicit);
				}
				visit(el, elCtx, offset, result, registry);
				return;
			}
		}
	}
}

/** Like `visit`, but for the literal object of an ObjectMap<Key, Value>-typed field: entries are
 * arbitrary map keys (not fixed schema fields), and each entry's *value* resolves to `valueCtx`. */
function visitMapEntries(mapObj: JvalObject, keyType: string, valueCtx: TypeContext, offset: number, result: LocateResult, registry: SchemaRegistry) {
	if (!contains(mapObj.range, offset)) return;
	result.object = mapObj;
	result.ctx = new TypeContext(registry, undefined); // arbitrary keys: no fixed field set to complete
	result.isMapEntries = true;
	for (const entry of mapObj.entries) {
		if (contains(entry.keyRange, offset)) {
			result.onKey = entry;
			result.mapKeyType = keyType;
			return;
		}
		if (contains(entry.value.range, offset)) {
			result.onValue = entry;
			if (entry.value.type === 'object') {
				const explicit = findExplicitTypeField(entry.value as JvalObject);
				visit(entry.value, valueCtx.withExplicitType(explicit), offset, result, registry);
			} else if (entry.value.type === 'array') {
				visit(entry.value, new TypeContext(registry, undefined), offset, result, registry);
			}
			return;
		}
	}
}
