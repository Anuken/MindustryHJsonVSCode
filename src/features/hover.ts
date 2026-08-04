import * as vscode from 'vscode';
import { parseMHJson, JvalString } from '../parser/mhjsonParser';
import { SchemaRegistry, TYPE_FIELD } from '../schema/schemaLoader';
import { locate } from './locate';

export class MHJsonHoverProvider implements vscode.HoverProvider {
	constructor(private registry: SchemaRegistry, private getContentTypeFolders: () => Record<string, string>) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const parse = parseMHJson(text);
		const loc = locate(parse, offset, this.registry, document.uri.fsPath, this.getContentTypeFolders());

		// Hovering the *value* of `type: SimpleName` -> look up that class's schema and show its doc.
		if (loc.onValue && loc.onValue.key === 'type' && loc.onValue.value.type === 'string') {
			const simpleName = (loc.onValue.value as JvalString).value;
			const schema = this.registry.getBySimpleName(simpleName);
			if (schema) {
				const md = new vscode.MarkdownString();
				md.appendCodeblock(schema.fqcn, 'java');
				if (schema.doc) md.appendMarkdown(schema.doc);
				const range = new vscode.Range(document.positionAt(loc.onValue.value.range.start), document.positionAt(loc.onValue.value.range.end));
				return new vscode.Hover(md, range);
			}
			return undefined;
		}

		const member = loc.onKey;
		if (!member) return undefined;

		if (loc.mapKeyType) {
			const md = new vscode.MarkdownString();
			md.appendCodeblock(`${member.key}: ${loc.mapKeyType}`, 'java');
			md.appendMarkdown('Key of this map.');
			const range = new vscode.Range(document.positionAt(member.keyRange.start), document.positionAt(member.keyRange.end));
			return new vscode.Hover(md, range);
		}

		const field = member.key === 'type' ? TYPE_FIELD : loc.ctx.schemaFields.get(member.key);
		if (!field) return undefined;

		const md = new vscode.MarkdownString();
		md.appendCodeblock(`${member.key}: ${field.type}`, 'java');
		if (field.doc) md.appendMarkdown(field.doc + '\n\n');
		if (field.default !== undefined) md.appendMarkdown(`*Default:* \`${field.default}\``);
		const range = new vscode.Range(document.positionAt(member.keyRange.start), document.positionAt(member.keyRange.end));
		return new vscode.Hover(md, range);
	}
}
