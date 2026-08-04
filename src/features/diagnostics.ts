import * as vscode from 'vscode';
import { Jval, JvalArray, JvalObject, JvalString, ParseResult } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { ContentIndex } from '../schema/contentIndex';
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
	prettyType,
	resolveObjectType,
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
) {
	const diagnostics: vscode.Diagnostic[] = [];

	for (const err of parse.errors) {
		diagnostics.push(new vscode.Diagnostic(rangeOf(doc, err.range), err.message, vscode.DiagnosticSeverity.Error));
	}

	if (parse.root && registry.size > 0) {
		let ctx = new TypeContext(registry, undefined);
		if (parse.root.type === 'object') {
			ctx = resolveImplicitTypeContext(registry, doc.uri.fsPath, contentTypeFolders, vanillaContent);
			const explicit = findExplicitTypeField(parse.root as JvalObject);
			ctx = resolveObjectType(ctx, explicit);
		}
		walk(parse.root, ctx, doc, diagnostics, registry, contentIndex, vanillaContent);
	}

	collection.set(doc.uri, diagnostics);
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
) {
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
) {
	const contentType = arrayContentTypeSimpleName(fieldType) ?? stackArrayContentType(fieldType);
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

function walk(
	node: Jval,
	ctx: TypeContext,
	doc: vscode.TextDocument,
	out: vscode.Diagnostic[],
	registry: SchemaRegistry,
	contentIndex: ContentIndex,
	vanillaContent: VanillaContentIndex,
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
						checkStringValue(member.value as JvalString, field.type, registry, doc, out, contentIndex, vanillaContent);
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

			let childCtx: TypeContext;
			if (member.value.type === 'object') {
				const mapField = ctx.resolveMapField(field);
				if (mapField) {
					walkMapEntries(member.value as JvalObject, mapField.valueCtx, doc, out, registry, contentIndex, vanillaContent);
					continue;
				}
				const explicit = findExplicitTypeField(member.value as JvalObject);
				childCtx = resolveObjectType(ctx.forField(field), explicit);
			} else if (member.value.type === 'array') {
				if (field) checkStringArray(member.value as JvalArray, field.type, registry, doc, out, contentIndex, vanillaContent);
				childCtx = ctx.forArrayElement(field);
			} else {
				childCtx = new TypeContext(registry, undefined);
				if (member.value.type === 'string' && field) {
					checkStringValue(member.value as JvalString, field.type, registry, doc, out, contentIndex, vanillaContent);
				}
			}
			walk(member.value, childCtx, doc, out, registry, contentIndex, vanillaContent);
		}
	} else if (node.type === 'array') {
		for (const el of node.elements) {
			let elCtx = ctx;
			if (el.type === 'object') {
				const explicit = findExplicitTypeField(el as JvalObject);
				elCtx = resolveObjectType(ctx, explicit);
			}
			walk(el, elCtx, doc, out, registry, contentIndex, vanillaContent);
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
) {
	for (const entry of mapObj.entries) {
		let childCtx = valueCtx;
		if (entry.value.type === 'object') {
			const explicit = findExplicitTypeField(entry.value as JvalObject);
			childCtx = resolveObjectType(valueCtx, explicit);
		} else if (entry.value.type === 'array') {
			childCtx = new TypeContext(registry, undefined);
		}
		walk(entry.value, childCtx, doc, out, registry, contentIndex, vanillaContent);
	}
}

function rangeOf(doc: vscode.TextDocument, r: { start: number; end: number }): vscode.Range {
	return new vscode.Range(doc.positionAt(r.start), doc.positionAt(Math.max(r.end, r.start + 1)));
}
