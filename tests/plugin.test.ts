import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import ResearchSourceReviewPlugin from '../src/main';
import { bindPro, resetPro } from '../src/pro';
import { blockLink, normalizeData, paragraph, report, type Pin } from '../src/review';
import manifest from '../manifest.json';

const initial: Pin = { id: 'p1', sourcePath: 'Source.md', blockId: 'limit', dependentPath: 'Conclusion.md', approved: '30 days', checkedAt: '2026-10-14T00:00:00.000Z', group: '' };
function fixture(content = '30 days ^limit') {
	const app = App.createConfigured__({ files: { 'Source.md': content, 'Conclusion.md': '[[Source#^limit]]' } });
	const plugin = new ResearchSourceReviewPlugin(app as never, manifest as never);
	plugin.settings = { pins: [{ ...initial }], groups: [] };
	vi.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
	return { app, plugin };
}
function pro(on = true) { bindPro({ isPro: () => on, onChange: () => () => undefined } as unknown as SponsorsManager); }
afterEach(() => { resetPro(); vi.restoreAllMocks(); });

describe('free review workflow', () => {
	it('loads local saved baselines', async () => {
		const { plugin } = fixture(); vi.spyOn(plugin, 'loadData').mockResolvedValue(plugin.settings);
		expect(normalizeData(await plugin.loadData())).toEqual(plugin.settings);
	});
	it('scan reads the fresh paragraph and preserves its baseline', async () => {
		const { plugin } = fixture('14 days ^limit');
		const [result] = await plugin.scan(); expect(result?.status).toBe('changed'); expect(result?.current).toBe('14 days'); expect(plugin.settings.pins[0]?.approved).toBe('30 days');
	});
	it('approves a seen value and persists it', async () => {
		const { plugin } = fixture('14 days ^limit'); const [result] = await plugin.scan();
		expect(await plugin.approve(result!)).toBe(true); expect(plugin.settings.pins[0]?.approved).toBe('14 days'); expect(plugin.saveData).toHaveBeenCalled();
	});
	it('stops approval when the source changes after comparison', async () => {
		const { app, plugin } = fixture('14 days ^limit'); const [result] = await plugin.scan();
		await app.vault.modify(app.vault.getFileByPath('Source.md')!, '7 days ^limit');
		expect(await plugin.approve(result!)).toBe(false); expect(plugin.settings.pins[0]?.approved).toBe('30 days');
	});
	it('stops approval when another review changed the baseline', async () => {
		const { plugin } = fixture('14 days ^limit'); const [result] = await plugin.scan();
		plugin.settings.pins[0]!.approved = 'A different baseline'; expect(await plugin.approve(result!)).toBe(false);
	});
	it('restores the baseline after a failed save', async () => {
		const { plugin } = fixture('14 days ^limit'); const [result] = await plugin.scan(); vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error('disk full'));
		await expect(plugin.approve(result!)).rejects.toThrow('disk full'); expect(plugin.settings.pins[0]?.approved).toBe('30 days');
		expect(await plugin.approve(result!)).toBe(true);
	});
	it('keeps approved text after an ID is removed', async () => { const { plugin } = fixture('30 days'); const [result] = await plugin.scan(); expect(result?.status).toBe('missing-block'); expect(await plugin.approve(result!)).toBe(false); });
	it('reports an unreadable source without removing its baseline', async () => { const { app, plugin } = fixture(); vi.spyOn(app.vault, 'read').mockRejectedValue(new Error('read failed')); expect((await plugin.scan())[0]?.status).toBe('unreadable'); expect(plugin.settings.pins[0]?.approved).toBe('30 days'); });
	it('renames paths at a folder boundary and keeps exact text', async () => {
		const { plugin } = fixture(); plugin.settings.pins.push({ ...initial, id: 'p2', sourcePath: 'Source.md/Child.md', dependentPath: 'Source.mdX/Other.md' });
		await plugin.handleRename('Source.md', 'New.md'); expect(plugin.settings.pins[0]?.sourcePath).toBe('New.md'); expect(plugin.settings.pins[0]?.approved).toBe('30 days'); expect(plugin.settings.pins[1]?.dependentPath).toBe('Source.mdX/Other.md');
	});
	it('renames the dependent note too', async () => { const { plugin } = fixture(); await plugin.handleRename('Conclusion.md', 'Claim.md'); expect(plugin.settings.pins[0]?.dependentPath).toBe('Claim.md'); });
	it('does not add a duplicate pin', async () => { const { plugin } = fixture(); const [shown] = await plugin.scan(); expect(await plugin.pinSource(initial, shown!)).toBe(false); expect(plugin.settings.pins).toHaveLength(1); });
	it('saves the exact text for a new dependent note', async () => {
		const { plugin } = fixture(); const candidate = { ...initial, id: '', dependentPath: 'Other.md', approved: '' }; const shown = await plugin.resolve(candidate);
		expect(await plugin.pinSource(candidate, shown)).toBe(true); expect(plugin.settings.pins[1]?.approved).toBe('30 days'); expect(plugin.settings.pins[1]?.dependentPath).toBe('Other.md');
	});
	it('deduplicates native links and ignores headings', async () => {
		const { app, plugin } = fixture(); const file = app.vault.getFileByPath('Conclusion.md')!;
		vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({ links: [{ link: 'Source#^limit' }, { link: 'Source#^limit' }, { link: 'Source#Heading' }] } as never);
		vi.spyOn(app.metadataCache, 'getFirstLinkpathDest').mockReturnValue(app.vault.getFileByPath('Source.md'));
		expect(await plugin.candidates(file)).toEqual([{ sourcePath: 'Source.md', blockId: 'limit', dependentPath: 'Conclusion.md' }]);
	});
	it('removes only saved pin data', async () => { const { app, plugin } = fixture(); await plugin.removePin('p1'); expect(plugin.settings.pins).toHaveLength(0); expect(app.vault.getFileByPath('Source.md')).not.toBeNull(); });
});

