
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Repository, AppSettings, RepositoryCustomScript } from './types';
import { getAppDataDir } from './platform-utils';
import { assertRepoNameAvailable, migrateRepoNames, repoNamesEqual, slugifyRepoName, uniqueRepoName } from './repo-name';
import { getWorktreeInfo, normalizePath } from './worktree';

// Store the list of known repositories in a shared app data directory.
// This allows all instances of the app to share the same repository list.
const DATA_DIR = getAppDataDir();
const DATA_FILE = path.join(DATA_DIR, 'repos.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function migrateWorktreeMetadata(repos: Repository[]): boolean {
  let changed = false;
  for (const repo of repos) {
    if (repo.isWorktree === undefined) {
      const info = getWorktreeInfo(repo.path);
      if (info.isWorktree) {
        repo.isWorktree = true;
        if (info.rootWorktreePath) {
          repo.rootWorktreePath = info.rootWorktreePath;
        }
        changed = true;
      } else {
        repo.isWorktree = false;
        changed = true;
      }
    }
  }
  return changed;
}

function syncWorktreeScripts(repos: Repository[]): boolean {
  let changed = false;
  const repoByNormalizedPath = new Map<string, Repository>();
  for (const r of repos) {
    repoByNormalizedPath.set(normalizePath(r.path), r);
  }

  for (const repo of repos) {
    if (repo.isWorktree && repo.rootWorktreePath) {
      const rootRepo = repoByNormalizedPath.get(normalizePath(repo.rootWorktreePath));
      if (rootRepo && rootRepo.customScripts) {
        const rootScriptsJson = JSON.stringify(rootRepo.customScripts);
        const currScriptsJson = JSON.stringify(repo.customScripts || []);
        if (rootScriptsJson !== currScriptsJson) {
          repo.customScripts = JSON.parse(rootScriptsJson);
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function getRepositories(): Repository[] {
  if (!fs.existsSync(DATA_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    const repos: Repository[] = JSON.parse(data);
    let changed = false;

    // Names double as URL slugs: make legacy names valid and unique once.
    const migrated = migrateRepoNames(repos);
    if (migrated) {
      changed = true;
    }

    if (migrateWorktreeMetadata(repos)) {
      changed = true;
    }

    if (syncWorktreeScripts(repos)) {
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(repos, null, 2));
    }
    return repos;
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

export function findRepositoryByName(name: string): Repository | undefined {
  return getRepositories().find((r) => repoNamesEqual(r.name, name));
}

/**
 * Register a repository. An explicit `name` must be valid and unique (throws RepoNameError);
 * otherwise one is derived from the folder name and suffixed on collision.
 */
export function addRepository(repoPath: string, name?: string, displayName?: string | null): Repository {
  const repos = getRepositories();
  // Check if exists
  if (repos.find(r => r.path === repoPath)) {
    throw new Error('Repository already exists');
  }

  const takenNames = repos.map(r => r.name);
  let repoName: string;
  if (name) {
    assertRepoNameAvailable(name, takenNames);
    repoName = name;
  } else {
    repoName = uniqueRepoName(slugifyRepoName(path.basename(repoPath)), takenNames);
  }

  const normalizedDisplayName = normalizeDisplayName(displayName);
  const worktreeInfo = getWorktreeInfo(repoPath);

  let initialCustomScripts: RepositoryCustomScript[] | undefined;
  if (worktreeInfo.isWorktree && worktreeInfo.rootWorktreePath) {
    const parentRepo = repos.find(r => normalizePath(r.path) === normalizePath(worktreeInfo.rootWorktreePath!));
    if (parentRepo?.customScripts) {
      initialCustomScripts = JSON.parse(JSON.stringify(parentRepo.customScripts));
    }
  }

  const newRepo: Repository = {
    path: repoPath,
    name: repoName,
    ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
    lastOpenedAt: new Date().toISOString(),
    isWorktree: worktreeInfo.isWorktree,
    ...(worktreeInfo.rootWorktreePath ? { rootWorktreePath: worktreeInfo.rootWorktreePath } : {}),
    ...(initialCustomScripts ? { customScripts: initialCustomScripts } : {}),
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

  const targetRepo = repos[repoIndex];

  if (targetRepo.isWorktree && updates.customScripts !== undefined) {
    throw new Error('Cannot manage custom scripts on a worktree');
  }

  const normalizedUpdates: Partial<Repository> = { ...updates };
  if (normalizedUpdates.name !== undefined) {
    assertRepoNameAvailable(
      normalizedUpdates.name,
      repos.filter((_, i) => i !== repoIndex).map(r => r.name),
    );
  }
  if ('displayName' in normalizedUpdates) {
    normalizedUpdates.displayName = normalizeDisplayName(normalizedUpdates.displayName);
  }
  if ('icon' in normalizedUpdates) {
    normalizedUpdates.icon = normalizeIcon(normalizedUpdates.icon);
  }

  const updatedRepo = { ...targetRepo, ...normalizedUpdates };
  repos[repoIndex] = updatedRepo;

  // If this is a root repository and customScripts were updated, sync them to all child worktrees
  if (!updatedRepo.isWorktree && normalizedUpdates.customScripts !== undefined) {
    const normRootPath = normalizePath(repoPath);
    for (let i = 0; i < repos.length; i++) {
      if (repos[i].isWorktree && repos[i].rootWorktreePath && normalizePath(repos[i].rootWorktreePath!) === normRootPath) {
        repos[i] = {
          ...repos[i],
          customScripts: JSON.parse(JSON.stringify(normalizedUpdates.customScripts)),
        };
      }
    }
  }
  
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
