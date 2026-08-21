# atk — Skill Collection Management (user-level install/uninstall)

`atk` is a standalone, zero-runtime-dependency CLI that does two things: **manages skill-collection repositories** and **installs/uninstalls enabled collections into the user-level skill directories of your local AI clients**, following a scope model.

- **Collection** = a git repository or local directory whose content contract is `skills/<name>/SKILL.md` (optional `atk.manifest.json` declaring dependencies/shared resources)
- **Scope install model**: `scope` only decides the default at `add` and auto-install behavior — `global` registers and installs immediately (`enabled=true`); `scoped` registers but stays disabled (`enabled=false`, install only after an explicit `enable` + `apply`)
- **User-level single-layer resolution**: all enabled collections are merged by `priority`; on a same-name conflict the higher `priority` wins (only the winner is installed); `status` reports overridden skills
- **Boundaries**: operates on **user-level** directories only (no project-level install / no project `.atk.json` / no layered resolution); never writes project context (AGENTS.md is a separate approach); never produces skill content
- Config is plain JSON (`~/.config/atk/collections.json` + user-level `~/.config/atk/state.json`), copyable across machines; `atk sync` restores

## Install

**Manual install** (recommended):

```bash
npm install -g atk            # after npm publish, from anywhere
# from source (run in this repository root):
npm install -g .              # or: git clone this repo && npm install -g <repo path>
atk --version
```

Requires Node ≥ 18. atk depends on no third-party packages and reads no other tool's configuration.

**ai-toolkit integration (optional)**: on a machine with ai-toolkit, run `node setup.js --install-atk` to auto-register the official collection, migrate legacy config, and hand over management (see the ai-toolkit repo).

## Quick Start

**Step 1 — register a collection** (git URL or local directory both work):

```bash
atk collection add ~/my-skills --name my-skills --scope global      # global: installs on register
atk collection add https://github.com/your/skills.git --name team-x # default scoped: enable to install
```

> `~/.atk/personal/`, if present, automatically participates as a `personal` scoped collection (implicit — not written to the registry); it also needs `enable` before install.

**Step 2 — inspect:**

```bash
atk collection list
atk status          # read-only: registered collections / effective set / enabled / name conflicts / full view
atk status --json   # for scripts/AI; includes the `registered` full view (every registered collection × skill detail, enabled or not)
```

**Step 3 — enable / disable (= install / uninstall):**

```bash
atk collection enable team-x      # mark enabled (takes effect at next apply)
atk collection disable team-x     # mark disabled (apply cleans links under safety rules)
```

**Step 4 — apply** (writes to disk; required after any enable/disable):

```bash
atk apply --dry-run   # preview links to create and items to clean (zero writes)
atk apply             # apply: symlink the effective set into the 5 clients' user-level dirs
```

Back to your AI client after applying (see Client Matrix).

## Unified Management (TUI, recommended for daily use)

With ai-toolkit installed (`node setup.js --install-atk`, or on any machine that has it), `node setup.js --skills` is the graphical unified management entry covering all operations above:

1. **Best practices**: pick one of V5 / V8 / Comi (ai-toolkit-side logic; atk does not manage bestPractices);
2. **Collection panel**: one-click enable/disable for every **registered collection** (official/personal/any scope, including disabled ones); your personal library `~/.atk/personal/` is toggled here too; inline shows scope/skill count/missing directory;
3. **Skill panel**: Enter on a collection → **auto-focuses that collection's skills** (filter word = collection name; Backspace clears to see all); unchecking = global disable (same semantics as `atk defaults disable`); auto-runs `atk apply` on save.

Cascade: collection-level toggle = `atk collection enable/disable` (effect = install/uninstall the whole collection); skill-level = `atk defaults disable/enable` (effect = fine-grained disable of a single skill name). Non-TTY (CI/scripts/atk missing) degrades gracefully to plain delegation — no interaction, no hangs.

## Typical Use Cases

**Case 1 — official baseline + team/personal collections**

```bash
atk collection add <official repo> --scope global --name official-skills  # org baseline, installs on register
atk collection add <team repo>    --scope scoped --name team-skills       # enable on demand
atk collection add ~/my-skills    --scope scoped --name personal          # personal skills (or auto-detected ~/.atk/personal/)
atk collection enable team-skills && atk collection enable personal
atk status                                                               # inspect resolution & conflicts
```

