# 04 · Safety Boundaries and the Permission System

Covers: `src/permissions.ts`, `src/command-parse.ts`, the security-relevant
parts of `src/tools/shell.ts`, and the path-boundary parts of
`src/tools/filesystem.ts`.

## 0. The big picture: two kinds of boundary, fundamentally different

| Boundary | Nature | Enforced by |
| --- | --- | --- |
| File tools cannot escape the workspace root | **Containment**, mechanically enforced | `resolveToolPath` |
| Whether a shell command asks the user | **Consent**, heuristic | whitelist + rules + approver |

Every command on the whitelist can read any file the user can read, on every
platform — the same posture Codex (read-only still reads the whole disk),
Gemini CLI, and Cursor document. **Containment needs an OS sandbox, which
this project does not have.** The docs and code comments repeat this so
nobody later mistakes the "consent mechanism" for a "security boundary".

## 1. The file path boundary (filesystem.ts)

Three layers; every file tool — and the shell's `workdir` — must go through
the last one:

### resolveInsideRoot — the lexical layer

`path.resolve(root, target)` then a `path.relative` check: a relative result
starting with `..` or an absolute result → reject. Pure string work; blocks
`..` traversal and absolute paths pointing outside the root. **It cannot see
symbolic links** — AGENTS.md forbids tools from calling it directly.

### resolveToolPath — the resolved layer (what tools must use)

```
absolute = resolveInsideRoot(target)
realRoot = realpath(root); missing → undefined (a root that does not exist yet
           cannot contain a link, so pass — write_file must be able to create it)
realTarget = realpathDeepestExisting(absolute)   ← realpath of the deepest *existing* ancestor
relative(realRoot, realTarget) outside the root → reject ("resolves outside
           the workspace root through a link")
```

Why the second layer is needed: `resolveInsideRoot` compares strings, so a
symlink / NTFS junction *inside* the root pointing outside passes the check,
and the subsequent read or write follows the link out — measured: a junction
at `<root>/link` let `read_file link/secret.txt` return a file outside the
root.

`realpathDeepestExisting`: when the target does not exist (a file about to be
written), it walks up to the deepest existing ancestor — the directory the
write will actually land in. Only `ENOENT`/`ENOTDIR` tolerate walking up;
anything else (symlink loops, permission errors) **fails closed**, because
guessing would turn an unresolvable path into an allowed one.

`displayPath`: the path shown to the model — relative to the root, POSIX
separators (display form).

The undo side respects the boundary too: before restoring, the journal
re-validates each recorded path through `resolveToolPath` (doc 06) — safe
when recorded does not mean safe now, since a link may have appeared since;
undo must not be the one path that writes outside the root.

## 2. Shell command parsing (command-parse.ts)

`splitSubcommands` and `commandLeaders` are shared by the shell tool
(read-only classification) and the permission rule engine (prefix matching).

### Dialect awareness (why it must exist)

The two shells' disagreement about escaping is a demonstrated vulnerability
source:

- bash: `\` escapes the next character — outside quotes and inside `"…"`
  alike; nothing is special inside `'…'`.
- PowerShell: the **backtick** escapes (same three contexts); `\` is an
  ordinary character — so `"C:\dir\"` is a complete string in PowerShell but
  an escaped quote in bash.

If the parser believes a separator is escaped while the real shell does not,
the hidden command rides along on the first subcommand's allow decision:
measured on Windows, a `Get-Content` line with an escaped `\;` was classified
read-only and deleted a file outside the workspace root without any approval.
Therefore every dialect rule here **errs toward splitting** (the stricter
direction): a part that should not have been split can only make the line
harder to approve, never easier.

### splitSubcommands details

- Separators: `&&`, `||`, `;`, `|`, `|&`, newlines, and a **bare `&`**.
  A bare `&` separates in both dialects (POSIX backgrounding, PowerShell 7
  background operator, and in earlier PowerShell the call operator —
  splitting is the strict reading of all three). Leaving it out once let
  `type a.txt & del a.txt` pass the read-only test on its first word alone.
