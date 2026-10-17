import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
// Kept self-contained so the scheduled sync needs no npm dependencies.
function githubClient(repository, token) {
  return async (route, options = {}, allowed = []) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      ...options,
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', ...options.headers },
    });
    if (!response.ok && !allowed.includes(response.status)) {
      throw new Error(`GitHub request failed: ${options.method || 'GET'} ${route} ${response.status}`);
    }
    return response;
  };
}

export function githubRepository(value) {
  const repository = value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/repo or an HTTPS github.com repository URL');
  }
  return repository;
}

export function rewriteManifest(content, links, repository, tag) {
  const manifest = JSON.parse(content);
  for (const platform of Object.values(manifest.platforms || {})) {
    const asset = links.find((link) => [link.url, link.direct_asset_url].includes(platform.url));
    if (!asset) throw new Error('Updater manifest references an unknown release asset');
    platform.url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  }
  return JSON.stringify(manifest, null, 2) + '\n';
}

export async function syncGithub({ env = process.env, send = fetch,
  git = (args, options = {}) => execFileSync('git', args, { stdio: 'inherit', ...options }),
  request,
} = {}) {
  const missing = ['GITHUB_REPOSITORY', 'GITHUB_TOKEN'].filter((key) => !env[key]?.trim());
  if (missing.length) {
    console.warn(`WARNING: GitHub sync skipped; missing CI/CD variables: ${missing.join(', ')}. Job succeeds without syncing.`);
    return;
  }
  const repository = githubRepository(env.GITHUB_REPOSITORY);
  request ||= githubClient(repository, env.GITHUB_TOKEN);
  const projectApi = `${env.CI_API_V4_URL}/projects/${encodeURIComponent(env.CI_PROJECT_ID)}`;
  const gitlab = async (url, allowed = []) => {
    // Inspect every redirect before forwarding the job token.
    for (let redirects = 0; ; redirects++) {
      const target = new URL(url);
      const base = new URL(projectApi);
      const permitted = ['releases', 'packages/generic'].some((route) =>
        target.pathname === `${base.pathname}/${route}` || target.pathname.startsWith(`${base.pathname}/${route}/`));
      if (target.origin !== base.origin || target.username || target.password || !permitted) {
        throw new Error('Release assets must be hosted in this project Generic Package Registry or release API');
      }
      const response = await send(target.href, { headers: { 'JOB-TOKEN': env.CI_JOB_TOKEN }, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('GitLab redirect is missing Location');
        if (redirects >= 5) throw new Error('Too many GitLab redirects (maximum 5)');
        url = new URL(location, target).href;
        continue;
      }
      if (!response.ok && !allowed.includes(response.status)) throw new Error(`GitLab download failed: HTTP ${response.status}`);
      return response;
    }
  };
  const response = await gitlab(`${projectApi}/releases/permalink/latest`, [404]);
  const release = response.status === 404 ? null : await response.json();
  const tag = release?.tag_name;
  if (release && (!tag || tag.startsWith('-') || /[\s~^:?*\[\\]/.test(tag))) throw new Error('Invalid release tag');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-sync-'));
  try {
    const askpass = path.join(temporary, 'askpass.sh');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) echo "$GITHUB_TOKEN";; esac\n', { mode: 0o700 });
    git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    if (tag) git(['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
    git(['-c', 'credential.helper=', 'push', '--atomic', `https://github.com/${repository}.git`,
      'refs/remotes/origin/main:refs/heads/main', ...(tag ? [`refs/tags/${tag}:refs/tags/${tag}`] : [])],
    { env: { ...env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' } });
    if (!release) {
      console.log('Synced main; no published GitLab release to copy.');
      return;
    }
    const links = release.assets?.links || [];
    const names = new Set();
    let body = release.description || '';
    const files = [];
    for (const link of links) {
      if (!link.name || path.basename(link.name) !== link.name || ['.', '..'].includes(link.name) || names.has(link.name)) {
        throw new Error('Invalid or duplicate release asset name');
      }
      names.add(link.name);
      const file = path.join(temporary, link.name);
      const download = await gitlab(link.url);
      await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(file));
      if (link.name === 'latest.json') fs.writeFileSync(file, rewriteManifest(fs.readFileSync(file, 'utf8'), links, repository, tag));
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      files.push({ name: link.name, file, digest: `sha256:${hash.digest('hex')}` });
      const publicUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(link.name)}`;
      for (const url of [link.direct_asset_url, link.url].filter(Boolean)) body = body.split(url).join(publicUrl);
    }
    const existing = await request(`/releases/tags/${encodeURIComponent(tag)}`, {}, [404]);
    let target = existing.status === 404 ? null : await existing.json();
    const metadata = { tag_name: tag, name: release.name, body, prerelease: false };
    if (!target) target = await (await request('/releases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...metadata, draft: true }),
    })).json();
    // Paginate independently: the embedded release assets list may be truncated.
    const assets = [];
    for (let page = 1; ; page++) {
      const batch = await (await request(`/releases/${target.id}/assets?per_page=100&page=${page}`)).json();
      assets.push(...batch);
      if (batch.length < 100) break;
    }
    for (const file of files) {
      const previous = assets.find((asset) => asset.name === file.name);
      if (previous?.digest === file.digest) continue;
      if (previous) await request(`/releases/assets/${previous.id}`, { method: 'DELETE' });
      const uploaded = await send(`https://uploads.github.com/repos/${repository}/releases/${target.id}/assets?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file.file).size),
          'X-GitHub-Api-Version': '2026-03-10' },
        body: fs.createReadStream(file.file), duplex: 'half', signal: AbortSignal.timeout(600_000),
      });
      if (!uploaded.ok) throw new Error(`GitHub asset upload failed: HTTP ${uploaded.status}`);
    }
    await request(`/releases/${target.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...metadata, draft: false, make_latest: 'true' }) });
    console.log(`Synced main and release ${tag} (${files.length} assets) to GitHub.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await syncGithub();
}
