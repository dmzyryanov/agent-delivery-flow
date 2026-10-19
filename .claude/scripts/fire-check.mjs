// Whether a scheduled fire has work, asked before it starts a Claude session
// (D17). `.claude/scripts/scheduled-fire.sh`, the launchd job's program, runs
// it, and so does a desktop scheduled task's prompt before anything else; a
// fire with nothing to do then costs this script and one log line.
//
//   node .claude/scripts/fire-check.mjs <cycle|grooming>
//
// It prints one line, `work: <reason>` or `skip: <reason>`, and exits 0 for
// work, 1 for none, 2 for wrong usage. It only reads: it never claims,
// comments, labels or writes the delivery queue. What it cannot tell — a
// command that fails, runs past its time or answers something it does not
// understand — it answers as work, so a fault here costs a session, never a
// fire that had work. The exceptions are preconditions, which the session's
// own checks would end it on at once: `.claude/flow.json` that cannot be read
// starts no session of either job, and the cycle's work with GitHub, the
// remote or Docker not answering starts none either. Docker is a
// precondition only when `commands.taskTest` or `commands.e2e` in
// `.claude/flow.json` is set: only those suites need it.
//
// The cycle has work when Resume first would take a task — a queue row
// `DEAD` or `detached`, but not a day task its session has not detached, nor
// a task awaiting the lock while the lock is held or the queue is paused —
// or when `pick` offers a ready issue that the procedure's owner-steps and
// double-take gates would not pass over at once, and that is still an open
// `state:ready` issue outside `delivery:attended` and `type:epic` with its
// labels in order (`.claude/scheduled/delivery-cycle.md`).
//
// The grooming has work in the morning range — from `schedule.morningFire`
// to 14 minutes after it, the one grooming fire that owes the owner the
// morning notification; empty, none — otherwise when an earlier run's claim
// is two hours old or more and none is younger, or, while fewer than ten open
// issues wait for the owner, when an open issue carrying none of the four
// state labels, and no epic, has not been seen by the owner: grooming never
// takes an epic, which is groomed through its children
// (`.claude/scheduled/grooming.md`, D25).
// An issue it lists that carries two `state:` labels is one it cannot tell:
// work, so that a run reports it.
//
// It runs `gh`, `git`, `docker` and `node` as found on PATH, each with a
// time limit, against `project.repo` of `.claude/flow.json`, always with
// `--repo` (D22, D23). Lists are read with `gh issue list --limit`, gh reading
// the pages; an issue's comments with `gh issue view --json comments`, which
// reads them all; its label events with `gh api` page by page, explicit
// `per_page` and `page`. Three things PATH cannot stand in for are read from
// the environment, for its tests: `FIRE_CHECK_QUEUE`, the queue script to
// run, `FIRE_CHECK_NOW`, the time, and `FLOW_CONFIG`, the configuration;
// `FIRE_CHECK_TIMEOUT_MS` shortens the time limit of each command.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FlowConfigError, loadFlow } from './flow-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUEUE =
  process.env.FIRE_CHECK_QUEUE || join(ROOT, '.claude', 'scripts', 'delivery-queue.mjs');

// Every command gets this long, and the whole check this long: a check that
// takes minutes is one that cannot tell.
const COMMAND_MS =
  Number(process.env.FIRE_CHECK_TIMEOUT_MS) > 0
    ? Number(process.env.FIRE_CHECK_TIMEOUT_MS)
    : 30_000;
const BUDGET_MS = 240_000;
const STARTED = Date.now();

// The most ready candidates whose gates are read, the most grooming
// candidates whose history is read, the most issues one list reads, and the
// most pages of label events.
export const MAX_CYCLE_CANDIDATES = 10;
export const MAX_GROOMING_LOOKUPS = 20;
export const MAX_LISTED = 1000;
const MAX_PAGES = 10;
const PER_PAGE = 100;

// The grooming's numbers, as the procedure states them.
export const MORNING_MINUTES = 14;
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;
export const NEEDS_OWNER_LIMIT = 10;
const STATE_LABELS = ['state:ready', 'state:grooming', 'state:deferred', 'state:needs-owner'];
const READY = 'state:ready';
const ATTENDED = 'delivery:attended';
const EPIC = 'type:epic';

