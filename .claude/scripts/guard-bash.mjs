// The Bash guard: a PreToolUse hook that refuses the few commands that must
// never run, in every session of this project and inside its sub-agents (D9).
// `.claude/settings.json` runs it before each Bash call with the call as JSON
// on stdin: `cwd`, `tool_input.command` and, inside a sub-agent, `agent_id` and
// `agent_type`; a main session started with `claude --agent <name>` carries
// `agent_type` alone.
//
// Exit 2 refuses the call, and the one line on stderr is what the model reads:
// the rule and what to do instead. Exit 0 lets the call go on to the permission
// system, which decides as it did before; the guard grants nothing.
//
// The main branch is `project.mainBranch` in `.claude/flow.json`, read through
// `flow-config.mjs` beside this file (D23), and `main` when that cannot be
// read; `main` below stands for it.
//
// Refused everywhere: `git commit` where the target directory's branch is
// `main`; `git commit` where a `node_modules` of the target worktree (its root,
// `apps/*`, `packages/*`) is a symlink; a `kill` whose PID comes from an
// `lsof`'s output — through a pipe, a command substitution, or a variable or a
// file filled from it; `pkill`; `killall`; and every command that merges a
// pull request itself (D16): `gh pr merge`, with any flags, a `gh pr` whose
// subcommand a variable or a substitution gives, `gh api` on a pull request's
// `merge` path, `…/pulls/<n>/merge` with any method — read as GitHub routes
// it, without its query or fragment, percent-escapes decoded, `//`, `.` and
// `..` folded, a `.json` suffix allowed, and a segment a parameter expansion
// gives — `$M`, `${M}ge`, `$1` — or a bracket expression may make one of
// those segments — `merg[e]` — taken for any one segment — or whose endpoint a
// substitution, arithmetic, a `${…}` that does more than name a variable, a
// `*` or `?` glob (zsh's `**` among them), a gh placeholder (`{owner}`,
// `{repo}`, `{branch}`, and the older `:owner`, `:repo`, `:branch`, which gh
// fills in from the repository) or a value next to a percent-escape (`%${P}`,
// `${P}2F`) gives; or carrying the GraphQL `mergePullRequest` or
// `enablePullRequestAutoMerge`, or a `query` field, or a field whose key, a
// variable or a substitution gives; a `gh pr` command with an auto-merge
// option (`--auto`, `--auto-merge`; `gh pr create` and `gh pr edit` have none
// today, and the rule holds for one they may gain), and a word of
// `gh pr create` that a variable or a substitution gives unless it is the
// value of one of its value options or follows a written-out `--name=`.
// A provable GET merges nothing: a `gh api` whose last `-X`/`--method` is a
// written-out `GET`, or that has none and no body option, and that has no
// option but `--paginate`, `--slurp`, `-i`/`--include`, `--silent`, `--cache`,
// `--hostname`, `-H`/`--header`, `-q`/`--jq` and `-t`/`--template`, each
// written out, reads an expansion, a placeholder and a glob — as the text gh
// gets when it matches no file — in its endpoint as an id, and is refused only
// for a merge's path written out or an endpoint a substitution gives. The
// values of `gh api`'s body, header and output options (`-f`, `-F`, `-H`,
// `-q`, `-t`, `--input`), written apart or joined (`-fa=1`, `-Hx`), are no
// endpoint, so a comment that quotes a merge path passes. Merges go through
// the delivery queue, `node .claude/scripts/delivery-queue.mjs merge …`, which
// checks the delivery lock's current token and runs the merge itself, where no
// Bash call is made.
//
// Refused in this project's repository, whose main branch a private
// repository on GitHub Free does not protect (D26): a `git push` — `git -C
// <dir> push` and a push after `cd <dir>` among them — whose refspec targets
// `main`: `main`, `heads/main`, `refs/heads/main`, `HEAD:main`, `<x>:main`,
// `:main`, the matching refspec `:`, or a pattern or a glob that could be one
// of those (`'refs/heads/*'`, `mai[n]`); one that forces: `-f`, `--force`,
// `--force-with-lease`, `--force-if-includes`, a start of one of those that
// git takes for it (`--force-w`), or a refspec with a `+`; `--mirror`, `--all`
// and `--branches`, which push `main` with the rest; and `-d`/`--delete` of
// `main`. A refspec `HEAD` or `@`, and a push with no refspec, push the
// current branch: they are refused where the target directory's branch is
// `main`, and pass where it is another branch or cannot be told. A push whose
// directory the guard cannot know — after a `cd` to a variable, through
// `--git-dir` — is held to the written-out forms all the same, since a push,
// unlike a commit, reaches the remote at once. A task branch pushed by its
// name or as `HEAD` from its worktree, and a tag as `refs/tags/<name>`, pass.
//
// Refused inside the `developer`, `tester` and `tester-process` sub-agents, by
// `agent_type`: any `lsof` (D21 adds `tester-process`, which carries
// `tester`'s body). The two commit rules and the push rule hold in this
// project's repository and its worktrees, not in a throwaway repository a
// session builds elsewhere.
// Refused inside any sub-agent, told by the `agent_id` that only a sub-agent's
// input carries (and an agent team's teammate's), since the outside review is
// the main session's (D12): its script, `outside-review.sh`, by its name in
// any letter case — `ſ` read as `s`, as macOS's file system reads it — run by
// its path, given to `sh`, `bash`, `zsh`, `dash` or `ksh` after their options,
// the ones that take a value included, sourced with `.` or `source`, or fed to
// a shell on its standard input; its helper, `outside-review.mjs`, run or
// loaded by `node`; and `codex` itself, with any subcommand, at any path. A
// name after a directory that a variable or a substitution gives counts by the
// part written out after it (`"$ROOT"/.claude/scripts/outside-review.sh`). A
// shell's `-c` string is the indirection class's, and a shell's `-n`, which
// reads without running, `node --check`, `command -v codex` and `which codex`
// pass.
//
// A command is judged by the leading words of each of its segments and never by
// a substring, so a commit message, a `grep` pattern or a here-document that
// names `pkill` passes. Words are read as the shell gives them to the command:
// quotes taken off, `$'…'` escapes decoded, `$"…"` read as `"…"`. Where bash
// and zsh decode `$'…'` differently — an escape one of them does not know, a
// NUL, which ends the argument — a command holding one is read both ways and
// refused when either reading breaks a rule. The substitutions inside `${…}`
// and inside arithmetic are read as commands, since they run; `((…))` and
// `$((…))` are arithmetic only where the shells read them so — the `)` that
// closes the second parenthesis followed at once by another, the parentheses
// counted as zsh counts them, without regard to quotes — and two subshells
// otherwise, as in `((gh pr merge 5) )` and `((gh pr merge 5 ')' ))`,
// which zsh runs. A command name is matched in any letter case, as a file
// system that ignores it — macOS's — runs `GH`, `ENV`, `PKILL`, `LSOF`,
// `KILL` and `GIT`. A glob no quote protects in a command's name — `g[h]`,
// `/usr/bin/pk?ll`, and zsh's group in the middle of a name, `g(h)`, read as
// `*` — stands for every name a rule looks for that it could match, in any
// case, the wrappers and `xargs` among them, and each rule reads it as each of
// them; so does a glob in gh's group word, in its `pr` subcommand, in git's
// subcommand and in a refspec. A glob is matched against those fixed names
// and never refused as such: `[ … ]`, `[[`, a `[` never closed and
// `./scripts/*.sh` match none of them. Anything the guard cannot read to the
// end — input that is not JSON, a quote never closed — passes with exit 0, as
// does an error of its own: a guard that refuses wrongly stalls an unattended
// run, and one that lets a command through leaves the rules where they were,
// in prose. The merge rule is the exception: a command it cannot read to the
// end that names `gh`, or holds a word that as a glob could be `gh`, together
// with a merge — `merge` anywhere in it, in any letter case, or a word that
// as a glob could be `merge` — is refused, since a merge in it cannot be told
// apart; and so is the outside review rule inside a sub-agent, for a command
// it cannot read that names `outside-review` or `codex`.
//
// It is a habit breaker, not a security boundary. What it does not look into
// is the indirection class: `sh -c '…'`, `bash -c`, `eval`, a here-document
// fed to a shell, a function or an alias, a variable holding a command name or
// several segments of an API path (`pulls/$rest`, `$rest` holding `5/merge`)
// — or a whole percent-escape, `%2F`, alone or with the value beside it — a
// brace expansion or one of zsh's `EXTENDED_GLOB` operators that builds a
// command name or a path (`pk{i,}ll`), a script file, a gh alias or
// extension, a request body or a GraphQL query read from a file or standard
// input (`-F query=@file`, `--input`), another HTTP client; and the wrappers
// of the same kind that take a command as a string or run it on their own
// terms — `env -S`, `stdbuf`, `script`, `find -exec`, `npx`, `xargs sh -c`. A
// function body written on the line of `f()` is not read either; a body on
// lines of its own is read like any other command. Nor does it look into
// what the shell turns into several words — an unquoted expansion that bash
// splits, a glob that matches several files — options among them, in a
// provable GET too: `M='merge -XPUT'; gh api …/pulls/5/$M` runs a PUT in
// bash; a glob in an option's value; a placeholder in a field's value; the
// letter case of the helpers the sweep rule follows (`tee`, `echo`, `printf`,
// `read`, `mapfile`); the merge queue's GraphQL `enqueuePullRequest`; and the
// REST routes that move a branch without a pull request,
// `repos/{owner}/{repo}/merges` and `repos/{owner}/{repo}/git/refs/heads/…`.
// Of a push, it does not look into a refspec or an option that a variable or
// a substitution gives — in whole, or in its destination (`git push origin
// "$BRANCH"`, `HEAD:refs/heads/$B`) — which it reads as a task branch's; push
// settings from `-c`, `git config` or the environment (`push.default`,
// `remote.<name>.push`, `remote.<name>.mirror`); an upstream that is `main`
// under `push.default=upstream`; or a clone of the repository made outside
// it. Of the outside review and Codex, it does not catch a name built when
// the command runs — a variable, a brace expansion, a glob in the name
// itself — a renamed copy or a link, `npx codex`, `cat … | sh`, a
// here-document fed to a shell, or Codex reached outside Bash. The rules stay
// rules for what it does not catch (D9, D12, D16, D26).

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const GUARD = '.claude/scripts/guard-bash.mjs';
const DECISION = 'D9';
// The merge rule's decision and the queue's script (D16).
const QUEUE_DECISION = 'D16';
const QUEUE = '.claude/scripts/delivery-queue.mjs';

// The roles whose definitions forbid `lsof` outright, told by `agent_type`. The
// outside review rule goes by `agent_id` instead, which a main session started
// with `claude --agent` does not carry (D12).
const NO_LSOF_AGENTS = new Set(['developer', 'tester', 'tester-process']);
// The outside review's decision.
const OUTSIDE_DECISION = 'D12';
// The push rule's decision.
const PUSH_DECISION = 'D26';

// The main branch: `project.mainBranch` of `.claude/flow.json`, read through
// `flow-config.mjs` beside this file before the command is judged
// (`readMainBranch`), and `main` when it cannot be read. `mainNames` are the
// names a refspec's destination may give it, in lower case.
let MAIN = 'main';
let MAIN_NAMES = null;
const mainBranch = () => MAIN;
const mainNames = () =>
  (MAIN_NAMES ??= [MAIN, `heads/${MAIN}`, `refs/heads/${MAIN}`].map((name) => name.toLowerCase()));

