// The delivery queue (D16): the state the delivery cycle's sessions share on
// this machine, and the one delivery lock. `.claude/scheduled/delivery-cycle.md`
// says when each command is run; this file is what they do.
//
//   node .claude/scripts/delivery-queue.mjs <command> [arguments]
//
// The state is one JSON file under the repository's git directory —
// `$(git rev-parse --git-common-dir)/delivery-queue/state.json`, shared by the
// main checkout and every worktree, and never in Git — with the settings
// beside it. Every change is made holding the mutex, read whole, changed,
// written to a temporary file and renamed over the state, so a reader never
// sees half of it and two writers never interleave. The delivery lock is a
// field of that state: taking it is one such change, so of several sessions
// taking it at once exactly one does, and each acquisition gets a new random
// token.
//
// The mutex is the file `state.lock`, holding `<pid> <nonce>`: written whole
// beside it and hard-linked into place, so of several processes making it at
// once exactly one does and nobody sees it empty. Its holder removes it, and
// only while it still holds its own nonce. It is stale when the process it
// names is gone, or when it is older than 30 s whatever it names — no holder
// keeps it past one read and one write. A stale mutex is taken over through a
// claim: a file made with `wx`, named after that mutex's nonce, so of the
// processes that found the same stale mutex exactly one makes it; that one
// checks the mutex is still the one it found — nobody else may remove that
// one — removes it and lets go of the claim, and everyone tries the mutex
// again. A claim whose maker died holding it is passed over at the next
// level. Whoever holds the mutex sweeps what killed processes left: a
// temporary state, settings or mutex file, a dead claim.
//
// A task holds a slot while it is `working`. One `awaiting-lock`, `paused` or
// `delivering` holds none: the lock is a place of its own. The slot limit is a
// setting (`set slots <n>`), 3 by default. A task that comes back to work —
// from the lock, a pause or the wait for it — takes its slot back even over
// the limit; a new start waits until fewer tasks than the limit hold one.
// `adopt` leaves a paused task paused, and `lock` refuses it until
// `update --state working` puts it back to work, naming that command.
//
// A task belongs to one Claude Code session, named by its CLI session id —
// the directory that holds the session's scratchpad, which a headless run,
// whose system prompt names none, reads as `$CLAUDE_CODE_SESSION_ID` (D17).
// The desktop app's run status is no sign of life: a run waiting between
// turns for its background sub-agents reads `succeeded` while it is alive
// (D16). The signs are the session's transcript,
// `~/.claude/projects/<project>/<id>.jsonl`, and its sub-agents',
// `<id>/subagents/agent-*.jsonl`, written while they work, and the task's own
// updates. `<project>` is the folder Claude Code names after the path a
// session started in, every character but a letter or a digit made `-`
// (`/Users/me/src/app` is `-Users-me-src-app`), for the main checkout and each
// of its worktrees, as `git worktree list` gives them; no other folder is
// read. A session whose newest sign is older than `stale-minutes`, 90 by
// default, is presumed dead, and `adopt` hands a fire's task to the session
// that asks. A day task — the owner's, registered with `start --day` — is
// adopted only once its session has detached it.
//
// GitHub is read and merged through `gh`, always with `--repo` set to
// `project.repo` of `.claude/flow.json` (D22, D23); `project.mainBranch` names
// the main branch, read as `origin/<mainBranch>`. GitHub has no scoped labels,
// so one issue can carry two `state:` labels, or two `prio:` labels: the queue
// never guesses which holds, and `pick` passes such an issue over and `start`
// refuses it, saying which labels clash. An issue labelled `delivery:attended`
// (its delivery needs a person present) or `type:epic` (a container
// `/decompose` made, never delivered itself) is never the cycle's (D18, D25).
//
// `merge` is the one way a pull request is merged (D16): it checks the
// lock's current token holding the mutex and then runs `gh pr merge` itself,
// with `--match-head-commit`, so GitHub merges the checked commit or nothing.
// The Bash guard refuses every other way. A task whose merge broke main's run
// records its revert pull request with `update --pr` and merges it with the
// same `merge` and token, under the lock it still holds (the cycle's
// Recovery).
//
// `status --json` and `pick --json` print what `status` and `pick` print as
// one JSON object instead, for `.claude/scripts/fire-check.mjs`, which reads
// them before a scheduled fire starts a session (D17). Their exit statuses
// are the text forms', and the text forms are unchanged.
//
// Exit status: 0 done; 3 refused by the queue's state (the lock held, no slot
// free, a stale token, a session presumed alive, a conflict, an issue whose
// labels clash), with one line saying why; 2 wrong usage; 1 a fault — the
// state, `.claude/flow.json`, git or gh could not be read or written — and
// nothing changed, or gh did not merge, with what it printed, and the task's
// next step says to read the pull request.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FlowConfigError, loadFlow } from './flow-config.mjs';

const SCRIPT = '.claude/scripts/delivery-queue.mjs';
const DECISION = 'D16';
const DECISIONS = 'docs/DECISIONS.md';

export const DEFAULT_SLOTS = 3;
export const DEFAULT_STALE_MINUTES = 90;
const SLOT_RANGE = [1, 10];
const STALE_RANGE = [30, 1440];
// The longest one `lock --wait` may wait, in minutes: a Bash call in the
// background runs 30 minutes unless given longer, so one wait fits inside it.
export const MAX_WAIT_MINUTES = 25;
// The most `Depends on` issues of one issue a command looks up in GitHub; any
// beyond count as open.
export const MAX_DEPENDENCY_LOOKUPS = 20;
// The most ready issues one `pick` lists; gh reads the pages.
export const LIST_LIMIT = 200;

// The mutex is held for one read and one write. One not had within
// MUTEX_WAIT_MS is a fault. One whose process is gone, or older than
// MUTEX_STALE_MS whatever it names, was left by a process that died holding
// it, or by one whose PID the system has since given to another, and is taken
// over; CLAIM_LEVELS bounds the claims passed over on the way.
const MUTEX_WAIT_MS = 5000;
const MUTEX_POLL_MS = 10;
const MUTEX_STALE_MS = 30_000;
const CLAIM_LEVELS = 8;
const MUTEX_TEXT = /^([1-9]\d{0,9}) ([0-9a-f]{32})\n$/;

// A state or settings file larger than this is not one this script wrote.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Ended tasks kept for the record.
const ENDED_KEPT = 50;
// Free text kept per field: a reason, a next step.
const MAX_TEXT = 200;

export const STATES = ['working', 'awaiting-lock', 'delivering', 'paused'];
export const OUTCOMES = ['delivered', 'blocked', 'recovered', 'stopped'];
// Who started a task: a fire of the cycle, or an attended session, the owner
// in the chat, which registers it with `start --day` as a day task.
const ORIGINS = ['fire', 'day'];
// The labels the queue reads (D22). The cycle takes only `state:ready`, and
// never an issue whose delivery needs a person present, or that a scheduled
// run already took (D7, D18), nor an epic, which only holds other issues.
export const READY = 'state:ready';
export const ATTENDED = 'delivery:attended';
export const EPIC = 'type:epic';
const PRIORITIES = ['prio:1', 'prio:2', 'prio:3'];
const SETTABLE_STATES = ['working', 'awaiting-lock', 'paused'];

// A refusal: one line on stderr, and what the command found on stdout.
class Refused extends Error {
  constructor(message, out = '') {
    super(message);
    this.out = out;
  }
}
class Usage extends Error {}
// A fault: one line on stderr, and on stdout what a tool it ran printed.
class Fault extends Error {
  constructor(message, out = '') {
    super(message);
    this.out = out;
  }
}

const now = () => new Date();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// One line of at most `max` characters: control characters and runs of white
// space become one space.
export function oneLine(value, max = MAX_TEXT) {
  let text = '';
  let space = false;
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    const blank =
      code <= 0x20 ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029;
    if (blank) {
      space = text !== '';
      continue;
    }
    if (space) text += ' ';
    space = false;
    text += character;
    if (text.length > max) return `${text.slice(0, max - 1)}…`;
  }
  return text;
}

// A worktree's path as `start` and `update` take it: absolute, at most 4096
// characters, and one line that `oneLine` leaves as it is — no control
// character, no line break, no run of spaces — since `show`, `status` and
// `finish` print it back.
const isWorktreePath = (path) =>
  isAbsolute(path) && path.length <= 4096 && oneLine(path, 4096) === path;

const KEY = /^(?:[1-9]\d{0,8}|day-[a-z0-9][a-z0-9-]{0,39})$/;
const SHA = /^[0-9a-f]{7,64}$/;
// What `gh pr merge --match-head-commit` compares with the pull request's
// head: the whole commit id.
const FULL_SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isIssue = (key) => /^[1-9]\d{0,8}$/.test(key);
const label = (key) => (isIssue(key) ? `#${key}` : key);

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

