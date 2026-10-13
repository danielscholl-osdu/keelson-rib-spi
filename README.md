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
| Shared stack | Can forks deploy? If not, since when and what has been tried? Is the stack on its declared version? | `shared.yaml`, releases, and every env-refresh, env-upgrade, smoke and sweeper run with its jobs and steps |
| Service lines | Where is each fork with upstream, the osdu-spi template and its release, and which template changes has it not taken? | PRs, checks, issues, `Upstream-Sha` trailers, GitLab master, `.github/.template-sync-commit` on main and at each template-sync PR head, template compares, Sync Template runs |
| Doctor (footer) | Can the rib see? | sign-in probes, the GitHub budget, each read's age and last error |

The banner's pill is the tab's verdict (`BLOCKED`, `ATTENTION`, `MOVING`,
`CONVERGED`) and the nav badge counts P0 and P1 items. P0 broke unattended, P1
is a gate or a decision, P2 is ready work. A red check is classified by its
failed step before it counts: a lane that failed in `Confirm environment
deployable` is the stack's fault and folds under the stack incident.

When forks cannot deploy, the stack panel says since when (`MAINTENANCE MODE`
when the maintenance hold is the reason), the stage the latest attempt is in or
stopped at with how long each stage took, a timeline since the last green run,
and every attempt in order, cancelled ones included. A step that runs past every
green run of its kind turns amber. Times are local, the zone Keelson draws its
timelines and clocks in.

Service lines is one row per fork, and its state is the line's worst. Red means
main is red, or the line stopped with nothing open to act on: a sync halt, a
failed Sync Template run, or no template-sync PR. Amber means an open PR fails
on a real failure. Blue means an update waits on review or the stack, and
`current` means caught up with upstream and on the latest template. The header
turns red only for a red main, since a halt or a failing PR is work to do while
the service still builds.

A template-sync PR shows the version the fork is on and the one the PR moves it
to, so a jump across several releases is visible before anyone merges it. When
osdu-spi main is past its last tag, the target reads as the release its open
release PR will tag, for example `v1.2.0 → v1.2.1 (unreleased)`.

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
