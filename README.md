# Desktop for Yoto

A desktop app for **macOS** and **Windows** that turns folders of audio into Yoto MYO playlists. Drag-and-drop to upload, AI-picked pixel-art icons, drag-to-reorder, full edit-in-place, plus a built-in card-art and print-sticker generator for the physical MYO card. No subscription, no account beyond your existing Yoto login.

> This is a personal fork of Samuel Millett's original [desktop-for-yoto](https://github.com/sjaym88/desktop-for-yoto) — see [Acknowledgements](#acknowledgements) below.

## Download

Grab the latest installer for your machine from the [Releases page](https://github.com/bvlet/Yotodesktop/releases/latest):

- **Mac (Apple Silicon)** — `Desktop-for-Yoto-*-arm64.dmg`
- **Mac (Intel)** — `Desktop-for-Yoto-*-x64.dmg`
- **Windows** — `Desktop for Yoto Setup *.exe`

## First-run instructions (unsigned app)

The app is not code-signed (see [why](#why-isnt-it-signed) below), so the first launch shows a warning. One-time:

**Mac:** open the DMG, drag the app to Applications. Then in Finder, **right-click** the app → **Open** → click **Open** in the dialog. After that, double-click works normally.

**Windows:** run the installer. Windows SmartScreen may say "Windows protected your PC" — click **More info** → **Run anyway**. This is expected: the app isn't code-signed (see below).

## Quickstart

1. Open the app, sign in to your Yoto account in the browser window that pops up.
2. Drag a folder of audio anywhere onto the window. Any format works (mp3, flac, wav, m4a, opus, ogg…) — the app converts to mp3 locally and uploads to Yoto.
3. Click **Auto-choose icons** to AI-match each track to a pixel-art icon from Yoto's library.
4. Click **Publish to Yoto**. The playlist appears in your Yoto account.
5. Open the official Yoto app on your phone to **link** the new playlist to a physical MYO card. (The desktop app cannot link cards — that step requires the Yoto mobile app and physical NFC.)
6. Optional: use **card art** to design and print a cover for the physical card itself — see below.

## Card art & printable stickers

Two extras for the physical card, on top of the Yoto playlist itself:

- **Card art** — generates a credit-card-sized cover image with the playlist title baked on. Search for real cover art via Apple Music/Podcasts/Books or Google Books, or — when there's nothing to find (e.g. a homemade mixtape/compilation) — fall back to a generated "illustrated" mixtape-style cover instead. A "don't add a title" option is available for art that already reads fine on its own.
- **Print sticker sheet** — exports an A4 PDF of these card-art covers at real MYO card size (53.98 × 85.6 mm, ISO/IEC 7810 ID-1, rounded corners), with cut guides and a ruler on the page so you can verify the print scale before cutting. Print at 100% / "actual size" — not "fit to page".

## Features

- **Drag-and-drop folders** of any audio format. Local ffmpeg transcoding handles non-mp3.
- **Up to 3 parallel uploads**, with cancel / retry per track.
- **AI semantic icon matching** (bundled offline embedding model, ~25 MB) — "Wings" finds bird/feather icons, "Grow" finds plant/seedling, etc.
- **Drag-to-reorder** tracks; inline rename for playlists and tracks.
- **Cover art upload** (any image, auto-resized).
- **Card art generator** — creditcard-format cover art with title, sourced from Apple/Google Books or generated in a mixtape/illustrated style.
- **Print-ready sticker sheets** — A4 PDF export of card art at real card size, with cut guides.
- **Add tracks to existing playlists** by dropping audio while viewing them.
- **Fix on player** button — re-publishes a playlist with the correct chapter shape (use if a playlist won't play and just shows the cloud icon).

## Known limitations

- Linking a playlist to a physical MYO card still requires the official Yoto mobile app — there's no NFC API for desktops.
- Player audio sync to the device can take several minutes after publish; per Yoto's own troubleshooting, the player must be plugged in, idle, and no Yoto app open on a phone for it to refresh.

## Why isn't it signed?

Apple Developer ($99/yr) + Windows EV cert ($200–500/yr) cost more per year than the project warrants. The right-click → Open / SmartScreen → Run anyway dance is the price of free.

## Building from source

```sh
git clone https://github.com/bvlet/Yotodesktop.git
cd Yotodesktop
npm install
npm run dev
```

To build installers locally: `npm run dist -- --mac` (or `--win`). For Windows on a Mac you'll need `brew install --cask --no-quarantine wine-stable`. Installer output lands in `release/` (the plain esbuild output stays in `dist/`).

On Windows, if `npm run dist` fails while extracting `winCodeSign` with a "required privilege is not held by the client" error, either run the terminal as Administrator once, or turn on Developer Mode (Settings → System → For developers) so your account is allowed to create the symlinks electron-builder needs — then retry.

## Releasing (maintainer)

```sh
npm version patch    # or minor / major — bumps version in package.json and tags
git push --follow-tags
```

Pushing a `v*` tag triggers the GitHub Actions workflow, which builds Mac + Windows installers in parallel and attaches them to a GitHub Release.

## Tech

Electron + TypeScript + esbuild + ffmpeg-static + `@huggingface/transformers` (bundled all-MiniLM-L6-v2) + `pdf-lib` (sticker sheet PDF generation). About 250 MB installed.

## Acknowledgements

- This project started as a fork of [Samuel Millett](https://github.com/sjaym88)'s [`sjaym88/desktop-for-yoto`](https://github.com/sjaym88/desktop-for-yoto) — thank you for the original app this builds on.
- [`bcomnes/yoto-nodejs-client`](https://github.com/bcomnes/yoto-nodejs-client) — reference for the Yoto API surface and shapes.
- [`TheBestMoshe/yoto-cli`](https://github.com/TheBestMoshe/yoto-cli) — patterns for upload + content shape; `lizozom`'s [PR #2](https://github.com/TheBestMoshe/yoto-cli/pull/2) pointed at the format-from-transcoder fix that finally made playback work.
- [Openverse](https://openverse.org) — free openly-licensed image search used as a card-art fallback source.
- [Yoto Developer docs](https://yoto.dev/).
