const { app, BrowserWindow } = require("electron");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

const directory = process.argv[2];
app.setPath("userData", join(directory, "user-data"));
app.setPath("crashDumps", join(directory, "crashes"));

function installMockApi() {
  const uploads = [];
  window.testUploads = uploads;
  window.testCreatedPlaylists = [];
  window.testTitleUpdates = [];
  window.testAppendedTracks = [];
  window.testSavedPlaylists = {
    owned: { cardId: "owned", title: "Saved playlist", trackCount: 3, editable: true, chapters: [
      { key: "001", title: "Original song", tracks: [{ title: "Original song", durationSec: 65 }] },
      { key: "002", title: "Chapter", tracks: [{ title: "First part" }, { title: "Second part" }] },
    ] },
    family: { cardId: "family", title: "Shared playlist", trackCount: 1, editable: false, chapters: [
      { key: "001", title: "Shared song", tracks: [{ title: "Shared song" }] },
    ] },
  };
  window.yoto = {
    app: { getVersion: async () => "test" },
    auth: { status: async () => ({ signedIn: true }), onComplete: () => {} },
    playlists: {
      list: async () => [{ cardId: "owned", title: "Saved playlist" }],
      listFamily: async () => [{ cardId: "family", title: "Shared playlist" }],
      create: async (input) => {
        window.testCreatedPlaylists.push(input);
        return { cardId: "test-card" };
      },
      get: async (cardId) => structuredClone(window.testSavedPlaylists[cardId] ?? { cardId: "test-card", title: "Published", chapters: [], trackCount: 0 }),
      setTitles: async (cardId, updates) => {
        window.testTitleUpdates.push({ cardId, updates });
        if (window.testFailNextTitleSave) {
          window.testFailNextTitleSave = false;
          throw new Error("Test save failed");
        }
        for (const update of updates) {
          const chapter = window.testSavedPlaylists[cardId].chapters[update.chapterIndex];
          if (update.trackIndex !== undefined) chapter.tracks[update.trackIndex].title = update.title;
          else {
            chapter.title = update.title;
            if (chapter.tracks.length === 1) chapter.tracks[0].title = update.title;
          }
        }
      },
      appendTracks: async (cardId, tracks) => {
        window.testAppendedTracks.push({ cardId, tracks });
        for (const track of tracks) window.testSavedPlaylists[cardId].chapters.push({ title: track.title, tracks: [{ title: track.title }] });
      },
    },
    icons: {
      listPublic: async () => [{ mediaId: "bird", title: "Bird", tags: ["bird"], url: "data:," }],
      listUser: async () => [],
    },
    audio: {
      upload: (id, path, onStage) => new Promise((resolve, reject) => {
        uploads.push({ id, path, onStage, resolve, reject });
      }),
      cancel: async (id) => uploads.find((upload) => upload.id === id)?.reject(new Error("aborted")),
    },
    files: {
      pathForDroppedFile: (file) => file.name,
      resolveDropPaths: async (paths) => ({ audioFiles: paths }),
    },
  };
}

