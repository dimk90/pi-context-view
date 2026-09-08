/** Pure, deliberately heuristic attribution of the text after pi's prompt footer. */
import { AGGREGATE_SOURCE, extensionSource, type InjectionSource } from "./model.ts";

/** Public tool/command provenance only; no extension files are read to guess an owner. */
export interface PromptSourceSlice {
	readonly source: string;
	readonly path: string;
	/** Package root only, never a shared directory of loose extension files. */
	readonly baseDir?: string;
	/** Tools and slash commands this source registered; commands carry their `/`. */
	readonly names?: readonly string[];
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
	/** Tool or command of `source` the run named, when exactly one of them occurs in it. */
	readonly tool?: string;
	readonly attribution?: "guess";
}

/** Characters that may follow a matched path: its own separator, or ordinary prose punctuation. */
const PATH_BOUNDARY = "[/\\s\"'`<>\\[\\](),;:]";

/** Shortest registered name worth guessing; shorter tokens match ordinary prose too readily. */
const MIN_NAME_LENGTH = 3;

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
	const runs: Array<{ text: string; source: InjectionSource; tool?: string }> = [];
	for (const region of regions) {
		let previous: { text: string; source: InjectionSource; tool?: string } | undefined;
		for (const text of splitBlocks(region)) {
			const owner = guessOwner(text, options.sources ?? []);
			// Merge only inside one region: text on either side of the boundary has different authors.
			if (previous?.source.id === owner.source.id && previous.tool === owner.tool) {
				previous.text += text;
				continue;
			}
			previous = { text, ...owner };
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

/** Extension a block was guessed to belong to, and the tool or command it named. */
interface PromptAdditionOwner {
	readonly source: InjectionSource;
	readonly tool?: string;
}

/** Several tools/commands from one package are one candidate, not an ambiguous match. */
function guessOwner(text: string, sources: readonly PromptSourceSlice[]): PromptAdditionOwner {
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
	const [match] = matches;
	if (matches.size !== 1 || match === undefined) return { source: AGGREGATE_SOURCE };
	return { source: extensionSource(match), tool: guessTool(normalized, sources, match) };
}

/**
 * Registered tool or command of the owning extension the block names, when
 * exactly one of them occurs in it. Two mentions name no tool, as two packages
 * name no extension; the result only qualifies a guessed label, so it never
 * changes which item counts the text.
 */
function guessTool(
	text: string,
	sources: readonly PromptSourceSlice[],
	owner: string,
): string | undefined {
	const matches = new Set<string>();
	for (const source of sources) {
		if (source.source !== owner) continue;
		for (const name of source.names ?? []) {
			if (name.length >= MIN_NAME_LENGTH && containsName(text, name)) matches.add(name);
		}
	}
	const [name] = matches;
	return matches.size === 1 ? name : undefined;
}

/**
 * Require a complete name token, so a longer identifier and a path segment are
 * no mention: `web_search` matches in prose but not in `tools/web_search.md`,
 * and the command `/ask` matches only where it is written with its slash.
 */
function containsName(text: string, name: string): boolean {
	return new RegExp(`(?<![\\w/-])${escapePattern(name)}(?![\\w-])`).test(text);
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
