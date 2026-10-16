import test from 'node:test';
import assert from 'node:assert/strict';
import { getHttpRemoteUrl, getGitAuthConfig } from './git-auth';

test('PAT transport resolves SSH URLs and nested GitLab groups to HTTPS', () => {
  for (const remote of ['git@git.insea.io:group/nested/repo.git', 'ssh://git@git.insea.io:2222/group/nested/repo.git']) {
    assert.equal(getHttpRemoteUrl(remote), 'https://git.insea.io/group/nested/repo.git');
    assert.equal(getHttpRemoteUrl(remote, 'https://git.insea.io:8443'), 'https://git.insea.io:8443/group/nested/repo.git');
  }
});

test('HTTP and local remotes retain their existing transport', () => {
  assert.equal(getHttpRemoteUrl('https://git.insea.io/group/repo.git'), 'https://git.insea.io/group/repo.git');
  assert.equal(getHttpRemoteUrl('http://localhost:8080/repo.git'), 'http://localhost:8080/repo.git');
  for (const remote of ['/tmp/repo.git', 'file:///tmp/repo.git', '../repo', 'git://example.com/repo.git', 'invalid']) {
    assert.equal(getHttpRemoteUrl(remote), null);
  }
});

test('SSH rewrite refuses unrelated account hosts and non-HTTP origins', () => {
  for (const host of ['https://elsewhere.test', 'https://git.insea.io.attacker.test', 'file:///tmp/repo', 'ssh://git.insea.io']) {
    assert.equal(getHttpRemoteUrl('git@git.insea.io:group/repo.git', host), null);
  }
  assert.equal(getHttpRemoteUrl('git@git.insea.io:group/repo.git', 'git.insea.io'), 'https://git.insea.io/group/repo.git');
  assert.equal(getHttpRemoteUrl('git@git.insea.io:group/repo.git', 'https://user:password@git.insea.io'), 'https://git.insea.io/group/repo.git');
});

test('HTTP authentication stays on the account origin when remotes have a different push URL', () => {
  const credentials = { username: 'test', token: 'fixture-token', serverUrl: 'https://git.insea.io' };
  for (const remote of ['https://elsewhere.test/group/repo.git', 'http://git.insea.io/group/repo.git', 'https://git.insea.io:8443/group/repo.git']) {
    assert.deepEqual(getGitAuthConfig(remote, credentials), []);
  }
  const args = getGitAuthConfig('git@git.insea.io:group/repo.git', credentials);
  assert.ok(args.includes('url.https://git.insea.io/group/repo.git.insteadOf=git@git.insea.io:group/repo.git'));
  assert.ok(args.includes('credential.helper='));
  assert.equal(getHttpRemoteUrl('https://git.insea.io/group/repo.git', 'invalid host'), null);
});
