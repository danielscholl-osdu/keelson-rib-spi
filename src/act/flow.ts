// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FLEET_RELEASE_WORKFLOW, TEMPLATE_REPO } from "../config.ts";
import type { LaneLoad } from "../model/lanes.ts";
import type { EnvRerun, RolloutFork, RolloutModel } from "../model/rollout.ts";
import { plural, short, stamp } from "../util.ts";
import { RERUN_LANES } from "./rerun.ts";
import { paced, paceText, ROLL_OUT, SYNC_FORKS } from "./rollout.ts";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.ts";

// Fleet Release only records a BOM; publish stays off until a person turns it on in GitHub.
export const FLEET_RELEASE: Verb = {
  id: "fleet-release",
  label: "Run Fleet Release",
  command: (t) => [
    "workflow",
    "run",
    FLEET_RELEASE_WORKFLOW,
    "-R",
    t.repo,
    "-f",
    `template_target=${t.sha ?? ""}`,
    "-f",
    "publish=false",
  ],
};

export interface FlowActions {
  primary: ActionItem;
  secondary: ActionItem[];
}

function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function services(list: readonly RolloutFork[]): string {
  return names(list.map((f) => f.service));
}

// A secondary button names up to three forks; more read as a count.
function few(list: readonly RolloutFork[]): string {
  return list.length <= 3 ? services(list) : plural(list.length, "more fork");
}

// A dispatch carries the template head it was drawn for, so a press after main moved is refused.
function dispatchTarget(r: RolloutModel, f: RolloutFork): Target {
  return { repo: f.repo, kind: "workflow", state: "idle", sha: r.target.sha, label: f.service };
}

function mergeTarget(f: RolloutFork): Target {
  return {
    repo: f.repo,
    kind: "pr",
    number: f.pr?.number,
    sha: f.pr?.headSha,
    state: "open",
    label: `${f.service} #${f.pr?.number}`,
  };
}

function rerunTarget(e: EnvRerun): Target {
  return {
    repo: e.repo,
    kind: "run",
    number: e.runId,
    ...(e.pr ? { pr: e.pr } : {}),
    ...(e.headSha ? { sha: e.headSha } : {}),
    state: "failure",
    label: e.pr ? `${e.service} #${e.pr}` : `${e.service} main`,
  };
}

function scheduleLines(r: RolloutModel, now: Date): string[] {
  const out: string[] = [];
  const up = stamp(r.schedule.upstream, now);
  if (up && r.schedule.upstreamForks > 0) {
    out.push(
      `Upstream sync at ${up} opens ${plural(r.schedule.upstreamForks, "PR")} that share the lanes.`,
    );
  }
  const tmpl = stamp(r.schedule.template, now);
  if (tmpl) out.push(`The ${tmpl} template sync opens every fork still without a PR at once.`);
  return out;
}

function orderLines(r: RolloutModel): string[] {
  return r.ordering.map(
    (o) =>
      `${o.service} merges only after ${names(o.after)} ${o.after.length === 1 ? "has" : "have"} merged with a green main run${o.reason ? ` (${o.reason})` : ""}.`,
  );
}

function disabled(label: string, reason: string): ActionItem {
  return { type: "act", label, disabled: true, reason };
}

function dispatchAction(
  r: RolloutModel,
  forks: readonly RolloutFork[],
  swept: string,
  item: string,
  load: LaneLoad,
  now: Date,
  start: boolean,
): ActionItem {
  const targets = forks.map((f) => dispatchTarget(r, f));
  const label = start
    ? `Start rollout · dispatch Sync Template to ${plural(forks.length, "fork")}`
    : `Dispatch ${services(forks)}`;
  return verbAction(
    SYNC_FORKS,
    { item, swept, targets },
    {
      primary: true,
      label,
      pending: `Dispatching ${forks.length}…`,
      title: start ? `Start the rollout to ${short(r.target.sha)}` : label,
      detail: [
        `Dispatches Sync Template on ${services(forks)}, so each fork's template-sync PR carries ${r.target.label} (${short(r.target.sha)}).`,
        ...paceText(load, []),
        ...orderLines(r),
        ...(start ? scheduleLines(r, now) : []),
        "Each fork is read again first: one with Sync Template already running is skipped, and every press is refused if osdu-spi main moved since this board drew.",
      ],
    },
  );
}

function mergeAction(r: RolloutModel, swept: string, item: string, load: LaneLoad): ActionItem {
  const go = r.mergeNext;
  const all = go.length + r.mergeWaits.length;
  const waits = r.mergeWaits.length
    ? ` · ${services(r.mergeWaits)} ${r.mergeWaits.length === 1 ? "waits" : "wait"} for a lane`
    : "";
  const label = `Merge ${go.length} of ${all} approved: ${services(go)}${waits}`;
  return verbAction(
    ROLL_OUT,
    { item, swept, targets: go.map(mergeTarget) },
    {
      primary: true,
      label,
      pending: `Merging ${go.length}…`,
      title: `Merge ${plural(go.length, "template-sync PR")}`,
      detail: [
        `Merges ${names(go.map((f) => `${f.service} #${f.pr?.number}`))} into main with a merge commit, taking each fork to ${short(r.target.sha)}. Each merge starts a main run on the shared environment.`,
        ...paceText(load, []),
        ...orderLines(r),
      ],
      subject: {
        value: String(go.length),
        label: `Type ${go.length}: the number of PRs this merges into main`,
      },
    },
  );
}

