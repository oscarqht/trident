import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getAppDataDir, getAugmentedPath, getAugmentedEnv, ensureAugmentedProcessPath } from './platform-utils';

describe('getAppDataDir', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  const mockHomeDir = '/home/user';

  // Mock os.homedir
  // We need to use mock.method on the os object imported by the system
  const homedirMock = mock.method(os, 'homedir', () => mockHomeDir);

  after(() => {
    // Restore
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
    homedirMock.mock.restore();
  });

  it('should return correct path for Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\User\\AppData\\Roaming';

    const expected = path.join('C:\\Users\\User\\AppData\\Roaming', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should use fallback for Windows if APPDATA is not set', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.APPDATA;

    const expected = path.join(mockHomeDir, 'AppData', 'Roaming', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should return correct path for macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const expected = path.join(mockHomeDir, 'Library', 'Application Support', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should return correct path for Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.XDG_CONFIG_HOME;

    const expected = path.join(mockHomeDir, '.config', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should use XDG_CONFIG_HOME for Linux if set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_CONFIG_HOME = '/custom/config';

    const expected = path.join('/custom/config', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });
});

describe('augmented path and environment', () => {
  it('should return a non-empty augmented PATH', () => {
    const augmentedPath = getAugmentedPath();
    assert.ok(typeof augmentedPath === 'string' && augmentedPath.length > 0);
  });

  it('should include bun/bin in augmented path if it exists locally', () => {
    const homeDir = os.homedir();
    const bunBin = path.join(homeDir, '.bun', 'bin');
    if (fs.existsSync(bunBin)) {
      const augmentedPath = getAugmentedPath();
      const parts = augmentedPath.split(path.delimiter);
      assert.ok(
        parts.includes(bunBin),
        `Expected ${augmentedPath} to include ${bunBin}`
      );
    }
  });

  it('should return augmented environment with PATH and BUN_INSTALL', () => {
    const env = getAugmentedEnv();
    assert.ok(env.PATH);
    const homeDir = os.homedir();
    const bunDir = path.join(homeDir, '.bun');
    if (fs.existsSync(bunDir)) {
      assert.strictEqual(env.BUN_INSTALL, bunDir);
    }
  });

  it('should update process.env.PATH when ensureAugmentedProcessPath is called', () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      ensureAugmentedProcessPath();
      assert.ok(process.env.PATH.length > 0);
      const homeDir = os.homedir();
      const bunBin = path.join(homeDir, '.bun', 'bin');
      if (fs.existsSync(bunBin)) {
        assert.ok(process.env.PATH.split(path.delimiter).includes(bunBin));
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('should strip TRIDENT_PARENT_PID and trident-parent-watchdog from NODE_OPTIONS', () => {
    const origPid = process.env.TRIDENT_PARENT_PID;
    const origNodeOptions = process.env.NODE_OPTIONS;
    try {
      process.env.TRIDENT_PARENT_PID = '12345';
      process.env.NODE_OPTIONS = '--require "/path/to/trident-parent-watchdog.cjs"';
      const env = getAugmentedEnv();
      assert.strictEqual(env.TRIDENT_PARENT_PID, undefined);
      assert.strictEqual(env.NODE_OPTIONS, undefined);

      process.env.NODE_OPTIONS = '--max-old-space-size=4096 --require "/tmp/trident-parent-watchdog.cjs"';
      const env2 = getAugmentedEnv();
      assert.strictEqual(env2.TRIDENT_PARENT_PID, undefined);
      assert.strictEqual(env2.NODE_OPTIONS, '--max-old-space-size=4096');
    } finally {
      if (origPid === undefined) delete process.env.TRIDENT_PARENT_PID;
      else process.env.TRIDENT_PARENT_PID = origPid;
      if (origNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = origNodeOptions;
    }
  });
});
