// The scheduled fires (D17): the launchd job's program,
// `.claude/scripts/scheduled-fire.sh`, and the jobs' installer under
// `.claude/scripts/launchd/`. Nothing here reaches GitHub, the remote,
// launchd or Claude: the check, `claude`, `caffeinate`, `osascript` and
// `launchctl` are stand-ins in temporary directories, first on PATH or under
// a temporary HOME, that answer from a file and record each call. Each fixture
// is a checkout of its own in a temporary directory, holding copies of the
// scripts under test and a `.claude/flow.json` of its own (D23). The commands
// are compared as text, not by a shell parser.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const WRAPPER = join(root, '.claude', 'scripts', 'scheduled-fire.sh');
const LAUNCHD = join(root, '.claude', 'scripts', 'launchd');
const FLOW_CONFIG = join(root, '.claude', 'scripts', 'flow-config.mjs');
const NODE = process.execPath;

// The fixtures' configuration: the repository names the logs and the jobs,
// the project's name titles the morning notification.
const FLOW = {
  project: { name: 'Fixture Project', repo: 'owner/fixture-repo' },
  schedule: { cycle: '*/30 * * * *', grooming: '7,22,37,52 * * * *' },
};

const temporary = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const executable = (path, text) => writeFileSync(path, text, { mode: 0o755 });
const lines = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

// ---------------------------------------------------------------------------
// scheduled-fire.sh, with a stand-in claude, caffeinate, osascript and check
// ---------------------------------------------------------------------------

// The stand-in claude records its arguments, its environment and its working
// directory, then writes the lines of `$HOME/plan.json` to its stdout: a
// string is a line, `{ "wait": "<file>" }` waits until that file exists.
// `auth status` answers the plan's `auth`.
const CLAUDE = `
const fs = require('node:fs');
const home = process.env.HOME;
const plan = JSON.parse(fs.readFileSync(home + '/plan.json', 'utf8'));
const args = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (error) { input = 'unreadable: ' + error.code; }
fs.appendFileSync(home + '/claude-calls.jsonl', JSON.stringify({ args, env: process.env, cwd: process.cwd(), input, pid: process.pid, binary: process.argv[1] }) + '\\n');
if (args[0] === 'auth') { process.stdout.write(plan.auth ?? '{}'); process.exit(0); }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (const step of plan.lines ?? []) {
  if (typeof step === 'string') { fs.writeSync(1, step + '\\n'); continue; }
  const until = Date.now() + 30000;
  while (!fs.existsSync(step.wait) && Date.now() < until) sleep(50);
}
process.exit(plan.exit ?? 0);
`;

// caffeinate and osascript: record the call; caffeinate then runs the rest
// of its arguments after its two flags, as the real one runs its utility.
const CAFFEINATE = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/caffeinate-calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] !== '-i' || args[1] !== '-s') process.exit(64);
const result = spawnSync(args[2], args.slice(3), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;
// osascript reads its options as the real one does, getopt's way: -e, -l and
// -s take a value, attached or the next word, -i none; `--` ends them, and so
// does the first word with no dash. Any other dash word is an illegal option,
// exit 2 and no notification, as the real one answers. The words left are the
// run handler's `argv`, recorded as the notification it shows.
const OSASCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/osascript-calls.jsonl', JSON.stringify(args) + '\\n');
let at = 0;
let statements = 0;
for (; at < args.length; at += 1) {
  const word = args[at];
  if (word === '--') { at += 1; break; }
  if (!word.startsWith('-') || word === '-') break;
  const flag = word.slice(0, 2);
  if (['-e', '-l', '-s'].includes(flag)) {
    if (flag === '-e') statements += 1;
    if (word.length === 2) at += 1;
    continue;
  }
  if (word === '-i') continue;
  process.stderr.write('osascript: illegal option -- ' + word.slice(1, 2) + '\\n');
  process.exit(2);
}
const rest = args.slice(at);
fs.appendFileSync(process.env.HOME + '/osascript-notifications.jsonl', JSON.stringify(statements > 0 ? rest : rest.slice(1)) + '\\n');
`;
// The check: what the file named by FIRE_STUB says, on stdout and stderr, and
// a record of the call.
const STUB_CHECK = `
import fs from 'node:fs';
const answer = JSON.parse(fs.readFileSync(process.env.FIRE_STUB, 'utf8'));
fs.appendFileSync(process.env.FIRE_STUB + '.calls', JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(answer.line ?? '');
process.stderr.write(answer.stderr ?? '');
process.exit(answer.status);
`;

const VERSION_NEW = '2.1.300';
const VERSION_OLD = '2.1.9';

function fireFixture(t, { app = true, flow = FLOW } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-scheduled-fire-')));
  // No stand-in process outlives the test: every gate opens, the stand-ins
  // end, and only then does the directory go (the hooks run in this order).
  t.after(async () => {
    for (const name of ['go', 'go1', 'go2']) writeFileSync(join(dir, name), '');
    await delay(500);
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const checkout = join(dir, 'checkout');
  const scripts = join(checkout, '.claude', 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(WRAPPER, join(scripts, 'scheduled-fire.sh'));
  copyFileSync(FLOW_CONFIG, join(scripts, 'flow-config.mjs'));
  writeFileSync(join(scripts, 'fire-check.mjs'), STUB_CHECK);
  writeFileSync(join(checkout, '.claude', 'flow.json'), JSON.stringify(flow));
  const nodeBin = join(home, '.nvm', 'versions', 'node', 'v24.99.0', 'bin');
  mkdirSync(nodeBin, { recursive: true });
  // An older node that is not the newest by number, though it sorts last as text.
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin'), { recursive: true });
  symlinkSync(NODE, join(nodeBin, 'node'));
  executable(join(nodeBin, 'caffeinate'), `#!${NODE}\n${CAFFEINATE}`);
  executable(join(nodeBin, 'osascript'), `#!${NODE}\n${OSASCRIPT}`);
  const appBase = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const binary = (version, hash) =>
    join(appBase, version, hash, 'claude.app', 'Contents', 'MacOS', 'claude');
  if (app) {
    for (const [version, hash] of [
      [VERSION_OLD, 'aaaaaaaaaaaa'],
      [VERSION_NEW, 'bbbbbbbbbbbb'],
    ]) {
      mkdirSync(join(binary(version, hash), '..'), { recursive: true });
      executable(binary(version, hash), `#!${NODE}\n${CLAUDE}`);
    }
  }
  const stub = join(dir, 'check.json');
  const logs = join(home, 'Library', 'Logs', 'agent-flow', 'fixture-repo');
  const f = {
    dir,
    home,
    checkout,
    logs,
    log: join(logs, 'fires.log'),
    runs: join(logs, 'runs'),
    lock: (job) => join(logs, `${job}.lock`),
    newest: binary(VERSION_NEW, 'bbbbbbbbbbbb'),
    answer: (status, line, stderr = '') =>
      writeFileSync(stub, JSON.stringify({ status, line: `${line}\n`, stderr })),
    // The configuration replaced, or removed with null.
    flow: (value) => {
      const path = join(checkout, '.claude', 'flow.json');
      if (value === null) rmSync(path, { force: true });
      else writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    },
    // The check itself replaced, for a check that never reaches its answer.
    checkScript: (text) => writeFileSync(join(scripts, 'fire-check.mjs'), text),
    plan: (plan) => writeFileSync(join(home, 'plan.json'), JSON.stringify(plan)),
    checks: () => lines(`${stub}.calls`),
    claudeCalls: () => lines(join(home, 'claude-calls.jsonl')).map((line) => JSON.parse(line)),
    osascriptCalls: () =>
      lines(join(home, 'osascript-calls.jsonl')).map((line) => JSON.parse(line)),
    notifications: () =>
      lines(join(home, 'osascript-notifications.jsonl')).map((line) => JSON.parse(line)),
    caffeinateCalls: () =>
      lines(join(home, 'caffeinate-calls.jsonl')).map((line) => JSON.parse(line)),
    go: (name) => writeFileSync(join(dir, name), ''),
    gate: (name) => ({ wait: join(dir, name) }),
    fire: (...args) =>
      spawnSync('/bin/sh', [join(scripts, 'scheduled-fire.sh'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          USER: 'owner',
          LANG: 'en_US.UTF-8',
          TMPDIR: dir,
          SHELL: '/bin/zsh',
          FIRE_STUB: stub,
          // What the desktop app's sessions carry, which must not reach a session.
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-not-a-real-token',
          ANTHROPIC_API_KEY: 'not-a-real-key',
          CLAUDECODE: '1',
          __CFBundleIdentifier: 'com.anthropic.claudefordesktop',
        },
      }),
  };
  f.plan({ lines: [] });
  return f;
}

const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(what, condition, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await delay(100);
  }
  assert.fail(`waited ${ms} ms for ${what}`);
}

