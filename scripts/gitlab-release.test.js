import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { collectAssets, generateTauriConfig, getTauriBuildArgs } from './gitlab-release.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function command(args, cwd, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...extraEnv } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (status) => resolve({ status, output }));
  });
}

test('GitLab preparation bumps main once, checks out the released commit, and resolves manual tags', async (t) => {
  const directory = fixture(t);
  const remote = path.join(directory, 'remote.git');
  const cwd = path.join(directory, 'checkout');
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src-tauri'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'test@example.com');
  for (const name of ['gitlab-release.mjs', 'macos-release.mjs', 'native-runtime.mjs', 'bump-version.js', 'generate-changelog.js']) fs.copyFileSync(path.join(scriptDir, name), path.join(cwd, 'scripts', name));
  const pkg = { name: 'release-test', version: '1.2.0' };
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
  fs.writeFileSync(path.join(cwd, 'src-tauri/tauri.conf.json'), '{"version":"1.2.0"}');
  fs.writeFileSync(path.join(cwd, 'src-tauri/Cargo.toml'), '[package]\nname = "fixture"\nversion = "1.2.0"\n');
  git('add', '.');
  git('commit', '-m', 'feat: release fixture');
  git('tag', 'v1.2.0');
  fs.writeFileSync(path.join(cwd, 'feature.txt'), 'new feature');
  git('add', 'feature.txt');
  git('commit', '-m', 'feat: release fixture changes');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main', '--tags');
  const env = { GITLAB_CI: 'true', CI_PROJECT_URL: remote.slice(0, -4), CI_JOB_TOKEN: 'fixture', CI_COMMIT_TAG: '', RELEASE_TAG: '', GITHUB_OUTPUT: '', RELEASE_OUTPUT: '' };
  const prepared = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, env);
  assert.equal(prepared.status, 0, prepared.output);
  assert.equal(fs.readFileSync(path.join(cwd, 'release.env'), 'utf8'), 'RELEASE_TAG=v1.3.0\nSHOULD_RELEASE=true\n');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.3.0'));
  assert.equal(git('remote', 'get-url', 'origin'), remote);
  assert.match(fs.readFileSync(path.join(cwd, 'changelog.txt'), 'utf8'), /release fixture/);
  const skipped = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, env);
  assert.equal(skipped.status, 0, skipped.output);
  assert.equal(fs.readFileSync(path.join(cwd, 'release.env'), 'utf8'), 'RELEASE_TAG=v1.3.0\nSHOULD_RELEASE=true\n');
  const resumedWeb = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, { ...env, CI_PIPELINE_SOURCE: 'web' });
  assert.equal(resumedWeb.status, 0, resumedWeb.output);
  assert.equal(fs.readFileSync(path.join(cwd, 'release.env'), 'utf8'), 'RELEASE_TAG=v1.3.0\nSHOULD_RELEASE=true\n');
  const manual = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, { ...env, RELEASE_TAG: 'v1.2.0' });
  assert.equal(manual.status, 0, manual.output);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.2.0'));
  // A queued pipeline may start from an older checkout; resolve current remote main under the lock.
  const staleCheckout = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, env);
  assert.equal(staleCheckout.status, 0, staleCheckout.output);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'v1.3.0'));
  git('tag', 'v9.9.9');
  git('push', 'origin', 'refs/tags/v9.9.9');
  const mismatched = await command(['scripts/gitlab-release.mjs', 'prepare'], cwd, { ...env, RELEASE_TAG: 'v9.9.9' });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.output, /Tag does not match package version/);

});

test('collector adds architecture to macOS archive and keeps its signature paired', (t) => {
  const directory = fixture(t);
  const bundle = path.join(directory, 'bundle');
  fs.mkdirSync(path.join(bundle, 'macos/Trident.app'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'dmg'));
  for (const name of ['Trident.app.tar.gz', 'Trident.app.tar.gz.sig']) fs.writeFileSync(path.join(bundle, 'macos', name), 'asset');
  fs.writeFileSync(path.join(bundle, 'macos/Trident.app/ignored.exe'), 'internal');
  fs.writeFileSync(path.join(bundle, 'dmg/Trident.dmg'), 'installer');
  const destination = path.join(directory, 'assets');
  collectAssets(bundle, destination, 'darwin-aarch64');
  assert.deepEqual(fs.readdirSync(destination).sort(), ['Trident.dmg', 'Trident_aarch64.app.tar.gz', 'Trident_aarch64.app.tar.gz.sig']);
  assert.throws(() => collectAssets(bundle, destination, 'darwin-aarch64'), /Duplicate/);
});

