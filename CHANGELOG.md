# Changelog

## Unreleased

- Show a clear insertion line between tracks while dragging to reorder a playlist.
- Fixed track reordering for playlists with duplicate or missing chapter keys, and prevented new key collisions when adding tracks.
- Added a VS Code workspace and launch configuration for running the app locally.
- Updated the development and release environment to the latest stable Node.js 24 release.
- Renamed and harmonized the app identity as Desktop for Yoto; the title-bar name is now uppercase.
- Moved navigation into the title bar, added the player icon/identity pill, and ordered the menu as Playlists, Print card covers, Settings.
- Reworked Print card covers into a full application page with improved layout and selection controls.
- Replaced Dutch user-facing copy with English and added the English authentication success message.
- Added Lucide interface icons, contrast guidance, and hover states for interactive controls.
- Refined playlist controls: aligned action toolbar, compact NEW button, better title editing, Yoto-red delete actions, and card-cover tools.
- Added ID3 title reading with a preview; existing playlists use a file-selection modal with Save/Cancel controls and match files to current titles by filename.
- Added drag-and-drop track transfer between owned playlists.
- Added a Help page with device-sync FAQ guidance.
- Added a development launch flag for testing onboarding without changing the stored Yoto session.
- Reworked the signed-out screen into a centered onboarding card.
