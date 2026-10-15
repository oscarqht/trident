import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCredentials, verifyAndNotarize, verifyUpdaterKeyMatch, signNativeResources, runStapler, run } from './macos-release.mjs';

const env = {
  APPLE_CERTIFICATE: 'base64-p12', APPLE_CERTIFICATE_PASSWORD: 'certificate-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAM123)',
  APPLE_ID: 'developer@example.com', APPLE_PASSWORD: 'app-specific-password', APPLE_TEAM_ID: 'TEAM123',
};
const details = `Authority=${env.APPLE_SIGNING_IDENTITY}\nTeamIdentifier=TEAM123\nCodeDirectory flags=0x10000(runtime)`;

test('requires notarization credentials and a Developer ID certificate', () => {
  assert.throws(() => validateCredentials({ ...env, APPLE_PASSWORD: '' }), /APPLE_PASSWORD/);
  assert.throws(() => validateCredentials({ ...env, APPLE_SIGNING_IDENTITY: '-' }), /Developer ID Application/);
  assert.doesNotThrow(() => validateCredentials(env));
});

function fakeRunner(calls, status = 'Accepted', identity = details) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === 'codesign' && args[0] === '--display') return identity;
    if (args[0] === 'notarytool') return JSON.stringify({ id: 'submission-id', status });
    return '';
  };
}

test('checks stapled app, notarizes DMG, staples it, then assesses final installer', () => {
  const calls = [];
  verifyAndNotarize('Trident.app', 'Trident.dmg', env, fakeRunner(calls));
  const submit = calls.findIndex(call => call[1] === 'notarytool');
  assert.ok(calls.slice(0, submit).some(call => call.join(' ') === 'xcrun stapler validate Trident.app'));
  assert.deepEqual(calls.slice(submit + 1).map(call => call.slice(0, 3)), [
    ['xcrun', 'stapler', 'staple'], ['xcrun', 'stapler', 'validate'], ['spctl', '--assess', '--type'],
  ]);
  assert.ok(calls.at(-1).includes('context:primary-signature'));
});

test('rejected notarization never staples the DMG', () => {
  const calls = [];
  assert.throws(() => verifyAndNotarize('app', 'dmg', env, fakeRunner(calls, 'Invalid')), /not accepted/);
  assert.ok(!calls.some(call => call[2] === 'staple'));
});

test('wrong team or missing hardened runtime stops before submission', () => {
  for (const identity of [details.replace('TeamIdentifier=TEAM123', 'TeamIdentifier=OTHER'), details.replace('(runtime)', '')]) {
    const calls = [];
    assert.throws(() => verifyAndNotarize('app', 'dmg', env, fakeRunner(calls, 'Accepted', identity)), /hardened runtime/);
    assert.ok(!calls.some(call => call[1] === 'notarytool'));
  }
});

test('failed app Gatekeeper assessment prevents DMG submission', () => {
  const calls = [];
  const fake = fakeRunner(calls);
  assert.throws(() => verifyAndNotarize('app', 'dmg', env, (command, args) => {
    if (command === 'spctl') throw new Error('Gatekeeper rejected app');
    return fake(command, args);
  }), /Gatekeeper rejected/);
  assert.ok(!calls.some(call => call[1] === 'notarytool'));
});

test('ad-hoc DMG signature prevents notarization and publication', () => {
  const calls = [];
  const fake = fakeRunner(calls);
  assert.throws(() => verifyAndNotarize('app', 'dmg', env, (command, args) => {
    if (command === 'codesign' && args[0] === '--display' && args.at(-1) === 'dmg') return 'Signature=adhoc';
    return fake(command, args);
  }), /DMG must have/);
  assert.ok(!calls.some(call => call[1] === 'notarytool'));
});


test('command failures preserve Apple diagnostics while redacting the password', () => {
  const args = ['notarytool', 'submit', 'app.dmg', '--password', env.APPLE_PASSWORD];
  assert.throws(() => run('xcrun', args, () => ({
    status: 1, stdout: '', stderr: `HTTP 401: Invalid credentials: ${env.APPLE_PASSWORD}`,
  })), error => {
    assert.match(error.message, /HTTP 401: Invalid credentials/);
    assert.ok(!error.message.includes(env.APPLE_PASSWORD));
    assert.ok(!error.message.includes('--password'));
    return true;
  });
});

