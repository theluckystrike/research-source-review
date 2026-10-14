export interface Pin {
	id: string;
	sourcePath: string;
	blockId: string;
	dependentPath: string;
	approved: string;
	checkedAt: string;
	group: string;
}
export interface ReviewData { pins: Pin[]; groups: string[] }
export type Status = 'unchanged' | 'changed' | 'missing-block' | 'missing-source' | 'unsupported' | 'unreadable';
export interface Passage { status: 'found' | 'missing-block' | 'unsupported'; text: string | null; start: number; end: number }
export interface Comparison { pin: Pin; status: Status; current: string | null }
export const EMPTY_DATA: ReviewData = { pins: [], groups: [] };

/** Accept only a native link to an explicit block ID. The cache has already removed the alias. */
export function blockLink(link: string): { path: string; blockId: string } | null {
	const match = /^(.*?)#\^([A-Za-z0-9-]+)$/.exec(link);
	return match ? { path: match[1]!, blockId: match[2]! } : null;
}

/** Read a small, explicit paragraph from fresh source text. No cached offsets are trusted on their own. */
export function paragraph(content: string, id: string): Passage {
	if (!/^[A-Za-z0-9-]+$/.test(id)) return { status: 'unsupported', text: null, start: 0, end: 0 };
	const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let offset = 0;
	let start = 0;
	let buffer = '';
	let fence = '';
	let fenceLength = 0;
	let frontmatter = false;
	const found: Passage[] = [];
	const flush = () => {
		const raw = buffer.replace(/\r?\n$/, '');
		const marker = new RegExp(`(?:[ \\t]|\\r?\\n)\\^${id}[ \\t]*$`);
		if (marker.test(raw)) {
			const text = raw.replace(marker, '');
			const unsupported = text.trim() === '' || text.split(/\r?\n/).some((line) => /^(?: {4}|\t| {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|<|\$\$|\[\^[^\]]+\]:))/.test(line) || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line) || /^ {0,3}[-=]{2,}[ \t]*$/.test(line) || (line.includes('|') && line.includes('-') && /^[ \t:|-]+$/.test(line))) || /(?:^|\n) {0,3}(?:[-=]{2,}|\|.*\||[-:*| ]*\|[-:*| ]*)\s*$/.test(text);
			found.push({ status: unsupported ? 'unsupported' : 'found', text: unsupported ? null : text, start, end: start + raw.length });
		}
		buffer = '';
	};
	lines.forEach((line, index) => {
		const plain = line.replace(/\r?\n$/, '');
		if (index === 0 && plain === '---' && lines.slice(1).some((l) => /^(?:---|\.\.\.)\r?\n?$/.test(l))) { frontmatter = true; offset += line.length; return; }
		if (frontmatter) { if (plain === '---' || plain === '...') frontmatter = false; offset += line.length; return; }
		const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(plain);
		if (fence) { if (boundary && boundary[1]![0] === fence && boundary[1]!.length >= fenceLength && /^ {0,3}(?:`+|~+)[ \t]*$/.test(plain)) fence = ''; offset += line.length; return; }
		if (boundary) { flush(); fence = boundary[1]![0]!; fenceLength = boundary[1]!.length; offset += line.length; return; }
		if (plain.trim() === '') flush();
		else { if (!buffer) start = offset; buffer += line; }
		offset += line.length;
	});
	flush();
	if (found.length > 1) return { status: 'unsupported', text: null, start: 0, end: 0 };
	return found[0] ?? { status: 'missing-block', text: null, start: 0, end: 0 };
}

export function compare(pin: Pin, passage: Passage | null): Comparison {
	return {
		pin: { ...pin },
		status: passage === null ? 'missing-source' : passage.status === 'found' ? (passage.text === pin.approved ? 'unchanged' : 'changed') : passage.status,
		current: passage?.text ?? null,
	};
}
export function canApprove(shown: Comparison, fresh: Comparison): boolean {
	return fresh.current !== null && (fresh.status === 'changed' || fresh.status === 'unchanged') && shown.current === fresh.current && shown.pin.approved === fresh.pin.approved && shown.pin.sourcePath === fresh.pin.sourcePath && shown.pin.blockId === fresh.pin.blockId;
}
export function renamedPath(path: string, oldPath: string, newPath: string): string {
	return path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
}
export function normalizeData(value: unknown): ReviewData {
	if (!value || typeof value !== 'object') return { pins: [], groups: [] };
	const data = value as Partial<ReviewData>;
	const pins: Pin[] = [];
	if (Array.isArray(data.pins)) for (const pin of data.pins) {
		if (!pin || typeof pin !== 'object' || !['id', 'sourcePath', 'blockId', 'dependentPath', 'approved', 'checkedAt'].every((key) => typeof (pin as unknown as Record<string, unknown>)[key] === 'string')) continue;
		if (!pin.id || !pin.sourcePath || !pin.dependentPath || !/^[A-Za-z0-9-]+$/.test(pin.blockId) || pins.some((p) => p.id === pin.id || (p.sourcePath === pin.sourcePath && p.blockId === pin.blockId && p.dependentPath === pin.dependentPath))) continue;
		pins.push({ id: pin.id, sourcePath: pin.sourcePath, blockId: pin.blockId, dependentPath: pin.dependentPath, approved: pin.approved, checkedAt: pin.checkedAt, group: typeof pin.group === 'string' ? pin.group : '' });
	}
	const groups = Array.isArray(data.groups) ? [...new Set(data.groups.filter((g) => typeof g === 'string' && g.trim() !== '').map((g) => g.trim()))] : [];
	return { pins, groups };
}
function literal(text: string): string {
	const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
	return `${fence}\n${text}\n${fence}`;
}
export function report(results: Comparison[], date: string, group: string): string {
	return `# Research source review\n\nDate: ${date}\n\nGroup: ${group || 'No group filter'}\n\n` + results.map((r) => `## ${r.status}\n\nSource: ${r.pin.sourcePath}#^${r.pin.blockId}\n\nDependent note: ${r.pin.dependentPath}\n\nLast checked: ${r.pin.checkedAt}\n\nApproved text\n\n${literal(r.pin.approved)}\n\nCurrent text\n\n${r.current === null ? 'No supported passage found.' : literal(r.current)}\n`).join('\n');
}

export interface Scenario { approved?: string; source?: string | null; blockId?: string; rename?: string; shown?: string; approve?: boolean; restart?: boolean }
/** Golden vectors use the same comparison and approval functions as the plugin. */
export function runScenario(s: Scenario): { status: Status; approved: string; sourcePath: string; current: string | null; accepted: boolean } {
	let pin: Pin = { id: 'pin-1', sourcePath: 'Source.md', blockId: s.blockId ?? 'limit', dependentPath: 'Conclusion.md', approved: s.approved ?? '30 days', checkedAt: '2026-10-14T00:00:00.000Z', group: '' };
	if (s.rename) pin.sourcePath = renamedPath(pin.sourcePath, 'Source.md', s.rename);
	const fresh = compare(pin, s.source === null ? null : paragraph(s.source ?? '30 days ^limit', pin.blockId));
	const shown = s.shown === undefined ? fresh : compare(pin, paragraph(s.shown, pin.blockId));
	const accepted = s.approve === true && canApprove(shown, fresh);
	if (accepted) pin.approved = fresh.current!;
	if (s.restart) pin = normalizeData(JSON.parse(JSON.stringify({ pins: [pin], groups: [] })) as unknown).pins[0]!;
	const final = compare(pin, s.source === null ? null : paragraph(s.source ?? '30 days ^limit', pin.blockId));
	return { status: final.status, approved: pin.approved, sourcePath: pin.sourcePath, current: final.current, accepted };
}