// Whether one path segment matches one glob segment, `*` standing for any run
// of characters: the greedy match that backs up to the last `*`, linear in
// practice and never worse than the product of the two lengths.
function segmentMatches(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

// Whether a repository path matches a glob: `**` is any number of whole
// segments, and every other segment is matched as above. The same greedy
// match, one segment at a time.
export function globMatches(glob, path) {
  const pattern = glob.split('/');
  const segments = path.split('/');
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < segments.length) {
    if (p < pattern.length && pattern[p] === '**') {
      star = p;
      p += 1;
      mark = s;
    } else if (p < pattern.length && segmentMatches(pattern[p], segments[s])) {
      p += 1;
      s += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '**') p += 1;
  return p === pattern.length;
}

const specificity = (glob) => glob.length - [...glob].filter((c) => c === '*').length;

// The vocabulary, `.claude/delivery-areas.json` beside this script's folder,
// checked for the shape the rest relies on.
export function readVocabulary(
  path = join(dirname(fileURLToPath(import.meta.url)), '..', 'delivery-areas.json'),
) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Fault(`the area vocabulary ${path} cannot be read: ${error.message}`);
  }
  const names = new Set();
  const validArea = (area) => {
    const ok =
      isObject(area) &&
      typeof area.name === 'string' &&
      /^[a-z][a-z0-9-]{0,39}$/.test(area.name) &&
      area.name !== 'other' &&
      !names.has(area.name) &&
      typeof area.hard === 'boolean' &&
      Array.isArray(area.paths) &&
      area.paths.length > 0 &&
      area.paths.every((glob) => typeof glob === 'string' && glob !== '');
    if (ok) names.add(area.name);
    return ok;
  };
  const ok =
    isObject(parsed) &&
    Array.isArray(parsed.bookkeeping) &&
    parsed.bookkeeping.every((file) => typeof file === 'string') &&
    Array.isArray(parsed.areas) &&
    parsed.areas.every(validArea);
  if (!ok) throw new Fault(`the area vocabulary ${path} is not in the expected shape`);
  return {
    bookkeeping: new Set(parsed.bookkeeping),
    areas: parsed.areas.map(({ name, hard, paths }) => ({ name, hard, paths })),
    names,
    hard: new Set(parsed.areas.filter((area) => area.hard).map((area) => area.name)),
  };
}

// The areas one file counts in: every hard area with a matching glob, and the
// ordinary areas whose matching glob is the most specific; `other` when no
// glob matches. A bookkeeping file counts in none.
export function areasOfFile(vocabulary, path) {
  if (vocabulary.bookkeeping.has(path)) return [];
  const found = new Set();
  let best = -1;
  let ordinary = [];
  for (const area of vocabulary.areas) {
    for (const glob of area.paths) {
      if (!globMatches(glob, path)) continue;
      if (area.hard) {
        found.add(area.name);
      } else {
        const weight = specificity(glob);
        if (weight > best) {
          best = weight;
          ordinary = [area.name];
        } else if (weight === best && !ordinary.includes(area.name)) {
          ordinary.push(area.name);
        }
      }
    }
  }
  for (const name of ordinary) found.add(name);
  if (found.size === 0) found.add('other');
  return [...found];
}

export function areasOfFiles(vocabulary, paths) {
  const found = new Set();
  for (const path of paths) for (const name of areasOfFile(vocabulary, path)) found.add(name);
  return [...found].sort();
}

// ---------------------------------------------------------------------------
// What an issue says about itself
// ---------------------------------------------------------------------------

// Whether a line is a Markdown heading: one to six `#` and then a space or
// nothing.
function isHeading(line) {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#') hashes += 1;
  return hashes >= 1 && hashes <= 6 && (hashes === line.length || line[hashes] === ' ');
}

const isFence = (line) => line.startsWith('```') || line.startsWith('~~~');

