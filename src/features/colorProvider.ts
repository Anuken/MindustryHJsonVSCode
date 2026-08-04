import * as vscode from 'vscode';
import { Jval, JvalArray, JvalObject, JvalString, parseMHJson } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { TypeContext, findExplicitTypeField, inferImplicitType, isColorArrayType, isColorType } from '../schema/typeResolver';

/** Matches a bare (optionally '#'-prefixed) 6- or 8-digit hex color, e.g. "ffbb44" or "c2464666". */
const HEX_COLOR = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Shows inline color swatches (and VS Code's native color picker) for
 * string fields whose schema type is `arc.graphics.Color` or an array of it
 * (e.g. a bullet's `colors: [...]`). Mindustry mods write colors as bare hex
 * strings with no '#' required, so string values are only treated as colors
 * when both the schema says `Color` *and* the text parses as hex - this
 * keeps non-color strings (e.g. a `type:` value) from ever being touched.
 */
export class MHJsonColorProvider implements vscode.DocumentColorProvider {
	constructor(
		private registry: SchemaRegistry,
		private getContentTypeFolders: () => Record<string, string>,
	) {}

	provideDocumentColors(document: vscode.TextDocument): vscode.ColorInformation[] {
		if (this.registry.size === 0) return [];
		const parse = parseMHJson(document.getText());
		if (!parse.root) return [];

		const implicitSimple = inferImplicitType(document.uri.fsPath, this.getContentTypeFolders());
		let ctx = new TypeContext(this.registry, undefined);
		if (parse.root.type === 'object') {
			const explicit = findExplicitTypeField(parse.root as JvalObject) ?? implicitSimple;
			ctx = ctx.withExplicitType(explicit);
		}

		const out: vscode.ColorInformation[] = [];
		walk(parse.root, ctx, document, out, this.registry);
		return out;
	}

	provideColorPresentations(color: vscode.Color, context: { document: vscode.TextDocument; range: vscode.Range }): vscode.ColorPresentation[] {
		const original = context.document.getText(context.range);
		const hasHash = original.startsWith('#');
		const hadAlpha = (hasHash ? original.slice(1) : original).length === 8;

		const toHex = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
		let hex = toHex(color.red) + toHex(color.green) + toHex(color.blue);
		if (hadAlpha || color.alpha < 1) hex += toHex(color.alpha);

		return [new vscode.ColorPresentation((hasHash ? '#' : '') + hex)];
	}
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function parseHexColor(raw: string): vscode.Color | undefined {
	const m = HEX_COLOR.exec(raw.trim());
	if (!m) return undefined;
	const hex = m[1];
	const r = parseInt(hex.slice(0, 2), 16) / 255;
	const g = parseInt(hex.slice(2, 4), 16) / 255;
	const b = parseInt(hex.slice(4, 6), 16) / 255;
	const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
	return new vscode.Color(r, g, b, a);
}

/** Range of a string node's inner text, excluding surrounding quotes for quoted strings - this is
 * what gets replaced when the user edits the color, so existing quotes are left untouched. */
function innerRange(document: vscode.TextDocument, node: JvalString): vscode.Range {
	const start = node.range.start + (node.quoted ? 1 : 0);
	const end = node.range.end - (node.quoted ? 1 : 0);
	return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function tryPushColor(node: Jval, document: vscode.TextDocument, out: vscode.ColorInformation[]) {
	if (node.type !== 'string') return;
	const color = parseHexColor(node.value);
	if (!color) return;
	out.push(new vscode.ColorInformation(innerRange(document, node), color));
}

function walk(node: Jval, ctx: TypeContext, document: vscode.TextDocument, out: vscode.ColorInformation[], registry: SchemaRegistry) {
	if (node.type === 'object') {
		const fields = ctx.schemaFields;
		for (const member of node.entries) {
			if (member.key === 'type') continue;
			const field = fields.get(member.key);

			if (member.value.type === 'string' && field && isColorType(field.type)) {
				tryPushColor(member.value, document, out);
				continue;
			}
			if (member.value.type === 'array' && field && isColorArrayType(field.type)) {
				for (const el of (member.value as JvalArray).elements) tryPushColor(el, document, out);
				continue;
			}

			let childCtx: TypeContext;
			if (member.value.type === 'object') {
				const mapField = ctx.resolveMapField(field);
				if (mapField) {
					walkMapEntries(member.value as JvalObject, mapField.valueCtx, mapField.valueType, document, out, registry);
					continue;
				}
				const explicit = findExplicitTypeField(member.value as JvalObject);
				childCtx = ctx.forField(field).withExplicitType(explicit);
			} else if (member.value.type === 'array') {
				childCtx = ctx.forArrayElement(field);
			} else {
				childCtx = new TypeContext(registry, undefined);
			}
			walk(member.value, childCtx, document, out, registry);
		}
	} else if (node.type === 'array') {
		for (const el of node.elements) {
			let elCtx = ctx;
			if (el.type === 'object') {
				const explicit = findExplicitTypeField(el as JvalObject);
				elCtx = ctx.withExplicitType(explicit);
			}
			walk(el, elCtx, document, out, registry);
		}
	}
}

/** Like `walk`, but for the literal object of an ObjectMap<Key, Value>-typed field. */
function walkMapEntries(
	mapObj: JvalObject,
	valueCtx: TypeContext,
	valueType: string,
	document: vscode.TextDocument,
	out: vscode.ColorInformation[],
	registry: SchemaRegistry,
) {
	const valueIsColor = isColorType(valueType);
	for (const entry of mapObj.entries) {
		if (entry.value.type === 'string' && valueIsColor) {
			tryPushColor(entry.value, document, out);
			continue;
		}
		let childCtx = valueCtx;
		if (entry.value.type === 'object') {
			const explicit = findExplicitTypeField(entry.value as JvalObject);
			childCtx = valueCtx.withExplicitType(explicit);
		} else if (entry.value.type === 'array') {
			childCtx = new TypeContext(registry, undefined);
		}
		walk(entry.value, childCtx, document, out, registry);
	}
}
