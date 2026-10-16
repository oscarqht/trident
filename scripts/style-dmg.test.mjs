import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { packageDmgDownload, applyDmgFileIcon, applyVolumeIcon, resolveDmgIcon, signStyledDmg } from './style-dmg.mjs';

const identity = 'Developer ID Application: Fixture (TEAM)';

test('resolves the .icns bundle icon from tauri.conf.json', () => {
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const icon = resolveDmgIcon(config);
  assert.equal(icon, path.resolve('src-tauri/icons/trident.icns'));
  assert.ok(fs.existsSync(icon));
});

test('applyVolumeIcon copies .VolumeIcon.icns and marks custom icon attributes on the mounted volume', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-volicon-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const icon = path.join(temporary, 'trident.icns');
  const mount = path.join(temporary, 'Trident');
  fs.writeFileSync(icon, 'icns-fixture');
  fs.mkdirSync(mount);
  const calls = [];
  applyVolumeIcon(mount, icon, (command, args) => calls.push([command, ...args]));
  assert.equal(fs.readFileSync(path.join(mount, '.VolumeIcon.icns'), 'utf8'), 'icns-fixture');
  assert.deepEqual(calls, [
    ['SetFile', '-c', 'icnC', path.join(mount, '.VolumeIcon.icns')],
    ['SetFile', '-a', 'C', mount],
  ]);
});

test('applyDmgFileIcon stamps a custom icon onto the .dmg file', { skip: process.platform !== 'darwin' }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-fileicon-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dmg = path.join(temporary, 'Trident.dmg');
  fs.writeFileSync(dmg, 'dmg-fixture');
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const icon = resolveDmgIcon(config);
  applyDmgFileIcon(dmg, icon);
  const attributes = execFileSync('GetFileInfo', ['-a', dmg], { encoding: 'utf8' }).trim();
  assert.ok(attributes.includes('C'), `Expected custom icon attribute 'C' on DMG, got: ${attributes}`);
});

test('restores the job keychain removed by Tauri before re-signing the styled DMG', () => {
  const calls = [];
  const keychain = '/tmp/trident-job.keychain-db';
  signStyledDmg('styled.dmg', identity, { TRIDENT_SIGNING_KEYCHAIN: keychain }, (command, args) => {
    calls.push([command, ...args]);
    return args[0] === 'list-keychains' ? '"/tmp/login.keychain-db"\n"/tmp/other-job.keychain-db"' : '';
  });
  assert.deepEqual(calls, [
    ['security', 'list-keychains', '-d', 'user'],
    ['security', 'list-keychains', '-d', 'user', '-s', keychain, '/tmp/login.keychain-db', '/tmp/other-job.keychain-db'],
    ['codesign', '--force', '--sign', identity, '--timestamp', '--keychain', keychain, 'styled.dmg'],
    ['codesign', '--verify', '--strict', 'styled.dmg'],
  ]);
});

test('local signing without a job keychain uses the normal search list', () => {
  const calls = [];
  signStyledDmg('local.dmg', identity, {}, (command, args) => calls.push([command, ...args]));
  assert.deepEqual(calls, [
    ['codesign', '--force', '--sign', identity, '--timestamp', 'local.dmg'],
    ['codesign', '--verify', '--strict', 'local.dmg'],
  ]);
});

test('a re-signing failure blocks completion and retains the error', () => {
  assert.throws(() => signStyledDmg('styled.dmg', identity, {}, () => {
    throw new Error('signing identity unavailable');
  }), /signing identity unavailable/);
});

// HTTP and GitLab artifacts transfer data bytes, not macOS extended attributes.
test('DMG ZIP restores the icon after byte-only transfer and extraction', { skip: process.platform !== 'darwin' }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-download-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dmg = path.join(temporary, 'Installer.dmg');
  const payload = Buffer.from('signed-and-stapled-dmg-bytes');
  fs.writeFileSync(dmg, payload);
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  packageDmgDownload(dmg, resolveDmgIcon(config));
  const originalFork = fs.readFileSync(`${dmg}/..namedfork/rsrc`);
  assert.ok(originalFork.length > 0);
  const downloaded = path.join(temporary, 'downloaded.zip');
  fs.writeFileSync(downloaded, fs.readFileSync(`${dmg}.zip`));
  const extracted = path.join(temporary, 'extracted');
  execFileSync('ditto', ['-x', '-k', downloaded, extracted]);
  const restored = path.join(extracted, 'Installer.dmg');
  assert.deepEqual(fs.readFileSync(restored), payload, 'signing/notarization bytes must stay unchanged');
  assert.deepEqual(fs.readFileSync(`${restored}/..namedfork/rsrc`), originalFork);
  assert.ok(execFileSync('GetFileInfo', ['-a', restored], { encoding: 'utf8' }).includes('C'));
  // A raw download of exactly the same DMG bytes cannot retain its custom icon.
  const raw = path.join(temporary, 'raw.dmg');
  fs.writeFileSync(raw, fs.readFileSync(dmg));
  assert.ok(!execFileSync('xattr', [raw], { encoding: 'utf8' }).includes('com.apple.ResourceFork'));
});
