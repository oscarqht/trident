import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function validateCredentials(env) {
  const required = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing release CI variables: ${missing.join(', ')}`);
  if (!env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
    throw new Error('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity');
  }
}

export function run(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 35 * 60 * 1000 });
  const securityPasswords = command === 'security'
    ? args.flatMap((argument, index) => ['-p', '-P'].includes(argument) || (args[0] === 'set-key-partition-list' && argument === '-k') ? [args[index + 1]] : []) : [];
  const secrets = [...securityPasswords, args.includes('--password') ? args[args.indexOf('--password') + 1] : undefined, process.env.APPLE_PASSWORD,
    process.env.APPLE_CERTIFICATE_PASSWORD, process.env.APPLE_CERTIFICATE, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]
    .filter(Boolean);
  const redact = output => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), output || '');
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  if (result.error || result.status !== 0) {
    // Keep Apple's diagnostics, but never print arguments containing credentials.
    const details = [redact(result.error?.message), stdout, stderr].filter(Boolean).join('\n').trim();
    const error = new Error(`${command} ${args[0]} failed (exit ${result.status ?? 'timeout'}).${details ? `\n${details}` : ''}`);
    error.stdout = stdout;
    throw error;
  }
  return command === 'codesign' && args[0] === '--display' ? stdout + stderr : stdout;
}

const sleepSync = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

export function runStapler(action, target, execute = run, sleep = sleepSync) {
  const delays = [5000, 15000, 45000, 90000];
  for (let attempt = 0; ; attempt++) {
    try {
      return execute('xcrun', ['stapler', action, target]);
    } catch (error) {
      // Exit 68 also covers permanent failures; retry only explicit network diagnostics.
      const diagnostics = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
      const transient = /NSURLErrorDomain[\s\S]*?Code=-(?:1001|1003|1004|1005|1006|1009)\b/.test(diagnostics);
      if (!transient || attempt >= delays.length) throw error;
      console.warn(`Apple stapler ${action} lost its network connection; retrying in ${delays[attempt] / 1000}s (${attempt + 2}/${delays.length + 1}).`);
      sleep(delays[attempt]);
    }
  }
}

export function verifyAndNotarize(app, dmg, env, execute = run, sleep = sleepSync, onAppRestapled = () => { throw new Error('Distribution containers must be rebuilt after repairing the app ticket.'); }) {
  validateCredentials(env);
  execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = execute('codesign', ['--display', '--verbose=4', app]);
  if (!details.includes(`Authority=${env.APPLE_SIGNING_IDENTITY}`) ||
      !details.includes(`TeamIdentifier=${env.APPLE_TEAM_ID}`) || !/flags=.*\bruntime\b/.test(details)) {
    throw new Error('App must have the expected Developer ID, team, and hardened runtime');
  }
  try {
    runStapler('validate', app, execute, sleep);
  } catch (error) {
    if (!/does not have a ticket stapled to it/.test(error.message)) throw error;
    console.warn('Tauri app notarization completed without a stapled ticket; recovering it explicitly.');
    runStapler('staple', app, execute, sleep);
    runStapler('validate', app, execute, sleep);
    onAppRestapled();
  }
  execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  execute('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
  const dmgDetails = execute('codesign', ['--display', '--verbose=4', dmg]);
  if (!dmgDetails.includes(`Authority=${env.APPLE_SIGNING_IDENTITY}`) ||
      !dmgDetails.includes(`TeamIdentifier=${env.APPLE_TEAM_ID}`)) {
    throw new Error('DMG must have the expected Developer ID and team');
  }
  const credentials = ['--apple-id', env.APPLE_ID, '--password', env.APPLE_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  const rejection = (result, message) => {
    let log;
    try {
      log = execute('xcrun', ['notarytool', 'log', result.id, ...credentials]);
    } catch (error) {
      log = `Could not retrieve Apple's notarization log: ${error.message}`;
    }
    return new Error(`${message} (submission ${result.id}, status ${result.status}).\n${log}`);
  };
  let result;
  try {
    result = JSON.parse(execute('xcrun', ['notarytool', 'submit', dmg, ...credentials,
      '--wait', '--timeout', '30m', '--output-format', 'json']));
  } catch (error) {
    // A nonzero exit may still include a submission ID and Apple's rejection status.
    try { result = JSON.parse(error.stdout || '{}'); } catch { /* No structured response. */ }
    if (result?.id) throw rejection(result, error.message);
    throw error;
  }
  if (result.status !== 'Accepted') throw rejection(result, 'DMG notarization was not accepted');
  runStapler('staple', dmg, execute, sleep);
  runStapler('validate', dmg, execute, sleep);
  execute('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
}

