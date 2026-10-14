import { Notice, Plugin, type TFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { ResearchSourceReviewSettingTab } from './settings';
import { blockLink, canApprove, compare, normalizeData, paragraph, renamedPath, report, type Comparison, type Pin, type ReviewData } from './review';
import { ReviewModal } from './modal';

export default class ResearchSourceReviewPlugin extends Plugin {
	settings: ReviewData = { pins: [], groups: [] };
	pro: SponsorsManager | null = null;
	modal: ReviewModal | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private revision = 0;
	private serial = 0;

	async onload(): Promise<void> {
		this.settings = normalizeData(await this.loadData() as unknown);
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init(); this.pro = pro; bindPro(pro);
		const tab = new ResearchSourceReviewSettingTab(this.app, this);
		this.addSettingTab(tab);
		this.register(pro.onChange(() => { tab.update(); this.modal?.render(); }));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.revision++;
			void this.handleRename(oldPath, file.path).catch(() => new Notice('Could not save renamed paths.'));
		}));
		this.registerEvent(this.app.vault.on('modify', () => { this.revision++; }));
		this.registerEvent(this.app.vault.on('delete', () => { this.revision++; }));
		this.addCommand({ id: 'pin-source', name: 'Pin a source paragraph from the active note', callback: () => { void this.choosePin().catch(() => new Notice('Could not read the active note.')); } });
		this.addCommand({ id: 'scan-pins', name: 'Scan saved pins', callback: () => { this.openReview(); } });
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}
	onunload(): void { this.modal?.close(); resetPro(); }

	/** One mutation and one saved snapshot at a time. Restore local data if the write fails. */
	private change<T>(action: () => Promise<T> | T, save: (value: T) => boolean = () => true): Promise<T> {
		const result = this.queue.then(async () => {
			const old = normalizeData(this.settings);
			try { const value = await action(); if (save(value)) await this.saveData(this.settings); return value; }
			catch (error) { this.settings = old; throw error; }
		});
		this.queue = result.catch(() => undefined);
		return result;
	}
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		// A vault rename that changes no pin path does not write the saved data.
		await this.change(() => {
			let moved = false;
			for (const pin of this.settings.pins) {
				const sourcePath = renamedPath(pin.sourcePath, oldPath, newPath);
				const dependentPath = renamedPath(pin.dependentPath, oldPath, newPath);
				if (sourcePath !== pin.sourcePath || dependentPath !== pin.dependentPath) moved = true;
				pin.sourcePath = sourcePath; pin.dependentPath = dependentPath;
			}
			return moved;
		}, (moved) => moved);
	}
	async resolve(pin: Pin): Promise<Comparison> {
		const file = this.app.vault.getFileByPath(pin.sourcePath);
		if (!file) return compare(pin, null);
		try {
			const content = await this.app.vault.read(file);
			const passage = paragraph(content, pin.blockId);
			// The public block cache supplies the current block location. Check it against the fresh paragraph.
			// If indexing is behind, the fresh parser resolves the explicit ID, without using stale offsets.
			const cache = this.app.metadataCache.getFileCache(file);
			const block = cache?.blocks?.[pin.blockId];
			if (block && block.position.start.offset === passage.start && block.position.end.offset === passage.end) {
				const section = cache?.sections?.find((s) => s.position.start.offset === passage.start && s.position.end.offset === passage.end);
				if (section && section.type !== 'paragraph') return compare(pin, { ...passage, status: 'unsupported', text: null });
			}
			return compare(pin, passage);
		} catch { return { pin: { ...pin }, status: 'unreadable', current: null }; }
	}
	async scan(group = ''): Promise<Comparison[]> {
		await this.queue;
		const filter = isPro() ? group : '';
		return Promise.all(this.settings.pins.filter((p) => !filter || p.group === filter).map((p) => this.resolve({ ...p })));
	}
	async candidates(file: TFile): Promise<{ sourcePath: string; blockId: string; dependentPath: string }[]> {
		const cache = this.app.metadataCache.getFileCache(file);
		const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
		const seen = new Set<string>();
		const candidates: { sourcePath: string; blockId: string; dependentPath: string }[] = [];
		for (const link of links) {
			const target = blockLink(link.link);
			if (!target) continue;
			const source = target.path ? this.app.metadataCache.getFirstLinkpathDest(target.path, file.path) : file;
			if (!source || source.extension !== 'md') continue;
			const key = source.path + '#^' + target.blockId;
			if (seen.has(key)) continue;
			seen.add(key); candidates.push({ sourcePath: source.path, blockId: target.blockId, dependentPath: file.path });
		}
		return candidates;
	}
	async choosePin(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') { new Notice('Open a Markdown note with a paragraph block link.'); return; }
		const candidates = await this.candidates(file);
		this.modal?.close();
		this.modal = new ReviewModal(this, candidates);
		this.modal.open();
	}
	openReview(): void {
		this.modal?.close(); this.modal = new ReviewModal(this); this.modal.open();
	}
	async pinSource(candidate: Pick<Pin, 'sourcePath' | 'blockId' | 'dependentPath'>, shown: Comparison): Promise<boolean> {
		return this.change(async () => {
			if (this.settings.pins.some((p) => p.sourcePath === candidate.sourcePath && p.blockId === candidate.blockId && p.dependentPath === candidate.dependentPath)) return false;
			const rev = this.revision;
			const fresh = await this.resolve(shown.pin);
			if (rev !== this.revision || !canApprove(shown, fresh)) return false;
			this.settings.pins.push({ ...candidate, id: `${Date.now()}-${++this.serial}`, approved: fresh.current!, checkedAt: new Date().toISOString(), group: '' });
			return true;
		});
	}
	async approve(shown: Comparison): Promise<boolean> {
		return this.change(async () => {
			const pin = this.settings.pins.find((p) => p.id === shown.pin.id);
			if (!pin) return false;
			const rev = this.revision;
			const fresh = await this.resolve(pin);
			if (rev !== this.revision || !canApprove(shown, fresh)) return false;
			pin.approved = fresh.current!; pin.checkedAt = new Date().toISOString();
			return true;
		});
	}
	async removePin(id: string): Promise<void> { await this.change(() => { this.settings.pins = this.settings.pins.filter((p) => p.id !== id); }); }
	async addGroup(name: string): Promise<boolean> {
		if (!isPro() || !name.trim() || name.trim().length > 80) return false;
		return this.change(() => {
			if (!isPro()) return false;
			const group = name.trim(); if (!this.settings.groups.includes(group)) this.settings.groups.push(group); return true;
		});
	}
	async setGroup(id: string, group: string): Promise<boolean> {
		if (!isPro()) return false;
		return this.change(() => {
			if (!isPro() || (group !== '' && !this.settings.groups.includes(group))) return false;
			const pin = this.settings.pins.find((p) => p.id === id); if (!pin) return false; pin.group = group; return true;
		});
	}
	async saveReport(group = ''): Promise<TFile | null> {
		if (!isPro()) { new Notice('Local reports need pro. Sign in from the plugin settings.'); return null; }
		const results = await this.scan(group);
		if (!isPro()) return null;
		const date = new Date().toISOString();
		const base = `Research source review ${date.replace(/[:.]/g, '-')}`;
		let path = base + '.md'; let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${suffix++}.md`;
		const file = await this.app.vault.create(path, report(results, date, group));
		new Notice(`Saved ${file.path}`); return file;
	}
}
