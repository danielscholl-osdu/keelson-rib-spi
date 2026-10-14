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

The tab is one console with four views. Each answers one question in a
sentence, then shows only what supports it. The words come from one pure
briefing (`src/brief/`), which `spi_brief` returns to chat as well.

| View | Question | What it shows |
|---|---|---|
| Today | What needs me now? | A headline naming at most two causes, three facts (environment version, forks with sync stopped, template adoption), up to five focus items with cause, effect and next step, and one line of ready work. |
| Flow | Where is change stuck? | One row per fork that needs a person, one column per station (upstream, sync, cascade, main, release, lane, template). A column every fork agrees on becomes one band, the environment is one row above the table, and quiet forks fold into one row. |
| Horizon | What will affect us next? | One row per upstream cause across forks (a halt entry, a Java move, ports owed, the template rollout, the Azure removal deadline), queued commits kept apart from open MRs. |
| Environment | Is the environment dependable? | The running version, the 21-day deployable share and the last proof, over a 24-hour timeline of upgrades, refreshes, smoke runs and maintenance holds. |

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

The template-sync set's inspector carries the rollout. **Sync all forks** runs
`gh workflow run sync-template.yml` on each fork behind `osdu-spi` main whose PR
does not already carry it; a fork with Sync Template already running is
skipped. **Roll out** merges every template-sync PR that is approved, green and
unchanged since the draw, with a merge commit, and names each PR held back and
why. Below the buttons, the release ladder has one step per fork position,
newest first, and each step opens its own inspector. Review stays on GitHub:
the rib never approves a PR.

The console's read line (`every source read`) opens the doctor: the sign-in
probes, the GitHub budget, each source's last read, and what the verbs need
(the `gh` token's scopes, Keelson projects for the forks, and the workflow and
gate grants). A source that fails keeps its last good read until it reads again.

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

`spi_brief`, `spi_watchstand`, `spi_incidents`, `spi_line`, `spi_stack`,
`spi_template` and `spi_prs` answer from the same sweep the console renders, so chat, workflows and
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
badge stays current. GitLab is read every 30 minutes, and a refresh or upgrade
in flight is re-read every 15 seconds. Completed jobs, compares and file reads
never change, so they are read once and kept in the rib's data directory.
