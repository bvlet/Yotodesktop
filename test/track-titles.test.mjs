import assert from "node:assert/strict";
import test from "node:test";
import { updateChapterTitles } from "../src/main/track-titles.ts";

test("renaming a single-track chapter preserves audio metadata and the original cache", () => {
  const chapters = [{ key: "001", title: "Original", display: { icon: "bird" }, tracks: [{
    key: "01", title: "Original", trackUrl: "yoto:audio", duration: 65, format: "opus",
  }] }];
  const before = structuredClone(chapters);
  const renamed = updateChapterTitles(chapters, [{ chapterIndex: 0, title: "  Bedtime song  " }]);
  assert.equal(renamed[0].title, "Bedtime song");
  assert.deepEqual(renamed[0].tracks, [{ ...before[0].tracks[0], title: "Bedtime song" }]);
  assert.deepEqual(renamed[0].display, before[0].display);
  assert.deepEqual(chapters, before);
});

test("renaming a nested track keeps its chapter and sibling tracks intact", () => {
  const chapters = [{ title: "Chapter", tracks: [{ title: "First", trackUrl: "one" }, { title: "Second", trackUrl: "two" }] }];
  const renamed = updateChapterTitles(chapters, [{ chapterIndex: 0, trackIndex: 1, title: "New second" }]);
  assert.equal(renamed[0].title, "Chapter");
  assert.deepEqual(renamed[0].tracks, [{ title: "First", trackUrl: "one" }, { title: "New second", trackUrl: "two" }]);
  assert.equal(chapters[0].tracks[1].title, "Second");
});

test("renaming a multi-track chapter leaves the nested track names intact", () => {
  const chapters = [{ title: "Chapter", tracks: [{ title: "First" }, { title: "Second" }] }];
  const renamed = updateChapterTitles(chapters, [{ chapterIndex: 0, title: "Renamed chapter" }]);
  assert.equal(renamed[0].title, "Renamed chapter");
  assert.deepEqual(renamed[0].tracks, chapters[0].tracks);
});

test("bulk title updates can rename several tracks in the same chapter", () => {
  const chapters = [{ title: "Chapter", tracks: [{ title: "First" }, { title: "Second" }] }];
  const renamed = updateChapterTitles(chapters, [
    { chapterIndex: 0, trackIndex: 0, title: "New first" },
    { chapterIndex: 0, trackIndex: 1, title: "New second" },
  ]);
  assert.deepEqual(renamed[0].tracks, [{ title: "New first" }, { title: "New second" }]);
});

test("invalid or empty title updates do not modify the original chapters", () => {
  const chapters = [{ title: "Original", tracks: [{ title: "Original" }] }];
  const before = structuredClone(chapters);
  for (const update of [
    { chapterIndex: -1, title: "New" }, { chapterIndex: 2, title: "New" },
    { chapterIndex: 0.5, title: "New" }, { chapterIndex: 0, trackIndex: 3, title: "New" },
    { chapterIndex: 0, title: "   " },
  ]) {
    assert.throws(() => updateChapterTitles(chapters, [{ chapterIndex: 0, title: "Changed" }, update]));
    assert.deepEqual(chapters, before);
  }
});
