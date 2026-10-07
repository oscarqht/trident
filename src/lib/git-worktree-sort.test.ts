import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitService } from './git';
import { simpleGit } from 'simple-git';

describe('GitService worktree sorting', () => {
  it('should pin current worktree first and sort others DESC by last modify/commit time', async () => {
    const rawTestDir = await mkdtemp(join(tmpdir(), 'trident-test-worktree-sort-'));
    const testDir = realpathSync(rawTestDir);

    try {
      const mainRepoPath = join(testDir, 'main-repo');
      const worktreeOlderPath = join(testDir, 'wt-older');
      const worktreeNewerPath = join(testDir, 'wt-newer');

      // 1. Initialize main repo
      const repoGit = simpleGit();
      await repoGit.init(['-b', 'main', mainRepoPath]);

      const mainGit = simpleGit(mainRepoPath);
      await mainGit.addConfig('user.name', 'Trident Test');
      await mainGit.addConfig('user.email', 'test@example.com');
      await mainGit.addConfig('commit.gpgsign', 'false');

      // Base commit
      await writeFile(join(mainRepoPath, 'main.txt'), 'initial\n');
      await mainGit.add('main.txt');
      await mainGit.commit('initial commit', { '--date': '2026-01-01T10:00:00Z' });

      // Create branch-older with commit in Jan 2026
      await mainGit.checkoutLocalBranch('branch-older');
      await writeFile(join(mainRepoPath, 'older.txt'), 'older\n');
      await mainGit.add('older.txt');
      await mainGit.commit('older commit', { '--date': '2026-01-02T10:00:00Z' });

      // Create branch-newer with commit in Feb 2026
      await mainGit.checkout('main');
      await mainGit.checkoutLocalBranch('branch-newer');
      await writeFile(join(mainRepoPath, 'newer.txt'), 'newer\n');
      await mainGit.add('newer.txt');
      await mainGit.commit('newer commit', { '--date': '2026-02-01T10:00:00Z' });

      // Switch mainRepo back to main
      await mainGit.checkout('main');

      // Add linked worktrees
      await mainGit.raw(['worktree', 'add', worktreeOlderPath, 'branch-older']);
      await mainGit.raw(['worktree', 'add', worktreeNewerPath, 'branch-newer']);

      // Ensure directory mtimes don't inadvertently mask commit time order
      const pastDate = new Date('2026-01-01T00:00:00Z');
      await utimes(worktreeOlderPath, pastDate, pastDate);
      await utimes(worktreeNewerPath, pastDate, pastDate);

      const gitService = new GitService(mainRepoPath);
      const worktrees = await gitService.getWorktrees('main');

      assert.strictEqual(worktrees.length, 3);
      // Index 0 must be current worktree
      assert.strictEqual(worktrees[0].isCurrent, true);
      assert.strictEqual(worktrees[0].branch, 'main');

      // Index 1 should be wt-newer (Feb 2026 commit > Jan 2026 commit)
      assert.strictEqual(worktrees[1].path, worktreeNewerPath);
      assert.strictEqual(worktrees[1].branch, 'branch-newer');
      assert.ok(worktrees[1].lastModified !== undefined);

      // Index 2 should be wt-older
      assert.strictEqual(worktrees[2].path, worktreeOlderPath);
      assert.strictEqual(worktrees[2].branch, 'branch-older');
      assert.ok(worktrees[2].lastModified !== undefined);
      assert.ok(worktrees[1].lastModified! >= worktrees[2].lastModified!);

      // Now update filesystem modification time in wt-older to be much newer than wt-newer
      const futureDate = new Date(Date.now() + 100000);
      await utimes(worktreeOlderPath, futureDate, futureDate);

      const updatedWorktrees = await gitService.getWorktrees('main');
      assert.strictEqual(updatedWorktrees[0].isCurrent, true);
      // Now wt-older should have moved before wt-newer due to newer filesystem modification
      assert.strictEqual(updatedWorktrees[1].path, worktreeOlderPath);
      assert.strictEqual(updatedWorktrees[2].path, worktreeNewerPath);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
