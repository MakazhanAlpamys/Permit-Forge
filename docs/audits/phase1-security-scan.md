# Phase 1 — Security Scan (.claude config / hooks / MCP) (2026-05-21)

Scope: PermitForge repository at `c:\Users\tokmo\PermitAi\Emirate-Forge-main`.
Methodology: enumerate Claude Code harness configuration (.claude/, MCP, settings,
hooks, agents, slash commands) and project-level prompt files (CLAUDE.md,
LOCAL_NOTES.md) for misconfigurations, prompt-injection vectors, unsafe shell
hooks, blanket permission allowlists, and embedded secrets.

## Files Found

Harness/config files actually present in repo:

- `c:\Users\tokmo\PermitAi\Emirate-Forge-main\.claude\scheduled_tasks.lock`
  (runtime lock file only — session id + pid + timestamp; no executable config)
- `c:\Users\tokmo\PermitAi\Emirate-Forge-main\CLAUDE.md` (project instructions)
- `c:\Users\tokmo\PermitAi\Emirate-Forge-main\LOCAL_NOTES.md` (gitignored
  trust-boundary notes referenced from CLAUDE.md)
- `c:\Users\tokmo\PermitAi\Emirate-Forge-main\.gitignore` (cross-check — confirms
  `.claude/` and `LOCAL_NOTES.md` are gitignored)

Harness/config files explicitly NOT present (searched and confirmed missing):

- No `.claude/settings.json`
- No `.claude/settings.local.json`
- No `.claude/agents/` directory or agent definitions
- No `.claude/hooks/` directory or hook scripts
- No `.claude/commands/` slash-command definitions
- No `.mcp.json` at any depth inside the project tree (only node_modules paths
  matched, which are vendored and out of scope)
- No `claude.json` at any depth
- No project-root `settings.local.json`

Note: a single `settings.local.json` exists at
`node_modules\es-abstract\.claude\settings.local.json` — third-party package
artifact, not consumed by this project's harness, out of scope.

## Critical findings

None.

## High findings

None.

## Medium findings

None.

## Low findings

### L1 — `.claude/scheduled_tasks.lock` is a Claude runtime artifact in a working tree (informational)

File: `c:\Users\tokmo\PermitAi\Emirate-Forge-main\.claude\scheduled_tasks.lock:1`
Content: `{"sessionId":"1bcf50a8-0f20-43d8-b8b8-94e1d74f9c5f","pid":2972,"procStart":"639149024364411080","acquiredAt":1779289308954}`

- Risk: none directly — file is gitignored via `.gitignore:53` (`.claude/`) so it
  will not leak via the public repo. It exposes only a local session id and pid
  to anyone with filesystem access to the working tree, which is the local
  developer.
- Action: none required. Confirmed not committed; confirmed not consumed as
  configuration (purely a Claude Code internal cron/scheduler lock).

### L2 — `CLAUDE.md` is committed and acts as a high-trust prompt source (informational)

File: `c:\Users\tokmo\PermitAi\Emirate-Forge-main\CLAUDE.md`

- Risk: `CLAUDE.md` is read by Claude Code on every session and is treated as
  high-priority project instructions. Anyone who can push to `main` can inject
  instructions that will steer future Claude sessions on every collaborator's
  machine. This is a supply-chain prompt-injection surface that applies to any
  repo using project-level CLAUDE.md, and is not specific to this codebase.
- Content review: file contains only architecture documentation, command
  cheat-sheet, route table, module map, and environment-variable names. It does
  **not**:
  - instruct Claude to disable safety checks
  - instruct Claude to auto-execute risky commands without confirmation
  - instruct Claude to read or exfiltrate `.env.local` / secrets
  - reference shell hooks or `pre-commit`-style auto-runners
  - contain embedded credentials, tokens, or service-role keys
- Embedded commands are all read-only or standard dev commands
  (`npm run dev`, `npm test`, `npx tsc --noEmit`, `npx vitest run`) — safe.
- Action: none required. Recommend keeping branch protection on `main` and PR
  review on any `CLAUDE.md` change, but that is a general policy point, not a
  finding against the current contents.