// The areas an issue declares in its `## Touches` section: the names in its
// first paragraph — the lines after the heading up to a blank line or the
// next heading — separated by commas, spaces or line breaks, a list marker or
// backticks allowed around them. What follows that paragraph, a
// `Depends on #<number>` line say, is not read. `{ every: true }` with the
// reason when it declares none, or names a word that is no area: an issue
// that does not say what it touches counts as touching everything. Text
// inside a fenced block is not read.
export function declaredAreas(description, vocabulary) {
  if (typeof description !== 'string') return { every: true, why: 'no description' };
  let fenced = false;
  let inside = false;
  let found = false;
  let started = false;
  const names = [];
  for (const raw of description.split('\n')) {
    const line = raw.trim();
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!inside) {
      if (line === '## Touches') {
        inside = true;
        found = true;
      }
      continue;
    }
    if (isHeading(line)) break;
    if (line === '') {
      if (started) break;
      continue;
    }
    started = true;
    for (const piece of line.split(',')) {
      for (const word of piece.split(/\s+/)) {
        let name = word;
        if (name === '' || name === '-' || name === '*') continue;
        if (name.length > 2 && name.startsWith('`') && name.endsWith('`')) name = name.slice(1, -1);
        if (!vocabulary.names.has(name)) {
          return { every: true, why: `## Touches names ${oneLine(name, 60)}, which is no area` };
        }
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  if (!found) return { every: true, why: 'no ## Touches' };
  if (names.length === 0) return { every: true, why: '## Touches names no area' };
  return { every: false, areas: names.sort() };
}

// The issues a description depends on, as grooming writes them: every
// `#<number>` on a line from its `Depends on` to the line's end, so that
// `Depends on #1, #2` names both. A line is read once, however often it says
// `Depends on`, so a description of any length costs its length.
export function dependencies(description) {
  if (typeof description !== 'string') return [];
  const found = new Set();
  const phrase = 'Depends on';
  let at = description.indexOf(phrase);
  while (at >= 0) {
    let lineEnd = description.indexOf('\n', at);
    if (lineEnd < 0) lineEnd = description.length;
    let k = at + phrase.length;
    while (k < lineEnd) {
      if (description[k] !== '#') {
        k += 1;
        continue;
      }
      k += 1;
      let digits = '';
      while (k < lineEnd && digits.length < 10 && description[k] >= '0' && description[k] <= '9') {
        digits += description[k];
        k += 1;
      }
      if (/^[1-9]\d{0,8}$/.test(digits)) found.add(Number(digits));
    }
    at = description.indexOf(phrase, lineEnd);
  }
  return [...found].sort((a, b) => a - b);
}

// The names of an issue's labels as gh answers them, `[{ name, … }]`.
export const labelNames = (labels) =>
  (Array.isArray(labels) ? labels : [])
    .map((item) => (isObject(item) ? item.name : item))
    .filter((name) => typeof name === 'string');

// Why an issue's labels cannot be read as one state and one priority, or
// null: two `state:` labels, or two `prio:` labels. GitHub keeps neither
// unique, and the queue does not guess which of the two holds.
export function labelFault(names) {
  for (const prefix of ['state:', 'prio:']) {
    const found = names.filter((name) => name.startsWith(prefix)).sort();
    if (found.length > 1) {
      return `carries ${found.length} ${prefix} labels (${oneLine(found.join(', '), 120)}): fix its labels; the queue does not guess which holds`;
    }
  }
  return null;
}

// An issue's priority: 1, 2 or 3 from its `prio:` label, 4 for none or one
// that is no priority, and null when it carries two: a fault, never guessed.
export function priority(labels) {
  const found = (Array.isArray(labels) ? labels : []).filter(
    (name) => typeof name === 'string' && name.startsWith('prio:'),
  );
  if (found.length > 1) return null;
  if (found.length === 1 && PRIORITIES.includes(found[0])) return Number(found[0].slice(5));
  return 4;
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

// What keeps a task with these declared areas from running beside the tasks
// in flight, or null: a hard area it shares with one of them, or, when it
// touches every area, any task at all. `inFlight` maps each task in the queue
// to its areas, `null` for one that touches every area.
export function conflict(declared, inFlight, vocabulary) {
  if (declared.every) {
    if (inFlight.size === 0) return null;
    return `touches every area (${declared.why}), and ${[...inFlight.keys()].map(label).join(', ')} in flight`;
  }
  for (const [key, theirs] of inFlight) {
    const hard = declared.areas.filter(
      (name) => vocabulary.hard.has(name) && (theirs === null || theirs.includes(name)),
    );
    if (hard.length > 0) return `shares the hard area ${hard.join(', ')} with ${label(key)}`;
  }
  return null;
}

// Why an issue with dependencies still open, or not looked up, is passed over.
export function dependencyReason(open, unread = 0) {
  const parts = [];
  if (open.length > 0) parts.push(`depends on ${open.map((n) => `#${n}`).join(', ')}, still open`);
  if (unread > 0) {
    parts.push(
      `names ${unread} more ${unread === 1 ? 'dependency' : 'dependencies'} past the first ${MAX_DEPENDENCY_LOOKUPS}, not looked up and counted as open`,
    );
  }
  return parts.join('; ');
}

// The order in which a fire offers candidates to the procedure's gates, and
// those it passes over with the reason. `candidates` are ready issues with
// their priority, their declared areas, the dependencies still open and, when
// their labels clash, the fault. Among those it may take: priority, then the
// fewest areas shared with the tasks in flight, then the smaller number.
export function pickOrder(candidates, inFlight, vocabulary) {
  const every = [...vocabulary.names].sort();
  const flying = new Set([...inFlight.values()].flatMap((areas) => areas ?? every));
  const take = [];
  const passed = [];
  for (const candidate of candidates) {
    const { iid, open, declared, unread = 0, fault = null } = candidate;
    const why = inFlight.has(String(iid))
      ? 'in the queue already: resumed through the queue, never picked'
      : fault !== null
        ? fault
        : open.length > 0 || unread > 0
          ? dependencyReason(open, unread)
          : conflict(declared, inFlight, vocabulary);
    if (why !== null) {
      passed.push({ iid, why });
      continue;
    }
    const areas = declared.every ? every : declared.areas;
    take.push({ ...candidate, areas, shared: areas.filter((name) => flying.has(name)).length });
  }
  take.sort((a, b) => a.priority - b.priority || a.shared - b.shared || a.iid - b.iid);
  return { take, passed };
}

// ---------------------------------------------------------------------------
// The configuration, git and gh
// ---------------------------------------------------------------------------

// `.claude/flow.json`, read once per command and only by the commands that
// need it: a queue whose configuration is broken still shows, locks and
// finishes its tasks.
function flowOf(context) {
  if (context.flowRead === undefined) {
    let flow;
    try {
      flow = loadFlow();
    } catch (error) {
      if (error instanceof FlowConfigError) throw new Fault(error.message);
      throw error;
    }
    const main = flow.project.mainBranch;
    if (!BRANCH.test(main) || main.includes('..')) {
      throw new Fault(`project.mainBranch in .claude/flow.json is not a branch name`);
    }
    context.flowRead = flow;
  }
  return context.flowRead;
}

const repository = (context) => flowOf(context).project.repo;
const mainRef = (context) => `origin/${flowOf(context).project.mainBranch}`;

function run(command, args, cwd, { allowFail = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout;
  if (allowFail) return null;
  const why = result.error
    ? (result.error.code ?? result.error.message)
    : oneLine(result.stderr || `exit ${result.status}`, 160);
  throw new Fault(`${command} ${args.slice(0, 3).join(' ')} failed: ${why}`);
}

const git = (cwd, ...args) => run('git', args, cwd, { allowFail: true });

function ghJson(cwd, args) {
  const text = run('gh', args, cwd);
  try {
    return JSON.parse(text);
  } catch {
    throw new Fault(`gh ${args.slice(0, 2).join(' ')} did not answer JSON`);
  }
}

// The open issues labelled `state:ready`, at most LIST_LIMIT. gh filters by
// one label; the issues the cycle never takes are left out by the caller.
const readyIssues = (context) =>
  ghJson(context.cwd, [
    'issue',
    'list',
    '--repo',
    repository(context),
    '--state',
    'open',
    '--label',
    READY,
    '--json',
    'number,title,labels,body,updatedAt',
    '--limit',
    String(LIST_LIMIT),
  ]);

const issue = (context, number) =>
  ghJson(context.cwd, [
    'issue',
    'view',
    String(number),
    '--repo',
    repository(context),
    '--json',
    'number,state,labels,body',
  ]);

// The dependencies of one description that are still open: `open`, each read
// from GitHub once per command whatever number of issues name it — `seen`
// keeps what it answered — one that cannot be read counting as open; and
// `unread`, how many it names past the first MAX_DEPENDENCY_LOOKUPS, which are
// not looked up and count as open, so that a description naming hundreds
// costs no more than twenty calls.
function openDependencies(context, description, seen = new Map()) {
  const named = dependencies(description);
  const open = [];
  for (const number of named.slice(0, MAX_DEPENDENCY_LOOKUPS)) {
    if (!seen.has(number)) {
      let state;
      try {
        state = issue(context, number)?.state;
      } catch {
        state = null;
      }
      seen.set(number, state);
    }
    if (seen.get(number) !== 'CLOSED') open.push(number);
  }
  return { open, unread: Math.max(0, named.length - MAX_DEPENDENCY_LOOKUPS) };
}

// The commit a task's branch is at: its local branch, else origin's.
function branchCommit(cwd, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const sha = git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    if (sha) return sha.trim();
  }
  return null;
}

// The files a branch has changed against its base, the commit it shares with
// origin's main branch — its BASE_SHA, or the main it last merged in — and
// their areas. Null when the branch or the base cannot be found.
export function changedAreas(cwd, vocabulary, branch, recordedBase = null, main = 'origin/main') {
  const head = branchCommit(cwd, branch);
  if (head === null) return null;
  const base = git(cwd, 'merge-base', main, head)?.trim() || recordedBase;
  if (!base) return null;
  const listed = git(cwd, 'diff', '--name-only', '--no-renames', base, head);
  if (listed === null) return null;
  const files = listed.split('\n').filter((file) => file !== '');
  return { base, head, files, areas: areasOfFiles(vocabulary, files) };
}

// The highest decision id `D<n>` on main's decision log, or null when it has
// none. Headings only, `## D<n>` followed by a space or nothing; the kit's
// own `DK<n>` ids are not counted.
export function highestDecision(text) {
  let highest = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('## D')) continue;
    let digits = '';
    for (let at = 4; at < line.length && at < 14 && line[at] >= '0' && line[at] <= '9'; at += 1) {
      digits += line[at];
    }
    if (digits !== '' && (line.length === 4 + digits.length || line[4 + digits.length] === ' ')) {
      const id = Number(digits);
      if (highest === null || id > highest) highest = id;
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// The state on disk
// ---------------------------------------------------------------------------

function stateDirectory(cwd) {
  const common = git(cwd, 'rev-parse', '--git-common-dir');
  if (common === null || common.trim() === '') {
    throw new Fault('not in a git repository: run it from the main checkout or a task worktree');
  }
  return join(resolve(cwd, common.trim()), 'delivery-queue');
}

const emptyState = () => ({
  version: 1,
  nextDecision: null,
  lock: null,
  paused: null,
  tasks: {},
  ended: [],
});

// A regular file's text, at most MAX_FILE_BYTES, never through a link; null
// when there is none.
function readRegular(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Fault(`${path} cannot be read: ${error.code}`);
  }
  if (!stats.isFile()) throw new Fault(`${path} is not a regular file`);
  if (stats.size > MAX_FILE_BYTES) throw new Fault(`${path} is larger than the queue ever writes`);
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isTextOrNull = (value) => value === null || typeof value === 'string';

function validTask(key, task) {
  return (
    isObject(task) &&
    task.key === key &&
    ORIGINS.includes(task.origin) &&
    STATES.includes(task.state) &&
    isTextOrNull(task.session) &&
    typeof task.branch === 'string' &&
    typeof task.worktree === 'string' &&
    Array.isArray(task.worktrees) &&
    (task.declared === null ||
      (Array.isArray(task.declared) && task.declared.every((n) => typeof n === 'string'))) &&
    Number.isInteger(task.rounds) &&
    task.rounds >= 0 &&
    Array.isArray(task.decisions) &&
    isObject(task.verified) &&
    isTime(task.updatedAt)
  );
}

// The state as written, checked for the shape the rest relies on. A state
// that is not is a fault, never an empty queue: that would release the lock.
export function parseState(text, path = 'the state') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Fault(
      `${path} is not JSON; nothing was changed. Move it aside by hand once the tasks in it are accounted for`,
    );
  }
  const ok =
    isObject(parsed) &&
    parsed.version === 1 &&
    (parsed.nextDecision === null || Number.isInteger(parsed.nextDecision)) &&
    (parsed.lock === null ||
      (isObject(parsed.lock) &&
        typeof parsed.lock.key === 'string' &&
        TOKEN.test(parsed.lock.token ?? ''))) &&
    (parsed.paused === null ||
      (isObject(parsed.paused) && typeof parsed.paused.reason === 'string')) &&
    isObject(parsed.tasks) &&
    Object.entries(parsed.tasks).every(([key, task]) => KEY.test(key) && validTask(key, task)) &&
    Array.isArray(parsed.ended) &&
    (parsed.lock === null || Object.hasOwn(parsed.tasks, parsed.lock.key));
  if (!ok) {
    throw new Fault(`${path} is not in the shape this script writes; nothing was changed`);
  }
  return parsed;
}

function readState(directory) {
  const path = join(directory, 'state.json');
  const text = readRegular(path);
  return text === null ? emptyState() : parseState(text, path);
}

function readSettings(directory) {
  const path = join(directory, 'settings.json');
  const text = readRegular(path);
  const settings = { slots: DEFAULT_SLOTS, staleMinutes: DEFAULT_STALE_MINUTES, from: 'default' };
  if (text === null) return settings;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Fault(`${path} is not JSON`);
  }
  if (!isObject(parsed)) throw new Fault(`${path} is not a JSON object`);
  const inRange = (value, [low, high]) => Number.isInteger(value) && value >= low && value <= high;
  if (parsed.slots !== undefined) {
    if (!inRange(parsed.slots, SLOT_RANGE))
      throw new Fault(`${path}: slots is not ${SLOT_RANGE.join('–')}`);
    settings.slots = parsed.slots;
  }
  if (parsed.staleMinutes !== undefined) {
    if (!inRange(parsed.staleMinutes, STALE_RANGE)) {
      throw new Fault(`${path}: staleMinutes is not ${STALE_RANGE.join('–')}`);
    }
    settings.staleMinutes = parsed.staleMinutes;
  }
  settings.from = path;
  return settings;
}

// Written whole into a temporary file beside it and renamed over it.
function writeWhole(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Fault(`${path} cannot be written: ${error.code ?? error.message}`);
  }
}

// ---------------------------------------------------------------------------
// The mutex
// ---------------------------------------------------------------------------

// Whether a process of this machine is still there. EPERM is one that is,
// owned by another user.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A mutex or a claim as found, read through one descriptor so that what it
// holds and which file it is agree: its inode and time, and the PID and nonce
// it holds, null when it holds anything else. Null when there is none.
export function readMutex(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Fault(
      `${path} cannot be read: ${error.code}; remove it by hand once no queue command runs`,
    );
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Fault(
        `${path} is not a regular file; remove it by hand once no queue command runs`,
      );
    }
    const buffer = Buffer.alloc(64);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const match = MUTEX_TEXT.exec(buffer.subarray(0, read).toString('latin1'));
    return {
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      pid: match ? Number(match[1]) : null,
      nonce: match ? match[2] : null,
    };
  } finally {
    closeSync(fd);
  }
}

