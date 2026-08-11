import * as vscode from 'vscode';
import { Jval, JvalArray, JvalObject, JvalString, ParseResult } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { ContentIndex } from '../schema/contentIndex';
import { VanillaContentIndex } from '../schema/vanillaContent';
import { NameListIndex } from '../schema/nameListIndex';
import { SoundIndex } from '../schema/soundIndex';
import {
	TypeContext,
	findExplicitTypeMember,
	resolveImplicitTypeContext,
	contentTypeSimpleName,
	arrayContentTypeSimpleName,
	stackContentType,
	stackArrayContentType,
	resolveEnumInfo,
	arrayEnumInfo,
	prettyType,
	resolveObjectType,
	checkPrimitiveShapeMismatch,
	arrayElementTypeString,
	isNumericType,
	isBooleanType,
	describeJvalType,
	isEffectType,
	isSoundType,
	isSoundArrayType,
	isTeamType,
	isTeamArrayType,
	isAttributeType,
	isAttributesType,
	parseStackShorthand,
	isValidNumberString,
} from '../schema/typeResolver';

export function makeDiagnosticCollection(): vscode.DiagnosticCollection {
	return vscode.languages.createDiagnosticCollection('mhjson');
}

export function refreshDiagnostics(
	doc: vscode.TextDocument,
	parse: ParseResult,
	registry: SchemaRegistry,
	contentTypeFolders: Record<string, string>,
	collection: vscode.DiagnosticCollection,
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
	vanillaEffects: NameListIndex,
	vanillaSounds: NameListIndex,
	soundIndex: SoundIndex,
	vanillaTeams: NameListIndex,
) {
	const diagnostics: vscode.Diagnostic[] = [];

	for (const err of parse.errors) {
		diagnostics.push(new vscode.Diagnostic(rangeOf(doc, err.range), err.message, vscode.DiagnosticSeverity.Error));
	}

	if (parse.root && registry.size > 0) {
		let ctx = new TypeContext(registry, undefined);
		if (parse.root.type === 'object') {
			ctx = resolveImplicitTypeContext(registry, doc.uri.fsPath, contentTypeFolders, vanillaContent);
			ctx = resolveObjectTypeChecked(ctx, parse.root as JvalObject, doc, diagnostics);
		}
		walk(parse.root, ctx, doc, diagnostics, registry, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
	}

	collection.set(doc.uri, diagnostics);
}

/** Validates the amount portion of a stack shorthand string (`"name/amount"`), pushing a warning if it's missing or not a valid number. No-op if the string has no `/` at all (the amount-less shorthand is legal on its own). */
function checkStackAmount(value: JvalString, doc: vscode.TextDocument, out: vscode.Diagnostic[]) {
	const { amount, amountRange } = parseStackShorthand(value);
	if (amount === undefined) return;
	if (amount.length === 0) {
		const diag = new vscode.Diagnostic(rangeOf(doc, amountRange!), `Missing amount after '/'`, vscode.DiagnosticSeverity.Warning);
		diag.code = 'invalid-amount';
		out.push(diag);
	} else if (!isValidNumberString(amount)) {
		const diag = new vscode.Diagnostic(rangeOf(doc, amountRange!), `Invalid amount '${amount}' - expected a number`, vscode.DiagnosticSeverity.Warning);
		diag.code = 'invalid-amount';
		out.push(diag);
	}
}

/** Validates an object literal given for an `Attributes`-typed field (e.g. `attributes: {heat: 10}`): the object's keys are extensible attribute names (never flagged as unknown), but every value must be a number. */
function checkAttributesObject(obj: JvalObject, doc: vscode.TextDocument, out: vscode.Diagnostic[]) {
	for (const entry of obj.entries) {
		if (entry.value.type === 'double' || entry.value.type === 'long' || entry.value.type === 'null') continue;
		const diag = new vscode.Diagnostic(
			rangeOf(doc, entry.value.range),
			`Expected a number for attribute '${entry.key}', got ${describeJvalType(entry.value.type)}`,
			vscode.DiagnosticSeverity.Warning,
		);
		diag.code = 'type-mismatch';
		out.push(diag);
	}
}

/** Checks a bare-string value against a content-typed or enum-typed field, pushing a warning if it's unresolvable/unknown. */
function checkStringValue(
	value: JvalString,
	fieldType: string,
	registry: SchemaRegistry,
	doc: vscode.TextDocument,
	out: vscode.Diagnostic[],
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
	vanillaEffects: NameListIndex,
	vanillaSounds: NameListIndex,
	soundIndex: SoundIndex,
	vanillaTeams: NameListIndex,
) {
	if (isEffectType(fieldType)) {
		if (!vanillaEffects.has(value.value)) {
			const diag = new vscode.Diagnostic(rangeOf(doc, value.range), `Unknown effect '${value.value}'`, vscode.DiagnosticSeverity.Warning);
			diag.code = 'unknown-effect';
			out.push(diag);
		}
		return;
	}
	if (isSoundType(fieldType)) {
		if (!vanillaSounds.has(value.value) && !soundIndex.has(value.value)) {
			const diag = new vscode.Diagnostic(rangeOf(doc, value.range), `Unknown sound '${value.value}'`, vscode.DiagnosticSeverity.Warning);
			diag.code = 'unknown-sound';
			out.push(diag);
		}
		return;
	}
	if (isTeamType(fieldType)) {
		// Unlike Effect/Sound/Attribute, team names aren't extensible - anything not in
		// allTeams.json is always unknown, never just "not indexed yet".
		if (!vanillaTeams.has(value.value)) {
			const diag = new vscode.Diagnostic(rangeOf(doc, value.range), `Unknown team '${value.value}'`, vscode.DiagnosticSeverity.Warning);
			diag.code = 'unknown-team';
			out.push(diag);
		}
		return;
	}
	if (isAttributeType(fieldType)) {
		// Attribute names are extensible at runtime (Attribute.add(...) for anything unrecognized) -
		// never flagged as unknown, same as Effect/Sound would be if they had a similar `.add`.
		return;
	}
	const contentType = contentTypeSimpleName(fieldType);
	if (contentType) {
		const name = value.value.indexOf('/') >= 0 ? value.value.slice(0, value.value.indexOf('/')) : value.value;
		if (contentIndex.lookup(contentType, name).length === 0 && !vanillaContent.has(contentType, name)) {
			const diag = new vscode.Diagnostic(rangeOf(doc, value.range), `Unknown ${contentType} '${name}'`, vscode.DiagnosticSeverity.Warning);
			diag.code = 'unknown-content';
			out.push(diag);
		}
		return;
	}
	const stackType = stackContentType(fieldType);
	if (stackType) {
		const name = value.value.indexOf('/') >= 0 ? value.value.slice(0, value.value.indexOf('/')) : value.value;
		if (contentIndex.lookup(stackType, name).length === 0 && !vanillaContent.has(stackType, name)) {
			const diag = new vscode.Diagnostic(rangeOf(doc, value.range), `Unknown ${stackType} '${name}'`, vscode.DiagnosticSeverity.Warning);
			diag.code = 'unknown-content';
			out.push(diag);
		}
		checkStackAmount(value, doc, out);
		return;
	}
	const enumInfo = resolveEnumInfo(registry, fieldType);
	if (enumInfo && !enumInfo.values.includes(value.value)) {
		const diag = new vscode.Diagnostic(
			rangeOf(doc, value.range),
			`Unknown value '${value.value}' for ${prettyType(enumInfo.fqcn)}. Expected one of: ${enumInfo.values.join(', ')}`,
			vscode.DiagnosticSeverity.Warning,
		);
		diag.code = 'unknown-enum-value';
		out.push(diag);
	}
}

/** Like `checkStringValue`, but for each string element of a content/enum-typed array field. */
function checkStringArray(
	arr: JvalArray,
	fieldType: string,
	registry: SchemaRegistry,
	doc: vscode.TextDocument,
	out: vscode.Diagnostic[],
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
	vanillaSounds: NameListIndex,
	soundIndex: SoundIndex,
	vanillaTeams: NameListIndex,
) {
	// A Sound[]-typed field (or rather, a JSON array given for a Sound-typed
	// field - Mindustry's "random sound" shorthand) isn't a Seq<Sound> field
	// declared that way in schema; it's a bare `Sound` field whose value
	// happens to be an array. Each element is checked exactly like a
	// Sound-typed string field would be. (Effect has no analogous array
	// case: an array given for an Effect field is a custom MultiEffect
	// shorthand instead - see forArrayElement - so it's deliberately left
	// unchecked here.)
	if (isSoundType(fieldType) || isSoundArrayType(fieldType)) {
		for (const el of arr.elements) {
			if (el.type !== 'string') continue;
			const str = el as JvalString;
			if (!vanillaSounds.has(str.value) && !soundIndex.has(str.value)) {
				const diag = new vscode.Diagnostic(rangeOf(doc, str.range), `Unknown sound '${str.value}'`, vscode.DiagnosticSeverity.Warning);
				diag.code = 'unknown-sound';
				out.push(diag);
			}
		}
		return;
	}
	if (isTeamArrayType(fieldType)) {
		for (const el of arr.elements) {
			if (el.type !== 'string') continue;
			const str = el as JvalString;
			if (!vanillaTeams.has(str.value)) {
				const diag = new vscode.Diagnostic(rangeOf(doc, str.range), `Unknown team '${str.value}'`, vscode.DiagnosticSeverity.Warning);
				diag.code = 'unknown-team';
				out.push(diag);
			}
		}
		return;
	}
	const contentType = arrayContentTypeSimpleName(fieldType) ?? stackArrayContentType(fieldType);
	const isStackArray = contentType !== undefined && stackArrayContentType(fieldType) !== undefined;
	const enumInfo = contentType ? undefined : arrayEnumInfo(registry, fieldType);
	if (!contentType && !enumInfo) return;
	for (const el of arr.elements) {
		if (el.type !== 'string') continue;
		const str = el as JvalString;
		if (contentType) {
			const name = str.value.indexOf('/') >= 0 ? str.value.slice(0, str.value.indexOf('/')) : str.value;
			if (contentIndex.lookup(contentType, name).length === 0 && !vanillaContent.has(contentType, name)) {
				const diag = new vscode.Diagnostic(rangeOf(doc, str.range), `Unknown ${contentType} '${name}'`, vscode.DiagnosticSeverity.Warning);
				diag.code = 'unknown-content';
				out.push(diag);
			}
			if (isStackArray) checkStackAmount(str, doc, out);
		} else if (enumInfo && !enumInfo.values.includes(str.value)) {
			const diag = new vscode.Diagnostic(
				rangeOf(doc, str.range),
				`Unknown value '${str.value}' for ${prettyType(enumInfo.fqcn)}. Expected one of: ${enumInfo.values.join(', ')}`,
				vscode.DiagnosticSeverity.Warning,
			);
			diag.code = 'unknown-enum-value';
			out.push(diag);
		}
	}
}

/** For an array field whose element type is a numeric or boolean primitive (e.g. `float[]`, `Seq<Boolean>`), warns on any element whose JSON value kind doesn't match. Elements of any other (unrecognized) element type are left alone, same as `checkPrimitiveShapeMismatch`. */
function checkArrayElementPrimitives(arr: JvalArray, fieldType: string, doc: vscode.TextDocument, out: vscode.Diagnostic[]) {
	const elementType = arrayElementTypeString(fieldType);
	if (!elementType) return;
	const numeric = isNumericType(elementType);
	const boolean = isBooleanType(elementType);
	if (!numeric && !boolean) return;
	for (const el of arr.elements) {
		if (el.type === 'null') continue;
		const ok = numeric ? el.type === 'double' || el.type === 'long' : el.type === 'boolean';
		if (ok) continue;
		const diag = new vscode.Diagnostic(
			rangeOf(doc, el.range),
			`Expected ${numeric ? 'a number' : 'a boolean'} element for type '${prettyType(fieldType)}', got ${describeJvalType(el.type)}`,
			vscode.DiagnosticSeverity.Warning,
		);
		diag.code = 'type-mismatch';
		out.push(diag);
	}
}

/**
 * Resolves an object literal's effective TypeContext (see `resolveObjectType`), additionally
 * pushing a warning diagnostic if its own `type: X` entry (when present, and actually being used
 * as a polymorphic subclass selector) names a class that isn't really a subclass of `baseCtx` -
 * e.g. `destroyBullet: {type: Conveyor}` where `destroyBullet` is BulletType-typed, or a block file
 * under `blocks/` declaring `type: Item`. See `TypeContext.checkSubclassMismatch`.
 */
function resolveObjectTypeChecked(baseCtx: TypeContext, obj: JvalObject, doc: vscode.TextDocument, out: vscode.Diagnostic[]): TypeContext {
	const member = findExplicitTypeMember(obj);
	if (!member) return baseCtx;
	const value = member.value as JvalString;
	const mismatch = baseCtx.checkSubclassMismatch(value.value);
	if (mismatch) {
		const diag = new vscode.Diagnostic(rangeOf(doc, value.range), mismatch, vscode.DiagnosticSeverity.Warning);
		diag.code = 'type-mismatch';
		out.push(diag);
		// Don't apply the mismatched override - keep checking this object's other members against
		// the *expected* base type instead of cascading into "unknown field" spam for every field
		// that doesn't happen to exist on the (wrong) type the mod author wrote.
		return baseCtx;
	}
	return resolveObjectType(baseCtx, value.value);
}

function walk(
	node: Jval,
	ctx: TypeContext,
	doc: vscode.TextDocument,
	out: vscode.Diagnostic[],
	registry: SchemaRegistry,
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
	vanillaEffects: NameListIndex,
	vanillaSounds: NameListIndex,
	soundIndex: SoundIndex,
	vanillaTeams: NameListIndex,
) {
	if (node.type === 'object') {
		const fields = ctx.schemaFields;
		const haveSchema = ctx.fqcn !== undefined && fields.size > 0;
		for (const member of node.entries) {
			const field = fields.get(member.key);

			if (member.key === 'type') {
				if (field) {
					// Schema declares its own 'type' field (e.g. UnitType.type: JsonUnitType) -
					// it's a normal field, not the polymorphic subclass selector below.
					if (member.value.type === 'string') {
						checkStringValue(member.value as JvalString, field.type, registry, doc, out, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
					}
				} else if (member.value.type === 'string') {
					// Default polymorphic subclass selector, e.g. `type: FlakBulletType` - warn if unresolved.
					const simpleName = (member.value as JvalString).value;
					if (!registry.getBySimpleName(simpleName)) {
						const diag = new vscode.Diagnostic(rangeOf(doc, member.value.range), `Unknown type '${simpleName}'`, vscode.DiagnosticSeverity.Warning);
						diag.code = 'unknown-type';
						out.push(diag);
					}
				}
				continue; // 'type' is always a legal field, and its value is a scalar - nothing more to walk into
			}

			if (haveSchema && !field) {
				const diag = new vscode.Diagnostic(
					rangeOf(doc, member.keyRange),
					`Unknown field '${member.key}' for type '${prettyType(ctx.fqcn!)}'`,
					vscode.DiagnosticSeverity.Warning,
				);
				diag.code = 'unknown-field';
				out.push(diag);
			}

			if (field) {
				const mismatch = checkPrimitiveShapeMismatch(field.type, member.value.type);
				if (mismatch) {
					const diag = new vscode.Diagnostic(rangeOf(doc, member.value.range), mismatch, vscode.DiagnosticSeverity.Warning);
					diag.code = 'type-mismatch';
					out.push(diag);
				}
			}

			let childCtx: TypeContext;
			if (member.value.type === 'object') {
				if (field && isAttributesType(field.type)) {
					checkAttributesObject(member.value as JvalObject, doc, out);
					continue;
				}
				const mapField = ctx.resolveMapField(field);
				if (mapField) {
					walkMapEntries(member.value as JvalObject, mapField.valueCtx, doc, out, registry, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
					continue;
				}
				childCtx = resolveObjectTypeChecked(ctx.forField(field), member.value as JvalObject, doc, out);
			} else if (member.value.type === 'array') {
				if (field) {
					checkStringArray(member.value as JvalArray, field.type, registry, doc, out, contentIndex, vanillaContent, vanillaSounds, soundIndex, vanillaTeams);
					checkArrayElementPrimitives(member.value as JvalArray, field.type, doc, out);
				}
				childCtx = ctx.forArrayElement(field);
			} else {
				childCtx = new TypeContext(registry, undefined);
				if (member.value.type === 'string' && field) {
					checkStringValue(member.value as JvalString, field.type, registry, doc, out, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
				}
			}
			walk(member.value, childCtx, doc, out, registry, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
		}
	} else if (node.type === 'array') {
		for (const el of node.elements) {
			let elCtx = ctx;
			if (el.type === 'object') {
				elCtx = resolveObjectTypeChecked(ctx, el as JvalObject, doc, out);
			}
			walk(el, elCtx, doc, out, registry, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
		}
	}
}

/** Like `walk`, but for the literal object of an ObjectMap<Key, Value>-typed field: entries are
 * arbitrary map keys (never "unknown fields"), and each entry's value is checked against `valueCtx`. */
function walkMapEntries(
	mapObj: JvalObject,
	valueCtx: TypeContext,
	doc: vscode.TextDocument,
	out: vscode.Diagnostic[],
	registry: SchemaRegistry,
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
	vanillaEffects: NameListIndex,
	vanillaSounds: NameListIndex,
	soundIndex: SoundIndex,
	vanillaTeams: NameListIndex,
) {
	for (const entry of mapObj.entries) {
		let childCtx = valueCtx;
		if (entry.value.type === 'object') {
			childCtx = resolveObjectTypeChecked(valueCtx, entry.value as JvalObject, doc, out);
		} else if (entry.value.type === 'array') {
			childCtx = new TypeContext(registry, undefined);
		}
		walk(entry.value, childCtx, doc, out, registry, contentIndex, vanillaContent, vanillaEffects, vanillaSounds, soundIndex, vanillaTeams);
	}
}

function rangeOf(doc: vscode.TextDocument, r: { start: number; end: number }): vscode.Range {
	return new vscode.Range(doc.positionAt(r.start), doc.positionAt(Math.max(r.end, r.start + 1)));
}