import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { GitService, clearGitInstances } from './git';

// A separate process also serves synchronous fetches made by the submit runner.
const backendScript = `
const http = require('node:http');
const { spawn } = require('node:child_process');
const server = http.createServer((req, res) => {
  const auth = req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'authorization');
  if (auth.length !== 1 || req.headers.authorization !== process.env.EXPECTED_AUTH) {
    res.writeHead(400); res.end('Duplicate or incorrect Authorization header'); return;
  }
  const url = new URL(req.url, 'http://localhost');
  const child = spawn('git', ['http-backend'], { env: {
    ...process.env, GIT_PROJECT_ROOT: process.env.REMOTE_ROOT, GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'test',
  }});
  let data = Buffer.alloc(0);
  child.stdout.on('data', chunk => { data = Buffer.concat([data, chunk]); });
  child.stderr.resume();
  child.on('close', () => {
    const end = data.indexOf('\\r\\n\\r\\n');
    if (end < 0) { res.writeHead(500); res.end(); return; }
    let status = 200;
    const headers = {};
    for (const line of data.subarray(0, end).toString().split('\\r\\n')) {
      const colon = line.indexOf(':');
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') status = parseInt(value); else headers[key] = value;
    }
    res.writeHead(status, headers); res.end(data.subarray(end + 4));
  });
  req.pipe(child.stdin);
});
server.listen(0, '127.0.0.1', () => process.send(server.address().port));
`;

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-http-auth-'));
  const local = path.join(root, 'local');
  const remote = path.join(root, 'repo.git');
  fs.mkdirSync(local);
  const git = (args: string[], cwd = local) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', '-b', 'main', remote]);
  git(['config', 'http.receivepack', 'true'], remote);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(local, 'README.md'), 'test\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main']);
  const token = 'fixture-token';
  const auth = `AUTHORIZATION: basic ${Buffer.from(`test:${token}`).toString('base64')}`;
  const server = spawn(process.execPath, ['-e', backendScript], {
    env: { ...process.env, REMOTE_ROOT: root, EXPECTED_AUTH: auth.slice('AUTHORIZATION: '.length) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [port] = await once(server, 'message');
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/repo.git`;
  git(['remote', 'set-url', 'origin', url]);
  return { root, local, remote, git, token, auth, origin, url, cleanup: async () => {
    clearGitInstances();
    server.kill();
    await once(server, 'exit');
    fs.rmSync(root, { recursive: true, force: true });
  }};
}


for (const remoteFormat of ['http', 'scp', 'ssh']) {
  test(`updated PAT authenticates fetch, push and tag discovery for ${remoteFormat}`, async (t) => {
    const f = await fixture();
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(JSON.stringify(args)); });
    }
    try {
      const remoteUrl = remoteFormat === 'http' ? f.url : remoteFormat === 'scp'
        ? 'git@127.0.0.1:repo.git' : 'ssh://git@127.0.0.1:2222/repo.git';
      f.git(['remote', 'set-url', 'origin', remoteUrl]);
      f.git(['config', `http.${f.origin}.extraheader`, 'Authorization: basic stale-token']);
      f.git(['tag', 'v-fixture']);
      fs.writeFileSync(path.join(f.local, 'feature.txt'), 'new content\n');
      f.git(['add', '.']);
      f.git(['commit', '-m', 'feature']);
      const service = new GitService(f.local);
      const credentials = { username: 'test', token: 'wrong-token', serverUrl: f.origin };
      await assert.rejects(service.pushToRemote('main', 'origin', 'main', { credentials }));
      credentials.token = f.token;
      await service.pushToRemote('main', 'origin', 'main', { credentials });
      assert.equal(f.git(['show', 'main:feature.txt'], f.remote), 'new content\n');
      assert.match(f.git(['show-ref'], f.remote), /refs\/tags\/v-fixture/);
      await service.fetchRemote('origin', credentials);
      await service.fetch({ credentials });
      await service.createTag('created-tag', 'HEAD', { pushToRemote: true, remote: 'origin', credentials });
      await service.deleteRemoteTag('origin', 'created-tag', credentials);
      await service.pushToRemote('main', 'origin', 'to-rename', { credentials, pushLocalOnlyTags: false });
      await service.renameRemoteBranch('origin', 'to-rename', 'renamed', credentials);
      await service.deleteRemoteBranch('origin', 'renamed', credentials);
      const peer = path.join(f.root, 'peer');
      f.git(['clone', f.remote, peer]);
      f.git(['config', 'user.name', 'Peer'], peer);
      f.git(['config', 'user.email', 'peer@example.test'], peer);
      fs.writeFileSync(path.join(peer, 'peer.txt'), 'remote update\n');
      f.git(['add', '.'], peer);
      f.git(['commit', '-m', 'remote change'], peer);
      f.git(['push', 'origin', 'main'], peer);
      await service.pullFromRemote('main', 'origin', 'main', { credentials });
      assert.equal(fs.readFileSync(path.join(f.local, 'peer.txt'), 'utf8'), 'remote update\n');
      await service.pull({ credentials });
      const cloned = path.join(f.root, 'auth-clone');
      await GitService.cloneRepository(remoteUrl, cloned, { credentials });
      const cloneConfig = fs.readFileSync(path.join(cloned, '.git', 'config'), 'utf8');
      assert.ok(!cloneConfig.includes('extraheader'));
      assert.ok(!cloneConfig.includes('insteadOf'));
      assert.ok(!cloneConfig.includes(f.token));
      const linked = path.join(f.root, 'linked');
      f.git(['worktree', 'add', '-b', 'linked-auth', linked, 'main']);
      fs.writeFileSync(path.join(linked, 'linked.txt'), 'linked worktree\n');
      f.git(['add', '.'], linked);
      f.git(['commit', '-m', 'linked update'], linked);
      await service.pushToRemote('linked-auth', 'origin', 'linked-auth', { credentials });
      assert.equal(f.git(['show', 'linked-auth:linked.txt'], f.remote), 'linked worktree\n');
      assert.ok(!logs.join('\n').includes(f.token));
      assert.ok(!logs.join('\n').includes(Buffer.from(`test:${f.token}`).toString('base64')));
      assert.equal(f.git(['config', '--get', 'remote.origin.url']).trim(), remoteUrl);
      const saved = fs.readFileSync(path.join(f.local, '.git', 'config'), 'utf8');
      assert.ok(!saved.includes(f.token));
      assert.ok(!saved.includes(f.auth));
    } finally { await f.cleanup(); }
  });
}