const INIT =
  '{"type":"system","subtype":"init","session_id":"20b5e806-e819-47be-b676-6a67f3d12be9"}';
// A tool's output quoting a result line is a string inside another line.
const QUOTING = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: '{"type":"result"}' }] },
});
const RESULT = (text) =>
  JSON.stringify({
    duration_api_ms: 1,
    session_id: '20b5e806-e819-47be-b676-6a67f3d12be9',
    subtype: 'success',
    result: text,
    type: 'result',
  });

// Acceptance 2, through the job: a skip is one log line and no session.
test('a fire with nothing to do writes one skip line, starts no claude and leaves no lock', (t) => {
  const f = fireFixture(t);
  f.answer(1, 'skip: nothing to resume or take (pick: nothing to take)');
  const result = f.fire('cycle');
  assert.equal(result.status, 0, result.stderr);
  const log = lines(f.log);
  assert.equal(log.length, 1, log.join('\n'));
  assert.match(
    log[0],
    new RegExp(`^${ISO} cycle skip nothing to resume or take \\(pick: nothing to take\\)$`),
  );
  assert.deepEqual(f.claudeCalls(), []);
  assert.deepEqual(f.caffeinateCalls(), []);
  assert.ok(!existsSync(f.lock('cycle')), 'the lock is gone');
  assert.deepEqual(readdirSync(f.runs), [], 'no stream');
  assert.deepEqual(f.checks(), ['["cycle"]'], 'fire-check asked once, for its job');
  // Wrong usage changes nothing.
  for (const args of [[], ['night'], ['cycle', 'x'], ['--supervise', 'cycle']]) {
    assert.equal(f.fire(...args).status, 2, args.join(' '));
  }
  assert.equal(lines(f.log).length, 1);
});

