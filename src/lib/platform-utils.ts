import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

// Get cross-platform app data directory
export function getAppDataDir(): string {
  const platform = process.platform;
  const homeDir = os.homedir();

  if (platform === 'win32') {
    // Windows: %APPDATA%\trident
    return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'trident');
  } else if (platform === 'darwin') {
    // macOS: ~/Library/Application Support/trident
    return path.join(homeDir, 'Library', 'Application Support', 'trident');
  } else {
    // Linux/others: ~/.config/trident
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'trident');
  }
}

/**
 * Returns an augmented PATH string containing user-installed tool directories
 * (e.g. bun, cargo, nvm, pnpm, deno, homebrew) even when the app is launched
 * from a GUI environment without an inherited terminal PATH.
 */
export function getAugmentedPath(): string {
  const isWindows = process.platform === 'win32';
  const delimiter = path.delimiter;
  const homeDir = os.homedir();
  const candidateDirs: string[] = [];

  if (!isWindows) {
    // 1. Try querying user's login shell PATH (fast and reflects user's actual terminal config)
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const shellPath = execSync(`${shell} -l -c 'echo -n "$PATH"'`, {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (shellPath) {
        for (const p of shellPath.split(':')) {
          if (p) candidateDirs.push(p);
        }
      }
    } catch {
      // Shell resolution failed or timed out; fallback to standard locations
    }

    // 2. Add well-known tool directories in user's home directory
    candidateDirs.push(
      path.join(homeDir, '.bun', 'bin'),
      path.join(homeDir, '.cargo', 'bin'),
      path.join(homeDir, '.local', 'bin'),
      path.join(homeDir, 'Library', 'pnpm'),
      path.join(homeDir, '.pnpm'),
      path.join(homeDir, '.deno', 'bin'),
      path.join(homeDir, '.config', 'yarn', 'global', 'node_modules', '.bin'),
      path.join(homeDir, '.yarn', 'bin'),
      path.join(homeDir, '.fnm', 'current', 'bin'),
      path.join(homeDir, '.volta', 'bin'),
      path.join(homeDir, '.asdf', 'shims'),
      path.join(homeDir, '.asdf', 'bin')
    );

    // Check NVM node versions (~/.nvm/versions/node/*)
    const nvmVersionsDir = path.join(homeDir, '.nvm', 'versions', 'node');
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir);
        versions.sort();
        for (let i = versions.length - 1; i >= 0; i--) {
          candidateDirs.push(path.join(nvmVersionsDir, versions[i], 'bin'));
        }
      }
    } catch {}

    // 3. Add standard Unix/macOS binary directories
    candidateDirs.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    );
  } else {
    // Windows candidate directories
    candidateDirs.push(
      path.join(homeDir, '.bun', 'bin'),
      path.join(homeDir, '.cargo', 'bin'),
      path.join(homeDir, 'AppData', 'Local', 'pnpm'),
      path.join(homeDir, 'AppData', 'Roaming', 'npm'),
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
      'C:\\Program Files\\nodejs'
    );
  }

  // 4. Also add any existing PATH entries from process.env
  const existingPath = process.env.PATH || '';
  if (existingPath) {
    for (const p of existingPath.split(delimiter)) {
      if (p) candidateDirs.push(p);
    }
  }

  // 5. Deduplicate and filter to existing directories where feasible
  const seen = new Set<string>();
  const finalDirs: string[] = [];

  for (const dir of candidateDirs) {
    if (!dir) continue;
    const normalized = path.normalize(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // Keep if directory exists on disk, or if it was already in process.env.PATH
    try {
      if (fs.existsSync(dir)) {
        finalDirs.push(dir);
      }
    } catch {
      // In case of permission errors, keep directory
      finalDirs.push(dir);
    }
  }

  return finalDirs.length > 0 ? finalDirs.join(delimiter) : existingPath;
}

/**
 * Returns a cloned process.env augmented with a comprehensive PATH and
 * tool-specific environment variables (e.g. BUN_INSTALL, PNPM_HOME).
 */
export function getAugmentedEnv(): NodeJS.ProcessEnv {
  const homeDir = os.homedir();
  const augmentedPath = getAugmentedPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath,
  };

  if (!env.BUN_INSTALL) {
    const bunDir = path.join(homeDir, '.bun');
    if (fs.existsSync(bunDir)) {
      env.BUN_INSTALL = bunDir;
    }
  }

  if (!env.PNPM_HOME) {
    const pnpmDarwin = path.join(homeDir, 'Library', 'pnpm');
    const pnpmGeneral = path.join(homeDir, '.pnpm');
    if (fs.existsSync(pnpmDarwin)) {
      env.PNPM_HOME = pnpmDarwin;
    } else if (fs.existsSync(pnpmGeneral)) {
      env.PNPM_HOME = pnpmGeneral;
    }
  }

  return env;
}

/**
 * Ensures current process.env.PATH is augmented with tool directories.
 */
export function ensureAugmentedProcessPath(): void {
  const augmented = getAugmentedPath();
  process.env.PATH = augmented;
  const homeDir = os.homedir();
  if (!process.env.BUN_INSTALL) {
    const bunDir = path.join(homeDir, '.bun');
    if (fs.existsSync(bunDir)) {
      process.env.BUN_INSTALL = bunDir;
    }
  }
  if (!process.env.PNPM_HOME) {
    const pnpmDarwin = path.join(homeDir, 'Library', 'pnpm');
    const pnpmGeneral = path.join(homeDir, '.pnpm');
    if (fs.existsSync(pnpmDarwin)) {
      process.env.PNPM_HOME = pnpmDarwin;
    } else if (fs.existsSync(pnpmGeneral)) {
      process.env.PNPM_HOME = pnpmGeneral;
    }
  }
}

// Automatically ensure augmented path on module load
try {
  ensureAugmentedProcessPath();
} catch {}
