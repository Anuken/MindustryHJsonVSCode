import * as vscode from 'vscode';
import { parseMHJson } from '../parser/mhjsonParser';
import { SchemaRegistry } from '../schema/schemaLoader';
import { ContentIndex } from '../schema/contentIndex';
import { VanillaContentIndex } from '../schema/vanillaContent';
import { SoundIndex } from '../schema/soundIndex';
import { locate } from './locate';

/** Jump-to-definition for bare-string content references (Item/Block/Liquid/Planet/SectorPreset/StatusEffect/UnitType/Weather) and for Sound references that resolve to one of the mod's own sounds/ files. */
export class MHJsonDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private registry: SchemaRegistry,
		private getContentTypeFolders: () => Record<string, string>,
		private contentIndex: ContentIndex,
		private vanillaContent: VanillaContentIndex,
		private soundIndex: SoundIndex,
	) {}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const parse = parseMHJson(text);
		const loc = locate(parse, offset, this.registry, document.uri.fsPath, this.getContentTypeFolders(), this.vanillaContent);

		if (loc.soundRef) {
			const uris = this.soundIndex.lookup(loc.soundRef.name);
			return uris.length > 0 ? uris.map((uri) => new vscode.Location(uri, new vscode.Position(0, 0))) : undefined;
		}

		if (!loc.contentRef) return undefined;

		const uris = this.contentIndex.lookup(loc.contentRef.type, loc.contentRef.name);
		if (uris.length === 0) return undefined;

		return uris.map((uri) => new vscode.Location(uri, new vscode.Position(0, 0)));
	}
}
