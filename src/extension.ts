import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMHJson } from './parser/mhjsonParser';
import { SchemaRegistry } from './schema/schemaLoader';
import { refreshDiagnostics, makeDiagnosticCollection } from './features/diagnostics';
import { MHJsonCompletionProvider } from './features/completion';
import { MHJsonHoverProvider } from './features/hover';

const LANGUAGE_ID = 'mhjson';

export function activate(context: vscode.ExtensionContext) {
	const registry = new SchemaRegistry();
	const collection = makeDiagnosticCollection();
	context.subscriptions.push(collection);

	function getContentTypeFolders(): Record<string, string> {
		return vscode.workspace.getConfiguration('mindustryHjson').get('contentTypeFolders') ?? {};
	}

	function resolveSchemaFolder(): string | undefined {
		const configured = vscode.workspace.getConfiguration('mindustryHjson').get<string>('schemaFolder');
		if (configured) return configured;
		const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (wsFolder) {
			const local = path.join(wsFolder, '.mindustry-schemas');
			if (fs.existsSync(local)) return local;
		}
		const bundled = path.join(context.extensionPath, 'schemas');
		if (fs.existsSync(bundled)) return bundled;
		return undefined;
	}

	function loadSchemas() {
		const folder = resolveSchemaFolder();
		if (!folder) {
			vscode.window.setStatusBarMessage('Mindustry HJSON: no schema folder configured', 4000);
			return;
		}
		const { loaded, errors } = registry.loadFolder(folder);
		vscode.window.setStatusBarMessage(`Mindustry HJSON: loaded ${loaded} schemas from ${folder}`, 4000);
		for (const e of errors) console.warn('[mindustry-hjson]', e);
		lintAllOpenDocuments();
	}

	function lintDocument(doc: vscode.TextDocument) {
		if (doc.languageId !== LANGUAGE_ID) return;
		const parse = parseMHJson(doc.getText());
		refreshDiagnostics(doc, parse, registry, getContentTypeFolders(), collection);
	}

	function lintAllOpenDocuments() {
		for (const doc of vscode.workspace.textDocuments) lintDocument(doc);
	}

	loadSchemas();

	context.subscriptions.push(
		vscode.commands.registerCommand('mindustryHjson.reloadSchemas', loadSchemas),
		vscode.workspace.onDidOpenTextDocument(lintDocument),
		vscode.workspace.onDidChangeTextDocument((e) => lintDocument(e.document)),
		vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('mindustryHjson')) loadSchemas();
		}),
		vscode.languages.registerCompletionItemProvider(
			{ language: LANGUAGE_ID },
			new MHJsonCompletionProvider(registry, getContentTypeFolders),
			':', ' ', '"',
		),
		vscode.languages.registerHoverProvider({ language: LANGUAGE_ID }, new MHJsonHoverProvider(registry, getContentTypeFolders)),
	);

	lintAllOpenDocuments();
}

export function deactivate() {}
