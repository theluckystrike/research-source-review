import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import type ResearchSourceReviewPlugin from '../../src/main';
import { pluginId } from './load';

// A free user selects "Save dated report (Pro)" in the review window: the shared Pro notice shows with the
// "Sponsor on GitHub" button, no report note is written and no data is saved. A Pro user's click writes the report.
const LEAD = 'Local reports need pro.';
const LABEL = 'Save dated report (Pro)';
type P = ResearchSourceReviewPlugin & { pro: { opts: { http: unknown }; refreshNow(): Promise<unknown>; signOut(): void; isPro(): boolean } };

async function setPro(on: boolean): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, id, on) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins[id]!;
		if (!on) { p.pro.signOut(); return p.pro.isPro(); }
		p.pro.opts.http = () => Promise.resolve({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
		await p.pro.refreshNow();
		return p.pro.isPro();
	}, pluginId, on);
}

async function state(): Promise<{ reports: string[]; data: string; notices: { text: string; buttons: number }[]; enabled: boolean | null }> {
	return browser.executeObsidian(async ({ app }, id, label) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins[id]!;
		const doc = activeWindow.document;
		const button = [...doc.querySelectorAll<HTMLButtonElement>('.research-source-review button')].find((b) => b.textContent === label);
		return {
			reports: app.vault.getMarkdownFiles().map((f) => f.path).filter((path) => path.startsWith('Research source review')),
			data: JSON.stringify(await p.loadData()),
			notices: [...doc.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', buttons: n.querySelectorAll('.pf-pro-notice-sponsor').length })),
			enabled: button ? !button.disabled : null,
		};
	}, pluginId, LABEL);
}

async function openReview(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		activeWindow.document.querySelectorAll('.notice').forEach((n) => n.remove());
		for (const f of app.vault.getMarkdownFiles()) if (f.path.startsWith('Research source review')) void app.fileManager.trashFile(f);
	});
	await browser.executeObsidianCommand(`${pluginId}:scan-pins`);
	await browser.$('.research-source-review .rsr-card').waitForDisplayed();
}

describe('Save dated report for a free user and a Pro user', function () {
	beforeEach(async function () {
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins[id]!;
			p.modal?.close(); p.pro.signOut();
			p.settings = { pins: [{ id: 'p1', sourcePath: 'Source.md', blockId: 'limit', dependentPath: 'Conclusion.md', approved: '30 days', checkedAt: '2026-10-14T00:00:00.000Z', group: '' }], groups: [] };
			await p.saveData(p.settings);
		}, pluginId);
		await obsidianPage.write('Source.md', '30 days ^limit');
		await obsidianPage.write('Conclusion.md', '# Conclusion\n\nUse [[Source#^limit]] for the limit.');
	});
	afterEach(async function () {
		await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins[id]!;
			p.modal?.close(); p.pro.signOut();
		}, pluginId);
	});

	it('a free user who selects Save dated report gets the Pro notice with a Sponsor button, and no report is written', async function () {
		expect(await setPro(false)).toBe(false);
		await openReview();
		const before = await state();
		expect(before.enabled).toBe(true);
		await browser.$(`button=${LABEL}`).click();
		await browser.waitUntil(async () => (await state()).notices.some((n) => n.text.includes(LEAD)), { timeout: 5000, timeoutMsg: 'No Pro notice after Save dated report.' });
		await browser.pause(500);
		const after = await state();
		const notice = after.notices.find((n) => n.text.includes(LEAD))!;
		expect(notice.buttons).toBe(1);
		expect(after.reports).toEqual([]);
		expect(after.data).toBe(before.data);
		expect(after.enabled).toBe(true);
	});

	it('a Pro user who selects Save dated report writes the report', async function () {
		expect(await setPro(true)).toBe(true);
		await openReview();
		await browser.$(`button=${LABEL}`).click();
		await browser.waitUntil(async () => (await state()).reports.length === 1, { timeout: 10000, timeoutMsg: 'The Pro user got no report note.' });
		expect((await state()).notices.some((n) => n.buttons > 0)).toBe(false);
		expect(await browser.$('.rsr-message').getText()).toContain('Saved local report');
	});
});
