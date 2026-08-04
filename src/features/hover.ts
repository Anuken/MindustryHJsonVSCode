import * as vscode from 'vscode';
import * as path from 'path';
import { parseMHJson, JvalString } from '../parser/mhjsonParser';
import { SchemaRegistry, TYPE_FIELD } from '../schema/schemaLoader';
import { ContentIndex } from '../schema/contentIndex';
import { VanillaContentIndex } from '../schema/vanillaContent';
import { prettyType } from '../schema/typeResolver';
import { locate } from './locate';

export class MHJsonHoverProvider implements vscode.HoverProvider {
	constructor(
		private registry: SchemaRegistry,
		private getContentTypeFolders: () => Record<string, string>,
		private contentIndex: ContentIndex,
		private vanillaContent: VanillaContentIndex,
	) {}

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const parse = parseMHJson(text);
		const loc = locate(parse, offset, this.registry, document.uri.fsPath, this.getContentTypeFolders(), this.vanillaContent);

		// Hovering a bare-string content reference -> show which file(s) it resolves to.
		if (loc.contentRef) {
			const { type, name, range } = loc.contentRef;
			const uris = this.contentIndex.lookup(type, name);
			const md = new vscode.MarkdownString();
			md.appendCodeblock(`${name}: ${type}`, 'java');
			if (uris.length > 0) {
				const wsFolder = vscode.workspace.getWorkspaceFolder(uris[0]);
				for (const uri of uris) {
					const rel = wsFolder ? path.relative(wsFolder.uri.fsPath, uri.fsPath) : uri.fsPath;
					md.appendMarkdown(`\n\n${rel}`);
				}
			} else if (this.vanillaContent.has(type, name)) {
				md.appendMarkdown(`\n\n*Vanilla content.*`);
			} else {
				md.appendMarkdown(`\n\n*Unknown ${type} '${name}'.*`);
			}
			const hoverRange = new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
			return new vscode.Hover(md, hoverRange);
		}

		// Hovering a bare-string enum field value -> show the enum type and its legal values.
		if (loc.enumRef) {
			const { info, range } = loc.enumRef;
			const md = new vscode.MarkdownString();
			md.appendCodeblock(prettyType(info.fqcn), 'java');
			md.appendMarkdown(`Values: ${info.values.map((v) => `\`${v}\``).join(', ')}`);
			const hoverRange = new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
			return new vscode.Hover(md, hoverRange);
		}

		// Hovering the *value* of `type: SimpleName` -> look up that class's schema and show its doc.
		if (loc.onValue && loc.onValue.key === 'type' && loc.onValue.value.type === 'string' && !loc.ctx.schemaFields.has('type')) {
			const simpleName = (loc.onValue.value as JvalString).value;
			const schema = this.registry.getBySimpleName(simpleName);
			if (schema) {
				const md = new vscode.MarkdownString();
				md.appendCodeblock(prettyType(schema.fqcn), 'java');
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

		const field = loc.ctx.schemaFields.get(member.key) ?? (member.key === 'type' ? TYPE_FIELD : undefined);
		if (!field) return undefined;

		const md = new vscode.MarkdownString();
		md.appendCodeblock(`${member.key}: ${prettyType(field.type)}`, 'java');
		if (field.doc) md.appendMarkdown(field.doc + '\n\n');
		if (field.default !== undefined) md.appendMarkdown(`*Default:* \`${field.default}\``);
		const range = new vscode.Range(document.positionAt(member.keyRange.start), document.positionAt(member.keyRange.end));
		return new vscode.Hover(md, range);
	}
}
