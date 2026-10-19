// The check a scheduled fire makes before it starts a session (D17),
// `.claude/scripts/fire-check.mjs`. Nothing here reaches GitHub, the remote,
// Docker or Claude: `gh`, `git`, `docker` and the queue are stand-ins in a
// temporary directory, first on PATH, that answer from a file and record each
// call, and `.claude/flow.json` is a made-up one named by FLOW_CONFIG. The
// commands and the words the procedures write are compared as text, not by a
// shell or Markdown parser.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_CYCLE_CANDIDATES,
  MAX_GROOMING_LOOKUPS,
  MAX_LISTED,
  NEEDS_OWNER_LIMIT,
  OWNER_STEPS,
  RELEASED,
  earlierRunLine,
  groomingLine,
  hasUntickedOwnerStep,
  inMorning,
  morningRange,
  resumable,
  runTime,
} from '../scripts/fire-check.mjs';

const FIRE_CHECK = fileURLToPath(new URL('../scripts/fire-check.mjs', import.meta.url));
const NODE = process.execPath;
const REPO = 'acme/widgets';

const temporary = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const executable = (path, text) => writeFileSync(path, text, { mode: 0o755 });
const lines = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

// A stand-in for gh: `issue list` answers the fixture's open issues carrying
// the `--label`, up to `--limit`, as gh does after reading the pages; `issue
// view <n>` one issue with its comments; `api --method GET
// repos/acme/widgets/issues/<n>/events?per_page=&page=` one page of its label
// events; `api --method GET repos/acme/widgets` the repository. A rule whose
// pattern matches the words of the call answers instead: `fail` exits 1 with
// gh's line for an HTTP failure, `garbage` prints what is no JSON, `object` an
// object where a list belongs, `hang` never answers.
const GH = `
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.STUB_DATA, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_DATA + '.calls', JSON.stringify(['gh', ...args]) + '\\n');
const out = (value) => process.stdout.write(JSON.stringify(value));
const words = args.join(' ');
for (const rule of data.ghRules ?? []) {
  if (!new RegExp(rule.match).test(words)) continue;
  if (rule.mode === 'fail') { process.stderr.write('HTTP 404: Not Found (https://api.github.com/x)\\n'); process.exit(1); }
  if (rule.mode === 'garbage') { process.stdout.write('<html>not json'); process.exit(0); }
  if (rule.mode === 'object') { out({ message: 'not a list' }); process.exit(0); }
  if (rule.mode === 'hang') { setInterval(() => {}, 1000); return; }
}
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const issues = data.issues ?? [];
const shape = (i) => ({
  number: i.number,
  title: 'issue ' + i.number,
  state: i.state ?? 'OPEN',
  labels: Array.isArray(i.labels) ? i.labels.map((name) => ({ id: 'LA_' + name, name, color: 'ededed' })) : i.labels,
  body: i.body ?? '',
  updatedAt: '2026-10-17T00:00:00Z',
});
if (args[0] === 'api' && args[1] === '--method' && args[2] === 'GET') {
  const url = new URL('http://github.invalid/' + args[3]);
  if (url.pathname === '/repos/acme/widgets') { out({ full_name: 'acme/widgets' }); process.exit(0); }
  const match = /^\\/repos\\/acme\\/widgets\\/issues\\/(\\d+)\\/events$/.exec(url.pathname);
  const found = match && issues.find((i) => String(i.number) === match[1]);
  if (!found) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const at = Number(url.searchParams.get('page') ?? 1);
  out((found.events ?? []).slice((at - 1) * per, at * per));
} else if (args[0] === 'issue' && args[1] === 'list') {
  const label = option('--label');
  out(issues
    .filter((i) => (i.state ?? 'OPEN') === 'OPEN')
    .filter((i) => label === undefined || i.labels.includes(label))
    .slice(0, Number(option('--limit') ?? 30))
    .map(shape));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const found = issues.find((i) => String(i.number) === args[2]);
  if (!found) {
    process.stderr.write('GraphQL: Could not resolve to an issue or pull request with the number of ' + args[2] + '. (repository.issue)\\n');
    process.exit(1);
  }
  out({ ...shape(found), comments: found.comments ?? [] });
} else {
  process.stderr.write('stand-in gh: not ' + words + '\\n');
  process.exit(2);
}
`;

// git and docker: an answer, or the fixture's `fail` or `hang` for them.
const TOOL = (name) => `
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.STUB_DATA, 'utf8'));
fs.appendFileSync(process.env.STUB_DATA + '.calls', JSON.stringify(['${name}', ...process.argv.slice(2)]) + '\\n');
const mode = (data.tools ?? {})['${name}'];
if (mode === 'fail') { process.stderr.write('${name}: cannot connect\\n'); process.exit(128); }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
process.stdout.write('${name} answers\\n');
`;

// The queue: `status --json` and `pick --json` answer what the fixture says,
// as an exit status and the two streams.
const QUEUE = `
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.env.STUB_DATA, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_DATA + '.calls', JSON.stringify(['queue', ...args]) + '\\n');
const answer = args[0] === 'status' ? data.status : args[0] === 'pick' ? data.pick : null;
if (!answer || args[1] !== '--json') { process.stderr.write('stand-in queue: not ' + args.join(' ') + '\\n'); process.exit(2); }
if (answer.hang) { setInterval(() => {}, 1000); return; }
process.stdout.write(typeof answer.stdout === 'string' ? answer.stdout : JSON.stringify(answer.stdout ?? null));
process.stderr.write(answer.stderr ?? '');
process.exit(answer.status ?? 0);
`;

// A stand-in that hangs is given this long, through FIRE_CHECK_TIMEOUT_MS, and
// only a case with one gets it: the stand-ins that answer before it, each a
// node starting up, stay far inside it on a loaded machine.
const HANG_MS = 5000;
const hangs = { FIRE_CHECK_TIMEOUT_MS: String(HANG_MS) };
// What the check then says, as a pattern's source.
const ranPast = `ran past ${String(HANG_MS / 1000).replace('.', '\\.')} s`;

