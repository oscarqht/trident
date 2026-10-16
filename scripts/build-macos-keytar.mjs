import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { requireMacos, verifyNativeRuntime } from './native-runtime.mjs';

// The app uses the user's Node, which may be Intel even on Apple Silicon.
// keytar uses Node-API, so one universal addon can support both Node architectures.
export function buildUniversalKeytar(root = process.cwd(), env = process.env, execute = execFileSync) {
  const binary = path.resolve(root, 'node_modules/keytar/build/Release/keytar.node');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-keytar-'));
  try {
    const slices = ['x64', 'arm64'].map(arch => {
      execute('npm', ['rebuild', 'keytar'], {
        cwd: root, stdio: 'inherit',
        env: { ...env, npm_config_arch: arch, npm_config_build_from_source: 'true' },
      });
      const slice = path.join(temporary, `${arch}.node`);
      fs.copyFileSync(binary, slice);
      return slice;
    });
    execute('lipo', ['-create', ...slices, '-output', binary], { cwd: root, stdio: 'inherit' });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireMacos();
  buildUniversalKeytar();
  verifyNativeRuntime(process.cwd(), 'universal');
}