// The words the procedures write, pinned as they write them.
export const OWNER_STEPS = '## Owner steps before delivery';
const SCHEDULED = 'Scheduled run ';
const GROOMING = 'Grooming run ';
const EARLIER_RUN = ['taken', 'DELIVERED', 'BLOCKED', 'RECOVERED'];
const GROOMING_RESULTS = ['ready without the owner', 'waits for the owner'];
export const RELEASED = 'released to a /groom chat';

// What the script cannot tell: answered as work, with the reason.
class Unknown extends Error {}
// A precondition that failed before any work was looked for.
class Precondition extends Error {}

const oneLine = (text, max = 160) => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function run(command, args) {
  if (Date.now() - STARTED > BUDGET_MS) {
    throw new Unknown(`the checks ran past ${BUDGET_MS / 1000} s`);
  }
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: COMMAND_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
  });
}

// Why a command did not answer, in a few words.
function failure(result) {
  if (result.error?.code === 'ETIMEDOUT') return `ran past ${COMMAND_MS / 1000} s`;
  if (result.error) return result.error.code ?? oneLine(result.error.message, 80);
  if (result.signal) return `killed by ${result.signal}`;
  return `exit ${result.status}${result.stderr ? `: ${oneLine(result.stderr, 80)}` : ''}`;
}

function parse(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Unknown(`${what} did not answer JSON`);
  }
}

// One gh read, a JSON value; `what` names it in a reason.
function gh(args, what) {
  const result = run('gh', args);
  if (result.status !== 0 || result.error) throw new Unknown(`${what}: ${failure(result)}`);
  return parse(result.stdout, what);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const names = (labels) =>
  (Array.isArray(labels) ? labels : [])
    .map((item) => (isObject(item) ? item.name : null))
    .filter((name) => typeof name === 'string');

// The `state:` labels an issue carries; two or more are a fault of that
// issue, never read as either.
const stateLabels = (labelNames) => labelNames.filter((name) => name.startsWith('state:')).sort();

// The open issues with one label, or every open one: at most MAX_LISTED, and
// a list that reaches it is one it cannot tell.
function issueList(repo, labelName = null) {
  const args = ['issue', 'list', '--repo', repo, '--state', 'open'];
  if (labelName !== null) args.push('--label', labelName);
  args.push('--json', 'number,title,labels,body,updatedAt', '--limit', String(MAX_LISTED));
  const what = `gh issue list${labelName === null ? '' : ` --label ${labelName}`}`;
  const list = gh(args, what);
  if (!Array.isArray(list)) throw new Unknown(`${what} did not answer a list`);
  if (list.length >= MAX_LISTED) throw new Unknown(`${what} listed ${MAX_LISTED} or more issues`);
  for (const item of list) {
    if (
      !isObject(item) ||
      !Number.isInteger(item.number) ||
      item.number <= 0 ||
      !Array.isArray(item.labels)
    ) {
      throw new Unknown(`${what} listed something that is no issue`);
    }
    item.names = names(item.labels);
    const states = stateLabels(item.names);
    if (states.length > 1) {
      throw new Unknown(`#${item.number} carries ${states.length} state: labels (${states.join(', ')})`);
    }
  }
  return list;
}

// One issue with its comments, oldest first.
function issueWithComments(repo, number) {
  const what = `gh issue view ${number}`;
  const found = gh(
    ['issue', 'view', String(number), '--repo', repo, '--json', 'number,state,labels,body,comments'],
    what,
  );
  if (
    !isObject(found) ||
    (found.body !== null && found.body !== undefined && typeof found.body !== 'string') ||
    !Array.isArray(found.labels) ||
    !Array.isArray(found.comments)
  ) {
    throw new Unknown(`${what} answered an unexpected shape`);
  }
  for (const comment of found.comments) {
    if (!isObject(comment) || typeof comment.body !== 'string') {
      throw new Unknown(`a comment of #${number} is not one`);
    }
  }
  const comments = found.comments
    .map((comment, at) => ({ comment, at }))
    .sort(
      (a, b) =>
        (Date.parse(a.comment.createdAt) || 0) - (Date.parse(b.comment.createdAt) || 0) ||
        a.at - b.at,
    )
    .map(({ comment }) => comment);
  return { ...found, body: found.body ?? '', names: names(found.labels), comments };
}

// Every label event of an issue, page by page: a full page means there is
// another.
function labelEvents(repo, number) {
  const events = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const path = `repos/${repo}/issues/${number}/events?per_page=${PER_PAGE}&page=${page}`;
    const answer = gh(['api', '--method', 'GET', path], `gh api ${path}`);
    if (!Array.isArray(answer)) throw new Unknown(`gh api ${path} did not answer a list`);
    events.push(...answer);
    if (answer.length < PER_PAGE) return events;
  }
  throw new Unknown(`the events of #${number} have more than ${MAX_PAGES} pages`);
}