const emptyStatus = { slots: 3, used: 0, staleMinutes: 90, lock: null, paused: null, tasks: [] };
const nothingToTake = {
  status: 3,
  stdout: { take: [], passed: [] },
  stderr: 'refused: nothing to take\n',
};
const offer = (...numbers) => ({
  status: 0,
  stdout: {
    take: numbers.map((iid) => ({ iid, priority: 4, areas: ['docs'], shared: 0 })),
    passed: [],
  },
});
const row = (task, origin, life, state = 'working') => ({
  task,
  origin,
  state,
  life,
  session: life === 'detached' ? null : '00000000-0000-4000-8000-000000000000',
  minutes: life === 'detached' ? null : life === 'DEAD' ? 120 : 1,
});
// A comment as `gh issue view --json comments` gives it.
const comment = (body, at = '2026-10-17T10:00:00Z') => ({
  id: `IC_${Date.parse(at)}`,
  author: { login: 'owner' },
  authorAssociation: 'OWNER',
  body,
  createdAt: at,
  includesCreatedEdit: false,
  isMinimized: false,
  minimizedReason: '',
  reactionGroups: [],
  url: 'https://github.com/acme/widgets/issues/1#issuecomment-1',
  viewerDidAuthor: true,
});
const ready = (number, extra = {}) => ({ number, labels: ['state:ready'], body: '', ...extra });

const FLOW = {
  project: { name: 'Widgets', repo: REPO, mainBranch: 'main' },
  commands: { test: 'npm test', taskTest: '', e2e: '' },
  schedule: { morningFire: '09:07' },
};

// A fixture: the data the stand-ins answer from, a flow.json, and a run of
// fire-check.
function checkFixture(t, data, flow = FLOW) {
  const dir = temporary(t, 'flow-fire-check-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(NODE, join(bin, 'node'));
  executable(join(bin, 'gh'), `#!${NODE}\n${GH}`);
  executable(join(bin, 'git'), `#!${NODE}\n${TOOL('git')}`);
  executable(join(bin, 'docker'), `#!${NODE}\n${TOOL('docker')}`);
  // CommonJS, as the other stand-ins are, so that a hang can return early.
  const queue = join(dir, 'queue.cjs');
  writeFileSync(queue, QUEUE);
  const file = join(dir, 'data.json');
  const flowFile = join(dir, 'flow.json');
  const set = (value) =>
    writeFileSync(
      file,
      JSON.stringify({ status: { stdout: emptyStatus }, pick: nothingToTake, ...value }),
    );
  const setFlow = (value) =>
    value === null ? rmSync(flowFile, { force: true }) : writeFileSync(flowFile, JSON.stringify(value));
  set(data);
  setFlow(flow);
  return {
    dir,
    bin,
    set,
    setFlow,
    calls: () => lines(`${file}.calls`).map((line) => JSON.parse(line)),
    check: (job, { now = '2026-10-17T12:00:00+03:00', env = {}, path = bin } = {}) =>
      spawnSync(NODE, [FIRE_CHECK, job], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: path,
          HOME: dir,
          TZ: 'Europe/Moscow',
          STUB_DATA: file,
          FIRE_CHECK_QUEUE: queue,
          FIRE_CHECK_NOW: now,
          FLOW_CONFIG: flowFile,
          ...env,
        },
      }),
  };
}

// The answer: its exit status and its one line.
function answer(result, status, pattern, label) {
  assert.equal(result.stderr, '', `${label}: stderr ${result.stderr}`);
  assert.match(
    result.stdout,
    /^(?:work|skip): [^\n]+\n$/,
    `${label}: not one line: ${result.stdout}`,
  );
  assert.equal(result.status, status, `${label}: exit ${result.status}, ${result.stdout}`);
  assert.match(result.stdout, pattern, `${label}: ${result.stdout}`);
}

const preconditionsAsked = (f) =>
  f
    .calls()
    .filter(
      (call) =>
        (call[0] === 'gh' && call[1] === 'api' && call[4] === `repos/${REPO}`) ||
        call[0] === 'git' ||
        call[0] === 'docker',
    );

// ---------------------------------------------------------------------------
// The command line and the configuration
// ---------------------------------------------------------------------------

test('fire-check takes one job and nothing else', (t) => {
  const f = checkFixture(t, {});
  for (const args of [[], ['night'], ['cycle', 'grooming'], ['--cycle']]) {
    const result = spawnSync(NODE, [FIRE_CHECK, ...args], {
      encoding: 'utf8',
      env: { PATH: f.bin },
    });
    assert.equal(result.status, 2, `${args.join(' ')}: exit ${result.status}`);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /^usage: node \.claude\/scripts\/fire-check\.mjs <cycle\|grooming>\n$/,
    );
  }
  assert.equal(
    f.check('cycle', { now: 'yesterday-ish' }).status,
    2,
    'a FIRE_CHECK_NOW that is no time',
  );
  assert.deepEqual(f.calls(), [], 'wrong usage asks nothing');
});

