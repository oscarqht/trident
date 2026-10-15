import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Finder icon/text sizes are not exposed by Tauri's DMG configuration.
// Apply the layout before release notarization, then restore the DMG signature.
export function styleDmg(dmg) {
  if (process.platform !== 'darwin') throw new Error('DMG styling requires macOS');
  dmg = path.resolve(dmg);
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const layout = config.bundle.macOS.dmg;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-dmg-'));
  const mount = path.join(temporary, 'volume');
  const writable = path.join(temporary, 'writable.dmg');
  const output = path.join(temporary, 'styled.dmg');
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });
  const signature = spawnSync('codesign', ['--display', '--verbose=2', dmg], { encoding: 'utf8' });
  const identity = signature.stderr?.match(/^Authority=(.+)$/m)?.[1];
  let attached = false;
  try {
    run('hdiutil', ['convert', dmg, '-format', 'UDRW', '-o', writable]);
    const plist = run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, '-plist', writable]);
    attached = true;
    const plistFile = path.join(temporary, 'mount.plist');
    fs.writeFileSync(plistFile, plist);
    const entities = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plistFile]))['system-entities'];
    const device = entities.find(entity => entity['mount-point'])['dev-entry'];
    const infoFile = path.join(temporary, 'volume.plist');
    fs.writeFileSync(infoFile, run('diskutil', ['info', '-plist', device]));
    const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', infoFile]));
    const volumeName = info.VolumeName;
    // Finder resolves volumes by name, so avoid editing another mounted installer.
    run('diskutil', ['renameVolume', device, path.basename(temporary)]);
    const script = path.join(temporary, 'layout.applescript');
    fs.writeFileSync(script, `on run argv
  tell application "Finder"
    set targetFolder to POSIX file (item 1 of argv) as alias
    open targetFolder
    if (target of front window as alias) is not targetFolder then error "Finder opened an unexpected volume"
    tell front window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set bounds to {100, 100, ${100 + layout.windowSize.width}, ${100 + layout.windowSize.height}}
    end tell
    set opts to icon view options of front window
    set icon size of opts to 64
    set text size of opts to 12
    set position of item "Trident.app" of targetFolder to {${layout.appPosition.x}, ${layout.appPosition.y}}
    set position of item "Applications" of targetFolder to {${layout.applicationFolderPosition.x}, ${layout.applicationFolderPosition.y}}
    set extension hidden of item "Trident.app" of targetFolder to true
    -- Hidden assets must remain inside the canvas to avoid Finder overflow.
    repeat with hiddenName in {".background", ".VolumeIcon.icns"}
      if exists item (contents of hiddenName) of targetFolder then set position of item (contents of hiddenName) of targetFolder to {100, 100}
    end repeat
    repeat with hiddenName in {".background", ".VolumeIcon.icns"}
      if exists item (contents of hiddenName) of targetFolder then
        set savedPosition to position of item (contents of hiddenName) of targetFolder
        if savedPosition is not {100, 100} then error "Hidden installer asset position was not applied"
      end if
    end repeat
    update targetFolder without registering applications
    close front window
    delay 2
  end tell
end run
`);
    run('osascript', [script, mount, path.basename(temporary)]);
    run('diskutil', ['renameVolume', device, volumeName]);
    run('hdiutil', ['detach', mount]);
    attached = false;
    run('hdiutil', ['convert', writable, '-format', 'UDZO', '-o', output]);
    if (identity) {
      run('codesign', ['--force', '--sign', identity, '--timestamp', output]);
      run('codesign', ['--verify', '--strict', output]);
    }
    fs.copyFileSync(output, dmg);
    console.log(`Styled installer: ${dmg}`);
  } finally {
    if (attached) spawnSync('hdiutil', ['detach', mount]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/style-dmg.mjs <installer.dmg>');
  styleDmg(process.argv[2]);
}