function rerunAction(r: RolloutModel, swept: string, item: string, enabled: boolean): ActionItem {
  const first = r.envReruns[0] as EnvRerun;
  const label = `Re-run ${names(r.envReruns.map((e) => e.service))} once · environment failure, attempt 1`;
  if (!enabled) return disabled(label, "after the other lanes drain");
  return verbAction(
    RERUN_LANES,
    { item, swept, targets: r.envReruns.map(rerunTarget) },
    {
      primary: true,
      label,
      pending: "Re-running…",
      title: `Re-run ${first.service}'s failed jobs once`,
      detail: [
        "Every failed job carries the Environment annotation title, so this is the shared environment, not the change. It is re-run once; a second failure stops the line.",
      ],
    },
  );
}

function releaseAction(r: RolloutModel, swept: string, item: string): ActionItem {
  const target: Target = {
    repo: TEMPLATE_REPO,
    kind: "workflow",
    state: "idle",
    sha: r.target.sha,
    label: "osdu-spi",
  };
  const without = r.total - r.released;
  return verbAction(
    FLEET_RELEASE,
    { item, swept, targets: [target] },
    {
      primary: true,
      label: `Run Fleet Release · target ${short(r.target.sha)} · publish off`,
      pending: "Dispatching Fleet Release…",
      title: "Run Fleet Release with publish off",
      detail: [
        `Builds bom.json from each fork's latest release that includes ${short(r.target.sha)}.`,
        without > 0
          ? `${plural(without, "fork")} without a release on this template ${without === 1 ? "is" : "are"} listed as excluded with the reason.`
          : "Every fork has released on this template.",
        "Publish stays off: the BOM is a run artifact, and no fleet release is cut.",
      ],
    },
  );
}

// The primary press names exactly what it does next; every other verb says why it waits.
export function flowActions(
  r: RolloutModel,
  opts: { swept: string; item: string; load: LaneLoad; now: Date; blocked?: string },
): FlowActions {
  const { swept, item, load, now, blocked } = opts;
  const secondary: ActionItem[] = [];
  let primary: ActionItem;
  const target = short(r.target.sha);

  switch (r.next) {
    case "start":
      primary =
        r.dispatchNext.length > 0
          ? dispatchAction(r, r.dispatchNext, swept, item, load, now, true)
          : disabled(
              "Start rollout",
              r.lanes.unread
                ? `lanes unknown until ${r.lanes.unread} are read`
                : `${r.lanes.busy} of ${r.lanes.cap} lanes are busy`,
            );
      break;
    case "merge":
      primary = mergeAction(r, swept, item, load);
      break;
    case "dispatch":
      primary = dispatchAction(r, r.dispatchNext, swept, item, load, now, false);
      break;
    case "rerun":
      primary = rerunAction(r, swept, item, true);
      break;
    case "retarget": {
      const forks = r.forks.filter(
        (f) => !f.onTarget && !f.carries && !f.skip && f.validation.tone !== "run",
      );
      const { targets } = paced(
        forks.map((f) => dispatchTarget(r, f)),
        load,
      );
      const go = forks.filter((f) => targets.some((t) => t.repo === f.repo));
      primary =
        go.length > 0
          ? {
              ...dispatchAction(r, go, swept, item, load, now, false),
              label: `Retarget the rollout to main · dispatch ${services(go)}`,
            }
          : disabled("Retarget the rollout to main", "every lane is busy");
      break;
    }
    case "stopped":
      primary = disabled(
        `Merging paused · ${plural(r.stops.length, "main run")} red`,
        "fix it forward in the template",
      );
      break;
    case "release":
      primary = releaseAction(r, swept, item);
      break;
    default:
      primary = disabled(
        "Nothing to press yet",
        r.lanes.busy > 0
          ? `${r.lanes.busy} of ${r.lanes.cap ?? r.lanes.busy} lanes busy`
          : "waiting on reviews",
      );
  }

  if (r.phase === "stopped") {
    if (r.next !== "retarget") {
      const moved = r.stops.some((f) => f.carries);
      secondary.push(
        disabled(
          "Retarget the rollout to main",
          moved
            ? "the fix is on its PR; merge it when approved and green"
            : `once a template fix merges · main is still ${target}`,
        ),
      );
    }
    for (const f of r.stops) {
      secondary.push(disabled(`Re-run ${f.service}'s main run`, "not offered · real failure"));
    }
  } else if (r.phase !== "done") {
    if (r.next !== "merge") {
      const ready = r.forks.filter((f) => f.ready && !f.onTarget);
      secondary.push(
        disabled(
          "Merge approved PRs",
          ready.length === 0
            ? "nothing is approved and green yet"
            : ready.every((f) => f.heldBy.length > 0)
              ? `held · ${services(ready)} merge after ${names([...new Set(ready.flatMap((f) => f.heldBy))])}`
              : "waits for a lane",
        ),
      );
    }
    if (r.next !== "dispatch" && r.next !== "start") {
      const waiting = r.dispatchWaits;
      if (waiting.length > 0) {
        secondary.push(disabled(`Dispatch ${few(waiting)}`, "waits for a lane"));
      }
    } else if (r.dispatchWaits.length > 0) {
      secondary.push(disabled(`Dispatch ${few(r.dispatchWaits)}`, "waits for the next press"));
    }
    if (r.envReruns.length > 0 && r.next !== "rerun") {
      secondary.push(rerunAction(r, swept, item, false));
    }
  }

  if (blocked) {
    return {
      primary: primary.disabled ? primary : disabled(primary.label, blocked),
      secondary,
    };
  }
  return { primary, secondary };
}
