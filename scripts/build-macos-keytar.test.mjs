import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUniversalKeytar } from './build-macos-keytar.mjs';

test('builds both Node architectures and merges the slices before packaging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-keytar-test-'));
  const binary = path.join(root, 'node_modules/keytar/build/Release/keytar.node');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const builds = [];
  try {
    buildUniversalKeytar(root, { PATH: '/test/bin' }, (command, args, options) => {
      assert.equal(options.cwd, root);
      if (command === 'npm') {
        assert.deepEqual(args, ['rebuild', 'keytar']);
        assert.equal(options.env.npm_config_build_from_source, 'true');
        assert.equal(options.env.PATH, '/test/bin');
        builds.push(options.env.npm_config_arch);
        fs.writeFileSync(binary, options.env.npm_config_arch);
      } else {
        assert.equal(command, 'lipo');
        assert.equal(args[0], '-create');
        assert.deepEqual(args.slice(1, 3).map(file => fs.readFileSync(file, 'utf8')), ['x64', 'arm64']);
        assert.deepEqual(args.slice(3), ['-output', binary]);
        fs.writeFileSync(binary, 'universal');
      }
    });
    assert.deepEqual(builds, ['x64', 'arm64']);
    assert.equal(fs.readFileSync(binary, 'utf8'), 'universal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed architecture build stops before merging or packaging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trident-keytar-test-'));
  const binary = path.join(root, 'node_modules/keytar/build/Release/keytar.node');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const commands = [];
  try {
    assert.throws(() => buildUniversalKeytar(root, {}, (command, args, options) => {
      commands.push(command);
      if (options.env.npm_config_arch === 'arm64') throw new Error('compile failed');
      fs.writeFileSync(binary, 'x64');
    }), /compile failed/);
    assert.deepEqual(commands, ['npm', 'npm']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
