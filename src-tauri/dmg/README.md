# macOS installer artwork

`background.png` is the supplied 660 × 400 installer background (the supplied artwork is 1320 × 800, i.e. @2x).

The layout lives in `bundle.macOS.dmg` in `../tauri.conf.json`. The Applications shortcut sits at (315, 97) and Trident at (259, 258), following the artwork's `create-dmg` spec. `scripts/style-dmg.mjs` sets Finder's icon size to 96 px and label size to 12 px after Tauri packaging. `scripts/tauri.mjs` runs this for local builds and both release pipelines before notarization; a Developer ID signed DMG is re-signed after styling. Run `npm run tauri -- bundle --bundles dmg` to package an existing build through this step. Finder keeps live icons and labels upright.

The 660 × 432 window includes Finder's 32 px title bar, leaving 660 × 400 for the artwork. Keep the window size and icon coordinates in sync when replacing the background.

## Finder preview

The styling step also places hidden installer assets at (100, 100), near the top-left corner inside the canvas, and verifies their positions, preventing them from expanding Finder's scrollable area. Preview with Finder's **Show Hidden Files** disabled (toggle with Command-Shift-period) so these supporting files stay hidden.

## Styling on CI

CI runners have no Finder session, so when `CI` is set `scripts/style-dmg.mjs` skips AppleScript and writes the volume's `.DS_Store` directly with `scripts/write-dmg-layout.py` (needs `python3` with pip; it installs `ds_store` and `mac_alias` into a temporary directory), stamps `.VolumeIcon.icns` and the volume custom-icon flag via `SetFile`, and sets the custom project icon on the `.dmg` file itself before signing. The background path is canonicalized before alias creation so macOS's `/var` and `/private/var` paths produce a volume-relative reference that survives remounting. Set `DMG_STYLE_MODE=ds-store` or `finder` to force either path locally. Styling failures stop the build, including on CI.

Run `python3 scripts/write-dmg-layout.test.py` on macOS with `ds_store` and `mac_alias` installed to test alias creation through a symlinked mount and inspect the layout after remounting the image.
