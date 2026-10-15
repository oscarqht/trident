import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateCredentials, verifyReleaseBundle, withSigningKeychain } from './macos-release.mjs';

const env = process.env;
const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { stdio: 'inherit', ...options });
  } catch (error) {
    // execFileSync errors include arguments, which can contain keychain passwords or remote credentials.
    throw new Error(`${command} failed (exit ${error.status ?? 'unknown'})`);
  }
};
const node = (script, args = [], options = {}) => run(process.execPath, [`scripts/${script}`, ...args], options);
const validateTag = (tag) => {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Release tag must be vMAJOR.MINOR.PATCH');
  return tag;
};

export function collectAssets(bundleDir, destination, platform) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(bundleDir, { withFileTypes: true })) {
    const source = path.join(bundleDir, entry.name);
    if (entry.isDirectory()) {
      // The unpacked .app is distributed through its signed archive.
      if (!entry.name.endsWith('.app')) collectAssets(source, destination, platform);
    } else if (/\.(dmg|app\.tar\.gz)(\.sig)?$/.test(entry.name)) {
      const archName = platform === 'darwin-aarch64'
        ? entry.name.replace(/\.app\.tar\.gz/, '_aarch64.app.tar.gz') : entry.name;
      const name = archName.replace(/[^A-Za-z0-9._+-]/g, '_');
      if (fs.existsSync(path.join(destination, name))) throw new Error(`Duplicate release asset: ${name}`);
      fs.copyFileSync(source, path.join(destination, name));
    }
  }
}

