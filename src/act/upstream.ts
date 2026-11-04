// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { CASCADE_WORKFLOW, SYNC_UPSTREAM_WORKFLOW } from "../config.ts";
import { claimRoom, type LaneLoad } from "../model/lanes.ts";
import {
  planStep,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpFork,
  type UpstreamModel,
} from "../model/upstream.ts";
import { names, plural, stamp } from "../util.ts";
import { type ActionItem, type Target, type Verb, verbAction } from "./verbs.ts";

export { UPSTREAM_ITEM, UPSTREAM_PREFIX };

function cascadeArgs(t: Target): string[] {
  return ["workflow", "run", CASCADE_WORKFLOW, "-R", t.repo, "-f", `issue_number=${t.issue ?? ""}`];
}

// Sync Upstream only opens a sync PR into fork_upstream; nothing merges and no lane is taken.
export const PREPARE: Verb = {
  id: "sync-upstream",
  label: "Prepare",
  command: (t) => ["workflow", "run", SYNC_UPSTREAM_WORKFLOW, "-R", t.repo],
};

// Sync PRs into fork_upstream land as merge commits; the cascade's ancestry check needs it.
export const START: Verb = {
  id: "start-upstream",
  label: "Start",
  command: (t) => ["pr", "merge", String(t.number), "-R", t.repo, "--merge"],
  followUp: cascadeArgs,
  paced: true,
  claims: true,
};

export const DISPATCH_CASCADE: Verb = {
  id: "dispatch-cascade",
  label: "Dispatch cascade",
  command: cascadeArgs,
  paced: true,
  claims: true,
};

export const RERUN_CASCADE: Verb = {
  id: "rerun-cascade",
  label: "Re-run cascade",
  command: cascadeArgs,
  paced: true,
  claims: true,
};

export function prepareTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "workflow",
    workflow: SYNC_UPSTREAM_WORKFLOW,
    state: "idle",
    label: f.service,
  };
}

export function startTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "pr",
    number: f.syncPr?.number,
    sha: f.syncPr?.headSha,
    state: "open",
    ...(f.tracking ? { issue: f.tracking.number } : {}),
    label: `${f.service} #${f.syncPr?.number}`,
  };
}

export function cascadeTarget(f: UpFork): Target {
  return {
    repo: f.repo,
    kind: "workflow",
    workflow: CASCADE_WORKFLOW,
    state: "idle",
    ...(f.tracking ? { issue: f.tracking.number } : {}),
    label: f.service,
  };
}

function services(list: readonly UpFork[]): string {
  return names(list.map((f) => f.service));
}

function disabled(label: string, reason: string): ActionItem {
  return { type: "act", label, disabled: true, reason };
}

// The host shows a disabled reason only on hover, so a waiting verb says why in its label.
function waiting(label: string, reason: string): ActionItem {
  return disabled(`${label} · ${reason}`, reason);
}

function laneText(u: UpstreamModel): string[] {
  const l = u.lanes;
  if (l.cap === null) return ["Unpaced: rollout.json sets no lane cap."];
  if (l.unread) return [`Lanes unknown until ${l.unread} are read, so nothing starts.`];
  return [
    `Lanes are shared with the template rollout: ${l.busy} of ${l.cap} in flight${l.holders.length ? ` (${names(l.holders)})` : ""}${l.claims ? `, ${plural(l.claims, "cascade")} claiming one` : ""}. A press only tops up to ${l.cap}.`,
  ];
}

function orderText(u: UpstreamModel, forks: readonly UpFork[]): string[] {
  return u.ordering
    .filter((o) => forks.some((f) => f.service === o.service))
    .map(
      (o) =>
        `${o.service} starts only after ${names(o.after)} ${o.after.length === 1 ? "is" : "are"} on main${o.reason ? ` (${o.reason})` : ""}.`,
    );
}

