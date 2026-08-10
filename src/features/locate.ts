import { Jval, JvalObject, JvalArray, JvalMember, JvalString, ParseResult, Range } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { VanillaContentIndex } from '../schema/vanillaContent';
import {
	TypeContext,
	findExplicitTypeField,
	resolveImplicitTypeContext,
	contentTypeSimpleName,
	arrayContentTypeSimpleName,
	stackContentType,
	stackArrayContentType,
	resolveEnumInfo,
	arrayEnumInfo,
	EnumInfo,
	resolveObjectType,
	isEffectType,
	isSoundType,
	isSoundArrayType,
	isTeamType,
	isTeamArrayType,
	isAttributeType,
	isAttributesType,
	parseStackShorthand,
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

/** A bare-string token that refers to a vanilla Effect by name (e.g. `hitEffect: hitBulletSmall`). */
export interface EffectRef {
	name: string;
	range: Range;
}

/** A bare-string token that refers to a Sound by name - either vanilla or one of the mod's own sounds/ files. Also used for each element of a "random sound" array (a Sound field given a JSON array of names). */
export interface SoundRef {
	name: string;
	range: Range;
}

/** A bare-string token that refers to a Team by name (e.g. `forceTeam: sharded`, or an element of a Team[]/Seq<Team> field). Team names are a fixed, non-extensible set - see `isTeamType`. */
export interface TeamRef {
	name: string;
	range: Range;
}

/**
 * A bare-string token naming an attribute - either the value of a singular `Attribute`-typed
 * field (e.g. `AttributeCrafter.attribute: heat`), or a key inside a plural `Attributes`-typed
 * map object (e.g. `attributes: {heat: 10}`). Attribute names are extensible (see `isAttributeType`),
 * so this is only used for completion/hover, never for a "must be known" diagnostic.
 */
export interface AttributeRef {
	name: string;
	range: Range;
}

/** The offset sits inside the amount portion (after the `/`) of a stack shorthand string (`"name/amount"` - see `parseStackShorthand`). Drives amount completion/hover. */
export interface StackAmountRef {
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
	/**
	 * Set when the offset sits on a bare-string token whose field type
	 * resolves to an Enum-superclass schema (e.g. `category: distribution`,
	 * where `category`'s type `mindustry.type.Category` has `superclass:
	 * "Enum"`). Drives enum-value completion/hover/diagnostics.
	 */
	enumRef: { info: EnumInfo; range: Range } | undefined;
	/** Set when the offset sits on a bare-string token that refers to a vanilla Effect by name (a string value of an Effect-typed field). */
	effectRef: EffectRef | undefined;
	/** Set when the offset sits on a bare-string token that refers to a Sound by name (a string value of a Sound-typed field, or an element of that field's "random sound" array shorthand). */
	soundRef: SoundRef | undefined;
	/** Set when the offset sits on a bare-string token that refers to a Team by name (a string value of a Team-typed field, or an element of a Team array field). */
	teamRef: TeamRef | undefined;
	/** Set when the offset sits on a bare-string token naming an attribute - either a singular `Attribute`-typed field's value, or a key inside a plural `Attributes`-typed map object. */
	attributeRef: AttributeRef | undefined;
	/** Set when the offset sits inside the amount portion of a stack shorthand string (`"name/amount"`). */
	stackAmountRef: StackAmountRef | undefined;
}

export function locate(
	parse: ParseResult,
	offset: number,
	registry: SchemaRegistry,
	filePath: string,
	contentTypeFolders: Record<string, string>,
	vanillaContent?: VanillaContentIndex,
): LocateResult {
	let rootCtx = new TypeContext(registry, undefined);
	if (parse.root && parse.root.type === 'object') {
		rootCtx = resolveImplicitTypeContext(registry, filePath, contentTypeFolders, vanillaContent);
		const explicit = findExplicitTypeField(parse.root as JvalObject);
		rootCtx = resolveObjectType(rootCtx, explicit);
	}

	const result: LocateResult = {
		object: undefined,
		ctx: rootCtx,
		onKey: undefined,
		onValue: undefined,
		isMapEntries: false,
		mapKeyType: undefined,
		contentRef: undefined,
		enumRef: undefined,
		effectRef: undefined,
		soundRef: undefined,
		teamRef: undefined,
		attributeRef: undefined,
		stackAmountRef: undefined,
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

/** Checks whether a stack-array-typed array (ItemStack[], LiquidStack[], ...) has a string element (shorthand `name/amount`) containing `offset`. If `offset` sits on the name portion (left of the `/`), records it as a ContentRef of `contentType`; if it sits on the amount portion (right of the `/`), records a StackAmountRef instead - see `parseStackShorthand`. */
function checkStackArrayElement(arr: JvalArray, contentType: string, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			const { name, nameRange, amountRange } = parseStackShorthand(el as JvalString);
			if (contains(nameRange, offset)) result.contentRef = { type: contentType, name, range: nameRange };
			else if (amountRange && contains(amountRange, offset)) result.stackAmountRef = { range: amountRange };
			return;
		}
	}
}

/** Checks whether a "random sound" array (a Sound-typed field given a JSON array) has a string element containing `offset`, recording it as a SoundRef - each element is a bare sound name, same as a scalar Sound field's value. */
function checkSoundArrayElement(arr: JvalArray, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			result.soundRef = { name: (el as any).value, range: el.range };
			return;
		}
	}
}