async function checkRenaming() {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for renderer update");
  };
  const title = () => document.querySelector(".detail-title");
  const startRename = (value) => {
    title().click();
    const input = title().querySelector("input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.setSelectionRange(2, 8, "backward");
    return input;
  };
  const expectEditing = (input, value) => {
    expect(title().querySelector("input") === input, "Upload update replaced the name input");
    expect(document.activeElement === input, "Upload update lost input focus");
    expect(input.value === value, "Upload update lost the typed name");
    expect(input.selectionStart === 2 && input.selectionEnd === 8 && input.selectionDirection === "backward",
      "Upload update lost the cursor selection");
  };
  const pressKey = (input, key) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const finish = (upload) => upload.resolve({
    trackSha256: `sha-${upload.id}`, durationSec: 65, serverFileSize: 1024, format: "mp3", channels: "stereo",
  });

  await waitFor(() => document.querySelector(".new-playlist-btn"));
  document.querySelector(".new-playlist-btn").click();
  const transfer = new DataTransfer();
  for (const name of ["Bird.mp3", "Second.mp3", "Third.mp3"]) {
    transfer.items.add(new File(["mock audio"], name, { type: "audio/mpeg" }));
  }
  document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  await waitFor(() => window.testUploads.length === 3);

  const draftRow = document.querySelector(".draft-track");
  const pencil = draftRow.querySelector(".track-rename");
  expect(getComputedStyle(pencil).opacity === "0", "Track pencil should be hidden without hover or focus");
  pencil.focus();
  expect(getComputedStyle(pencil).opacity === "1", "Track pencil should be visible for keyboard focus");
  pencil.click();
  const trackInput = draftRow.querySelector(".track-title-input");
  trackInput.value = "Bird renamed";
  trackInput.setSelectionRange(2, 8, "backward");
  window.testUploads[1].onStage("uploading");
  expect(document.querySelector(".draft-track .track-title-input") === trackInput, "Upload replaced the track editor");
  expect(document.activeElement === trackInput && trackInput.selectionStart === 2 && trackInput.selectionEnd === 8,
    "Upload lost track input focus or selection");
  pressKey(trackInput, "Enter");
  expect(document.querySelector(".draft-track .track-title-text").textContent === "Bird renamed", "Draft track name was not saved");
  document.querySelector(".draft-track .track-rename").click();
  const cancelledTrackInput = document.querySelector(".draft-track .track-title-input");
  cancelledTrackInput.value = "Cancelled song name";
  pressKey(cancelledTrackInput, "Escape");
  expect(document.querySelector(".draft-track .track-title-text").textContent === "Bird renamed", "Escape saved a cancelled track name");

  const input = startRename("Bedtime songs");
  for (const stage of ["transcoding-local", "hashing", "uploading", "transcoding-server", "done"]) {
    window.testUploads[0].onStage(stage);
    expectEditing(input, "Bedtime songs");
  }
  expect(document.querySelector(".detail-meta").textContent === "1 of 3 ready", "Ready count did not update");
  finish(window.testUploads[0]);
  await waitFor(() => document.querySelector(".draft-track .track-icon"));
  expectEditing(input, "Bedtime songs");
  expect(document.querySelector(".track-duration").textContent === "1:05", "Finished track did not update");

  window.testUploads[1].reject(new Error("Test upload failed"));
  await waitFor(() => document.querySelector(".row-error"));
  expectEditing(input, "Bedtime songs");
  window.testUploads[2].reject(new Error("aborted"));
  await waitFor(() => document.querySelector(".row-cancelled"));
  expectEditing(input, "Bedtime songs");

  pressKey(input, "Enter");
  expect(!title().querySelector("input"), "Enter did not finish renaming");
  expect(title().querySelector(".detail-title-text").textContent === "Bedtime songs", "Enter did not save the name");
  expect(document.querySelector(".playlist.draft .playlist-title").textContent.startsWith("Bedtime songs"),
    "Saved name did not update in the sidebar");

  const retry = document.querySelector(".row-error .retry-btn");
  retry.click();
  await waitFor(() => window.testUploads.length === 4);
  const cancelledInput = startRename("Cancelled name");
  window.testUploads[3].onStage("uploading");
  expectEditing(cancelledInput, "Cancelled name");
  pressKey(cancelledInput, "Escape");
  expect(!title().querySelector("input"), "Escape did not finish renaming");
  expect(title().querySelector(".detail-title-text").textContent === "Bedtime songs", "Escape saved a cancelled name");
  finish(window.testUploads[3]);
  await waitFor(() => document.querySelector(".detail-meta").textContent === "2 of 3 ready");
  expect(!title().querySelector("input"), "Later upload updates reopened the cancelled edit");

  const blurredInput = startRename("  Final playlist name  ");
  blurredInput.blur();
  expect(title().querySelector(".detail-title-text").textContent === "Final playlist name", "Blur did not save and trim the name");
  const emptyInput = startRename("    ");
  pressKey(emptyInput, "Enter");
  expect(title().querySelector(".detail-title-text").textContent === "Final playlist name", "Empty edit erased the name");

  const publish = [...document.querySelectorAll(".detail-toolbar button")].find((button) => button.textContent === "Publish to Yoto");
  expect(!publish.disabled, "Publish did not become available after uploads stopped");
  publish.click();
  await waitFor(() => window.testCreatedPlaylists.length === 1);
  expect(window.testCreatedPlaylists[0].title === "Final playlist name", "Publishing used the wrong name");
  expect(window.testCreatedPlaylists[0].tracks.length === 2, "Publishing lost completed tracks");
  expect(window.testCreatedPlaylists[0].tracks[0].title === "Bird renamed", "Publishing lost the edited draft track name");
}

