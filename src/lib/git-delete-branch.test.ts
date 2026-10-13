import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitService } from './git';
import { simpleGit } from 'simple-git';

describe('GitService deleteBranch', () => {
  it('should successfully delete a normal local branch', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-delete-normal-'));

    try {
      const git = simpleGit(testDir);
      await git.init();
      await git.addConfig('user.name', 'Trident Test');
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('commit.gpgsign', 'false');

      await writeFile(join(testDir, 'file.txt'), 'initial\n');
      await git.add('.');
      await git.commit('initial commit');

      await git.branch(['to-delete']);

      const gitService = new GitService(testDir);
      await gitService.deleteBranch('to-delete');

      const branches = await git.branchLocal();
      assert.strictEqual(branches.all.includes('to-delete'), false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should automatically prune stale worktrees and delete branch when worktree folder was deleted', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-delete-stale-wt-'));
    const wtDir = join(testDir, 'wt-stale');

    try {
      const git = simpleGit(testDir);
      await git.init();
      await git.addConfig('user.name', 'Trident Test');
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('commit.gpgsign', 'false');

      await writeFile(join(testDir, 'file.txt'), 'initial\n');
      await git.add('.');
      await git.commit('initial commit');

      await git.branch(['stale-branch']);
      await git.raw(['worktree', 'add', wtDir, 'stale-branch']);

      // Simulate external deletion of worktree folder without git worktree remove
      await rm(wtDir, { recursive: true, force: true });

      const gitService = new GitService(testDir);
      await gitService.deleteBranch('stale-branch');

      const branches = await git.branchLocal();
      assert.strictEqual(branches.all.includes('stale-branch'), false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should automatically cleanup interrupted rebase on another branch and delete branch', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-delete-rebase-'));

    try {
      const git = simpleGit(testDir);
      await git.init();
      await git.addConfig('user.name', 'Trident Test');
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('commit.gpgsign', 'false');

      await writeFile(join(testDir, 'file.txt'), 'initial\n');
      await git.add('.');
      await git.commit('initial commit');

      // Create branch-a and commit
      await git.checkoutLocalBranch('branch-a');
      await writeFile(join(testDir, 'file.txt'), 'branch-a commit 1\n');
      await git.commit('branch-a commit 1', ['file.txt']);

      // Create main branch from initial commit and add conflicting commit
      await git.checkout(['-b', 'main-test', 'HEAD~1']);
      await writeFile(join(testDir, 'file.txt'), 'main-test conflicting commit\n');
      await git.commit('main-test conflict', ['file.txt']);

      // Switch to branch-a and attempt rebase onto main-test (conflicts)
      await git.checkout('branch-a');
      try {
        await git.rebase(['main-test']);
      } catch {
        // Expected conflict leaving rebase-merge
      }

      // User subsequently checks out main-test without finishing/aborting rebase
      await git.checkout(['-f', 'main-test']);

      // Now verify GitService cleans up stale rebase and successfully deletes branch-a
      const gitService = new GitService(testDir);
      await gitService.deleteBranch('branch-a');

      const branches = await git.branchLocal();
      assert.strictEqual(branches.all.includes('branch-a'), false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should throw friendly error when branch is actively checked out in a worktree', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-delete-active-wt-'));
    const wtDir = join(testDir, 'wt-active');

    try {
      const git = simpleGit(testDir);
      await git.init();
      await git.addConfig('user.name', 'Trident Test');
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('commit.gpgsign', 'false');

      await writeFile(join(testDir, 'file.txt'), 'initial\n');
      await git.add('.');
      await git.commit('initial commit');

      await git.branch(['active-branch']);
      await git.raw(['worktree', 'add', wtDir, 'active-branch']);

      const gitService = new GitService(testDir);
      await assert.rejects(
        async () => {
          await gitService.deleteBranch('active-branch');
        },
        /Cannot delete branch "active-branch" because it is currently checked out in worktree/
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