test('a cycle fire with work starts the newest app-bundled claude in a clean environment and lets its lock go at the first result', async (t) => {
  const f = fireFixture(t);
  f.answer(0, 'work: #301 is ready to take');
  f.plan({
    lines: [
      INIT,
      QUOTING,
      f.gate('go1'),
      RESULT('Прогон 14:30 — взял #301 в работу.'),
      f.gate('go2'),
      RESULT('second turn'),
    ],
    exit: 0,
  });
  const result = f.fire('cycle');
  assert.equal(result.status, 0, result.stderr);
  assert.match(lines(f.log)[0], new RegExp(`^${ISO} cycle run #301 is ready to take$`));
  await until('claude to start', () => f.claudeCalls().length === 1);
  const [call] = f.claudeCalls();
  assert.equal(realpathSync(call.binary), realpathSync(f.newest), 'the newest version by number');
  assert.deepEqual(call.args, [
    '-p',
    `Read ${realpathSync(f.checkout)}/.claude/scheduled/delivery-cycle.md and follow it exactly.`,
    '--model',
    'claude-opus-5-5',
    '--effort',
    'xhigh',
    '--permission-mode',
    'auto',
    '--output-format',
    'stream-json',
    '--verbose',
  ]);
  assert.equal(call.cwd, realpathSync(f.checkout), 'the session runs in the checkout');
  assert.equal(call.input, '', 'stdin is /dev/null');
  const keys = Object.keys(call.env).filter((key) => !key.startsWith('__CF_'));
  assert.deepEqual(keys.sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER']);
  assert.equal(call.env.HOME, f.home);
  assert.equal(call.env.LOGNAME, 'owner');
  assert.ok(
    call.env.PATH.startsWith(`${join(f.home, '.nvm', 'versions', 'node', 'v24.99.0', 'bin')}:`),
    call.env.PATH,
  );
  for (const part of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    '/usr/bin',
    '/bin',
  ]) {
    assert.ok(call.env.PATH.split(':').includes(part), `PATH lacks ${part}`);
  }
  assert.deepEqual(f.caffeinateCalls()[0].slice(0, 3), ['-i', '-s', f.newest]);

  // Inside the first turn the lock is held, and a second fire skips.
  const holder = Number(readFileSync(join(f.lock('cycle'), 'pid'), 'utf8'));
  assert.ok(alive(holder), 'the lock names a live supervisor');
  f.answer(0, 'work: #302 is ready to take');
  f.fire('cycle');
  assert.match(
    lines(f.log)[1],
    new RegExp(`^${ISO} cycle skip previous cycle run still in its turn \\(pid ${holder}\\)$`),
  );
  assert.equal(f.claudeCalls().length, 1);

  // The first result line lets the lock go while the session lives on.
  f.go('go1');
  await until('the lock to go', () => !existsSync(f.lock('cycle')));
  assert.ok(alive(call.pid), 'the session still runs');
  f.answer(1, 'skip: nothing to resume or take (pick: nothing to take)');
  f.fire('cycle');
  assert.match(lines(f.log)[2], new RegExp(`^${ISO} cycle skip nothing to resume or take`));

  f.go('go2');
  await until('the end line', () => lines(f.log).some((line) => line.includes(' cycle end ')));
  assert.match(lines(f.log).at(-1), new RegExp(`^${ISO} cycle end exit=0$`));
  const streams = readdirSync(f.runs);
  assert.equal(streams.length, 1, streams.join(' '));
  assert.match(streams[0], /^cycle-\d{8}T\d{6}Z\.jsonl$/);
  assert.deepEqual(lines(join(f.runs, streams[0])), [
    INIT,
    QUOTING,
    RESULT('Прогон 14:30 — взял #301 в работу.'),
    RESULT('second turn'),
  ]);
  assert.equal(
    lines(f.log)[0].slice(0, 20).replace(/[-:]/g, ''),
    streams[0].slice(6, 22),
    'the stream is named by the run line’s time',
  );
  assert.deepEqual(f.osascriptCalls(), [], 'no notification from the cycle');
});

test('a grooming fire holds its lock until the session ends, and its morning run posts the final result as a notification', async (t) => {
  const f = fireFixture(t);
  f.answer(0, 'work: morning notification (09:07–09:21)');
  f.plan({
    lines: [
      INIT,
      RESULT(
        '  Груминг, утро: сами стали ready за сутки — 0; ждут тебя — 38 (#12, #30).\n Разбор: /groom.  ',
      ),
      f.gate('go'),
      RESULT(''),
    ],
    exit: 3,
  });
  assert.equal(f.fire('grooming').status, 0);
  await until('the result line', () =>
    readdirSync(f.runs).some((name) => lines(join(f.runs, name)).length >= 2),
  );
  await delay(2500);
  assert.ok(existsSync(f.lock('grooming')), 'the lock outlives the first result');
  f.answer(0, 'work: #10 is a candidate the owner has not seen');
  f.fire('grooming');
  assert.match(
    lines(f.log)[1],
    new RegExp(`^${ISO} grooming skip previous grooming run still in its turn \\(pid \\d+\\)$`),
  );
  assert.deepEqual(f.osascriptCalls(), []);

  f.go('go');
  await until('the end line', () => lines(f.log).some((line) => line.includes(' grooming end ')));
  assert.match(lines(f.log).at(-1), new RegExp(`^${ISO} grooming end exit=3$`));
  await until('the lock to go', () => !existsSync(f.lock('grooming')));
  await until('the notification', () => f.osascriptCalls().length === 1);
  const [args] = f.osascriptCalls();
  assert.deepEqual(args.slice(0, 7), [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title (item 2 of argv)',
    '-e',
    'end run',
    '--',
  ]);
  assert.deepEqual(f.notifications(), [
    [
      'Груминг, утро: сами стали ready за сутки — 0; ждут тебя — 38 (#12, #30). Разбор: /groom.',
      'Fixture Project · grooming',
    ],
  ]);
  const [call] = f.claudeCalls();
  assert.equal(
    call.args[1],
    `Read ${realpathSync(f.checkout)}/.claude/scheduled/grooming.md and follow it exactly.`,
  );
  assert.deepEqual(call.args.slice(4, 6), ['--effort', 'medium']);

  // A grooming run outside the morning posts nothing.
  f.answer(0, 'work: #10 is a candidate the owner has not seen');
  f.plan({ lines: [RESULT('Груминг 10:22 — #10 ждёт тебя.')] });
  f.fire('grooming');
  await until(
    'the second end line',
    () => lines(f.log).filter((line) => line.includes(' grooming end ')).length === 2,
  );
  await delay(300);
  assert.equal(f.osascriptCalls().length, 1, 'no second notification');
});