// ---------------------------------------------------------------------------
// What issues say
// ---------------------------------------------------------------------------

const lines = (text) =>
  text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
const isFence = (line) => line.startsWith('```') || line.startsWith('~~~');

// Whether a line is a Markdown heading: one to six `#` and then a space or
// nothing.
function isHeading(line) {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#') hashes += 1;
  return hashes >= 1 && hashes <= 6 && (hashes === line.length || line[hashes] === ' ');
}

// Whether a line is an unticked task-list box: `- [ ]`, `* [ ]`, `+ [ ]` or
// `1. [ ]`, indented or not.
function isUnticked(line) {
  const text = line.trimStart();
  let at = 0;
  if (text[0] === '-' || text[0] === '*' || text[0] === '+') {
    at = 1;
  } else {
    while (at < text.length && at < 9 && text[at] >= '0' && text[at] <= '9') at += 1;
    if (at === 0 || (text[at] !== '.' && text[at] !== ')')) return false;
    at += 1;
  }
  return text.startsWith(' [ ]', at);
}

// Whether a text has the heading `## Owner steps before delivery` with an
// unticked box under it, before the next heading. Text inside a fenced block
// is not read: a quoted template is not a checklist.
export function hasUntickedOwnerStep(text) {
  if (typeof text !== 'string') return false;
  let fenced = false;
  let inside = false;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (isHeading(line)) {
      inside = line === OWNER_STEPS;
      continue;
    }
    if (inside && isUnticked(raw)) return true;
  }
  return false;
}

// The words after a run line's time: what follows the first `: ` within the
// first 80 characters after the opening, or null when the line is no run line
// of that opening.
function afterTime(line, opening) {
  if (!line.startsWith(opening)) return null;
  const at = line.indexOf(': ', opening.length);
  if (at < 0 || at - opening.length > 80) return null;
  return { time: line.slice(opening.length, at), words: line.slice(at + 2) };
}

const startsWithWord = (text, word) =>
  text.startsWith(word) && !/[A-Za-z0-9]/.test(text.charAt(word.length));

// The first line in a comment from an earlier scheduled delivery run that
// closes the double-take gate: a claim, `Scheduled run <time>: taken`, or a
// result, `DELIVERED`, `BLOCKED` or `RECOVERED`. A `not taken` skip is not
// one. Lines are read from their first character, outside fenced blocks.
export function earlierRunLine(text) {
  if (typeof text !== 'string') return null;
  let fenced = false;
  for (const line of lines(text)) {
    if (isFence(line.trim())) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const found = afterTime(line, SCHEDULED);
    if (found && EARLIER_RUN.some((word) => startsWithWord(found.words, word)))
      return oneLine(line, 100);
  }
  return null;
}

// A comment's opening run line, as the grooming procedure reads it: the
// comment begins `Grooming run <time>: `, read up to its first full stop.
// `kind` is `claim` for a take claim (`taken by…`, `taken over…`), `result`
// for a grooming result, `released` for a `/groom` chat's release, and
// `other` for anything else.
export function groomingLine(body) {
  if (typeof body !== 'string') return null;
  const first = lines(body)[0];
  const found = afterTime(first, GROOMING);
  if (!found) return null;
  const stop = found.words.indexOf('.');
  const words = stop < 0 ? found.words : found.words.slice(0, stop);
  let kind = 'other';
  if (startsWithWord(words, 'taken')) kind = 'claim';
  else if (GROOMING_RESULTS.some((result) => startsWithWord(words, result))) kind = 'result';
  else if (words.startsWith(RELEASED)) kind = 'released';
  return { time: found.time, kind };
}