export function prepareAction(
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: {
    swept: string;
    item: string;
    now: Date;
    label?: string;
    primary?: boolean;
    extra?: string[];
  },
): ActionItem {
  const at = stamp(u.schedule.upstream, opts.now);
  return verbAction(
    PREPARE,
    { item: opts.item, swept: opts.swept, targets: forks.map(prepareTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `Prepare ${services(forks)}`,
      pending: `Dispatching Sync Upstream on ${forks.length}…`,
      title: `Prepare · dispatch Sync Upstream on ${plural(forks.length, "fork")}`,
      detail: [
        `Dispatches Sync Upstream on ${services(forks)}${at ? ` now instead of at ${at}` : ""}. Each opens a sync PR into fork_upstream with the filtered tree and a tracking issue. Nothing merges, and no lane is taken.`,
        ...(opts.extra ?? []),
        "Each fork is read again first: one with a sync PR already open or Sync Upstream running is skipped.",
      ],
    },
  );
}

export function startAction(
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: {
    swept: string;
    item: string;
    load: LaneLoad;
    label?: string;
    primary?: boolean;
    extra?: string[];
  },
): ActionItem {
  const n = forks.length;
  return verbAction(
    START,
    { item: opts.item, swept: opts.swept, targets: forks.map(startTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `Start ${services(forks)}`,
      pending: `Starting ${n}…`,
      title: `Start · merge ${plural(n, "sync PR")} and dispatch the cascade`,
      detail: [
        `Merges ${names(forks.map((f) => `${f.service} #${f.syncPr?.number}`))} into fork_upstream with a merge commit, then dispatches Cascade Integration with each tracking issue at once instead of waiting up to 6 hours for the monitor.`,
        "The cascade merges main and upstream into fork_integration and builds core and azure on GitHub runners. A green one opens a Sync to Main PR that borrows a lane, and its push to main borrows another.",
        ...laneText(u),
        ...orderText(u, forks),
        ...(opts.extra ?? []),
      ],
      subject: {
        value: String(n),
        label: `Type ${n}: the number of sync PRs this merges`,
      },
    },
  );
}

function cascadeAction(
  verb: Verb,
  u: UpstreamModel,
  forks: readonly UpFork[],
  opts: { swept: string; item: string; label?: string; primary?: boolean; now: Date },
): ActionItem {
  const rerun = verb.id === RERUN_CASCADE.id;
  return verbAction(
    verb,
    { item: opts.item, swept: opts.swept, targets: forks.map(cascadeTarget) },
    {
      ...(opts.primary ? { primary: true } : {}),
      label: opts.label ?? `${verb.label} · ${services(forks)}`,
      pending: rerun ? "Re-running…" : "Dispatching…",
      title: `${verb.label} · ${services(forks)}`,
      detail: [
        rerun
          ? `A fix landed on fork_integration after the failed cascade${forks.length === 1 && forks[0]?.stop?.run ? ` (${stamp(forks[0].stop.run.updatedAt, opts.now)})` : ""}, so the cascade runs again with each tracking issue.`
          : `The sync PR merged and no cascade ran, so this dispatches Cascade Integration with each tracking issue.`,
        "A green cascade opens a Sync to Main PR that borrows a lane.",
        ...laneText(u),
        "Each fork is read again first: one with a cascade already running is skipped.",
      ],
    },
  );
}

export interface UpstreamActions {
  primary: ActionItem;
  secondary: ActionItem[];
}

function blockAll(a: UpstreamActions, blocked?: string): UpstreamActions {
  if (!blocked) return a;
  const off = (x: ActionItem) => (x.disabled ? x : disabled(x.label, blocked));
  return { primary: off(a.primary), secondary: a.secondary.map(off) };
}

// The plan's one primary press, in the order the line runs; the rest say why they wait.
export function planActions(
  u: UpstreamModel,
  opts: { swept: string; load: LaneLoad; now: Date; blocked?: string },
): UpstreamActions {
  const base = { swept: opts.swept, item: UPSTREAM_ITEM };
  const secondary: ActionItem[] = [];
  let primary: ActionItem | undefined;
  const group = (list: readonly UpFork[]) =>
    list.every((f) => f.role === "pilot")
      ? "the pilot"
      : list.every((f) => f.wave === list[0]?.wave)
        ? `wave ${list[0]?.wave}`
        : services(list);

  const step = planStep(u);
  switch (step.kind) {
    case "start":
      primary = startAction(u, step.forks, {
        ...base,
        load: opts.load,
        primary: true,
        label: `Start ${services(step.forks)} · merge the sync PR${step.forks.length > 1 ? "s" : ""}, dispatch the cascade`,
      });
      break;
    case "dispatch":
      primary = cascadeAction(DISPATCH_CASCADE, u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
      });
      break;
    case "prepare":
      primary = prepareAction(u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
        label: `Prepare ${group(step.forks)} · dispatch Sync Upstream on ${plural(step.forks.length, "fork")}`,
      });
      break;
    case "rerun":
      primary = cascadeAction(RERUN_CASCADE, u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
      });
      break;
    case "paused":
      primary = disabled(
        `Paused · ${names(u.paused?.forks ?? [])} failed the cascade the same way`,
        "absorb the move in the remaining forks first",
      );
      break;
    case "env":
      primary = disabled(
        `Waiting for the environment · ${u.envHeld}`,
        "Start resumes once it reads deployable",
      );
      break;
    case "early":
      primary = prepareAction(u, step.forks, {
        ...base,
        now: opts.now,
        primary: true,
        label: `Prepare ${group(step.forks)} early · ${plural(step.forks.length, "fork")}`,
        extra: [`Their Start still waits: ${step.forks[0]?.planWait ?? "for their wave"}.`],
      });
      break;
  }
  if (!primary) {
    const why =
      u.startWaits.length > 0
        ? `${services(u.startWaits)} ${u.startWaits.length === 1 ? "waits" : "wait"} for a lane`
        : u.reviews.length > 0
          ? `review ${services(u.reviews)} on GitHub`
          : u.forks.some((f) => f.phase === "cascading")
            ? "cascades are running"
            : "nothing waits on a press";
    primary = disabled(`Nothing to press yet · ${why}`, why);
  }

  if (primary.binding?.verb !== START.id && u.startWaits.length > 0) {
    secondary.push(waiting(`Start ${services(u.startWaits)}`, "waits for a lane"));
  }
  const early = (list: readonly UpFork[]) =>
    prepareAction(u, list, {
      ...base,
      now: opts.now,
      label: `Prepare ${group(list)} early · ${plural(list.length, "fork")}`,
      extra: [`Their Start still waits: ${list[0]?.planWait ?? "for their wave"}.`],
    });
  const preparing = primary.binding?.verb === PREPARE.id;
  if (!preparing && u.prepareNext.length > 0) {
    secondary.push(prepareAction(u, u.prepareNext, { ...base, now: opts.now }));
  } else if (preparing && step.kind !== "early" && u.prepareLater.length > 0) {
    secondary.push(early(u.prepareLater));
  }
  if (primary.binding?.verb !== RERUN_CASCADE.id) {
    if (u.reruns.length > 0) {
      secondary.push(cascadeAction(RERUN_CASCADE, u, u.reruns, { ...base, now: opts.now }));
    }
    for (const f of u.stops.filter((s) => s.wait)) {
      secondary.push(waiting(`Re-run ${f.service}'s cascade`, f.wait as string));
    }
  }
  return blockAll({ primary, secondary }, opts.blocked);
}