// A process of the test's own that stands for a lock's holder, stopped when
// the test ends even if it fails; the command line `ps` reads is checked first.
async function holderProcess(t, command, args, named) {
  const child = spawn(command, args, { stdio: 'ignore' });
  t.after(async () => {
    if (alive(child.pid)) child.kill('SIGKILL');
    await until('the holder to end', () => !alive(child.pid));
  });
  await until(`the holder to run ${named}`, () =>
    spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(child.pid)], {
      encoding: 'utf8',
    }).stdout.includes(named),
  );
  return child;
}

test('a lock whose process is gone, or whose PID another program now has, is taken over; one held by a live run of the wrapper is a skip that asks nothing', async (t) => {
  const f = fireFixture(t);
  const gone = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
  assert.ok(!alive(gone), 'the made-up holder is gone');
  mkdirSync(f.lock('cycle'), { recursive: true });
  writeFileSync(join(f.lock('cycle'), 'pid'), `${gone}\n`);
  f.answer(1, 'skip: nothing to resume or take (pick: nothing to take)');
  f.fire('cycle');
  assert.match(
    lines(f.log)[0],
    new RegExp(
      `^${ISO} cycle skip nothing to resume or take \\(pick: nothing to take\\) \\[stale lock of pid ${gone} taken over\\]$`,
    ),
  );
  assert.ok(!existsSync(f.lock('cycle')));

  // A lock with no PID in it at all is stale too.
  mkdirSync(f.lock('grooming'), { recursive: true });
  f.fire('grooming');
  assert.match(lines(f.log)[1], /\[stale lock of pid unknown taken over\]$/);

  // A lock naming a live process that is no run of the wrapper — its PID
  // given to another program since the run died — is stale too, and the
  // process is left alone.
  const other = await holderProcess(t, 'sleep', ['60'], 'sleep');
  mkdirSync(f.lock('cycle'), { recursive: true });
  writeFileSync(join(f.lock('cycle'), 'pid'), `${other.pid}\n`);
  f.fire('cycle');
  assert.match(
    lines(f.log)[2],
    new RegExp(
      `^${ISO} cycle skip nothing to resume or take \\(pick: nothing to take\\) \\[stale lock of pid ${other.pid} taken over\\]$`,
    ),
  );
  assert.ok(!existsSync(f.lock('cycle')));
  assert.ok(alive(other.pid), 'the other program still runs');
  other.kill('SIGKILL');
  await until('the other program to end', () => !alive(other.pid));

  // A live process whose command line names the wrapper holds the lock.
  const run = await holderProcess(
    t,
    NODE,
    [
      '-e',
      'setInterval(() => {}, 1000)',
      join(f.checkout, '.claude', 'scripts', 'scheduled-fire.sh'),
      'cycle',
    ],
    'scheduled-fire.sh',
  );
  mkdirSync(f.lock('cycle'), { recursive: true });
  writeFileSync(join(f.lock('cycle'), 'pid'), `${run.pid}\n`);
  const asked = f.checks().length;
  f.fire('cycle');
  assert.match(
    lines(f.log)[3],
    new RegExp(`^${ISO} cycle skip previous cycle run still in its turn \\(pid ${run.pid}\\)$`),
  );
  assert.equal(f.checks().length, asked, 'fire-check is not asked');
  assert.equal(
    readFileSync(join(f.lock('cycle'), 'pid'), 'utf8'),
    `${run.pid}\n`,
    'the lock is left alone',
  );
  run.kill('SIGKILL');
  await until('the stand-in run to end', () => !alive(run.pid));
});

test('the log is rotated past 1 MiB, the newest 50 streams of a job are kept, and a check that cannot answer is work', async (t) => {
  const f = fireFixture(t);
  mkdirSync(f.runs, { recursive: true });
  writeFileSync(f.log, `${'x'.repeat(1024)}\n`.repeat(1025));
  for (let i = 0; i < 55; i += 1) {
    // Old enough to sort before any run made today.
    writeFileSync(
      join(
        f.runs,
        `cycle-202001${String(10 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}0000Z.jsonl`,
      ),
      '',
    );
  }
  writeFileSync(join(f.runs, 'cycle-20200110T000000Z.err'), 'oldest');
  writeFileSync(join(f.runs, 'grooming-20200101T000000Z.jsonl'), '');
  f.answer(7, 'Error: something of its own');
  f.plan({ lines: [RESULT('ok')] });
  f.fire('cycle');
  assert.ok(existsSync(`${f.log}.1`), 'the old log is kept once');
  assert.equal(readFileSync(`${f.log}.1`, 'utf8').length, 1025 * 1025);
  assert.match(
    lines(f.log)[0],
    new RegExp(`^${ISO} cycle run cannot tell: fire-check exit 7: Error: something of its own$`),
  );
  await until('the end line', () => lines(f.log).some((line) => line.includes(' cycle end ')));
  const kept = readdirSync(f.runs).filter(
    (name) => name.startsWith('cycle-') && name.endsWith('.jsonl'),
  );
  assert.equal(kept.length, 50, kept.join(' '));
  assert.ok(!existsSync(join(f.runs, 'cycle-20200110T000000Z.jsonl')), 'the oldest stream went');
  assert.ok(!existsSync(join(f.runs, 'cycle-20200110T000000Z.err')), 'with its errors');
  assert.ok(
    existsSync(join(f.runs, 'grooming-20200101T000000Z.jsonl')),
    'another job’s stream stays',
  );
});

