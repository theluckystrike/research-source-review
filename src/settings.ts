import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import type ResearchSourceReviewPlugin from './main';
import { helloSettingItems } from './hello/settings';

export class ResearchSourceReviewSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], private reviewPlugin: ResearchSourceReviewPlugin) { super(app, reviewPlugin); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...(this.reviewPlugin.pro ? sponsorsSettingItems(this.reviewPlugin.pro, PRO_UI) : []),
			{ name: 'Local review data', desc: 'Pins contain source text and note paths. Scans run when you select Scan saved pins. Reports are new Markdown notes in the vault root.' },
		];
	}
}
