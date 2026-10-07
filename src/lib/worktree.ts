import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeInfo {
  isWorktree: boolean;
  rootWorktreePath?: string;
}

/**
 * Normalizes a path, resolving symlinks when possible.
 */
export function normalizePath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Detects if a repository folder is a git linked worktree and determines
 * the parent root worktree's path.
 */
export function getWorktreeInfo(repoPath: string): WorktreeInfo {
  try {
    const gitPath = path.join(repoPath, '.git');
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        if (content.startsWith('gitdir:')) {
          const rawGitDir = content.slice('gitdir:'.length).trim();
          const resolvedGitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repoPath, rawGitDir);
          
          const normalizedGitDir = resolvedGitDir.replace(/\\/g, '/');
          if (normalizedGitDir.includes('/worktrees/')) {
            const commondirFile = path.join(resolvedGitDir, 'commondir');
            let commonGitDir: string;
            if (fs.existsSync(commondirFile)) {
              const commondirRel = fs.readFileSync(commondirFile, 'utf-8').trim();
              commonGitDir = path.resolve(resolvedGitDir, commondirRel);
            } else {
              commonGitDir = path.resolve(resolvedGitDir, '../..');
            }
            const rootWorktreePath = normalizePath(path.dirname(commonGitDir));
            return { isWorktree: true, rootWorktreePath };
          }
        }
      }
    }
  } catch {
    // Ignore filesystem errors
  }

  // Fallback for paths that might have been removed from disk or nested in .worktrees
  const normalized = repoPath.replace(/\\/g, '/');
  const idx = normalized.indexOf('/.worktrees/');
  if (idx !== -1) {
    const parent = repoPath.slice(0, idx);
    return {
      isWorktree: true,
      rootWorktreePath: normalizePath(parent),
    };
  }

  return { isWorktree: false };
}
