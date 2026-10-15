# macOS installer artwork

`background.png` is the supplied 800 × 450 installer background, resized from the supplied 1672 × 941 artwork.

The layout lives in `bundle.macOS.dmg` in `../tauri.conf.json`. Trident sits on the right square; the Applications shortcut sits on the left square. The icons sit slightly above the square centers so their labels fit underneath. `scripts/style-dmg.mjs` sets Finder's icon size to 64 px and label size to 12 px after Tauri packaging. `scripts/tauri.mjs` runs this for local builds and both release pipelines before notarization; a Developer ID signed DMG is re-signed after styling. Run `npm run tauri -- bundle --bundles dmg` to package an existing build through this step. Finder keeps live icons and labels upright.

The 800 × 482 window includes Finder's 32 px title bar, leaving 800 × 450 for the artwork. Keep the window size and icon coordinates in sync when replacing the background.

## Finder preview

The styling step also places hidden installer assets at (100, 100), near the top-left corner inside the canvas, and verifies their positions, preventing them from expanding Finder's scrollable area. Preview with Finder's **Show Hidden Files** disabled (toggle with Command-Shift-period) so these supporting files stay hidden.

## Styling on CI

CI runners have no Finder session, so when `CI` is set `scripts/style-dmg.mjs` skips AppleScript and writes the volume's `.DS_Store` directly with `scripts/write-dmg-layout.py` (needs `python3` with pip; it installs `ds_store` and `mac_alias` into a temporary directory). Set `DMG_STYLE_MODE=ds-store` or `finder` to force either path locally. If styling still fails in CI, `scripts/tauri.mjs` warns and ships the unstyled DMG.