**Case 2 — same-name takeover (priority control)**

When two enabled collections both contain `coding`, the higher `priority` wins and is installed; `status` reports the overridden item. After disabling the higher-priority collection, `apply` re-points the link to the new winner:

```bash
atk collection add A --scope global --priority 100   # A's coding wins
atk collection add B --scope global --priority 200   # B's coding beats A
atk collection disable B && atk apply                # link re-points back to A's coding
```

**Case 3 — one-shot restore for new members / new machines**

```bash
npm install -g atk
cp ~/.config/atk/collections.json <new machine equivalent>   # plain JSON, copy restores registry
atk sync          # auto-clone git collections + apply, one-shot layout restore
```

**Case 4 — team skills stay current automatically**

```bash
atk sync    # fetch + ff-only pull of all git collections and re-apply; dirty workspaces skipped; offline falls back to last local copy
```

## Command Reference

| Command | Description |
|---------|-------------|
| `atk status [--json]` | State snapshot (read-only; `--json` for scripts/AI; `registered` is the **full view**: every registered collection × skill detail × on/off + scope, enabled or not) |
| `atk apply [--dry-run]` | Two-phase apply: plan/validate first (zero writes), then execute (idempotent, partial failures converge on re-run) |
| `atk sync [--no-apply]` | Pull all git collections (fetch + ff-only; dirty/detached skipped) and re-apply |
| `atk collection add <git-url\|path> [--scope] [--name] [--priority] [--branch]` | Register a collection (git type clones to `~/.atk/collections/<name>/`; global installs on register, scoped defaults to disabled) |
| `atk collection remove/enable/disable/list/export` | Collection lifecycle (enable/disable support `--dry-run` preview; enable=install, disable=uninstall) |
| `atk defaults disable\|enable <skill>` | **Global per-name disable/enable**: after merging all enabled collections, delete/restore by skill name, regardless of origin (official and personal same-name skills disable together); turn whole collections on/off with `atk collection enable/disable` |
| `atk validate collection <dir>` | Collection health check: structure/broken links/required dependencies/unknown schema, leveled output |

## Client Matrix (user-level only)

| Client | User-level directory |
|--------|----------------------|
| Claude Code | `~/.claude/skills` |
| OpenCode | `~/.config/opencode/skill` |
| CC Switch | `~/.cc-switch/skills` |
| Codex | `~/.agents/skills` |
| DSH | `~/.dsh/skills` |

Same-name resolution follows "higher priority wins": each directory only gets the winner's link; atk does not promise per-client dedup (each client uses its own loading behavior.

## Collection Content Contract

```
my-skills/
├── skills/
│   ├── alpha/SKILL.md            # skill: frontmatter must contain name
│   └── beta/SKILL.md
└── atk.manifest.json             # optional: dependencies & shared resources
```

```json
{
  "sharedResources": [{ "name": "workflow", "path": "skills/WORKFLOW.md" }],
  "dependencies": { "review": ["skills/merge-review/SCORING.md"] }
}
```

- missing `dependencies` = required dependency missing → apply plan fails (zero writes)
- missing `sharedResources` = optional → warning, continue

## Safety

- Deletes only symlinks atk created: state record + `readlink` lexical check (realpath verify when target exists; broken links can be cleaned); user-created files are never deleted
- Two-phase apply: plan validation failures = zero writes; partial execution failures record only the completed items, next apply converges
- Registry/state writes: temp file + rename atomic replace
- sync is non-interactive (never waits for credentials), 60s timeout, process lock against concurrency

## FAQ

- **Scoped collection not effective after add**: since M3, scoped registration means "disabled" — run `atk collection enable <name>` then `atk apply`.
- **Want to disable official skill but keep the same-name personal one**: disable is global by name (`defaults disable` kills the personal version too; `collection disable` kills the whole collection). Same-name selection is controlled by priority: the personal library's priority is higher than official (default p2 > p1), so the official one yields automatically — no disabling needed.
- **Skills deleted upstream cause broken links**: lexical cleanup on disable/remove; won't hang even with invalid links.
- **Which same-name skill is installed**: merge all enabled collections by priority; higher wins (only the winner is installed); `atk status` shows source and conflicts.