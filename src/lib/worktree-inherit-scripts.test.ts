import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { getWorktreeInfo, normalizePath } from './worktree';
import { Repository, RepositoryCustomScript } from './types';

describe('Worktree detection and script inheritance', () => {
  it('detects main repo vs linked worktree correctly via getWorktreeInfo', async () => {
    const rawTestDir = await mkdtemp(join(tmpdir(), 'trident-test-wt-info-'));
    const testDir = realpathSync(rawTestDir);

    const mainRepoPath = join(testDir, 'main-repo');
    const worktreePath = join(testDir, 'linked-wt');

    // 1. Initialize main repo
    const git = simpleGit();
    await git.init(['-b', 'main', mainRepoPath]);

    const mainGit = simpleGit(mainRepoPath);
    await mainGit.addConfig('user.name', 'Trident Test');
    await mainGit.addConfig('user.email', 'test@example.com');
    await mainGit.addConfig('commit.gpgsign', 'false');

    await writeFile(join(mainRepoPath, 'README.md'), 'test\n');
    await mainGit.add('README.md');
    await mainGit.commit('init');

    // 2. Add linked worktree
    await mainGit.raw(['worktree', 'add', '-b', 'feature', worktreePath]);

    // Check main repo
    const mainInfo = getWorktreeInfo(mainRepoPath);
    assert.strictEqual(mainInfo.isWorktree, false);
    assert.strictEqual(mainInfo.rootWorktreePath, undefined);

    // Check linked worktree
    const wtInfo = getWorktreeInfo(worktreePath);
    assert.strictEqual(wtInfo.isWorktree, true);
    assert.strictEqual(normalizePath(wtInfo.rootWorktreePath!), normalizePath(mainRepoPath));
  });

  it('filters out worktrees in repository lists', () => {
    const repos: Repository[] = [
      {
        path: '/repos/project-a',
        name: 'project-a',
        isWorktree: false,
      },
      {
        path: '/repos/project-a/.worktrees/feature',
        name: 'project-a-feature',
        isWorktree: true,
        rootWorktreePath: '/repos/project-a',
      },
      {
        path: '/repos/project-b',
        name: 'project-b',
      },
    ];

    const homeList = repos.filter((r) => !r.isWorktree);
    assert.strictEqual(homeList.length, 2);
    assert.strictEqual(homeList[0].name, 'project-a');
    assert.strictEqual(homeList[1].name, 'project-b');
  });

  it('inherits custom scripts from parent root worktree', () => {
    const testScript: RepositoryCustomScript = {
      id: 'script-1',
      name: 'Run Lint',
      target: 'branch',
      action: 'run-bash-script',
      content: 'npm run lint',
    };

    const rootRepo: Repository = {
      path: '/repos/my-app',
      name: 'my-app',
      isWorktree: false,
      customScripts: [testScript],
    };

    const worktreeRepo: Repository = {
      path: '/repos/my-app/.worktrees/feat',
      name: 'my-app-feat',
      isWorktree: true,
      rootWorktreePath: '/repos/my-app',
      // inherited scripts
      customScripts: JSON.parse(JSON.stringify(rootRepo.customScripts)),
    };

    assert.deepStrictEqual(worktreeRepo.customScripts, [testScript]);
    assert.strictEqual(worktreeRepo.isWorktree, true);
    assert.strictEqual(worktreeRepo.rootWorktreePath, rootRepo.path);
  });
});
