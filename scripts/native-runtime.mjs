import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export function requireMacos(platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Apple Silicon releases require macOS');
}

// Check the actual standalone copy, not only the build machine's node_modules.
// The release runner may be Intel, so the target arch can differ from the host's.
export function verifyNativeRuntime(root, arch = process.env.TRIDENT_NATIVE_ARCH || process.arch, hostArch = process.arch,
  architectures = binary => execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }),
  load = filename => createRequire(filename)('keytar')) {
  const entrypoint = path.resolve(root, 'server.js');
  const binary = path.resolve(root, 'node_modules/keytar/build/Release/keytar.node');
  const expected = arch === 'universal' ? ['x86_64', 'arm64'] : [arch === 'x64' ? 'x86_64' : arch];
  const available = architectures(binary).trim().split(/\s+/);
  if (!expected.every(slice => available.includes(slice))) {
    throw new Error(`Bundled keytar does not support ${arch}; rebuild native dependencies for the release architecture.`);
  }
  // A foreign-arch addon cannot be dlopen'd by this Node; the lipo check covers it.
  if (arch === 'universal' || arch === hostArch) load(entrypoint);
}
