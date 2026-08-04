import * as vscode from 'vscode';
import { parseMHJson } from '../parser/mhjsonParser';
import { SchemaRegistry, TYPE_FIELD } from '../schema/schemaLoader';
import { ContentIndex } from '../schema/contentIndex';
import { locate } from './locate';

/** Chars that can appear in a bare key/type token being typed. */
const TOKEN_CHARS = /[A-Za-z0-9_.\-]/;

interface TokenInfo {
	/** Range of the raw token (partial word) the cursor is currently inside/after. */
	range: vscode.Range;
	/** True if a ':' (ignoring whitespace) already follows the token in the document. */
	hasColonAfter: boolean;
}

/** Finds the bare word token touching `offset`, independent of the (possibly error-recovered) AST. */
function currentToken(text: string, offset: number, document: vscode.TextDocument): TokenInfo {
	let start = offset;
	while (start > 0 && TOKEN_CHARS.test(text[start - 1])) start--;
	let end = offset;
	while (end < text.length && TOKEN_CHARS.test(text[end])) end++;
	const rest = text.slice(end);
	const hasColonAfter = /^\s*:/.test(rest);
	return { range: new vscode.Range(document.positionAt(start), document.positionAt(end)), hasColonAfter };
}

export class MHJsonCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private registry: SchemaRegistry,
		private getContentTypeFolders: () => Record<string, string>,
		private contentIndex: ContentIndex,
	) {}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const parse = parseMHJson(text);
		const loc = locate(parse, offset, this.registry, document.uri.fsPath, this.getContentTypeFolders());
		const token = currentToken(text, offset, document);

		// completing a bare-string content reference (e.g. `liquid: `, a Seq<Item> element,
		// or an ObjectMap<Item, ...> key) -> suggest names of that content type found in the mod
		if (loc.contentRef) {
			return this.contentIndex.namesFor(loc.contentRef.type).map((name) => {
				const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
				item.detail = loc.contentRef!.type;
				item.range = token.range;
				return item;
			});
		}

		// completing a `type: ` value -> suggest simple class names
		if (loc.onValue && loc.onValue.key === 'type') {
			return this.registry.getAllSimpleNames().map((name) => {
				const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
				const schema = this.registry.getBySimpleName(name);
				item.detail = schema?.fqcn;
				if (schema?.doc) item.documentation = new vscode.MarkdownString(schema.doc);
				item.range = token.range;
				return item;
			});
		}

		// completing a field name inside an object with a known schema
		if (loc.object) {
			const fields = loc.ctx.schemaFields;
			const already = new Set(loc.object.entries.map((m) => m.key));
			const items: vscode.CompletionItem[] = [];
			for (const [name, field] of fields) {
				if (already.has(name)) continue;
				const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
				item.detail = field.type;
				item.documentation = new vscode.MarkdownString(describeField(field));
				item.range = token.range;
				// Don't append ": <default>" if the user already typed a colon after this key.
				item.insertText = token.hasColonAfter ? name : new vscode.SnippetString(`${name}: \${1:${field.default ?? ''}}`);
				items.push(item);
			}
			if (!already.has('type') && !loc.isMapEntries) {
				const item = new vscode.CompletionItem('type', vscode.CompletionItemKind.Field);
				item.detail = TYPE_FIELD.type;
				item.documentation = new vscode.MarkdownString(describeField(TYPE_FIELD));
				item.range = token.range;
				item.insertText = token.hasColonAfter ? 'type' : new vscode.SnippetString('type: ${1}');
				items.push(item);
			}
			return items;
		}

		return [];
	}
}

function describeField(field: { type: string; doc?: string; default?: string }): string {
	let md = `**${field.type}**`;
	if (field.doc) md += `\n\n${field.doc}`;
	if (field.default !== undefined) md += `\n\n*Default:* \`${field.default}\``;
	return md;
}