// The time a run line names, `2026-10-10 03:22:10 MSK` as `date '+%Y-%m-%d
// %H:%M:%S %Z'` writes it, or `+0300` as `%z` does: MSK, UTC and GMT, or a
// numeric offset; null for anything else, since other abbreviations are
// ambiguous.
const ZONES = { MSK: '+03:00', UTC: 'Z', GMT: 'Z' };
export function runTime(text) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]{3}|[+-]\d{4})$/.exec(text);
  if (!match) return null;
  const zone =
    match[3].length === 3 ? ZONES[match[3]] : `${match[3].slice(0, 3)}:${match[3].slice(3)}`;
  if (zone === undefined) return null;
  const at = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(at) ? null : at;
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

const ORIGINS = ['fire', 'day'];
const LIVES = ['alive', 'DEAD', 'detached'];

function queue(...args) {
  const result = run('node', [QUEUE, ...args]);
  if (result.error || result.signal)
    throw new Unknown(`the queue's ${args[0]}: ${failure(result)}`);
  return result;
}

// The task Resume first would take, or null.
export function resumable(status) {
  if (!isObject(status) || !Array.isArray(status.tasks)) {
    throw new Unknown("the queue's status --json answered an unexpected shape");
  }
  const lockHeld = status.lock !== null;
  const paused = status.paused !== null;
  for (const task of status.tasks) {
    if (
      !isObject(task) ||
      typeof task.task !== 'string' ||
      !ORIGINS.includes(task.origin) ||
      !LIVES.includes(task.life)
    ) {
      throw new Unknown("the queue's status --json answered a task of an unexpected shape");
    }
    if (task.life === 'alive') continue;
    // A day task is the owner's until its session detaches it.
    if (task.origin === 'day' && task.life === 'DEAD') continue;
    // One awaiting the lock is taken only while the lock is free and the
    // queue runs.
    if (task.state === 'awaiting-lock' && (lockHeld || paused)) continue;
    const name = /^\d+$/.test(task.task) ? `#${task.task}` : task.task;
    return `resume ${name} (${task.origin} task, ${task.life})`;
  }
  return null;
}

// Why the procedure would pass this ready issue over at once, or null when
// it would take it to its other gates. Its labels are read again: an epic or
// an attended issue is never the cycle's, whatever the pick's list said.
function passedOver(repo, number) {
  const found = issueWithComments(repo, number);
  if (found.names.includes(EPIC)) return `labelled ${EPIC}: an epic is never delivered itself`;
  if (found.names.includes(ATTENDED)) return `labelled ${ATTENDED}: its delivery needs a person`;
  if (found.state !== 'OPEN' || !found.names.includes(READY)) {
    return `no longer an open ${READY} issue`;
  }
  for (const prefix of ['state:', 'prio:']) {
    const clash = found.names.filter((name) => name.startsWith(prefix)).sort();
    if (clash.length > 1) return `carries ${clash.length} ${prefix} labels (${clash.join(', ')})`;
  }
  const texts = [found.body, ...found.comments.map((comment) => comment.body)];
  if (texts.some(hasUntickedOwnerStep))
    return 'an unticked box under ## Owner steps before delivery';
  for (const comment of found.comments) {
    const line = earlierRunLine(comment.body);
    if (line) return `an earlier scheduled run's line: ${line}`;
  }
  return null;
}