- `&` adjacent to `>` is not a separator (`2>&1`, `>&2`, `&>file` are
  redirections).
- No splitting inside quotes; the escape character is inert inside single
  quotes (one of the few things the dialects agree on).

### commandLeaders and the environment-prefix whitelist

`commandLeaders` extracts `(program, subcommand)`, and the `NAME=value`
prefixes it may strip are restricted to variables that **cannot change what
gets executed or which file gets read**: `LANG`, `TZ`, `TERM`, `NO_COLOR`,
`LC_*`, etc. Stripping *every* prefix used to be a hole:
`PATH=./evil cat x` ran a model-planted `cat` while the classifier saw the
whitelisted name (`LD_PRELOAD` and `GIT_EXTERNAL_DIFF` likewise — code
execution on their own). Any other assignment keeps its place, the leading
word no longer matches a whitelisted program → falls to the approver.

## 3. The prefix rule engine (permissions.ts)

Rule syntax (Claude Code's model): a command prefix with an optional trailing
`*` — `npm run *` matches `npm run test`, `npm run build`, and the bare
`npm run`; `git status` matches exactly itself.

### evaluate: whole-line decision

```
parts = splitSubcommands(command, dialect)   ← dialect must match the shell that will run it
any part matching a deny rule → 'deny'       ← a compound cannot smuggle a risky fragment
every part matching some allow rule → 'allow' ← same policy as the read-only classification: all must pass
otherwise → 'ask'
```

The `dialect` parameter matters: the split must follow the grammar of the
shell that will actually run the command, or a separator that shell honors
but the parser missed stays hidden inside the first subcommand and inherits
its allow. An empty split (parts.length === 0) → 'ask'.

`parseRules` parses config leniently (non-string/empty entries dropped);
`derivePrefixRule` derives the "never ask again this session" prefix from a
command the user just approved: two words for the SUBCOMMAND_PROGRAMS set
(npm/git/docker/... → `git commit *`), otherwise the bare program
(`mkdir *`).

### mergeRules (cli.ts): the project layer wins

When merging global and project rules, a project allow can "redeem" the same
rule from global deny, and a project deny can suppress the same global allow
— on conflict the project layer wins.

## 4. The shell read-only whitelist (shell.ts)

### The approval chain (the order is the security semantics)

```
1. persistent deny rules        → throw immediately ("Do not try to work around it")
2. persistent allow rules       → pass only when every subcommand matches
3. read-only whitelist          → isReadOnlyCommand passes
4. ctx.approve approver         → deny by default (no approver = denied; the error
                                   message points to configuring approver or permissions.allow)
```

**Deny is evaluated before the whitelist** is a hard constraint: the
whitelist is a convenience heuristic, and a user who writes
`deny: ["cat *"]` must be able to close the hole the heuristic opens.

### isReadOnlyCommand

Every subcommand (compound commands are fully split) must be read-only; any
non-read-only fragment → the whole line needs approval. `isReadOnlySubcommand`'s
global vetoes:

- command substitution `$(...)` and backticks (backtick is bash's
  substitution delimiter *and* PowerShell's escape — dangerous in both, so
  rejected outright);
- `(`, `@`, `{` appearing outside quoted text in PowerShell (subexpressions,
  splats, and script blocks are **code**: `Write-Output (Remove-Item x)`
  really executes Remove-Item; `withoutQuotedText` strips quoted strings
  first, so regex literals like `Select-String "a(b)c"` are unaffected);
- file redirection (`hasFileRedirection`);
- path-prefixed program names (`/bin/rm`, `C:\tools\x.exe`, `./script`) —
  never whitelisted.

`hasFileRedirection` exemptions: descriptor duplication `2>&1`/`>&2` and null
devices (POSIX `/dev/null`; PowerShell's `$null` and `nul`, with negative
lookahead excluding ordinary names like `nul.txt`). Every other
`> file`/`>> file`/`< file`/`2> file` counts as a file redirection.

### The whitelist command set (shared by both dialects, intersection semantics)

On Windows with Git for Windows installed (the normal case for this
project's users), name resolution splits three ways, and every name in the
shared set must be read-only under *either* resolution:

1. PowerShell aliases (aliases win over anything on PATH): `ls`, `cat`,
   `type`, `echo`, `pwd`, `cd`, `diff`, `sort`;
2. GNU coreutils from Git's `usr/bin` (GNU *flag* semantics on Windows too,
   so every POSIX flag guard applies there as well): `head`, `tail`, `grep`,
   `find`, `wc`, `which`, `stat`, `du`, `uniq`, `printf`, `dirname`,
   `basename`, `realpath`;
3. `whereis` is absent — that one name costs a failed call rather than an
   approval prompt on Windows.

`cd` is included deliberately: it changes the working directory of the rest
of the line, but it cannot itself write, and a plain absolute path
(`cat /etc/shadow`) reaches exactly the same places — the same property as
the documented read posture, not a hole of its own. Narrow it with a deny
rule if you want it gone.

The PowerShell-only set (`POWERSHELL_READ_ONLY_COMMANDS`, added on Windows):
about 50 read-only cmdlets (`Get-ChildItem`, `Get-Content`, `Select-String`,
`ConvertTo-Json`, the formatting families, ...) and read-only aliases
(`gci`, `gc`, `sls`, `ft`, ...). **Dangerous aliases are deliberately
absent**: `rm`/`del` (=Remove-Item), `sc` (=Set-Content), `set`, `ac`, `ni`,
`si`, `sp`, `mv`, `cp`, `iex` (Invoke-Expression), `ii`, `tee`, `where`
(Where-Object is a script-block filter, not a command lookup). PowerShell
lookup is case-insensitive, so program names are lowercased first.

### Write-flag guards (whitelisted programs that can still write)

| Program | Guard |
| --- | --- |
| `git` | subcommands restricted to `status/log/show/diff/rev-parse/ls-files/remote/blame/describe`; `branch -D/-d/--delete`, `tag -d/--delete`, `remote add|rm|rename|set-url|set-head|set-branches|prune|update` (rewrites .git/config), and any `--output=FILE` are all rejected |
| `sort` | `-o FILE` (including `-ro`) and `--output` |
| `find` | `-delete/-exec/-execdir/-ok/-okdir/-fls/-fprint/-fprint0/-fprintf` spelled out **in full** — pattern-matching `-fprint*` happened to cover the fprint family but silently missed `-fls` (both GNU and BSD provide it), so `find . -fls OUT` wrote an arbitrary file while classified read-only; `-printf` is deliberately absent (writes to stdout, not a file) |
| `tail` | `-f`/`--follow` (never terminates; only burns the timeout budget) |
| PowerShell | `Get-Help -Online` (egress), `Get-Content -Wait` (never terminates) |

## 5. The child process environment (childEnv)

In Node, `spawn`'s `options.env` **replaces rather than merges** — omitting
it hands the child everything in `process.env`, including the agent's own API
key; measured: `echo $env:AGENT_API_KEY` read the secret back with no
approval prompt at all (CWE-526). The child environment is therefore copied
**by name, from an allowlist**:

- program lookup and the shell itself: `PATH/Path/PATHEXT/SHELL/COMSPEC/SystemRoot/...`
- home and temp: `HOME/USERPROFILE/TEMP/TMP/...`
- locale and terminal (formatting only): `LANG/LC_*/TERM/TZ/NO_COLOR/...`
- Windows shell folders and machine facts tools assume: `APPDATA/LOCALAPPDATA/PROGRAMFILES/...`
- egress proxies: `HTTP(S)_PROXY/NO_PROXY` in both cases

What is excluded is not just secrets but execution-influencing variables
(`LD_PRELOAD`, `NODE_OPTIONS`, ...). A command that legitimately needs some
other variable fails rather than leaks — the intended trade. Extend the list
deliberately, one variable at a time. Note again: this is not a containment
boundary — a secret in a file is still readable.

## 6. Process execution and management (runCommand)

- **Shell resolution** `resolveShell()` (cached): Windows → PowerShell 7's
  install location → `pwsh.exe` on PATH (a Store install only has a
  WindowsApps execution alias) → the OS-bundled 5.1; `cmd.exe` is
  deliberately not used (its dialect, quoting, and OEM code page all differ
  from what the model writes). POSIX → `/bin/bash`, else `sh`.
  `ShellConfig.dialect` is the **only** dialect source the classifier reads
  (never the host platform directly), so the parser and the real shell can
  never disagree.
- **PowerShell encoding preamble**: `[Console]::OutputEncoding` is pinned to
  UTF-8 — measured on a Chinese Windows, both pwsh 7 and 5.1 default to
  gb2312 while the collector decodes UTF-8, so every PowerShell error
  message arrived as mojibake the model could not read. The preamble stays
  on line 1 so error line numbers remain accurate. Legacy native tools
  writing the OEM code page are not fixable from here (their bytes never
  pass through PowerShell's encoder).
- **Invocation**: the command text goes to `-Command`/`-c` as a **single**
  argv element, with Windows quoting done by Node (PowerShell understands
  `\"`). `windowsHide` always; POSIX `detached: true` so the child leads its
  own process group.
- **Timeout and cancellation**: deadline and abort both `killProcessTree` —
  POSIX kills the negative pid (the whole group), Windows runs
  `taskkill /F /T /PID`; failure falls back to killing the direct child.
- **Bounded output buffering**: once accumulation exceeds `2 × 50KB` the
  head is dropped, so memory stays bounded even for `yes`. Before returning,
  `truncateTail`: bytes first (50KB) then lines (2000), the byte cut point
  backed off to a UTF-8 character boundary, never splitting a line,
  truncation honestly reported.
- **Tool-level timeout**: the model may pass `timeout` (seconds, 1–300); the
  tool's `timeoutMs = 305s` exceeds the 300s maximum so the tool's own
  timeout (which kills the tree and reports captured output) always fires
  before the agent's generic one.
- **Result semantics**: non-zero exit → throw with the output; timeout →
  throw with truncated output; abort → "Command aborted."; empty output →
  `(no output)`.

The tool description carries a dialect hint (PowerShell syntax on Windows,
POSIX elsewhere) so the model never wastes a round-trip running `ls` on
Windows.

## 7. Where the approver comes from

The `approver` given to the Agent (or set later via `setApprover`) → each
tool execution's `ToolContext.approve` → the shell tool calls it at the end
of the chain. The CLI's implementation is in doc 08 (`y`/`a`/`n`, `a`
remembers the prefix for the session; `--yes` auto-approves everything;
without a TTY approval is refused). Library users who provide no approver
get deny-by-default for anything off the whitelist — the safe default.

## 8. Known boundaries and an honest limitations list

1. Files written by shell commands are not tracked by the undo journal (the
   command string says nothing about what it will touch) — use git.
2. Whitelisted commands can read any path the user can read — the consent
   mechanism working as intended; containment needs an OS sandbox (not
   implemented).
3. The whitelist is a program-name + flag-guard heuristic; a new flag or
   alias can open a hole — which is why **any** change to
   `isReadOnlyCommand` must add adversarial cases to `test/shell.test.ts`
   (compound commands, pipes, redirections, command substitution, and
   **both dialects** asserted explicitly, never just the host platform —
   that host-derived blind spot is exactly how the PowerShell escaping bug
   stayed invisible).
4. Variables outside the `childEnv` list are invisible inside the shell —
   deliberate; extending requires review.
