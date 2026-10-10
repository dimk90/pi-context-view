/**
 * PayloadGuard's tool-declaration channel: compare the declarations a
 * payload carries with the tools the structured capture replayed, less the ones
 * Pi hid. Pure functions over process-local data.
 */
import type { GuardFinding } from "../snapshot.ts";
import { diffLines, normalizeText } from "./messages.ts";
import type { PayloadDeclaration } from "./payload.ts";

/** Inputs of one tool-channel comparison. */
export interface ToolComparisonInput {
	/** Tools replayed from the request at the monitor's handler, without the ones Pi hid. */
	readonly expected: readonly PayloadDeclaration[];
	/** Declarations of the payload after its inline changes were replayed. */
	readonly declarations: readonly PayloadDeclaration[];
	/**
	 * Match payload names to expected ones without case, as Pi does for Claude
	 * Code tool names with an Anthropic OAuth token.
	 */
	readonly ignoreNameCase: boolean;
}

/**
 * Compare the declarations; each difference is edited after monitor:
 *   missing from the payload    deleted, with the captured description lines
 *   added by the payload        added, with the payload's description lines
 *   description differs         modified, with the changed lines
 * Descriptions are compared without whitespace, as message text is. Schemas
 * are not compared: Pi adapts them per provider, such as for strict mode.
 */
export function compareToolDeclarations(input: ToolComparisonInput): GuardFinding[] {
	const expectedByName = new Map(input.expected.map((tool) => [tool.name, tool]));
	const declared = input.declarations.map((declaration) => ({
		...declaration,
		name: resolveName(declaration.name, expectedByName, input.ignoreNameCase),
	}));
	const declaredNames = new Set(declared.map((declaration) => declaration.name));
	const findings: GuardFinding[] = [];

	for (const tool of input.expected) {
		if (declaredNames.has(tool.name)) continue;
		findings.push({
			type: "late-tool-edit", change: "deleted", name: tool.name, lines: diffLines(tool.description ?? "", ""),
		});
	}
	for (const declaration of declared) {
		const tool = expectedByName.get(declaration.name);
		const before = tool?.description ?? "";
		const after = declaration.description ?? "";
		if (tool !== undefined && normalizeText(before) === normalizeText(after)) continue;
		findings.push({
			type: "late-tool-edit",
			change: tool === undefined ? "added" : "modified",
			name: declaration.name,
			lines: diffLines(before, after),
		});
	}
	return findings;
}

/** The expected name a payload name stands for; itself when it matches exactly or nothing matches. */
function resolveName(name: string, expected: ReadonlyMap<string, unknown>, ignoreCase: boolean): string {
	if (!ignoreCase || expected.has(name)) return name;
	const lower = name.toLowerCase();
	return [...expected.keys()].find((candidate) => candidate.toLowerCase() === lower) ?? name;
}
