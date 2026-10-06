import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitService } from './git';
import { simpleGit } from 'simple-git';

describe('GitService worktree pull and push operations', () => {
  it('should successfully pull a branch that is checked out in a linked worktree', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-worktree-pull-'));

    try {
      const bareRemotePath = join(testDir, 'remote.git');
      const mainRepoPath = join(testDir, 'main-repo');
      const worktreePath = join(testDir, 'worktree-feature');

      // 1. Create a bare remote repo
      await simpleGit().init(true, ['--bare', bareRemotePath]);

      // 2. Clone to main-repo, configure git user and commit initial main
      const mainGit = simpleGit();
      await mainGit.clone(bareRemotePath, mainRepoPath);

      const repoGit = simpleGit(mainRepoPath);
      await repoGit.addConfig('user.name', 'Trident Test');
      await repoGit.addConfig('user.email', 'test@example.com');
      await repoGit.addConfig('commit.gpgsign', 'false');

      await writeFile(join(mainRepoPath, 'main.txt'), 'initial main\n');
      await repoGit.add('main.txt');
      await repoGit.commit('initial main commit');
      await repoGit.push(['-u', 'origin', 'main']);

      // 3. Create feature branch and push to origin
      await repoGit.checkoutLocalBranch('feature-branch');
      await writeFile(join(mainRepoPath, 'feature.txt'), 'feature v1\n');
      await repoGit.add('feature.txt');
      await repoGit.commit('feature v1');
      await repoGit.push(['-u', 'origin', 'feature-branch']);

      // 4. Switch mainRepo back to main
      await repoGit.checkout('main');

      // 5. Add a worktree for feature-branch
      await repoGit.raw(['worktree', 'add', worktreePath, 'feature-branch']);

      // 6. In another clone / temporary clone, simulate a remote push to feature-branch
      const otherClonePath = join(testDir, 'other-clone');
      await simpleGit().clone(bareRemotePath, otherClonePath);
      const otherGit = simpleGit(otherClonePath);
      await otherGit.addConfig('user.name', 'Other Dev');
      await otherGit.addConfig('user.email', 'other@example.com');
      await otherGit.addConfig('commit.gpgsign', 'false');
      await otherGit.checkout('feature-branch');
      await writeFile(join(otherClonePath, 'feature.txt'), 'feature v2 from remote\n');
      await otherGit.add('feature.txt');
      await otherGit.commit('feature v2 commit');
      await otherGit.push('origin', 'feature-branch');

      const expectedRemoteCommit = (await otherGit.revparse(['HEAD'])).trim();

      // 7. Now in mainRepo (where main is checked out and feature-branch is in worktreePath),
      // invoke GitService.pullFromRemote on 'feature-branch'.
      // Previously, this failed with:
      // "fatal: 'feature-branch' is already used by worktree at '...'"
      const service = new GitService(mainRepoPath);
      await service.pullFromRemote('feature-branch', 'origin', 'feature-branch', { rebase: true });

      // 8. Verify the linked worktree has the updated commit!
      const wtGit = simpleGit(worktreePath);
      const wtHead = (await wtGit.revparse(['HEAD'])).trim();
      assert.strictEqual(wtHead, expectedRemoteCommit, 'Linked worktree HEAD should be updated to remote commit');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should successfully push a branch that is checked out in a linked worktree', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-worktree-push-'));

    try {
      const bareRemotePath = join(testDir, 'remote.git');
      const mainRepoPath = join(testDir, 'main-repo');
      const worktreePath = join(testDir, 'worktree-feature');

      await simpleGit().init(true, ['--bare', bareRemotePath]);
      const bareGit = simpleGit(bareRemotePath);

      await simpleGit().clone(bareRemotePath, mainRepoPath);
      const repoGit = simpleGit(mainRepoPath);
      await repoGit.addConfig('user.name', 'Trident Test');
      await repoGit.addConfig('user.email', 'test@example.com');
      await repoGit.addConfig('commit.gpgsign', 'false');

      await writeFile(join(mainRepoPath, 'main.txt'), 'main\n');
      await repoGit.add('main.txt');
      await repoGit.commit('main commit');
      await repoGit.push(['-u', 'origin', 'main']);

      await repoGit.checkoutLocalBranch('feature-branch');
      await writeFile(join(mainRepoPath, 'feature.txt'), 'feature v1\n');
      await repoGit.add('feature.txt');
      await repoGit.commit('feature v1');
      await repoGit.push(['-u', 'origin', 'feature-branch']);

      await repoGit.checkout('main');
      await repoGit.raw(['worktree', 'add', worktreePath, 'feature-branch']);

      // Make a commit in the linked worktree
      const wtGit = simpleGit(worktreePath);
      await wtGit.addConfig('user.name', 'Trident Test');
      await wtGit.addConfig('user.email', 'test@example.com');
      await wtGit.addConfig('commit.gpgsign', 'false');
      await writeFile(join(worktreePath, 'feature.txt'), 'feature v2 local\n');
      await wtGit.add('feature.txt');
      await wtGit.commit('feature v2 local commit');
      const localCommit = (await wtGit.revparse(['HEAD'])).trim();

      // Push from main repo
      const service = new GitService(mainRepoPath);
      await service.pushToRemote('feature-branch', 'origin', 'feature-branch');

      // Verify remote received the commit
      const remoteHead = (await bareGit.raw(['rev-parse', 'refs/heads/feature-branch'])).trim();
      assert.strictEqual(remoteHead, localCommit, 'Remote should receive commit pushed from main service');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should cleanly abort rebase in linked worktree and restore stash if pull conflicts', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'trident-test-worktree-conflict-'));

    try {
      const bareRemotePath = join(testDir, 'remote.git');
      const mainRepoPath = join(testDir, 'main-repo');
      const worktreePath = join(testDir, 'worktree-feature');

      await simpleGit().init(true, ['--bare', bareRemotePath]);

      await simpleGit().clone(bareRemotePath, mainRepoPath);
      const repoGit = simpleGit(mainRepoPath);
      await repoGit.addConfig('user.name', 'Trident Test');
      await repoGit.addConfig('user.email', 'test@example.com');
      await repoGit.addConfig('commit.gpgsign', 'false');

      await writeFile(join(mainRepoPath, 'main.txt'), 'main\n');
      await repoGit.add('main.txt');
      await repoGit.commit('main commit');
      await repoGit.push(['-u', 'origin', 'main']);

      await repoGit.checkoutLocalBranch('feature-branch');
      await writeFile(join(mainRepoPath, 'feature.txt'), 'line 1\nline 2\n');
      await repoGit.add('feature.txt');
      await repoGit.commit('feature base');
      await repoGit.push(['-u', 'origin', 'feature-branch']);

      await repoGit.checkout('main');
      await repoGit.raw(['worktree', 'add', worktreePath, 'feature-branch']);

      // In linked worktree, make a local conflicting commit
      const wtGit = simpleGit(worktreePath);
      await wtGit.addConfig('user.name', 'Trident Test');
      await wtGit.addConfig('user.email', 'test@example.com');
      await wtGit.addConfig('commit.gpgsign', 'false');
      await writeFile(join(worktreePath, 'feature.txt'), 'local conflicting change\n');
      await wtGit.add('feature.txt');
      await wtGit.commit('local conflicting commit');
      const prePullHead = (await wtGit.revparse(['HEAD'])).trim();

      // Also leave an uncommitted modified tracked file in the worktree to test stash restore
      await writeFile(join(worktreePath, 'feature.txt'), 'local conflicting change with dirty uncommitted edits\n');

      // On remote, make another conflicting commit
      const otherClonePath = join(testDir, 'other-clone');
      await simpleGit().clone(bareRemotePath, otherClonePath);
      const otherGit = simpleGit(otherClonePath);
      await otherGit.addConfig('user.name', 'Other Dev');
      await otherGit.addConfig('user.email', 'other@example.com');
      await otherGit.addConfig('commit.gpgsign', 'false');
      await otherGit.checkout('feature-branch');
      await writeFile(join(otherClonePath, 'feature.txt'), 'remote conflicting change\n');
      await otherGit.add('feature.txt');
      await otherGit.commit('remote conflicting commit');
      await otherGit.push('origin', 'feature-branch');

      // Attempt pullFromRemote from mainRepo
      const service = new GitService(mainRepoPath);
      let errorThrown = false;
      try {
        await service.pullFromRemote('feature-branch', 'origin', 'feature-branch', { rebase: true });
      } catch {
        errorThrown = true;
      }

      assert.strictEqual(errorThrown, true, 'Pull should fail due to conflict');

      // Verify the linked worktree is NOT left in a rebase-in-progress state
      const rebaseMergeExists = await (async () => {
        try {
          const wtStatus = await wtGit.status();
          return Boolean(wtStatus.current);
        } catch {
          return false;
        }
      })();
      assert.strictEqual(rebaseMergeExists, true, 'Linked worktree should still be in valid state');

      // Verify HEAD in linked worktree was restored to pre-pull commit
      const postPullHead = (await wtGit.revparse(['HEAD'])).trim();
      assert.strictEqual(postPullHead, prePullHead, 'Linked worktree HEAD should be restored');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