/** Like `checkSoundArrayElement`, but for a Team array field (`Team[]`/`Seq<Team>`) - each element is a bare team name. */
function checkTeamArrayElement(arr: JvalArray, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			result.teamRef = { name: (el as any).value, range: el.range };
			return;
		}
	}
}

/** If `arr` has a string element containing `offset`, records it as an enumRef using the given EnumInfo. */
function checkEnumArrayElement(arr: JvalArray, info: EnumInfo, offset: number, result: LocateResult) {
	for (const el of arr.elements) {
		if (contains(el.range, offset) && el.type === 'string') {
			result.enumRef = { info, range: el.range };
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
					if (field && isAttributesType(field.type)) {
						visitAttributesEntries(member.value as JvalObject, offset, result, registry);
						return;
					}
					const mapField = ctx.resolveMapField(field);
					if (mapField) {
						visitMapEntries(member.value as JvalObject, mapField.keyType, mapField.valueType, mapField.valueCtx, offset, result, registry);
						return;
					}
					const explicit = findExplicitTypeField(member.value as JvalObject);
					childCtx = resolveObjectType(ctx.forField(field), explicit);
				} else if (member.value.type === 'array') {
					if (field && (isSoundType(field.type) || isSoundArrayType(field.type))) {
						checkSoundArrayElement(member.value as JvalArray, offset, result);
						return;
					}
					if (field && isTeamArrayType(field.type)) {
						checkTeamArrayElement(member.value as JvalArray, offset, result);
						return;
					}
					const arrayContentType = field ? arrayContentTypeSimpleName(field.type) : undefined;
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
						const enumInfo = arrayEnumInfo(registry, field.type);
						if (enumInfo) {
							checkEnumArrayElement(member.value as JvalArray, enumInfo, offset, result);
							return;
						}
					}
					childCtx = ctx.forArrayElement(field);
				} else {
					childCtx = new TypeContext(registry, undefined);
					if (member.value.type === 'string' && field) {
						if (isEffectType(field.type)) {
							result.effectRef = { name: (member.value as any).value, range: member.value.range };
						} else if (isSoundType(field.type)) {
							result.soundRef = { name: (member.value as any).value, range: member.value.range };
						} else if (isTeamType(field.type)) {
							result.teamRef = { name: (member.value as any).value, range: member.value.range };
						} else if (isAttributeType(field.type)) {
							result.attributeRef = { name: (member.value as any).value, range: member.value.range };
						} else {
							const contentType = contentTypeSimpleName(field.type);
							if (contentType) {
								result.contentRef = { type: contentType, name: (member.value as any).value, range: member.value.range };
							} else {
								const stackType = stackContentType(field.type);
								if (stackType) {
									const { name, nameRange, amountRange } = parseStackShorthand(member.value as JvalString);
									if (contains(nameRange, offset)) result.contentRef = { type: stackType, name, range: nameRange };
									else if (amountRange && contains(amountRange, offset)) result.stackAmountRef = { range: amountRange };
								} else {
									const enumInfo = resolveEnumInfo(registry, field.type);
									if (enumInfo) result.enumRef = { info: enumInfo, range: member.value.range };
								}
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
					elCtx = resolveObjectType(ctx, explicit);
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
				visit(entry.value, resolveObjectType(valueCtx, explicit), offset, result, registry);
			} else if (entry.value.type === 'array') {
				visit(entry.value, new TypeContext(registry, undefined), offset, result, registry);
			} else if (entry.value.type === 'string') {
				const valueContentType = contentTypeSimpleName(valueType);
				if (valueContentType) {
					result.contentRef = { type: valueContentType, name: (entry.value as any).value, range: entry.value.range };
				} else {
					const stackType = stackContentType(valueType);
					if (stackType) {
						const { name, nameRange, amountRange } = parseStackShorthand(entry.value as JvalString);
						if (contains(nameRange, offset)) result.contentRef = { type: stackType, name, range: nameRange };
						else if (amountRange && contains(amountRange, offset)) result.stackAmountRef = { range: amountRange };
					}
				}
			}
			return;
		}
	}
}

/**
 * Like `visitMapEntries`, but for the literal object of an `Attributes`-typed field (e.g.
 * `attributes: {heat: 10}`) - entries are extensible attribute names (not fixed schema fields, and
 * never "unknown"), and each entry's *value* is a plain number rather than something with its own
 * nested TypeContext, so unlike `visitMapEntries` there's no `valueCtx` to recurse into.
 */
function visitAttributesEntries(obj: JvalObject, offset: number, result: LocateResult, registry: SchemaRegistry) {
	if (!contains(obj.range, offset)) return;
	result.object = obj;
	result.ctx = new TypeContext(registry, undefined);
	result.isMapEntries = true;
	for (const entry of obj.entries) {
		if (contains(entry.keyRange, offset)) {
			result.onKey = entry;
			result.attributeRef = { name: entry.key, range: entry.keyRange };
			return;
		}
		if (contains(entry.value.range, offset)) {
			result.onValue = entry;
			return;
		}
	}
}
