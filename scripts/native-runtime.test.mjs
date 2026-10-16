import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeRuntime, requireMacos } from './native-runtime.mjs';

test('Apple Silicon release requires macOS but allows an Intel build host', () => {
  assert.throws(() => requireMacos('linux'), /macOS/);
  assert.doesNotThrow(() => requireMacos('darwin'));
});

test('cross-built keytar is checked by architecture without loading it on an Intel host', () => {
  let loaded = false;
  const load = () => { loaded = true; };
  assert.throws(() => verifyNativeRuntime('/fixture', 'arm64', 'x64', () => 'x86_64', load), /keytar.*arm64/);
  assert.doesNotThrow(() => verifyNativeRuntime('/fixture', 'arm64', 'x64', () => 'arm64', load));
  assert.equal(loaded, false);
});

test('packaged keytar must contain the runtime architecture before it is loaded', () => {
  let loaded = false;
  assert.throws(() => verifyNativeRuntime('/fixture', 'arm64', 'arm64', () => 'x86_64', () => { loaded = true; }), /keytar.*arm64/);
  assert.equal(loaded, false);
  assert.doesNotThrow(() => verifyNativeRuntime('/fixture', 'arm64', 'arm64', () => 'x86_64 arm64', () => { loaded = true; }));
  assert.equal(loaded, true);
});

test('native load failures stop packaging even when architecture matches', () => {
  assert.throws(() => verifyNativeRuntime('/fixture', 'arm64', 'arm64', () => 'arm64', () => { throw new Error('dlopen failed'); }), /dlopen failed/);
});

test('release addon supports Intel Node even when the desktop app targets ARM', () => {
  for (const host of ['x64', 'arm64']) {
    for (const singleSlice of ['arm64', 'x86_64']) {
      assert.throws(() => verifyNativeRuntime('/fixture', 'universal', host, () => singleSlice, () => {}), /keytar.*universal/);
    }
    let loaded = false;
    verifyNativeRuntime('/fixture', 'universal', host, () => 'x86_64 arm64', () => { loaded = true; });
    assert.equal(loaded, true);
  }
});
