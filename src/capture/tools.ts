/**
 * PayloadGuard's tool-declaration channel, LoadoutAttributor, and
 * DeclaredTools (D4, D7, D9): compare the declarations a payload carries with
 * the tools the structured capture replayed. Pure functions over
 * process-local data.
 */
import type { DeclaredTools, GuardFinding } from "../snapshot.ts";
import type { PayloadDeclaration } from "./payload.ts";

/** Inputs of one tool-channel comparison. */
export interface ToolComparisonInput {
	/** Tools replayed from the request at the monitor's handler. */
	readonly expected: readonly PayloadDeclaration[];
	/** Declarations of the payload after its inline changes were replayed. */
	readonly declarations: readonly PayloadDeclaration[];
	/** Tool names replayed from the capture's baseline. */
	readonly baselineNames: readonly string[];
	/**
	 * Match payload names to expected ones without case, as Pi does for Claude
	 * Code tool names with an Anthropic OAuth token.
	 */
	readonly ignoreNameCase: boolean;
	/** Active `model-only` tools that may hide declarations; read only when one is missing. */
	readonly loadoutCandidates: () => readonly string[];
}

/** Tool-channel findings and the name sets Usage filters by. */
export interface ToolComparison {
	readonly findings: readonly GuardFinding[];
	readonly declaredTools: DeclaredTools;
}

/**
 * Compare the declarations:
 *   missing from the payload    hidden declaration, with loadout candidates
 *   added by the payload        edited after monitor
 *   description differs         edited after monitor
 * Schemas are not compared: Pi adapts them per provider, such as for strict mode.
 */
export function compareToolDeclarations(input: ToolComparisonInput): ToolComparison {
	const expectedByName = new Map(input.expected.map((tool) => [tool.name, tool]));
	const declared = input.declarations.map((declaration) => ({
		...declaration,
		name: resolveName(declaration.name, expectedByName, input.ignoreNameCase),
	}));
	const declaredByName = new Map(declared.map((declaration) => [declaration.name, declaration]));
	const findings: GuardFinding[] = [];

	const missing = input.expected.filter((tool) => !declaredByName.has(tool.name));
	const candidates = missing.length > 0 ? input.loadoutCandidates() : [];
	for (const tool of missing) {
		findings.push({ type: "hidden-declaration", name: tool.name, candidates: candidates.filter((name) => name !== tool.name) });
	}
	for (const declaration of declared) {
		const tool = expectedByName.get(declaration.name);
		if (tool !== undefined && tool.description === declaration.description) continue;
		findings.push({
			type: "late-tool-edit",
			change: tool === undefined ? "added" : "modified",
			name: declaration.name,
			...(declaration.description === undefined ? {} : { description: declaration.description }),
		});
	}
	return {
		findings,
		declaredTools: { declared: [...declaredByName.keys()], baseline: [...input.baselineNames] },
	};
}

/** The expected name a payload name stands for; itself when it matches exactly or nothing matches. */
function resolveName(name: string, expected: ReadonlyMap<string, unknown>, ignoreCase: boolean): string {
	if (!ignoreCase || expected.has(name)) return name;
	const lower = name.toLowerCase();
	return [...expected.keys()].find((candidate) => candidate.toLowerCase() === lower) ?? name;
}