// Exit 1 is a skip only with a `skip: ` line: node exits 1 too when it fails
// before the check runs, a stack trace on stderr and nothing on stdout, and a
// skip read from that would stop both schedules with no word.
test('a check that exits 1 without a skip line is work that cannot tell, and the session starts', async (t) => {
  const f = fireFixture(t);
  f.checkScript("throw new Error('a fault before main()');\n");
  f.plan({ lines: [RESULT('ok')] });
  const result = f.fire('cycle');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Error: a fault before main\(\)/, 'node’s own stack trace');
  assert.match(lines(f.log)[0], new RegExp(`^${ISO} cycle run cannot tell: fire-check exit 1$`));
  await until('claude to start', () => f.claudeCalls().length === 1);
  await until('the end line', () => lines(f.log).some((line) => line.includes(' cycle end ')));

  // The stand-in check again, exiting 1 with what is no skip line.
  const g = fireFixture(t);
  g.plan({ lines: [RESULT('ok')] });
  const said = [
    ['', '', 'exit 1'],
    ['', 'TypeError: x is not a function\n    at main (fire-check.mjs:1:1)\n', 'exit 1'],
    ['work: #301 is ready to take', '', 'exit 1: work: #301 is ready to take'],
    ['skipped: nothing', '', 'exit 1: skipped: nothing'],
    ['skip:nothing', '', 'exit 1: skip:nothing'],
    [' skip: nothing', '', 'exit 1:  skip: nothing'],
  ];
  for (const [index, [line, stderr, reason]] of said.entries()) {
    g.answer(1, line, stderr);
    assert.equal(g.fire('grooming').status, 0);
    const run = lines(g.log).filter((entry) => !entry.includes(' grooming end '));
    assert.equal(run.length, index + 1, run.join('\n'));
    assert.equal(
      run.at(-1).replace(/^\S+ /, ''),
      `grooming run cannot tell: fire-check ${reason}`,
      JSON.stringify(line),
    );
    await until(
      `the session of ${JSON.stringify(line)}`,
      () => g.claudeCalls().length === index + 1,
    );
    await until(
      `the end of ${JSON.stringify(line)}`,
      () => lines(g.log).filter((entry) => entry.includes(' grooming end ')).length === index + 1,
    );
    await until('the lock to go', () => !existsSync(g.lock('grooming')));
  }
  // A `skip: ` line with exit 1 is still a skip.
  g.answer(1, 'skip: no candidate the owner has not seen (3 seen)');
  g.fire('grooming');
  assert.match(
    lines(g.log).at(-1),
    new RegExp(`^${ISO} grooming skip no candidate the owner has not seen \\(3 seen\\)$`),
  );
  assert.equal(g.claudeCalls().length, said.length);
});

test('without an app-bundled claude the standalone one runs, and without either the fire skips naming the work', async (t) => {
  const f = fireFixture(t, { app: false });
  f.answer(0, 'work: #301 is ready to take');
  f.fire('cycle');
  assert.match(
    lines(f.log)[0],
    new RegExp(
      `^${ISO} cycle skip no Claude Code binary found, with work present \\(#301 is ready to take\\)$`,
    ),
  );
  assert.ok(!existsSync(f.lock('cycle')));
  const local = join(f.home, '.local', 'bin', 'claude');
  mkdirSync(join(local, '..'), { recursive: true });
  executable(local, `#!${NODE}\n${CLAUDE}`);
  f.plan({ lines: [RESULT('ok')] });
  f.fire('cycle');
  await until('claude to start', () => f.claudeCalls().length === 1);
  assert.equal(f.claudeCalls()[0].binary, local);
  await until('the end line', () => lines(f.log).some((line) => line.includes(' cycle end ')));
});

test('--auth-status says signed in or not, through the same binary and clean environment, and prints no token', (t) => {
  const f = fireFixture(t);
  f.plan({
    auth: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "token": "sk-ant-oat-secret-looking"\n}',
  });
  const yes = f.fire('--auth-status');
  assert.equal(yes.status, 0);
  assert.equal(yes.stdout, 'signed in\n');
  const [call] = f.claudeCalls();
  assert.deepEqual(call.args, ['auth', 'status']);
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in call.env), 'the app’s token does not reach it');
  f.plan({ auth: '{"loggedIn": false}' });
  const no = f.fire('--auth-status');
  assert.equal(no.status, 1);
  assert.equal(no.stdout, 'not signed in\n');
  for (const output of [yes, no]) assert.doesNotMatch(output.stdout + output.stderr, /sk-ant/);
  assert.deepEqual(lines(f.log), [], 'it logs no fire');
});


// The wrapper reads what a check prints and what a session streams, so made-up
// input built to break it: a reason of any length with line breaks, tabs and
// carriage returns stays one log line; a stream whose lines only look like a
// result — cut short, the words inside a string, a megabyte with no line
// break — is no result, so the cycle's lock waits for the process to end; a
// morning run with no result text still notifies, saying so; and one whose
// text opens with a dash notifies with that text.
test('the wrapper keeps one line per fire and takes no made-up stream line for a result, at growing sizes', async (t) => {
  for (const size of [1_000, 100_000]) {
    const f = fireFixture(t);
    f.answer(1, `skip: ${'a\tb\rc\n'.repeat(size / 6)}`);
    f.fire('cycle');
    const log = lines(f.log);
    assert.equal(log.length, 1, `${size}: ${log.length} lines`);
    assert.ok(log[0].length <= 600, `${size}: a line of ${log[0].length}`);
    assert.match(log[0], new RegExp(`^${ISO} cycle skip a b c`));
  }

  const f = fireFixture(t);
  f.answer(0, 'work: #301 is ready to take');
  f.plan({
    lines: [
      '{"type":"result"',
      'not json, "type":"result"',
      JSON.stringify({ type: 'assistant', text: '{"type":"result","result":"no"}' }),
      `{"type":"result",${'"x":1,'.repeat(150_000)}`,
      f.gate('go'),
    ],
  });
  f.fire('cycle');
  await until('the stream', () =>
    readdirSync(f.runs).some((name) => lines(join(f.runs, name)).length === 4),
  );
  await delay(2500);
  assert.ok(existsSync(f.lock('cycle')), 'a made-up result line lets no lock go');
  f.go('go');
  await until('the end line', () => lines(f.log).some((line) => line.includes(' cycle end ')));
  await until('the lock to go', () => !existsSync(f.lock('cycle')));

  const g = fireFixture(t);
  g.answer(0, 'work: morning notification (09:07–09:21)');
  g.plan({
    lines: ['\u0000\u0001 binary', RESULT('   '), '{"type":"result","result":"cut'],
    exit: 2,
  });
  g.fire('grooming');
  await until('the notification', () => g.osascriptCalls().length === 1);
  assert.deepEqual(g.notifications(), [
    [
      'The morning grooming run ended (exit 2) with no result text; see fires.log.',
      'Fixture Project · grooming',
    ],
  ]);

  // A result text that opens with a dash is the notification's text, not an
  // option of osascript's: not an illegal one, not `--`, and not a statement
  // `-e` would run.
  for (const text of ['-x 38 wait for the owner', '--', '-e do shell script "touch pwned"']) {
    const h = fireFixture(t);
    h.answer(0, 'work: morning notification (09:07–09:21)');
    h.plan({ lines: [RESULT(text)] });
    h.fire('grooming');
    await until(`the notification of ${text}`, () => h.osascriptCalls().length === 1);
    assert.deepEqual(h.notifications(), [[text, 'Fixture Project · grooming']], text);
  }
});

