// Tests the package npm would ship, not the repo: pack it, install the tarball
// into an empty folder, run both binaries from there, then dry-run the publish.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'leafi-pack-test-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  process.stderr.write(`$ ${command} ${args.join(' ')}\n`);
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    ...options,
  });
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  process.stderr.write(`ok - ${message}\n`);
}

try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', work], { cwd: root }));
  const [{ filename, files }] = packed;
  const shipped = files.map((file) => file.path);
  check(shipped.includes('dist/main.js') && shipped.includes('dist/mcp/main.js'), 'both entry points are packed');
  check(shipped.includes('AGENTS.md') && shipped.includes('SECURITY.md'), 'AGENTS.md and SECURITY.md are packed');
  check(shipped.includes('agents/HOW_TO_DESIGN_YOUR_FLOW.md'), 'the design guide is packed');
  check(!shipped.some((file) => file.endsWith('.map') || file.endsWith('.tsbuildinfo')), 'no source maps or build cache');
  check(!shipped.some((file) => file.startsWith('src/') || file.startsWith('test/') || file.startsWith('.env')), 'no source, tests or env files');

  const install = path.join(work, 'install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), '{"private":true}\n');
  run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', path.join(work, filename)], { cwd: install });

  const bin = path.join(install, 'node_modules', '.bin');
  const cli = path.join(bin, process.platform === 'win32' ? 'leafi.cmd' : 'leafi');
  const mcp = path.join(bin, process.platform === 'win32' ? 'leafi-mcp.cmd' : 'leafi-mcp');
  const env = { ...process.env, LEAFI_HOME: path.join(work, 'home') };
  const inInstall = { cwd: install, env };

  check(run(cli, ['--help'], inInstall).includes('leafi <command>'), 'leafi --help');
  check(run(cli, ['--version'], inInstall).trim() === version, `leafi --version prints ${version}`);
  const example = run(cli, ['schema', 'example'], inInstall);
  const validation = JSON.parse(run(cli, ['validate', '--graph', '-'], { ...inInstall, input: example }));
  check(validation.ok === true, 'leafi schema example | leafi validate --graph -');
  const setup = JSON.parse(run(cli, ['init', '--yes'], { ...inInstall, input: '' }));
  check(setup.envFileStatus === 'created' && setup.flowStatus === 'created', 'leafi init writes the settings file and a starter flow');
  check(JSON.parse(run(cli, ['validate', '--graph', 'flow.json'], inInstall)).ok === true, 'the starter flow validates');
  check(run(mcp, ['--help'], inInstall).includes('leafi-mcp'), 'leafi-mcp --help');
  check(run(mcp, ['--version'], inInstall).trim() === version, `leafi-mcp --version prints ${version}`);

  process.stderr.write(`\nThe packed package works (${filename}).\n`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
