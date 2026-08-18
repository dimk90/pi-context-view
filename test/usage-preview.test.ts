import assert from "node:assert/strict";
import { test } from "node:test";

import { BlockNavigator, layoutPreviewBlocks } from "../src/ui/usage-preview.ts";

test("layoutPreviewBlocks separates blocks without assigning the blank row", () => {
	assert.deepEqual(layoutPreviewBlocks([2, 3]), {
		extents: [
			{ start: 0, height: 2 },
			{ start: 3, height: 3 },
		],
		lines: [
			{ blockIndex: 0, lineIndex: 0 },
			{ blockIndex: 0, lineIndex: 1 },
			undefined,
			{ blockIndex: 1, lineIndex: 0 },
			{ blockIndex: 1, lineIndex: 1 },
			{ blockIndex: 1, lineIndex: 2 },
		],
	});
});

test("BlockNavigator moves by block and minimally reveals blocks that fit", () => {
	const navigator = new BlockNavigator();
	navigator.setExtent(layoutPreviewBlocks([3, 2, 4]), 5);

	assert.equal(navigator.selected, 0);
	assert.equal(navigator.offset, 0);
	assert.equal(navigator.stepForward(), true);
	assert.equal(navigator.selected, 1);
	assert.equal(navigator.offset, 1, "the second block is bottom-aligned without overscrolling");
	assert.equal(navigator.stepForward(), true);
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.offset, 6);
	assert.equal(navigator.stepBack(), true);
	assert.equal(navigator.selected, 1);
	assert.equal(navigator.offset, 4);
});

test("BlockNavigator scrolls inside an oversized block before crossing its edge", () => {
	const navigator = new BlockNavigator();
	navigator.setExtent(layoutPreviewBlocks([2, 7, 2]), 4);

	assert.equal(navigator.stepForward(), true);
	assert.equal(navigator.selected, 1);
	assert.equal(navigator.offset, 3, "forward navigation exposes the oversized block's top");
	for (const offset of [4, 5, 6]) {
		assert.equal(navigator.stepForward(), true);
		assert.equal(navigator.selected, 1);
		assert.equal(navigator.offset, offset);
	}
	assert.equal(navigator.stepForward(), true);
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.offset, 9);

	assert.equal(navigator.stepBack(), true);
	assert.equal(navigator.selected, 1);
	assert.equal(navigator.offset, 6, "backward navigation exposes the oversized block's bottom");
	assert.equal(navigator.stepBack(), true);
	assert.equal(navigator.selected, 1);
	assert.equal(navigator.offset, 5);
});

test("BlockNavigator pages by viewport height and reaches the item at each stream boundary", () => {
	const navigator = new BlockNavigator();
	navigator.setExtent(layoutPreviewBlocks([2, 2, 2, 2, 2]), 5);

	assert.equal(navigator.page(1), true);
	assert.equal(navigator.offset, 5);
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.page(1), true);
	assert.equal(navigator.offset, 9);
	assert.equal(navigator.selected, 3);
	assert.equal(navigator.page(1), true, "paging from the final viewport selects its last block");
	assert.equal(navigator.offset, 9);
	assert.equal(navigator.selected, 4);
	assert.equal(navigator.page(1), false, "paging at the last block is bounded");
	assert.equal(navigator.page(-1), true);
	assert.equal(navigator.offset, 4);
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.page(-1), true);
	assert.equal(navigator.offset, 0);
	assert.equal(navigator.selected, 0);
	assert.equal(navigator.page(-1), false, "paging at the first block is bounded");
});

test("BlockNavigator handles empty streams and boundary jumps", () => {
	const navigator = new BlockNavigator();
	navigator.setExtent(layoutPreviewBlocks([]), 5);
	assert.equal(navigator.blockCount, 0);
	assert.equal(navigator.stepBack(), false);
	assert.equal(navigator.stepForward(), false);
	assert.equal(navigator.page(1), false);
	assert.equal(navigator.moveToFirst(), false);
	assert.equal(navigator.moveToLast(), false);

	navigator.setExtent(layoutPreviewBlocks([2, 2, 2]), 8);
	assert.equal(navigator.page(1), true, "a single-page stream still pages to its last block");
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.page(-1), true, "Page Up returns a single-page stream to its first block");
	assert.equal(navigator.selected, 0);

	navigator.setExtent(layoutPreviewBlocks([2, 2, 2]), 3);
	assert.equal(navigator.moveToLast(), true);
	assert.equal(navigator.selected, 2);
	assert.equal(navigator.offset, navigator.maxOffset);
	assert.equal(navigator.moveToFirst(), true);
	assert.equal(navigator.selected, 0);
	assert.equal(navigator.offset, 0);
});