test('collector preserves the metadata ZIP through Linux publication', t => {
  const directory = fixture(t);
  const source = path.join(directory, 'macos');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Installer_aarch64.dmg.zip'), 'archive-with-appledouble');
  const destination = path.join(directory, 'published');
  collectAssets(source, destination, 'published');
  assert.equal(fs.readFileSync(path.join(destination, 'Installer_aarch64.dmg.zip'), 'utf8'), 'archive-with-appledouble');
});

async function publicationFixture(t) {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.copyFileSync(path.join(scriptDir, 'generate-updater-json.js'), path.join(directory, 'scripts/generate-updater-json.js'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'changelog.txt'), '- New feature\n');
  const bundles = { 'darwin-aarch64': 'Trident_aarch64.app.tar.gz' };
  for (const [platform, name] of Object.entries(bundles)) {
    const folder = path.join(directory, 'release-assets', platform);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name), 'bundle');
    fs.writeFileSync(path.join(folder, `${name}.sig`), `signed-${platform}\n`);
  }
  const requests = [];
  let existing = false;
  let failedUpload = false;
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    requests.push({ method: req.method, url: req.url, data, token: req.headers['job-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/packages/') && !/^[A-Za-z0-9._+-]+$/.test(decodeURIComponent(req.url.split('/').at(-1)))) {
      res.writeHead(400); res.end('{}');
    } else if (failedUpload && req.method === 'PUT' && req.url.includes('/packages/')) {
      res.writeHead(500); res.end('{}');
    } else if (req.method === 'GET' && !existing) {
      res.writeHead(404); res.end('{}');
    } else if (req.method === 'GET') {
      res.end(JSON.stringify({ assets: { links: [{ name: 'latest.json', id: 7 }] } }));
    } else res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const execute = (extraEnv = {}) => command([path.join(scriptDir, 'gitlab-release.mjs'), 'publish'], directory, {
    CI_API_V4_URL: `${url}/api/v4`, CI_PROJECT_ID: '42', CI_PROJECT_URL: `${url}/group/app`,
    CI_JOB_TOKEN: 'fixture-token', RELEASE_TAG: 'v1.2.0', SHOULD_RELEASE: 'true', RELEASE_ASSETS_DIR: '', ...extraEnv,
  });
  return { directory, requests, url, execute, existing: () => { existing = true; }, failUpload: () => { failedUpload = true; } };
}

test('publication uploads signed manifest before creating release and retries existing links', async (t) => {
  const f = await publicationFixture(t);
  const result = await f.execute();
  assert.equal(result.status, 0, result.output);
  const release = f.requests.at(-1);
  assert.equal(release.method, 'POST');
  assert.equal(release.url, '/api/v4/projects/42/releases');
  const body = JSON.parse(release.data);
  assert.equal(body.tag_name, 'v1.2.0');
  assert.equal(body.name, 'Trident v1.2.0');
  assert.equal(body.description, '- New feature\n');
  assert.ok(body.assets.links.some((link) => link.direct_asset_path === '/latest.json'));
  const uploaded = f.requests.find((req) => req.url.endsWith('/latest.json'));
  const manifest = JSON.parse(uploaded.data);
  for (const platform of ['darwin-aarch64']) {
    assert.equal(manifest.platforms[platform].signature, `signed-${platform}`);
    assert.ok(manifest.platforms[platform].url.startsWith(`${f.url}/api/v4/projects/42/packages/generic/trident/1.2.0/`));
    assert.ok(!manifest.platforms[platform].url.includes(' '));
  }
  assert.ok(f.requests.every((req) => req.token === 'fixture-token'));
  f.requests.length = 0;
  f.existing();
  const retry = await f.execute();
  assert.equal(retry.status, 0, retry.output);

  assert.ok(f.requests.some((req) => req.method === 'PUT' && req.url.endsWith('/assets/links/7')));
  assert.equal(f.requests.at(-1).method, 'PUT');
});

