import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export function checkFullDiskAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const safariPath = path.join(os.homedir(), 'Library', 'Safari');
    fs.readdirSync(safariPath);
    return true;
  } catch {
    try {
      fs.readdirSync('/Library/Application Support/com.apple.TCC');
      return true;
    } catch {
      return false;
    }
  }
}

export async function openFullDiskAccessSettings(): Promise<void> {
  if (process.platform === 'darwin') {
    await execAsync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"').catch(() => {});
    if (fs.existsSync('/Applications/Trident.app')) {
      await execAsync('open -R /Applications/Trident.app').catch(() => {});
    }
  }
}

const LAUNCH_AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(LAUNCH_AGENT_DIR, 'Trident.plist');
const LEGACY_PLIST_PATH = path.join(LAUNCH_AGENT_DIR, 'com.oscarqht.trident.plist');

export function isAutostartEnabled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync(PLIST_PATH) || fs.existsSync(LEGACY_PLIST_PATH);
  }
  if (process.platform === 'linux') {
    return fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'trident.desktop'));
  }
  return false;
}

export async function toggleAutostart(): Promise<boolean> {
  const current = isAutostartEnabled();
  const next = !current;

  if (process.platform === 'darwin') {
    if (next) {
      if (!fs.existsSync(LAUNCH_AGENT_DIR)) {
        fs.mkdirSync(LAUNCH_AGENT_DIR, { recursive: true });
      }
      let execPath = '/Applications/Trident.app/Contents/MacOS/trident';
      if (!fs.existsSync(execPath)) {
        execPath = process.execPath;
      }
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
  <key>Label</key>
  <string>Trident</string>
  <key>ProgramArguments</key>
  <array><string>${execPath}</string></array>
  <key>RunAtLoad</key>
  <true/>
  </dict>
</plist>
`;
      fs.writeFileSync(PLIST_PATH, plistContent, 'utf-8');
    } else {
      if (fs.existsSync(PLIST_PATH)) {
        try { fs.unlinkSync(PLIST_PATH); } catch {}
      }
      if (fs.existsSync(LEGACY_PLIST_PATH)) {
        try { fs.unlinkSync(LEGACY_PLIST_PATH); } catch {}
      }
    }
    return next;
  }

  if (process.platform === 'linux') {
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    const desktopFilePath = path.join(autostartDir, 'trident.desktop');
    if (next) {
      if (!fs.existsSync(autostartDir)) {
        fs.mkdirSync(autostartDir, { recursive: true });
      }
      const desktopFileContent = `[Desktop Entry]
Type=Application
Name=Trident
Exec=${process.execPath}
Terminal=false
`;
      fs.writeFileSync(desktopFilePath, desktopFileContent, 'utf-8');
    } else {
      if (fs.existsSync(desktopFilePath)) {
        try { fs.unlinkSync(desktopFilePath); } catch {}
      }
    }
    return next;
  }

  return false;
}

export function getDesktopStatus() {
  return {
    platform: process.platform,
    fullDiskAccessGranted: checkFullDiskAccess(),
    autostartEnabled: isAutostartEnabled(),
  };
}
