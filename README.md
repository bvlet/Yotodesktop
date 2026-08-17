# Desktop for Yoto

A desktop app for **macOS** and **Windows** that turns folders of audio into Yoto MYO playlists. Drag-and-drop to upload, AI-picked pixel-art icons, drag-to-reorder, full edit-in-place. No subscription, no account beyond your existing Yoto login.

## Download

Grab the latest installer for your machine from the [Releases page](https://github.com/sjaym88/desktop-for-yoto/releases/latest):

- **Mac (Apple Silicon)** — `Desktop-for-Yoto-*-arm64.dmg`
- **Mac (Intel)** — `Desktop-for-Yoto-*-x64.dmg`
- **Windows** — `Desktop-for-Yoto-Setup-*.exe`

## First-run instructions (unsigned app)

The app is not code-signed (see [why](#why-isnt-it-signed) below), so the first launch shows a warning. One-time:

**Mac:** open the DMG, drag the app to Applications. Then in Finder, **right-click** the app → **Open** → click **Open** in the dialog. After that, double-click works normally.

**Windows:** run the installer. Windows SmartScreen may say "Windows protected your PC" — click **More info** → **Run anyway**.

## Quickstart

1. Open the app, sign in to your Yoto account in the browser window that pops up.
2. Drag a folder of audio anywhere onto the window. Any format works (mp3, flac, wav, m4a, opus, ogg…) — the app converts to mp3 locally and uploads to Yoto.
3. Click **Auto-choose icons** to AI-match each track to a pixel-art icon from Yoto's library.
4. Click **Publish to Yoto**. The playlist appears in your Yoto account.
5. Open the official Yoto app on your phone to **link** the new playlist to a physical MYO card. (The desktop app cannot link cards — that step requires the Yoto mobile app and physical NFC.)

## Features

- **Drag-and-drop folders** of any audio format. Local ffmpeg transcoding handles non-mp3.
- **Up to 3 parallel uploads**, with cancel / retry per track.
- **AI semantic icon matching** (bundled offline embedding model, ~25 MB) — "Wings" finds bird/feather icons, "Grow" finds plant/seedling, etc.
- **Drag-to-reorder** tracks; inline rename for playlists and tracks.
- **Cover art upload** (any image, auto-resized).
- **Add tracks to existing playlists** by dropping audio while viewing them.
- **Fix on player** button — re-publishes a playlist with the correct chapter shape (use if a playlist won't play and just shows the cloud icon).

## Known limitations

- Linking a playlist to a physical MYO card still requires the official Yoto mobile app — there's no NFC API for desktops.
- Player audio sync to the device can take several minutes after publish; per Yoto's own troubleshooting, the player must be plugged in, idle, and no Yoto app open on a phone for it to refresh.

## Why isn't it signed?

Apple Developer ($99/yr) + Windows EV cert ($200–500/yr) cost more per year than the project warrants. The right-click → Open / SmartScreen → Run anyway dance is the price of free.

## Building from source

```sh
git clone https://github.com/sjaym88/desktop-for-yoto.git
cd desktop-for-yoto
npm install
npm run dev
```

To build installers locally: `npm run dist -- --mac` (or `--win`). For Windows on a Mac you'll need `brew install --cask --no-quarantine wine-stable`.

## Releasing (maintainer)

```sh
npm version patch    # or minor / major — bumps version in package.json and tags
git push --follow-tags
```

Pushing a `v*` tag triggers the GitHub Actions workflow, which builds Mac + Windows installers in parallel and attaches them to a GitHub Release.

## Tech

Electron + TypeScript + esbuild + ffmpeg-static + `@huggingface/transformers` (bundled all-MiniLM-L6-v2). About 250 MB installed.

## Acknowledgements

- [`bcomnes/yoto-nodejs-client`](https://github.com/bcomnes/yoto-nodejs-client) — reference for the Yoto API surface and shapes.
- [`TheBestMoshe/yoto-cli`](https://github.com/TheBestMoshe/yoto-cli) — patterns for upload + content shape; `lizozom`'s [PR #2](https://github.com/TheBestMoshe/yoto-cli/pull/2) pointed at the format-from-transcoder fix that finally made playback work.
- [Yoto Developer docs](https://yoto.dev/).
