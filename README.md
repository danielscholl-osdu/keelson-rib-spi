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
| Service lines | Where is each line, and is it moving? | PRs, checks, issues, `Upstream-Sha` trailers, GitLab master, the `spi-stack` lane ledger |
| Template | Is every fork on the current osdu-spi template? | `.github/.template-sync-commit`, template compares, template-sync PRs, Sync Template runs |
| Doctor (footer) | Can the rib see? | sign-in probes, the GitHub budget, each read's age and last error |

The banner's pill is the tab's verdict (`BLOCKED`, `ATTENTION`, `MOVING`,
`CONVERGED`) and the nav badge counts P0 and P1 items. P0 broke unattended, P1
is a gate or a decision, P2 is ready work. A red check is classified by its
failed step before it counts: a lane that failed in `Confirm environment
deployable` is the stack's fault and folds under the stack incident.

When forks cannot deploy, the stack panel says since when, the stage the latest
attempt is in or stopped at with how long each stage took, a timeline since the
last green run, and every attempt in order, cancelled ones included. A step that
runs past every green run of its kind turns amber. Times are local, the zone
Keelson draws its timelines and clocks in.

## Services

| Service | Fork | Upstream project |
|---|---|---|
| partition | Azure/osdu-spi-partition | osdu/platform/system/partition |
| entitlements | Azure/osdu-spi-entitlements | osdu/platform/security-and-compliance/entitlements |
| legal | Azure/osdu-spi-legal | osdu/platform/security-and-compliance/legal |
| schema | Azure/osdu-spi-schema | osdu/platform/system/schema-service |
| file | Azure/osdu-spi-file | osdu/platform/system/file |

storage, indexer and search show as empty seats until their forks exist. The
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
