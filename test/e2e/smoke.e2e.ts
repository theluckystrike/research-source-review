import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import type ResearchSourceReviewPlugin from '../../src/main';
import { pluginId, reloadPlugin } from './load';

async function pluginState() {
	return browser.executeObsidian(({ app }, id) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, ResearchSourceReviewPlugin> } }).plugins.plugins[id]; return p.settings;
	}, pluginId);
}
async function pinThroughUi() {
	await browser.executeObsidianCommand(`${pluginId}:pin-source`);
	await browser.$('.research-source-review .rsr-current').waitForDisplayed();
	expect(await browser.$('.rsr-current').getText()).toBe('30 days');
	await browser.$('button=Save pin').click();
	await browser.waitUntil(async () => (await pluginState()).pins.length === 1, { timeout: 10000 });
	await browser.$('.rsr-approved').waitForDisplayed();
}
async function scanThroughUi() { await browser.executeObsidianCommand(`${pluginId}:scan-pins`); await browser.$('.rsr-card').waitForDisplayed(); }
async function statusIs(status: string) { await browser.waitUntil(async () => await browser.$(`.rsr-card[data-status="${status}"]`).isExisting(), { timeout: 10000 }); }

describe(`${pluginId} real app workflow`, function () {
	beforeEach(async function () {
		await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, ResearchSourceReviewPlugin> } }).plugins.plugins[id];
			p.modal?.close(); p.pro?.signOut(); p.settings = { pins: [], groups: [] }; await p.saveData(p.settings);
		}, pluginId);
		await obsidianPage.write('Source.md', '30 days ^limit');
		await obsidianPage.write('Conclusion.md', '# Conclusion\n\nUse [[Source#^limit]] for the limit.');
		await obsidianPage.openFile('Conclusion.md');
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
			const source = app.vault.getFileByPath('Source.md'); const note = app.vault.getFileByPath('Conclusion.md');
			return !!source && !!note && !!app.metadataCache.getFileCache(source)?.blocks?.limit && !!app.metadataCache.getFileCache(note)?.links?.some((l) => l.link === 'Source#^limit');
		}), { timeout: 15000 });
	});
	it('loads and reloads without console errors', async function () { expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] }); });
	it('pins exact paragraph text and keeps an unchanged scan', async function () {
		await pinThroughUi(); await scanThroughUi(); await statusIs('unchanged');
		const pin = (await pluginState()).pins[0]; expect(pin.approved).toBe('30 days'); expect(pin.sourcePath).toBe('Source.md'); expect(pin.blockId).toBe('limit'); expect(pin.dependentPath).toBe('Conclusion.md');
	});
	it('shows changed approved and current versions without approval', async function () {
		await pinThroughUi(); await obsidianPage.write('Source.md', '14 days ^limit'); await scanThroughUi(); await statusIs('changed');
		expect(await browser.$('.rsr-approved').getText()).toBe('30 days'); expect(await browser.$('.rsr-current').getText()).toBe('14 days'); expect((await pluginState()).pins[0].approved).toBe('30 days');
	});
	it('keeps unrelated edits and paragraph movement unchanged', async function () {
		await pinThroughUi(); await obsidianPage.write('Source.md', 'An unrelated paragraph changed.\n\n30 days ^limit\n\nAnother paragraph.'); await scanThroughUi(); await statusIs('unchanged');
	});
	it('keeps the baseline when the block ID is removed', async function () {
		await pinThroughUi(); await obsidianPage.write('Source.md', '30 days'); await scanThroughUi(); await statusIs('missing-block'); expect((await pluginState()).pins[0].approved).toBe('30 days'); expect(await browser.$('button=Mark checked').isExisting()).toBe(false);
	});
	it('updates the source path after a rename', async function () {
		await pinThroughUi();
		await browser.executeObsidian(async ({ app }) => {
			const source = app.vault.getFileByPath('Source.md')!; const prior = app.vault.getFileByPath('New.md'); if (prior) await app.fileManager.trashFile(prior); await app.vault.rename(source, 'New.md');
		});
		await browser.waitUntil(async () => (await pluginState()).pins[0].sourcePath === 'New.md', { timeout: 10000 });
		await scanThroughUi(); await statusIs('unchanged'); expect((await pluginState()).pins[0].approved).toBe('30 days');
	});
	it('persists an approved baseline through an app restart', async function () {
		await pinThroughUi(); await obsidianPage.write('Source.md', '14 days ^limit'); await scanThroughUi(); await statusIs('changed'); await browser.$('button=Mark checked').click();
		await browser.waitUntil(async () => (await pluginState()).pins[0].approved === '14 days', { timeout: 10000 });
		await browser.waitUntil(async () => browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, ResearchSourceReviewPlugin> } }).plugins.plugins[id]; const saved = await p.loadData() as { pins: { approved: string }[] }; return saved.pins[0]?.approved === '14 days';
		}, pluginId), { timeout: 10000 });
		await browser.reloadObsidian({ copy: false }); await scanThroughUi(); await statusIs('unchanged'); expect((await pluginState()).pins[0].approved).toBe('14 days');
	});
	it('stops an approval when the source changed after display', async function () {
		await pinThroughUi(); await obsidianPage.write('Source.md', '14 days ^limit'); await scanThroughUi(); await statusIs('changed'); expect(await browser.$('.rsr-current').getText()).toBe('14 days');
		await obsidianPage.write('Source.md', '7 days ^limit'); await browser.$('button=Mark checked').click();
		await browser.waitUntil(async () => (await browser.$('.rsr-current').getText()) === '7 days', { timeout: 10000 }); expect((await pluginState()).pins[0].approved).toBe('30 days'); expect(await browser.$('.rsr-message').getText()).toContain('Review the refreshed text');
	});
	it('requires Pro for groups and reports while free review remains available', async function () {
		await pinThroughUi(); const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, ResearchSourceReviewPlugin> } }).plugins.plugins[id]; return { group: await p.addGroup('Research'), report: await p.saveReport(), count: (await p.scan('Research')).length };
		}, pluginId); expect(result).toEqual({ group: false, report: null, count: 1 });
	});
	it('keeps groups and reports local with a test sponsorship', async function () {
		await pinThroughUi(); const result = await browser.executeObsidian(async ({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, ResearchSourceReviewPlugin> } }).plugins.plugins[id]; const pro = p.pro!;
			pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'test-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } }); app.secretStorage.setSecret(id + '-github-token', 'gho_' + '0'.repeat(36));
			try {
				await pro.refreshNow(); const group = await p.addGroup('Project'); const assigned = await p.setGroup(p.settings.pins[0].id, 'Project'); const file = await p.saveReport('Project'); const text = file ? await app.vault.read(file) : ''; return { group, assigned, name: file?.path, text };
			} finally { pro.signOut(); }
		}, pluginId);
		expect(result.group).toBe(true); expect(result.assigned).toBe(true); expect(result.name).toContain('Research source review'); expect(result.text).toContain('30 days'); expect(result.text).toContain('Project'); expect(result.text).toContain('Conclusion.md');
	});
});
