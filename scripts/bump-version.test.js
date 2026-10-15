import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./bump-version.js', import.meta.url));
function fixture(t, version = '0.92.0') {
  const directory = mkdtempSync(path.join(tmpdir(), 'trident-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git');
  const cwd = path.join(directory, 'checkout');
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'test@example.com');
  mkdirSync(path.join(cwd, 'src-tauri'));
  const setVersion = (value) => {
    const pkg = { name: 'release-fixture', version: value, private: true };
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg));
    writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
    writeFileSync(path.join(cwd, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: value }));
    writeFileSync(path.join(cwd, 'src-tauri/Cargo.toml'), `[package]\nname = "fixture"\nversion = "${value}"\n`);
  };
  setVersion(version);
  git('add', '.');
  git('commit', '-m', 'fix: prepare a release');
  git('tag', 'v0.92.0');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main', 'refs/tags/v0.92.0');
  const output = path.join(directory, 'output');
  const runWithEnv = (extraEnv, ...args) => {
    writeFileSync(output, '');
    return spawnSync(process.execPath, [script, ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output, ...extraEnv },
    });
  };
  const remoteRef = (ref) => git('ls-remote', '--refs', 'origin', ref).split('\t')[0];
  const run = (...args) => runWithEnv({}, ...args);
  return { cwd, remote, git, setVersion, run, runWithEnv, remoteRef, outputs: () => readFileSync(output, 'utf8') };
}

test('release publishes matching commit/tag and outputs after success', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.remoteRef('refs/heads/main'), f.git('rev-parse', 'HEAD'));
  assert.equal(f.remoteRef('refs/tags/v0.93.0'), f.git('rev-parse', 'HEAD'));
  assert.match(f.outputs(), /tag=v0.93.0\nversion=0.93.0\nshould_release=true/);
});

test('a rejected tag leaves both remote refs unchanged and can be retried without another bump', (t) => {
  const f = fixture(t);
  const before = f.remoteRef('refs/heads/main');
  const hook = path.join(f.remote, 'hooks/update');
  writeFileSync(hook, '#!/bin/sh\nif [ "$1" = "refs/tags/v0.93.0" ]; then echo "missing necessary objects" >&2; exit 1; fi\n', { mode: 0o755 });
  const rejected = f.run();
  assert.notEqual(rejected.status, 0);
  assert.equal(f.remoteRef('refs/heads/main'), before, 'failed tag publication must not publish the version commit');
  assert.equal(f.remoteRef('refs/tags/v0.93.0'), '');
  assert.equal(f.outputs(), '');
  const releaseCommit = f.git('rev-parse', 'HEAD');
  rmSync(hook);
  const retried = f.run();
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(f.git('rev-parse', 'HEAD'), releaseCommit);
  assert.equal(f.remoteRef('refs/tags/v0.93.0'), releaseCommit);
  assert.match(f.outputs(), /should_release=true/);
});

test('retry recovers the tag for an already-published version commit', (t) => {
  const f = fixture(t);
  f.setVersion('0.93.0');
  f.git('add', '.');
  f.git('commit', '-m', 'chore(release): v0.93.0 [skip ci]');
  f.git('push', 'origin', 'main');
  const releaseCommit = f.git('rev-parse', 'HEAD');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.remoteRef('refs/tags/v0.93.0'), releaseCommit);
  assert.equal(f.git('rev-parse', 'HEAD'), releaseCommit);
  assert.match(f.outputs(), /version=0.93.0\nshould_release=true/);
  assert.equal(f.run().status, 0);
  assert.equal(f.outputs(), 'should_release=false\n');
});

test('an older tag cannot override a newer package version', (t) => {
  const f = fixture(t, '0.93.0');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.remoteRef('refs/tags/v0.94.0'), f.git('rev-parse', 'HEAD'));
  assert.match(f.outputs(), /version=0.94.0/);
});

test('dry run leaves files, refs and outputs unchanged', (t) => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.outputs(), '');
});

test('GitLab release uses dotenv output and GitLab bot identity', (t) => {
  const f = fixture(t);
  const output = path.join(f.cwd, 'release.env');
  const result = f.runWithEnv({ GITLAB_CI: 'true', RELEASE_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /tag=v0.93.0\nversion=0.93.0\nshould_release=true/);
  assert.equal(f.outputs(), '', 'GitLab output must not write GitHub output');
  assert.equal(f.git('log', '-1', '--format=%an <%ae>'), 'gitlab-ci[bot] <gitlab-ci@localhost>');
});
