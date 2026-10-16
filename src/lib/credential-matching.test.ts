import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchingCredentialsForRemote } from './credential-matching';

const github = { type: 'github' as const };
const gitlab = { type: 'gitlab' as const, serverUrl: 'https://git.insea.io:8443' };
const credentials = [github, gitlab];

describe('saved credential host matching', () => {
  it('matches SCP and explicit SSH remotes independently of HTTP API ports', () => {
    for (const remote of ['git@git.insea.io:group/repo.git', 'ssh://git@git.insea.io:2222/group/repo.git']) {
      assert.deepEqual(matchingCredentialsForRemote(remote, credentials), [gitlab]);
    }
  });

  it('matches the HTTP origin including protocol and port', () => {
    assert.deepEqual(matchingCredentialsForRemote('https://git.insea.io:8443/group/repo.git', credentials), [gitlab]);
    assert.deepEqual(matchingCredentialsForRemote('https://git.insea.io/group/repo.git', credentials), []);
    assert.deepEqual(matchingCredentialsForRemote('http://git.insea.io:8443/group/repo.git', credentials), []);
  });

  it('does not send GitHub credentials to hosts containing github.com in their path or name', () => {
    for (const remote of ['https://evil.test/github.com/repo', 'https://github.com.evil.test/repo', 'git@evil.test:github.com/repo']) {
      assert.deepEqual(matchingCredentialsForRemote(remote, credentials), []);
    }
    assert.deepEqual(matchingCredentialsForRemote('git@github.com:group/repo.git', credentials), [github]);
  });

  it('ignores malformed server URLs and non-network remotes without disrupting valid matches', () => {
    assert.deepEqual(matchingCredentialsForRemote('ssh://git@git.insea.io/group/repo.git', [
      { type: 'gitlab', serverUrl: 'invalid' }, gitlab,
    ]), [gitlab]);
    assert.deepEqual(matchingCredentialsForRemote('/tmp/local.git', credentials), []);
    assert.deepEqual(matchingCredentialsForRemote('file:///tmp/local.git', credentials), []);
  });
});
