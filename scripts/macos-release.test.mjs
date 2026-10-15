import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCredentials, verifyAndNotarize, rebuildMacosContainers, verifyUpdaterKeyMatch, signNativeResources, withSigningKeychain, updateSigningKeychainSearchList, runStapler, run } from './macos-release.mjs';

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
  const signingEnv = { ...env, TRIDENT_SIGNING_KEYCHAIN: '/tmp/job-specific.keychain-db' };
  const calls = [];
  assert.deepEqual(signNativeResources(root, signingEnv, (command, args) => { calls.push([command, ...args]); return args[0] === 'list-keychains' ? `"${signingEnv.TRIDENT_SIGNING_KEYCHAIN}"` : ''; }), [module]);
  assert.deepEqual(calls.filter(call => call[0] === 'codesign'), [
    ['codesign', '--force', '--timestamp', '--options', 'runtime', '--keychain', signingEnv.TRIDENT_SIGNING_KEYCHAIN, '--sign', env.APPLE_SIGNING_IDENTITY, module],
    ['codesign', '--verify', '--strict', '--verbose=2', module],
  ]);
  assert.throws(() => signNativeResources(root, signingEnv, () => { throw new Error('nested signature failed'); }), /nested signature failed/);
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

test('stapler retries stop after five transient failures and retain Apple diagnostics', () => {
  const sleeps = [];
  let attempts = 0;
  assert.throws(() => runStapler('staple', 'dmg', () => {
    attempts++;
    throw new Error('NSURLErrorDomain Code=-1005 "The network connection was lost."');
  }, milliseconds => sleeps.push(milliseconds)), /Code=-1005/);
  assert.equal(attempts, 5);
  assert.deepEqual(sleeps, [5000, 15000, 45000, 90000]);
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


test('job keychain is checked explicitly and deleted without restoring a stale search-list snapshot', () => {
  const calls = [];
  let keychain;
  const result = withSigningKeychain(env, signingEnv => {
    keychain = signingEnv.TRIDENT_SIGNING_KEYCHAIN;
    assert.ok(fs.existsSync(path.join(path.dirname(keychain), 'certificate.p12')));
    return 'signed';
  }, (command, args) => {
    calls.push([command, ...args]);
    return args[0] === 'find-identity' ? `1) HASH "${env.APPLE_SIGNING_IDENTITY}"` : '';
  });
  assert.equal(result, 'signed');
  assert.ok(calls.some(call => call[1] === 'find-identity' && call.at(-1) === keychain));
  assert.ok(calls.some(call => call[1] === 'list-keychains'));
  assert.deepEqual(calls.at(-1), ['security', 'delete-keychain', keychain]);
  assert.equal(fs.existsSync(path.dirname(keychain)), false);
});

test('missing identity fails before compilation and cleans the temporary keychain', () => {
  const calls = [];
  assert.throws(() => withSigningKeychain(env, () => assert.fail('must not build without identity'), (command, args) => {
    calls.push([command, ...args]);
    return '0 valid identities found';
  }), /does not contain/);
  assert.equal(calls.at(-1)[1], 'delete-keychain');
  assert.equal(fs.existsSync(path.dirname(calls.at(-1).at(-1))), false);
});

test('build failure still removes only its own temporary keychain', () => {
  const calls = [];
  assert.throws(() => withSigningKeychain(env, () => { throw new Error('build failed'); }, (command, args) => {
    calls.push([command, ...args]);
    return args[0] === 'find-identity' ? `"${env.APPLE_SIGNING_IDENTITY}"` : '';
  }), /build failed/);
  assert.equal(calls.at(-1)[1], 'delete-keychain');
  assert.ok(calls.some(call => call[1] === 'list-keychains'));
});


test('a leaf-only p12 becomes usable after adding Apple intermediate certificates to its own keychain', () => {
  const calls = [];
  let checks = 0;
  withSigningKeychain(env, signingEnv => {
    assert.ok(signingEnv.TRIDENT_SIGNING_KEYCHAIN);
  }, (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'find-identity') return ++checks === 1 ? '0 valid identities found' : `"${env.APPLE_SIGNING_IDENTITY}"`;
    if (args[0] === 'add-certificates') assert.ok(fs.existsSync(args.at(-1)));
    return '';
  });
  assert.equal(checks, 2);
  const added = calls.filter(call => call[1] === 'add-certificates');
  assert.equal(added.length, 2);
  assert.ok(added.every(call => call[2] === '-k' && call[3] === calls.at(-1).at(-1)));
});


test('keychain registration and cleanup preserve unrelated current keychains', () => {
  let searchList = ['/tmp/login.keychain-db'];
  const execute = (command, args) => {
    if (args.includes('-s')) searchList = args.slice(args.indexOf('-s') + 1);
    return searchList.map(filename => `"${filename}"`).join('\n');
  };
  updateSigningKeychainSearchList('/tmp/trident.keychain-db', true, execute);
  assert.deepEqual(searchList, ['/tmp/trident.keychain-db', '/tmp/login.keychain-db']);
  searchList.push('/tmp/another-job.keychain-db');
  updateSigningKeychainSearchList('/tmp/trident.keychain-db', false, execute);
  assert.deepEqual(searchList, ['/tmp/login.keychain-db', '/tmp/another-job.keychain-db']);
});


test('repairs a missing app ticket and rebuilds both containers before final DMG notarization', () => {
  const calls = [];
  const fake = fakeRunner(calls);
  let appValidations = 0;
  verifyAndNotarize('app', 'dmg', env, (command, args) => {
    if (args[0] === 'stapler' && args[1] === 'validate' && args[2] === 'app' && ++appValidations === 1) {
      calls.push([command, ...args]);
      throw new Error('xcrun stapler failed (exit 65). app does not have a ticket stapled to it.');
    }
    return fake(command, args);
  }, () => {}, () => calls.push(['rebuild-containers']));
  assert.equal(appValidations, 2);
  const staple = calls.findIndex(call => call[1] === 'stapler' && call[2] === 'staple' && call[3] === 'app');
  const rebuild = calls.findIndex(call => call[0] === 'rebuild-containers');
  const notarize = calls.findIndex(call => call[1] === 'notarytool' && call[2] === 'submit');
  assert.ok(staple >= 0 && rebuild > staple && notarize > rebuild);
});

test('app ticket recovery failure blocks repackaging and DMG publication', () => {
  const calls = [];
  const fake = fakeRunner(calls);
  assert.throws(() => verifyAndNotarize('app', 'dmg', env, (command, args) => {
    if (args[0] === 'stapler') {
      if (args[1] === 'validate') throw new Error('app does not have a ticket stapled to it.');
      throw new Error('Apple has no notarization record for this app');
    }
    return fake(command, args);
  }, () => {}, () => assert.fail('must not repackage')), /no notarization record/);
  assert.ok(!calls.some(call => call[1] === 'notarytool'));
});


test('repackaging copies the ticket-bearing app, replaces the DMG, and signs the regenerated updater archive', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-repackage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'Trident.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/ticket-fixture'), 'stapled ticket');
  const dmg = path.join(directory, 'Trident.dmg');
  const archive = path.join(directory, 'Trident.app.tar.gz');
  fs.writeFileSync(dmg, 'old DMG');
  fs.writeFileSync(archive, 'old archive');
  fs.writeFileSync(`${archive}.sig`, 'old signature');
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const publicKey = Buffer.from(Buffer.from(config.plugins.updater.pubkey, 'base64').toString().trim().split(/\r?\n/)[1], 'base64');
  const signingEnv = { ...env, TRIDENT_SIGNING_KEYCHAIN: '/tmp/job.keychain-db', TAURI_SIGNING_PRIVATE_KEY: 'fixture-key' };
  const calls = [];
  rebuildMacosContainers(app, dmg, archive, signingEnv, (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ditto') fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
    if (command === 'hdiutil') {
      if (args[0] === 'attach') {
        const staging = args[args.indexOf('-mountpoint') + 1];
        fs.mkdirSync(path.join(staging, '.background'), { recursive: true });
        fs.writeFileSync(path.join(staging, '.background/background.png'), 'installer artwork');
        fs.writeFileSync(path.join(staging, '.DS_Store'), 'Finder layout');
        fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
      } else if (args[0] === 'detach') {
        const staging = args[1];
        assert.equal(fs.readFileSync(path.join(staging, 'Trident.app/Contents/ticket-fixture'), 'utf8'), 'stapled ticket');
        assert.equal(fs.readFileSync(path.join(staging, '.background/background.png'), 'utf8'), 'installer artwork');
        assert.equal(fs.readFileSync(path.join(staging, '.DS_Store'), 'utf8'), 'Finder layout');
        assert.equal(fs.readlinkSync(path.join(staging, 'Applications')), '/Applications');
      } else if (args[0] === 'convert') {
        assert.ok(args.includes('UDRW') || args.includes('UDZO'));
        fs.writeFileSync(args.at(-1), 'rebuilt DMG');
      } else {
        assert.fail('Recovery must preserve the existing image, not create a bare DMG');
      }
    }
    if (command === 'tar') fs.writeFileSync(archive, 'regenerated archive');
    if (command === process.execPath) {
      const signature = Buffer.alloc(74); signature.write('ED'); publicKey.copy(signature, 2, 2, 10);
      fs.writeFileSync(`${archive}.sig`, Buffer.from(`untrusted comment: fixture\n${signature.toString('base64')}\n`).toString('base64'));
    }
    return command === 'security' ? `"${signingEnv.TRIDENT_SIGNING_KEYCHAIN}"` : '';
  });
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'rebuilt DMG');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'regenerated archive');
  assert.doesNotThrow(() => verifyUpdaterKeyMatch(`${archive}.sig`, config.plugins.updater.pubkey));
  assert.ok(calls.some(call => call[0] === process.execPath && call.includes('signer') && call.includes('sign')));
});
