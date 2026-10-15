import test from 'node:test';
import assert from 'node:assert/strict';
import { signStyledDmg } from './style-dmg.mjs';

const identity = 'Developer ID Application: Fixture (TEAM)';

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