// codesign still requires the identity keychain on the search list even with --keychain.
export function updateSigningKeychainSearchList(keychain, include, execute = run) {
  const output = execute('security', ['list-keychains', '-d', 'user']);
  const current = [...output.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
  const canonical = filename => { try { return fs.realpathSync(filename); } catch { return filename; } };
  const same = filename => canonical(filename) === canonical(keychain);
  const next = current.filter(filename => !same(filename));
  if (include) next.unshift(keychain);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    execute('security', ['list-keychains', '-d', 'user', '-s', ...next]);
  }
}

// Use an explicit identity keychain, and preserve unrelated jobs when updating the search list.
export function withSigningKeychain(env, callback, execute = run) {
  validateCredentials(env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-signing-'));
  const keychain = path.join(directory, 'build.keychain-db');
  const certificate = path.join(directory, 'certificate.p12');
  const password = randomBytes(32).toString('hex');
  let created = false;
  try {
    fs.writeFileSync(certificate, Buffer.from(env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600 });
    execute('security', ['create-keychain', '-p', password, keychain]);
    created = true;
    execute('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    execute('security', ['unlock-keychain', '-p', password, keychain]);
    execute('security', ['import', certificate, '-k', keychain, '-P', env.APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign']);
    execute('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    updateSigningKeychainSearchList(keychain, true, execute);
    const findIdentities = () => execute('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
    let identities = findIdentities();
    if (!identities.includes(`"${env.APPLE_SIGNING_IDENTITY}"`)) {
      // A .p12 may contain only the leaf certificate and private key. The issuing
      // Developer ID intermediate must also be available to build a trusted chain.
      for (const name of ['DeveloperIDCA.cer', 'DeveloperIDG2CA.cer']) {
        execute('security', ['add-certificates', '-k', keychain, fileURLToPath(new URL(`./certificates/${name}`, import.meta.url))]);
      }
      identities = findIdentities();
    }
    if (!identities.includes(`"${env.APPLE_SIGNING_IDENTITY}"`)) {
      throw new Error('The imported keychain does not contain the configured valid Developer ID signing identity.');
    }
    return callback({ ...env, TRIDENT_SIGNING_KEYCHAIN: keychain });
  } finally {
    try {
      if (created) {
        try { updateSigningKeychainSearchList(keychain, false, execute); }
        finally { execute('security', ['delete-keychain', keychain]); }
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}

// Native Node modules live in Resources, where signing the outer app alone does not sign them.
export function signNativeResources(root, env, execute = run) {
  validateCredentials(env);
  if (!env.TRIDENT_SIGNING_KEYCHAIN) throw new Error('Native resource signing requires the job signing keychain.');
  updateSigningKeychainSearchList(env.TRIDENT_SIGNING_KEYCHAIN, true, execute);
  const signed = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        const descriptor = fs.openSync(filename, 'r');
        const magic = Buffer.alloc(4);
        try { fs.readSync(descriptor, magic, 0, 4, 0); }
        finally { fs.closeSync(descriptor); }
        if (!['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'))) continue;
        execute('codesign', ['--force', '--timestamp', '--options', 'runtime', '--keychain', env.TRIDENT_SIGNING_KEYCHAIN, '--sign', env.APPLE_SIGNING_IDENTITY, filename]);
        execute('codesign', ['--verify', '--strict', '--verbose=2', filename]);
        signed.push(filename);
      }
    }
  };
  walk(root);
  return signed;
}

export function verifyUpdaterKeyMatch(signaturePath, encodedPublicKey) {
  const publicKey = Buffer.from(Buffer.from(encodedPublicKey, 'base64').toString('utf8').trim().split(/\r?\n/)[1] || '', 'base64');
  const signature = Buffer.from(Buffer.from(fs.readFileSync(signaturePath, 'utf8').trim(), 'base64').toString('utf8').trim().split(/\r?\n/)[1] || '', 'base64');
  if (publicKey.length !== 42 || signature.length !== 74) throw new Error('Invalid Tauri updater public key or signature encoding');
  if (!publicKey.subarray(2, 10).equals(signature.subarray(2, 10))) {
    throw new Error('Updater signing key does not match the public key embedded in Trident. Restore the matching private key or deliberately rotate the public key before releasing.');
  }
}

export function rebuildMacosContainers(app, dmg, archive, env, execute = run) {
  if (!env.TRIDENT_SIGNING_KEYCHAIN) throw new Error('Repackaging requires the job signing keychain.');
  if (!env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Repackaging requires TAURI_SIGNING_PRIVATE_KEY.');
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const icon = path.resolve('src-tauri', config.bundle.icon.find(entry => entry.endsWith('.icns')));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-restaple-'));
  try {
    const staging = path.join(temporary, 'installer');
    const writable = path.join(temporary, 'writable.dmg');
    const image = path.join(temporary, 'installer.dmg');
    // Preserve Finder metadata and artwork when replacing the ticket-bearing app.
    execute('hdiutil', ['convert', dmg, '-format', 'UDRW', '-o', writable]);
    execute('hdiutil', ['attach', '-nobrowse', '-mountpoint', staging, writable]);
    try {
      execute('ditto', ['--rsrc', '--extattr', app, path.join(staging, path.basename(app))]);
      const volumeIcon = path.join(staging, '.VolumeIcon.icns');
      fs.copyFileSync(icon, volumeIcon);
      execute('SetFile', ['-c', 'icnC', volumeIcon]);
      execute('SetFile', ['-a', 'C', staging]);
    } finally {
      execute('hdiutil', ['detach', staging]);
    }
    execute('hdiutil', ['convert', writable, '-format', 'UDZO', '-o', image]);
    execute('swift', ['-e', [
      'import AppKit',
      'let iconPath = CommandLine.arguments[1]',
      'let targetPath = CommandLine.arguments[2]',
      'guard let image = NSImage(contentsOfFile: iconPath) else { fputs("Failed to load icon: \\(iconPath)\\n", stderr); exit(1) }',
      'if !NSWorkspace.shared.setIcon(image, forFile: targetPath, options: []) { fputs("Failed to set file icon on: \\(targetPath)\\n", stderr); exit(1) }',
    ].join('\n'), icon, image]);
    updateSigningKeychainSearchList(env.TRIDENT_SIGNING_KEYCHAIN, true, execute);
    execute('codesign', ['--force', '--timestamp', '--keychain', env.TRIDENT_SIGNING_KEYCHAIN, '--sign', env.APPLE_SIGNING_IDENTITY, image]);
    execute('ditto', ['--rsrc', '--extattr', image, dmg]);
    // The archive bytes changed when the ticket was added; generate a fresh updater signature.
    execute('tar', ['-czf', archive, '-C', path.dirname(app), path.basename(app)]);
    execute(process.execPath, [path.resolve('node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', archive]);
    verifyUpdaterKeyMatch(`${archive}.sig`, config.plugins.updater.pubkey);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyReleaseBundle(bundle, env, execute = run) {
  validateCredentials(env);
  const artifact = (folder, extension) => {
    const files = fs.readdirSync(path.join(bundle, folder)).filter(name => name.endsWith(extension));
    if (files.length !== 1) throw new Error(`Expected exactly one ${extension} in ${folder}`);
    return path.join(bundle, folder, files[0]);
  };
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  verifyUpdaterKeyMatch(artifact('macos', '.app.tar.gz.sig'), config.plugins.updater.pubkey);
  const app = artifact('macos', '.app');
  const dmg = artifact('dmg', '.dmg');
  verifyAndNotarize(app, dmg, env, execute, sleepSync, () =>
    rebuildMacosContainers(app, dmg, artifact('macos', '.app.tar.gz'), env, execute));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCredentials(process.env);
  if (process.argv[2] === 'validate') {
    console.log('Apple signing and notarization credentials are configured.');
  } else if (process.argv[2] === 'sign-resources') {
    const sign = signingEnv => signNativeResources('.next/standalone', signingEnv);
    const signed = process.env.TRIDENT_SIGNING_KEYCHAIN ? sign(process.env) : withSigningKeychain(process.env, sign);
    console.log(`Signed and verified ${signed.length} bundled native code files.`);
  } else if (process.argv[2] === 'prepare') {
    fs.writeFileSync('src-tauri/tauri.macos.release.json', JSON.stringify({ build: { beforeBundleCommand: 'node scripts/macos-release.mjs sign-resources' }, bundle: { macOS: {
      signingIdentity: process.env.APPLE_SIGNING_IDENTITY, hardenedRuntime: true,
    } } }, null, 2));
  } else if (process.argv[2] === 'notarize') {
    const bundle = 'src-tauri/target/aarch64-apple-darwin/release/bundle';
    const verify = signingEnv => verifyReleaseBundle(bundle, signingEnv);
    if (process.env.TRIDENT_SIGNING_KEYCHAIN) verify(process.env);
    else withSigningKeychain(process.env, verify);
    console.log('App and DMG passed signing, notarization, and Gatekeeper checks.');
  } else {
    throw new Error('Usage: node scripts/macos-release.mjs validate|prepare|sign-resources|notarize');
  }
}