function prepare() {
  let tag = env.CI_COMMIT_TAG || env.RELEASE_TAG;
  if (!tag) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-gitlab-'));
    const output = path.join(temporary, 'version.env');
    const askpass = path.join(temporary, 'askpass.sh');
    const originalRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    // Keep credentials out of the remote URL and command output.
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) echo "$RELEASE_GIT_USER";; *) echo "$RELEASE_GIT_TOKEN";; esac\n', { mode: 0o700 });
    const token = env.CI_RELEASE_TOKEN || env.CI_JOB_TOKEN;
    if (!token) throw new Error('CI_RELEASE_TOKEN or push-enabled CI_JOB_TOKEN is required');
    try {
      run('git', ['remote', 'set-url', 'origin', `${env.CI_PROJECT_URL}.git`]);
      const gitEnv = { ...env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0',
        RELEASE_GIT_USER: env.CI_RELEASE_TOKEN ? 'oauth2' : 'gitlab-ci-token', RELEASE_GIT_TOKEN: token };
      run('git', ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', '--tags'], { env: gitEnv });
      run('git', ['checkout', '--detach', 'refs/remotes/origin/main']);
      node('bump-version.js', [], { env: { ...gitEnv, RELEASE_OUTPUT: output } });
      const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
      if (values.should_release !== 'true') {
        const headTag = execFileSync('git', ['log', '-1', '--pretty=%B'], { encoding: 'utf8' }).match(/^chore\(release\): (v\d+\.\d+\.\d+) \[skip ci\]/)?.[1];
        if (!headTag) {
          fs.writeFileSync('release.env', 'SHOULD_RELEASE=false\n');
          return;
        }
        tag = headTag;
      } else {
        tag = values.tag;
      }
    } finally {
      run('git', ['remote', 'set-url', 'origin', originalRemote], { stdio: 'ignore' });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  validateTag(tag);
  run('git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  run('git', ['checkout', '--detach', tag]);
  if (tag !== `v${JSON.parse(fs.readFileSync('package.json', 'utf8')).version}`) throw new Error('Tag does not match package version');
  node('generate-changelog.js', [tag, '--out', 'changelog.txt']);
  fs.writeFileSync('release.env', `RELEASE_TAG=${tag}\nSHOULD_RELEASE=true\n`);
}

export function generateTauriConfig(customEnv = env) {
  const config = {};
  if (customEnv.UPDATER_ENDPOINTS) {
    config.plugins = { updater: { endpoints: customEnv.UPDATER_ENDPOINTS.split(',').map((u) => u.trim()) } };
  }
  // Explicitly honor the certificate identity over the repository's ad-hoc default.
  if (customEnv.APPLE_SIGNING_IDENTITY) {
    config.build = { beforeBundleCommand: 'node scripts/macos-release.mjs sign-resources' };
    config.bundle = { macOS: { signingIdentity: customEnv.APPLE_SIGNING_IDENTITY, hardenedRuntime: true } };
  }
  return config;
}

export function getTauriBuildArgs(platform, target, hostPlatform = process.platform) {
  if (platform !== 'darwin-aarch64' || target !== 'aarch64-apple-darwin') {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
  if (hostPlatform !== 'darwin') throw new Error('macOS builds require a macOS runner');
  return ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--target', target, '--config', 'gitlab-tauri.conf.json'];
}

async function build(platform) {
  if (env.SHOULD_RELEASE === 'false') return;
  validateTag(env.RELEASE_TAG);
  const targets = { 'darwin-aarch64': 'aarch64-apple-darwin' };
  const target = targets[platform];
  if (!target) throw new Error(`Unsupported platform: ${platform}`);
  validateCredentials(env);
  run('git', ['fetch', 'origin', `refs/tags/${env.RELEASE_TAG}:refs/tags/${env.RELEASE_TAG}`]);
  run('git', ['checkout', '--detach', env.RELEASE_TAG]);
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (env.RELEASE_TAG !== `v${version}`) throw new Error('Tag does not match package version');
  env.TAURI_SIGNING_PRIVATE_KEY ||= env.TAURI_PRIVATE_KEY;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ||= env.TAURI_KEY_PASSWORD;
  if (!env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required');
  getTauriBuildArgs(platform, target); // Reject cross builds before installing dependencies.
  run('rustup', ['toolchain', 'install', 'stable', '--profile', 'minimal']);
  run('rustup', ['default', 'stable']);
  run('rustup', ['target', 'add', target]);
  run('npm', ['ci']);
  run('npm', ['run', 'build']);
  run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
  const config = generateTauriConfig(env);
  fs.writeFileSync('gitlab-tauri.conf.json', JSON.stringify(config));
  withSigningKeychain(env, signingEnv => {
    run(process.execPath, getTauriBuildArgs(platform, target), { env: signingEnv });
    const bundle = `src-tauri/target/${target}/release/bundle`;
    verifyReleaseBundle(bundle, signingEnv);
    const destination = `release-assets/${platform}`;
    collectAssets(bundle, destination, platform);
    if (!fs.readdirSync(destination).some((name) => name.endsWith('.sig'))) throw new Error('Build did not produce signed updater artifacts');
  });
}

async function publish() {
  if (env.SHOULD_RELEASE === 'false') return;
  const tag = validateTag(env.RELEASE_TAG);
  const projectApi = `${env.CI_API_V4_URL}/projects/${encodeURIComponent(env.CI_PROJECT_ID)}`;
  const packageUrl = `${projectApi}/packages/generic/trident/${tag.slice(1)}`;
  const headers = { 'JOB-TOKEN': env.CI_JOB_TOKEN };
  async function request(url, options = {}, allowed = []) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok && !allowed.includes(response.status)) throw new Error(`GitLab request failed: ${options.method || 'GET'} ${response.status}`);
    return response;
  }
  const assets = env.RELEASE_ASSETS_DIR || 'release-assets/all';
  if (!env.RELEASE_ASSETS_DIR) {
    fs.rmSync(assets, { recursive: true, force: true });
    for (const platform of ['darwin-aarch64']) collectAssets(`release-assets/${platform}`, assets, 'published');
  }
  node('generate-updater-json.js', [tag], { env: { ...env, RELEASE_ASSETS_DIR: assets, RELEASE_ASSETS_BASE_URL: packageUrl } });
  const manifest = JSON.parse(fs.readFileSync('latest.json', 'utf8'));
  for (const platform of ['darwin-aarch64']) {
    if (!manifest.platforms[platform]?.signature) throw new Error(`Missing updater platform: ${platform}`);
  }
  fs.copyFileSync('latest.json', `${assets}/latest.json`);
  const links = [];
  for (const name of fs.readdirSync(assets)) {
    const url = `${packageUrl}/${encodeURIComponent(name)}`;
    await request(url, { method: 'PUT', body: fs.createReadStream(`${assets}/${name}`), duplex: 'half' });
    links.push({ name, url, direct_asset_path: `/${name}`, link_type: 'package' });
  }
  const releaseUrl = `${projectApi}/releases/${encodeURIComponent(tag)}`;
  const existing = await request(releaseUrl, {}, [404]);
  const body = { name: `Trident ${tag}`, description: fs.readFileSync('changelog.txt', 'utf8') };
  if (existing.status === 404) {
    await request(`${projectApi}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, tag_name: tag, assets: { links } }) });
  } else {
    const release = await existing.json();
    // Retrying publication updates links rather than failing on an existing release.
    for (const link of links) {
      const prior = release.assets.links.find((asset) => asset.name === link.name);
      await request(`${releaseUrl}/assets/links${prior ? `/${prior.id}` : ''}`, { method: prior ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link) });
    }
    await request(releaseUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  console.log(`Published ${env.CI_PROJECT_URL}/-/releases/${tag}`);

}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, platform] = process.argv.slice(2);
  if (command === 'prepare') prepare();
  else if (command === 'build') await build(platform);
  else if (command === 'publish') await publish();
  else throw new Error('Usage: node scripts/gitlab-release.mjs prepare|build <platform>|publish');
}
