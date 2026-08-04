import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMHJson } from './parser/mhjsonParser';
import { SchemaRegistry } from './schema/schemaLoader';
import { ContentIndex } from './schema/contentIndex';
import { VanillaContentIndex } from './schema/vanillaContent';
import { refreshDiagnostics, makeDiagnosticCollection } from './features/diagnostics';
import { MHJsonCompletionProvider } from './features/completion';
import { MHJsonHoverProvider } from './features/hover';
import { MHJsonDefinitionProvider } from './features/definition';
import { MHJsonColorProvider } from './features/colorProvider';

const LANGUAGE_ID = 'mhjson';

export function activate(context: vscode.ExtensionContext) {
	const registry = new SchemaRegistry();
	const contentIndex = new ContentIndex();
	const vanillaContent = new VanillaContentIndex();
	const collection = makeDiagnosticCollection();
	context.subscriptions.push(collection);

	function getContentTypeFolders(): Record<string, string> {
		return vscode.workspace.getConfiguration('mindustryHjson').get('contentTypeFolders') ?? {};
	}

	let contentIndexRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleContentIndexRefresh() {
		if (contentIndexRefreshTimer) clearTimeout(contentIndexRefreshTimer);
		contentIndexRefreshTimer = setTimeout(() => {
			contentIndex.refresh(getContentTypeFolders());
		}, 300);
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
		vanillaContent.load(folder);
		vscode.window.setStatusBarMessage(`Mindustry HJSON: loaded ${loaded} schemas from ${folder}`, 4000);
		for (const e of errors) console.warn('[mindustry-hjson]', e);
		lintAllOpenDocuments();
	}

	function lintDocument(doc: vscode.TextDocument) {
		if (doc.languageId !== LANGUAGE_ID) return;
		const parse = parseMHJson(doc.getText());
		refreshDiagnostics(doc, parse, registry, getContentTypeFolders(), collection, contentIndex, vanillaContent);
	}

	function lintAllOpenDocuments() {
		for (const doc of vscode.workspace.textDocuments) lintDocument(doc);
	}

	loadSchemas();
	scheduleContentIndexRefresh();

	const contentWatcher = vscode.workspace.createFileSystemWatcher('**/*.hjson');
	contentWatcher.onDidCreate(scheduleContentIndexRefresh);
	contentWatcher.onDidDelete(scheduleContentIndexRefresh);

	context.subscriptions.push(
		vscode.commands.registerCommand('mindustryHjson.reloadSchemas', loadSchemas),
		vscode.workspace.onDidOpenTextDocument(lintDocument),
		vscode.workspace.onDidChangeTextDocument((e) => lintDocument(e.document)),
		vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('mindustryHjson')) {
				loadSchemas();
				scheduleContentIndexRefresh();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(scheduleContentIndexRefresh),
		contentWatcher,
		vscode.languages.registerCompletionItemProvider(
			{ language: LANGUAGE_ID },
			new MHJsonCompletionProvider(registry, getContentTypeFolders, contentIndex, vanillaContent),
			':', ' ', '"',
		),
		vscode.languages.registerHoverProvider({ language: LANGUAGE_ID }, new MHJsonHoverProvider(registry, getContentTypeFolders, contentIndex, vanillaContent)),
		vscode.languages.registerDefinitionProvider({ language: LANGUAGE_ID }, new MHJsonDefinitionProvider(registry, getContentTypeFolders, contentIndex)),
		vscode.languages.registerColorProvider({ language: LANGUAGE_ID }, new MHJsonColorProvider(registry, getContentTypeFolders)),
	);

	lintAllOpenDocuments();
}

export function deactivate() {}