// A name git would refuse for a branch, or one that would break the
// refusal's one line, is not taken.
const BRANCH_NAME = /^[^\s~^:?*[\\`\x00-\x1f\x7f]{1,255}$/;
async function readMainBranch() {
  try {
    const { loadFlow } = await import('./flow-config.mjs');
    const name = loadFlow(undefined, { requireRepo: false }).project.mainBranch;
    if (typeof name === 'string' && BRANCH_NAME.test(name)) MAIN = name;
  } catch {
    // No configuration, or none that reads, or no `flow-config.mjs` beside
    // a copy of this file: the default.
  }
}

// The guard answers well inside the hook's own timeout in `.claude/settings.json`
// (10 s): it waits for stdin at most 3 s, gives one git call at most 1.5 s, and
// asks git nothing, nor lets a call run, past 7 s from its start, the wait for
// stdin included.
const STDIN_LIMIT_MS = 3000;
const GIT_LIMIT_MS = 1500;
const GIT_DEADLINE_MS = 7000;
const started = Date.now();

// A command that changes directory more often than this, or reaches a path
// longer than any the system accepts, runs its later commits in a directory
// the guard does not know. Without the bounds a chain of `cd a;` grows the
// tracked path with every step and costs the square of its length.
const MAX_DIRECTORY_MOVES = 64;
const MAX_PATH_LENGTH = 4096;

// A command the splitter could not read to its end. It passes.
class Unparsable extends Error {}

// ---------------------------------------------------------------------------
// Splitting a command into segments
// ---------------------------------------------------------------------------

// A frame is one list of commands: the whole command, or the inside of `$(…)`,
// of backticks, of `<(…)` or of a subshell. It holds its finished segments and
// the one being read. `checked` is false only for a parenthesis in the middle
// of a word — an array literal, a glob qualifier — whose words are not
// commands. `dir` is the directory its next segment runs in, null when a `cd`
// named one the guard cannot know. `pattern` is set while the words being read
// are a `case` pattern, and `conditional` inside `[[ … ]]`, where parentheses,
// `|`, `&&` and `<` are not the command line's. `redirect` is the kind of
// redirection whose target the next word is, and `inputs` and `outputs` the
// targets of the segment being read: what it reads on its input, and the
// files its output goes to.
const newFrame = (close, kind, checked, dir) => ({
  close,
  kind,
  checked,
  dir,
  segments: [],
  words: [],
  subs: [],
  word: null,
  redirect: null,
  inputs: [],
  outputs: [],
  before: 'start',
  start: -1,
  atCommand: true,
  conditional: false,
  cases: 0,
  pattern: null,
  yieldsLsof: false,
  inputLsof: false,
  process: false,
});

// Characters that mean nothing special anywhere in a word.
const PLAIN = /[^\s\\'"`$()<>;&|]+/y;
// The name after `$`, and after `${`, `${#` or `${!`.
const VARIABLE = /[A-Za-z_][A-Za-z0-9_]*/y;
const BRACED_VARIABLE = /[#!]?([A-Za-z_][A-Za-z0-9_]*)/y;
const PLAIN_IN_QUOTES = /[^"\\`$]+/y;
// The parameters with a one-character name of their own.
const SPECIAL_PARAMETER = /[0-9@*#?$!-]/;
// Characters that mean nothing inside `${…}` or arithmetic.
const PLAIN_IN_DATA = /[^\\'"`$(){}]+/y;
const ENDS_DELIMITER = /[\s;&|()<>]/;
const DESCRIPTOR = /^\d+$/;
// How much text the guard reads again, in all, after arithmetic it read as
// such turned out to be subshells: a million characters and four times the
// command's length. Past it the guard stops reading, so a command built to
// make it go back over the same text again and again — `$(( '))'` nested in
// itself, the quote hiding the parentheses that make it subshells — costs a
// few passes and stays inside the hook's time.
const REREAD_FACTOR = 4;
const REREAD_ALLOWANCE = 1_000_000;
// The one-letter escapes of `$'…'` that bash and zsh both know.
const ANSI_C = {
  a: '\u0007',
  b: '\b',
  e: '\u001b',
  E: '\u001b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};
const OCTAL = /[0-7]/;
const HEX = /[0-9A-Fa-f]/;

// Returns every frame of the command, the outermost first and each one before
// the frames nested in it. One pass over the text, with an explicit stack, so
// the cost is linear in its length and nesting depth costs no call stack.
// `dialect` is the shell whose reading of `$'…'` the words take, `bash` or
// `zsh` (`ansiC` below); everything else the two read alike.
function split(source, cwd, dialect = 'bash') {
  const length = source.length;
  const top = newFrame(null, 'top', true, cwd);
  const frames = [top];
  // A frame; `{ owner }` while inside a double-quoted part of owner's word;
  // or `{ data, owner }` while inside `${…}` or arithmetic in owner's line.
  const stack = [top];
  const heredocs = [];
  let heredocsRead = 0;
  let openBackticks = 0;
  let reread = 0;
  // The `((` found not to open arithmetic, by where the pair begins.
  const notArithmetic = new Set();
  let matches = null;
  let i = 0;

  // A word: its text with the quotes taken off, whether part of it is only
  // known when it runs, the variables it names and the substitutions in it.
  // `unknown` is set when a part of its text is only known when it runs and
  // is not a variable's bare name: a substitution of any kind, arithmetic, a
  // `${…}` that does more than name a variable. `marks` are the parts of its
  // text whose value the guard does not know, in order: `{ at, end, sub }`,
  // where a parameter expansion — `$name`, `${…}`, `$1`, `$_`, `$@` — or
  // arithmetic begins and where the text it stands in for ends (`isMergePath`),
  // and where a substitution stands (`sub`), which adds no text, `group` set
  // for a parenthesis in the middle of a word — an array, one of zsh's glob
  // groups (`globShape`). `globs` are
  // the places in its text of the glob characters no quote protects: `*`, `?`,
  // `[` and `]` (`globOf`).
  const wordOf = (frame) => {
    if (frame.word === null) {
      frame.word = {
        text: '',
        dynamic: false,
        unknown: false,
        tilde: false,
        vars: null,
        subs: null,
        marks: null,
        globs: null,
      };
      if (frame.start < 0) frame.start = i;
    }
    return frame.word;
  };

  // A parameter expansion or arithmetic begins where word's text now ends;
  // its `end` is set once the text it stands in for is read.
  const expansionAt = (word) => {
    const mark = { at: word.text.length, end: word.text.length, sub: false };
    (word.marks ??= []).push(mark);
    return mark;
  };

  // `$` at `i`, followed by none of `(`, `{`, `'` and `"`: `$NAME`, a special
  // parameter — `$1`, `$@`, `$*`, `$#`, `$?`, `$$`, `$!`, `$-`, read whole
  // so that `$?` and `$*` are no glob — or a `$` alone.
  const parameter = (word) => {
    const mark = expansionAt(word);
    word.text += '$';
    i += 1;
    const before = word.text.length;
    variable(word, false);
    if (word.text.length === before && i < length && SPECIAL_PARAMETER.test(source[i])) {
      word.text += source[i];
      i += 1;
    }
    mark.end = word.text.length;
  };

  // `$NAME` or `${NAME…}` at `i`, which is past the `$` or the `${`: the
  // name goes into the word's variables and its text. Returns whether a
  // `${…}` is the bare name, `${NAME}`, which it then reads to its end.
  const variable = (word, braced) => {
    const pattern = braced ? BRACED_VARIABLE : VARIABLE;
    pattern.lastIndex = i;
    const match = pattern.exec(source);
    if (match === null) return false;
    const name = braced ? match[1] : match[0];
    (word.vars ??= []).push(name);
    word.text += braced ? `{${name}}` : name;
    if (!braced) {
      i += name.length;
      return false;
    }
    if (match[0] !== name || source[i + name.length] !== '}') return false;
    i += name.length + 1;
    return true;
  };

  const endWord = (frame) => {
    const word = frame.word;
    if (word === null) return;
    frame.word = null;
    // zsh ends an argument at its first NUL, which `$'\0'` makes.
    if (dialect === 'zsh') {
      const nul = word.text.indexOf('\0');
      if (nul >= 0) {
        word.text = word.text.slice(0, nul);
        // What comes after the NUL is gone with it; an expansion before it
        // stays.
        if (word.marks !== null) {
          word.marks = word.marks
            .filter((mark) => mark.at <= nul)
            .map((mark) => ({ ...mark, end: Math.min(mark.end, nul) }));
        }
        if (word.globs !== null) word.globs = word.globs.filter((at) => at < nul);
      }
    }
    if (frame.redirect !== null) {
      // A redirection's target is not a word of the command.
      if (frame.redirect === 'in' || frame.redirect === 'string') {
        frame.inputs.push({ ...word, string: frame.redirect === 'string' });
      } else if (frame.redirect === 'out') {
        frame.outputs.push(word);
      }
      frame.redirect = null;
      return;
    }
    const text = word.dynamic ? null : word.text;
    if (frame.pattern !== null) {
      // A `case` pattern is not a command; `esac` where a pattern would begin
      // ends the statement.
      if (frame.pattern.started || text !== 'esac') {
        frame.pattern.started = true;
        return;
      }
      frame.pattern = null;
      frame.cases -= 1;
    } else if (text === 'esac' && frame.cases > 0 && frame.words.length === 0) {
      frame.cases -= 1;
    }
    frame.words.push(word);
    if (text === 'in' && frame.words.length === 3 && frame.words[0].text === 'case') {
      frame.cases += 1;
      frame.pattern = { depth: 0, started: false, opened: false };
    } else if (text === '[[' && frame.atCommand) {
      frame.conditional = true;
    } else if (text === ']]' && frame.conditional) {
      frame.conditional = false;
    }
    if (text === null || !KEYWORDS.has(text)) frame.atCommand = false;
  };

  const endSegment = (frame, after) => {
    endWord(frame);
    frame.redirect = null;
    frame.atCommand = true;
    frame.conditional = false;
    const empty = frame.inputs.length === 0 && frame.outputs.length === 0;
    if (frame.words.length === 0 && frame.subs.length === 0 && empty) {
      // A line break after an operator continues the list: `a |⏎ b`.
      if (after !== '\n') frame.before = after;
      return;
    }
    const segment = {
      command: commandOf(frame.words),
      readings: commandsOf(frame.words),
      words: frame.words,
      subs: frame.subs,
      inputs: frame.inputs,
      outputs: frame.outputs,
      before: frame.before,
      after,
      start: frame.start,
      dir: frame.dir,
      stdinLsof: false,
    };
    frame.segments.push(segment);
    frame.dir = directoryAfter(segment, frame.dir);
    frame.words = [];
    frame.subs = [];
    frame.inputs = [];
    frame.outputs = [];
    frame.start = -1;
    frame.before = after;
  };

  const open = (parent, close, kind, checked, process = false) => {
    const frame = newFrame(close, kind, checked, parent.dir);
    frame.process = process;
    if (parent.start < 0) parent.start = i;
    parent.subs.push(frame);
    if (parent.word !== null) {
      (parent.word.subs ??= []).push(frame);
      parent.word.unknown = true;
      const at = parent.word.text.length;
      (parent.word.marks ??= []).push({ at, end: at, sub: true, group: kind === 'group' });
    }
    frames.push(frame);
    stack.push(frame);
    if (close === '`') openBackticks += 1;
  };

  // A redirection's file descriptor (`2>`) is not a word of the command; it is
  // returned, or null when none was written.
  const endWordBeforeRedirection = (frame) => {
    const word = frame.word;
    if (word !== null && !word.dynamic && DESCRIPTOR.test(word.text)) {
      frame.word = null;
      return word.text;
    }
    endWord(frame);
    return null;
  };

  // …and its target, the next word, is kept apart: `kind` is `in` for a
  // file read on standard input, `out` for one standard output is written to,
  // `both` for `&>`, `string` for a here-string, and `other` for the rest.
  const redirection = (frame, kind) => {
    const descriptor = endWordBeforeRedirection(frame);
    let target = kind;
    if (kind === 'both') target = 'out';
    else if (kind === 'out' && descriptor !== null && descriptor !== '1') target = 'other';
    else if (kind === 'in' && descriptor !== null && descriptor !== '0') target = 'other';
    frame.redirect = target;
  };

  const closedQuote = (from) => {
    const end = source.indexOf("'", from);
    if (end < 0) throw new Unparsable('a quote is never closed');
    return end;
  };

  // The quote that ends a `$'…'` or a `"…"` begun before `from`, where a
  // backslash escapes the character after it.
  const closedEscaped = (from, quote) => {
    let at = from;
    while (at < length) {
      const c = source[at];
      if (c === quote) return at;
      at += c === '\\' ? 2 : 1;
    }
    throw new Unparsable('a quote is never closed');
  };

  // The text of `$'…'` from `from` up to `end`, its closing quote, as the
  // dialect's shell makes it. Both shells find the closing quote alike — a
  // backslash takes the character after it with it, so `\'` and `\\` never
  // end the string and an escape never reaches past it — and decode most
  // escapes alike: the one-letter ones, `\nnn` octal, `\xHH`, `\uHHHH`,
  // `\UHHHHHHHH`. They differ in the rest, and a word is read both ways
  // (`brokenRule`). bash keeps an escape it does not know as written, makes
  // `\cX` a control character, and drops what follows a NUL up to the
  // closing quote. zsh drops the backslash of an escape it does not know —
  // `\c` and `\q` among them, so `$'\merge'` is `merge` — makes `\x`, `\u` and
  // `\U` without digits a NUL, reads `\C-` and `\M-` as control and meta for
  // the next character, and keeps a NUL, which ends the argument (`endWord`).
  const ansiC = (from, end) => {
    const zsh = dialect === 'zsh';
    let text = '';
    let at = from;
    let control = false;
    let meta = false;
    // One character made, or null for a NUL in bash, which ends the string.
    const put = (code) => {
      let made = code;
      if (control) made = made === 0x3f ? 0x7f : made & 0x9f;
      if (meta) made |= 0x80;
      control = false;
      meta = false;
      if (made === 0 && !zsh) return false;
      text += made <= 0x10ffff ? String.fromCodePoint(made) : '�';
      return true;
    };
    const digits = (pattern, most) => {
      let run = '';
      while (run.length < most && at < end && pattern.test(source[at])) {
        run += source[at];
        at += 1;
      }
      return run;
    };
    while (at < end) {
      // The next backslash, looked for no further than the closing quote.
      let stop = at;
      while (stop < end && source.charCodeAt(stop) !== 0x5c) stop += 1;
      if (stop > at) {
        // A run of plain characters; a pending control or meta takes the
        // first of them.
        if (control || meta) {
          if (!put(source.codePointAt(at))) return text;
          at += source.codePointAt(at) > 0xffff ? 2 : 1;
          continue;
        }
        text += source.slice(at, stop);
        at = stop;
        continue;
      }
      const e = source[at + 1];
      at += 2;
      let code;
      if (Object.hasOwn(ANSI_C, e)) {
        code = ANSI_C[e].charCodeAt(0);
      } else if (e >= '0' && e <= '7') {
        code = Number.parseInt(e + digits(OCTAL, 2), 8) & 0xff;
      } else if (e === 'x' || e === 'u' || e === 'U') {
        const hex = digits(HEX, e === 'x' ? 2 : e === 'u' ? 4 : 8);
        if (hex === '' && !zsh) {
          text += `\\${e}`;
          continue;
        }
        code = hex === '' ? 0 : Number.parseInt(hex, 16);
      } else if (zsh && (e === 'C' || e === 'M')) {
        if (e === 'C') control = true;
        else meta = true;
        if (at < end && source[at] === '-') at += 1;
        continue;
      } else if (zsh) {
        code = e.codePointAt(0);
      } else if (e === 'c') {
        if (at >= end) {
          text += '\\';
          continue;
        }
        code = source.codePointAt(at) & 0x1f;
        at += 1;
      } else {
        text += `\\${e}`;
        continue;
      }
      if (!put(code)) return text;
    }
    return text;
  };

  // Where the `)` closing the `(` at `at` is, counting every parenthesis in
  // the command and none of its quotes, or -1: one pass, made the first time
  // a `((` is met.
  const closingOf = (at) => {
    if (matches === null) {
      matches = new Int32Array(length).fill(-1);
      const opened = new Int32Array(length);
      let depth = 0;
      for (let k = 0; k < length; k += 1) {
        const c = source.charCodeAt(k);
        if (c === 0x28) {
          opened[depth] = k;
          depth += 1;
        } else if (c === 0x29 && depth > 0) {
          depth -= 1;
          matches[opened[depth]] = k;
        }
      }
    }
    return matches[at];
  };

  // Whether the `((` beginning at `at` is arithmetic, as both shells read it:
  // the `)` that closes its second parenthesis is followed at once by the one
  // that closes its first. Otherwise it is two subshells, `( (…) )`, and
  // `((gh pr merge 5) )` runs gh. The count here takes no quote into
  // account; the reading that follows does, and goes back when it finds the
  // two disagree (`backtrack`).
  const arithmeticAt = (at) => {
    if (notArithmetic.has(at)) return false;
    const close = closingOf(at + 1);
    return close >= 0 && source[close + 1] === ')';
  };

  // A `${…}` (`expansion`) or an arithmetic expansion (`arithmetic`) being
  // read: none of its words is a command, but the substitutions in it run, so
  // they are read as commands of owner's line. `quotes` is whether `'…'` and
  // `$'…'` are quotes in it, which they are not inside double quotes;
  // `double` whether it is inside a `"…"` of its own. An arithmetic one keeps
  // where it began, to read it again as subshells if it is not arithmetic.
  const data = (kind, owner, quotes, from = null) => ({
    data: kind,
    owner,
    quotes,
    double: false,
    depth: kind === 'arithmetic' ? 2 : 1,
    from,
  });

  // What reading an arithmetic expansion may change, so that a wrong guess
  // can be undone: `at` is where reading resumes and `pair` where the `((`
  // begins.
  const snapshot = (at, pair, owner) => ({
    at,
    pair,
    stack: stack.length,
    frames: frames.length,
    heredocs: heredocs.length,
    heredocsRead,
    openBackticks,
    moves: directoryMoves,
    subs: owner.subs.length,
    word: owner.word,
    wordSubs: owner.word?.subs?.length ?? 0,
    wordMarks: owner.word?.marks?.length ?? 0,
    start: owner.start,
  });

  // The `((` read as arithmetic is subshells after all: everything read
  // since it began is dropped, and it is read again as subshells.
  const backtrack = (frame) => {
    const was = frame.from;
    reread += i - was.at;
    if (reread > REREAD_FACTOR * length + REREAD_ALLOWANCE) {
      throw new Unparsable('arithmetic the guard cannot tell from subshells');
    }
    const { owner } = frame;
    stack.length = was.stack;
    frames.length = was.frames;
    heredocs.length = was.heredocs;
    heredocsRead = was.heredocsRead;
    openBackticks = was.openBackticks;
    directoryMoves = was.moves;
    owner.subs.length = was.subs;
    if (was.word !== null && was.word.subs !== null) was.word.subs.length = was.wordSubs;
    if (was.word !== null && was.word.marks !== null) was.word.marks.length = was.wordMarks;
    owner.start = was.start;
    notArithmetic.add(was.pair);
    i = was.at;
  };

  // `$(` at `i`, in owner's line: arithmetic when `$((…))` is, otherwise a
  // command substitution. `quotes` as for `data`.
  const dollarParen = (owner, quotes) => {
    const word = owner.word;
    if (source[i + 2] === '(' && arithmeticAt(i + 1)) {
      const was = snapshot(i, i + 1, owner);
      if (word !== null) {
        word.dynamic = true;
        word.unknown = true;
        expansionAt(word);
      }
      const frame = data('arithmetic', owner, quotes, was);
      i += 3;
      stack.push(frame);
      return;
    }
    i += 2;
    open(owner, ')', 'substitution', true);
  };

  // `${` at `i`, in owner's word: the variable it names, and the rest read
  // as data unless it is the bare name.
  const dollarBrace = (owner, quotes) => {
    const word = owner.word;
    word.dynamic = true;
    const mark = expansionAt(word);
    i += 2;
    const bare = variable(word, true);
    mark.end = word.text.length;
    if (bare) return;
    word.unknown = true;
    stack.push(data('expansion', owner, quotes));
  };

  // Inside `${…}` or arithmetic: quotes, nesting and substitutions are
  // followed; everything else is passed over. A `${…}` ends at the `}` that
  // closes it, an arithmetic expansion at its `))`.
  const inData = (frame) => {
    const c = source[i];
    const next = source[i + 1];
    const quotes = frame.quotes && !frame.double;
    switch (c) {
      case '\\':
        i += 2;
        return;
      case '"':
        frame.double = !frame.double;
        i += 1;
        return;
      case "'":
        i = quotes ? closedQuote(i + 1) + 1 : i + 1;
        return;
      case '`':
        if (openBackticks > 0) throw new Unparsable('backticks are nested');
        i += 1;
        open(frame.owner, '`', 'substitution', true);
        return;
      case '$':
        if (next === '(') dollarParen(frame.owner, quotes);
        else if (next === '{') {
          i += 2;
          stack.push(data('expansion', frame.owner, quotes));
        } else if (next === "'" && quotes) i = closedEscaped(i + 2, "'") + 1;
        else i += 1;
        return;
      case '(':
      case ')':
      case '{':
      case '}':
        i += 1;
        if (frame.double) return;
        if (frame.data === 'expansion') {
          if (c === '{') frame.depth += 1;
          else if (c === '}' && (frame.depth -= 1) === 0) stack.pop();
          return;
        }
        if (c === '(') frame.depth += 1;
        else if (c === ')' && (frame.depth -= 1) === 1) {
          if (source[i] === ')') {
            i += 1;
            stack.pop();
          } else {
            backtrack(frame);
          }
        }
        return;
      default: {
        PLAIN_IN_DATA.lastIndex = i;
        i += PLAIN_IN_DATA.exec(source)[0].length;
      }
    }
  };

  const heredocDelimiter = () => {
    while (source[i] === ' ' || source[i] === '\t') i += 1;
    let text = '';
    let seen = false;
    while (i < length) {
      const c = source[i];
      if (c === "'") {
        const end = closedQuote(i + 1);
        text += source.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i += 1;
        while (i < length && source[i] !== '"') {
          if (source[i] === '\\' && i + 1 < length) i += 1;
          text += source[i];
          i += 1;
        }
        if (i >= length) throw new Unparsable('a quote is never closed');
        i += 1;
      } else if (c === '\\' && i + 1 < length) {
        text += source[i + 1];
        i += 2;
      } else if (ENDS_DELIMITER.test(c)) {
        break;
      } else {
        text += c;
        i += 1;
      }
      seen = true;
    }
    if (!seen) throw new Unparsable('a here-document has no delimiter');
    return text;
  };

  // The bodies of the here-documents opened on the line that just ended. Their
  // text is data — a commit message, a script for another interpreter — and
  // is skipped whole, up to the line that is the delimiter.
  const skipHeredocs = () => {
    while (heredocsRead < heredocs.length) {
      const { delimiter, tabs } = heredocs[heredocsRead];
      heredocsRead += 1;
      while (i < length) {
        let end = source.indexOf('\n', i);
        if (end < 0) end = length;
        let from = i;
        if (tabs) while (from < end && source[from] === '\t') from += 1;
        const last = end - from === delimiter.length && source.startsWith(delimiter, from);
        i = Math.min(end + 1, length);
        if (last) break;
      }
    }
  };

  const inQuotes = ({ owner }) => {
    const word = owner.word;
    const c = source[i];
    if (c === '"') {
      stack.pop();
      i += 1;
    } else if (c === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        i += 1;
      } else {
        if (next !== '\n') word.text += '$`"\\'.includes(next) ? next : c + next;
        i += 2;
      }
    } else if (c === '`') {
      if (openBackticks > 0) throw new Unparsable('backticks are nested');
      word.dynamic = true;
      i += 1;
      open(owner, '`', 'substitution', true);
    } else if (c === '$') {
      word.dynamic = true;
      if (source[i + 1] === '(') {
        dollarParen(owner, false);
      } else if (source[i + 1] === '{') {
        dollarBrace(owner, false);
      } else {
        parameter(word);
      }
    } else {
      PLAIN_IN_QUOTES.lastIndex = i;
      const run = PLAIN_IN_QUOTES.exec(source)[0];
      word.text += run;
      i += run.length;
    }
  };

  // Inside a `case` pattern: `(` opens it or a group, `|` separates
  // alternatives, and the `)` that closes no group ends it. True when the
  // character was one of those.
  const inPattern = (frame, c) => {
    const pattern = frame.pattern;
    if (c === '(') {
      if (pattern.started || pattern.depth > 0 || pattern.opened) pattern.depth += 1;
      else pattern.opened = true;
    } else if (c === '|') {
      endWord(frame);
    } else if (c === ')' && pattern.depth > 0) {
      endWord(frame);
      pattern.depth -= 1;
    } else if (c === ')') {
      endWord(frame);
      frame.pattern = null;
      endSegment(frame, ';');
    } else {
      return false;
    }
    pattern.started = true;
    i += 1;
    return true;
  };

  // Inside `[[ … ]]`: a parenthesis groups a pattern or an expression, and
  // `&&`, `||`, `<` and `>` are its operators. True when the character was
  // one of those.
  const inConditional = (frame, c, next) => {
    const word = frame.word;
    if (word !== null && !word.dynamic && word.text === ']]') {
      // `]]&&`, `]]||`, `]]>`: the test ends at `]]`, and what follows is
      // the command line's.
      endWord(frame);
      return false;
    }
    if (c === '(') {
      wordOf(frame).dynamic = true;
      i += 1;
      open(frame, ')', 'group', false);
    } else if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endWord(frame);
      i += 2;
    } else if (c === '<' || c === '>') {
      endWord(frame);
      i += 1;
    } else {
      return false;
    }
    return true;
  };

  const inCommand = (frame) => {
    const c = source[i];
    const next = source[i + 1];
    if (frame.pattern !== null && inPattern(frame, c)) return;
    if (frame.conditional && inConditional(frame, c, next)) return;
    switch (c) {
      case ' ':
      case '\t':
      case '\r':
        endWord(frame);
        i += 1;
        return;
      case '\n':
        i += 1;
        endSegment(frame, '\n');
        skipHeredocs();
        return;
      case '\\':
        if (next === '\n') {
          i += 2;
        } else if (next === undefined) {
          wordOf(frame).text += c;
          i += 1;
        } else {
          wordOf(frame).text += next;
          i += 2;
        }
        return;
      case "'": {
        const end = closedQuote(i + 1);
        wordOf(frame).text += source.slice(i + 1, end);
        i = end + 1;
        return;
      }
      case '"':
        wordOf(frame);
        i += 1;
        stack.push({ owner: frame });
        return;
      case '`':
        if (frame.close === '`') {
          endSegment(frame, 'end');
          stack.pop();
          openBackticks -= 1;
          i += 1;
          return;
        }
        if (openBackticks > 0) throw new Unparsable('backticks are nested');
        wordOf(frame).dynamic = true;
        i += 1;
        open(frame, '`', 'substitution', true);
        return;
      case '$': {
        const word = wordOf(frame);
        if (next === "'") {
          // $'…': a quote whose escapes are decoded, as the shell decodes
          // them before the command sees the word. Its end is found first,
          // so no escape reaches past it.
          const end = closedEscaped(i + 2, "'");
          word.text += ansiC(i + 2, end);
          i = end + 1;
          return;
        }
        if (next === '"') {
          // $"…": a string for translation, which without a translation is
          // the string itself — read as "…".
          i += 1;
          return;
        }
        word.dynamic = true;
        if (next === '(') {
          dollarParen(frame, true);
        } else if (next === '{') {
          dollarBrace(frame, true);
        } else {
          parameter(word);
        }
        return;
      }
      case '(': {
        if (frame.word !== null) {
          // In the middle of a word — `a=(…)`, `*(.)`, `f()`. Not commands.
          frame.word.dynamic = true;
          i += 1;
          open(frame, ')', 'group', false);
        } else if (next === '(' && arithmeticAt(i)) {
          // `((…))`: an arithmetic command, whose words are no commands.
          const was = snapshot(i, i, frame);
          if (frame.start < 0) frame.start = i;
          i += 2;
          stack.push(data('arithmetic', frame, true, was));
        } else {
          i += 1;
          open(frame, ')', 'subshell', frame.checked);
        }
        return;
      }
      case ')':
        if (frame.close === ')') {
          endSegment(frame, 'end');
          stack.pop();
        } else {
          // The parenthesis that ends a `case` pattern: the words before it
          // were the pattern, not a command, and so were the alternatives a
          // `|` set apart (`stop|halt)`).
          endWord(frame);
          frame.words = [];
          frame.subs = [];
          frame.inputs = [];
          frame.outputs = [];
          frame.start = -1;
          while (frame.before === '|' && frame.segments.length > 0) {
            frame.before = frame.segments.pop().before;
          }
        }
        i += 1;
        return;
      case ';':
        if (frame.cases > 0 && (next === ';' || next === '&')) {
          i += next === ';' && source[i + 2] === '&' ? 3 : 2;
          endSegment(frame, ';');
          frame.pattern = { depth: 0, started: false, opened: false };
          return;
        }
        i += 1;
        endSegment(frame, ';');
        return;
      case '&':
        if (next === '&') {
          i += 2;
          endSegment(frame, '&&');
        } else if (next === '>') {
          i += source[i + 2] === '>' ? 3 : 2;
          redirection(frame, 'both');
        } else {
          i += 1;
          endSegment(frame, '&');
        }
        return;
      case '|':
        if (next === '|') {
          i += 2;
          endSegment(frame, '||');
        } else {
          i += next === '&' ? 2 : 1;
          endSegment(frame, '|');
        }
        return;
      case '<':
        if (next === '(') {
          wordOf(frame).dynamic = true;
          i += 2;
          open(frame, ')', 'substitution', true, true);
        } else if (next === '<' && source[i + 2] === '<') {
          i += 3;
          redirection(frame, 'string');
        } else if (next === '<') {
          endWordBeforeRedirection(frame);
          i += 2;
          const tabs = source[i] === '-';
          if (tabs) i += 1;
          heredocs.push({ delimiter: heredocDelimiter(), tabs });
        } else {
          const other = next === '&' || next === '>';
          i += other ? 2 : 1;
          redirection(frame, other ? 'other' : 'in');
        }
        return;
      case '>':
        if (next === '(') {
          wordOf(frame).dynamic = true;
          i += 2;
          open(frame, ')', 'substitution', true, true);
        } else {
          // `>&2` names a descriptor, not a file.
          i += next === '>' || next === '&' || next === '|' ? 2 : 1;
          redirection(frame, next === '&' ? 'other' : 'out');
        }
        return;
      case '#':
        if (frame.word === null) {
          // A comment runs to the end of its line.
          const end = source.indexOf('\n', i);
          i = end < 0 ? length : end;
        } else {
          frame.word.text += c;
          i += 1;
        }
        return;
      case '~': {
        const first = frame.word === null;
        const word = wordOf(frame);
        if (first) word.tilde = true;
        word.text += c;
        i += 1;
        return;
      }
      default: {
        PLAIN.lastIndex = i;
        const run = PLAIN.exec(source);
        if (run === null) {
          // White space the cases above do not name.
          endWord(frame);
          i += 1;
        } else {
          // No quote protects these characters: each glob character among
          // them is marked where it lands in the word's text.
          const word = wordOf(frame);
          const from = word.text.length;
          const text = run[0];
          for (let k = 0; k < text.length; k += 1) {
            const code = text.charCodeAt(k);
            if (code === 0x2a || code === 0x3f || code === 0x5b || code === 0x5d) {
              (word.globs ??= []).push(from + k);
            }
          }
          word.text += text;
          i += text.length;
        }
      }
    }
  };

  while (i < length) {
    const current = stack[stack.length - 1];
    if (current.data) inData(current);
    else if (current.owner) inQuotes(current);
    else inCommand(current);
  }
  if (stack.length > 1) {
    const open = stack[stack.length - 1].data;
    if (open === 'arithmetic') throw new Unparsable('an arithmetic expansion is never closed');
    if (open === 'expansion') throw new Unparsable('a parameter expansion is never closed');
    throw new Unparsable('a quote or a parenthesis is never closed');
  }
  endSegment(top, 'end');
  return frames;
}

// ---------------------------------------------------------------------------
// Reading a segment's leading words
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
// Commands that run the command named after them, as bash and zsh know them:
// for each, the options that take a value of their own, and how many plain
// words come before the command (`timeout 5 …`, `repeat 3 …`). zsh's `- cmd`
// is the word `-`.
const WRAPPERS = new Map(
  [
    [
      'sudo',
      ['-u', '-g', '-C', '-D', '-h', '-p', '-R', '-T', '-U', '-r', '-t'].concat(
        [
          'user',
          'group',
          'chdir',
          'close-from',
          'prompt',
          'role',
          'type',
          'other-user',
          'host',
        ].map((option) => `--${option}`),
      ),
      0,
    ],
    ['env', ['-u', '-C', '-P', '-S', '--unset', '--chdir', '--split-string'], 0],
    ['exec', ['-a'], 0],
    ['time', ['-o', '-f'], 0],
    ['nice', ['-n', '--adjustment'], 0],
    ['timeout', ['-s', '-k', '--signal', '--kill-after'], 1],
    ['caffeinate', ['-t', '-w'], 0],
    ['arch', ['-arch', '-e', '-d'], 0],
    ['repeat', [], 1],
    ['command', [], 0],
    ['builtin', [], 0],
    ['nohup', [], 0],
    ['noglob', [], 0],
    ['nocorrect', [], 0],
    ['coproc', [], 0],
    ['-', [], 0],
  ].map(([name, withValue, plain]) => [name, { withValue: new Set(withValue), plain }]),
);
const XARGS_WITH_VALUE = new Set(
  ['-I', '-n', '-P', '-L', '-s', '-E', '-J', '-R', '-S', '-d', '-a'].concat(
    ['args', 'lines', 'procs', 'chars'].map((what) => `--max-${what}`),
    ['--delimiter', '--arg-file', '--process-slot-var'],
  ),
);

const isOption = (word) => !word.dynamic && word.text.startsWith('-');

// The words after a command's own options, `withValue` naming the options
// whose value is the next word.
function afterOptions(words, from, withValue) {
  let k = from;
  while (k < words.length && isOption(words[k])) {
    if (words[k].text === '--') return k + 1;
    k += withValue.has(words[k].text) ? 2 : 1;
  }
  return k;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

// A glob no quote protects stands for whatever names it matches, so a word
// with one is read as every fixed name a rule looks for that it could match,
// in any letter case, and never as "any glob character": `[ -n … ]`, `[[`, a
// `[` never closed and `./scripts/*.sh` match none of them. A glob is a list
// of tokens: STAR for `*`, ONE for `?`, a set for a bracket expression, and a
// lower-case character for the rest. A set that is negated or names a class
// (`[[:alpha:]]`) is taken to admit any character; the shells' own reading of
// it is one of those it could match.
const STAR = 0;
const ONE = 1;
const UNIVERSAL = [STAR];

// The places in a word's text that hold a glob character no quote protects,
// as a mask, or null when there are none.
function globMask(word) {
  if (word.globs === null) return null;
  const mask = new Uint8Array(word.text.length);
  for (const at of word.globs) mask[at] = 1;
  return mask;
}

// A word read as a glob, `{ text, mask }`: its text and its glob characters,
// with each of zsh's groups in the middle of it — `g(h)`, which zsh runs as
// `gh` and bash refuses — read as `*`; null when another part of it is
// only known when it runs.
function globShape(word) {
  if (!word.dynamic) return { text: word.text, mask: globMask(word) };
  if (word.marks === null || !word.marks.every((mark) => mark.group)) return null;
  const { marks } = word;
  const globs = word.globs ?? [];
  const mask = new Uint8Array(word.text.length + marks.length);
  let text = '';
  let from = 0;
  let g = 0;
  // A glob character before the next group keeps its place, shifted by the
  // stars put in before it.
  const copy = (to) => {
    for (; g < globs.length && globs[g] < to; g += 1) mask[text.length + globs[g] - from] = 1;
    text += word.text.slice(from, to);
    from = to;
  };
  for (const { at } of marks) {
    copy(at);
    mask[text.length] = 1;
    text += '*';
  }
  copy(word.text.length);
  return { text, mask };
}

// The glob that text[from, to) is, or null when it holds no glob: no
// unprotected `*` or `?`, and no unprotected `[` closed by an unprotected `]`.
// One pass, the closing brackets found from the right first.
function globOf(text, mask, from, to) {
  if (mask === null) return null;
  let any = false;
  for (let k = from; k < to; k += 1) if (mask[k] === 1) any = true;
  if (!any) return null;
  // The first unprotected `]` at or after each place.
  const closing = new Int32Array(to - from + 1).fill(-1);
  for (let k = to - 1; k >= from; k -= 1) {
    closing[k - from] = mask[k] === 1 && text[k] === ']' ? k : closing[k + 1 - from];
  }
  const tokens = [];
  let glob = false;
  for (let k = from; k < to; k += 1) {
    const c = text[k];
    if (mask[k] === 1 && c === '*') {
      if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
      glob = true;
      continue;
    }
    if (mask[k] === 1 && c === '?') {
      tokens.push(ONE);
      glob = true;
      continue;
    }
    if (mask[k] === 1 && c === '[') {
      let s = k + 1;
      const negated = s < to && (text[s] === '!' || text[s] === '^');
      if (negated) s += 1;
      // A `]` first in the set is one of its members.
      const searchFrom = s < to && text[s] === ']' ? s + 1 : s;
      const close = searchFrom < to ? closing[searchFrom - from] : -1;
      if (close >= 0) {
        const members = text.slice(s, close);
        if (/\[[:=.]/.test(members)) return UNIVERSAL;
        const chars = [];
        const ranges = [];
        for (let m = 0; m < members.length; m += 1) {
          if (members[m + 1] === '-' && m + 2 < members.length) {
            ranges.push([members[m], members[m + 2]]);
            m += 2;
          } else {
            chars.push(members[m]);
          }
        }
        tokens.push({ any: negated, chars: chars.join(''), ranges });
        glob = true;
        k = close;
        continue;
      }
    }
    const lower = c.toLowerCase();
    tokens.push(lower.length === 1 ? lower : c);
  }
  return glob ? tokens : null;
}

// Whether a token takes the lower-case character `c`, in either case.
function takes(token, c) {
  if (token === ONE) return true;
  if (typeof token === 'string') return token === c;
  if (token.any) return true;
  const upper = c.toUpperCase();
  if (token.chars.includes(c) || token.chars.includes(upper)) return true;
  return token.ranges.some(
    ([low, high]) => (c >= low && c <= high) || (upper >= low && upper <= high),
  );
}

// Whether the glob could match `name`, a short lower-case name. The places in
// the name reached so far are the bits of one number, so the cost is the
// glob's length times the name's.
function globMatches(tokens, name) {
  const n = name.length;
  const all = 2 ** (n + 1) - 1;
  let reached = 1;
  for (const token of tokens) {
    if (token === STAR) {
      // Every place from the first one reached onwards.
      reached = all & ~((reached & -reached) - 1);
      continue;
    }
    let next = 0;
    for (let p = 0; p < n; p += 1) {
      if ((reached & (1 << p)) !== 0 && takes(token, name[p])) next |= 1 << (p + 1);
    }
    if (next === 0) return false;
    reached = next;
  }
  return (reached & (1 << n)) !== 0;
}

// The names among `names` a word could be: its own text in lower case when it
// holds no glob, and each one its glob could match otherwise.
function couldBe(word, names) {
  const shape = globShape(word);
  if (shape === null) return [];
  const glob = globOf(shape.text, shape.mask, 0, shape.text.length);
  if (glob === null) return names.filter((name) => name === word.text.toLowerCase());
  return names.filter((name) => globMatches(glob, name));
}

// The command a list of words runs: its name without a directory, and its
// arguments. Assignments, shell keywords and wrappers in front of it are
// passed over; null when the name is not written out — a variable, a
// substitution — or when the words only look a command up (`command -v`).
function commandAt(words, from) {
  let k = from;
  for (;;) {
    while (k < words.length && ASSIGNMENT.test(words[k].text)) k += 1;
    if (k >= words.length) return null;
    const word = words[k];
    if (word.dynamic) return null;
    if (KEYWORDS.has(word.text)) {
      k += 1;
      continue;
    }
    // zsh's `=cmd` is the path of `cmd`.
    const text = word.text.length > 1 && word.text.startsWith('=') ? word.text.slice(1) : word.text;
    const name = text.slice(text.lastIndexOf('/') + 1);
    // On a file system that ignores case, as macOS's does, `ENV` runs `env`
    // and `GH` runs `gh`: the wrappers and the merge rule's commands are
    // matched by `lower`.
    const lower = name.toLowerCase();
    const wrapper = WRAPPERS.get(lower);
    if (wrapper === undefined) return { name, lower, words, from: k + 1, xargs: false };
    k += 1;
    if (lower === 'command' && k < words.length && /^-[a-zA-Z]*[vV]/.test(words[k].text)) {
      return null;
    }
    k = afterOptions(words, k, wrapper.withValue) + wrapper.plain;
  }
}

// `xargs kill` runs `kill`, so the command of an `xargs` segment is the one it
// is given, marked as reading its arguments from its input.
function commandOf(words) {
  const command = commandAt(words, 0);
  if (command === null || command.lower !== 'xargs') return command;
  const given = commandAt(words, afterOptions(words, command.from, XARGS_WITH_VALUE));
  return given === null ? null : { ...given, xargs: true };
}

// The names the rules look for, with the wrappers that run the command after
// them: what a glob in a command's name is matched against.
const GUARDED = ['gh', 'git', 'pkill', 'killall', 'lsof', 'kill', 'xargs', ...WRAPPERS.keys()];

// A name as a file system that ignores letter case finds it: in lower case,
// and with `ſ` (U+017F) as `s`, which macOS's folds into `s` and
// `toLowerCase` leaves as it is. Only the outside review rule reads names so;
// the other rules match theirs by `toLowerCase` alone.
const fold = (text) => text.toLowerCase().replaceAll('ſ', 's');

// The last part of a word's path, folded: its text after the last `/`. Where a
// part of the word is only known when it runs — a variable, a substitution —
// the last part counts only when it is written out after the last of those,
// behind a `/` of its own (`"$ROOT"/scripts/x.sh`, `$(pwd)/x.sh`); null
// otherwise. One pass over the word's marks.
function lastPart(word) {
  if (word === undefined) return null;
  const { text } = word;
  const slash = text.lastIndexOf('/');
  if (word.dynamic) {
    if (word.marks === null) return null;
    let written = 0;
    for (const mark of word.marks) if (mark.end > written) written = mark.end;
    if (slash < written) return null;
  }
  return fold(text.slice(slash + 1));
}

// Every command a list of words may run, as the rules read it: `commandOf`'s,
// and where a name holds a glob (`/usr/bin/pk?ll`, `gla[b]`), each guarded
// name the glob could match — a wrapper or `xargs` among them read on to the
// command after it. Each place in the words is read at most twice, as given
// to `xargs` or not, so the cost stays linear in their number. A reading's
// `base` is its name folded (`fold`). A name that a variable or a substitution
// gives in part is a reading too, with no `name` and no `lower`, so that no
// rule but the outside review's reads it, and with the part written out after
// the last of those as its `base` (`lastPart`).
function commandsOf(words) {
  const found = [];
  const seen = new Set();
  const pending = [[0, false]];
  while (pending.length > 0) {
    const [from, xargs] = pending.pop();
    const key = 2 * from + (xargs ? 1 : 0);
    if (seen.has(key)) continue;
    seen.add(key);
    let k = from;
    for (;;) {
      while (k < words.length && ASSIGNMENT.test(words[k].text)) k += 1;
      if (k < words.length && !words[k].dynamic && KEYWORDS.has(words[k].text)) {
        k += 1;
        continue;
      }
      break;
    }
    if (k >= words.length) continue;
    const word = words[k];
    const shape = globShape(word);
    if (shape === null) {
      const base = lastPart(word);
      if (base !== null) found.push({ name: null, lower: null, base, words, from: k + 1, xargs });
      continue;
    }
    const { text } = shape;
    const lead = text.length > 1 && text.startsWith('=') ? 1 : 0;
    const start = text.lastIndexOf('/') + 1 || lead;
    const name = text.slice(start);
    const glob = globOf(text, shape.mask, start, text.length);
    const names =
      glob === null ? [name.toLowerCase()] : GUARDED.filter((n) => globMatches(glob, n));
    for (const lower of names) {
      const wrapper = WRAPPERS.get(lower);
      if (wrapper !== undefined) {
        const after = words[k + 1];
        if (lower === 'command' && after !== undefined && /^-[a-zA-Z]*[vV]/.test(after.text)) {
          continue;
        }
        pending.push([afterOptions(words, k + 1, wrapper.withValue) + wrapper.plain, xargs]);
      } else if (lower === 'xargs') {
        pending.push([afterOptions(words, k + 1, XARGS_WITH_VALUE), true]);
      } else {
        const base = glob === null ? fold(name) : lower;
        found.push({ name: glob === null ? name : lower, lower, base, words, from: k + 1, xargs });
      }
    }
  }
  return found;
}

// How many times the command being read has changed directory so far.
let directoryMoves = 0;

// A directory named by a word, against the directory it is read in. Null when
// the guard cannot know it: a variable, a substitution, `~user`, a relative
// path after an unknown directory, a move past MAX_DIRECTORY_MOVES or a path
// longer than MAX_PATH_LENGTH.
function moveTo(word, base) {
  directoryMoves += 1;
  if (directoryMoves > MAX_DIRECTORY_MOVES) return null;
  const path = pathOf(word, base);
  return path !== null && path.length <= MAX_PATH_LENGTH ? path : null;
}

function pathOf(word, base) {
  if (word === undefined || word.dynamic || word.text === '') return null;
  const { text } = word;
  if (word.tilde) {
    if (text === '~') return homedir();
    return text.startsWith('~/') ? join(homedir(), text.slice(2)) : null;
  }
  if (isAbsolute(text)) return resolve(text);
  return base === null ? null : resolve(base, text);
}

const CD_OPTION = /^-[LPe@]+$/;

// The directory the segments after this one run in. A `cd` in a pipeline or in
// the background changes nothing: it runs in a subshell.
function directoryAfter(segment, dir) {
  const command = segment.command;
  if (command === null) return dir;
  if (segment.before === '|' || segment.after === '|' || segment.after === '&') return dir;
  if (command.name === 'popd') return null;
  if (command.name !== 'cd' && command.name !== 'pushd') return dir;
  const { words } = command;
  let k = command.from;
  while (k < words.length && !words[k].dynamic && CD_OPTION.test(words[k].text)) k += 1;
  if (k < words.length && !words[k].dynamic && words[k].text === '--') k += 1;
  const targets = words.length - k;
  if (targets === 0) return command.name === 'cd' ? homedir() : null;
  if (targets > 1 || words[k].text === '-') return null;
  return moveTo(words[k], dir);
}

const GIT_WITH_VALUE = new Set(['-c', '--namespace', '--super-prefix', '--config-env']);
const GIT_ELSEWHERE = /^--(?:git-dir|work-tree)(?:=|$)/;

// A `git` command's subcommand and the directory it runs in: the segment's,
// moved by each `-C`, and null when that directory cannot be told, as with
// `--git-dir`. `next` is where the subcommand's own words begin; null when
// there is no subcommand.
function gitAt(command, dir) {
  const { words } = command;
  let target = dir;
  let known = dir !== null;
  let k = command.from;
  while (k < words.length && isOption(words[k])) {
    const { text } = words[k];
    if (text === '-C') {
      target = moveTo(words[k + 1], target);
      known = target !== null;
      k += 2;
    } else {
      if (GIT_ELSEWHERE.test(text)) known = false;
      k += GIT_WITH_VALUE.has(text) || text === '--git-dir' || text === '--work-tree' ? 2 : 1;
    }
  }
  const subcommand = words[k];
  if (subcommand === undefined) return null;
  return { subcommand, next: k + 1, dir: known ? target : null };
}

// Whether it is `git commit`: git runs `COMMIT` as no command at all, but a
// glob may match `commit`.
const isCommit = ({ subcommand }) =>
  (!subcommand.dynamic && subcommand.text === 'commit') || globCould(subcommand, 'commit');

// Whether it is `git push`, in any letter case, since a file system that
// ignores it finds `git-PUSH` as `git-push`; a glob may match `push`.
const isPush = ({ subcommand }) =>
  (!subcommand.dynamic && subcommand.text.toLowerCase() === 'push') ||
  globCould(subcommand, 'push');

// Whether a word holds a glob that could match `name`.
function globCould(word, name) {
  const shape = globShape(word);
  if (shape === null) return false;
  const glob = globOf(shape.text, shape.mask, 0, shape.text.length);
  return glob !== null && globMatches(glob, name);
}

// ---------------------------------------------------------------------------
// What git and the file system say about a commit's directory
// ---------------------------------------------------------------------------

const repositories = new Map();

// git's answer, or null when it has none or the guard's time for git is spent:
// no call starts, and none runs, past GIT_DEADLINE_MS from the guard's start.
function git(dir, ...args) {
  const left = started + GIT_DEADLINE_MS - Date.now();
  if (left <= 0) return null;
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: Math.min(GIT_LIMIT_MS, left),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.replace(/\n$/, '') : null;
}

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isSymlink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// A `node_modules` of the worktree that is a symlink: its root's, or that of a
// directory under `apps/` or `packages/`.
function linkedModules(top) {
  const candidates = [join(top, 'node_modules')];
  for (const parent of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(top, parent));
    } catch {
      // No such directory in this worktree.
    }
    for (const entry of entries) candidates.push(join(top, parent, entry, 'node_modules'));
  }
  const linked = candidates.find(isSymlink);
  return linked === undefined ? null : relative(top, linked);
}

// A repository as one path: the git directory all its worktrees share, which
// git reports relative to the directory it was asked in.
const sharedDirectory = (dir, commonDir) => {
  try {
    return realpathSync(resolve(dir, commonDir));
  } catch {
    return null;
  }
};

// This project's repository: the one `CLAUDE_PROJECT_DIR` names, which Claude
// Code sets for a hook, and failing that the one holding this file. Null when
// neither is a repository, and then the commit rules hold everywhere.
let project;
function projectRepository() {
  if (project !== undefined) return project;
  project = null;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [process.env.CLAUDE_PROJECT_DIR, here]) {
    if (typeof dir !== 'string' || !isAbsolute(dir) || !isDirectory(dir)) continue;
    const commonDir = git(dir, 'rev-parse', '--git-common-dir');
    if (commonDir !== null && commonDir !== '') project = sharedDirectory(dir, commonDir);
    if (project !== null) break;
  }
  return project;
}

// The branch and the linked `node_modules` of the worktree holding `dir`, or
// null where there is nothing to refuse: git does not answer — not a
// directory, not a repository, no git, the guard's time spent — or the
// directory belongs to another repository than the project's.
function repositoryAt(dir) {
  if (repositories.has(dir)) return repositories.get(dir);
  let found = null;
  if (isDirectory(dir)) {
    const answer = git(dir, 'rev-parse', '--show-toplevel', '--git-common-dir');
    const [top, commonDir] = answer === null ? [] : answer.split('\n');
    if (top && commonDir) {
      const ours = projectRepository();
      if (ours === null || sharedDirectory(dir, commonDir) === ours) {
        found = {
          // Fails on a detached HEAD, which is not `main`.
          branch: git(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
          linked: linkedModules(top),
        };
      }
    }
  }
  repositories.set(dir, found);
  return found;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const STOP =
  'Stop what you started by its recorded PID (`kill <pid>`), or a background task by its task id with `TaskStop`.';

const RULES = {
  main: (dir) =>
    `\`git commit\` on \`${MAIN}\` (${dir}). Commit on a task branch instead, in a worktree cut from \`origin/${MAIN}\`.`,
  linked: (path) =>
    `\`git commit\` while \`${path}\` is a symlink. Remove the link and install \`node_modules\` in this worktree instead: \`npm ci\`.`,
  sweep: () => `\`lsof\` fed into \`kill\`, a sweep by port. ${STOP}`,
  pkill: () => `\`pkill\`, a kill by pattern. ${STOP}`,
  killall: () => `\`killall\`, a kill by name. ${STOP}`,
  lsof: (agent) =>
    `\`lsof\` inside the \`${agent}\` sub-agent. ${STOP} A port something else holds is reported, not cleared.`,
  merge: (what) =>
    `${what}, a merge outside the delivery queue. Merge with \`node ${QUEUE} merge <task> --token <token> --sha <sha>\`, which checks the delivery lock's current token and runs the merge itself; take the lock first with \`node ${QUEUE} lock <task> --session <id>\`. A session whose token is stale stops acting, reads the actual state and queues again.`,
  unread: (why) =>
    `a command that names \`gh\` together with a merge and that the guard cannot read to its end (${why}), in which a merge cannot be told apart. Write it so that it reads to its end; a merge goes through \`node ${QUEUE} merge <task> --token <token> --sha <sha>\`.`,
  push: (what) =>
    `${what}. Push a task branch, by its name or as \`HEAD\` from its worktree, and without force: bring \`origin/${MAIN}\` in by a merge, or push rewritten history as a new branch; \`${MAIN}\` moves only by the delivery queue's merge, \`node ${QUEUE} merge <task> --token <token> --sha <sha>\`.`,
  outside: (what) =>
    `${what} inside a sub-agent. The outside review is the main session's to run, and Codex's allowance and login are the owner's: run neither here, and say in your report that the outside review is due.`,
  unreadOutside: (why) =>
    `a command that names \`outside-review\` or \`codex\` and that the guard cannot read to its end (${why}), inside a sub-agent, where the outside review cannot be told apart. Write it so that it reads to its end; the outside review is the main session's to run, so say in your report that it is due.`,
};

// ---------------------------------------------------------------------------
// Where a PID comes from
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNED = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
const DECLARATIONS = new Set(['export', 'local', 'declare', 'typeset', 'readonly']);
const READ_WITH_VALUE = new Set(['-d', '-n', '-N', '-p', '-t', '-u', '-i', '-k']);
const READ_ARRAY = new Set(['-a', '-A']);
const MAPFILE_WITH_VALUE = new Set(['-d', '-n', '-O', '-s', '-u', '-C', '-c']);
const FILLS = new Set(['read', 'mapfile', 'readarray']);

// The variables a `read`, `mapfile` or `readarray` fills.
function filledBy({ name, words, from }) {
  const names = [];
  if (name === 'read') {
    for (let k = from; k < words.length; k += 1) {
      const { text, dynamic } = words[k];
      if (dynamic) continue;
      if (READ_ARRAY.has(text) || READ_WITH_VALUE.has(text)) {
        const value = words[k + 1];
        if (READ_ARRAY.has(text) && value !== undefined && !value.dynamic) names.push(value.text);
        k += 1;
      } else if (NAME.test(text)) {
        names.push(text);
      }
    }
    return names.length > 0 ? names : ['REPLY'];
  }
  let last = 'MAPFILE';
  for (let k = from; k < words.length; k += 1) {
    const { text, dynamic } = words[k];
    if (dynamic) continue;
    if (MAPFILE_WITH_VALUE.has(text)) k += 1;
    else if (NAME.test(text)) last = text;
  }
  return [last];
}

// The variables a segment assigns, each with the word that holds its value:
// assignments in front of a command, or the arguments of `export`, `local`
// and the like.
function assignments({ words, command }) {
  const found = [];
  for (const word of words) {
    const match = ASSIGNED.exec(word.text);
    if (match === null) break;
    found.push([match[1], word]);
  }
  if (command !== null && DECLARATIONS.has(command.name)) {
    for (let k = command.from; k < words.length; k += 1) {
      const match = ASSIGNED.exec(words[k].text);
      if (match !== null) found.push([match[1], words[k]]);
    }
  }
  return found;
}

const SWEEP_ROUNDS = 8;

// Marks each `kill` whose PID comes, provably, from an `lsof`'s output
// (`lsofPid`): a word of it names a variable that was filled from that output
// — by an assignment from a substitution, by `read`, `mapfile` or a `for`
// loop — or holds a substitution that yields it, `$(lsof …)` or `$(cat f)`
// of a file it was written to; or it is `xargs kill` reading that output on
// its input. Variables and files are followed by name across the whole command
// line, in any order, through at most SWEEP_ROUNDS hand-overs; `/dev/null` is
// no file, and whatever cannot be followed passes. A PID from anywhere else — a
// variable filled otherwise, `$!`, a number, another file — is not marked.
function markLsofKills(frames) {
  const vars = new Set();
  const files = new Set();
  const isFile = (word) => !word.string && (word.dynamic || word.text !== '/dev/null');
  const readsFile = (word) => isFile(word) && files.has(word.text);
  const yields = (word) => word.subs !== null && word.subs.some((sub) => sub.yieldsLsof);
  // A word that is the file `<(lsof …)` makes.
  const readsLsof = (word) =>
    word.subs !== null && word.subs.some((sub) => sub.process && sub.yieldsLsof);
  const carries = (word) =>
    (word.vars !== null && word.vars.some((name) => vars.has(name))) || yields(word);
  const args = (command) => (command === null ? [] : command.words.slice(command.from));

  let changed = true;
  for (let round = 0; changed && round < SWEEP_ROUNDS; round += 1) {
    changed = false;
    const mark = (set, value) => {
      if (set.has(value)) return;
      set.add(value);
      changed = true;
    };
    const setFlag = (object, key) => {
      if (object[key]) return;
      object[key] = true;
      changed = true;
    };
    // Inner frames first, so a substitution's output is settled before the
    // word that holds it is read.
    for (let f = frames.length - 1; f >= 0; f -= 1) {
      const frame = frames[f];
      if (!frame.checked) {
        // An array literal: `pids=($(lsof …))` holds what its words carry.
        if (frame.segments.some((segment) => segment.words.some(carries))) {
          setFlag(frame, 'yieldsLsof');
        }
        continue;
      }
      // The previous segment's output, for one that reads it through `|`, and
      // the variables `read` fills in a loop whose input comes at `done`.
      let piped = false;
      let loopReads = [];
      for (const segment of frame.segments) {
        const { command } = segment;
        const name = command === null ? null : command.name;
        const given = segment.inputs.some((word) =>
          word.string ? carries(word) : readsFile(word) || yields(word),
        );
        const fromFrame = frame.inputLsof && segment.inputs.length === 0;
        const stdin = (segment.before === '|' ? piped : fromFrame) || given;
        segment.stdinLsof = stdin;
        const words = args(command);
        const stdout =
          stdin ||
          segment.readings.some((reading) => reading.lower === 'lsof') ||
          segment.subs.some((sub) => sub.kind === 'subshell' && sub.yieldsLsof) ||
          words.some(readsFile) ||
          words.some(readsLsof) ||
          ((name === 'echo' || name === 'printf') && words.some(carries));

        if (stdout) {
          for (const word of segment.outputs) if (isFile(word)) mark(files, word.text);
        }
        if (stdin && name === 'tee') {
          for (const word of words) if (!isOption(word)) mark(files, word.text);
        }
        if (FILLS.has(name)) {
          if (stdin) for (const variable of filledBy(command)) mark(vars, variable);
          else for (const variable of filledBy(command)) loopReads.push(variable);
        } else if (name === 'done') {
          if (given) for (const variable of loopReads) mark(vars, variable);
          loopReads = [];
        }
        for (const [variable, word] of assignments(segment)) {
          if (carries(word)) mark(vars, variable);
        }
        const [first, variable, keyword] = segment.words;
        if (
          first !== undefined &&
          !first.dynamic &&
          (first.text === 'for' || first.text === 'select') &&
          variable !== undefined &&
          !variable.dynamic &&
          keyword !== undefined &&
          keyword.text === 'in' &&
          segment.words.slice(3).some(carries)
        ) {
          mark(vars, variable.text);
        }
        if (stdin) {
          for (const sub of segment.subs) if (sub.kind === 'subshell') setFlag(sub, 'inputLsof');
        }
        if (stdout && segment.after !== '|' && segment.outputs.length === 0) {
          setFlag(frame, 'yieldsLsof');
        }
        piped = stdout;
      }
    }
  }

  for (const frame of frames) {
    if (!frame.checked) continue;
    for (const segment of frame.segments) {
      segment.lsofPid = segment.readings.some(
        (reading) =>
          reading.lower === 'kill' &&
          (args(reading).some(carries) || (reading.xargs && segment.stdinLsof)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Merges and the delivery lock (D16)
// ---------------------------------------------------------------------------

// The words of a `gh` command that are not options, the value of `-R` or
// `--repo` passed over with it.
function ghWords(command) {
  const plain = [];
  const { words } = command;
  for (let k = command.from; k < words.length; k += 1) {
    const word = words[k];
    if (isOption(word)) {
      if (word.text === '-R' || word.text === '--repo') k += 1;
      continue;
    }
    plain.push(word);
  }
  return plain;
}

// Percent-escapes decoded, as often as one is left, up to four times: a
// server, or a proxy in front of it, may decode a path more than once.
const PERCENT = /%([0-9A-Fa-f]{2})/g;
function decoded(text) {
  let current = text;
  for (let round = 0; round < 4 && current.includes('%'); round += 1) {
    const next = current.replace(PERCENT, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

// Put in a path where an expansion stands (`marked`): a character no
// percent-escape decodes to. EXPANDED is a value that may be any one segment
// (`isMergePath`); OPAQUE, in a provable GET, an id that is one segment and
// none of the names a merge's path holds.
const EXPANDED = '\uE000';
const OPAQUE = '\uE001';

// A word's text with `mark` in place of each part whose value the guard does
// not know — the name of a parameter expansion, `${…}`, arithmetic, a
// substitution — and the places in that text of the glob characters no quote
// protects, as a mask (`globOf`), null when there are none.
function marked(word, mark) {
  const source = word.text;
  const marks = word.marks ?? [];
  const globs = word.globs ?? [];
  if (marks.length === 0 && globs.length === 0) return { text: source, mask: null };
  let text = '';
  const places = [];
  let from = 0;
  let g = 0;
  const copy = (to) => {
    for (; g < globs.length && globs[g] < to; g += 1) {
      if (globs[g] >= from) places.push(text.length + globs[g] - from);
    }
    text += source.slice(from, to);
    from = to;
  };
  for (const { at, end } of marks) {
    if (at < from) continue;
    copy(Math.min(at, source.length));
    text += mark;
    from = Math.max(from, Math.min(end, source.length));
  }
  copy(source.length);
  if (places.length === 0) return { text, mask: null };
  const mask = new Uint8Array(text.length);
  for (const at of places) mask[at] = 1;
  return { text, mask };
}

// The place in a word's text where the first part only known when it runs
// begins, or Infinity when the word is written out whole.
function dynamicAt(word) {
  if (word.marks !== null && word.marks.length > 0) return word.marks[0].at;
  return word.dynamic ? 0 : Infinity;
}

// The placeholders that `gh api` fills in from the repository in an endpoint:
// `{owner}`, `{repo}` and `{branch}`, as gh 2.102.0's `gh api --help` names
// them, and the older `:owner`, `:repo` and `:branch`, a `:` and the name with
// no letter, digit or `_` after it.
const BRACED_PLACEHOLDERS = ['{owner}', '{repo}', '{branch}'];
const COLON_PLACEHOLDERS = ['owner', 'repo', 'branch'];
const WORD_CHARACTER = /[a-z0-9_]/;

// Each placeholder in text replaced by `by`, or, with `by` null, whether text
// holds one at all. In any letter case, so that the rule errs towards a
// placeholder.
function placeholders(text, by) {
  const lower = text.toLowerCase();
  let out = '';
  let from = 0;
  for (let at = 0; at < lower.length; at += 1) {
    const c = lower[at];
    if (c !== '{' && c !== ':') continue;
    let size = 0;
    if (c === '{') {
      const name = BRACED_PLACEHOLDERS.find((each) => lower.startsWith(each, at));
      if (name !== undefined) size = name.length;
    } else {
      const name = COLON_PLACEHOLDERS.find(
        (each) =>
          lower.startsWith(each, at + 1) && !WORD_CHARACTER.test(lower[at + 1 + each.length] ?? ''),
      );
      if (name !== undefined) size = name.length + 1;
    }
    if (size === 0) continue;
    if (by === null) return true;
    out += text.slice(from, at) + by;
    from = at + size;
    at = from - 1;
  }
  return by === null ? false : out + text.slice(from);
}

// Whether a value next to a percent-escape may complete it, in the text as it
// is or after any round of decoding: `%${P}`, `%2${P}` or `${P}2F`, with
// EXPANDED for the value — `P=%` makes `${P}2F` the `/` that the guard would
// refuse written out. Values that hold a whole escape between them, `%2F` or
// `${A}${B}`, are the several segments a variable may hold, out of reach.
const isHex = (c) => c !== undefined && HEX.test(c);
function nextToPercent(text) {
  let current = text;
  for (let round = 0; round <= 4; round += 1) {
    for (let at = current.indexOf(EXPANDED); at >= 0; at = current.indexOf(EXPANDED, at + 1)) {
      const before = current[at - 1];
      if (before === '%' || (current[at - 2] === '%' && isHex(before))) return true;
      if (isHex(current[at + 1])) return true;
    }
    if (!current.includes('%')) return false;
    const next = current.replace(PERCENT, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) return false;
    current = next;
  }
  return false;
}

// The ranges `isMergePath` keeps: [least, most], or null for none.
const NOTHING_YET = [0, 0];
const hasZero = (range) => range !== null && range[0] === 0;
const joined = (a, b) => {
  if (a === null) return b;
  if (b === null) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
};
const lessOne = (range) =>
  range === null || range[1] === 0 ? null : [Math.max(range[0] - 1, 0), range[1] - 1];
const plusOne = (range) => (range === null ? null : [range[0] + 1, range[1] + 1]);
const oneEitherWay = (range) => (range === null ? null : [Math.max(range[0] - 1, 0), range[1] + 1]);

// Whether an API path is a pull request's merge, `…/pulls/<n>/merge`, as
// GitHub routes it — `repos/{owner}/{repo}/pulls/{n}/merge`, or the same
// under `repositories/{id}` or a full URL: without its query or fragment,
// percent-escapes decoded, in any letter case, empty and `.` segments dropped
// and each `..` taking the one before it away, and a `.json` suffix allowed.
// A segment's `;…`, a path parameter some servers strip, is not read either.
//
// A segment holding a parameter expansion (EXPANDED, `marked`), alone or
// with text of its own — `$M`, `${M}ge`, `$1`, `$_.json` — may stand for any
// one segment: `pulls`, the pull request's number, `merge`, but also an
// empty one, `.` or `..`, and its value may hold the `?` or `#` that ends the
// path. The path is a merge when some choice of them makes one. A value that
// holds several segments, `pulls/5/merge`, is out of reach: any path with a
// variable in it could be one.
//
// It is read from the last segment back. `need[f]` holds the `..` still owed
// — how many segments further left the `..` read so far take away — for the
// readings that have found the last `f` of the three segments a merge's path
// ends in: `merge`, the number, `pulls`. A segment no `..` takes away is the
// next of those; one an expansion stands in may be any of them, or a `..`, or
// nothing. A choice of readings is kept as the range from the least to the
// most owed, which may hold a number no single reading owes — the reading then
// errs towards a merge, never away from one — and is exact for a path without
// an expansion. One pass, so a path of any length costs its length.
function isMergePath(text) {
  const cut = text.search(/[?#]/);
  const path = decoded(cut < 0 ? text : text.slice(0, cut)).toLowerCase();
  const parts = path.split('/');
  let need = [NOTHING_YET, null, null];
  for (let k = parts.length - 1; k >= 0; k -= 1) {
    const whole = parts[k];
    const at = whole.indexOf(';');
    const segment = at < 0 ? whole : whole.slice(0, at);
    if (segment.includes(EXPANDED)) {
      // Its value may end the path here; then it may be anything at all.
      need[0] = joined(need[0], NOTHING_YET);
      if (hasZero(need[2])) return true;
      need = [
        oneEitherWay(need[0]),
        joined(oneEitherWay(need[1]), NOTHING_YET),
        joined(oneEitherWay(need[2]), hasZero(need[1]) ? NOTHING_YET : null),
      ];
    } else if (segment === '' || segment === '.') {
      continue;
    } else if (segment === '..') {
      need = need.map(plusOne);
    } else {
      if (hasZero(need[2]) && segment === 'pulls') return true;
      const merge = hasZero(need[0]) && segment.replace(/\.json$/, '') === 'merge';
      need = [
        lessOne(need[0]),
        joined(lessOne(need[1]), merge ? NOTHING_YET : null),
        joined(lessOne(need[2]), hasZero(need[1]) ? NOTHING_YET : null),
      ];
    }
  }
  return false;
}

// An auto-merge option set to anything but false, the way gh reads a flag:
// `--auto` or `--auto-merge`, alone or with a value after `=`.
const AUTO_MERGE_OPTIONS = ['--auto', '--auto-merge'];
const FALSE = new Set(['false', 'f', '0']);
function setsAutoMerge(word) {
  const text = word.text.toLowerCase();
  if (AUTO_MERGE_OPTIONS.includes(text)) return true;
  const equals = text.indexOf('=');
  if (equals < 0 || !AUTO_MERGE_OPTIONS.includes(text.slice(0, equals))) return false;
  return word.dynamic || !FALSE.has(text.slice(equals + 1));
}

// The options of `gh pr create` whose value is the next word, as gh 2.102.0's
// `gh pr create --help` lists them; its `-f` is `--fill` and its `-d`
// `--draft`, flags.
const CREATE_WITH_VALUE = new Set(
  ['-a', '-B', '-b', '-F', '-H', '-l', '-m', '-p', '-r', '-T', '-t', '-R'].concat(
    [
      'assignee',
      'attach',
      'base',
      'body',
      'body-file',
      'head',
      'label',
      'milestone',
      'project',
      'recover',
      'reviewer',
      'template',
      'title',
      'repo',
    ].map((option) => `--${option}`),
  ),
);

// Whether a word of `gh pr create`, which takes no operand, may be an
// auto-merge option: one that a variable or a substitution gives, in whole or
// in part, unless it is the value of an option above — written apart, or
// joined to its short name (`-t"$T"`) — or follows a written-out `--name=`
// (`--title=$T`). `gh pr edit` is not read so: its operand, the pull request,
// is a variable as often as not.
function createMayAutoMerge(command) {
  const { words } = command;
  for (let k = command.from; k < words.length; k += 1) {
    const word = words[k];
    const at = dynamicAt(word);
    if (at === Infinity) {
      if (CREATE_WITH_VALUE.has(word.text)) k += 1;
      continue;
    }
    const { text } = word;
    const equals = text.indexOf('=');
    if (text.startsWith('--') && equals >= 0 && equals < at) continue;
    if (at >= 2 && CREATE_WITH_VALUE.has(text.slice(0, 2))) continue;
    return true;
  }
  return false;
}

// The GraphQL mutations that merge a pull request or set it to merge itself,
// in lower case.
const MERGE_MUTATIONS = ['mergepullrequest', 'enablepullrequestautomerge'];

// The options of `gh api` whose value is a request body's field, a header,
// the body's file or a filter of the output, never the endpoint: a comment
// whose body quotes a merge path is no merge. Written apart (`-f x`), joined
// with `=` (`--field=x`), or joined to a short one (`-fx`); a joined one takes
// no word after it.
const BODY_OPTIONS = new Set([
  '-f',
  '-F',
  '-H',
  '-q',
  '-t',
  '--field',
  '--raw-field',
  '--header',
  '--input',
  '--jq',
  '--template',
]);
const BODY_JOINED = /^(?:--(?:field|raw-field|header|input|jq|template)=|-[fFHqt].)/;

// The words of a `gh api` command that may be its endpoint: every word after
// `api` but the values of BODY_OPTIONS, all of them after `--`.
function endpointWords(command, from) {
  const found = [];
  const { words } = command;
  for (let k = from; k < words.length; k += 1) {
    const word = words[k];
    if (!word.dynamic && word.text === '--') return found.concat(words.slice(k + 1));
    if (!word.dynamic && BODY_OPTIONS.has(word.text)) {
      k += 1;
      continue;
    }
    if (!word.dynamic && BODY_JOINED.test(word.text)) continue;
    found.push(word);
  }
  return found;
}

// The options a provable GET may carry besides `-X`/`--method`, from gh
// 2.102.0's `gh api --help`, each written out: these with a value, these
// without one. And the options that give a request a body, which makes POST
// its default method.
const GET_WITH_VALUE = new Set(['--hostname', '--header', '--jq', '--template', '--cache']);
const GET_FLAGS = new Set(['--paginate', '--slurp', '--include', '--silent']);
const BODY_LONG = new Set(['--field', '--raw-field', '--input']);
// gh api's short options that take a value, the rest of the word or else the
// next word; `-i` is its one short flag.
const API_SHORT_WITH_VALUE = 'XHfFpqt';

// The endpoint of a `gh api` command that provably sends a GET, which merges
// nothing, or null: its last `-X`/`--method` a written-out `GET`, or none and
// no body option (`-f`, `-F`, `--field`, `--raw-field`, `--input`); every
// other option one of `--paginate`, `--slurp`, `-i`/`--include`, `--silent`,
// `--cache`, `--hostname`, `-H`/`--header`, `-q`/`--jq` and `-t`/`--template`,
// written out with its value; and one word left for the endpoint. A word that
// a variable or a substitution begins may be an option (`--method=PUT`), so it
// leaves the endpoint unknown unless it is the only word left. Short options
// are read as gh reads them, bundled and joined to a value: `-iXGET`,
// `-X=GET`.
function provableGet(words, from) {
  let method = null;
  let body = false;
  const plain = [];
  for (let k = from; k < words.length; k += 1) {
    const word = words[k];
    const at = dynamicAt(word);
    const { text } = word;
    if (at === Infinity && text === '--') {
      plain.push(...words.slice(k + 1));
      break;
    }
    if (at === 0 || !text.startsWith('-') || text === '-') {
      plain.push(word);
      continue;
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      // An option whose name a variable or a substitution gives in part.
      if (equals < 0 ? at !== Infinity : at < equals) return null;
      const name = equals < 0 ? text : text.slice(0, equals);
      const next = words[k + 1];
      const valueDynamic =
        equals >= 0 ? at !== Infinity : next === undefined || dynamicAt(next) !== Infinity;
      if (name === '--method') {
        if (valueDynamic) return null;
        method = equals >= 0 ? text.slice(equals + 1) : next.text;
      } else if (BODY_LONG.has(name)) {
        body = true;
      } else if (GET_WITH_VALUE.has(name)) {
        if (valueDynamic) return null;
      } else if (GET_FLAGS.has(name)) {
        if (at !== Infinity) return null;
        continue;
      } else {
        return null;
      }
      if (equals < 0) k += 1;
      continue;
    }
    // `i` takes no value; `X`, `H`, `f`, `F`, `q` and `t` take the rest of the
    // word, after one `=`, or else the next word; `p` is no GET's.
    for (let j = 1; j < text.length; j += 1) {
      if (j >= at) return null;
      const c = text[j];
      if (c === 'i') continue;
      if (!'XHfFqt'.includes(c)) return null;
      let value;
      let dynamic;
      if (j + 1 < text.length || at === j + 1) {
        value = text.slice(text[j + 1] === '=' ? j + 2 : j + 1);
        dynamic = at !== Infinity;
      } else {
        const next = words[k + 1];
        if (next === undefined) return null;
        value = next.text;
        dynamic = dynamicAt(next) !== Infinity;
        k += 1;
      }
      if (c === 'f' || c === 'F') body = true;
      else if (dynamic) return null;
      else if (c === 'X') method = value;
      break;
    }
  }
  if (plain.length !== 1) return null;
  if (method === null ? body : method !== 'GET') return null;
  return plain[0];
}

// The segments a glob may make into one that a merge's path holds.
const MERGE_SEGMENTS = ['pulls', 'merge', 'merge.json', '.', '..'];
// What a set must not admit for its segment to be matched as written: the
// start of a percent-escape, of a query, of a fragment or of a parameter.
const NOT_IN_A_SEGMENT = ['%', '?', '#', ';'];

// An endpoint word as the merge rule reads it outside a provable GET: its
// text with EXPANDED for each part a parameter expansion, arithmetic or a
// substitution gives, and for the part of a segment, up to its first `;`,
// `?` or `#`, that a bracket expression could make `pulls`, `merge`,
// `merge.json`, `.` or `..`; and `glob`, true where a glob may make the
// endpoint any path at all — a `*` or `?` (zsh's `**` among them), or a
// bracket expression that is negated, names a class or admits `%`, `?`, `#`
// or `;`, or stands in a segment holding `%` — since what it matches may
// hold a percent-escape, a query or a fragment.
function endpointReading(word) {
  const { text, mask } = marked(word, EXPANDED);
  if (mask === null) return { text, glob: false };
  for (let k = 0; k < text.length; k += 1) {
    if (mask[k] === 1 && (text[k] === '*' || text[k] === '?')) return { text, glob: true };
  }
  let out = '';
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf('/', start);
    if (end < 0) end = text.length;
    const tokens = globOf(text, mask, start, end);
    if (tokens === null) {
      out += text.slice(start, end);
    } else {
      const loose = (token) =>
        token === STAR ||
        token === ONE ||
        (typeof token === 'object' && (token.any || NOT_IN_A_SEGMENT.some((c) => takes(token, c))));
      if (tokens.some(loose) || text.slice(start, end).includes('%')) return { text, glob: true };
      let head = start;
      while (head < end && !';?#'.includes(text[head])) head += 1;
      const named = globOf(text, mask, start, head);
      out +=
        named !== null && MERGE_SEGMENTS.some((name) => globMatches(named, name))
          ? EXPANDED + text.slice(head, end)
          : text.slice(start, end);
    }
    if (end < text.length) out += '/';
    start = end + 1;
  }
  return { text: out, glob: false };
}

// Whether a field of `gh api` may carry a merge mutation that no word of it
// spells out: a `query` field whose value a variable or a substitution gives
// in part, or a field whose key one gives.
const FIELD_LONG = new Set(['--field', '--raw-field']);
function fieldMayMerge(word, from) {
  const at = dynamicAt(word);
  if (at === Infinity) return false;
  const equals = word.text.indexOf('=', from);
  if (equals < 0 || at <= equals) return true;
  return word.text.slice(from, equals).toLowerCase() === 'query';
}
function queryMayMerge(words, from) {
  for (let k = from; k < words.length; k += 1) {
    const word = words[k];
    const at = dynamicAt(word);
    const { text } = word;
    if (at === 0 || !text.startsWith('-')) continue;
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      const name = equals < 0 ? text : text.slice(0, equals);
      if (!FIELD_LONG.has(name)) continue;
      if (equals >= 0) {
        if (at > equals && fieldMayMerge(word, equals + 1)) return true;
      } else if (at === Infinity) {
        const value = words[k + 1];
        k += 1;
        if (value !== undefined && fieldMayMerge(value, 0)) return true;
      }
      continue;
    }
    // Short options, bundled: `f` and `F` take a field, the other letters of
    // API_SHORT_WITH_VALUE a value of their own, each the rest of the word or
    // else the next word.
    for (let j = 1; j < text.length && j < at; j += 1) {
      const c = text[j];
      if (!API_SHORT_WITH_VALUE.includes(c)) continue;
      const joined = j + 1 < text.length || at === j + 1;
      if (c === 'f' || c === 'F') {
        if (joined && fieldMayMerge(word, text[j + 1] === '=' ? j + 2 : j + 1)) return true;
        if (!joined) {
          const value = words[k + 1];
          if (value !== undefined && fieldMayMerge(value, 0)) return true;
        }
      }
      if (!joined) k += 1;
      break;
    }
  }
  return false;
}

// What in a `gh api` command merges a pull request, or null; `from` is where
// its words after `api` begin.
function apiMerge(command, from, args) {
  const endpoint = provableGet(command.words, from);
  if (endpoint !== null) {
    // A GET merges nothing, so an expansion, a placeholder and a glob as gh
    // gets it when it matches no file each stand for an id there; a merge's
    // path written out stays refused, and so does an endpoint a substitution
    // gives, as for every method.
    if (endpoint.subs !== null && endpoint.subs.length > 0) {
      return '`gh api` whose endpoint a substitution gives';
    }
    if (isMergePath(placeholders(marked(endpoint, OPAQUE).text, OPAQUE))) {
      return "`gh api` on a pull request's `merge` path";
    }
  } else {
    const words = endpointWords(command, from);
    const readings = words.map(endpointReading);
    if (readings.some((reading) => isMergePath(reading.text))) {
      return "`gh api` on a pull request's `merge` path";
    }
    // A substitution, arithmetic or a `${…}` that does more than name a
    // variable may make any path at all, a merge's among them; so may a glob,
    // a placeholder gh fills in from the repository (`{branch}` on a branch
    // named `merge`), and a value next to a percent-escape (`%${P}`).
    if (words.some((word) => word.unknown)) {
      return '`gh api` whose endpoint a substitution or an expansion gives';
    }
    if (readings.some((reading) => reading.glob)) {
      return '`gh api` whose endpoint a glob may make any path';
    }
    const texts = words.map((word) => marked(word, EXPANDED).text);
    if (texts.some((text) => placeholders(text, null))) {
      return '`gh api` whose endpoint holds a placeholder gh fills in';
    }
    if (texts.some(nextToPercent)) {
      return '`gh api` whose endpoint a value next to a percent-escape may make any path';
    }
  }
  if (
    args.some((word) => {
      const text = word.text.toLowerCase();
      return MERGE_MUTATIONS.some((name) => text.includes(name));
    })
  ) {
    return '`gh api` carrying the GraphQL `mergePullRequest` or `enablePullRequestAutoMerge`';
  }
  if (queryMayMerge(command.words, from)) {
    return '`gh api` with a GraphQL query or a field key that a variable or a substitution gives, which may be `mergePullRequest`';
  }
  return null;
}

// What in a `gh pr` command merges a pull request, or null.
function prMerge(command, second, args) {
  if (second === undefined) return null;
  if (second.dynamic) return '`gh pr` whose subcommand a variable or a substitution gives';
  const subcommands = couldBe(second, ['merge', 'create']);
  if (subcommands.includes('merge')) {
    return second.globs === null
      ? '`gh pr merge`'
      : '`gh pr` whose subcommand a glob may make `merge`';
  }
  if (args.some(setsAutoMerge)) return '`gh pr` with an auto-merge option';
  if (subcommands.includes('create') && createMayAutoMerge(command)) {
    return '`gh pr create` with a word that a variable or a substitution gives, which may be an auto-merge option';
  }
  return null;
}

// What in a segment's command merges a pull request, said in a few words, or
// null when nothing does. A glob may make gh's group word `pr` or `api`.
function mergeOf(command) {
  if (command.lower !== 'gh') return null;
  const [first, second] = ghWords(command);
  if (first === undefined) return null;
  if (first.dynamic) return '`gh` whose subcommand a variable or a substitution gives';
  const args = command.words.slice(command.from);
  const groups = couldBe(first, ['pr', 'api']);
  if (groups.includes('pr')) {
    const merge = prMerge(command, second, args);
    if (merge !== null) return merge;
  }
  if (groups.includes('api')) return apiMerge(command, command.words.indexOf(first) + 1, args);
  return null;
}

// Whether a command the guard could not read names `gh` together with a
// merge, with quotes and backslashes taken out and percent-escapes decoded
// first, so that `g\h`, `g''h` and `%6derge` count too: `gh` as a word of its
// own, or a word that as a glob could be `gh` (`/opt/homebrew/bin/g?`); and
// `merge` anywhere, in any letter case — `mergePullRequest` and
// `--auto-merge` among them — or a word that as a glob could be `merge` or
// one of the merge mutations.
const NAMES_GH = /(?:^|[^a-z0-9_.-])gh(?:$|[^a-z0-9_.-])/;
const GLOB_WORD = /[a-z0-9_.\-*?[\]!^]+/g;
const MERGE_WORDS = ['merge', ...MERGE_MUTATIONS];
function namesGhMerge(command) {
  const text = decoded(command.replace(/['"\\]/g, '')).toLowerCase();
  let gh = NAMES_GH.test(text);
  let merge = text.includes('merge');
  if (gh && merge) return true;
  for (const [token] of text.matchAll(GLOB_WORD)) {
    if (!token.includes('*') && !token.includes('?') && !token.includes('[')) continue;
    const mask = new Uint8Array(token.length);
    for (let k = 0; k < token.length; k += 1) if ('*?[]'.includes(token[k])) mask[k] = 1;
    const glob = globOf(token, mask, 0, token.length);
    if (glob === null) continue;
    if (!gh && globMatches(glob, 'gh')) gh = true;
    if (!merge && MERGE_WORDS.some((name) => globMatches(glob, name))) merge = true;
    if (gh && merge) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pushes to the main branch (D26)
// ---------------------------------------------------------------------------

// git push's long options that force, that push the main branch with every
// other branch, that delete, and that push tags alone; and those whose value
// may be the next word. git takes any start of a long option's name for it,
// so a start of one of the first counts as it (`mayBe`).
const PUSH_FORCE = ['--force', '--force-with-lease', '--force-if-includes'];
const PUSH_EVERY = ['--mirror', '--all', '--branches'];
const PUSH_DELETE = '--delete';
const PUSH_TAGS = '--tags';
const PUSH_WITH_VALUE = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
  '--recurse-submodules',
]);

// Whether `name`, a long option's name or the part of it written out, may be
// `full`: git takes any start of a name longer than `--`.
const mayBe = (name, full) => name.length > 2 && full.startsWith(name);

// Whether the lower-case `name` matches a list of glob tokens (`globOf`),
// where STAR stands for any run of characters. One pass per token over the
// places in the name, so the cost is the tokens' number times its length.
function patternMatches(tokens, name) {
  const n = name.length;
  if (!tokens.includes(STAR) && tokens.length !== n) return false;
  let reached = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  reached[0] = 1;
  for (const token of tokens) {
    next.fill(0);
    let any = false;
    if (token === STAR) {
      for (let p = 0; p <= n; p += 1) {
        if (reached[p] === 1) any = true;
        if (any) next[p] = 1;
      }
    } else {
      for (let p = 0; p < n; p += 1) {
        if (reached[p] === 1 && takes(token, name[p])) {
          next[p + 1] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    [reached, next] = [next, reached];
  }
  return reached[n] === 1;
}

// Whether a refspec's destination, text[from, to) of a `marked` reading, may
// name the main branch: `main`, `heads/main` or `refs/heads/main`, which git
// completes to it, in any letter case; a `*` in it, quoted or not, is git's
// pattern, and a glob no quote protects the shell's. A part a variable or a
// substitution gives is read as naming a task branch.
function namesMain(text, mask, from, to) {
  const destination = text.slice(from, to);
  if (destination.includes(EXPANDED)) return false;
  const names = mainNames();
  if (!destination.includes('*') && mask === null) return names.includes(destination.toLowerCase());
  const wild = new Uint8Array(to);
  for (let k = from; k < to; k += 1) {
    if ((mask !== null && mask[k] === 1) || text[k] === '*') wild[k] = 1;
  }
  const tokens = globOf(text, wild, from, to);
  if (tokens === null) return names.includes(destination.toLowerCase());
  return names.some((name) => patternMatches(tokens, name));
}

// What in a `git push` breaks the push rule whatever the current branch is,
// said in a few words, or null; and whether it pushes the current branch. `at`
// is `gitAt`'s reading of the command. The words after `push` are options —
// a short group read letter by letter, `-o` taking the rest of the group or
// the next word — or refspecs, the first of them the repository, which is
// read as one too: a remote is never named like the main branch. A word a
// variable or a substitution begins is a refspec (`namesMain`).
function pushOf(command, at) {
  const { words } = command;
  let force = false;
  let every = null;
  let deleting = false;
  let tags = false;
  let options = true;
  const refspecs = [];
  for (let j = at.next; j < words.length; j += 1) {
    const word = words[j];
    const written = dynamicAt(word);
    const { text } = word;
    if (options && written === Infinity && text === '--') {
      options = false;
      continue;
    }
    if (!options || written === 0 || !text.startsWith('-') || text === '-') {
      refspecs.push(word);
      continue;
    }
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      const end = Math.min(equals < 0 ? text.length : equals, written);
      const name = text.slice(0, end);
      if (PUSH_FORCE.some((full) => mayBe(name, full))) force = true;
      else if (PUSH_EVERY.some((full) => mayBe(name, full))) {
        every ??= mayBe(name, '--mirror') ? '--mirror' : '--all';
      } else if (mayBe(name, PUSH_DELETE)) deleting = true;
      else if (mayBe(name, PUSH_TAGS)) tags = true;
      if (equals < 0 && written === Infinity && PUSH_WITH_VALUE.has(name)) j += 1;
      continue;
    }
    for (let c = 1; c < text.length && c < written; c += 1) {
      const letter = text[c];
      if (letter === 'f') force = true;
      else if (letter === 'd') deleting = true;
      else if (letter === 'o') {
        if (c + 1 === text.length && written === Infinity) j += 1;
        break;
      }
    }
  }

  const main = mainBranch();
  let target = null;
  // No refspec but the repository, and no option that names what to push:
  // `push.default` pushes the current branch.
  let current = refspecs.length <= 1 && every === null && !tags && !deleting;
  for (const word of refspecs) {
    // zsh's group in the middle of a word, `m(a)in`, is read as `*`, as in a
    // command's name; any other part only known when it runs as EXPANDED.
    const { text, mask } = globShape(word) ?? marked(word, EXPANDED);
    const plus = text.startsWith('+') ? 1 : 0;
    if (plus === 1) force = true;
    const colon = text.indexOf(':', plus);
    if (colon < 0) {
      const source = text.slice(plus).toLowerCase();
      // `HEAD` — `head`, which a file system that ignores case finds — and
      // `@` push the current branch to its own name.
      if (source === 'head' || source === '@') {
        current = true;
        continue;
      }
    }
    if (target !== null) continue;
    if (colon === text.length - 1 && colon === plus) {
      target = `\`git push\` of the matching refspec \`:\`, which pushes \`${main}\` with the rest`;
    } else if (namesMain(text, mask, colon < 0 ? plus : colon + 1, text.length)) {
      // An empty source, `:main`, deletes as `--delete` does.
      target =
        deleting || colon === plus
          ? `\`git push --delete\` of \`${main}\``
          : `\`git push\` to \`${main}\``;
    }
  }
  const explicit =
    target ??
    (every !== null ? `\`git push ${every}\`, which pushes \`${main}\` with the rest` : null) ??
    (force ? 'a force push' : null);
  return { explicit, current };
}

// ---------------------------------------------------------------------------
// The outside review and Codex, inside a sub-agent (D12)
// ---------------------------------------------------------------------------

// The names the rule looks for, folded, and what its line calls each.
const CODEX = 'codex';
const OUTSIDE_NAMES = new Map([
  ['outside-review.sh', 'the outside review script, `outside-review.sh`,'],
  ['outside-review.mjs', "the outside review's helper, `outside-review.mjs`,"],
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SOURCES = new Set(['.', 'source']);
const NODES = new Set(['node', 'nodejs']);
// The paths that name a command's own standard input.
const STDIN_PATHS = new Set(['/dev/stdin', '/dev/fd/0']);

// The shells' long options that take the next word as their value: bash's
// `--rcfile` and `--init-file`, files it runs, and zsh's `--emulate`.
const SHELL_LONG_WITH_VALUE = new Set(['--rcfile', '--init-file', '--emulate']);
const SHELL_LONG_RUN = new Set(['--rcfile', '--init-file']);

// What a shell is given to run. A short option that takes a value, `o` or `O`
// in a group, is read both ways the shells read it, and each reading counts:
// bash takes its value from the next word whatever follows it in the group
// (`-oe pipefail`); zsh and ksh take the rest of the group (`-onoglob`), and
// the next word only when nothing follows. ksh's `-T <mask>` takes a value the
// same way, where bash and zsh read `-T` as a flag, so only the second reading
// gives it one. `scripts` are the words it may run as a script — its first
// operand, the file of `--rcfile` — and `stdin` whether it may read one on its
// standard input: without an operand, or with `-s`. `-` and `--` end the
// options. A reading with `-c`, whose string the indirection class leaves
// alone, or with `-n` in force, which reads without running, gives nothing.
function shellGiven({ words, from }) {
  const scripts = [];
  let stdin = false;
  for (const attached of [false, true]) {
    let k = from;
    let operand;
    let command = false;
    let noexec = false;
    let fromStdin = false;
    while (k < words.length) {
      const word = words[k];
      const { text } = word;
      if (word.dynamic || text === '+' || (text[0] !== '-' && text[0] !== '+')) {
        operand = word;
        break;
      }
      k += 1;
      if (text === '-' || text === '--') {
        operand = words[k];
        break;
      }
      if (text.startsWith('--')) {
        if (SHELL_LONG_WITH_VALUE.has(text)) {
          if (SHELL_LONG_RUN.has(text) && k < words.length) scripts.push(words[k]);
          k += 1;
        }
        continue;
      }
      const on = text[0] === '-';
      for (let c = 1; c < text.length; c += 1) {
        const letter = text[c];
        if (letter === 'c' && on) command = true;
        else if (letter === 'n') noexec = on;
        else if (letter === 's' && on) fromStdin = true;
        else if (letter === 'o' || letter === 'O' || (letter === 'T' && attached)) {
          if (attached && c + 1 < text.length) break;
          k += 1;
        }
      }
    }
    if (command || noexec) continue;
    if (fromStdin || operand === undefined) stdin = true;
    else scripts.push(operand);
  }
  return { scripts, stdin };
}

// What `.` or `source` is given: its first word, after bash's `-p <path>` and
// `--`.
function sourceGiven({ words, from }) {
  let k = from;
  while (k < words.length && !words[k].dynamic && words[k].text === '-p') k += 2;
  if (k < words.length && !words[k].dynamic && words[k].text === '--') k += 1;
  return { scripts: k < words.length ? [words[k]] : [], stdin: false };
}

// node's options that load a module before the script; those that take the
// next word as their value, from the `--help` of the release in use; and
// those after which it runs no script file: a string, a check of the syntax,
// a package's script, a version or the help.
const NODE_LOADS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const NODE_WITH_VALUE = new Set([
  ...NODE_LOADS,
  '-C',
  ...`
  allow-fs-read allow-fs-write build-snapshot-config conditions cpu-prof-dir
  cpu-prof-interval cpu-prof-name diagnostic-dir disable-proto
  disable-warning dns-result-order env-file env-file-if-exists
  experimental-config-file experimental-sea-config
  experimental-test-tag-filter heap-prof-dir heap-prof-interval
  heap-prof-name heapsnapshot-near-heap-limit heapsnapshot-signal
  icu-data-dir input-type inspect-port inspect-publish-uid localstorage-file
  max-http-header-size max-old-space-size-percentage
  network-family-autoselection-attempt-timeout openssl-config
  redirect-warnings report-dir report-directory report-filename
  report-signal secure-heap secure-heap-min snapshot-blob test-concurrency
  test-coverage-branches test-coverage-exclude test-coverage-functions
  test-coverage-include test-coverage-lines test-global-setup test-isolation
  test-name-pattern test-random-seed test-reporter test-reporter-destination
  test-rerun-failures test-shard test-skip-pattern test-timeout title
  tls-cipher-list tls-keylog trace-event-categories trace-event-file-pattern
  trace-require-module unhandled-rejections use-largepages v8-pool-size
  watch-kill-signal watch-path
`
    .trim()
    .split(/\s+/)
    .map((option) => `--${option}`),
]);
const NODE_NO_SCRIPT = new Set(
  ['-e', '-p', '-c', '-v', '-h'].concat(
    ['eval', 'print', 'check', 'run', 'version', 'help', 'v8-options'].map(
      (option) => `--${option}`,
    ),
  ),
);

// The last place in a list of words whose last part is one of the review's
// names, or -1: found once per list, however many `node --test` readings of it
// ask.
const lastOutside = new WeakMap();
function lastOutsideIn(words) {
  let last = lastOutside.get(words);
  if (last === undefined) {
    last = -1;
    for (let k = words.length - 1; k >= 0 && last < 0; k -= 1) {
      if (OUTSIDE_NAMES.has(lastPart(words[k]))) last = k;
    }
    lastOutside.set(words, last);
  }
  return last;
}

// What `node` is given to run: the modules it loads first and its script —
// with `--test`, any word from its first operand on, each a test file it runs
// — and whether it may read the script on its standard input: without an
// operand, or with `-`. Null after an option that runs no script file.
function nodeGiven({ words, from }) {
  const scripts = [];
  let test = false;
  let k = from;
  while (k < words.length) {
    const word = words[k];
    const { text } = word;
    if (word.dynamic || !text.startsWith('-') || text === '-') break;
    k += 1;
    if (text === '--') break;
    const equals = text.indexOf('=');
    const name = equals < 0 ? text : text.slice(0, equals);
    if (NODE_NO_SCRIPT.has(name)) return null;
    if (name === '--test') test = true;
    if (equals >= 0) {
      if (NODE_LOADS.has(name)) scripts.push({ ...word, text: text.slice(equals + 1) });
    } else if (NODE_WITH_VALUE.has(name)) {
      if (NODE_LOADS.has(name) && k < words.length) scripts.push(words[k]);
      k += 1;
    }
  }
  if (test && k < words.length) {
    const last = lastOutsideIn(words);
    if (last >= k) scripts.push(words[last]);
  }
  const operand = words[k];
  const stdin = operand === undefined || (!operand.dynamic && operand.text === '-');
  if (!stdin) scripts.push(operand);
  return { scripts, stdin };
}

// The review's name that the segment's standard input is a file of, or null;
// read once per segment, however many shells it holds.
function stdinOutside(segment) {
  if (segment.stdinOutside === undefined) {
    segment.stdinOutside = null;
    for (const word of segment.inputs) {
      const part = word.string ? null : lastPart(word);
      if (OUTSIDE_NAMES.has(part)) {
        segment.stdinOutside = part;
        break;
      }
    }
  }
  return segment.stdinOutside;
}

// What in a segment runs the outside review or Codex, in the words its line
// names it by, or null: a command named `codex`, `outside-review.sh` or
// `outside-review.mjs`, or a shell, `.`, `source` or `node` given one of the
// last two as a script, as a module or on its standard input — though not
// through `xargs`, which gives the command it runs no input of the segment's.
function outsideReviewOf(segment) {
  for (const reading of segment.readings) {
    const { base } = reading;
    if (base === CODEX) return '`codex`';
    if (OUTSIDE_NAMES.has(base)) return OUTSIDE_NAMES.get(base);
    // A name only partly known runs nothing else the rule can tell.
    if (reading.lower === null) continue;
    let given = null;
    if (SHELLS.has(base)) given = shellGiven(reading);
    else if (SOURCES.has(base)) given = sourceGiven(reading);
    else if (NODES.has(base)) given = nodeGiven(reading);
    if (given === null) continue;
    let { stdin } = given;
    for (const word of given.scripts) {
      const part = lastPart(word);
      if (OUTSIDE_NAMES.has(part)) return OUTSIDE_NAMES.get(part);
      if (word !== undefined && !word.dynamic && STDIN_PATHS.has(word.text)) stdin = true;
    }
    const input = stdin && !reading.xargs ? stdinOutside(segment) : null;
    if (input !== null) return OUTSIDE_NAMES.get(input);
  }
  return null;
}

// Whether a command the guard could not read names the outside review or
// Codex, read as `namesGhMerge` reads `gh`: quotes and backslashes taken out
// first, and folded.
const NAMES_CODEX = /(?:^|[^a-z0-9_.-])codex(?:$|[^a-z0-9_.-])/;
function namesOutsideReview(command) {
  const text = fold(command.replace(/['"\\]/g, ''));
  return text.includes('outside-review') || NAMES_CODEX.test(text);
}

// The first rule the command breaks, as written from left to right, or null.
// A command with `$'…'` in it is read as bash reads it and, when that breaks
// no rule, as zsh does, since the two decode it differently (`ansiC`). `agent`
// is the input's `agent_type`, and `subAgent` whether it carries `agent_id`.
function brokenRule(command, cwd, agent, subAgent) {
  const first = brokenIn(command, cwd, agent, subAgent, 'bash');
  if (first !== null || !command.includes("$'")) return first;
  return brokenIn(command, cwd, agent, subAgent, 'zsh');
}

function brokenIn(command, cwd, agent, subAgent, dialect) {
  directoryMoves = 0;
  let frames;
  try {
    frames = split(command, cwd, dialect);
  } catch (error) {
    // The merge rule fails closed, and inside a sub-agent the outside review
    // rule does; the others pass what cannot be read.
    if (error instanceof Unparsable && namesGhMerge(command)) {
      return { text: RULES.unread(error.message), decision: QUEUE_DECISION };
    }
    if (error instanceof Unparsable && subAgent && namesOutsideReview(command)) {
      return { text: RULES.unreadOutside(error.message), decision: OUTSIDE_DECISION };
    }
    throw error;
  }
  markLsofKills(frames);

  let first = null;
  const broken = (start, frame, rule, sweep = false, decision = DECISION) => {
    if (first === null || start < first.start) first = { start, frame, rule, sweep, decision };
  };

  for (const frame of frames) {
    if (!frame.checked) continue;
    // Where the pipeline being read ran `lsof`, if it did.
    let lsofAt = -1;
    for (const segment of frame.segments) {
      if (segment.before !== '|') lsofAt = -1;
      const { readings } = segment;
      if (readings.length === 0) continue;
      let merge = null;
      for (const reading of readings) {
        merge = mergeOf(reading);
        if (merge !== null) break;
      }
      if (merge !== null) {
        broken(segment.start, frame, RULES.merge(merge), false, QUEUE_DECISION);
        continue;
      }
      if (subAgent) {
        const outside = outsideReviewOf(segment);
        if (outside !== null) {
          broken(segment.start, frame, RULES.outside(outside), false, OUTSIDE_DECISION);
        }
      }
      // Each name in any letter case, as macOS runs `PKILL`; a glob may be
      // several of them, and each rule reads it as its own.
      const is = (name) => readings.some((reading) => reading.lower === name);
      if (is('pkill')) broken(segment.start, frame, RULES.pkill());
      if (is('killall')) broken(segment.start, frame, RULES.killall());
      if (is('lsof')) {
        if (NO_LSOF_AGENTS.has(agent)) broken(segment.start, frame, RULES.lsof(agent));
        if (lsofAt < 0) lsofAt = segment.start;
      }
      if (is('kill')) {
        if (lsofAt >= 0) broken(lsofAt, frame, RULES.sweep(), true);
        else if (segment.lsofPid) broken(segment.start, frame, RULES.sweep(), true);
      }
      for (const reading of readings) {
        if (reading.lower !== 'git') continue;
        const at = gitAt(reading, segment.dir);
        if (at === null) continue;
        // Each check below is skipped once this segment or an earlier one is
        // already refused: git is asked only where its answer could change
        // the outcome.
        if (isCommit(at) && at.dir !== null && !(first !== null && first.start <= segment.start)) {
          const repository = repositoryAt(at.dir);
          if (repository !== null && repository.branch === MAIN) {
            broken(segment.start, frame, RULES.main(at.dir));
          } else if (repository !== null && repository.linked !== null) {
            broken(segment.start, frame, RULES.linked(repository.linked));
          }
        }
        if (!isPush(at) || (first !== null && first.start <= segment.start)) continue;
        const push = pushOf(reading, at);
        if (push.explicit !== null) {
          // A push the written-out words make one to `main`, or a forced one,
          // is refused in the project's repository, and where the directory
          // cannot be told; a throwaway repository is left alone.
          if (at.dir === null || repositoryAt(at.dir) !== null) {
            broken(segment.start, frame, RULES.push(push.explicit), false, PUSH_DECISION);
          }
        } else if (push.current && at.dir !== null) {
          // `HEAD`, `@` or no refspec: the current branch decides, as for a
          // commit, and a branch that cannot be told passes.
          const repository = repositoryAt(at.dir);
          if (repository !== null && repository.branch === MAIN) {
            broken(
              segment.start,
              frame,
              RULES.push(`\`git push\` of \`HEAD\` where the branch is \`${MAIN}\` (${at.dir})`),
              false,
              PUSH_DECISION,
            );
          }
        }
      }
    }
  }

  if (first === null) return null;
  const where =
    first.frame.kind === 'substitution' && !first.sweep
      ? ' It stands in a command substitution: the shell runs `$(…)` and backticks even inside double quotes.'
      : '';
  return { text: `${first.rule}${where}`, decision: first.decision };
}

// The line that refuses a hook input, or null when it passes.
function refusal(input) {
  if (input === null || typeof input !== 'object') return null;
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const agent = typeof input.agent_type === 'string' ? input.agent_type : null;
  // Only a sub-agent's input carries `agent_id`, whatever its value; a main
  // session started with `claude --agent` carries `agent_type` alone (D9).
  const subAgent = input.agent_id !== undefined && input.agent_id !== null;
  const rule = brokenRule(command, cwd, agent, subAgent);
  if (rule === null) return null;
  return `guard-bash refused this command: ${rule.text} [PreToolUse hook ${GUARD}, ${rule.decision}]`;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

// Everything on stdin, or null if it does not end in time.
const readInput = () =>
  new Promise((done) => {
    const chunks = [];
    const timer = setTimeout(() => done(null), STDIN_LIMIT_MS);
    const finish = (text) => {
      clearTimeout(timer);
      done(text);
    };
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(null));
  });

// The main branch is read while the input arrives.
const [text] = await Promise.all([readInput(), readMainBranch()]);
// Exit 0 with a note on stderr reaches only the debug log.
const unchecked = (why) => process.stderr.write(`guard-bash did not check this command: ${why}\n`);

if (text === null) {
  unchecked('its input did not arrive');
  process.exit(0);
}

let line = null;
try {
  line = refusal(JSON.parse(text));
} catch (error) {
  if (error instanceof Unparsable) unchecked(error.message);
  else if (error instanceof SyntaxError) unchecked('its input is not JSON');
  else unchecked(`an error of its own (${error?.name ?? 'unknown'})`);
}

if (line !== null) process.stderr.write(`${line}\n`);
process.exitCode = line === null ? 0 : 2;
