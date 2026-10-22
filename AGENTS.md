# AGENTS.md

Project guidance for coding agents working in this repository. It records what
stays true across changes: the contract, the commands, the patterns and the
invariants. Inventories (which keys, regions and tools exist) live in the code.

## What this is

`@keelson/rib-spi` is a rib for [Keelson](https://github.com/danielscholl/keelson)
that watches the Azure OSDU SPI program: five service forks on GitHub, their
upstream projects on GitLab, the `Azure/osdu-spi` template and the shared stack
`Azure/osdu-spi-stack` runs. Slice 1 (Watch) is built: remote mode, read-only.
Slice 2 (Act on the queue) adds verbs on top of one action path.

## Commands

```bash
bun install
bun test                 # model, briefing, console and contract coverage on a recorded sweep
bun run typecheck        # tsc --noEmit
bun run check            # Biome lint + format
bun dev/sweep.ts         # one live sweep with your gh and glab, console and inspectors validated
bun dev/releases.ts      # one live release read, then a month's notes as html and PDF

keelson rib add "$PWD"   # install into the keelson home, then `keelson restart`
```

A change needs `bun run check`, `bun run typecheck` and `bun test` green.

## Architecture

- `src/collect/` reads: one aliased GraphQL query for PRs, checks, issues,
  markers and the lane ledger; REST for workflow runs, jobs, annotations, logs,
  compares and Dependabot and code-scanning alerts; `glab` for upstream heads
  and compares. Collectors only GET.
- `src/sweep.ts` runs the collectors on a timer, keeps each area's last good
  read beside its last error, caches immutable reads (completed jobs, compares,
  files at a sha) and persists both to the rib's data directory.
- `src/model/` is pure: facts and a clock in, lines, stack state, template
  currency and the ranked queue out. Every region and tool reads this one model.
- `src/brief/` is pure: the model, the doctor and a clock in, the briefing out.
  It decides the words (headline, focus with cause, effect and next, themes
  across forks, and `readItem` for one item); the console, the inspector and
  `spi_brief` only show them. It never imports
  from `src/boards/`; shared wording lives in `src/brief/words.ts`.
- `src/boards/` draws: the console html from the briefing (`console.ts`), the
  side inspector boards, and the badge. No I/O in a composer.
- `src/act/` is the only code that writes: the verb registry, the binding a
  button carries, revalidation, the action log and readiness for the doctor.
- `src/notes/` is the release notes' local files: the reviewed notes file per
  month and the PDF a headless browser prints. The month's facts come from
  `src/collect/releases.ts` (its own hourly read) through
  `src/model/releases.ts`, `src/brief/release.ts` and `src/boards/release.ts`.

## Invariants

- **Reads everywhere, writes in one place.** Collectors, tools and composers call
  `gh` and `glab` with `api` (GET) and `auth status` only. A write happens only in
  `act()` (`src/act/path.ts`): a registered verb, a binding stamped at draw time,
  each target read again and refused if it changed, the outcome logged, then a
  resweep. Writes go to GitHub only, never GitLab or the cluster. No token is
  stored; the operator's sign-ins are used per call.
- **Local files only from the inspector.** Creating a month's notes file,
  approving it and writing its PDF are local writes, never forge writes; they
  run from inspector buttons. Approve and Back to draft change only its
  `status`, in place. Only Update replaces a notes file's words: an agent turn
  with no tools revises the draft, the rib validates it against the schema,
  keeps the old file in `.history/` and writes only if the file is still the
  draft it read. Approved notes are never replaced.
- **The console frame never acts.** `rib:spi:console` is html in a sandboxed
  frame, so its markup is untrusted: `onAction` accepts only `inspect` from a
  `canvas-html` origin, and every verb stays a button in the inspector drawer.
- **An item clears only when a sweep reads the change.** A verb never removes
  a queue item itself.
- **Unmeasured is not zero.** A failed read keeps the last good data and its
  age; a value the rib cannot see is `null` and draws as "?", and adds nothing
  to the queue.
- **Classify before counting.** A red check is attributed by its failed step and
  reason (ENV, TEST, HALT, TOOLCHAIN, CONFLICT, POLICY, INFRA, BUILD). ENV
  failures fold under the stack incident that explains them.
- **Newest check wins.** Only the newest check per workflow and name counts; a
  skipped lane never hides a real result.
- **Ownership comes from paths, not names.** An alert or PR is sorted by the
  fork's sync filter (`fork_owned`), the template's synced paths and the
  repository, never by a package, rule or service named in code.
- **Identity is configuration.** Services come from `src/config.ts`, never from
  derived names.
- **Local time.** Stamps print in the machine's local zone, the zone the host
  draws timelines and clocks in; a header chip names the zone once.
- **Fail closed.** Every key registers a validator (`expectView`); a bad board
  is refused by the host before it renders.

## Comments

Default to none. Add one only for a non-obvious why. One short line.

## Conventions

- Conventional commits.
- Test fixtures come from a real sweep with personal logins replaced.