test('publication uploads the DMG ZIP and explains icon-preserving extraction', async t => {
  const f = await publicationFixture(t);
  const name = 'Installer_aarch64.dmg.zip';
  fs.writeFileSync(path.join(f.directory, 'release-assets/darwin-aarch64', name), 'appledouble-archive');
  const result = await f.execute();
  assert.equal(result.status, 0, result.output);
  const upload = f.requests.find(req => req.method === 'PUT' && req.url.endsWith(`/${name}`));
  assert.equal(upload?.data, 'appledouble-archive');
  const body = JSON.parse(f.requests.at(-1).data);
  assert.ok(body.assets.links.some(link => link.direct_asset_path === `/${name}`));
  assert.match(body.description, /download the `\.dmg\.zip`/);
  const manifest = JSON.parse(f.requests.find(req => req.url.endsWith('/latest.json')).data);
  assert.ok(manifest.platforms['darwin-aarch64'].url.endsWith('.app.tar.gz'));
});

test('upload failure prevents release publication', async (t) => {
  const f = await publicationFixture(t);
  f.failUpload();
  const result = await f.execute();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /GitLab request failed: PUT 500/);
  assert.ok(!f.requests.some((req) => req.url.includes('/releases')));
});

test('missing platform signature prevents any upload', async (t) => {
  const f = await publicationFixture(t);
  fs.rmSync(path.join(f.directory, 'release-assets/darwin-aarch64/Trident_aarch64.app.tar.gz.sig'));
  const result = await f.execute();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /No updater signatures found/);
  assert.equal(f.requests.length, 0);
});

test('generateTauriConfig inherits the application updater endpoint and supports overrides', () => {
  const defaultConfig = generateTauriConfig({ CI_PROJECT_URL: 'https://gitlab.example.com/org/repo' });
  assert.equal(defaultConfig.plugins?.updater?.endpoints, undefined, 'Default builds inherit the repository updater configuration');
  const config = JSON.parse(fs.readFileSync(path.join(scriptDir, '../src-tauri/tauri.conf.json'), 'utf8'));
  assert.deepEqual(config.plugins.updater.endpoints, ['https://git.insea.io/api/v4/projects/alpha%2Fprojects%2Fchatgpt%2Ftrident/releases/permalink/latest/downloads/latest.json']);

  const customConfig = generateTauriConfig({ UPDATER_ENDPOINTS: 'https://github.com/custom/repo/releases/latest/download/latest.json' });
  assert.deepEqual(customConfig.plugins.updater.endpoints, ['https://github.com/custom/repo/releases/latest/download/latest.json']);

  const signingConfig = generateTauriConfig({ APPLE_SIGNING_IDENTITY: 'Developer ID' });
  assert.equal(signingConfig.bundle.macOS.signingIdentity, 'Developer ID');
  assert.equal(signingConfig.bundle.macOS.hardenedRuntime, true);
  assert.equal(signingConfig.build.beforeBundleCommand, 'node scripts/macos-release.mjs sign-resources');

  assert.throws(() => getTauriBuildArgs('windows-x86_64', 'x86_64-pc-windows-msvc', 'win32'), /Unsupported release platform/);
  assert.throws(() => getTauriBuildArgs('linux-x86_64', 'x86_64-unknown-linux-gnu', 'linux'), /Unsupported release platform/);
  assert.throws(() => getTauriBuildArgs('darwin-aarch64', 'aarch64-apple-darwin', 'linux'), /macOS runner/);
  assert.deepEqual(
    getTauriBuildArgs('darwin-aarch64', 'aarch64-apple-darwin', 'darwin'),
    ['scripts/tauri.mjs', 'build', '--target', 'aarch64-apple-darwin', '--config', 'gitlab-tauri.conf.json'],
  );
});



test('publication accepts imported flat assets and regenerates internal updater URLs', async (t) => {
  const f = await publicationFixture(t);
  const imported = path.join(f.directory, 'imported');
  for (const platform of ['darwin-aarch64']) {
    collectAssets(path.join(f.directory, 'release-assets', platform), imported, 'published');
  }
  fs.writeFileSync(path.join(imported, 'latest.json'), '{"platforms":{"github":"external"}}');
  fs.rmSync(path.join(f.directory, 'release-assets'), { recursive: true });
  const result = await f.execute({ RELEASE_ASSETS_DIR: imported });
  assert.equal(result.status, 0, result.output);
  const manifest = JSON.parse(f.requests.find((req) => req.url.endsWith('/latest.json')).data);
  assert.ok(manifest.platforms['darwin-aarch64'].url.startsWith(f.url));
  assert.equal(manifest.platforms.github, undefined);
});
