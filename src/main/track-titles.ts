export interface TitleUpdate {
  chapterIndex: number;
  trackIndex?: number;
  title: string;
}

export function updateChapterTitles(chapters: Array<Record<string, unknown>>, updates: TitleUpdate[]): Array<Record<string, unknown>> {
  const next = chapters.slice();
  for (const update of updates) {
    const chapter = next[update.chapterIndex];
    if (!Number.isInteger(update.chapterIndex) || !chapter) throw new Error("Unknown chapter.");
    const title = update.title.trim();
    if (!title) throw new Error("Track names cannot be empty.");
    const tracks = (chapter.tracks as Array<Record<string, unknown>> | undefined) ?? [];
    if (update.trackIndex !== undefined) {
      if (!Number.isInteger(update.trackIndex) || !tracks[update.trackIndex]) throw new Error("Unknown track.");
      const nextTracks = tracks.slice();
      nextTracks[update.trackIndex] = { ...tracks[update.trackIndex], title };
      next[update.chapterIndex] = { ...chapter, tracks: nextTracks, ...(tracks.length === 1 ? { title } : {}) };
    } else {
      next[update.chapterIndex] = {
        ...chapter, title,
        ...(tracks.length === 1 ? { tracks: [{ ...tracks[0], title }] } : {}),
      };
    }
  }
  return next;
}
