
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Repository, AppSettings } from './types';
import { getAppDataDir } from './platform-utils';

// Store the list of known repositories in a shared app data directory.
// This allows all instances of the app to share the same repository list.
const DATA_DIR = getAppDataDir();
const DATA_FILE = path.join(DATA_DIR, 'repos.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function getRepositories(): Repository[] {
  if (!fs.existsSync(DATA_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to parse repos.json', error);
    return [];
  }
}

function normalizeDisplayName(displayName?: string | null): string | null | undefined {
  if (displayName === undefined) return undefined;
  if (displayName === null) return null;
  const normalized = displayName.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeIcon(icon?: string | null): string | null | undefined {
  if (icon === undefined) return undefined;
  if (icon === null) return null;
  const normalized = icon.trim();
  return normalized.length > 0 ? normalized : null;
}

export function addRepository(repoPath: string, name?: string, displayName?: string | null): Repository {
  const repos = getRepositories();
  // Check if exists
  if (repos.find(r => r.path === repoPath)) {
    throw new Error('Repository already exists');
  }

  const normalizedDisplayName = normalizeDisplayName(displayName);
  const newRepo: Repository = {
    path: repoPath,
    name: name || path.basename(repoPath),
    ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
  };

  repos.push(newRepo);
  fs.writeFileSync(DATA_FILE, JSON.stringify(repos, null, 2));
  return newRepo;
}

export function updateRepository(repoPath: string, updates: Partial<Repository>): Repository {
  const repos = getRepositories();
  const repoIndex = repos.findIndex(r => r.path === repoPath);
  
  if (repoIndex === -1) {
    throw new Error('Repository not found');
  }

  const normalizedUpdates: Partial<Repository> = { ...updates };
  if ('displayName' in normalizedUpdates) {
    normalizedUpdates.displayName = normalizeDisplayName(normalizedUpdates.displayName);
  }
  if ('icon' in normalizedUpdates) {
    normalizedUpdates.icon = normalizeIcon(normalizedUpdates.icon);
  }

  const updatedRepo = { ...repos[repoIndex], ...normalizedUpdates };
  repos[repoIndex] = updatedRepo;
  
  fs.writeFileSync(DATA_FILE, JSON.stringify(repos, null, 2));
  return updatedRepo;
}

export function removeRepository(repoPath: string, options?: { deleteLocalFolder?: boolean }): void {
  const { deleteLocalFolder = false } = options || {};

  if (deleteLocalFolder) {
    const resolvedRepoPath = path.resolve(repoPath);
    const rootPath = path.parse(resolvedRepoPath).root;
    if (resolvedRepoPath === rootPath) {
      throw new Error('Refusing to delete a filesystem root path');
    }
    fs.rmSync(resolvedRepoPath, { recursive: true, force: true });
  }

  let repos = getRepositories();
  repos = repos.filter(r => r.path !== repoPath);
  fs.writeFileSync(DATA_FILE, JSON.stringify(repos, null, 2));
}

// Settings management
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export function getSettings(): AppSettings {
  const defaults: AppSettings = {
    defaultRootFolder: null, // null means use user's home directory
    sidebarCollapsed: false,
  };

  if (!fs.existsSync(SETTINGS_FILE)) {
    return defaults;
  }

  try {
    const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const saved = JSON.parse(data);
    return { ...defaults, ...saved };
  } catch (error) {
    console.error('Failed to parse settings.json', error);
    return defaults;
  }
}

export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
  return updated;
}

export function getDefaultRootFolder(): string {
  const settings = getSettings();
  
  // If a default folder is set, check if it still exists
  if (settings.defaultRootFolder) {
    try {
      if (fs.existsSync(settings.defaultRootFolder) && fs.statSync(settings.defaultRootFolder).isDirectory()) {
        return settings.defaultRootFolder;
      }
    } catch {
      // Folder doesn't exist or can't be accessed, fall back to home
    }
  }
  
  // Fall back to user's home directory
  return os.homedir();
}
