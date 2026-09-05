/** Pure, deliberately heuristic attribution of the text after pi's prompt footer. */
import { AGGREGATE_SOURCE, extensionSource, type InjectionSource } from "./model.ts";

/** Public tool/command provenance only; no extension files are read to guess an owner. */
export interface PromptSourceSlice {
	readonly source: string;
	readonly path: string;
	/** Package root only, never a shared directory of loose extension files. */
	readonly baseDir?: string;
}

/** Optional observations that improve guesses without claiming handler-level provenance. */
export interface PromptAdditionOptions {
	readonly sources?: readonly PromptSourceSlice[];
	/** Prompt seen at our latest before_agent_start handler; used only if still a prefix. */
	readonly promptAtHandler?: string;
}

/** One contiguous captured run. Concatenating runs restores the exact addition region. */
export interface PromptAdditionRun {
	readonly text: string;
	readonly source: InjectionSource;
	readonly attribution?: "guess";
}

/** Characters that may follow a matched path: its own separator, or ordinary prose punctuation. */
const PATH_BOUNDARY = "[/\\s\"'`<>\\[\\](),;:]";

/**
 * Bound blank-line blocks at our handler position, then guess a source only on
 * a unique package-name or full-path match. Unmatched/ambiguous text stays
 * unattributed. The boundary is internal and never establishes an owner.
 */
export function splitPromptAdditions(
	prompt: string,
	start: number,
	options: PromptAdditionOptions,
): PromptAdditionRun[] {
	const observed = options.promptAtHandler;
	const boundary = observed !== undefined && observed.length > start && prompt.startsWith(observed)
		? observed.length
		: start;
	const regions = [prompt.slice(start, boundary), prompt.slice(boundary)];
	const runs: Array<{ text: string; source: InjectionSource }> = [];
	for (const region of regions) {
		let previous: { text: string; source: InjectionSource } | undefined;
		for (const text of splitBlocks(region)) {
			const source = guessSource(text, options.sources ?? []);
			// Merge only inside one region: text on either side of the boundary has different authors.
			if (previous?.source.id === source.id) {
				previous.text += text;
				continue;
			}
			previous = { text, source };
			runs.push(previous);
		}
	}
	return runs.map((run) => ({
		...run,
		attribution: run.source.id === AGGREGATE_SOURCE.id ? undefined : "guess",
	}));
}

/** Keep separators with the following block; trailing whitespace stays with the final block. */
function splitBlocks(text: string): string[] {
	const blocks: string[] = [];
	let start = 0;
	for (const separator of text.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) {
		if (text.slice(start, separator.index).trim().length === 0) continue;
		if (text.slice(separator.index).trim().length === 0) break;
		blocks.push(text.slice(start, separator.index));
		start = separator.index;
	}
	if (start < text.length) blocks.push(text.slice(start));
	return blocks;
}

/** Several tools/commands from one package are one candidate, not an ambiguous match. */
function guessSource(text: string, sources: readonly PromptSourceSlice[]): InjectionSource {
	const normalized = text.replaceAll("\\", "/");
	const matches = new Set<string>();
	for (const source of sources) {
		if (source.source === "builtin" || source.source === "sdk") continue;
		const packageName = source.source.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/)?.[1];
		if (
			containsPath(normalized, source.path) || containsPath(normalized, source.baseDir) ||
			(packageName !== undefined && containsPackage(normalized, packageName)) ||
			(/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(source.source) && containsPackage(normalized, source.source))
		) matches.add(source.source);
	}
	const [source] = matches;
	return matches.size === 1 && source !== undefined ? extensionSource(source) : AGGREGATE_SOURCE;
}

/**
 * Require a complete package token: a longer package name must not match, while
 * ordinary sentence punctuation after the name must, so `pi-web-providers` and
 * `pi-web.js` are rejected where `npm:pi-web.` is accepted.
 */
function containsPackage(text: string, name: string): boolean {
	const escaped = escapePattern(name);
	return new RegExp(`(?:^|[^\\w@/.-]|/node_modules/)${escaped}(?![\\w-])(?!\\.[\\w-])`).test(text);
}

/** Match absolute paths at boundaries; a package root may be followed by a child path. */
function containsPath(text: string, path: string | undefined): boolean {
	if (path === undefined) return false;
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
	// A relative or synthetic provenance such as `<builtin:read>` is no evidence of authorship.
	if (!/^(\/|[A-Za-z]:\/).+/.test(normalized)) return false;
	return new RegExp(`(?:^|[^\\w/.-])${escapePattern(normalized)}(?=$|${PATH_BOUNDARY})`).test(text);
}

/** Escape literal provenance before using it in a boundary-sensitive pattern. */
function escapePattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
