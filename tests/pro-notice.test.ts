import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import ResearchSourceReviewPlugin from '../src/main';
import { ReviewModal } from '../src/modal';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user sees "Save dated report (Pro)" in the review window. A click shows the shared Pro notice with the
// "Sponsor on GitHub" button. No report is written and no data is saved. A Pro user's click writes the report.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';
const LABEL = 'Save dated report (Pro)';

function fakePro(pro: boolean): SponsorsManager {
	return {
		isPro: () => pro,
		onChange: () => () => undefined,
		hasToken: () => false,
		isChecking: () => false,
		getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
		config: { sponsorLogin: 'theluckystrike', source: 'research-source-review' },
	} as unknown as SponsorsManager;
}

async function setup(pro: boolean) {
	const app = App.createConfigured__({ files: { 'Source.md': '30 days ^limit', 'Conclusion.md': '[[Source#^limit]]' } });
	const plugin = new ResearchSourceReviewPlugin(app as never, manifest as never);
	plugin.settings = { pins: [{ id: 'p1', sourcePath: 'Source.md', blockId: 'limit', dependentPath: 'Conclusion.md', approved: '30 days', checkedAt: '2026-10-14T00:00:00.000Z', group: '' }], groups: [] };
	const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
	bindPro(fakePro(pro));
	const shown: { text: string; buttons: number }[] = [];
	vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
		shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
	});
	const create = vi.spyOn(app.vault, 'create');
	const modal = new ReviewModal(plugin);
	await modal.onOpen();
	return { app, plugin, modal, shown, create, saveData };
}

function reportButton(modal: ReviewModal): HTMLButtonElement | undefined {
	return [...modal.contentEl.querySelectorAll('button')].find((b) => b.textContent === LABEL);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Save dated report for a free user and a Pro user', () => {
	afterEach(() => { resetPro(); vi.restoreAllMocks(); });

	it('a free user who selects Save dated report gets the Pro notice with a Sponsor button, and no report is written', async () => {
		const { app, modal, shown, create, saveData } = await setup(false);
		const button = reportButton(modal);
		expect(button, 'The free review window shows Save dated report (Pro).').toBeDefined();
		expect(button!.disabled).toBe(false);
		button!.click(); await flush(); await flush();
		expect(shown).toEqual([{ text: `Local reports need pro. ${PITCH}Sponsor on GitHub`, buttons: 1 }]);
		expect(create).not.toHaveBeenCalled();
		expect(saveData).not.toHaveBeenCalled();
		expect(app.vault.getMarkdownFiles().map((f) => f.path).sort()).toEqual(['Conclusion.md', 'Source.md']);
		// The window draws again with the button enabled and no message.
		expect(reportButton(modal)!.disabled).toBe(false);
		expect(modal.contentEl.querySelector('.rsr-message')).toBeNull();
		// The free group controls stay hidden: no group select and no Add group button.
		expect(modal.contentEl.querySelector('select')).toBeNull();
		expect([...modal.contentEl.querySelectorAll('button')].some((b) => b.textContent === 'Add group (Pro)')).toBe(false);
		modal.onClose();
	});

	it('a Pro user who selects Save dated report writes the report', async () => {
		const { modal, shown, create } = await setup(true);
		reportButton(modal)!.click();
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
		expect(String(create.mock.calls[0]![0])).toContain('Research source review');
		expect(shown.some((n) => n.buttons > 0)).toBe(false);
		modal.onClose();
	});
});
