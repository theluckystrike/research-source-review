import { Modal, Notice } from 'obsidian';
import type ResearchSourceReviewPlugin from './main';
import { isPro, proText } from './pro';
import { type Comparison, type Pin } from './review';

type Candidate = Pick<Pin, 'sourcePath' | 'blockId' | 'dependentPath'>;
const LABELS = { unchanged: 'Unchanged', changed: 'Changed text', 'missing-block': 'Missing block', 'missing-source': 'Missing source', unsupported: 'Unsupported block', unreadable: 'Could not read source' };

export class ReviewModal extends Modal {
	private results: Comparison[] = [];
	private group = '';
	private message = '';
	private busy = false;
	private generation = 0;
	private closed = false;
	constructor(private plugin: ResearchSourceReviewPlugin, private choices: Candidate[] | null = null) { super(plugin.app); }
	async onOpen(): Promise<void> { this.modalEl.addClass('research-source-review'); this.setTitle(this.choices ? 'Pin a source paragraph' : 'Review source passages'); await this.refresh(); }
	onClose(): void { this.closed = true; this.generation++; this.contentEl.empty(); if (this.plugin.modal === this) this.plugin.modal = null; }
	private button(parent: HTMLElement, label: string, action: () => Promise<void>): void {
		const button = parent.createEl('button', { text: label });
		button.disabled = this.busy;
		button.addEventListener('click', () => {
			if (this.busy) return;
			this.busy = true; this.render();
			void action().catch(() => { this.message = 'Could not save or read review data. Try again.'; }).finally(() => { this.busy = false; this.render(); });
		});
	}
	async refresh(): Promise<void> {
		const generation = ++this.generation;
		if (!isPro()) this.group = '';
		const results = this.choices
			? await Promise.all(this.choices.map((c) => this.plugin.resolve({ ...c, id: '', approved: '', checkedAt: '', group: '' })))
			: await this.plugin.scan(this.group);
		if (this.closed || generation !== this.generation) return;
		this.results = results; this.render();
	}
	render(): void {
		if (this.closed) return;
		const el = this.contentEl; el.empty();
		if (!isPro() && this.group) { this.group = ''; void this.refresh(); return; }
		el.createEl('p', { text: this.choices ? 'Choose a linked paragraph. Read the exact source text, then save the pin.' : 'Manual scan. Read approved and current text before you mark a pin checked.' });
		if (this.message) el.createEl('p', { cls: 'rsr-message', text: this.message, attr: { role: 'status' } });
		if (!this.choices) {
			const toolbar = el.createDiv({ cls: 'rsr-toolbar' });
			this.button(toolbar, 'Scan again', async () => { this.message = ''; await this.refresh(); });
			if (isPro()) {
				const label = toolbar.createEl('label', { text: 'Review group (pro) ' });
				const select = label.createEl('select', { attr: { 'aria-label': 'Review group' } });
				select.createEl('option', { value: '', text: 'No group filter' });
				for (const group of this.plugin.settings.groups) select.createEl('option', { value: group, text: group });
				select.value = this.group; select.disabled = this.busy;
				select.addEventListener('change', () => { this.group = select.value; void this.refresh(); });
				this.button(toolbar, 'Save dated report (Pro)', async () => { const file = await this.plugin.saveReport(this.group); if (file) this.message = `Saved local report: ${file.path}`; });
				const groups = el.createDiv({ cls: 'rsr-toolbar' });
				const name = groups.createEl('input', { attr: { placeholder: 'Research project name', 'aria-label': 'New review group', maxlength: '80' } });
				this.button(groups, 'Add group (Pro)', async () => { this.message = await this.plugin.addGroup(name.value) ? 'Review group saved.' : 'Enter a group name of 1 to 80 characters.'; });
			} else {
				// A free user can select the report button: saveReport shows the Pro notice and writes nothing.
				this.button(toolbar, 'Save dated report (Pro)', async () => { await this.plugin.saveReport(this.group); });
				el.createEl('p', { cls: 'rsr-muted', text: proText('Named review groups and dated local reports need pro. Free pins remain available.') });
			}
		}
		if (!this.results.length) el.createEl('p', { text: this.choices ? 'No native paragraph block link was found. Add a link such as [[Source#^limit]] to the active note.' : 'No saved pins in this view. Open a note with a block link and run Pin a source paragraph from the active note.' });
		for (const result of this.results) this.card(el, result);
	}
	private card(parent: HTMLElement, result: Comparison): void {
		const card = parent.createDiv({ cls: 'rsr-card', attr: { 'data-pin-id': result.pin.id, 'data-status': result.status } });
		card.createEl('h3', { text: `${result.pin.sourcePath}#^${result.pin.blockId}` });
		card.createEl('p', { cls: 'rsr-status', text: this.choices && result.current !== null ? 'Ready to pin' : LABELS[result.status] });
		card.createEl('p', { cls: 'rsr-muted', text: `Dependent note: ${result.pin.dependentPath}` });
		const versions = card.createDiv({ cls: 'rsr-versions' });
		if (!this.choices) {
			const approved = versions.createDiv(); approved.createEl('h4', { text: 'Approved text' }); approved.createEl('pre', { cls: 'rsr-approved', text: result.pin.approved });
		}
		const current = versions.createDiv(); current.createEl('h4', { text: 'Current text' }); current.createEl('pre', { cls: 'rsr-current', text: result.current ?? 'No supported passage found. The approved text is kept.' });
		if (!this.choices) card.createEl('p', { cls: 'rsr-muted', text: `Last checked: ${result.pin.checkedAt}` });
		const actions = card.createDiv({ cls: 'rsr-toolbar' });
		this.button(actions, 'Open source', async () => { await this.app.workspace.openLinkText(`${result.pin.sourcePath}#^${result.pin.blockId}`, result.pin.dependentPath, true); });
		if (result.current !== null) this.button(actions, this.choices ? 'Save pin' : 'Mark checked', async () => {
			const ok = this.choices
				? await this.plugin.pinSource(result.pin, { ...result, pin: { ...result.pin, approved: '' } })
				: await this.plugin.approve(result);
			this.message = ok ? (this.choices ? 'Pin saved. The source text is now approved.' : 'Pin checked. The current text is now approved.') : 'The source or baseline changed, or this pin already exists. Review the refreshed text before approval.';
			if (ok && this.choices) { this.choices = null; this.setTitle('Review source passages'); }
			await this.refresh();
		});
		if (!this.choices) {
			this.button(actions, 'Remove pin', async () => { await this.plugin.removePin(result.pin.id); this.message = 'Pin removed. Source and dependent notes are kept.'; await this.refresh(); });
			if (isPro()) {
				const label = card.createEl('label', { text: 'Group (pro) ' });
				const select = label.createEl('select', { attr: { 'aria-label': `Group for ${result.pin.sourcePath}` } });
				select.createEl('option', { value: '', text: 'No group' });
				for (const group of this.plugin.settings.groups) select.createEl('option', { value: group, text: group });
				select.value = result.pin.group; select.disabled = this.busy;
				select.addEventListener('change', () => { void this.plugin.setGroup(result.pin.id, select.value).then(() => this.refresh()).catch(() => new Notice('Could not save the review group.')); });
			}
		}
	}
}
