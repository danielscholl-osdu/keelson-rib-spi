# keelson-rib-spi

A [Keelson](https://github.com/danielscholl/keelson) rib for the Azure OSDU SPI
program. It adds an **SPI** tab that follows each service as one line from its
upstream GitLab project, through its GitHub fork, to the shared stack
environment, and folds failures into incidents by cause.

The rib reads only. Every fact comes from the operator's own `gh` and `glab`
sign-ins; it makes no GitHub or GitLab change and does not touch the cluster.

## What the tab shows

| Region | Question | Built from |
|---|---|---|
| Needs attention (banner) | What needs a person, ranked by what it blocks? | the incidents and gates the sweep finds |
| Environment | Can forks deploy? Is the environment on the latest release, does it deploy from nothing, and does the running one keep proving itself on schedule? | `shared.yaml`, stack releases, the lifecycle workflows' schedules, and every env-refresh, env-upgrade, smoke and sweeper run with its jobs and steps |
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

The banner's last row is the doctor: `Doctor · all clear` while every source
reads, with the sign-in probes, the GitHub budget and each read's age behind its
disclosure. When a sign-in, the budget or a read fails, that row moves above the
queue, amber or red, and names what failed; every panel keeps that source's last
good read until it reads again.

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

The Services panel opens with three gate tiles. Each shows the oldest item the
gate holds now and the 21-day median wait: upstream (a sync PR opened to the
integration PR merged after it), template (template-sync PRs) and release.

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