async function checkSavedTrackRenaming() {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for saved track update");
  };
  const pressKey = (input, key) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const start = (row, value) => {
    const original = row.querySelector(".track-title-text").textContent;
    row.querySelector(".track-rename").click();
    const input = row.querySelector(".track-title-input");
    expect(input.value === original, "Track editor did not start with the current name");
    input.value = value;
    input.setSelectionRange(2, 8, "backward");
    return input;
  };
  const finish = (upload) => upload.resolve({ trackSha256: `sha-${upload.id}`, durationSec: 65, serverFileSize: 1024 });
  await waitFor(() => !document.querySelector(".playlist.draft"));
  document.querySelector('.playlist[data-card="owned"]').click();
  await waitFor(() => document.querySelector(".track-sub"));

  let row = document.querySelector('.track[data-idx="0"]');
  const savedInput = start(row, "Saved new name");
  pressKey(savedInput, "Enter");
  await waitFor(() => !row.querySelector("input"));
  expect(row.querySelector(".track-title-text").textContent === "Saved new name", "Saved track name did not update");
  expect(window.testTitleUpdates[0].updates[0].chapterIndex === 0 && window.testTitleUpdates[0].updates[0].trackIndex === undefined,
    "Saved rename targeted the wrong chapter");
  expect(window.testSavedPlaylists.owned.chapters[0].tracks[0].title === "Saved new name", "Saved rename did not persist");

  const callCount = window.testTitleUpdates.length;
  const emptyInput = start(row, "   ");
  pressKey(emptyInput, "Enter");
  expect(window.testTitleUpdates.length === callCount, "Empty name was sent to Yoto");
  const cancelledInput = start(row, "Cancelled saved name");
  pressKey(cancelledInput, "Escape");
  expect(window.testTitleUpdates.length === callCount, "Cancelled name was sent to Yoto");

  window.testFailNextTitleSave = true;
  start(row, "Failed name").blur();
  await waitFor(() => document.querySelector(".error.banner"));
  expect(row.querySelector(".track-title-text").textContent === "Saved new name", "Failed save erased the original name");
  expect(window.testSavedPlaylists.owned.chapters[0].title === "Saved new name", "Failed save changed the remote name");

  const subRow = document.querySelectorAll(".track-sub")[1];
  start(subRow, "Second part renamed").blur();
  await waitFor(() => !subRow.querySelector("input"));
  const nestedUpdate = window.testTitleUpdates.at(-1).updates[0];
  expect(nestedUpdate.chapterIndex === 1 && nestedUpdate.trackIndex === 1, "Nested rename targeted the wrong track");
  expect(window.testSavedPlaylists.owned.chapters[1].title === "Chapter" && window.testSavedPlaylists.owned.chapters[1].tracks[0].title === "First part",
    "Nested rename changed the chapter or a sibling");

  const previousUploads = window.testUploads.length;
  const transfer = new DataTransfer();
  for (const name of ["Fourth.mp3", "Fifth.mp3"]) transfer.items.add(new File(["audio"], name));
  document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  await waitFor(() => window.testUploads.length === previousUploads + 2);
  row = document.querySelector('.track[data-idx="0"]');
  const whileUploading = start(row, "Name during upload");
  window.testUploads[previousUploads].onStage("uploading");
  expect(document.querySelector('.track[data-idx="0"] input') === whileUploading && document.activeElement === whileUploading,
    "Appending upload replaced the saved track editor");
  expect(whileUploading.selectionStart === 2 && whileUploading.selectionEnd === 8, "Appending upload lost cursor selection");
  pressKey(whileUploading, "Enter");
  await waitFor(() => !row.querySelector("input"));

  const appendingRow = document.querySelectorAll(".tracks-appending .track")[1];
  const appendingInput = start(appendingRow, "New appended song");
  finish(window.testUploads[previousUploads]);
  await waitFor(() => document.querySelector(".tracks-appending .track-status")?.textContent === "Ready");
  expect(document.querySelector(".tracks-appending input") === appendingInput && document.activeElement === appendingInput,
    "Completion replaced the appended track editor");
  pressKey(appendingInput, "Enter");
  finish(window.testUploads[previousUploads + 1]);
  await waitFor(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Save to playlist"));
  [...document.querySelectorAll("button")].find((button) => button.textContent === "Save to playlist").click();
  await waitFor(() => window.testAppendedTracks.length === 1);
  expect(window.testAppendedTracks[0].tracks[1].title === "New appended song", "Appending lost the edited track name");

  document.querySelector('.playlist[data-card="family"]').click();
  await waitFor(() => document.querySelector(".detail-readonly-note"));
  expect(!document.querySelector("#detail .track-rename"), "Read-only family tracks have a rename control");
}

