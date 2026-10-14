import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

// Build before running; inspect the real tarball and smoke-test only offline help.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
assert.equal(pack.name, 'wallfly');
assert.equal(pack.version, pkg.version);
const paths = pack.files.map(({ path }) => path);
for (const required of ['bin/wallfly', 'dist/src/cli/index.js', 'dist/src/send/index.js',
  'docs/ARCHITECTURE.md', 'docs/PRIVACY.md', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'package.json']) {
  assert.ok(paths.includes(required), `Missing package file: ${required}`);
}
for (const path of paths) {
  assert.match(path, /^(?:bin\/wallfly|dist\/src\/.+\.js|docs\/.+\.(?:md|service)|README\.md|SECURITY\.md|CHANGELOG\.md|LICENSE|package\.json)$/,
    `Unexpected package file: ${path}`);
}
const directory = mkdtempSync(resolve('.pack-check-'));
try {
  execFileSync('npm', ['install', '--prefix', directory, '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', resolve(pack.filename)], { stdio: 'inherit' });
  const bin = join(directory, 'node_modules', 'wallfly', 'bin', 'wallfly');
  for (const args of [['--help'], ['send', '--help'], ['config', '--help']]) {
    const help = execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: directory });
    assert.match(help, /wallfly/);
  }
  process.stdout.write(`Package OK: ${pack.filename} (${paths.length} files); installed CLI help passed offline.\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
