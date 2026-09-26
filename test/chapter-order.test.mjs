import assert from "node:assert/strict";
import test from "node:test";
import { nextUnusedChapterKey, reorderChapters } from "../src/main/chapter-order.ts";

test("new chapter keys skip keys left behind by deletions", () => {
  const used = new Set(["001", "003"]);
  assert.equal(nextUnusedChapterKey(used, 3), "004");
  assert.equal(nextUnusedChapterKey(used, 4), "005");
});

test("reorder keeps every chapter and repairs duplicate keys", () => {
  const chapters = [
    { key: "001", title: "First" },
    { key: "003", title: "Second" },
    { key: "003", title: "Third" },
  ];
  const reordered = reorderChapters(chapters, [2, 0, 1]);
  assert.deepEqual(reordered.map((chapter) => chapter.title), ["Third", "First", "Second"]);
  assert.equal(new Set(reordered.map((chapter) => chapter.key)).size, 3);
  assert.equal(reordered[2].key, "003");
  assert.equal(chapters[2].key, "003");
});

test("reorder assigns a key to a chapter that has none", () => {
  const reordered = reorderChapters([{ title: "First" }, { key: "002", title: "Second" }], [1, 0]);
  assert.equal(reordered[0].key, "002");
  assert.equal(reordered[1].key, "003");
});

test("reorder rejects repeated or missing positions", () => {
  const chapters = [{ key: "001" }, { key: "002" }];
  assert.throws(() => reorderChapters(chapters, [0, 0]));
  assert.throws(() => reorderChapters(chapters, [0]));
  assert.throws(() => reorderChapters(chapters, [0, 2]));
});
