# keelson-rib-spi

A [Keelson](https://github.com/danielscholl/keelson) rib for the Azure OSDU SPI
program. It adds an **SPI** tab that follows each service as one line from its
upstream GitLab project, through its GitHub fork, to the shared stack
environment, and folds failures into incidents by cause.

Every fact comes from the operator's own `gh` and `glab` sign-ins. Writes go to
GitHub only, as verbs on the board, through one path: the button carries the
targets as the board drew them, its confirmation shows the exact `gh` command,
each target is read again and skipped if it changed, and the outcome is logged
and shown in the item's inspector. The rib never writes to GitLab or touches the
cluster, and the `spi_*` tools stay read-only.

## What the tab shows

| Region | Question | Built from |
|---|---|---|
| Needs attention (banner) | What needs a person, ranked by what it blocks? | the incidents and gates the sweep finds |
| Environment | Can forks deploy? Is the environment on the latest release, does it deploy from nothing, and does the running one keep proving itself on schedule? | `shared.yaml`, stack releases, the lifecycle workflows' schedules, and every env-refresh, env-upgrade, smoke and sweeper run with its jobs and steps |
| Engineering system | What is the newest `osdu-spi` release, which forks run it, what waits on the template itself, and where does each fork's rollout stand? | `osdu-spi` releases, tags, compares and open and merged PRs; each fork's marker, template-sync PR, Sync Template runs and schedule, and open Dependabot PRs |
| Services | Where is each fork with upstream, the osdu-spi template and its release, how long does change wait at each gate, and how has each line moved over 21 days? | open and merged PRs, checks, open and closed halt issues, `Upstream-Sha` trailers, GitLab master, `.github/.template-sync-commit` on main and at each template-sync PR head, template compares, Sync Template runs |

The banner's pill is the tab's verdict (`BLOCKED`, `ATTENTION`, `MOVING`,
`CONVERGED`) and the nav badge counts P0 and P1 items. P0 broke unattended, P1
is a gate or a decision, P2 is ready work. A red check is classified by its
failed step before it counts: a lane that failed in `Confirm environment
deployable` is the environment's fault and folds under its incident.

A banner row opens its inspector in a side drawer beside the tab, and the next
row swaps it in place. The inspector shows the item's class, its cause line by
line with links, the effects folded under it, and a link to the item on GitHub.
For a sync halt on an unclassified upstream entry, it also reads every other
fork's `.github/upstream-filter.yml` and its upstream tree, and marks each fork
`absent` (upstream has no such entry), `listed`, `unlisted` (its next sync will
halt too) or `?` when a read failed. While the environment is in an incident,
each attempt row opens the same environment inspector. An item a sweep no
longer reads shows as cleared rather than vanishing.

Outside PRs whose workflow runs wait for a maintainer are matched by head: only
runs on a PR's current head count, and runs on heads since pushed past are
named as superseded. The inspector lists each PR with its author and diff size
and gives it an **Approve** button for its waiting runs. The confirmation names
the author, the files and the size, and when the PR changes anything under
`.github/` it asks for the PR number to be typed first. A push to the PR after
the board drew it refuses the approval.

The banner's last row is the doctor: `Doctor · all clear` while every source
reads, with the sign-in probes, the GitHub budget and each read's age behind its
disclosure. When a sign-in, the budget or a read fails, that row moves above the
queue, amber or red, and names what failed; every panel keeps that source's last
good read until it reads again. The disclosure ends with three Act lines: the
`gh` token's `repo` and `workflow` scopes, how many of the five forks and
`osdu-spi` have a Keelson project (matched by git remote), and which of the rib's
workflow and gate grants `config.json` holds. They never raise the doctor; a
verb that cannot run says why on its own button.

The Environment panel has three tiles in fixed places. **Running** is the
version on the environment against the declared one and the newest release,
with when it landed and how long after its release, against the usual lag.
**Greenfield** is the last smoke run, a fresh cluster brought to green, with its
duration against the usual and the next scheduled run. **Brownfield** is the
last refresh, the running environment re-proved in place, the same way. A
refresh that failed before a later green upgrade reads amber, since the upgrade
proved the stack after it.

When forks cannot deploy, Brownfield turns into the time since (`MAINTENANCE
MODE` when the hold is the reason), and the panel adds the stage the latest
attempt is in or stopped at, a timeline since the last green run, and every
attempt in order, cancelled ones included. A step that runs past every green run
of its kind turns amber. Greenfield stays where it is, so a green fresh deploy
beside a red in-place run points at the upgrade path rather than the release.

Under the tiles, 21 days of history are one cell per UTC day, grouped as
greenfield (smoke), brownfield (behind latest, upgrade, refresh) and
housekeeping (sweeper). A day's cell is its newest run: green, red, amber for
cancelled, blue while running. A scheduled day with no run is an outlined red
cell, and a day with nothing due is an empty outline. Green days are a faint
tint, so color goes to exceptions. Behind latest is a column per day as tall as
the number of releases the environment trailed at day end. Sweeper folds to one
line while every run in the window is green. Times are local, the zone Keelson
draws its timelines and clocks in; days are UTC because the schedules are.

The Engineering system panel treats the `osdu-spi` template as the one shared
input it is. **Release** is the newest release and how many forks are on it,
whether main is the release, and the version an open release PR will cut.
**Rollout** is the oldest open template-sync PR, what the open set carries, the
next scheduled Sync Template and the usual merge wait. **Template PRs** is what
waits on `osdu-spi` itself, Dependabot and the release PR included, and what
merged since the release. A template commit is named by the newest release it
contains, `v1.2.0 +14`, so forks and PRs read against releases even after a
newer one is cut.

Under the tiles, the release ladder has one step per fork position, newest
first: how many changes it brings, what they reach in a fork (images, actions,
workflows, settings, fork resources), and how far it has spread. A fork whose
PR does not reach a step counts as having no PR for it, so a fresh release
reads `0 of 5 · no PR carries it yet` until Sync Template moves the PRs. A step
opens its inspector with the change titles and the compare. The rollout table
is one row per fork: where it is, its template-sync PR and what it carries,
checks (a failure the environment caused reads as red on the stack), review,
the last Sync Template run, and open Dependabot PRs. A link opens every open
template-sync PR in one GitHub list for review.

Two buttons roll a release out. **Sync all forks** runs `gh workflow run
sync-template.yml` on each fork behind `osdu-spi` main whose PR does not already
carry it, so the PRs move to the release now instead of at the next scheduled
run; a fork with Sync Template already running is skipped, and one that starts
running after the board drew it is refused. **Roll out** merges every
template-sync PR that is approved, green and unchanged since the draw, with a
merge commit as those PRs have always landed, and its confirmation asks for the
number of PRs it merges. Each PR merges on its own, and the panel names each PR
held back and why (needs review, fails a check, red on the stack, a draft,
conflicts). Review stays on GitHub: the rib never approves a PR.

The Services panel opens with two tiles. **Upstream** and **Release** show
the oldest item their gate holds now and the 21-day median wait: upstream (a
sync PR opened to the integration PR merged after it) and release.

The table is one row per fork, worst first, one column per station of the line
(upstream, sync, cascade, main, release, lane) plus template. A clear station
is a green dot. A station that waits or stops carries its position and age:
blue ◷ where it waits, amber or red ✕ where it failed, and the stations a
stopped sync starves are hollow. Release and template always show their
version, `v1.3.1 → v1.3.2 · #175` while a release PR waits. The last column is
21 days of the line, the worse of its upstream and template tracks each day.
The header turns red only for a red main, since a halt or a failing PR is work
to do while the service still builds. Once four or more forks are current on
every station, they fold into one row.

Below the table, two fleet lanes, upstream and template, give a column per day
as tall as the forks not caught up, so the history keeps its height as forks are
added. They share the Environment history's columns, so one day reads down the
whole tab. A template release shows as a band across the template lane, and its
width is the review wait.

## Services

| Service | Fork | Upstream project |
|---|---|---|
| partition | Azure/osdu-spi-partition | osdu/platform/system/partition |
| entitlements | Azure/osdu-spi-entitlements | osdu/platform/security-and-compliance/entitlements |
| legal | Azure/osdu-spi-legal | osdu/platform/security-and-compliance/legal |
| schema | Azure/osdu-spi-schema | osdu/platform/system/schema-service |
| file | Azure/osdu-spi-file | osdu/platform/system/file |

storage, indexer and search are listed as planned until their forks exist. The
map lives in `src/config.ts`.

## Tools and agent

`spi_watchstand`, `spi_incidents`, `spi_line`, `spi_stack`, `spi_template` and
`spi_prs` answer from the same sweep the boards render, so chat, workflows and
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
queue and lines, and checks every board against the host's render gate.

## Cadence

One in-process sweep every 5 minutes, whether or not the tab is open, so the
badge stays current. GitLab is read every 30 minutes, and a refresh or upgrade
in flight is re-read every 15 seconds. Completed jobs, compares and file reads
never change, so they are read once and kept in the rib's data directory.
