import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isValidRepoName, migrateRepoNames, slugifyRepoName, uniqueRepoName } from './repo-name';

describe('repo-name', () => {
  it('validates names', () => {
    assert.strictEqual(isValidRepoName('my-app_1.0'), true);
    assert.strictEqual(isValidRepoName('My App'), false);
    assert.strictEqual(isValidRepoName('..'), false);
    assert.strictEqual(isValidRepoName(''), false);
  });

  it('slugifies and lowercases', () => {
    assert.strictEqual(slugifyRepoName('My Project'), 'my-project');
    assert.strictEqual(slugifyRepoName('café_app'), 'caf-_app');
    assert.strictEqual(slugifyRepoName('..'), 'repo');
  });

  it('suffixes collisions case-insensitively', () => {
    assert.strictEqual(uniqueRepoName('app', ['App']), 'app-2');
    assert.strictEqual(uniqueRepoName('app', ['app', 'app-2']), 'app-3');
    assert.strictEqual(uniqueRepoName('app', []), 'app');
  });

  it('migrates invalid and duplicate names', () => {
    const repos = [
      { name: 'App', path: '/a/App' },
      { name: 'app', path: '/b/app' },
      { name: 'My Repo', path: '/c/My Repo' },
    ];
    assert.deepStrictEqual(migrateRepoNames(repos)?.map((r) => r.name), ['App', 'app-2', 'my-repo']);
    assert.strictEqual(migrateRepoNames([{ name: 'x', path: '/x' }]), null);
  });
});
