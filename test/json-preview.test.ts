import assert from "node:assert/strict";
import { test } from "node:test";

import { expandJsonSpan, shiftJsonSpan } from "../src/ui/json-preview.ts";

test("expandJsonSpan indents only the marked run of a preview text", () => {
	// Tool definition shape: the schema is the tail after the description line.
	const heading = "search: Search the web\n";
	const schema = '{"type":"object","properties":{"q":{"type":"string"}}}';
	const definition = `${heading}${schema}`;
	assert.equal(
		expandJsonSpan(definition, { start: heading.length, end: definition.length }),
		[
			"search: Search the web",
			"{",
			'  "type": "object",',
			'  "properties": {',
			'    "q": {',
			'      "type": "string"',
			"    }",
			"  }",
			"}",
		].join("\n"),
	);

	// Tool call shape: the arguments sit inside the call parentheses.
	const call = 'read({"path":"x"})';
	assert.equal(expandJsonSpan(call, { start: 5, end: call.length - 1 }), 'read({\n  "path": "x"\n})');

	// Message content shape: the whole text is one serialized document.
	const content = '[{"type":"text"}]';
	assert.equal(expandJsonSpan(content, { start: 0, end: content.length }), '[\n  {\n    "type": "text"\n  }\n]');
});

test("expandJsonSpan leaves unmarked and unparseable text exactly as captured", () => {
	const text = 'read({"path":"x"})';
	assert.equal(expandJsonSpan(text, undefined), text);
	// A stale marker must degrade to the captured form rather than corrupt it.
	assert.equal(expandJsonSpan(text, { start: 0, end: text.length }), text);
	assert.equal(expandJsonSpan("{ not json }", { start: 0, end: 12 }), "{ not json }");
});

test("shiftJsonSpan re-anchors a span onto trimmed text", () => {
	assert.equal(shiftJsonSpan(undefined, 2), undefined);
	assert.deepEqual(shiftJsonSpan({ start: 3, end: 9 }, 0), { start: 3, end: 9 });
	assert.deepEqual(shiftJsonSpan({ start: 3, end: 9 }, 3), { start: 0, end: 6 });
	// Trimming into the run itself invalidates the marker.
	assert.equal(shiftJsonSpan({ start: 3, end: 9 }, 4), undefined);
});
