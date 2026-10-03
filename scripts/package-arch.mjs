import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const tagArg = args.find((a) => !a.startsWith('--'));

let tag = tagArg ? tagArg.trim() : null;

// If tag not provided, read version from package.json
if (!tag) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  tag = `v${pkg.version}`;
}

const version = tag.replace(/^v/, '');
console.log(`Packaging Arch Linux package (.pkg.tar.zst) for ${tag} (version ${version})...`);

const debDir = path.resolve('src-tauri/target/release/bundle/deb');
if (!fs.existsSync(debDir)) {
  console.error(`Debian bundle directory not found: ${debDir}`);
  process.exit(1);
}

const debFiles = fs.readdirSync(debDir).filter((f) => f.endsWith('.deb'));
if (debFiles.length === 0) {
  console.error(`No .deb package found in ${debDir}`);
  process.exit(1);
}

const debPath = path.join(debDir, debFiles[0]);
console.log(`Using deb package: ${debPath}`);

const workDir = path.resolve('src-tauri/target/release/bundle/arch-pkg');
if (fs.existsSync(workDir)) {
  fs.rmSync(workDir, { recursive: true, force: true });
}
fs.mkdirSync(workDir, { recursive: true });

// Extract .deb
execSync(`ar x "${debPath}"`, { cwd: workDir, stdio: 'inherit' });

const pkgRoot = path.join(workDir, 'pkgroot');
fs.mkdirSync(pkgRoot, { recursive: true });

const dataTar = fs.readdirSync(workDir).find((f) => f.startsWith('data.tar'));
if (!dataTar) {
  console.error('Could not find data.tar archive in extracted deb');
  process.exit(1);
}

execSync(`tar -xf "${path.join(workDir, dataTar)}" -C "${pkgRoot}"`, { stdio: 'inherit' });

// Calculate total installed size in bytes
function calculateDirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += calculateDirSize(fullPath);
    } else if (entry.isFile()) {
      size += fs.statSync(fullPath).size;
    }
  }
  return size;
}

const totalSize = calculateDirSize(pkgRoot);
const buildDate = Math.floor(Date.now() / 1000);

const pkgInfo = `# Generated for Arch Linux / Omarchy Linux
pkgname = trident
pkgbase = trident
pkgver = ${version}-1
pkgdesc = A modern, web-based Git client
url = https://github.com/oscarqht/trident
builddate = ${buildDate}
packager = Trident <https://github.com/oscarqht/trident>
size = ${totalSize}
arch = x86_64
license = MIT
depend = webkit2gtk-4.1
depend = gtk3
depend = libayatana-appindicator
`;

fs.writeFileSync(path.join(pkgRoot, '.PKGINFO'), pkgInfo);

const outPkgFileName = `trident-${version}-1-x86_64.pkg.tar.zst`;
const outPkgPath = path.resolve(process.cwd(), outPkgFileName);

// Create .pkg.tar.zst archive
console.log(`Compressing ${outPkgFileName}...`);
execSync(`tar --zstd -cf "${outPkgPath}" .PKGINFO usr`, {
  cwd: pkgRoot,
  stdio: 'inherit',
});

console.log(`Successfully built Arch Linux package: ${outPkgPath}`);

if (isDryRun || !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.log('Skipping release upload (dry-run or no GitHub token).');
  process.exit(0);
}

console.log(`Uploading ${outPkgFileName} to release ${tag}...`);
try {
  execSync(`gh release upload "${tag}" "${outPkgPath}" --clobber`, {
    stdio: 'inherit',
  });
  console.log(`Successfully uploaded ${outPkgFileName}!`);
} catch (e) {
  console.error(`Failed to upload to release: ${e.message}`);
  process.exit(1);
}
