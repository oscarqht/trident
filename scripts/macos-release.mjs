import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  const secrets = [args.includes('--password') ? args[args.indexOf('--password') + 1] : undefined, process.env.APPLE_PASSWORD,
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
  const delays = [5000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      return execute('xcrun', ['stapler', action, target]);
    } catch (error) {
      // Exit 68 also covers permanent failures; retry only explicit network diagnostics.
      const diagnostics = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
      const transient = /NSURLErrorDomain[\s\S]*?Code=-(?:1001|1003|1004|1005|1006|1009)\b/.test(diagnostics);
      if (!transient || attempt >= delays.length) throw error;
      console.warn(`Apple stapler ${action} lost its network connection; retrying in ${delays[attempt] / 1000}s (${attempt + 2}/3).`);
      sleep(delays[attempt]);
    }
  }
}

export function verifyAndNotarize(app, dmg, env, execute = run, sleep = sleepSync) {
  validateCredentials(env);
  execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const details = execute('codesign', ['--display', '--verbose=4', app]);
  if (!details.includes(`Authority=${env.APPLE_SIGNING_IDENTITY}`) ||
      !details.includes(`TeamIdentifier=${env.APPLE_TEAM_ID}`) || !/flags=.*\bruntime\b/.test(details)) {
    throw new Error('App must have the expected Developer ID, team, and hardened runtime');
  }
  runStapler('validate', app, execute, sleep);
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

// Native Node modules live in Resources, where signing the outer app alone does not sign them.
export function signNativeResources(root, env, execute = run) {
  validateCredentials(env);
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
        execute('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', env.APPLE_SIGNING_IDENTITY, filename]);
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

export function verifyReleaseBundle(bundle, env, execute = run) {
  validateCredentials(env);
  const artifact = (folder, extension) => {
    const files = fs.readdirSync(path.join(bundle, folder)).filter(name => name.endsWith(extension));
    if (files.length !== 1) throw new Error(`Expected exactly one ${extension} in ${folder}`);
    return path.join(bundle, folder, files[0]);
  };
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  verifyUpdaterKeyMatch(artifact('macos', '.app.tar.gz.sig'), config.plugins.updater.pubkey);
  verifyAndNotarize(artifact('macos', '.app'), artifact('dmg', '.dmg'), env, execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCredentials(process.env);
  if (process.argv[2] === 'validate') {
    console.log('Apple signing and notarization credentials are configured.');
  } else if (process.argv[2] === 'sign-resources') {
    const signed = signNativeResources('.next/standalone', process.env);
    console.log(`Signed and verified ${signed.length} bundled native code files.`);
  } else if (process.argv[2] === 'prepare') {
    fs.writeFileSync('src-tauri/tauri.macos.release.json', JSON.stringify({ build: { beforeBundleCommand: 'node scripts/macos-release.mjs sign-resources' }, bundle: { macOS: {
      signingIdentity: process.env.APPLE_SIGNING_IDENTITY, hardenedRuntime: true,
    } } }, null, 2));
  } else if (process.argv[2] === 'notarize') {
    const bundle = 'src-tauri/target/aarch64-apple-darwin/release/bundle';
    verifyReleaseBundle(bundle, process.env);
    console.log('App and DMG passed signing, notarization, and Gatekeeper checks.');
  } else {
    throw new Error('Usage: node scripts/macos-release.mjs validate|prepare|sign-resources|notarize');
  }
}