### L3 — `LOCAL_NOTES.md` contains architectural weakness disclosure (informational, by-design)

File: `c:\Users\tokmo\PermitAi\Emirate-Forge-main\LOCAL_NOTES.md`

- Content review: the file documents (intentionally) that
  - `createAdminClient()` uses `SUPABASE_SERVICE_ROLE_KEY` and bypasses RLS
    (`LOCAL_NOTES.md:9-14`)
  - middleware **fail-opens** on Supabase fetch error for block-status checks
    (`LOCAL_NOTES.md:22-27`)
  - `SUPABASE_JWT_SECRET` is the RLS activation prerequisite
    (`LOCAL_NOTES.md:30-44`)
- Embedded secrets check: NO credentials, tokens, JWT secrets, service-role
  keys, SMTP passwords, or Gemini API keys appear in the file. Only the **names**
  of env vars are mentioned. This is correct.
- Gitignore check: `.gitignore:44` lists `LOCAL_NOTES.md` — confirmed excluded
  from version control. Behaviour matches its own self-description at
  `LOCAL_NOTES.md:46-53`.
- Risk: low. The file is local-only and contains weakness wording that would
  benefit an attacker if leaked, but the gitignore + the self-documented
  rationale show the project is handling this intentionally. The file is safe
  for Claude to read in a local session because the session is on the same
  trust boundary as the developer's filesystem.
- Action: none required.

## Notes

### Permission allowlists / blanket Bash allows
Not applicable — no `settings.json` or `settings.local.json` exists at project
level. Therefore there are zero project-scoped permission entries that could
be over-broad. No `Bash(*)` or wildcard write permissions are configured in
this repo. Permission behaviour is fully governed by the user's global
`~/.claude/settings.json` (out of scope for this scan).

### Hooks
No project-level hooks are defined. The `hooks/` directory at repo root
(`use-chat-stream.ts`, `use-csrf-action.ts`, `use-ingestion-stream.ts`) is the
Next.js / React custom-hooks directory for the application, NOT Claude Code
harness hooks. Zero risk of shell-command injection via Claude hooks because
there are no Claude hooks.

### MCP servers
No `.mcp.json` or `claude.json` is present. No project-scoped MCP servers are
declared. No inline credentials in MCP config exist because no MCP config
exists. Any MCP servers active during a session are inherited from the user's
global Claude configuration (out of scope).

### Agents / slash commands
No `.claude/agents/` and no `.claude/commands/` exist. No project-defined
sub-agents with broad tool access; no project-defined slash commands that
could execute arbitrary code.

### .env files referenced from hooks/settings
N/A — no hooks/settings exist to reference .env files. `CLAUDE.md:248-259`
documents the *names* of required env vars (`SUPABASE_SERVICE_ROLE_KEY`,
`GEMINI_API_KEY`, `JWT_SECRET`, `SMTP_PASS`, etc.) but never dumps their
values. No config dumps env vars to logs.

### Diploma-scope constraint
`.env.local` exists at repo root (per Glob output) and is properly gitignored
via `.gitignore:35` (`.env.local`). Per diploma scope, secrets sitting in the
working directory are **wontfix-diploma**. Confirmed: no `.claude` config file
exports, prints, or otherwise routes the contents of `.env.local` into Claude
Code's view — there are no `.claude` config files at all, so this risk is
trivially zero for the harness layer.

### Conclusion

The project has **effectively no project-level Claude Code harness
configuration** — only a runtime lock file under `.claude/` and the two
prompt-source files (`CLAUDE.md`, `LOCAL_NOTES.md`). The lock file is not
configuration. The two prompt files were inspected line-by-line and contain
no instructions to disable safety, no auto-execute directives, no embedded
secrets, and no shell injection vectors. There is **no project-scoped
harness misconfiguration** to remediate at this layer.

If a hardening pass is desired in future, the project could optionally add an
explicit `.claude/settings.json` with a tight `deny` list to defend against an
attacker who manages to add a malicious `CLAUDE.md` instruction in a future PR
— but absent such a settings file, the harness is governed by Claude Code
defaults plus the user's global settings, which is the standard posture.

No project-level harness config to audit beyond the runtime lock file and the
two prompt sources — scan complete.