// The logs are named after the repository of `project.repo` in
// `.claude/flow.json`. Without one there is no directory of the project's to
// log in and nothing a session could do: the fire logs its skip, naming why,
// in the directory above, asks no check and starts nothing.
test('a fire without a usable project.repo logs a skip under agent-flow and starts nothing', (t) => {
  const f = fireFixture(t);
  f.answer(0, 'work: #301 is ready to take');
  f.plan({ lines: [RESULT('ok')] });
  const parent = join(f.home, 'Library', 'Logs', 'agent-flow', 'fires.log');
  const checkout = realpathSync(f.checkout);
  const cases = [
    [null, /cannot be read \(ENOENT\): run \/flow-init/],
    ['{', /is not JSON: /],
    ...[{}, { repo: '' }, { repo: 'no-slash' }, { repo: 'owner/..' }, { repo: 'owner/a b' }].map(
      (project) => [
        { project },
        new RegExp(
          `project\\.repo in ${checkout}/\\.claude/flow\\.json is not owner/name: run /flow-init`,
        ),
      ],
    ),
  ];
  for (const [index, [flow, reason]] of cases.entries()) {
    f.flow(flow);
    const result = f.fire(index % 2 === 0 ? 'cycle' : 'grooming');
    assert.equal(result.status, 0, result.stderr);
    const log = lines(parent);
    assert.equal(log.length, index + 1, log.join('\n'));
    assert.match(log.at(-1), new RegExp(`^${ISO} (?:cycle|grooming) skip `));
    assert.match(log.at(-1), reason, JSON.stringify(flow));
    assert.ok(log.at(-1).endsWith(` (${checkout})`), log.at(-1));
  }
  assert.deepEqual(f.checks(), [], 'fire-check was asked');
  assert.deepEqual(f.claudeCalls(), []);
  assert.ok(!existsSync(f.logs), 'a directory of the project was made');

  // With the configuration back, the fire logs in the project's directory.
  f.flow(FLOW);
  f.answer(1, 'skip: nothing to resume or take (pick: nothing to take)');
  f.fire('cycle');
  assert.match(lines(f.log)[0], new RegExp(`^${ISO} cycle skip nothing to resume or take`));
  assert.equal(lines(parent).length, cases.length);
});

// The notification's title is the project's name, or the repository's when
// the configuration names no project.
test('the morning notification is titled with the repository when the project has no name', async (t) => {
  const f = fireFixture(t, { flow: { project: { name: '', repo: 'owner/fixture-repo' } } });
  f.answer(0, 'work: morning notification (09:07–09:21)');
  f.plan({ lines: [RESULT('ждут тебя — 3')] });
  f.fire('grooming');
  await until('the notification', () => f.osascriptCalls().length === 1);
  assert.deepEqual(f.notifications(), [['ждут тебя — 3', 'fixture-repo · grooming']]);
});

// ---------------------------------------------------------------------------
// The launchd jobs
// ---------------------------------------------------------------------------

const JOBS = ['cycle', 'grooming'];
const PLUTIL = '/usr/bin/plutil';
const minutesOf = (plist) =>
  [
    ...plist
      .split('<key>StartCalendarInterval</key>')[1]
      .split('</array>')[0]
      .matchAll(/<integer>(\d+)<\/integer>/g),
  ].map((m) => Number(m[1]));

// A stand-in launchctl records each call; `fail-first-bootstrap` in its file
// makes the first bootstrap fail, as one right after a bootout can.
const LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >>"$HOME/launchctl-calls"
if [ "$1" = bootstrap ] && [ -f "$HOME/fail-first-bootstrap" ]; then
  rm -f "$HOME/fail-first-bootstrap"
  exit 5
