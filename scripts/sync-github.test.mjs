import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { githubRepository, rewriteManifest, syncGithub } from './sync-github.mjs';

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'test-token', CI_API_V4_URL: 'https://gitlab.test/api/v4', CI_PROJECT_ID: '1', CI_JOB_TOKEN: 'job-token' };
const assetUrl = `${env.CI_API_V4_URL}/projects/1/packages/generic/trident/1.0.0/app.zip`;
const release = { tag_name: 'v1.0.0', name: 'Release', description: assetUrl, assets: { links: [{ name: 'app.zip', url: assetUrl }] } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('accepts repository coordinates and HTTPS remotes, rejects credential-bearing or foreign remotes', () => {
  assert.equal(githubRepository('owner/repo'), 'owner/repo');
  assert.equal(githubRepository('https://github.com/owner/repo.git'), 'owner/repo');
  for (const value of ['https://evil.test/owner/repo', 'https://token@github.com/owner/repo', 'owner/repo/extra']) assert.throws(() => githubRepository(value));
});

test('missing either variable succeeds without calling Git or APIs', async () => {
  for (const missing of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']) {
    await syncGithub({ env: { ...env, [missing]: '' }, git: () => assert.fail(), send: () => assert.fail(), request: () => assert.fail() });
  }
});

test('updater URLs become public GitHub URLs and signatures remain intact', () => {
  const result = JSON.parse(rewriteManifest(JSON.stringify({ platforms: { mac: { url: assetUrl, signature: 'signed' } } }), release.assets.links, 'owner/repo', 'v1.0.0'));
  assert.equal(result.platforms.mac.url, 'https://github.com/owner/repo/releases/download/v1.0.0/app.zip');
  assert.equal(result.platforms.mac.signature, 'signed');
  assert.throws(() => rewriteManifest('{"platforms":{"mac":{"url":"unknown"}}}', [], 'owner/repo', 'v1.0.0'));
});

test('no releases still pushes main without force or tags', async () => {
  const calls = [];
  await syncGithub({ env, send: async () => json({}, 404), git: (args) => calls.push(args), request: () => assert.fail() });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('refs/remotes/origin/main:refs/heads/main'));
  assert.ok(!calls[1].some((arg) => arg.includes('force') || arg.includes('refs/tags/')));
});

test('copies release assets and publishes only after uploads; rerun reuses release and matching assets', async () => {
  for (const exists of [false, true]) {
    const events = [];
    const gitCalls = [];
    await syncGithub({ env, git: (args, options = {}) => { gitCalls.push(args); if (options.env) assert.equal(options.env.GIT_TERMINAL_PROMPT, '0'); },
      send: async (url, options) => {
        if (url.endsWith('/permalink/latest')) return json(release);
        if (url === assetUrl) { assert.equal(options.headers['JOB-TOKEN'], 'job-token'); return new Response('data'); }
        assert.ok(url.startsWith('https://uploads.github.com/'));
        assert.ok(!options.headers['JOB-TOKEN']);
        // Consume the file stream as fetch would, before temporary files are removed.
        for await (const chunk of options.body) assert.equal(chunk.toString(), 'data');
        events.push('upload');
        return json({});
      },
      request: async (route, options = {}) => {
        events.push(`${options.method || 'GET'} ${route}`);
        if (route.startsWith('/releases/tags/')) return exists ? json({ id: 7 }) : json({}, 404);
        if (options.method === 'POST') { assert.equal(JSON.parse(options.body).draft, true); return json({ id: 7 }); }
        if (route.includes('/assets?')) return json(exists ? [{ name: 'app.zip', digest: 'sha256:3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7' }] : []);
        if (options.method === 'PATCH') { const metadata = JSON.parse(options.body); assert.equal(metadata.draft, false); assert.ok(metadata.body.includes('github.com/owner/repo/releases/download/')); return json({}); }
        assert.fail(route);
      },
    });
    assert.ok(gitCalls.at(-1).includes('refs/tags/v1.0.0:refs/tags/v1.0.0'));
    assert.equal(events.at(-1), 'PATCH /releases/7');
    assert.equal(events.includes('upload'), !exists);
  }
});

test('external asset links fail without forwarding the GitLab token', async () => {
  await assert.rejects(syncGithub({ env, git: () => {}, send: async (url) => {
    assert.ok(url.endsWith('/permalink/latest'));
    return json({ ...release, assets: { links: [{ name: 'app.zip', url: 'https://evil.test/asset' }] } });
  }, request: () => assert.fail() }), /Generic Package Registry/);
});

test('push failures stop release publication', async () => {
  await assert.rejects(syncGithub({ env, send: async () => json(release), git: (args) => {
    if (args.includes('push')) throw new Error('non-fast-forward');
  }, request: () => assert.fail() }), /non-fast-forward/);
});

test('follows the latest-release permalink redirect with authentication', async () => {
  const calls = [];
  await syncGithub({ env, git: () => {}, request: () => assert.fail(), send: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['JOB-TOKEN'], env.CI_JOB_TOKEN);
    if (url.endsWith('/permalink/latest')) return new Response(null, { status: 302, headers: { Location: '/api/v4/projects/1/releases/v1.0.0' } });
    assert.equal(url, `${env.CI_API_V4_URL}/projects/1/releases/v1.0.0`);
    return json({}, 404);
  } });
  assert.equal(calls.length, 2);
});

test('rejects external, other-project and non-API redirects before forwarding credentials', async () => {
  for (const location of ['https://evil.test/asset', 'https://gitlab.test/api/v4/projects/2/releases/v1',
    'https://gitlab.test/users/sign_in', 'https://gitlab.test/api/v4/projects/1/releases-evil',
    'https://gitlab.test/api/v4/projects/1/releases/../../../../users',
    'https://user:password@gitlab.test/api/v4/projects/1/releases/v1']) {
    let calls = 0;
    await assert.rejects(syncGithub({ env, git: () => assert.fail(), request: () => assert.fail(), send: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: location } });
    } }), /Generic Package Registry/);
    assert.equal(calls, 1);
  }
});

test('redirect loops and missing Location fail with clear errors', async () => {
  for (const location of [null, '/api/v4/projects/1/releases/permalink/latest']) {
    let calls = 0;
    await assert.rejects(syncGithub({ env, git: () => assert.fail(), request: () => assert.fail(), send: async () => {
      calls++;
      return new Response(null, { status: 302, headers: location ? { Location: location } : {} });
    } }), location ? /Too many GitLab redirects/ : /missing Location/);
    assert.ok(calls <= 6);
  }
});


test('real HTTP fetch follows GitLab-style redirects without an unexpected redirect error', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, token: request.headers['job-token'] });
    if (request.url.endsWith('/permalink/latest')) {
      response.writeHead(302, { Location: '/api/v4/projects/1/releases/v1.0.0' });
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
    }
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await syncGithub({ env: { ...env, CI_API_V4_URL: `http://127.0.0.1:${server.address().port}/api/v4` },
      git: () => {}, request: () => assert.fail() });
    assert.deepEqual(seen.map((entry) => entry.url), [
      '/api/v4/projects/1/releases/permalink/latest', '/api/v4/projects/1/releases/v1.0.0',
    ]);
    assert.ok(seen.every((entry) => entry.token === env.CI_JOB_TOKEN));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
