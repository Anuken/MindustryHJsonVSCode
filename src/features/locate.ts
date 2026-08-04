import { Jval, JvalObject, JvalArray, JvalMember, JvalString, ParseResult, Range } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import {
	TypeContext,
	findExplicitTypeField,
	inferImplicitType,
	contentTypeSimpleName,
	stackContentType,
	stackArrayContentType,
} from '../schema/typeResolver';

/** A bare-string token that refers to named content (an Item, Block, Liquid, ...) by name. */
export interface ContentRef {
	/** Simple class name of the content, e.g. "Item". */
	type: string;
	/** The referenced content's name, as written. */
	name: string;
	/** Source range of just the name token (the whole string value, or the map key). */
	range: Range;
}

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
	/**
	 * Set when the offset sits on a bare-string token (a direct field value, an
	 * element of a content-typed array, or a content-typed map's key) that
	 * refers to named content - Item/Block/Liquid/Planet/SectorPreset/
	 * StatusEffect/UnitType/Weather - resolvable via the mod's own content
	 * folders. Drives content-aware completion/hover/go-to-definition.
	 */
	contentRef: ContentRef | undefined;
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

	const result: LocateResult = {
		object: undefined,
		ctx: rootCtx,
		onKey: undefined,
		onValue: undefined,
		isMapEntries: false,
		mapKeyType: undefined,
		contentRef: undefined,
	};
	if (!parse.root) return result;
	visit(parse.root, rootCtx, offset, result, registry);
	return result;
}

function contains(range: { start: number; end: number }, offset: number): boolean {
	return offset >= range.start && offset <= range.end;
}

/** If `type` names a content class, checks whether `arr` has an element (string) containing `offset` and records it as a ContentRef. */
function checkContentArrayElement(arr: JvalArray, contentType: string, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			result.contentRef = { type: contentType, name: (el as any).value, range: el.range };
			return;
		}
	}
}

/**
 * "Stack" values (ItemStack, LiquidStack, ...) are written in mod HJSON as
 * shorthand strings `"name/amount"` (e.g. `territe-alloy/1200`, a
 * LiquidStack's `water/12.5`) rather than nested `{item/liquid, amount}`
 * objects. Given the string node, returns the name and its source range -
 * the part of the token up to (but not including) the `/`, or the whole
 * token if no `/` has been typed yet (so completion still works while the
 * name is being typed). Assumes no escape sequences appear before the `/`,
 * which holds for any real content name.
 */
function stackNameRange(node: JvalString): { name: string; range: Range } {
	const idx = node.value.indexOf('/');
	const end = idx < 0 ? node.value.length : idx;
	const quoteOffset = node.quoted ? 1 : 0;
	return {
		name: node.value.slice(0, end),
		range: { start: node.range.start + quoteOffset, end: node.range.start + quoteOffset + end },
	};
}

/** Checks whether a stack-array-typed array (ItemStack[], LiquidStack[], ...) has a string element (shorthand `name/amount`) containing `offset`. If `offset` sits on the name portion (left of the `/`), records it as a ContentRef of `contentType`. */
function checkStackArrayElement(arr: JvalArray, contentType: string, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			const { name, range } = stackNameRange(el as JvalString);
			if (contains(range, offset)) result.contentRef = { type: contentType, name, range };
			return;
		}
	}
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
						visitMapEntries(member.value as JvalObject, mapField.keyType, mapField.valueType, mapField.valueCtx, offset, result, registry);
						return;
					}
					const explicit = findExplicitTypeField(member.value as JvalObject);
					childCtx = ctx.forField(field).withExplicitType(explicit);
				} else if (member.value.type === 'array') {
					const arrayContentType = field ? contentTypeSimpleName(field.type) : undefined;
					if (arrayContentType) {
						checkContentArrayElement(member.value as JvalArray, arrayContentType, offset, result);
						return;
					}
					if (field) {
						const stackType = stackArrayContentType(field.type);
						if (stackType) {
							checkStackArrayElement(member.value as JvalArray, stackType, offset, result);
							return;
						}
					}
					childCtx = ctx.forArrayElement(field);
				} else {
					childCtx = new TypeContext(registry, undefined);
					if (member.value.type === 'string' && field) {
						const contentType = contentTypeSimpleName(field.type);
						if (contentType) {
							result.contentRef = { type: contentType, name: (member.value as any).value, range: member.value.range };
						} else {
							const stackType = stackContentType(field.type);
							if (stackType) {
								const { name, range } = stackNameRange(member.value as JvalString);
								if (contains(range, offset)) result.contentRef = { type: stackType, name, range };
							}
						}
					}
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
function visitMapEntries(
	mapObj: JvalObject,
	keyType: string,
	valueType: string,
	valueCtx: TypeContext,
	offset: number,
	result: LocateResult,
	registry: SchemaRegistry,
) {
	if (!contains(mapObj.range, offset)) return;
	result.object = mapObj;
	result.ctx = new TypeContext(registry, undefined); // arbitrary keys: no fixed field set to complete
	result.isMapEntries = true;
	const keyContentType = contentTypeSimpleName(keyType);
	for (const entry of mapObj.entries) {
		if (contains(entry.keyRange, offset)) {
			result.onKey = entry;
			result.mapKeyType = keyType;
			if (keyContentType) {
				result.contentRef = { type: keyContentType, name: entry.key, range: entry.keyRange };
			}
			return;
		}
		if (contains(entry.value.range, offset)) {
			result.onValue = entry;
			if (entry.value.type === 'object') {
				const explicit = findExplicitTypeField(entry.value as JvalObject);
				visit(entry.value, valueCtx.withExplicitType(explicit), offset, result, registry);
			} else if (entry.value.type === 'array') {
				visit(entry.value, new TypeContext(registry, undefined), offset, result, registry);
			} else if (entry.value.type === 'string') {
				const valueContentType = contentTypeSimpleName(valueType);
				if (valueContentType) {
					result.contentRef = { type: valueContentType, name: (entry.value as any).value, range: entry.value.range };
				} else {
					const stackType = stackContentType(valueType);
					if (stackType) {
						const { name, range } = stackNameRange(entry.value as JvalString);
						if (contains(range, offset)) result.contentRef = { type: stackType, name, range };
					}
				}
			}
			return;
		}
	}
}