function cycleWork(flow) {
  const status = queue('status', '--json');
  if (status.status !== 0) throw new Unknown(`the queue's status --json: ${failure(status)}`);
  const resume = resumable(parse(status.stdout, "the queue's status --json"));
  if (resume) return { work: true, reason: resume };

  const pick = queue('pick', '--json');
  if (pick.status === 3) {
    const why = oneLine((pick.stderr.split('\n')[0] ?? '').replace(/^refused: /, ''), 160);
    return { work: false, reason: `nothing to resume or take (pick: ${why})` };
  }
  if (pick.status !== 0) throw new Unknown(`the queue's pick --json: ${failure(pick)}`);
  const answer = parse(pick.stdout, "the queue's pick --json");
  if (!isObject(answer) || !Array.isArray(answer.take) || answer.take.length === 0) {
    throw new Unknown("the queue's pick --json answered an unexpected shape");
  }
  const passed = [];
  for (const candidate of answer.take.slice(0, MAX_CYCLE_CANDIDATES)) {
    if (!isObject(candidate) || !Number.isInteger(candidate.iid) || candidate.iid <= 0) {
      throw new Unknown("the queue's pick --json offered something that is no issue");
    }
    const why = passedOver(flow.project.repo, candidate.iid);
    if (why === null) return { work: true, reason: `#${candidate.iid} is ready to take` };
    passed.push(`#${candidate.iid}: ${why}`);
  }
  if (answer.take.length > MAX_CYCLE_CANDIDATES) {
    throw new Unknown(
      `${answer.take.length} ready candidates, the first ${MAX_CYCLE_CANDIDATES} passed over`,
    );
  }
  return { work: false, reason: `every ready candidate is passed over (${passed.join('; ')})` };
}

// The cycle's preconditions, run only with work present: GitHub and the
// remote answer, and Docker does where the project's suites need it.
function preconditions(flow) {
  const list = [
    ['github', 'gh', ['api', '--method', 'GET', `repos/${flow.project.repo}`]],
    ['remote', 'git', ['ls-remote', 'origin', 'HEAD']],
  ];
  if (flow.commands.taskTest !== '' || flow.commands.e2e !== '') {
    list.push(['docker', 'docker', ['info']]);
  }
  return list;
}

