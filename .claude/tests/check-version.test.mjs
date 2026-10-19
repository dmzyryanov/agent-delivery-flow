import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkVersion, isNextVersion, isRuntimePath, parseVersion } from '../scripts/check-version.mjs';

const SCRIPT = new URL('../scripts/check-version.mjs', import.meta.url).pathname;

test('runtime paths are everything but docs, tests and delivery tooling', () => {
  for (const path of ['README.md', 'docs/x.png', '.claude/scripts/a.mjs', '.github/workflows/ci.yml',
    'VERSION', 'CHANGELOG.md', '.mcp.json', 'src/a.test.ts', 'web/b.spec.js', 'tests/x.py', 'pkg/test/y.go',
    'e2e/run.ts', 'src/__tests__/z.js']) {
    assert.equal(isRuntimePath(path), false, path);
  }
  for (const path of ['src/index.ts', 'package.json', 'Dockerfile', 'app/testing.py', 'contest/a.js']) {
    assert.equal(isRuntimePath(path), true, path);
  }
});

test('VERSION is one MAJOR.MINOR.PATCH line and the next one is one step on', () => {
  assert.deepEqual(parseVersion('1.2.3\n'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  for (const text of ['', '1.2', '01.2.3', 'v1.2.3', '1.2.3\n\n', '1.2.3\n1.2.4\n']) {
    assert.equal(parseVersion(text), null, JSON.stringify(text));
  }
  assert.equal(isNextVersion([1, 2, 3], [1, 2, 4]), true);
  assert.equal(isNextVersion([1, 2, 3], [1, 3, 0]), true);
  assert.equal(isNextVersion([1, 2, 3], [2, 0, 0]), true);
  assert.equal(isNextVersion([1, 2, 3], [1, 2, 5]), false);
  assert.equal(isNextVersion([1, 2, 3], [1, 3, 1]), false);
  assert.equal(isNextVersion([1, 2, 3], [1, 2, 3]), false);
  assert.equal(isNextVersion([1, 2, 3], [1, 2, 2]), false);
});

test('a runtime change needs a bump with a changelog entry; tooling alone keeps the version', () => {
  const base = '0.1.0\n';
  assert.deepEqual(
    checkVersion({ baseVersion: base, headVersion: '0.1.1\n', changelog: '# C\n\n## 0.1.1\n', changedFiles: ['src/a.ts'] }),
    [],
  );
  assert.deepEqual(
    checkVersion({ baseVersion: base, headVersion: base, changelog: '', changedFiles: ['docs/a.md', '.claude/x'] }),
    [],
  );
  assert.match(
    checkVersion({ baseVersion: base, headVersion: base, changelog: '', changedFiles: ['src/a.ts'] })[0],
    /runtime files changed but VERSION stays 0\.1\.0: src\/a\.ts/,
  );
  assert.match(
    checkVersion({ baseVersion: base, headVersion: '0.1.1\n', changelog: '## 0.1.1\n', changedFiles: ['docs/a.md'] })[0],
    /keep the version/,
  );
  assert.deepEqual(
    checkVersion({ baseVersion: base, headVersion: '0.3.0\n', changelog: '## 0.2.0\n', changedFiles: ['src/a.ts'] }),
    [
      'VERSION 0.3.0 is not the next patch, minor or major after 0.1.0',
      'CHANGELOG.md does not open with a "## 0.3.0" entry',
    ],
  );
  assert.deepEqual(
    checkVersion({ baseVersion: base, headVersion: 'x', changelog: '', changedFiles: [] }),
    ['VERSION is not one MAJOR.MINOR.PATCH line'],
  );
  assert.deepEqual(
    checkVersion({ baseVersion: null, headVersion: '0.1.0\n', changelog: '', changedFiles: ['src/a.ts'] }),
    [],
  );
});

function repo(t, flow) {
  const dir = mkdtempSync(join(tmpdir(), 'check-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write('VERSION', '0.1.0\n');
  write('CHANGELOG.md', '## 0.1.0\n');
  write('src/a.ts', 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'task');
  const config = join(dir, 'flow-fixture.json');
  writeFileSync(config, JSON.stringify(flow));
  const run = () =>
    spawnSync(process.execPath, [SCRIPT, 'main'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, FLOW_CONFIG: config },
    });
  return { git, write, run };
}

test('the script compares HEAD with its merge base on the given ref', (t) => {
  const { git, write, run } = repo(t, { project: { repo: 'o/r' } });
  write('src/a.ts', 'b\n');
  git('commit', '-q', '-am', 'change');
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^version: runtime files changed but VERSION stays 0\.1\.0: src\/a\.ts$/m);
  write('VERSION', '0.1.1\n');
  write('CHANGELOG.md', '## 0.1.1\n\n## 0.1.0\n');
  git('commit', '-q', '-am', 'bump');
  result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'version: 0.1.1 fits 3 changed file(s)\n');
});

test('with versioning off the script checks nothing; a bad ref is exit 2', (t) => {
  const { git, write, run } = repo(t, { project: { repo: 'o/r' }, delivery: { versioning: false } });
  write('src/a.ts', 'b\n');
  git('commit', '-q', '-am', 'change');
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'version: not checked, delivery.versioning is false\n');
  const bad = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
