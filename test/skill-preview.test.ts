import assert from "node:assert/strict";
import { test } from "node:test";

import { splitSkillPreview } from "../src/ui/skill-preview.ts";

test("splitSkillPreview recognizes multiple complete wrappers and retains malformed text", () => {
	const text = [
		"before",
		'<skill name="code-style" location="/skills/code-style/SKILL.md">',
		"complete first body",
		"</skill>",
		"between",
		'<skill name="broken">',
		"malformed body",
		'<skill name="typescript-code">',
		"complete second body",
		"</skill>",
		"after",
	].join("\n");

	assert.deepEqual(splitSkillPreview(text), [
		{
			type: "text",
			text: ["before", ""].join("\n"),
		},
		{ type: "skill", name: "code-style" },
		{
			type: "text",
			text: ["", "between", '<skill name="broken">', "malformed body", ""].join("\n"),
		},
		{ type: "skill", name: "typescript-code" },
		{ type: "text", text: "\nafter" },
	]);
});

test("splitSkillPreview leaves incomplete and structurally unsafe wrappers visible", () => {
	const text = [
		'<skill name="unterminated" location="/skills/unterminated/SKILL.md">',
		"body",
		'<skill name="bad\"name" location="/skills/bad/SKILL.md">',
		"body",
		"</skill>",
	].join("\n");

	assert.deepEqual(splitSkillPreview(text), [{ type: "text", text }]);
});