fi
exit 0
`;

// A checkout of its own with the installer, the templates, the wrapper and
// flow-config.mjs copied in, and its own `.claude/flow.json`; node and the
// stand-in launchctl first on PATH.
function installFixture(t, { signedIn = true, flow = FLOW } = {}) {
  const dir = temporary(t, 'flow-launchd-');
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const checkout = join(dir, 'checkout');
  const launchd = join(checkout, '.claude', 'scripts', 'launchd');
  mkdirSync(launchd, { recursive: true });
  for (const name of ['install.sh', 'uninstall.sh', 'cycle.plist.in', 'grooming.plist.in']) {
    copyFileSync(join(LAUNCHD, name), join(launchd, name));
  }
  copyFileSync(WRAPPER, join(checkout, '.claude', 'scripts', 'scheduled-fire.sh'));
  copyFileSync(FLOW_CONFIG, join(checkout, '.claude', 'scripts', 'flow-config.mjs'));
  const setFlow = (value) =>
    writeFileSync(
      join(checkout, '.claude', 'flow.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  setFlow(flow);
  mkdirSync(bin, { recursive: true });
  executable(join(bin, 'launchctl'), LAUNCHCTL);
  symlinkSync(NODE, join(bin, 'node'));
  // plutil is macOS's; elsewhere a stand-in, and the text is compared whole.
  if (!existsSync(PLUTIL)) executable(join(bin, 'plutil'), '#!/bin/sh\nexit 0\n');
  const app = join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'claude-code',
    '2.1.299',
    'cccccccccccc',
    'claude.app',
    'Contents',
    'MacOS',
  );
  mkdirSync(app, { recursive: true });
  executable(join(app, 'claude'), `#!${NODE}\n${CLAUDE}`);
  writeFileSync(join(home, 'plan.json'), JSON.stringify({ auth: `{"loggedIn": ${signedIn}}` }));
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, USER: 'owner', LANG: 'en_US.UTF-8' };
  return {
    home,
    checkout,
    launchd,
    flow: setFlow,
    agents: join(home, 'Library', 'LaunchAgents'),
    logs: join(home, 'Library', 'Logs', 'agent-flow', 'fixture-repo'),
    calls: () => lines(join(home, 'launchctl-calls')),
    run: (script) => {
      assert.ok(existsSync(join(bin, 'launchctl')), 'the stand-in launchctl is first on PATH');
      return spawnSync('/bin/sh', [join(launchd, script)], {
        encoding: 'utf8',
        env,
        timeout: 60_000,
      });
    },
  };
}

// The template as install.sh is expected to fill it: the label, the checkout,
// the logs directory, and one calendar interval per minute.
function expected(template, { label, checkout, logs, minutes }) {
  const calendar = minutes
    .map((m) => `    <dict>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>\n`)
    .join('');
  return template
    .replace('@CALENDAR@\n', calendar)
    .split('@LABEL@')
    .join(label)
    .split('@CHECKOUT@')
    .join(checkout)
    .split('@LOGS@')
    .join(logs);
}

test('install.sh renders both jobs with this checkout and the configured minutes, lints them, and boots them in; uninstall.sh boots them out', (t) => {
  const f = installFixture(t);
  writeFileSync(join(f.home, 'fail-first-bootstrap'), '');
  const result = f.run('install.sh');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const uid = String(process.getuid());
  const checkout = realpathSync(f.checkout);
  const minutes = { cycle: [0, 30], grooming: [7, 22, 37, 52] };
  for (const job of JOBS) {
    const label = `dev.agent-flow.fixture-repo.${job}`;
    const rendered = readFileSync(join(f.agents, `${label}.plist`), 'utf8');
    const template = readFileSync(join(f.launchd, `${job}.plist.in`), 'utf8');
    assert.equal(
      rendered,
      expected(template, { label, checkout, logs: f.logs, minutes: minutes[job] }),
      job,
    );
    assert.doesNotMatch(rendered, /@[A-Z]+@/, `${job}: a placeholder is left`);
    assert.deepEqual(minutesOf(rendered), minutes[job], job);
    assert.ok(rendered.includes(`<string>${label}</string>`));
    assert.ok(
      rendered.includes(
        `<string>${checkout}/.claude/scripts/scheduled-fire.sh</string>\n    <string>${job}</string>`,
      ),
    );
    assert.ok(rendered.includes(`<string>${f.logs}/launchd-${job}.log</string>`));
    assert.ok(
      rendered.includes('<key>AbandonProcessGroup</key>\n  <true/>'),
      `${job}: the session outlives the job`,
    );
    assert.ok(!rendered.includes('RunAtLoad'), `${job}: no fire at load`);
    if (existsSync(PLUTIL)) {
      const lint = spawnSync(PLUTIL, ['-lint', join(f.agents, `${label}.plist`)], {
        encoding: 'utf8',
      });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    }
  }
  assert.deepEqual(f.calls(), [
    `bootout gui/${uid}/dev.agent-flow.fixture-repo.cycle`,
    `bootstrap gui/${uid} ${f.agents}/dev.agent-flow.fixture-repo.cycle.plist`,
    `bootstrap gui/${uid} ${f.agents}/dev.agent-flow.fixture-repo.cycle.plist`,
    `bootout gui/${uid}/dev.agent-flow.fixture-repo.grooming`,
    `bootstrap gui/${uid} ${f.agents}/dev.agent-flow.fixture-repo.grooming.plist`,
  ]);
  assert.ok(
    result.stdout.includes(`launchctl print gui/${uid}/dev.agent-flow.fixture-repo.cycle`),
    'it says how to check',
  );
  assert.ok(result.stdout.includes('minutes 0, 30 (cycle) and 7, 22, 37, 52 (grooming)'));
  assert.ok(result.stdout.includes(`tail -f ${f.logs}/fires.log`));
  assert.ok(existsSync(f.logs));

  const removed = f.run('uninstall.sh');
  assert.equal(removed.status, 0, removed.stderr);
  for (const job of JOBS) {
    assert.ok(!existsSync(join(f.agents, `dev.agent-flow.fixture-repo.${job}.plist`)));
  }
  assert.deepEqual(f.calls().slice(-2), [
    `bootout gui/${uid}/dev.agent-flow.fixture-repo.cycle`,
    `bootout gui/${uid}/dev.agent-flow.fixture-repo.grooming`,
  ]);
  assert.match(removed.stdout, new RegExp(`The logs stay in ${f.logs}/\\.\\n$`));
});