function cycle(flow) {
  let found;
  try {
    found = cycleWork(flow);
  } catch (error) {
    if (!(error instanceof Unknown)) throw error;
    found = { work: true, reason: `cannot tell: ${error.message}` };
  }
  if (!found.work) return found;
  for (const [name, command, args] of preconditions(flow)) {
    let answered;
    try {
      const result = run(command, args);
      answered = result.status === 0 && !result.error && !result.signal;
    } catch (error) {
      if (!(error instanceof Unknown)) throw error;
      answered = false;
    }
    if (!answered) {
      return {
        work: false,
        reason: `precondition ${name} failed with work present (${found.reason})`,
      };
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The grooming
// ---------------------------------------------------------------------------

const clock = (minutes) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// The morning range from `schedule.morningFire`, `HH:MM` on this machine's
// clock: that minute to MORNING_MINUTES after it, before the next grooming
// fire. Null for an empty one, which sends no morning notification.
export function morningRange(text) {
  if (text === '') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) {
    throw new Precondition(`schedule.morningFire in .claude/flow.json is not HH:MM or empty`);
  }
  const from = Number(match[1]) * 60 + Number(match[2]);
  return { from, to: from + MORNING_MINUTES, text: `${clock(from)}–${clock(from + MORNING_MINUTES)}` };
}

const minutesOfDay = (at) => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};
export const inMorning = (at, range = morningRange('09:07')) => {
  if (range === null) return false;
  const minutes = minutesOfDay(at);
  const late = minutes + 24 * 60;
  return (minutes >= range.from && minutes <= range.to) || (late >= range.from && late <= range.to);
};

// Whether the owner has seen an issue: a grooming run's result on it, a
// `/groom` chat's release, or `state:grooming` added to it, ever.
function seen(repo, number) {
  const { comments } = issueWithComments(repo, number);
  if (comments.some((comment) => ['result', 'released'].includes(groomingLine(comment.body)?.kind))) {
    return true;
  }
  return labelEvents(repo, number).some(
    (event) =>
      isObject(event) && event.event === 'labeled' && event.label?.name === 'state:grooming',
  );
}

function groomingWork(flow, now) {
  const range = morningRange(flow.schedule.morningFire);
  if (inMorning(now, range)) return { work: true, reason: `morning notification (${range.text})` };
  const repo = flow.project.repo;

  // (b) An earlier run still working, or one that died two hours ago.
  const held = issueList(repo, 'state:grooming').sort((a, b) => a.number - b.number);
  if (held.length > MAX_GROOMING_LOOKUPS) {
    throw new Unknown(`${held.length} issues carry state:grooming`);
  }
  let stale = null;
  for (const item of held) {
    const runs = issueWithComments(repo, item.number)
      .comments.map((comment) => groomingLine(comment.body))
      .filter(Boolean);
    const newest = runs.at(-1);
    if (newest?.kind !== 'claim') continue;
    const at = runTime(newest.time);
    if (at === null)
      throw new Unknown(`the claim time on #${item.number} reads ${oneLine(newest.time, 40)}`);
    if (now - at < STALE_CLAIM_MS) {
      return {
        work: false,
        reason: `the grooming run of ${newest.time} still holds #${item.number} (its claim is under two hours old)`,
      };
    }
    if (stale === null || at < stale.at) stale = { number: item.number, time: newest.time, at };
  }
  if (stale) {
    return {
      work: true,
      reason: `the claim of ${stale.time} on #${stale.number} is two hours old or more`,
    };
  }

  // (c) The owner's queue, then a candidate the owner has not seen.
  const waiting = issueList(repo, 'state:needs-owner').length;
  if (waiting >= NEEDS_OWNER_LIMIT) {
    return {
      work: false,
      reason: `${waiting} open issues wait for the owner (state:needs-owner), ${NEEDS_OWNER_LIMIT} or more`,
    };
  }
  const candidates = issueList(repo)
    .filter(
      (item) =>
        !item.names.some((name) => STATE_LABELS.includes(name)) && !item.names.includes(EPIC),
    )
    .sort((a, b) => b.number - a.number);
  if (candidates.length === 0) {
    return {
      work: false,
      reason: 'no candidate: every open issue carries a state label or is an epic',
    };
  }
  for (const candidate of candidates.slice(0, MAX_GROOMING_LOOKUPS)) {
    if (!seen(repo, candidate.number)) {
      return { work: true, reason: `#${candidate.number} is a candidate the owner has not seen` };
    }
  }
  if (candidates.length > MAX_GROOMING_LOOKUPS) {
    throw new Unknown(
      `${candidates.length} candidates, the first ${MAX_GROOMING_LOOKUPS} seen by the owner`,
    );
  }
  return {
    work: false,
    reason: `no candidate the owner has not seen (${candidates.length} seen)`,
  };
}

function grooming(flow, now) {
  try {
    return groomingWork(flow, now);
  } catch (error) {
    if (!(error instanceof Unknown)) throw error;
    return { work: true, reason: `cannot tell: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------

function nowFromEnvironment() {
  const given = process.env.FIRE_CHECK_NOW;
  if (!given) return Date.now();
  const at = Date.parse(given);
  return Number.isNaN(at) ? null : at;
}

export function main(argv) {
  const [job, ...rest] = argv;
  if (rest.length > 0 || (job !== 'cycle' && job !== 'grooming')) {
    return {
      status: 2,
      out: '',
      err: 'usage: node .claude/scripts/fire-check.mjs <cycle|grooming>\n',
    };
  }
  const now = nowFromEnvironment();
  if (now === null) return { status: 2, out: '', err: 'FIRE_CHECK_NOW is not a time\n' };
  let found;
  try {
    let flow;
    try {
      flow = loadFlow(ROOT);
    } catch (error) {
      if (!(error instanceof FlowConfigError)) throw error;
      throw new Precondition(error.message);
    }
    found = job === 'cycle' ? cycle(flow) : grooming(flow, now);
  } catch (error) {
    found =
      error instanceof Precondition
        ? { work: false, reason: `precondition flow failed (${oneLine(error.message, 200)})` }
        : // A fault of its own is something it cannot tell either.
          {
            work: true,
            reason: `cannot tell: an error of its own (${oneLine(error?.message ?? error, 120)})`,
          };
  }
  const line = `${found.work ? 'work' : 'skip'}: ${oneLine(found.reason, 400)}\n`;
  return { status: found.work ? 0 : 1, out: line, err: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, out, err } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = status;
}
