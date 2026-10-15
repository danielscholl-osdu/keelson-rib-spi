# Copilot code review: @keelson/rib-spi

A [Keelson](https://github.com/danielscholl/keelson) rib, Bun + TypeScript,
that watches the Azure OSDU SPI program: the service forks on GitHub, their
upstream projects on GitLab, the `Azure/osdu-spi` template and the shared
stack. It reads everywhere and writes to GitHub in one place, so the review
weight sits on that write path and on what the console frame may do.
`AGENTS.md` has the architecture and invariants.

## How to review

Be terse and cite `file:line`. A few high-signal findings beat breadth. This is
single-operator local software: skip speculative scale, multi-tenant and
micro-optimization concerns. No poems, jokes or emoji.

## Comments

Do not ask for docstrings or comment coverage. Flag a comment only when it
narrates the PR or restates the code; a missing comment is not a finding.

## Invariants to flag when a change breaks them

- **Reads everywhere, writes in one place.** Collectors, tools and composers
  call `gh` and `glab` with `api` (GET) and `auth status` only, through
  `src/forge.ts`. Flag a `-X`/`--method` other than GET, a `gh` subcommand that
  mutates, or any `glab` write outside `src/act/`. Flag a write in `src/act/`
  that is not a registered verb going through `act()` in `src/act/path.ts`.
- **Every write is revalidated.** A verb's binding is stamped at draw time and
  each target is read again before the write; a changed target is refused.
  Flag a verb that bypasses the re-read in `act()` (`src/act/revalidate.ts`),
  writes to a target not named in its binding, or proceeds after a target
  changed.
- **GitHub only.** Flag a write to GitLab, the cluster or anything other than
  the GitHub repositories in `src/config.ts`.
- **No token is stored.** The rib uses the operator's `gh` and `glab` sign-ins
  per call. Flag a token or `auth status` output reaching a log, the data
  directory, a board, a tool result or an error message.
- **The console frame never acts.** `rib:spi:console` is html in a sandboxed
  frame and its markup is untrusted. Flag `onAction` (`src/index.ts`) accepting
  anything but `inspect` from a `canvas-html` origin, or a verb button drawn in
  the console instead of the inspector.
- **Escaping.** PR titles, branch names, commit messages, job logs, annotations
  and issue bodies are attacker-controlled. Flag one reaching console html
  without escaping, an exec argument list unchecked, a request path without
  encoding, or a filesystem path.
- **Unmeasured is not zero.** A failed read keeps the last good data and its
  age; an unknown value is `null` and draws as "?". Flag a default of 0, `[]`
  or "ok" standing in for a failed or missing read, or a `null` adding to the
  queue.
- **Ownership comes from paths, not names.** Flag sorting or classifying an
  alert or PR by a package, rule or service named in code instead of the
  fork's sync filter, the template's synced paths and the repository.
- **Pure layers stay pure.** `src/model/` and `src/brief/` take facts and a
  clock; `src/boards/` composers take the briefing. Flag exec, HTTP, disk or
  `Date.now()` added there, or `src/brief/` importing from `src/boards/`.
- **Fail closed.** Every key validates through `expectView`. Flag a new key
  without a validator.
- **Fixtures carry no personal logins.** Flag a fixture, test or doc that adds
  what looks like a real person's login or email instead of placeholders such
  as `upstream-author-1` or `contributor-a`.
- **Attach only through the `Rib` contract** from `@keelson/shared`. Flag
  reaching into harness internals.

## What not to flag

- Missing docstrings or comments.
- Tests in `test/` using `bun:test` and the recorded sweep in `test/fixtures/`.
- Real repository names and GitLab project paths; they are public and come from
  `src/config.ts`.
- The absence of an abstraction; this repo waits for a second caller.