test('notarization rejection includes the Apple log and never staples', () => {
  for (const nonzeroExit of [false, true]) {
    const calls = [];
    const fake = fakeRunner(calls, 'Invalid');
    assert.throws(() => verifyAndNotarize('app', 'dmg', env, (command, args) => {
      if (args[0] === 'notarytool' && args[1] === 'log') {
        calls.push([command, ...args]);
        return JSON.stringify({ issues: [{ message: 'The signature does not include a secure timestamp.' }] });
      }
      if (nonzeroExit && args[0] === 'notarytool' && args[1] === 'submit') {
        const error = new Error('notarytool submit exited 1');
        error.stdout = JSON.stringify({ id: 'submission-id', status: 'Invalid' });
        throw error;
      }
      return fake(command, args);
    }), /secure timestamp/);
    assert.ok(calls.some(call => call[1] === 'notarytool' && call[2] === 'log' && call[3] === 'submission-id'));
    assert.ok(!calls.some(call => call[2] === 'staple'));
  }
});


test('updater signature must belong to the embedded public key', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-signature-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pub = Buffer.alloc(42); pub.write('Ed'); pub.fill(7, 2, 10);
  const sig = Buffer.alloc(74); sig.write('ED'); sig.fill(7, 2, 10);
  const publicKey = Buffer.from(`untrusted comment: key\n${pub.toString('base64')}\n`).toString('base64');
  const filename = path.join(directory, 'Trident.app.tar.gz.sig');
  const write = () => fs.writeFileSync(filename, Buffer.from(`untrusted comment: signature\n${sig.toString('base64')}\ntrusted comment: fixture\n`).toString('base64'));
  write();
  assert.doesNotThrow(() => verifyUpdaterKeyMatch(filename, publicKey));
  sig.fill(8, 2, 10); write();
  assert.throws(() => verifyUpdaterKeyMatch(filename, publicKey), /does not match/);
  fs.writeFileSync(filename, 'invalid');
  assert.throws(() => verifyUpdaterKeyMatch(filename, publicKey), /Invalid Tauri/);
});


test('signs native modules and Mach-O binaries before the outer app is sealed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-native-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'keytar'));
  const module = path.join(root, 'keytar/keytar.node');
  fs.writeFileSync(module, Buffer.from('cffaedfe01020304', 'hex'));
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log("server")');
  const calls = [];
  assert.deepEqual(signNativeResources(root, env, (command, args) => { calls.push([command, ...args]); }), [module]);
  assert.deepEqual(calls, [
    ['codesign', '--force', '--timestamp', '--options', 'runtime', '--sign', env.APPLE_SIGNING_IDENTITY, module],
    ['codesign', '--verify', '--strict', '--verbose=2', module],
  ]);
  assert.throws(() => signNativeResources(root, env, () => { throw new Error('nested signature failed'); }), /nested signature failed/);
});


test('retries a lost Apple CloudKit connection during DMG stapling without resubmitting notarization', () => {
  const calls = [];
  const sleeps = [];
  const fake = fakeRunner(calls);
  let attempts = 0;
  verifyAndNotarize('app', 'dmg', env, (command, args) => {
    if (args[0] === 'stapler' && args[1] === 'staple' && ++attempts === 1) {
      calls.push([command, ...args]);
      throw new Error('xcrun stapler failed (exit 68). NSURLErrorDomain Code=-1005 "The network connection was lost."');
    }
    return fake(command, args);
  }, milliseconds => sleeps.push(milliseconds));
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(calls.filter(call => call[1] === 'notarytool' && call[2] === 'submit').length, 1);
  assert.ok(calls.at(-1).includes('context:primary-signature'));
});

test('stapler retries stop after three transient failures and retain Apple diagnostics', () => {
  const sleeps = [];
  let attempts = 0;
  assert.throws(() => runStapler('staple', 'dmg', () => {
    attempts++;
    throw new Error('NSURLErrorDomain Code=-1005 "The network connection was lost."');
  }, milliseconds => sleeps.push(milliseconds)), /Code=-1005/);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [5000, 15000]);
});

test('stapler does not retry permanent ticket or validation failures', () => {
  let attempts = 0;
  assert.throws(() => runStapler('validate', 'app', () => {
    attempts++;
    throw new Error('The staple and validate action failed! Error 65. Ticket is invalid.');
  }, () => assert.fail('permanent errors must not wait')), /Ticket is invalid/);
  assert.equal(attempts, 1);
});

test('app ticket validation also recovers from a transient Apple timeout', () => {
  let attempts = 0;
  const result = runStapler('validate', 'app', () => {
    if (++attempts === 1) throw new Error('NSURLErrorDomain Code=-1001 "The request timed out."');
    return 'The validate action worked!';
  }, () => {});
  assert.equal(attempts, 2);
  assert.equal(result, 'The validate action worked!');
});