async function checkMainTitleWrites() {
  const assert = require("node:assert/strict");
  const { registerApiHandlers } = require(join(directory, "main-api.cjs"));
  const handlers = new Map();
  registerApiHandlers({ handle: (name, callback) => handlers.set(name, callback) });
  const original = {
    cardId: "api-test", title: "Playlist", metadata: { cover: { imageL: "cover" } },
    content: { chapters: [
      { key: "001", title: "Original", tracks: [{ title: "Original", trackUrl: "audio-one", duration: 65 }] },
      { key: "002", title: "Chapter", tracks: [{ title: "First", trackUrl: "audio-two" }, { title: "Second", trackUrl: "audio-three" }] },
    ] },
  };
  let remote = structuredClone(original);
  let failNext = false;
  let holdNext = false;
  let release;
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      posts.push(body);
      if (holdNext) {
        holdNext = false;
        await new Promise((resolve) => { release = resolve; });
      }
      if (failNext) {
        failNext = false;
        return new Response("Test save failed", { status: 500 });
      }
      remote = body;
      return Response.json({ card: remote });
    }
    if (new URL(url).pathname === "/content/shared") return new Response("Forbidden", { status: 403 });
    if (new URL(url).pathname === "/card/shared") return Response.json({ card: { ...remote, cardId: "shared" } });
    return Response.json({ card: remote });
  };
  const rename = (updates) => handlers.get("playlists:setTitles")(null, "api-test", updates);
  try {
    await handlers.get("playlists:get")(null, "api-test");
    failNext = true;
    await assert.rejects(rename([{ chapterIndex: 0, title: "Failed name" }]), /Test save failed/);
    await rename([{ chapterIndex: 1, trackIndex: 1, title: "New second" }]);
    assert.equal(remote.content.chapters[0].title, "Original", "Failed name remained in the cached content");
    assert.equal(remote.content.chapters[1].title, "Chapter");
    assert.equal(remote.content.chapters[1].tracks[0].title, "First");
    assert.equal(remote.content.chapters[1].tracks[1].title, "New second");
    assert.equal(remote.content.chapters[1].tracks[1].trackUrl, "audio-three");
    assert.deepEqual(remote.metadata, original.metadata);

    const before = posts.length;
    holdNext = true;
    const first = rename([{ chapterIndex: 0, title: "New first" }]);
    const second = rename([{ chapterIndex: 1, trackIndex: 0, title: "New nested first" }]);
    for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(typeof release, "function", "First save did not start");
    assert.equal(posts.length, before + 1, "Second save raced the first");
    release();
    await Promise.all([first, second]);
    assert.equal(remote.content.chapters[0].title, "New first");
    assert.equal(remote.content.chapters[0].tracks[0].title, "New first");
    assert.equal(remote.content.chapters[1].tracks[0].title, "New nested first");
    assert.equal(remote.content.chapters[1].tracks[1].title, "New second");

    failNext = true;
    const failed = assert.rejects(rename([{ chapterIndex: 0, title: "Another failed name" }]), /Test save failed/);
    const afterFailure = rename([{ chapterIndex: 1, title: "New chapter" }]);
    await Promise.all([failed, afterFailure]);
    assert.equal(remote.content.chapters[0].title, "New first");
    assert.equal(remote.content.chapters[1].title, "New chapter");

    await handlers.get("playlists:get")(null, "shared");
    const postCount = posts.length;
    await assert.rejects(handlers.get("playlists:setTitles")(null, "shared", [{ chapterIndex: 0, title: "Forbidden name" }]), /Only its owner/);
    assert.equal(posts.length, postCount, "Read-only rename reached the write endpoint");
  } finally {
    global.fetch = originalFetch;
  }
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  await window.loadFile(join(directory, "index.html"));
  await window.webContents.executeJavaScript(`(${installMockApi.toString()})()`);
  await window.webContents.executeJavaScript(await readFile(join(directory, "renderer.js"), "utf8"));
  window.webContents.focus();
  await window.webContents.executeJavaScript(`(${checkRenaming.toString()})()`);
  await window.webContents.executeJavaScript(`(${checkSavedTrackRenaming.toString()})()`);
  await checkMainTitleWrites();
  console.log("Draft rename regression checks passed");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