// The two cron shapes of the defaults install, at any step or list of
// minutes; any other shape is refused with one line before anything is
// installed, for launchd's calendar intervals here are minutes of every hour.
test('install.sh installs the two cron shapes and refuses any other with one line', (t) => {
  const installs = [
    ['*/15 * * * *', [0, 15, 30, 45]],
    ['*/7 * * * *', [0, 7, 14, 21, 28, 35, 42, 49, 56]],
    ['*/59 * * * *', [0, 59]],
    ['*/1 * * * *', Array.from({ length: 60 }, (_, m) => m)],
    ['5,35 * * * *', [5, 35]],
    ['07  *  *  *  *', [7]],
    ['0,08,59 * * * *', [0, 8, 59]],
  ];
  for (const [cron, minutes] of installs) {
    const f = installFixture(t, { flow: { ...FLOW, schedule: { ...FLOW.schedule, cycle: cron } } });
    const result = f.run('install.sh');
    assert.equal(result.status, 0, `${cron}: ${result.stderr}`);
    const rendered = readFileSync(
      join(f.agents, 'dev.agent-flow.fixture-repo.cycle.plist'),
      'utf8',
    );
    assert.deepEqual(minutesOf(rendered), minutes, cron);
    assert.deepEqual(
      minutesOf(readFileSync(join(f.agents, 'dev.agent-flow.fixture-repo.grooming.plist'), 'utf8')),
      [7, 22, 37, 52],
    );
  }

  const refusals = [
    '0 9 * * *',
    '*/15 * * * 1-5',
    '* * * * *',
    '*/0 * * * *',
    '*/60 * * * *',
    '*/100 * * * *',
    '60 * * * *',
    '1,,2 * * * *',
    ',5 * * * *',
    '5, * * * *',
    '*/15 * * *',
    '*/15 * * * * *',
    '@hourly',
    '',
    '*/x * * * *',
    '5-10 * * * *',
  ];
  for (const cron of refusals) {
    for (const job of JOBS) {
      const schedule = { ...FLOW.schedule, [job]: cron };
      const f = installFixture(t, { flow: { ...FLOW, schedule } });
      const result = f.run('install.sh');
      assert.equal(result.status, 1, `${job} ${JSON.stringify(cron)}: ${result.stdout}`);
      assert.equal(
        result.stderr,
        `install: schedule.${job} in .claude/flow.json is "${cron}"; only "*/N * * * *" and "M1,M2,... * * * *" install as launchd jobs: use the desktop app's scheduled task for it\n`,
        `${job} ${JSON.stringify(cron)}`,
      );
      assert.deepEqual(f.calls(), [], 'launchctl was called');
      assert.ok(!existsSync(f.agents), 'something was installed');
    }
  }
});

test('install.sh installs nothing without a usable configuration, or while the standalone CLI is not signed in', (t) => {
  const unsigned = installFixture(t, { signedIn: false });
  const result = unsigned.run('install.sh');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^install: the standalone CLI is not signed in: run `claude auth login` in Terminal once, then run this script again\n$/,
  );
  assert.deepEqual(unsigned.calls(), []);
  assert.ok(!existsSync(unsigned.agents));

  const f = installFixture(t);
  const checkout = realpathSync(f.checkout);
  for (const [flow, reason] of [
    ['{', /^install: [^\n]+flow\.json is not JSON: [^\n]+\n$/],
    [
      { project: { repo: '' } },
      new RegExp(`^install: project\\.repo in ${checkout}/\\.claude/flow\\.json is not owner/name: run /flow-init\\n$`),
    ],
    [
      { project: { repo: 'owner/..' } },
      /^install: project\.repo in [^\n]+ is not owner\/name: run \/flow-init\n$/,
    ],
    [
      { ...FLOW, schedule: { cycle: 5 } },
      /^install: [^\n]+flow\.json: schedule\.cycle is not a string\n$/,
    ],
  ]) {
    f.flow(flow);
    for (const script of ['install.sh', 'uninstall.sh']) {
      const refused = f.run(script);
      assert.equal(refused.status, 1, `${script} ${JSON.stringify(flow)}: ${refused.stdout}`);
      if (script === 'install.sh') assert.match(refused.stderr, reason, JSON.stringify(flow));
      else assert.match(refused.stderr, /^uninstall: [^\n]+\n$/, JSON.stringify(flow));
    }
    assert.deepEqual(f.calls(), [], 'launchctl was called');
    assert.ok(!existsSync(f.agents), 'something was installed');
  }
});

// The templates hold no path of a machine and run the wrapper with /bin/sh,
// and every script parses.
test('the templates name no machine path and run the wrapper with /bin/sh, and the scripts parse', () => {
  for (const job of JOBS) {
    const plist = readFileSync(join(LAUNCHD, `${job}.plist.in`), 'utf8');
    assert.ok(plist.includes('<string>@LABEL@</string>'));
    assert.ok(
      plist.includes(
        `<string>/bin/sh</string>\n    <string>@CHECKOUT@/.claude/scripts/scheduled-fire.sh</string>\n    <string>${job}</string>`,
      ),
    );
    assert.ok(plist.includes('\n@CALENDAR@\n'), `${job}: no calendar line`);
    assert.ok(plist.includes(`<string>@LOGS@/launchd-${job}.log</string>`));
    assert.doesNotMatch(plist, /\/Users\/|dmz|qa-tools/, `${job}: a machine path is committed`);
  }
  for (const script of ['scheduled-fire.sh', 'launchd/install.sh', 'launchd/uninstall.sh']) {
    assert.equal(
      spawnSync('/bin/sh', ['-n', join(root, '.claude', 'scripts', script)]).status,
      0,
      `${script} parses`,
    );
    assert.doesNotMatch(
      readFileSync(join(root, '.claude', 'scripts', script), 'utf8'),
      /\/Users\/|qa-tools/,
      `${script} names a machine path`,
    );
  }
});