// A project whose flow.json cannot be read has not run /flow-init, or broke
// it: a session would stop at once, so neither job starts one.
test('a flow.json that cannot be read starts no session of either job, and asks nothing', (t) => {
  const f = checkFixture(t, { pick: offer(301), issues: [ready(301)] });
  for (const [flow, pattern] of [
    [null, /cannot be read \(ENOENT\): run \/flow-init/],
    [{ project: { repo: '' } }, /project\.repo is "", not owner\/name/],
    [{ project: { repo: 'nobody' } }, /project\.repo is "nobody", not owner\/name/],
    [
      { ...FLOW, schedule: { morningFire: '9:07' } },
      /schedule\.morningFire in \.claude\/flow\.json is not HH:MM or empty/,
    ],
  ]) {
    f.setFlow(flow);
    for (const job of ['cycle', 'grooming']) {
      if (flow?.schedule && job === 'cycle') continue;
      const result = f.check(job);
      answer(result, 1, /^skip: precondition flow failed \(/m, `${job} ${JSON.stringify(flow)}`);
      assert.match(result.stdout, pattern, job);
    }
  }
  assert.deepEqual(f.calls(), [], 'nothing was asked');
  // A malformed morning fire is the grooming's only: the cycle reads none.
  f.setFlow({ ...FLOW, schedule: { morningFire: '9:07' } });
  answer(f.check('cycle'), 0, /^work: #301 is ready to take$/m, 'the cycle ignores it');
});

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

// No ready issue and no row to resume is no work, and nothing past the queue
// is asked — no precondition either.
test('the cycle with nothing to resume and nothing to take answers skip, asking no precondition', (t) => {
  const f = checkFixture(t, {});
  answer(
    f.check('cycle'),
    1,
    /^skip: nothing to resume or take \(pick: nothing to take\)$/m,
    'empty',
  );
  assert.deepEqual(
    f.calls().map((call) => call.slice(0, 3)),
    [
      ['queue', 'status', '--json'],
      ['queue', 'pick', '--json'],
    ],
  );
  f.set({
    pick: {
      status: 3,
      stdout: { take: [], passed: [] },
      stderr:
        'refused: Slots: 3 of 3 in use. Lock: free. Queue: running. No slot is free: take no new issue.\n',
    },
  });
  answer(
    f.check('cycle'),
    1,
    /^skip: nothing to resume or take \(pick: Slots: 3 of 3 in use\. .*No slot is free/,
    'no slot',
  );
  assert.deepEqual(preconditionsAsked(f), []);
});

// A ready issue the cycle can take is work; one with an unticked box under
// the owner-steps heading, or with an earlier scheduled run's claim or
// result, is passed over at once, and so is one whose labels changed since
// the pick: an epic, an attended one, one no longer ready, one whose labels
// clash.
test('a ready issue is work unless an unticked owner step, an earlier run’s line or its labels pass it over', (t) => {
  const claim =
    'Scheduled run 2026-09-22 02:04:11 MSK: taken, mode `full` (docs/DELIVERY.md).\nBranch `feat/x`. A result comment follows on this issue.';
  const cases = [
    ['plain', { body: '## Problem\n\nx\n' }, true],
    [
      'an unticked owner step',
      {
        body: `## Problem\n\nx\n\n${OWNER_STEPS}\n\n- [x] done\n- [ ] set the secret\n\n## Touches\n\ndocs\n`,
      },
      false,
    ],
    [
      'an unticked owner step in a comment',
      { comments: [comment(`${OWNER_STEPS}\n\n* [ ] add the DNS record`)] },
      false,
    ],
    ['every owner step ticked', { body: `${OWNER_STEPS}\n\n- [x] one\n- [X] two\n` }, true],
    [
      'boxes under another heading',
      {
        body: `${OWNER_STEPS}\n\n- [x] one\n\n## Owner steps during delivery\n\n- [ ] install it\n`,
      },
      true,
    ],
    [
      'an owner-steps template in a fenced block',
      { body: `\`\`\`markdown\n${OWNER_STEPS}\n\n- [ ] example\n\`\`\`\n` },
      true,
    ],
    [
      'a step reported done in prose',
      { comments: [comment('Owner steps before delivery: the secret is set.')] },
      true,
    ],
    ['an earlier claim', { comments: [comment(claim)] }, false],
    [
      'an earlier DELIVERED',
      {
        comments: [
          comment('Scheduled run 2026-09-22 02:04:11 MSK: DELIVERED. PR #47, merged as `a1b2c3d`.'),
        ],
      },
      false,
    ],
    [
      'an earlier BLOCKED',
      { comments: [comment('Scheduled run 2026-09-22 02:04:11 MSK: BLOCKED, not delivered. x')] },
      false,
    ],
    [
      'an earlier RECOVERED',
      { comments: [comment('Scheduled run 2026-09-22 02:04:11 MSK: RECOVERED. x')] },
      false,
    ],
    [
      'a not-taken skip only',
      {
        comments: [
          comment(
            'Scheduled run 2026-09-22 02:04:11 MSK: not taken. No observable acceptance criteria could be derived from this issue.',
          ),
        ],
      },
      true,
    ],
    [
      'a claim quoted in a skip',
      {
        comments: [
          comment(
            `Scheduled run 2026-09-23 02:04:11 MSK: not taken. An earlier scheduled run has already commented on this issue — \`${claim.split('\n')[0]}\` — and the delivery queue holds no task for it.`,
          ),
        ],
      },
      true,
    ],
    [
      'a grooming run’s claim',
      {
        comments: [
          comment('Grooming run 2026-10-10 03:22:10 MSK: taken by the scheduled grooming'),
        ],
      },
      true,
    ],
    ['labelled type:epic', { labels: ['state:ready', 'type:epic'] }, false],
    ['labelled delivery:attended', { labels: ['state:ready', 'delivery:attended'] }, false],
    ['no longer state:ready', { labels: ['state:needs-owner'] }, false],
    ['closed', { state: 'CLOSED' }, false],
    ['two state: labels', { labels: ['state:ready', 'state:deferred'] }, false],
    ['two prio: labels', { labels: ['state:ready', 'prio:1', 'prio:2'] }, false],
    ['one prio: label and others', { labels: ['state:ready', 'prio:1', 'type:bug'] }, true],
  ];
  for (const [label, issue, work] of cases) {
    const f = checkFixture(t, { pick: offer(301), issues: [ready(301, issue)] });
    const result = f.check('cycle');
    if (work) {
      answer(result, 0, /^work: #301 is ready to take$/m, label);
      assert.deepEqual(
        preconditionsAsked(f),
        [
          ['gh', 'api', '--method', 'GET', `repos/${REPO}`],
          ['git', 'ls-remote', 'origin', 'HEAD'],
        ],
        `${label}: the preconditions, Docker not among them with no taskTest and no e2e`,
      );
    } else {
      answer(result, 1, /^skip: every ready candidate is passed over \(#301: /m, label);
      assert.deepEqual(preconditionsAsked(f), [], `${label}: no precondition without work`);
    }
    // The issue is read with its comments, from the configured repository.
    assert.deepEqual(
      f.calls().find((call) => call[1] === 'issue'),
      ['gh', 'issue', 'view', '301', '--repo', REPO, '--json', 'number,state,labels,body,comments'],
      label,
    );
  }

  // The next candidate is read when the first is passed over.
  const f = checkFixture(t, {
    pick: offer(302, 303, 304),
    issues: [
      ready(302, { body: `${OWNER_STEPS}\n- [ ] token\n` }),
      ready(303, { comments: [comment(claim)] }),
      ready(304),
    ],
  });
  answer(f.check('cycle'), 0, /^work: #304 is ready to take$/m, 'the third candidate');
  f.set({
    pick: offer(302, 303),
    issues: [
      ready(302, { body: `${OWNER_STEPS}\n- [ ] token\n` }),
      ready(303, { comments: [comment(claim)] }),
    ],
  });
  answer(
    f.check('cycle'),
    1,
    /^skip: every ready candidate is passed over \(#302: an unticked box under ## Owner steps before delivery; #303: an earlier scheduled run's line: Scheduled run 2026-09-22 02:04:11 MSK: taken, mode `full` \(docs\/DELIVERY\.md\)\.\)$/m,
    'both passed over',
  );
  // More candidates than are read is work: it cannot tell.
  const many = Array.from({ length: MAX_CYCLE_CANDIDATES + 1 }, (_, i) => 500 + i);
  f.set({
    pick: offer(...many),
    issues: many.map((number) => ready(number, { body: `${OWNER_STEPS}\n- [ ] x\n` })),
  });
  answer(
    f.check('cycle'),
    0,
    /^work: cannot tell: 11 ready candidates, the first 10 passed over$/m,
    'many',
  );
});

// An epic is a container `/decompose` made: never delivered. Should the pick
// offer one — its list a moment old, or a label added since — the check
// passes it over and the fire starts nothing for it.
test('an issue labelled type:epic is never work for the cycle, even state:ready and offered', (t) => {
  const f = checkFixture(t, {
    pick: offer(310),
    issues: [ready(310, { labels: ['state:ready', 'type:epic', 'prio:1'] })],
  });
  answer(
    f.check('cycle'),
    1,
    /^skip: every ready candidate is passed over \(#310: labelled type:epic: an epic is never delivered itself\)$/m,
    'an epic alone',
  );
  assert.deepEqual(preconditionsAsked(f), []);
  f.set({
    pick: offer(310, 311),
    issues: [ready(310, { labels: ['state:ready', 'type:epic'] }), ready(311)],
  });
  answer(f.check('cycle'), 0, /^work: #311 is ready to take$/m, 'the issue after the epic');
});

// A fire's dead task is resumed; a day task its session has not detached is
// the owner's.
test('a DEAD or detached fire row is work, a DEAD day row is not, and a detached day row is', (t) => {
  const cases = [
    [
      'a DEAD fire row',
      [row('401', 'fire', 'DEAD')],
      /^work: resume #401 \(fire task, DEAD\)$/m,
      0,
    ],
    [
      'a detached fire row',
      [row('402', 'fire', 'detached', 'paused')],
      /^work: resume #402 \(fire task, detached\)$/m,
      0,
    ],
    ['a DEAD day row', [row('day-a', 'day', 'DEAD')], /^skip: nothing to resume or take/m, 1],
    [
      'a detached day row',
      [row('day-b', 'day', 'detached')],
      /^work: resume day-b \(day task, detached\)$/m,
      0,
    ],
    ['an alive fire row', [row('403', 'fire', 'alive')], /^skip: nothing to resume or take/m, 1],
    [
      'a DEAD day row before a DEAD fire row',
      [row('day-a', 'day', 'DEAD'), row('404', 'fire', 'DEAD')],
      /^work: resume #404 /m,
      0,
    ],
  ];
  for (const [label, tasks, pattern, status] of cases) {
    const f = checkFixture(t, { status: { stdout: { ...emptyStatus, tasks } } });
    answer(f.check('cycle'), status, pattern, label);
    const picked = f.calls().some((call) => call[0] === 'queue' && call[1] === 'pick');
    assert.equal(picked, status === 1, `${label}: pick is asked only without resume work`);
  }
  // A task awaiting the lock is taken only while the lock is free and the
  // queue runs, as Resume first takes it.
  const waiting = row('405', 'fire', 'detached', 'awaiting-lock');
  for (const [label, status, code] of [
    ['the lock free', { ...emptyStatus, tasks: [waiting] }, 0],
    ['the lock held', { ...emptyStatus, lock: { task: '406', since: 'x' }, tasks: [waiting] }, 1],
    [
      'the queue paused',
      { ...emptyStatus, paused: { since: 'x', reason: 'smoke' }, tasks: [waiting] },
      1,
    ],
  ]) {
    const f = checkFixture(t, { status: { stdout: status } });
    assert.equal(f.check('cycle').status, code, label);
  }
  assert.equal(resumable({ lock: null, paused: null, tasks: [] }), null);
  assert.throws(() =>
    resumable({ lock: null, paused: null, tasks: [{ task: '1', origin: 'night', life: 'DEAD' }] }),
  );
  assert.throws(() => resumable({ tasks: 'none' }));
});

// Work with a precondition failing starts nothing, and the line names the
// check. Docker is one only where the project's suites need it.
test('each precondition failing or hanging with work present answers skip and names it; Docker only with taskTest or e2e', (t) => {
  const issues = [ready(301)];
  const withDocker = { ...FLOW, commands: { ...FLOW.commands, taskTest: 'npm run test:task -- {task}' } };
  const withE2e = { ...FLOW, commands: { ...FLOW.commands, e2e: 'npm run e2e' } };
  for (const [name, data, flow, env] of [
    ['github', { ghRules: [{ match: `^api --method GET repos/${REPO}$`, mode: 'fail' }] }, FLOW],
    ['remote', { tools: { git: 'fail' } }, FLOW],
    ['docker', { tools: { docker: 'fail' } }, withDocker],
    ['docker', { tools: { docker: 'fail' } }, withE2e],
    ['docker', { tools: { docker: 'hang' } }, withDocker, hangs],
  ]) {
    const f = checkFixture(t, { pick: offer(301), issues, ...data }, flow);
    answer(
      f.check('cycle', { env }),
      1,
      new RegExp(
        `^skip: precondition ${name} failed with work present \\(#301 is ready to take\\)$`,
        'm',
      ),
      `${name} ${JSON.stringify(data)}`,
    );
  }
  // Docker down does not matter to a project whose suites do not need it.
  const quiet = checkFixture(t, { pick: offer(301), issues, tools: { docker: 'fail' } });
  answer(quiet.check('cycle'), 0, /^work: #301 is ready to take$/m, 'no docker needed');
  assert.ok(!quiet.calls().some((call) => call[0] === 'docker'), 'docker is not asked');
  const needed = checkFixture(t, { pick: offer(301), issues }, withDocker);
  answer(needed.check('cycle'), 0, /^work: #301 is ready to take$/m, 'docker answers');
  assert.deepEqual(preconditionsAsked(needed).at(-1), ['docker', 'info']);

  // With resume work, and with work it could not tell, the same.
  const f = checkFixture(
    t,
    {
      status: { stdout: { ...emptyStatus, tasks: [row('401', 'fire', 'DEAD')] } },
      tools: { docker: 'fail' },
    },
    withDocker,
  );
  answer(
    f.check('cycle'),
    1,
    /^skip: precondition docker failed with work present \(resume #401 \(fire task, DEAD\)\)$/m,
    'resume',
  );
  f.set({ status: { stdout: 'garbage' }, tools: { git: 'fail' } });
  answer(
    f.check('cycle'),
    1,
    /^skip: precondition remote failed with work present \(cannot tell: the queue's status --json did not answer JSON\)$/m,
    'cannot tell',
  );
  // gh missing altogether.
  const g = checkFixture(t, { pick: offer(301), issues });
  rmSync(join(g.bin, 'gh'));
  answer(
    g.check('cycle'),
    1,
    /^skip: precondition github failed with work present \(cannot tell: gh issue view 301: ENOENT\)$/m,
    'no gh',
  );
});

// Whatever fails or answers garbage is work.
test('a command failing, hanging or answering garbage makes the cycle answer work', (t) => {
  const issues = [ready(301)];
  const cases = [
    [
      'status garbage',
      { status: { stdout: '{"tasks":' } },
      /cannot tell: the queue's status --json did not answer JSON/,
    ],
    [
      'status of another shape',
      { status: { stdout: { tasks: {} } } },
      /cannot tell: the queue's status --json answered an unexpected shape/,
    ],
    [
      'status failing',
      { status: { status: 1, stdout: '', stderr: 'fault: the state is not the queue’s\n' } },
      /cannot tell: the queue's status --json: exit 1: fault/,
    ],
    [
      'status hanging',
      { status: { hang: true } },
      new RegExp(`cannot tell: the queue's status: ${ranPast}`),
      hangs,
    ],
    [
      'pick failing',
      { pick: { status: 1, stdout: '', stderr: 'fault: gh issue list failed\n' } },
      /cannot tell: the queue's pick --json: exit 1/,
    ],
    [
      'pick garbage',
      { pick: { status: 0, stdout: 'Offer to the gates' } },
      /cannot tell: the queue's pick --json did not answer JSON/,
    ],
    [
      'pick offering nothing with exit 0',
      { pick: { status: 0, stdout: { take: [] } } },
      /cannot tell: the queue's pick --json answered an unexpected shape/,
    ],
    [
      'pick offering no issue',
      { pick: { status: 0, stdout: { take: [{ iid: 'x' }] } } },
      /cannot tell: the queue's pick --json offered something that is no issue/,
    ],
    [
      'the issue failing',
      { pick: offer(301), ghRules: [{ match: '^issue view 301 ', mode: 'fail' }] },
      /cannot tell: gh issue view 301: exit 1: HTTP 404/,
    ],
    [
      'the issue gone',
      { pick: offer(302) },
      /cannot tell: gh issue view 302: exit 1: GraphQL: Could not resolve/,
    ],
    [
      'the issue garbage',
      { pick: offer(301), ghRules: [{ match: '^issue view', mode: 'garbage' }] },
      /cannot tell: gh issue view 301 did not answer JSON/,
    ],
    [
      'the issue without its comments',
      { pick: offer(301), ghRules: [{ match: '^issue view', mode: 'object' }] },
      /cannot tell: gh issue view 301 answered an unexpected shape/,
    ],
    [
      'a comment that is none',
      { pick: offer(301), issues: [ready(301, { comments: [{ body: 7 }] })] },
      /cannot tell: a comment of #301 is not one/,
    ],
    [
      'the issue hanging',
      { pick: offer(301), ghRules: [{ match: '^issue view', mode: 'hang' }] },
      new RegExp(`cannot tell: gh issue view 301: ${ranPast}`),
      hangs,
    ],
  ];
  for (const [label, data, pattern, env] of cases) {
    const f = checkFixture(t, { issues, ...data });
    answer(f.check('cycle', { env }), 0, new RegExp(`^work: ${pattern.source}`, 'm'), label);
  }
});

// ---------------------------------------------------------------------------
// The grooming
// ---------------------------------------------------------------------------

const open = (number, labels = [], extra = {}) => ({ number, labels, body: '', ...extra });
const waitingIssues = (count, from = 900) =>
  Array.from({ length: count }, (_, i) => open(from + i, ['state:needs-owner']));
const MORNING_AT = '2026-10-17T09:07:00+03:00';
const NOON = '2026-10-17T12:00:00+03:00';
const result = (time, words) => comment(`Grooming run ${time}: ${words}`);

// Ten or more issues waiting for the owner is no work but in the morning
// range; fewer, work only with an unseen candidate or a stale claim.
test('the grooming with ten or more waiting for the owner skips outside the morning range and works inside it', (t) => {
  const f = checkFixture(t, { issues: [...waitingIssues(NEEDS_OWNER_LIMIT), open(10)] });
  answer(
    f.check('grooming', { now: NOON }),
    1,
    /^skip: 10 open issues wait for the owner \(state:needs-owner\), 10 or more$/m,
    'ten',
  );
  for (const at of ['09:07:00', '09:14:59', '09:21:59']) {
    answer(
      f.check('grooming', { now: `2026-10-17T${at}+03:00` }),
      0,
      /^work: morning notification \(09:07–09:21\)$/m,
      at,
    );
  }
  for (const at of ['09:06:59', '09:22:00', '21:07:00']) {
    assert.equal(f.check('grooming', { now: `2026-10-17T${at}+03:00` }).status, 1, at);
  }
  // The morning range is the machine's local time: 06:07 UTC is 09:07 in Moscow.
  answer(
    f.check('grooming', { now: '2026-10-17T06:07:00Z' }),
    0,
    /^work: morning notification/m,
    'UTC',
  );
  assert.equal(
    f.check('grooming', { now: '2026-10-17T06:07:00Z', env: { TZ: 'UTC' } }).status,
    1,
    'in UTC it is 06:07',
  );
  // The morning asks GitHub nothing.
  const before = f.calls().length;
  f.check('grooming', { now: MORNING_AT });
  assert.equal(f.calls().length, before, 'the morning answer reads nothing');
  // Past a page the count is still exact, gh reading every page; nine is not ten.
  f.set({ issues: [...waitingIssues(130), open(10)] });
  answer(
    f.check('grooming', { now: NOON }),
    1,
    /^skip: 130 open issues wait for the owner \(state:needs-owner\), 10 or more$/m,
    'past a page',
  );
  f.set({ issues: [...waitingIssues(NEEDS_OWNER_LIMIT - 1), open(10)] });
  answer(
    f.check('grooming', { now: NOON }),
    0,
    /^work: #10 is a candidate the owner has not seen$/m,
    'nine',
  );
  // The lists, word for word.
  const listed = f.calls().filter((call) => call[1] === 'issue' && call[2] === 'list');
  assert.deepEqual(listed.slice(-3), [
    [
      'gh',
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--label',
      'state:grooming',
      '--json',
      'number,title,labels,body,updatedAt',
      '--limit',
      String(MAX_LISTED),
    ],
    [
      'gh',
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--label',
      'state:needs-owner',
      '--json',
      'number,title,labels,body,updatedAt',
      '--limit',
      String(MAX_LISTED),
    ],
    [
      'gh',
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'open',
      '--json',
      'number,title,labels,body,updatedAt',
      '--limit',
      String(MAX_LISTED),
    ],
  ]);
  assert.deepEqual(f.calls().at(-1), [
    'gh',
    'api',
    '--method',
    'GET',
    `repos/${REPO}/issues/10/events?per_page=100&page=1`,
  ]);
});

// The morning fire is `schedule.morningFire`: its minute and the fourteen
// after it, before the next grooming fire; empty, there is no morning run.
test('the morning range is schedule.morningFire and the fourteen minutes after it, none when it is empty', (t) => {
  const f = checkFixture(
    t,
    { issues: waitingIssues(NEEDS_OWNER_LIMIT) },
    { ...FLOW, schedule: { morningFire: '07:52' } },
  );
  answer(
    f.check('grooming', { now: '2026-10-17T07:52:00+03:00' }),
    0,
    /^work: morning notification \(07:52–08:06\)$/m,
    '07:52',
  );
  answer(
    f.check('grooming', { now: '2026-10-17T08:06:59+03:00' }),
    0,
    /^work: morning notification/m,
    '08:06',
  );
  for (const at of ['07:51:59', '08:07:00', '09:07:00']) {
    assert.equal(f.check('grooming', { now: `2026-10-17T${at}+03:00` }).status, 1, at);
  }
  f.setFlow({ ...FLOW, schedule: { morningFire: '' } });
  answer(
    f.check('grooming', { now: MORNING_AT }),
    1,
    /^skip: 10 open issues wait for the owner/m,
    'no morning run',
  );
  f.setFlow({ ...FLOW, schedule: { morningFire: '23:55' } });
  for (const at of ['2026-10-17T23:55:00+03:00', '2026-10-18T00:09:00+03:00']) {
    answer(
      f.check('grooming', { now: at }),
      0,
      /^work: morning notification \(23:55–00:09\)$/m,
      at,
    );
  }
  assert.equal(f.check('grooming', { now: '2026-10-18T00:10:00+03:00' }).status, 1, '00:10');

  assert.deepEqual(morningRange('09:07'), { from: 547, to: 561, text: '09:07–09:21' });
  assert.equal(morningRange(''), null);
  for (const bad of ['9:07', '24:00', '09:60', '09:07 ', 'morning']) {
    assert.throws(() => morningRange(bad), /not HH:MM or empty/, bad);
  }
  assert.ok(inMorning(new Date(2026, 9, 17, 9, 7).getTime()));
  assert.ok(!inMorning(new Date(2026, 9, 17, 9, 22).getTime()));
  assert.ok(!inMorning(new Date(2026, 9, 17, 9, 7).getTime(), null));
});

test('with fewer waiting, the grooming works only for an unseen candidate or a claim two hours old', (t) => {
  const cases = [
    ['an unseen candidate', [open(10)], 0, /^work: #10 is a candidate the owner has not seen$/m],
    [
      'no candidate',
      [open(11, ['state:ready']), open(12, ['state:deferred']), ...waitingIssues(2)],
      1,
      /^skip: no candidate: every open issue carries a state label or is an epic$/m,
    ],
    [
      'a candidate with a ready result',
      [
        open(13, [], {
          comments: [result('2026-10-10 03:22:10 MSK', 'ready without the owner. x')],
        }),
      ],
      1,
      /^skip: no candidate the owner has not seen \(1 seen\)$/m,
    ],
    [
      'a candidate with a waits result',
      [open(14, [], { comments: [result('2026-10-10 03:22:10 MSK', 'waits for the owner. x')] })],
      1,
      /^skip: no candidate the owner has not seen/m,
    ],
    [
      'a candidate a /groom chat released',
      [open(15, [], { comments: [result('2026-10-10 03:22:10 MSK', `${RELEASED}.`)] })],
      1,
      /^skip: no candidate the owner has not seen/m,
    ],
    [
      'a candidate once labelled state:grooming',
      [
        open(16, [], {
          events: [
            { event: 'unlabeled', label: { name: 'state:ready', color: 'ededed' } },
            { event: 'labeled', label: { name: 'state:grooming', color: 'ededed' } },
          ],
        }),
      ],
      1,
      /^skip: no candidate the owner has not seen/m,
    ],
    [
      'a label event that removed state:grooming only',
      [
        open(17, [], {
          events: [
            { event: 'unlabeled', label: { name: 'state:grooming' } },
            { event: 'labeled', label: null },
            { event: 'renamed', rename: { from: 'a', to: 'b' } },
          ],
        }),
      ],
      0,
      /^work: #17 is a candidate/m,
    ],
    [
      'the scoped GitLab spelling is not this flow’s label',
      [open(26, [], { events: [{ event: 'labeled', label: { name: 'state::grooming' } }] })],
      0,
      /^work: #26 is a candidate/m,
    ],
    [
      'a grooming claim only, no result',
      [
        open(18, [], {
          comments: [result('2026-10-10 03:22:10 MSK', 'taken by the scheduled grooming')],
        }),
      ],
      0,
      /^work: #18 is a candidate/m,
    ],
    [
      'a result quoted further down a comment',
      [
        open(19, [], {
          comments: [
            comment(`Looked at it.\nGrooming run 2026-10-10 03:22:10 MSK: waits for the owner.`),
          ],
        }),
      ],
      0,
      /^work: #19 is a candidate/m,
    ],
    [
      'the newest unseen of several',
      [
        open(20, [], { comments: [result('2026-10-10 03:22:10 MSK', 'waits for the owner.')] }),
        open(21),
      ],
      0,
      /^work: #21 is a candidate/m,
    ],
    [
      'an epic, unseen, is no candidate',
      [open(22, ['type:epic']), open(23, ['state:ready'])],
      1,
      /^skip: no candidate: every open issue carries a state label or is an epic$/m,
    ],
    [
      'an epic beside an unseen issue, the epic the newer',
      [open(24), open(25, ['type:epic'])],
      0,
      /^work: #24 is a candidate the owner has not seen$/m,
    ],
    [
      'a child of an epic is a candidate like any other',
      [open(27, ['type:epic']), open(28, [], { body: '## Problem\n\nx\n\nEpic: #27\n' })],
      0,
      /^work: #28 is a candidate the owner has not seen$/m,
    ],
    [
      'a stale claim',
      [
        open(30, ['state:grooming'], {
          comments: [result('2026-10-17 09:59:59 MSK', 'taken by the scheduled grooming')],
        }),
        ...waitingIssues(NEEDS_OWNER_LIMIT),
      ],
      0,
      /^work: the claim of 2026-10-17 09:59:59 MSK on #30 is two hours old or more$/m,
    ],
    [
      'a stale takeover claim',
      [
        open(31, ['state:grooming'], {
          comments: [
            result(
              '2026-10-17 10:00:00 MSK',
              'taken over from the grooming run of 2026-10-17 07:00:00 MSK',
            ),
          ],
        }),
      ],
      0,
      /^work: the claim of 2026-10-17 10:00:00 MSK on #31 /m,
    ],
    [
      'a fresh claim',
      [
        open(32, ['state:grooming'], {
          comments: [result('2026-10-17 10:00:01 MSK', 'taken by the scheduled grooming')],
        }),
        open(10),
      ],
      1,
      /^skip: the grooming run of 2026-10-17 10:00:01 MSK still holds #32 \(its claim is under two hours old\)$/m,
    ],
    [
      'a fresh claim beside a stale one',
      [
        open(33, ['state:grooming'], {
          comments: [result('2026-10-17 07:00:00 MSK', 'taken by the scheduled grooming')],
        }),
        open(34, ['state:grooming'], {
          comments: [result('2026-10-17 11:30:00 MSK', 'taken by the scheduled grooming')],
        }),
      ],
      1,
      /^skip: the grooming run of 2026-10-17 11:30:00 MSK still holds #34/m,
    ],
    [
      'a claim followed by its result',
      [
        open(35, ['state:grooming'], {
          comments: [
            comment(
              'Grooming run 2026-10-17 11:00:00 MSK: waits for the owner.',
              '2026-10-17T08:20:00Z',
            ),
            comment(
              'Grooming run 2026-10-17 11:00:00 MSK: taken by the scheduled grooming',
              '2026-10-17T08:00:00Z',
            ),
          ],
        }),
      ],
      1,
      /^skip: no candidate:/m,
    ],
    [
      'a claim in UTC',
      [
        open(36, ['state:grooming'], {
          comments: [result('2026-10-17 08:00:00 UTC', 'taken by the scheduled grooming')],
        }),
      ],
      1,
      /^skip: the grooming run of 2026-10-17 08:00:00 UTC still holds #36/m,
    ],
    [
      'a claim in UTC two hours old',
      [
        open(37, ['state:grooming'], {
          comments: [result('2026-10-17 07:00:00 UTC', 'taken by the scheduled grooming')],
        }),
      ],
      0,
      /^work: the claim of 2026-10-17 07:00:00 UTC on #37 /m,
    ],
    [
      'a claim with a numeric offset',
      [
        open(38, ['state:grooming'], {
          comments: [result('2026-10-17 10:30:00 +0200', 'taken by the scheduled grooming')],
        }),
      ],
      1,
      /^skip: the grooming run of 2026-10-17 10:30:00 \+0200 still holds #38/m,
    ],
  ];
  for (const [label, issues, status, pattern] of cases) {
    const f = checkFixture(t, { issues });
    answer(f.check('grooming', { now: NOON }), status, pattern, label);
  }
});

// Grooming never takes an epic: `/decompose` made it, and it is groomed and
// delivered through its children (D25). The check neither counts one as a
// candidate nor reads its history.
test('the grooming never counts an epic as a candidate, nor reads one', (t) => {
  const seenNote = [comment('Grooming run 2026-10-10 03:22:10 MSK: waits for the owner.')];
  const epics = Array.from({ length: MAX_GROOMING_LOOKUPS + 5 }, (_, i) =>
    open(4000 + i, ['type:epic', 'area:docs']),
  );
  const f = checkFixture(t, { issues: [...epics, open(12, [], { comments: seenNote })] });
  answer(
    f.check('grooming', { now: NOON }),
    1,
    /^skip: no candidate the owner has not seen \(1 seen\)$/m,
    'only epics unseen',
  );
  const read = f
    .calls()
    .filter((call) => (call[1] === 'issue' && call[2] === 'view') || call[1] === 'api')
    .map((call) => call[3] ?? call[4]);
  // Only the one candidate is read, seen by its comment before its events.
  assert.deepEqual(read, ['12']);
});

test('the grooming reads every page, bounds its lookups, and answers work for what it cannot tell', (t) => {
  // The one unseen candidate is past the first hundred open issues.
  const seenNote = [comment('Grooming run 2026-10-10 03:22:10 MSK: waits for the owner.')];
  const issues = [
    ...Array.from({ length: 120 }, (_, i) => open(1000 + i, ['state:ready'])),
    open(5),
    ...Array.from({ length: 3 }, (_, i) => open(2000 + i, [], { comments: seenNote })),
  ];
  const f = checkFixture(t, { issues });
  answer(
    f.check('grooming', { now: NOON }),
    0,
    /^work: #5 is a candidate the owner has not seen$/m,
    'past a page',
  );
  // The label event on the second page of events is read.
  const events = [
    ...Array.from({ length: 100 }, () => ({ event: 'labeled', label: { name: 'type:bug' } })),
    { event: 'labeled', label: { name: 'state:grooming' } },
  ];
  f.set({ issues: [open(6, [], { events })] });
  answer(
    f.check('grooming', { now: NOON }),
    1,
    /^skip: no candidate the owner has not seen \(1 seen\)$/m,
    'events page two',
  );
  assert.deepEqual(
    f
      .calls()
      .filter((call) => call[1] === 'api')
      .slice(-2)
      .map((call) => call[4]),
    [
      `repos/${REPO}/issues/6/events?per_page=100&page=1`,
      `repos/${REPO}/issues/6/events?per_page=100&page=2`,
    ],
  );
  // More candidates than it reads, all seen: it cannot tell.
  const seenMany = Array.from({ length: MAX_GROOMING_LOOKUPS + 1 }, (_, i) =>
    open(3000 + i, [], { comments: seenNote }),
  );
  f.set({ issues: seenMany });
  answer(
    f.check('grooming', { now: NOON }),
    0,
    /^work: cannot tell: 21 candidates, the first 20 seen by the owner$/m,
    'many',
  );

  const cases = [
    [
      'the list failing',
      { ghRules: [{ match: '--label state:grooming', mode: 'fail' }] },
      /cannot tell: gh issue list --label state:grooming: exit 1/,
    ],
    [
      'the list garbage',
      { ghRules: [{ match: '--label state:needs-owner', mode: 'garbage' }] },
      /cannot tell: gh issue list --label state:needs-owner did not answer JSON/,
    ],
    [
      'the list not a list',
      { ghRules: [{ match: '^issue list --repo acme/widgets --state open --json', mode: 'object' }] },
      /cannot tell: gh issue list did not answer a list/,
    ],
    [
      'a list at its limit',
      { issues: waitingIssues(MAX_LISTED) },
      /cannot tell: gh issue list --label state:needs-owner listed 1000 or more issues/,
    ],
    [
      'the events hanging',
      { issues: [open(10)], ghRules: [{ match: '/events', mode: 'hang' }] },
      new RegExp(`cannot tell: gh api .*/events.*: ${ranPast}`),
      hangs,
    ],
    [
      'the events not a list',
      { issues: [open(10)], ghRules: [{ match: '/events', mode: 'object' }] },
      /cannot tell: gh api repos\/acme\/widgets\/issues\/10\/events\?per_page=100&page=1 did not answer a list/,
    ],
    [
      'more pages of events than it reads',
      {
        issues: [
          open(10, [], {
            events: Array.from({ length: 1000 }, () => ({ event: 'labeled', label: { name: 'x' } })),
          }),
        ],
      },
      /cannot tell: the events of #10 have more than 10 pages/,
    ],
    [
      'a claim time it cannot read',
      {
        issues: [
          open(40, ['state:grooming'], {
            comments: [
              comment('Grooming run 2026-10-17 10:00:00 CEST: taken by the scheduled grooming'),
            ],
          }),
        ],
      },
      /cannot tell: the claim time on #40 reads 2026-10-17 10:00:00 CEST/,
    ],
    [
      'an issue of another shape',
      { issues: [{ number: 'x', labels: 'none' }] },
      /cannot tell: gh issue list listed something that is no issue/,
    ],
    // GitHub keeps neither state label unique: two are a fault of that
    // issue, which a run reports, never read as either.
    [
      'two state: labels on a candidate',
      { issues: [open(41, ['state:ready', 'state:deferred'])] },
      /cannot tell: #41 carries 2 state: labels \(state:deferred, state:ready\)$/,
    ],
    [
      'two state: labels on a held issue',
      { issues: [open(42, ['state:grooming', 'state:needs-owner'])] },
      /cannot tell: #42 carries 2 state: labels \(state:grooming, state:needs-owner\)$/,
    ],
  ];
  for (const [label, data, pattern, env] of cases) {
    const g = checkFixture(t, { issues: [open(10, [], { comments: seenNote })], ...data });
    answer(
      g.check('grooming', { now: NOON, env }),
      0,
      new RegExp(`^work: ${pattern.source}`, 'm'),
      label,
    );
  }
  const h = checkFixture(t, { issues: [] });
  rmSync(join(h.bin, 'gh'));
  answer(
    h.check('grooming', { now: NOON }),
    0,
    /^work: cannot tell: gh issue list --label state:grooming: ENOENT$/m,
    'no gh',
  );
});

// ---------------------------------------------------------------------------
// The readers, on made-up text at growing sizes
// ---------------------------------------------------------------------------

test(
  'the readers of issue text answer for made-up text at any length',
  { timeout: 120_000 },
  () => {
    for (const size of [1_000, 100_000, 1_000_000]) {
      const started = Date.now();
      assert.equal(
        hasUntickedOwnerStep(`${OWNER_STEPS}\n${'- [x] done\n'.repeat(size / 10)}`),
        false,
        `${size} ticked`,
      );
      assert.equal(
        hasUntickedOwnerStep(`${OWNER_STEPS}\n${' '.repeat(size)}- [ ] x`),
        true,
        `${size} indent`,
      );
      assert.equal(hasUntickedOwnerStep(`${'#'.repeat(size)}\n- [ ] x`), false, `${size} hashes`);
      assert.equal(
        hasUntickedOwnerStep(`${OWNER_STEPS}\n${'```\n'.repeat(size / 4)}- [ ] x`),
        true,
        `${size} fences, even`,
      );
      assert.equal(
        hasUntickedOwnerStep(`${OWNER_STEPS}\n${'1'.repeat(size)}. [ ] x`),
        false,
        `${size} digits`,
      );
      assert.equal(
        hasUntickedOwnerStep('- [ ] '.repeat(size / 6)),
        false,
        `${size} boxes, no heading`,
      );
      assert.equal(
        earlierRunLine(`Scheduled run ${': '.repeat(size / 2)}taken`),
        null,
        `${size} separators`,
      );
      assert.equal(
        earlierRunLine(`Scheduled run ${'x'.repeat(size)}: taken`),
        null,
        `${size} long time`,
      );
      assert.equal(
        earlierRunLine('Scheduled run t: not taken.\n'.repeat(size / 28)),
        null,
        `${size} skips`,
      );
      assert.match(
        earlierRunLine(`${'x\n'.repeat(size / 2)}Scheduled run t: BLOCKED, not delivered.`),
        /BLOCKED/,
        `${size} lines`,
      );
      assert.equal(groomingLine(`Grooming run ${':'.repeat(size)}`), null, `${size} colons`);
      assert.equal(
        groomingLine(`Grooming run t: ${'taken'.repeat(size / 5)}`).kind,
        'other',
        `${size} taken run together`,
      );
      assert.equal(runTime(`2026-10-17 10:00:00 ${'M'.repeat(size)}`), null, `${size} zone`);
      assert.ok(Date.now() - started < 20_000, `${size}: ${Date.now() - started} ms`);
    }
    // The words, exactly.
    assert.equal(earlierRunLine('Scheduled run 2026-09-22 02:04:11 MSK: takenly'), null);
    assert.equal(earlierRunLine('> Scheduled run 2026-09-22 02:04:11 MSK: taken'), null);
    assert.equal(earlierRunLine(' Scheduled run 2026-09-22 02:04:11 MSK: taken'), null);
    assert.equal(earlierRunLine('Scheduled run 2026-09-22 02:04:11 MSK: delivered'), null);
    assert.equal(earlierRunLine('```\nScheduled run 2026-09-22 02:04:11 MSK: taken\n```'), null);
    assert.deepEqual(
      groomingLine('Grooming run 2026-10-10 03:22:10 MSK: ready without the owner. x'),
      { time: '2026-10-10 03:22:10 MSK', kind: 'result' },
    );
    assert.equal(
      groomingLine('Grooming run 2026-10-10 03:22:10 MSK: taken over from the grooming run of x')
        .kind,
      'claim',
    );
    assert.equal(
      groomingLine(`Grooming run 2026-10-10 03:22:10 MSK: ${RELEASED}.`).kind,
      'released',
    );
    assert.equal(
      groomingLine('Grooming run 2026-10-10 03:22:10 MSK: waits for the owners.').kind,
      'other',
    );
    assert.equal(groomingLine('Scheduled run 2026-10-10 03:22:10 MSK: taken'), null);
    assert.equal(runTime('2026-10-10 03:22:10 MSK'), Date.parse('2026-10-10T00:22:10Z'));
    assert.equal(runTime('2026-10-10 03:22:10 +0300'), Date.parse('2026-10-10T00:22:10Z'));
    assert.equal(runTime('2026-10-10 03:22:10 PDT'), null);
    assert.equal(runTime('2026-13-40 03:22:10 MSK'), null);
    assert.equal(
      hasUntickedOwnerStep(`${OWNER_STEPS}  \n1) [ ] x`),
      true,
      'trailing spaces and 1)',
    );
    assert.equal(
      hasUntickedOwnerStep(`### ${OWNER_STEPS.slice(3)}\n- [ ] x`),
      false,
      'another level',
    );
    assert.equal(
      hasUntickedOwnerStep(`${OWNER_STEPS}\n- [~] x\n-[ ] y\n- [  ] z`),
      false,
      'not boxes',
    );
  },
);
