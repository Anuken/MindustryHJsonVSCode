import * as vscode from 'vscode';
import { Jval, JvalObject, ParseResult } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { TypeContext, findExplicitTypeField, inferImplicitType } from '../schema/typeResolver';

export function makeDiagnosticCollection(): vscode.DiagnosticCollection {
	return vscode.languages.createDiagnosticCollection('mhjson');
}

export function refreshDiagnostics(
	doc: vscode.TextDocument,
	parse: ParseResult,
	registry: SchemaRegistry,
	contentTypeFolders: Record<string, string>,
	collection: vscode.DiagnosticCollection,
) {
	const diagnostics: vscode.Diagnostic[] = [];

	for (const err of parse.errors) {
		diagnostics.push(new vscode.Diagnostic(rangeOf(doc, err.range), err.message, vscode.DiagnosticSeverity.Error));
	}

	if (parse.root && registry.size > 0) {
		const implicitSimple = inferImplicitType(doc.uri.fsPath, contentTypeFolders);
		let ctx = new TypeContext(registry, undefined);
		if (parse.root.type === 'object') {
			const explicit = findExplicitTypeField(parse.root as JvalObject) ?? implicitSimple;
			ctx = ctx.withExplicitType(explicit);
		}
		walk(parse.root, ctx, doc, diagnostics, registry);
	}

	collection.set(doc.uri, diagnostics);
}

function walk(node: Jval, ctx: TypeContext, doc: vscode.TextDocument, out: vscode.Diagnostic[], registry: SchemaRegistry) {
	if (node.type === 'object') {
		const fields = ctx.schemaFields;
		const haveSchema = ctx.fqcn !== undefined && fields.size > 0;
		for (const member of node.entries) {
			if (member.key === 'type') continue; // always legal
			const field = fields.get(member.key);
			if (haveSchema && !field) {
				const diag = new vscode.Diagnostic(
					rangeOf(doc, member.keyRange),
					`Unknown field '${member.key}' for type '${ctx.fqcn}'`,
					vscode.DiagnosticSeverity.Warning,
				);
				diag.code = 'unknown-field';
				out.push(diag);
			}

			let childCtx: TypeContext;
			if (member.value.type === 'object') {
				const mapField = ctx.resolveMapField(field);
				if (mapField) {
					walkMapEntries(member.value as JvalObject, mapField.valueCtx, doc, out, registry);
					continue;
				}
				const explicit = findExplicitTypeField(member.value as JvalObject);
				childCtx = ctx.forField(field).withExplicitType(explicit);
			} else if (member.value.type === 'array') {
				childCtx = ctx.forArrayElement(field);
			} else {
				childCtx = new TypeContext(registry, undefined);
			}
			walk(member.value, childCtx, doc, out, registry);
		}
	} else if (node.type === 'array') {
		for (const el of node.elements) {
			let elCtx = ctx;
			if (el.type === 'object') {
				const explicit = findExplicitTypeField(el as JvalObject);
				elCtx = ctx.withExplicitType(explicit);
			}
			walk(el, elCtx, doc, out, registry);
		}
	}
}

/** Like `walk`, but for the literal object of an ObjectMap<Key, Value>-typed field: entries are
 * arbitrary map keys (never "unknown fields"), and each entry's value is checked against `valueCtx`. */
function walkMapEntries(mapObj: JvalObject, valueCtx: TypeContext, doc: vscode.TextDocument, out: vscode.Diagnostic[], registry: SchemaRegistry) {
	for (const entry of mapObj.entries) {
		let childCtx = valueCtx;
		if (entry.value.type === 'object') {
			const explicit = findExplicitTypeField(entry.value as JvalObject);
			childCtx = valueCtx.withExplicitType(explicit);
		} else if (entry.value.type === 'array') {
			childCtx = new TypeContext(registry, undefined);
		}
		walk(entry.value, childCtx, doc, out, registry);
	}
}

function rangeOf(doc: vscode.TextDocument, r: { start: number; end: number }): vscode.Range {
	return new vscode.Range(doc.positionAt(r.start), doc.positionAt(Math.max(r.end, r.start + 1)));
}
