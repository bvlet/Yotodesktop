type KeyedChapter = { key?: unknown };

export function nextUnusedChapterKey(usedKeys: Set<string>, startNumber: number): string {
  let number = startNumber;
  let key = String(number).padStart(3, "0");
  while (usedKeys.has(key)) {
    number += 1;
    key = String(number).padStart(3, "0");
  }
  usedKeys.add(key);
  return key;
}

export function reorderChapters<T extends KeyedChapter>(chapters: T[], order: number[]): T[] {
  if (order.length !== chapters.length ||
      new Set(order).size !== chapters.length ||
      order.some((index) => !Number.isInteger(index) || index < 0 || index >= chapters.length)) {
    throw new Error("reorder must include each chapter exactly once");
  }

  // Keep the first occurrence of each key. Older appends could reuse a key after a deletion.
  const usedKeys = new Set(chapters
    .map((chapter) => chapter.key)
    .filter((key): key is string => typeof key === "string" && key.length > 0));
  const seenKeys = new Set<string>();
  const normalized = chapters.map((chapter) => {
    const key = chapter.key;
    if (typeof key === "string" && key.length > 0 && !seenKeys.has(key)) {
      seenKeys.add(key);
      return chapter;
    }
    const newKey = nextUnusedChapterKey(usedKeys, chapters.length + 1);
    seenKeys.add(newKey);
    return { ...chapter, key: newKey };
  });
  return order.map((index) => normalized[index]);
}
