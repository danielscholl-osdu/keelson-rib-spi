# keelson-rib-spi

A [Keelson](https://github.com/danielscholl/keelson) rib for the Azure OSDU SPI
program. It adds an **SPI** tab that follows each service as one line from its
upstream GitLab project, through its GitHub fork, to the shared stack
environment, and folds failures into incidents by cause.

Every fact comes from the operator's own `gh` and `glab` sign-ins. Writes go to
GitHub only, as buttons in the side inspector, through one path: the button
carries the targets as the inspector drew them, its confirmation shows the exact
`gh` command, each target is read again and skipped if it changed, and the
outcome is logged and shown in the item's inspector. The rib never writes to
GitLab or touches the cluster, and the `spi_*` tools stay read-only.

## What the tab shows

The tab is one console with five views. Each answers one question in a
sentence, then shows only what supports it. The words come from one pure
briefing (`src/brief/`), which `spi_brief` returns to chat as well.

| View | Question | What it shows |
|---|---|---|
| Today | What needs me now? | A headline naming at most two causes, three facts (environment version, forks with sync stopped, template adoption), up to five focus items with cause, effect and next step, and one line of ready work. |
| Repositories | What is open on each repository, and which of it is ours? | One row per repository (the template, the stack, then each fork) with its issues (human · other: an issue labeled `human-required` waits on a person and shows in red), pull requests and Dependabot bumps, and two security columns read ours · upstream, with the upstream figure faded: **Vulnerabilities** (Dependabot alerts on the libraries a service uses) and **Code scanning** (CodeQL and Scorecard findings in the source itself). Both count critical and high alerts in shipped code only. Selecting a row shows its issues and PRs first, then its alerts at a lower weight, beside the table. |
| Environment | Is the environment dependable? | The running version, the 21-day deployable share and the last proof, over a 24-hour timeline of upgrades, refreshes, smoke runs and maintenance holds. |
| Flow | Where is the upstream sync? | Before a sync starts: what each fork's next sync carries, what it waits on, and a proposed plan (a pilot, waves sized to the lanes, forks held for a SNAPSHOT move or a coming halt). Once it starts: each fork across Sync PR, Cascade, Sync to Main and Main run, with the next step. A row only selects; the plan and each fork open in the inspector. |
| Horizon | What will affect us next? | One row per upstream cause across forks (a halt entry, a Java move, ports owed, the template rollout, the Azure removal deadline), queued commits kept apart from open MRs. |
| Releases | What shipped this month? | One row per calendar month with its headline, numbers and whether its notes are approved. Opening a month gives the release notes and a PDF. |

The Repositories view sorts every open item by properties the rib reads, never
by package or service name. A PR's kind comes from its conventional-commit
title and author. An alert's owner comes from the path: the fork's own tree
(its sync filter's `fork_owned` paths) and the program's repositories are SPI,
files synced from `osdu-spi` are the template's, and everything else came from
upstream and is fixed by a later Sync Upstream. Its reach is shipped, tests
(GitHub's development scope or a test directory) or tooling (deployment and
helper scripts). Dependabot alerts group by package and manifest, with the one
version that fixes the group and any Dependabot PR open on it; code-scanning
alerts group by rule and tree. A Dependabot PR that edits an inherited file is
marked, because merging it diverges the fork from upstream. A critical alert in
SPI-owned shipped code, a vulnerability or a code-scanning alert, also joins
Today as one P1 item per package or rule.

The nav badge counts P0 and P1 items. P0 broke unattended, P1 is a gate or a
decision, P2 is ready work. A red check is classified by its failed step before
it counts: a lane that failed in `Confirm environment deployable` is the
environment's fault and folds under its incident.

The console runs in a sandboxed frame. It can select and open the inspector,
and nothing else: the rib refuses every other action from it, and links and
verbs live in the inspector. Selecting anything and pressing **Open in
inspector** opens a side drawer; selecting a row only selects it. The drawer
leads with the item's claim in the console's words, its priority, class and
age, then one **Next step** card that holds the
recommendation and the buttons that carry it out. Below it, **Why** lists each
fact beside its own link, and **Same cause elsewhere** steps to the same cause
on other forks. Every part comes from the item's class and facts, so a new
kind of failure draws the same way. When an item names both what the fork has
and what upstream needs, the two show side by side. The last action shows once
there is one.
For a sync halt on an unclassified upstream entry, it also reads every other
fork's `.github/upstream-filter.yml` and its upstream tree, and marks each fork
`absent`, `listed`, `unlisted` (its next sync will halt too) or `?` when a read
failed. An item a sweep no longer reads shows as cleared rather than vanishing.

Outside PRs whose workflow runs wait for a maintainer are matched by head: only
runs on a PR's current head count. The inspector gives each PR an **Approve**
button for its waiting runs; the confirmation names the author, the files and
the size, and asks for the PR number when the PR changes anything under
`.github/`. A push to the PR after the inspector drew it refuses the approval.

A template change on `osdu-spi` main that reaches the forks (it touches a
path the forks sync) raises one **Rollout** item, from the first dispatch to
the last green main run. The console card only opens the inspector; every verb
lives there. The Next step card has one primary button, labelled with exactly
what the next press does: **Start rollout** dispatches Sync Template into the
free lanes, **Merge** merges the approved, green PRs in the rollout file's
order, and **Re-run once** re-runs an environment failure after the other lanes
drain. The other verbs sit under it, each saying why it waits. Every press is
confirmed with the forks it touches, each target is read again, and a dispatch
is refused if `osdu-spi` main moved since the board drew it. Below the card are
a lane meter, one row per fork across PR, Validation, Review, Merge and Main
run, the schedule (the next upstream and template syncs), the last green main
run each merge replaced, what reaches the forks, and the release ladder.

A main run that fails after its merge without an `Environment` annotation title
stops the line: merges and dispatches pause, the failing job is linked, and
**Retarget the rollout to main** is offered once a template fix merges. A
failure that carries the title is re-run once instead. When every fork has
merged and every main run is green, the item offers **Run Fleet Release** with
publish off for a day. When main carries only changes no fork syncs, open
template-sync PRs show as the template-sync set, with **Sync all forks** and
**Roll out**. Review stays on GitHub: the rib never approves a PR.

The upstream sync runs from the same inspector. The plan's Next step card
offers one press for the line's next gate: **Prepare** dispatches Sync Upstream
(a sync PR into `fork_upstream`, no lane, not held by the environment), and
**Start** merges a green sync PR, then dispatches Cascade with its tracking
issue instead of waiting for the six-hourly monitor. Start waits while the
environment is held, while the fork's template rollout PR is open, for lane
room shared with the rollout, and for the pilot (the reference fork and every
fork with no toolchain move) to cascade green. A stopped cascade offers
**Re-run cascade** only once a commit lands on `fork_integration`; two forks
stopped on the same first error pause the wave. Each fork's board offers the
same verbs for that fork alone, and a SNAPSHOT move offers **Take it anyway**.
Nothing about the plan is stored: every sweep derives it from GitHub, so a sync
PR the 18:00 schedule opened shows as prepared.

The console's read line (`every source read`) opens the doctor: the sign-in
probes, the GitHub budget, each source's last read, and what the verbs need
(the `gh` token's scopes, Keelson projects for the forks, and the workflow and
gate grants). A source that fails keeps its last good read until it reads again.

A repository's inspector opens from **Open in inspector** on its row. Its
tabs are Issues (human-required first), PRs (pull requests and Dependabot
bumps), Vulnerabilities and Code scanning; each alert tab splits ours, upstream and tests, and every row
links to GitHub. A list GitHub hides from the token, such as
code scanning that is off, says so instead of reading as zero. Secret scanning
is not read.

## Release notes

The Releases view writes monthly release notes for SPI consumers. Each month
has two halves:

- **Computed** from GitHub: every release of the template, the stack,
  `osdu-spi-core-lib-azure` and each fork in the calendar month (UTC), the
  version each moved from and to, the changelog parsed from the release bodies,
  and each service's core-lib-azure and Java read from its poms at the release
  tag. A fork's first release shows as one line instead of the template history
  it inherits, template changes fold into one line, and dependency bumps are
  counted, not listed. PR numbers and links stay out.
- **Written** in a notes file, one per month: the headline, key changes,
  required and informational actions, highlights, known issues and, when set,
  a changelog that replaces the computed one. The file lives in
  `<keelson home>/rib-spi/release-notes/YYYY-MM.json`, or in
  `RIB_SPI_NOTES_DIR` (point it at a git checkout to review the notes as PRs).
  Until its `status` is `approved`, every copy says it is a draft.

A month's inspector has **Read release notes** (the document in the drawer),
**Download PDF**, **Create notes file** while the month has no file,
**Update notes** (**Draft notes** with no file yet) for a draft, and
**Approve notes** for a draft with a headline (**Back to draft** once it is
approved). Approving changes only the file's `status`, in place. Update runs
an agent turn on the latest release read: it keeps sentences that are still
true, folds in what landed since, and writes the result as a draft after
saving the previous file in `release-notes/.history/`. The PDF is
printed by a headless Chrome, Chromium or Edge (`RIB_SPI_CHROME` overrides the
binary) into `~/Downloads` (`RIB_SPI_PDF_DIR` overrides it); the console frame
cannot download, so the file is written by the rib. Chat can draft or revise a
month with `spi_release_notes` instead; either way, review the file, then
approve it in the inspector.

`bun dev/states.ts [out-dir]` writes the rollout states a live sweep may not
show (in flight, stopped, an environment failure, done) as facts files.
`RIB_SPI_FACTS_FILE` replays one: the rib draws it at its own sweep time, never
sweeps, and refuses every write.

`bun dev/releases.ts [YYYY-MM] [out-dir]` reads the releases live and writes
that month's html and PDF.

## Services

The fleet is the `forks:` list in `Azure/osdu-spi-stack`
`ops/environments/shared.yaml` on main, read at the start of every sweep, so a
fork onboarded there appears without a rib change. Each fork's upstream GitLab
project comes from the rib's identity map in `src/config.ts`, else from the
fork's `UPSTREAM_REPO_URL` variable; a fork with neither is named in the doctor
and not followed. A fork with `SYNC_MODE=mirror` (ADR-039) never takes Sync all
forks or Roll out, and neither does one whose variables the rib has never been
able to read. If the stack cannot be read, the last good list stays in use
and the doctor shows its age. `RIB_SPI_SERVICES_FILE` pins the fleet to a JSON
list instead, offline.

## Pacing and failure classes

`.github/fleet/rollout.json` in `Azure/osdu-spi` (schema 1) is read with the
stack file; `RIB_SPI_ROLLOUT_FILE` reads a local copy instead. The rib reads
its `lanes` and `ordering`.

- `lanes` caps Sync all forks, Roll out and Re-run lanes: a press tops the forks
  holding a lane up to the cap and leaves the rest for the next press. A lane is
  a Sync Template run, an open PR whose head Validation run has not concluded, a
  main Validation run, or a fork the rib wrote to in the last three minutes.
  `RIB_SPI_LANES` overrides the cap, and a local `RIB_SPI_ROLLOUT_FILE` applies
  even when GitHub cannot be read. With no file, or a schema the rib does not
  read, the buttons are unpaced. Until fork runs and PR checks have been read
  once, a paced press starts nothing.
- A failed run is an environment failure when any of its failed jobs carries a
  failure-level annotation titled `Environment`, which validate.yml gives its
  shared-environment timeouts. That reads as re-run the failed jobs once, after
  the other lanes drain; on attempt 2 or later, and for every other failure, it
  reads as stop the line and fix it forward in the template. Nothing is re-run
  on its own.
- `license/cla` on a PR an app opened and a skipped `Docker Build` are taken out
  of PR state before anything counts them.

**Dismiss** in any item's inspector writes `dismissed.json` in the rib's data
directory. The item leaves the queue and the badge until its inputs (heads,
runs, failures, entries) change. The doctor lists dismissed items, and each one's
inspector has **Bring back**.

## Tools and agent

`spi_brief`, `spi_watchstand`, `spi_incidents`, `spi_line`, `spi_stack`,
`spi_template`, `spi_prs`, `spi_issues`, `spi_security` and `spi_release_notes` answer from the same sweep the console renders, so chat, workflows and
Keelson MCP clients get the same counts as the tab. The **SPI Watch Officer**
agent answers from those tools.

## Install

You need `gh` and `glab` signed in (`glab` to `community.opengroup.org`).

```bash
keelson rib add https://github.com/danielscholl-osdu/keelson-rib-spi
keelson restart
```

To work on the rib, install it from a clone instead; edits then need only a restart:

```bash
git clone https://github.com/danielscholl-osdu/keelson-rib-spi.git
cd keelson-rib-spi && bun install
keelson rib add "$PWD"
keelson restart
```

`bun dev/sweep.ts` runs one live sweep outside Keelson, prints the verdict,
queue and lines, and checks the console frame and every inspector against the
host's render gate.

## Cadence

One in-process sweep every 5 minutes, whether or not the tab is open, so the
badge stays current. GitLab and the security alerts are read every 30 minutes, and a refresh or upgrade
in flight is re-read every 15 seconds. Completed jobs, compares and file reads
never change, so they are read once and kept in the rib's data directory.