const isStale = (found) =>
  Date.now() - found.mtimeMs > MUTEX_STALE_MS || (found.pid !== null && !isAlive(found.pid));

const sameFile = (a, b) =>
  a !== null && b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.nonce === b.nonce;

// Takes a stale mutex away, or leaves it to the process already doing so:
// true when the caller should try the mutex again at once. The claim is named
// after the stale mutex — its nonce, or its inode and time when it holds none
// — so only the processes that found that very mutex compete for it, and the
// one that makes the claim checks, before removing the mutex, that it is still
// the one found: nobody but that claim's maker removes that file.
export function takeOver(directory, mutex, found, own) {
  const id = found.nonce ?? `i${found.ino}-${Math.round(found.mtimeMs * 1000)}`;
  for (let level = 1; level <= CLAIM_LEVELS; level += 1) {
    const claim = join(directory, `state.lock.claim-${id}-${level}`);
    let fd;
    try {
      fd = openSync(claim, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Fault(`${claim} cannot be made: ${error.code}`);
      const maker = readMutex(claim);
      // Gone: its maker is done. Alive: it is taking the mutex over now.
      if (maker === null || !isStale(maker)) return maker === null;
      // Its maker died holding it: the next level.
      continue;
    }
    try {
      writeSync(fd, own);
    } finally {
      closeSync(fd);
    }
    try {
      if (sameFile(found, readMutex(mutex))) rmSync(mutex, { force: true });
    } finally {
      rmSync(claim, { force: true });
    }
    return true;
  }
  return false;
}

// The mutex, held until `release` is called: `<pid> <nonce>` written into a
// file of its own and hard-linked as `state.lock`, which fails while one is
// there.
function acquire(directory) {
  const mutex = join(directory, 'state.lock');
  const nonce = randomBytes(16).toString('hex');
  const own = `${process.pid} ${nonce}\n`;
  const mine = join(directory, `state.lock.${process.pid}.${nonce}.tmp`);
  const deadline = Date.now() + MUTEX_WAIT_MS;
  try {
    for (;;) {
      try {
        writeFileSync(mine, own, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw new Fault(`${mine} cannot be made: ${error.code}`);
      }
      try {
        linkSync(mine, mutex);
        return { mutex, nonce };
      } catch (error) {
        // Swept away by a holder that took it for a dead process's: again.
        if (error.code === 'ENOENT') continue;
        if (error.code !== 'EEXIST') throw new Fault(`${mutex} cannot be made: ${error.code}`);
      }
      const found = readMutex(mutex);
      if (found === null) continue;
      if (isStale(found) && takeOver(directory, mutex, found, own)) continue;
      if (Date.now() >= deadline) {
        const holder = found.pid === null ? '' : `, PID ${found.pid}`;
        throw new Fault(`the queue state is in use by another process (${mutex}${holder})`);
      }
      sleep(MUTEX_POLL_MS);
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

// Whether the mutex is still this holder's: it is not, only when another
// process took it for a dead one's, which takes a holder stopped past
// MUTEX_STALE_MS.
const stillHeld = (held) => readMutex(held.mutex)?.nonce === held.nonce;

function release(held) {
  try {
    if (stillHeld(held)) rmSync(held.mutex, { force: true });
  } catch {
    // Not this holder's to remove, or gone: nothing to release.
  }
}

const LEFTOVER_WRITE = /^(?:state|settings)\.json\.\d+\.[0-9a-f]+\.tmp$/;
const LEFTOVER_MUTEX = /^state\.lock\.(\d+)\.[0-9a-f]{32}\.tmp$/;
const CLAIM = /^state\.lock\.claim-[0-9a-z-]+$/;

// What killed processes left, removed by the holder: a temporary state or
// settings — nobody else writes one while the mutex is held — a mutex file of
// a process that is gone, and a claim whose maker is gone or done.
function sweep(directory) {
  for (const entry of entries(directory)) {
    const path = join(directory, entry.name);
    let dead = LEFTOVER_WRITE.test(entry.name);
    const mutexFile = LEFTOVER_MUTEX.exec(entry.name);
    if (mutexFile) dead = !isAlive(Number(mutexFile[1]));
    if (CLAIM.test(entry.name)) {
      try {
        const maker = readMutex(path);
        dead = maker !== null && isStale(maker);
      } catch {
        dead = false;
      }
    }
    if (dead) rmSync(path, { force: true });
  }
}

// `work(state, settings)` run holding the mutex, its changes written when it
// returns `{ write: true }`.
function withState(directory, work) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Fault(`${directory} cannot be made: ${error.code}`);
  }
  const held = acquire(directory);
  try {
    sweep(directory);
    const state = readState(directory);
    const settings = readSettings(directory);
    const result = work(state, settings);
    if ((result?.write || result?.settings) && !stillHeld(held)) {
      throw new Fault(
        `this process held the queue's mutex past ${MUTEX_STALE_MS / 1000} s and another took it over; nothing was written`,
      );
    }
    if (result?.write) writeWhole(join(directory, 'state.json'), state);
    if (result?.settings) writeWhole(join(directory, 'settings.json'), result.settings);
    return result;
  } finally {
    release(held);
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const holdsSlot = (task) => task.state === 'working';
const slotsInUse = (state) => Object.values(state.tasks).filter(holdsSlot).length;

function setLock(state, key) {
  for (const task of Object.values(state.tasks)) task.token = null;
  if (key === null) {
    state.lock = null;
    return null;
  }
  const token = randomBytes(16).toString('hex');
  state.lock = { key, token, since: now().toISOString() };
  state.tasks[key].token = token;
  return token;
}

function taskOf(state, key) {
  const task = state.tasks[key];
  if (!task) throw new Refused(`${label(key)} is not in the queue`);
  return task;
}

// The task, when `session` is the one it belongs to. A task that belongs to
// another session, or to none since its session detached, is that session's
// or is adopted first: a session that is not the task's stops acting on it.
function ownTask(state, key, session) {
  const task = taskOf(state, key);
  if (task.session !== session) {
    const owner = task.session === null ? 'no session (detached)' : `the session "${task.session}"`;
    throw new Refused(
      `${label(key)} belongs to ${owner}, not to "${session}": stop acting on it, read its actual state, and adopt it first`,
    );
  }
  return task;
}

const touch = (task) => {
  task.updatedAt = now().toISOString();
};

function time(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The areas of every task in the queue: what it declared, `null` for every
// area, plus what its branch has changed.
function inFlightAreas(context, state) {
  const result = new Map();
  for (const [key, task] of Object.entries(state.tasks)) {
    if (task.declared === null) {
      result.set(key, null);
      continue;
    }
    const changed = changedAreas(
      context.cwd,
      context.vocabulary,
      task.branch,
      task.base,
      mainRef(context),
    );
    const areas = new Set(task.declared);
    for (const name of changed?.areas ?? []) areas.add(name);
    result.set(key, [...areas].sort());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Signs of life
// ---------------------------------------------------------------------------

export const projectsRoot = () => join(homedir(), '.claude', 'projects');

// The names Claude Code gives the folder of a session started in `path`:
// every character but a letter or a digit made `-`. The plain rule, every `/`
// and `.` made `-`, gives the same name for the usual paths, and is read too.
export function projectNames(path) {
  return [...new Set([path.replace(/[^A-Za-z0-9]/g, '-'), path.replace(/[/.]/g, '-')])];
}

// The project folders a session of this repository writes its transcript
// in: those of the main checkout and of each of its worktrees, as given and
// with links resolved. Never any other folder.
export function projectDirectories(cwd, root = projectsRoot()) {
  const paths = [];
  for (const line of (git(cwd, 'worktree', 'list', '--porcelain') ?? '').split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length));
  }
  if (paths.length === 0) {
    const top = git(cwd, 'rev-parse', '--show-toplevel')?.trim();
    if (top) paths.push(top);
  }
  const names = new Set();
  for (const path of paths) {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // A worktree whose folder is gone: its name as given.
    }
    for (const each of new Set([path, real])) for (const name of projectNames(each)) names.add(name);
  }
  return [...names].map((name) => join(root, name));
}

const modified = (path) => {
  try {
    const stats = lstatSync(path);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
};

const entries = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
};

// When a session's transcripts were last written — its own, and its
// sub-agents' — in the project folders `directories`: whether its own was
// found, and the newest time, null when there is none.
export function transcriptTimes(session, directories) {
  let found = false;
  let latest = null;
  const newer = (time) => {
    if (time !== null && (latest === null || time > latest)) latest = time;
  };
  for (const directory of directories) {
    const own = modified(join(directory, `${session}.jsonl`));
    if (own === null) continue;
    found = true;
    newer(own);
    const subagents = join(directory, session, 'subagents');
    for (const file of entries(subagents)) {
      if (file.name.startsWith('agent-') && file.name.endsWith('.jsonl')) {
        newer(modified(join(subagents, file.name)));
      }
    }
  }
  return { found, latest };
}

// Whether a task's session shows a sign of life within the threshold: its
// transcripts, its sub-agents' and the task's last update, the newest of them.
export function liveness(task, staleMinutes, at = Date.now(), directories = []) {
  if (task.session === null) return { alive: false, minutes: null, transcript: false };
  const { found, latest } = transcriptTimes(task.session, directories);
  const newest = Math.max(Date.parse(task.updatedAt), latest ?? 0);
  const minutes = Math.max(0, Math.floor((at - newest) / 60_000));
  return { alive: minutes <= staleMinutes, minutes, transcript: found };
}

const lifeText = (life) =>
  life.minutes === null
    ? 'detached'
    : `${life.alive ? 'alive' : 'DEAD'}, last sign ${life.minutes} min ago${life.transcript ? '' : ', no transcript found'}`;

const projectsOf = (context) => {
  if (context.projects === undefined) context.projects = projectDirectories(context.cwd);
  return context.projects;
};

// A session that names itself must have a transcript, or nothing could tell
// later whether it is alive.
function requireTranscript(context, session) {
  if (!transcriptTimes(session, projectsOf(context)).found) {
    throw new Refused(
      `no transcript of the session ${session} under ${projectsRoot()} in the folders of this repository's checkouts: give the CLI session id, the directory that holds this session's scratchpad, or $CLAUDE_CODE_SESSION_ID in a headless run`,
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseArguments(argv, { flags = [], options = [] }) {
  const positional = [];
  const values = {};
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    if (word.startsWith('--')) {
      const name = word.slice(2);
      if (flags.includes(name)) {
        values[name] = true;
      } else if (options.includes(name)) {
        if (at + 1 >= argv.length) throw new Usage(`--${name} needs a value`);
        values[name] = argv[at + 1];
        at += 1;
      } else {
        throw new Usage(`unknown option ${oneLine(word, 60)}`);
      }
    } else {
      positional.push(word);
    }
  }
  return { positional, values };
}

function keyArgument(value) {
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw new Usage(
      'a task is an issue number, such as 127, or day-<word> for a day task without an issue',
    );
  }
  return value;
}

function sessionArgument(values) {
  const session = values.session ?? '';
  if (!SESSION.test(session)) {
    throw new Usage(
      "--session <id> is required: the CLI session id, the name of the directory that holds this session's scratchpad, or $CLAUDE_CODE_SESSION_ID in a headless run",
    );
  }
  return session;
}

function areaList(text, vocabulary) {
  const names = [
    ...new Set(
      text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
  if (names.length === 0) throw new Usage('--areas needs at least one area');
  for (const name of names) {
    if (!vocabulary.names.has(name))
      throw new Usage(`${oneLine(name, 60)} is no area of the vocabulary`);
  }
  return names.sort();
}

const ORIGIN_TEXT = {
  fire: 'fire (a session of the delivery cycle)',
  day: "day (the owner's session; a fire adopts it only once detached)",
};

function showTask(task, state, settings, directories) {
  const life = lifeText(liveness(task, settings.staleMinutes, Date.now(), directories));
  const lines = [
    `${label(task.key)}: ${task.state}${state.lock?.key === task.key ? ', holding the lock' : ''}${holdsSlot(task) ? ', holding a slot' : ''}`,
    `  origin: ${ORIGIN_TEXT[task.origin]}`,
    `  session: ${task.session ?? '(detached)'} (${life})`,
    `  branch: ${task.branch}  worktree: ${task.worktree}`,
    `  worktrees: ${task.worktrees.join(', ') || '-'}`,
    `  base: ${task.base ?? '-'}  PR: ${task.pr ? `#${task.pr}` : '-'}`,
    `  areas declared: ${task.declared === null ? 'every area' : task.declared.join(', ')}`,
    `  verified: tester ${task.verified.tester ?? '-'}, reviewer ${task.verified.reviewer ?? '-'}, against main ${task.verified.main ?? '-'}`,
    `  correction rounds: ${task.rounds}`,
    `  decision ids: ${task.decisions.map((id) => `D${id}`).join(', ') || '-'}`,
    `  next: ${task.next ?? '-'}`,
    `  reason: ${task.reason ?? '-'}`,
    `  updated: ${time(task.updatedAt)}`,
  ];
  return lines.join('\n');
}

const tableOrder = (state) =>
  Object.values(state.tasks).sort(
    (a, b) =>
      Number(isIssue(b.key)) - Number(isIssue(a.key)) ||
      a.key.localeCompare(b.key, 'en', { numeric: true }),
  );

function statusText(state, settings, directories) {
  const lock = state.lock
    ? `lock: ${label(state.lock.key)} since ${time(state.lock.since)}`
    : 'lock: free';
  const queue = state.paused
    ? `queue PAUSED since ${time(state.paused.since)}: ${state.paused.reason}`
    : 'queue running';
  const used = slotsInUse(state);
  const over =
    used > settings.slots
      ? ` (over the limit: a task back at work took its slot back; no new start until fewer than ${settings.slots})`
      : '';
  const header = `Delivery queue · ${used} of ${settings.slots} slots in use${over} · ${lock} · ${queue} · dead after ${settings.staleMinutes} min without a sign of life`;
  const tasks = tableOrder(state);
  if (tasks.length === 0) return `${header}\nNo task in the queue.`;
  const rows = [['Task', 'Origin', 'State', 'PR', 'Holds', 'Session', 'Life', 'Next', 'Reason']];
  for (const task of tasks) {
    rows.push([
      label(task.key),
      task.origin,
      task.state,
      task.pr ? `#${task.pr}` : '-',
      state.lock?.key === task.key ? 'lock' : holdsSlot(task) ? 'slot' : '-',
      task.session === null ? '(detached)' : task.session.slice(0, 8),
      lifeText(liveness(task, settings.staleMinutes, Date.now(), directories)),
      task.next ?? '-',
      task.reason ?? '-',
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const table = rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
      .join('  ')
      .trimEnd(),
  );
  return [header, ...table].join('\n');
}

// What `status` prints, as one JSON object, for `fire-check.mjs` (D17): the
// slots, the lock, the pause and the threshold, and per task, in the table's
// order, its key, origin, state, pull request, what it holds, its session and
// its life — `alive`, `DEAD` or `detached`, the words of the table — with the
// minutes since its last sign. No token is in it, as none is in the table.
export function statusJson(state, settings, at = Date.now(), directories = []) {
  return {
    slots: settings.slots,
    used: slotsInUse(state),
    staleMinutes: settings.staleMinutes,
    lock: state.lock ? { task: state.lock.key, since: state.lock.since } : null,
    paused: state.paused ? { since: state.paused.since, reason: state.paused.reason } : null,
    tasks: tableOrder(state).map((task) => {
      const life = liveness(task, settings.staleMinutes, at, directories);
      return {
        task: task.key,
        origin: task.origin,
        state: task.state,
        pr: task.pr ?? null,
        holds: state.lock?.key === task.key ? 'lock' : holdsSlot(task) ? 'slot' : null,
        session: task.session,
        life: life.minutes === null ? 'detached' : life.alive ? 'alive' : 'DEAD',
        minutes: life.minutes,
        transcript: life.transcript,
        next: task.next ?? null,
        reason: task.reason ?? null,
        updatedAt: task.updatedAt,
      };
    }),
  };
}

const COMMANDS = {
  status(argv, context) {
    const { values } = parseArguments(argv, { flags: ['json'] });
    const state = readState(context.directory);
    const settings = readSettings(context.directory);
    const directories = projectsOf(context);
    return {
      text: values.json
        ? JSON.stringify(statusJson(state, settings, Date.now(), directories))
        : statusText(state, settings, directories),
    };
  },

  show(argv, context) {
    const { positional } = parseArguments(argv, {});
    const key = keyArgument(positional[0]);
    const state = readState(context.directory);
    return {
      text: showTask(
        taskOf(state, key),
        state,
        readSettings(context.directory),
        projectsOf(context),
      ),
    };
  },

  set(argv, context) {
    const { positional } = parseArguments(argv, {});
    const [name, raw] = positional;
    const ranges = { slots: SLOT_RANGE, 'stale-minutes': STALE_RANGE };
    if (!Object.hasOwn(ranges, name) || positional.length !== 2) {
      throw new Usage('set slots <1–10> | set stale-minutes <30–1440>');
    }
    const value = Number(raw);
    const [low, high] = ranges[name];
    if (!/^\d{1,4}$/.test(raw) || value < low || value > high)
      throw new Usage(`${name} is ${low}–${high}`);
    return withState(context.directory, (state, settings) => {
      const next = { slots: settings.slots, staleMinutes: settings.staleMinutes };
      if (name === 'slots') next.slots = value;
      else next.staleMinutes = value;
      return {
        settings: next,
        text: `${name} set to ${value} in ${join(context.directory, 'settings.json')}`,
      };
    });
  },

  areas(argv, context) {
    const { positional, values } = parseArguments(argv, { flags: ['files'] });
    if (values.files) {
      const lines = positional.map(
        (file) => `${file}: ${areasOfFile(context.vocabulary, file).join(', ') || '(bookkeeping)'}`,
      );
      lines.push(`areas: ${areasOfFiles(context.vocabulary, positional).join(', ') || '-'}`);
      return { text: lines.join('\n') };
    }
    const branch = positional[0];
    if (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..')) {
      throw new Usage('areas <branch> | areas --files <path>…');
    }
    const main = mainRef(context);
    const changed = changedAreas(context.cwd, context.vocabulary, branch, null, main);
    if (changed === null) throw new Fault(`the branch ${branch} or its base on ${main} cannot be found`);
    const lines = changed.files.map(
      (file) => `${file}: ${areasOfFile(context.vocabulary, file).join(', ') || '(bookkeeping)'}`,
    );
    lines.push(
      `areas of ${branch} against ${changed.base.slice(0, 12)}: ${changed.areas.join(', ') || '-'}`,
    );
    return { text: lines.join('\n') };
  },

  pick(argv, context) {
    const { values } = parseArguments(argv, { flags: ['json'] });
    const { vocabulary, directory } = context;
    const state = readState(directory);
    const settings = readSettings(directory);
    const used = slotsInUse(state);
    const header = `Slots: ${used} of ${settings.slots} in use. Lock: ${state.lock ? label(state.lock.key) : 'free'}. Queue: ${state.paused ? 'paused' : 'running'}.`;
    // The JSON form: the same answer, the same exit status (D17).
    const json = (take, passed) =>
      JSON.stringify({
        slots: settings.slots,
        used,
        lock: state.lock ? state.lock.key : null,
        paused: Boolean(state.paused),
        take: take.map((item) => ({
          iid: item.iid,
          priority: item.priority,
          areas: item.declared.every ? null : item.areas,
          shared: item.shared,
        })),
        passed: passed.map((item) => ({ iid: item.iid, why: item.why })),
      });
    if (used >= settings.slots) {
      throw new Refused(
        `${header} No slot is free: take no new issue.`,
        values.json ? `${json([], [])}\n` : '',
      );
    }
    const listed = readyIssues(context);
    if (!Array.isArray(listed)) throw new Fault('gh issue list did not answer a list');
    const seen = new Map();
    const candidates = [];
    for (const item of listed) {
      if (!isObject(item) || !Number.isInteger(item.number) || item.number <= 0) continue;
      const names = labelNames(item.labels);
      // The issues the cycle never takes are not its candidates at all.
      if (!names.includes(READY) || names.includes(ATTENDED) || names.includes(EPIC)) continue;
      const fault = labelFault(names);
      candidates.push({
        iid: item.number,
        priority: priority(names) ?? 4,
        fault,
        declared: declaredAreas(item.body, vocabulary),
        ...(fault === null ? openDependencies(context, item.body, seen) : { open: [], unread: 0 }),
      });
    }
    const { take, passed } = pickOrder(candidates, inFlightAreas(context, state), vocabulary);
    if (values.json) {
      if (take.length === 0) throw new Refused('nothing to take', `${json(take, passed)}\n`);
      return { text: json(take, passed) };
    }
    const lines = [header];
    if (take.length > 0) {
      lines.push('Offer to the gates in this order:');
      for (const item of take) {
        const prio = item.priority === 4 ? 'no prio' : `prio:${item.priority}`;
        const areas = item.declared.every
          ? `every area (${item.declared.why})`
          : item.areas.join(', ');
        lines.push(
          `  #${item.iid}  ${prio}  areas: ${areas}  shared with tasks in flight: ${item.shared}`,
        );
      }
    }
    if (passed.length > 0) {
      lines.push('Passed over, the label kept:');
      for (const item of passed) lines.push(`  #${item.iid}  ${item.why}`);
    }
    if (take.length === 0) throw new Refused('nothing to take', `${lines.join('\n')}\n`);
    return { text: lines.join('\n') };
  },

  start(argv, context) {
    const { positional, values } = parseArguments(argv, {
      flags: ['day'],
      options: ['session', 'branch', 'worktree', 'base', 'areas'],
    });
    const key = keyArgument(positional[0]);
    const session = sessionArgument(values);
    requireTranscript(context, session);
    const { vocabulary, directory } = context;
    const branch = values.branch ?? '';
    if (!BRANCH.test(branch) || branch.includes('..'))
      throw new Usage('--branch <type>/<slug> is required');
    const worktree = values.worktree ?? '';
    if (!isWorktreePath(worktree)) throw new Usage('--worktree <absolute path> is required');
    if (values.base !== undefined && !SHA.test(values.base))
      throw new Usage('--base is a commit SHA');
    const day = values.day === true;
    if (!day && !isIssue(key))
      throw new Usage('a fire starts an issue; day-<word> is for a day task (--day)');
    if (values.areas !== undefined && !day) {
      throw new Usage(
        "--areas is for a day task: a fire's task declares its areas in its issue's ## Touches",
      );
    }
    // A fire's issue is read again here: the pick's list may be minutes old.
    const found = isIssue(key) && (!day || values.areas === undefined) ? issue(context, key) : null;
    if (found !== null && !isObject(found))
      throw new Fault(`gh did not answer #${key} as an issue`);
    if (!day) {
      const names = labelNames(found.labels);
      if (
        found.state !== 'OPEN' ||
        !names.includes(READY) ||
        names.includes(ATTENDED) ||
        names.includes(EPIC)
      ) {
        throw new Refused(
          `#${key} is no longer an open ${READY} issue outside ${ATTENDED} and ${EPIC}`,
        );
      }
      const fault = labelFault(names);
      if (fault !== null) throw new Refused(`#${key} ${fault}`);
      const { open, unread } = openDependencies(context, found.body);
      if (open.length > 0 || unread > 0) {
        throw new Refused(`#${key} ${dependencyReason(open, unread)}`);
      }
    }
    let declared = null;
    let why = 'no ## Touches';
    if (values.areas !== undefined) {
      declared = areaList(values.areas, vocabulary);
    } else if (found !== null) {
      const parsed = declaredAreas(found.body, vocabulary);
      if (parsed.every) why = parsed.why;
      else declared = parsed.areas;
    }
    // Worked out before the mutex, since it asks git; a task that starts
    // meanwhile has no branch of its own yet and counts by what it declared.
    const before = inFlightAreas(context, readState(directory));
    return withState(directory, (state, settings) => {
      if (state.tasks[key]) {
        throw new Refused(
          `${label(key)} is in the queue already: resume it through the queue (adopt), not by starting it again`,
        );
      }
      const inFlight = new Map();
      for (const [other, task] of Object.entries(state.tasks)) {
        inFlight.set(other, before.has(other) ? before.get(other) : task.declared);
      }
      const notes = [];
      const clash = conflict(
        declared === null ? { every: true, why } : { every: false, areas: declared },
        inFlight,
        vocabulary,
      );
      if (!day) {
        if (slotsInUse(state) >= settings.slots) {
          throw new Refused(`no slot is free: ${slotsInUse(state)} of ${settings.slots} in use`);
        }
        if (clash) throw new Refused(`${label(key)} ${clash}`);
      } else {
        if (slotsInUse(state) >= settings.slots)
          notes.push(
            `over the slot limit: ${slotsInUse(state) + 1} of ${settings.slots}, a day task is never refused`,
          );
        if (clash)
          notes.push(`note: ${label(key)} ${clash}; merges are one at a time under the lock`);
      }
      const stamp = now().toISOString();
      state.tasks[key] = {
        key,
        origin: day ? 'day' : 'fire',
        session,
        branch,
        worktree,
        worktrees: [worktree],
        base: values.base ?? null,
        declared,
        state: 'working',
        next: 'step 2: branch and worktree',
        reason: null,
        pr: null,
        verified: { tester: null, reviewer: null, main: null },
        rounds: 0,
        decisions: [],
        token: null,
        waitingSince: null,
        polledAt: null,
        pollMs: null,
        startedAt: stamp,
        updatedAt: stamp,
        adoptions: [],
      };
      const areas = declared === null ? `every area (${why})` : declared.join(', ');
      return {
        write: true,
        text: [
          `started ${label(key)}, holding a slot (${slotsInUse(state)} of ${settings.slots}); areas: ${areas}`,
          ...notes,
        ].join('\n'),
      };
    });
  },

  update(argv, context) {
    const { positional, values } = parseArguments(argv, {
      flags: ['round', 'detach', 'clear-reason'],
      options: [
        'session',
        'state',
        'next',
        'reason',
        'pr',
        'tester',
        'reviewer',
        'verified-main',
        'worktree',
      ],
    });
    const key = keyArgument(positional[0]);
    const session = sessionArgument(values);
    if (values.state !== undefined && !SETTABLE_STATES.includes(values.state)) {
      throw new Usage(
        `--state is one of ${SETTABLE_STATES.join(', ')}; the lock commands set delivering`,
      );
    }
    for (const name of ['tester', 'reviewer', 'verified-main']) {
      if (values[name] !== undefined && !SHA.test(values[name]))
        throw new Usage(`--${name} is a commit SHA`);
    }
    if (values.pr !== undefined && !/^[1-9]\d{0,8}$/.test(values.pr))
      throw new Usage('--pr is a pull request number');
    if (values.worktree !== undefined && !isWorktreePath(values.worktree)) {
      throw new Usage('--worktree is an absolute path on one line, at most 4096 characters');
    }
    // Asked of git before the mutex, which is held for one read and one write.
    const directories = projectsOf(context);
    return withState(context.directory, (state, settings) => {
      const task = ownTask(state, key, session);
      if (values.state !== undefined) {
        if (task.state === 'delivering') {
          throw new Refused(
            `${label(key)} holds the lock: unlock or finish it with its token instead`,
          );
        }
        if (values.state === 'awaiting-lock' && task.state !== 'awaiting-lock')
          task.waitingSince = now().toISOString();
        if (values.state !== 'awaiting-lock') task.waitingSince = null;
        task.state = values.state;
      }
      if (values.next !== undefined) task.next = oneLine(values.next) || null;
      if (values.reason !== undefined) task.reason = oneLine(values.reason) || null;
      if (values['clear-reason']) task.reason = null;
      if (values.pr !== undefined) task.pr = Number(values.pr);
      if (values.tester !== undefined) task.verified.tester = values.tester;
      if (values.reviewer !== undefined) task.verified.reviewer = values.reviewer;
      if (values['verified-main'] !== undefined) task.verified.main = values['verified-main'];
      if (values.round) task.rounds += 1;
      if (values.worktree !== undefined && !task.worktrees.includes(values.worktree)) {
        task.worktrees.push(values.worktree);
      }
      if (values.detach) task.session = null;
      touch(task);
      return { write: true, text: showTask(task, state, settings, directories) };
    });
  },

  adopt(argv, context) {
    const { positional, values } = parseArguments(argv, { options: ['session'] });
    const key = keyArgument(positional[0]);
    const session = sessionArgument(values);
    requireTranscript(context, session);
    const directories = projectsOf(context);
    return withState(context.directory, (state, settings) => {
      const task = taskOf(state, key);
      const holding = state.lock?.key === key;
      let verdict;
      if (task.session === session) {
        verdict = 'its own session';
      } else if (task.session === null) {
        verdict = 'its session detached';
      } else if (task.origin === 'day') {
        // The owner's task is the owner's until the owner hands it over.
        throw new Refused(
          `${label(key)} is a day task of the session ${task.session}: it is adopted only once that session detaches it (update ${key} --session <its id> --detach), whatever its last sign of life. Leave it`,
        );
      } else {
        const life = liveness(task, settings.staleMinutes, Date.now(), directories);
        if (life.alive) {
          throw new Refused(
            `${label(key)}'s session ${task.session} is alive: its last sign was ${life.minutes} min ago, within the ${settings.staleMinutes} min threshold. Leave it`,
          );
        }
        verdict = `its session ${task.session} showed no sign of life for ${life.minutes} min, past the ${settings.staleMinutes} min threshold`;
      }
      if (task.session !== session) {
        task.adoptions.push({ from: task.session, to: session, at: now().toISOString(), verdict });
        if (task.adoptions.length > 20) task.adoptions.shift();
        task.session = session;
      }
      const token = holding ? setLock(state, key) : null;
      touch(task);
      const lines = [`adopted ${label(key)}: ${verdict}`, showTask(task, state, settings, directories)];
      if (token) {
        lines.push(
          'It holds the lock, under a new token; the old one is refused from now on.',
          `token ${token}`,
        );
      }
      return { write: true, text: lines.join('\n') };
    });
  },

  lock(argv, context) {
    const { positional, values } = parseArguments(argv, { options: ['session', 'wait'] });
    const key = keyArgument(positional[0]);
    const session = sessionArgument(values);
    let waitMs = 0;
    if (values.wait !== undefined) {
      const minutes = Number(values.wait);
      if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(values.wait) || minutes > MAX_WAIT_MINUTES) {
        throw new Usage(
          `--wait is 0–${MAX_WAIT_MINUTES} minutes: one wait fits in one Bash call in the background, which runs 30 minutes`,
        );
      }
      waitMs = Math.round(minutes * 60_000);
    }
    const pollMs = Math.min(15_000, Math.max(200, Math.round(waitMs / 20)));
    const deadline = Date.now() + waitMs;
    for (;;) {
      const result = withState(context.directory, (state) => {
        const task = ownTask(state, key, session);
        if (state.lock?.key === key) {
          throw new Refused(
            `${label(key)} holds the lock already: use the token it was given, or adopt it to be given a new one`,
          );
        }
        // A paused task is put back to work first: `adopt` leaves it paused,
        // and the refusal names the command that does it.
        if (task.state === 'paused') {
          throw new Refused(
            `${label(key)} is paused: put it back to work first with update ${key} --session ${session} --state working --clear-reason, then take the lock`,
          );
        }
        if (!['working', 'awaiting-lock'].includes(task.state)) {
          throw new Refused(
            `${label(key)} is ${task.state}: only a working or awaiting task takes the lock`,
          );
        }
        const stamp = now();
        if (task.state !== 'awaiting-lock') {
          task.state = 'awaiting-lock';
          task.next = 'step 9: take the lock';
          task.waitingSince = stamp.toISOString();
        }
        if (state.paused) {
          // No task takes the lock until the owner's word unpauses the queue,
          // so a wait would only hold a fire for its whole bound: the task
          // stays awaiting the lock, polling no more, and the call ends now.
          task.polledAt = null;
          task.pollMs = null;
          touch(task);
          return { write: true, paused: state.paused.reason };
        }
        const live = (other) =>
          other.polledAt !== null &&
          stamp - new Date(other.polledAt) < 3 * (other.pollMs ?? 15_000) + 1000;
        const ahead = Object.values(state.tasks).find(
          (other) =>
            other.key !== key &&
            other.state === 'awaiting-lock' &&
            other.waitingSince !== null &&
            (other.waitingSince < task.waitingSince ||
              (other.waitingSince === task.waitingSince && other.key < key)) &&
            live(other),
        );
        const blocker = state.lock
          ? `the lock is held by ${label(state.lock.key)} since ${time(state.lock.since)}`
          : ahead
            ? `${label(ahead.key)} has waited longer and is still waiting`
            : null;
        task.polledAt = stamp.toISOString();
        task.pollMs = pollMs;
        touch(task);
        if (blocker !== null) return { write: true, blocker };
        const token = setLock(state, key);
        task.state = 'delivering';
        task.next = 'step 9: integrate and number, under the lock';
        task.waitingSince = null;
        task.polledAt = null;
        task.pollMs = null;
        return { write: true, token };
      });
      if (result.paused !== undefined) {
        throw new Refused(
          `the queue is paused: ${result.paused}; it takes the lock once the owner's word unpauses it`,
        );
      }
      if (result.token) {
        return {
          text: `${label(key)} holds the delivery lock. Check it before merging, before tagging and after every wait.\ntoken ${result.token}`,
        };
      }
      if (Date.now() + pollMs > deadline) {
        throw new Refused(`${result.blocker}; ${label(key)} stays awaiting the lock`);
      }
      sleep(pollMs);
    }
  },

  check(argv, context) {
    const { positional } = parseArguments(argv, {});
    const key = keyArgument(positional[0]);
    const token = positional[1] ?? '';
    const state = readState(context.directory);
    if (state.lock?.key === key && state.lock.token === token) {
      return { text: `${label(key)} holds the lock under this token: go on` };
    }
    throw new Refused(
      `stale token: ${label(key)} does not hold the lock under it${state.lock ? ` (held by ${label(state.lock.key)})` : ' (the lock is free)'}. Stop acting, read the actual state — the PR, main's workflow run, the tag — and queue again`,
    );
  },

  unlock(argv, context) {
    const { positional, values } = parseArguments(argv, { options: ['next'] });
    const key = keyArgument(positional[0]);
    const token = positional[1] ?? '';
    const next = oneLine(values.next ?? '');
    if (next === '') {
      throw new Usage(
        'unlock <task> <token> --next "<the step the task goes back to, and why>": a task that gives the lock back returns to its work, and its next step says where',
      );
    }
    return withState(context.directory, (state, settings) => {
      if (state.lock?.key !== key || state.lock.token !== token) {
        throw new Refused(
          `stale token: ${label(key)} does not hold the lock under it; nothing was released`,
        );
      }
      const task = taskOf(state, key);
      setLock(state, null);
      task.state = 'working';
      task.next = next;
      touch(task);
      return {
        write: true,
        text: `${label(key)} released the lock and is working again, holding a slot (${slotsInUse(state)} of ${settings.slots})`,
      };
    });
  },

  merge(argv, context) {
    const { positional, values } = parseArguments(argv, { options: ['token', 'sha'] });
    const key = keyArgument(positional[0]);
    if (positional.length > 1) throw new Usage(`merge <task> --token <token> --sha <sha>`);
    const token = values.token ?? '';
    if (!TOKEN.test(token)) throw new Usage('--token <the token lock printed> is required');
    const sha = values.sha ?? '';
    if (!FULL_SHA.test(sha)) {
      throw new Usage('--sha <the checked source SHA, all 40 characters> is required');
    }
    const repo = repository(context);
    // The token is checked holding the mutex; gh runs after it is let go,
    // since a merge can take longer than anyone may hold the mutex. The step
    // recorded first says a merge was asked for, so a session that adopts the
    // task reads the pull request before acting.
    const asked = withState(context.directory, (state) => {
      if (state.lock?.key !== key || state.lock.token !== token) {
        throw new Refused(
          `stale token: ${label(key)} does not hold the lock under it${state.lock ? ` (held by ${label(state.lock.key)})` : ' (the lock is free)'}; nothing was merged. Stop acting, read the actual state — the PR, main's workflow run, the tag — and queue again`,
        );
      }
      if (state.paused) {
        throw new Refused(
          `the queue is paused: ${state.paused.reason}; nothing is merged until the owner's word unpauses it`,
        );
      }
      const task = taskOf(state, key);
      if (task.pr === null || task.pr === undefined) {
        throw new Refused(
          `${label(key)} has no pull request recorded: record it with update ${key} --session <id> --pr <n>`,
        );
      }
      task.next = `step 9: the merge of #${task.pr} at ${sha.slice(0, 12)} was asked of GitHub at ${time(now().toISOString())}: read the PR before acting`;
      touch(task);
      return { write: true, pr: task.pr };
    });
    const args = [
      'pr',
      'merge',
      String(asked.pr),
      '--repo',
      repo,
      '--merge',
      '--match-head-commit',
      sha,
    ];
    const result = spawnSync('gh', args, {
      cwd: context.cwd,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const said = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 8000);
    const command = `gh ${args.join(' ')}`;
    if (result.status !== 0) {
      const why = result.error
        ? (result.error.code ?? result.error.message)
        : `exit ${result.status}`;
      throw new Fault(
        `${command} failed (${why}); read the PR before acting again`,
        said === '' ? '' : `${said}\n`,
      );
    }
    let recorded = '';
    try {
      withState(context.directory, (state) => {
        const task = state.tasks[key];
        if (!task || state.lock?.token !== token) return {};
        task.next = `step 9: #${asked.pr} merged at ${sha.slice(0, 12)}: follow the run, verify, tag`;
        touch(task);
        return { write: true };
      });
    } catch (error) {
      recorded = `\nThe queue could not record the merge (${oneLine(error.message, 160)}): record the next step with update.`;
    }
    return {
      text: `${command}: exit 0\n${said}\n${label(key)}: #${asked.pr} merged at ${sha}. Follow the main workflow's run for the merge commit, verify, tag (step 9).${recorded}`,
    };
  },

  finish(argv, context) {
    const { positional, values } = parseArguments(argv, {
      options: ['session', 'token', 'reason'],
    });
    const key = keyArgument(positional[0]);
    const outcome = positional[1];
    if (!OUTCOMES.includes(outcome))
      throw new Usage(`the outcome is one of ${OUTCOMES.join(', ')}`);
    const session = sessionArgument(values);
    return withState(context.directory, (state) => {
      const task = ownTask(state, key, session);
      const holding = state.lock?.key === key;
      if (holding && state.lock.token !== values.token) {
        throw new Refused(
          `${label(key)} holds the lock: finishing it needs its current token (--token)`,
        );
      }
      if (holding) setLock(state, null);
      delete state.tasks[key];
      state.ended.push({
        key,
        outcome,
        pr: task.pr,
        at: now().toISOString(),
        reason: values.reason === undefined ? null : oneLine(values.reason),
        worktrees: task.worktrees,
      });
      if (state.ended.length > ENDED_KEPT) state.ended.splice(0, state.ended.length - ENDED_KEPT);
      return {
        write: true,
        text: `${label(key)} left the queue: ${outcome}${holding ? '; the lock is released' : ''}${state.paused ? '; the queue stays paused' : ''}. Its worktrees: ${task.worktrees.join(', ')}`,
      };
    });
  },

  reserve(argv, context) {
    const { positional, values } = parseArguments(argv, { options: ['session'] });
    const key = keyArgument(positional[0]);
    const session = sessionArgument(values);
    const count = positional[1] === undefined ? 1 : Number(positional[1]);
    if (!Number.isInteger(count) || count < 1 || count > 5)
      throw new Usage('reserve <task> [1–5] --session <label>');
    const main = mainRef(context);
    const text = git(context.cwd, 'show', `${main}:${DECISIONS}`);
    const highest = text === null ? null : highestDecision(text);
    return withState(context.directory, (state) => {
      const task = ownTask(state, key, session);
      if (highest === null && state.nextDecision === null) {
        throw new Fault(
          `the highest decision id cannot be read from ${main}:${DECISIONS}, and the counter is not started`,
        );
      }
      const first = Math.max(state.nextDecision ?? 0, highest === null ? 0 : highest + 1);
      const ids = Array.from({ length: count }, (_, at) => first + at);
      state.nextDecision = first + count;
      task.decisions.push(...ids);
      touch(task);
      return {
        write: true,
        text: `reserved for ${label(key)}: ${ids.map((id) => `D${id}`).join(', ')}`,
      };
    });
  },

  pause(argv, context) {
    const { values } = parseArguments(argv, { options: ['reason'] });
    const reason = oneLine(values.reason ?? '');
    if (reason === '') throw new Usage('pause --reason <why the queue stops>');
    return withState(context.directory, (state) => {
      state.paused = { reason, since: now().toISOString() };
      return {
        write: true,
        text: `the queue is paused: no task takes the lock until it is unpaused on the owner's word`,
      };
    });
  },

  unpause(argv, context) {
    parseArguments(argv, {});
    return withState(context.directory, (state) => {
      const was = state.paused;
      state.paused = null;
      return {
        write: was !== null,
        text: was ? 'the queue runs again' : 'the queue was not paused',
      };
    });
  },
};

export const USAGE = `usage: node ${SCRIPT} <command> …
  status [--json] | show <task> | pick [--json] | areas <branch> | areas --files <path>…
  start <task> --session <id> --branch <branch> --worktree <path> [--base <sha>] [--areas <a,b>] [--day]
  update <task> --session <id> [--state working|awaiting-lock|paused] [--next <text>] [--reason <text>] [--clear-reason]
         [--pr <n>] [--tester <sha>] [--reviewer <sha>] [--verified-main <sha>] [--round] [--worktree <path>] [--detach]
  adopt <task> --session <id>
  lock <task> --session <id> [--wait <0–${MAX_WAIT_MINUTES} minutes>] | check <task> <token> | unlock <task> <token> --next <text>
  merge <task> --token <token> --sha <sha>
  finish <task> delivered|blocked|recovered|stopped --session <id> [--token <token>] [--reason <text>]
  reserve <task> [count] --session <id> | pause --reason <text> | unpause
  set slots <n> | set stale-minutes <n>
<id> is the CLI session id: the name of the directory that holds the session's scratchpad,
     or $CLAUDE_CODE_SESSION_ID in a headless run whose system prompt names none.`;

export function main(argv, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  try {
    if (!Object.hasOwn(COMMANDS, command ?? '')) throw new Usage(USAGE);
    const context = { cwd, directory: stateDirectory(cwd), vocabulary: readVocabulary() };
    const result = COMMANDS[command](rest, context);
    return { status: 0, out: `${result.text}\n`, err: '' };
  } catch (error) {
    if (error instanceof Refused) {
      return { status: 3, out: error.out, err: `refused: ${error.message}\n` };
    }
    if (error instanceof Usage) return { status: 2, out: '', err: `${error.message}\n` };
    if (error instanceof Fault)
      return { status: 1, out: error.out, err: `fault: ${error.message} [${DECISION}]\n` };
    return {
      status: 1,
      out: '',
      err: `fault: an error of its own (${error?.name ?? 'unknown'}: ${oneLine(error?.message ?? '', 160)}) [${DECISION}]\n`,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status, out, err } = main(process.argv.slice(2));
  process.stdout.write(out);
  process.stderr.write(err);
  process.exitCode = status;
}
