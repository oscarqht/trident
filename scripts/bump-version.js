import fs from 'node:fs';
import { execSync } from 'node:child_process';

const isDryRun = process.argv.includes('--dry-run');
const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version || '0.1.0';
const outputFile = process.env.RELEASE_OUTPUT || process.env.GITHUB_OUTPUT;

function publishRelease(tag) {
  const localTag = execSync(`git tag --list ${tag}`, { encoding: 'utf8' }).trim();
  if (!localTag) {
    execSync(`git tag ${tag}`);
  } else if (execSync(`git rev-parse ${tag}^{commit}`, { encoding: 'utf8' }).trim() !==
    execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()) {
    throw new Error(`${tag} already points to a different commit.`);
  }
  // Publish the commit and tag together so tag rejection cannot leave a partial release.
  execSync(`git push --atomic origin HEAD:refs/heads/main refs/tags/${tag}`, { stdio: 'inherit' });
  if (outputFile) {
    fs.appendFileSync(outputFile, `tag=${tag}\nversion=${tag.slice(1)}\nshould_release=true\n`);
  }
}

// 1. Check if the last commit was an automated release commit
let lastCommitMsg = '';
try {
  lastCommitMsg = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
} catch (e) {
  console.warn('Could not read git log:', e.message);
}
if (lastCommitMsg.includes('[skip ci]') || lastCommitMsg.includes('chore(release):')) {
  const releaseTag = lastCommitMsg.match(/^chore\(release\): (v\d+\.\d+\.\d+) \[skip ci\](?:\n|$)/)?.[1];
  if (releaseTag && releaseTag.slice(1) === packageVersion &&
    !execSync(`git ls-remote --refs origin refs/tags/${releaseTag}`, { encoding: 'utf8' }).trim()) {
    console.log(`Recovering missing release tag: ${releaseTag}`);
    if (!isDryRun) publishRelease(releaseTag);
    process.exit(0);
  }
  console.log('Automated release commit detected. Skipping version bump.');
  if (outputFile) {
    fs.appendFileSync(outputFile, 'should_release=false\n');
  }
  process.exit(0);
}

// 2. Use the newer version: a prior failed tag push may leave package.json ahead of the tags.
let currentVersion = packageVersion;
try {
  const latestTag = execSync('git describe --tags --abbrev=0', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  const cleanTag = latestTag.replace(/^v/, '');
  if (/^\d+\.\d+\.\d+$/.test(cleanTag)) {
    const tagParts = cleanTag.split('.').map(Number);
    const packageParts = packageVersion.split('.').map(Number);
    const difference = tagParts.findIndex((part, index) => part !== packageParts[index]);
    if (difference !== -1 && tagParts[difference] > packageParts[difference]) currentVersion = cleanTag;
  }
} catch {
  // No git tags exist yet, fallback to package.json version
}

// 3. Bump minor version: major.(minor + 1).0
const parts = currentVersion.split('.').map(Number);
const major = isNaN(parts[0]) ? 0 : parts[0];
const minor = isNaN(parts[1]) ? 1 : parts[1];
const nextVersion = `${major}.${minor + 1}.0`;
const nextTag = `v${nextVersion}`;

console.log(`Current: ${currentVersion} -> Next: ${nextVersion} (${nextTag})`);

if (isDryRun) {
  console.log('[dry-run] Version bump verified successfully.');
  process.exit(0);
}

// 4. Update package.json, tauri.conf.json & Cargo.toml
execSync(`npm version ${nextVersion} --no-git-tag-version`, { stdio: 'inherit' });

const tauriConfPath = 'src-tauri/tauri.conf.json';
if (fs.existsSync(tauriConfPath)) {
  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  conf.version = nextVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + '\n');
}

const cargoTomlPath = 'src-tauri/Cargo.toml';
if (fs.existsSync(cargoTomlPath)) {
  let toml = fs.readFileSync(cargoTomlPath, 'utf8');
  toml = toml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
  fs.writeFileSync(cargoTomlPath, toml);
}

// 5. Commit, then atomically publish the commit and tag
execSync(process.env.GITLAB_CI ? 'git config user.name "gitlab-ci[bot]"' : 'git config user.name "github-actions[bot]"');
execSync(process.env.GITLAB_CI ? 'git config user.email "gitlab-ci@localhost"' : 'git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
execSync('git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml');
execSync(`git commit -m "chore(release): ${nextTag} [skip ci]"`);
publishRelease(nextTag);