describe('Pro guards and local reports', () => {
	it('rejects groups and reports without Pro', async () => { const { plugin } = fixture(); expect(await plugin.addGroup('Project')).toBe(false); expect(await plugin.setGroup('p1', 'Project')).toBe(false); expect(await plugin.saveReport()).toBeNull(); expect(plugin.settings.groups).toEqual([]); });
	it('keeps free scans available after Pro ends', async () => { const { plugin } = fixture(); plugin.settings.pins[0]!.group = 'Project'; expect(await plugin.scan('Other')).toHaveLength(1); });
	it('saves a named group and filters its pins', async () => { pro(); const { plugin } = fixture(); expect(await plugin.addGroup('  Project  ')).toBe(true); expect(await plugin.setGroup('p1', 'Project')).toBe(true); expect(await plugin.scan('Project')).toHaveLength(1); expect(await plugin.scan('Other')).toHaveLength(0); expect(await plugin.setGroup('p1', 'Unknown')).toBe(false); });
	it('saves a dated local report with both texts', async () => { pro(); const { app, plugin } = fixture('14 days ^limit'); const file = await plugin.saveReport(); expect(file?.path).toMatch(/^Research source review .*\.md$/); const content = await app.vault.read(file!); expect(content).toContain('30 days'); expect(content).toContain('14 days'); expect(content).toContain('Conclusion.md'); expect(content).toContain('changed'); });
	it('uses a new path for a same-time second report', async () => { pro(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T00:00:00Z')); try { const { plugin } = fixture(); const a = await plugin.saveReport(); const b = await plugin.saveReport(); expect(a?.path).not.toBe(b?.path); } finally { vi.useRealTimers(); } });
	it('keeps Markdown source text inside code fences', () => { const content = report([{ pin: { ...initial, approved: '```\n# injected' }, status: 'changed', current: '<script>text</script>' }], 'date', 'Project'); expect(content).toContain('````\n```\n# injected\n````'); });
});

describe('data and paragraph boundaries', () => {
	it('repairs malformed local data and retains valid baselines', () => { expect(normalizeData({ pins: [null, {}, initial, initial], groups: ['', 3, ' Project ', 'Project'] })).toEqual({ pins: [initial], groups: ['Project'] }); expect(normalizeData(null)).toEqual({ pins: [], groups: [] }); });
	it('requires the explicit native block suffix', () => { expect(blockLink('Source#^limit')).toEqual({ path: 'Source', blockId: 'limit' }); expect(blockLink('Source#Heading')).toBeNull(); expect(blockLink('Source#^bad id')).toBeNull(); });
	it('does not accept a marker in a separate paragraph', () => { expect(paragraph('30 days\n\n^limit', 'limit').text).toBeNull(); });
	it('preserves Unicode, Markdown and internal whitespace', () => { expect(paragraph('Café **30**  days ^limit', 'limit').text).toBe('Café **30**  days'); });
	it('excludes setext headings and tables', () => { expect(paragraph('Heading\n=== ^limit', 'limit').status).toBe('unsupported'); expect(paragraph('| a | b | ^limit', 'limit').status).toBe('unsupported'); });
});

describe('review defects', () => {
	it('keeps a fence open past a line with an info string', () => { expect(paragraph('```\ncode\n```js\n30 days ^limit\n```', 'limit').status).toBe('missing-block'); });
	it('excludes thematic breaks and math blocks from paragraph text', () => { expect(paragraph('***\n30 days ^limit', 'limit').status).toBe('unsupported'); expect(paragraph('___\n30 days ^limit', 'limit').status).toBe('unsupported'); expect(paragraph('$$\nx\n$$ ^limit', 'limit').status).toBe('unsupported'); });
	it('reads a paragraph after an unclosed frontmatter marker', () => { expect(paragraph('---\n\n30 days ^limit', 'limit').text).toBe('30 days'); });
	it('does not write saved data for a rename that changes no pin', async () => { const { plugin } = fixture(); await plugin.handleRename('Other.md', 'Moved.md'); expect(plugin.saveData).not.toHaveBeenCalled(); });
	it('rejects a group name longer than 80 characters', async () => { pro(); const { plugin } = fixture(); expect(await plugin.addGroup('x'.repeat(81))).toBe(false); expect(await plugin.addGroup('x'.repeat(80))).toBe(true); });
});
