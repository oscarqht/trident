import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export function requireMacosArm64(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') throw new Error('Apple Silicon releases require macOS');
  if (arch !== 'arm64') throw new Error('Apple Silicon releases require arm64 Node; disable Rosetta for the build runtime.');
}

// Check the actual standalone copy, not only the build machine's node_modules.
export function verifyNativeRuntime(root, arch = process.arch,
  architectures = binary => execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }),
  load = filename => createRequire(filename)('keytar')) {
  const entrypoint = path.resolve(root, 'server.js');
  const binary = path.resolve(root, 'node_modules/keytar/build/Release/keytar.node');
  const expected = arch === 'x64' ? 'x86_64' : arch;
  if (!architectures(binary).trim().split(/\s+/).includes(expected)) {
    throw new Error(`Bundled keytar does not support ${arch}; rebuild native dependencies for the release architecture.`);
  }
  load(entrypoint);
}
