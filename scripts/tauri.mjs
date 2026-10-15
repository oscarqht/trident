import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { styleDmg } from './style-dmg.mjs';

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
if (process.platform === 'darwin' && ['build', 'bundle'].includes(args[0]) && !args.includes('--no-bundle')) {
  const value = flag => args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
    ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const target = value('--target') ?? value('-t');
  const bundles = value('--bundles') ?? value('-b');
  if ((!target || target.includes('apple-darwin')) && (!bundles || bundles.split(',').some(bundle => ['dmg', 'all'].includes(bundle)))) {
    const directory = path.join(process.env.CARGO_TARGET_DIR || 'src-tauri/target', target || '', args.includes('--debug') || args.includes('-d') ? 'debug' : 'release', 'bundle/dmg');
    if (!fs.existsSync(directory)) throw new Error(`DMG output directory missing: ${directory}`);
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.dmg'))) styleDmg(path.join(directory, name));
  }
}
