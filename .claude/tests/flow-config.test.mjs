import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FlowConfigError, loadFlow, taskCommand } from '../scripts/flow-config.mjs';

const SCRIPT = new URL('../scripts/flow-config.mjs', import.meta.url).pathname;

function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'flow.json');
  if (content !== undefined) {
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return path;
}

function withConfig(path, fn) {
  const before = process.env.FLOW_CONFIG;
  process.env.FLOW_CONFIG = path;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.FLOW_CONFIG;
    else process.env.FLOW_CONFIG = before;
  }
}

test('the kit ships a flow.json that reads, with an empty repo', () => {
  const flow = loadFlow(undefined, { requireRepo: false });
  assert.equal(flow.project.repo, '');
  assert.equal(flow.project.mainBranch, 'main');
  assert.equal(flow.delivery.mainWorkflow, 'main.yml');
  assert.throws(() => loadFlow(), FlowConfigError);
});

test('missing keys take their defaults and about texts are ignored', (t) => {
  const path = fixture(t, { about: 'x', project: { repo: 'owner/name', about: 'y' } });
  const flow = withConfig(path, () => loadFlow());
  assert.equal(flow.project.repo, 'owner/name');
  assert.equal(flow.project.mainBranch, 'main');
  assert.equal(flow.commands.test, '');
  assert.equal(flow.outsideReview.enabled, false);
  assert.deepEqual(flow.outsideReview.areas, []);
  assert.equal('about' in flow.project, false);
});

test('a missing file, broken JSON, a wrong type or a bad repo is one FlowConfigError line', (t) => {
  const cases = [
    [undefined, /cannot be read/],
    ['{', /is not JSON/],
    ['[]', /is not a JSON object/],
    [{ project: [] }, /project is not an object/],
    [{ project: { repo: 'owner/name' }, delivery: { deploy: 'yes' } }, /delivery\.deploy is not a boolean/],
    [{ project: { repo: 'owner/name' }, outsideReview: { areas: 'x' } }, /areas is not a list/],
    [{ project: { repo: 'no-slash' } }, /not owner\/name/],
    [{ project: { repo: 'a/b/c' } }, /not owner\/name/],
  ];
  for (const [content, message] of cases) {
    const path = fixture(t, content);
    assert.throws(
      () => withConfig(path, () => loadFlow()),
      (error) => error instanceof FlowConfigError && message.test(error.message) && !error.message.includes('\n'),
    );
  }
});

test('taskCommand fills {task} and falls back from taskTest to test', (t) => {
  const path = fixture(t, {
    project: { repo: 'o/r' },
    commands: { test: 'npm test', taskDown: 'node db.mjs down {task}' },
  });
  const flow = withConfig(path, () => loadFlow());
  assert.equal(taskCommand(flow, 'taskTest', '42'), 'npm test');
  assert.equal(taskCommand(flow, 'taskDown', '42'), 'node db.mjs down 42');
  assert.equal(taskCommand(flow, 'e2e', '42'), '');
});

test('run as a script it prints one value and exits 0, 1 or 2', (t) => {
  const path = fixture(t, { project: { repo: 'o/r', site: 'https://example.test' } });
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FLOW_CONFIG: path },
    });
  assert.deepEqual([run('project.repo').status, run('project.repo').stdout], [0, 'o/r\n']);
  assert.equal(run('delivery.deploy').stdout, 'false\n');
  assert.deepEqual([run('commands.e2e').status, run('commands.e2e').stdout], [0, '\n']);
  assert.equal(run('schedule').stdout, `${JSON.stringify(loadFlowDefaultsSchedule())}\n`);
  assert.equal(run('project.nothing').status, 2);
  assert.equal(run().status, 2);
  assert.equal(run('a;b').status, 2);
  const broken = fixture(t, '{');
  const fault = spawnSync(process.execPath, [SCRIPT, 'project.repo'], {
    encoding: 'utf8',
    env: { ...process.env, FLOW_CONFIG: broken },
  });
  assert.equal(fault.status, 1);
  assert.match(fault.stderr, /is not JSON/);
});

function loadFlowDefaultsSchedule() {
  return { cycle: '*/30 * * * *', grooming: '7,22,37,52 * * * *', morningFire: '09:07' };
}
