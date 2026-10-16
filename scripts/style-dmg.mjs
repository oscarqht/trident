import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { updateSigningKeychainSearchList } from './macos-release.mjs';

const SET_FILE_ICON_SWIFT = [
  'import AppKit',
  'let iconPath = CommandLine.arguments[1]',
  'let targetPath = CommandLine.arguments[2]',
  'guard let image = NSImage(contentsOfFile: iconPath) else { fputs("Failed to load icon: \\(iconPath)\\n", stderr); exit(1) }',
  'if !NSWorkspace.shared.setIcon(image, forFile: targetPath, options: []) { fputs("Failed to set file icon on: \\(targetPath)\\n", stderr); exit(1) }',
].join('\n');

export function resolveDmgIcon(config, root = 'src-tauri') {
  const icon = config.bundle?.icon?.find(entry => entry.endsWith('.icns'));
  if (!icon) throw new Error('Expected a .icns bundle icon in src-tauri/tauri.conf.json');
  return path.resolve(root, icon);
}

export function applyVolumeIcon(mount, icon, execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' })) {
  const volumeIcon = path.join(mount, '.VolumeIcon.icns');
  fs.copyFileSync(icon, volumeIcon);
  execute('SetFile', ['-c', 'icnC', volumeIcon]);
  execute('SetFile', ['-a', 'C', mount]);
}

export function applyDmgFileIcon(dmg, icon, execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' })) {
  execute('swift', ['-e', SET_FILE_ICON_SWIFT, icon, dmg]);
}

// Finder file icons are external xattrs; HTTP downloads only preserve data bytes.
// Package after final signing/stapling and asset renaming so Archive Utility can
// restore those attributes from the ZIP's __MACOSX AppleDouble entry.
export function packageDmgDownload(dmg, icon) {
  if (process.platform !== 'darwin') throw new Error('DMG download packaging requires macOS');
  applyDmgFileIcon(dmg, icon);
  const archive = `${dmg}.zip`;
  fs.rmSync(archive, { force: true });
  execFileSync('ditto', ['-c', '-k', '--rsrc', '--extattr', '--sequesterRsrc', dmg, archive]);
  return archive;
}

export function signStyledDmg(dmg, identity, env = process.env, execute = (command, args) => execFileSync(command, args, { encoding: 'utf8' })) {
  const keychain = env.TRIDENT_SIGNING_KEYCHAIN;
  // Tauri can replace the search list during packaging. Restore this job's
  // keychain, as Raft does, before re-signing the styled installer.
  if (keychain) updateSigningKeychainSearchList(keychain, true, execute);
  execute('codesign', ['--force', '--sign', identity, '--timestamp', ...(keychain ? ['--keychain', keychain] : []), dmg]);
  execute('codesign', ['--verify', '--strict', dmg]);
}

// Finder icon/text sizes are not exposed by Tauri's DMG configuration.
// Apply the layout before release notarization, then restore the DMG signature.
function writeLayout(mount, layout, temporary) {
  const library = path.join(temporary, 'pylib');
  execFileSync('python3', ['-m', 'pip', 'install', '--quiet', '--target', library, 'ds_store', 'mac_alias'], { stdio: 'inherit' });
  const items = {
    'Trident.app': [layout.appPosition.x, layout.appPosition.y],
    Applications: [layout.applicationFolderPosition.x, layout.applicationFolderPosition.y],
    '.background': [100, 100],
    '.VolumeIcon.icns': [100, 100],
  };
  const spec = JSON.stringify({ window: [layout.windowSize.width, layout.windowSize.height], iconSize: 96, textSize: 12, items });
  execFileSync('python3', [path.join(import.meta.dirname, 'write-dmg-layout.py'), mount, spec], {
    env: { ...process.env, PYTHONPATH: library },
    stdio: 'inherit',
  });
}

export function styleDmg(dmg) {
  if (process.platform !== 'darwin') throw new Error('DMG styling requires macOS');
  dmg = path.resolve(dmg);
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const layout = config.bundle.macOS.dmg;
  const icon = resolveDmgIcon(config);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-dmg-'));
  const writable = path.join(temporary, 'writable.dmg');
  const output = path.join(temporary, 'styled.dmg');
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' });
  const signature = spawnSync('codesign', ['--display', '--verbose=2', dmg], { encoding: 'utf8' });
  const identity = signature.stderr?.match(/^Authority=(.+)$/m)?.[1];
  // CI runners have no Finder session, so write the .DS_Store directly there.
  const headless = process.env.DMG_STYLE_MODE ? process.env.DMG_STYLE_MODE === 'ds-store' : Boolean(process.env.CI);
  // The background alias records the mount path's name, so headless mounts must use the real volume name.
  const mount = path.join(temporary, headless ? config.productName : 'volume');
  if (headless) fs.mkdirSync(mount);
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
    fs.copyFileSync(icon, path.join(mount, '.VolumeIcon.icns'));
    if (headless) {
      writeLayout(mount, layout, temporary);
    } else {
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
      set icon size of opts to 96
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
    }
    applyVolumeIcon(mount, icon, run);
    run('hdiutil', ['detach', mount]);
    attached = false;
    run('hdiutil', ['convert', writable, '-format', 'UDZO', '-o', output]);
    applyDmgFileIcon(output, icon, run);
    if (identity) {
      signStyledDmg(output, identity, process.env, run);
    }
    run('ditto', ['--rsrc', '--extattr', output, dmg]);
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