// One service: the same verbs, gated only by the fork's own state, the environment and lanes.
export function forkActions(
  u: UpstreamModel,
  f: UpFork,
  opts: { swept: string; load: LaneLoad; now: Date; blocked?: string },
): UpstreamActions {
  const base = { swept: opts.swept, item: `${UPSTREAM_PREFIX}${f.service}` };
  const room = claimRoom(opts.load);
  const anyway =
    f.held === "snapshot"
      ? [
          `The plan holds ${f.service}: upstream moved to ${f.snapshot}, and a SNAPSHOT can change under the same version. Pressing takes it anyway.`,
        ]
      : [];
  let primary: ActionItem;
  switch (f.verb) {
    case "prepare":
      primary = f.wait
        ? waiting("Prepare", f.wait)
        : prepareAction(u, [f], {
            ...base,
            now: opts.now,
            primary: true,
            label:
              f.held === "snapshot"
                ? "Take it anyway · Prepare"
                : "Prepare · dispatch Sync Upstream",
            extra: anyway,
          });
      break;
    case "start":
      primary = f.wait
        ? waiting("Start", f.wait)
        : room <= 0
          ? waiting(
              "Start",
              opts.load.unread
                ? `lanes unknown until ${opts.load.unread} are read`
                : "waits for a lane",
            )
          : startAction(u, [f], {
              ...base,
              load: opts.load,
              primary: true,
              label: `${f.held === "snapshot" ? "Take it anyway · " : ""}Start · merge #${f.syncPr?.number}, dispatch the cascade`,
              extra: [
                ...anyway,
                ...(f.planWait && f.held !== "snapshot"
                  ? [`The plan would wait: ${f.planWait}.`]
                  : []),
              ],
            });
      break;
    case "dispatch":
      primary = f.wait
        ? waiting("Dispatch cascade", f.wait)
        : room <= 0
          ? waiting("Dispatch cascade", "waits for a lane")
          : cascadeAction(DISPATCH_CASCADE, u, [f], { ...base, now: opts.now, primary: true });
      break;
    case "rerun":
      primary = f.wait
        ? waiting("Re-run the cascade", f.wait)
        : room <= 0
          ? waiting("Re-run the cascade", "waits for a lane")
          : cascadeAction(RERUN_CASCADE, u, [f], {
              ...base,
              now: opts.now,
              primary: true,
              label: "Re-run the cascade",
            });
      break;
    default:
      primary = disabled(
        "Nothing to press",
        f.phase === "review"
          ? "the Sync to Main PR auto-merges when green"
          : f.phase === "cascading"
            ? "the cascade is running"
            : f.phase === "main"
              ? "the main run is testing"
              : (f.wait ?? "nothing waits on a press"),
      );
  }
  const secondary: ActionItem[] = [];
  if (f.phase === "stopped" && f.syncPr) {
    secondary.push(waiting(`Start #${f.syncPr.number}`, "once this cascade clears"));
  }
  return blockAll({ primary, secondary }, opts.blocked);
}

export function upstreamVerbs(): Verb[] {
  return [PREPARE, START, DISPATCH_CASCADE, RERUN_CASCADE];
}
