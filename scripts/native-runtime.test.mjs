import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeRuntime, requireMacosArm64 } from './native-runtime.mjs';

test('Apple Silicon release rejects Intel Node even on macOS', () => {
  assert.throws(() => requireMacosArm64('darwin', 'x64'), /arm64 Node/);
  assert.throws(() => requireMacosArm64('linux', 'arm64'), /macOS/);
  assert.doesNotThrow(() => requireMacosArm64('darwin', 'arm64'));
});

test('packaged keytar must contain the runtime architecture before it is loaded', () => {
  let loaded = false;
  assert.throws(() => verifyNativeRuntime('/fixture', 'arm64', () => 'x86_64', () => { loaded = true; }), /keytar.*arm64/);
  assert.equal(loaded, false);
  assert.doesNotThrow(() => verifyNativeRuntime('/fixture', 'arm64', () => 'x86_64 arm64', () => { loaded = true; }));
  assert.equal(loaded, true);
});

test('native load failures stop packaging even when architecture matches', () => {
  assert.throws(() => verifyNativeRuntime('/fixture', 'arm64', () => 'arm64', () => { throw new Error('dlopen failed'); }), /dlopen failed/);
});
