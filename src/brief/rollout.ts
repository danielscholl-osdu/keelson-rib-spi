// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RolloutFork, RolloutModel } from "../model/rollout.ts";
import { plural, short, stamp } from "../util.ts";

export interface RolloutWords {
  title: string;
  sub: string;
  cause: string;
  effect: string;
  next: string;
  // The console's verb: what Open in inspector leads to.
  verb: string;
  plan: string;
  watch: string;
  reaches: string;
}

export function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function count(n: number): string {
  return NUMBER[n] ?? String(n);
}

// A synced path as a reader names it: the workflow file, the action, or the build path.
export function pathName(path: string): string {
  const action = /^\.github\/actions\/([^/]+)\//.exec(path);
  if (action) return `${action[1]} action`;
  if (path.startsWith(".github/template-workflows/")) return path.split("/").pop() ?? path;
  return path;
}

export function reachedPaths(r: RolloutModel): string[] {
  return [...new Set(r.changes.flatMap((c) => c.paths.map(pathName)))];
}

function orderText(r: RolloutModel): string[] {
  return r.ordering.map((o) => `${o.service} merges after ${names(o.after)}`);
}

export function planText(r: RolloutModel): string {
  const parts: string[] = [];
  if (r.lanes.waves !== null) parts.push(plural(r.lanes.waves, "wave"));
  parts.push(
    r.lanes.cap === null ? "unpaced: no lane cap is set" : `lanes ${r.lanes.cap} from rollout.json`,
  );
  parts.push(...orderText(r));
  return parts.join(" · ");
}

export function watchText(r: RolloutModel, now: Date): string {
  const out: string[] = [];
  const up = stamp(r.schedule.upstream, now);
  if (up && r.schedule.upstreamForks > 0) {
    out.push(
      `Upstream sync at ${up} opens ${plural(r.schedule.upstreamForks, "PR")}${r.borrows ? " that share these lanes" : ""}.`,
    );
  }
  const tmpl = stamp(r.schedule.template, now);
  if (tmpl) {
    out.push(
      r.schedule.templateOpens > 0
        ? `The ${tmpl} template sync opens every fork still without a PR at once${r.schedule.templateOpens < r.total ? ` (${r.schedule.templateOpens} now)` : ""}.`
        : `The ${tmpl} template sync opens nothing: every fork already has a PR or the change.`,
    );
  }
  return out.join(" ");
}

function forkList(list: readonly RolloutFork[]): string {
  return names(list.map((f) => f.service));
}

function laneWord(n: number): string {
  return n === 1 ? "One lane is" : `${cap(count(n))} lanes are`;
}

// The one sentence the Next step card leads with, matching what the primary button does.
export function nextSentence(r: RolloutModel): string {
  const first = r.dispatchNext.slice(0, r.lanes.room);
  switch (r.next) {
    case "start":
      return first.length > 0
        ? `Start the rollout: dispatch Sync Template to the first ${plural(first.length, "fork")}.`
        : `Start the rollout once a lane frees: ${r.lanes.busy} of ${r.lanes.cap} are busy.`;
    case "merge": {
      const lead = r.mergeNext.map((f) => f.service);
      return `Merge ${names(lead)}. ${laneWord(r.lanes.room)} free.`;
    }
    case "dispatch":
      return `Dispatch Sync Template to ${forkList(r.dispatchNext)}. ${laneWord(r.lanes.room)} free.`;
    case "rerun":
      return `Re-run ${names(r.envReruns.map((e) => e.service))} once: an environment failure, and the other lanes have drained.`;
    case "retarget":
      return "Retarget the rollout to main: dispatch Sync Template so each fork's PR carries the fix.";
    case "stopped":
      return "Fix it forward in the template. Merges and dispatches are paused.";
    case "release":
      return "Mark a fleet release once the forks have released.";
    default:
      if (r.lanes.busy > 0 && r.lanes.cap !== null && r.lanes.room === 0) {
        return `Wait: ${r.lanes.busy} of ${r.lanes.cap} lanes are busy.`;
      }
      if (r.reviews.length > 0) {
        return `Review ${forkList(r.reviews)} on GitHub; a merge starts once a PR is approved and green.`;
      }
      return "Wait for the PRs to go green: nothing is approved and green yet.";
  }
}

// Why the primary press is the one it is, in a sentence or two under it.
export function nextWhy(r: RolloutModel): string {
  if (r.phase === "stopped") {
    const stop = r.stops[0];
    if (!stop) return "";
    return `${stop.service}'s main run failed after its merge. The failure carries no Environment title, so it counts as a failure of the change. Don't patch the fork by hand.`;
  }
  if (r.phase === "done") {
    const without = r.total - r.released;
    return `Fleet Release records each fork's latest release in bom.json. Run now, ${without === 0 ? "every fork has released on this template" : `the ${plural(without, "fork")} without a release on this template are listed as excluded with the reason`}. The first run never publishes.`;
  }
  const parts: string[] = [];
  if (r.next === "merge") {
    const ok = r.mergeNext.concat(r.mergeWaits).map((f) => f.service);
    parts.push(`${names(ok)} ${ok.length === 1 ? "is" : "are"} approved and green.`);
    if (r.mergeWaits.length > 0) {
      parts.push(
        `Only ${count(r.lanes.room)} ${r.lanes.room === 1 ? "lane is" : "lanes are"} free, so ${forkList(r.mergeWaits)} ${r.mergeWaits.length === 1 ? "merges" : "merge"} on the next press.`,
      );
    }
  }
  for (const f of r.forks) {
    if (f.heldBy.length > 0 && f.carries) {
      parts.push(
        `${f.service} stays held until ${names(f.heldBy)} ${f.heldBy.length === 1 ? "is" : "are"} merged and their main runs are green.`,
      );
    }
  }
  if (r.phase === "ready" && r.borrows) {
    parts.push(
      `Each fork borrows a lane to validate its PR and another to merge; a press only tops up to ${r.lanes.cap ?? "every fork"}.`,
    );
  }
  return parts.join(" ");
}

export function verbText(r: RolloutModel): string {
  switch (r.next) {
    case "start":
      return "Start rollout";
    case "merge":
      return "Merge";
    case "dispatch":
      return "Dispatch";
    case "rerun":
      return "Re-run once";
    case "retarget":
      return "Retarget";
    case "stopped":
      return "Fix forward";
    case "release":
      return "Fleet Release";
    default:
      return r.reviews.length > 0 ? "Review on GitHub" : "Watch";
  }
}

export function rolloutWords(r: RolloutModel, now: Date): RolloutWords {
  const target = short(r.target.sha);
  const reaches = reachedPaths(r);
  const base = {
    next: nextSentence(r),
    verb: verbText(r),
    plan: planText(r),
    watch: watchText(r, now),
    reaches: reaches.length > 0 ? reaches.join(" · ") : r.consequences.join(", "),
  };
  const lanesText = r.borrows
    ? `every PR and every merge takes a deploy lane: ${plural(r.lanes.needed, "lane")}${r.lanes.cap ? `, ${r.lanes.cap} at a time` : ""}`
    : "no PR borrows a deploy lane";
  const reach = r.consequences.length > 0 ? names(r.consequences) : "files the forks sync";
  if (r.phase === "ready") {
    const one = r.from && r.forks.every((f) => !f.unread);
    return {
      ...base,
      title: `${plural(r.reaching, "change")} on main ${r.reaching === 1 ? "reaches" : "reach"} all ${r.total} forks`,
      sub: [plural(r.changes.length, "merge"), r.consequences.join(", "), "no PR carries it yet"]
        .filter(Boolean)
        .join(" · "),
      cause: `osdu-spi main ${target} is ${plural(r.changes.length, "merge")} past what ${one ? "every fork runs" : "the oldest fork runs"}${r.from ? ` (${short(r.from.sha)})` : ""}${r.reaching < r.changes.length ? `; ${r.reaching} of them change files the forks sync` : ""}.`,
      effect: `The change reaches ${reach}, so ${lanesText}.`,
    };
  }
  if (r.phase === "stopped") {
    const stop = r.stops[0];
    const held = r.forks.filter((f) => !f.onTarget && !f.red).length;
    return {
      ...base,
      title: `Rollout to template ${target} stopped at ${names(r.stops.map((f) => f.service))}`,
      sub: `${r.merged} of ${r.total} merged · ${plural(r.mainGreen, "main run")} green · ${r.stops.length} red · ${plural(held, "fork")} held`,
      cause: `${stop?.service ?? "A fork"}'s main run failed after its merge, with no Environment title on any failed job.`,
      effect: `Merges and dispatches pause; ${plural(held, "fork")} wait on the fix.`,
    };
  }
  if (r.phase === "done") {
    return {
      ...base,
      title: `Every fork runs template ${target}`,
      sub: `${r.total} of ${r.total} merged · every main run green`,
      cause: `Every fork merged its template-sync PR to ${target}.`,
      effect: `${r.released} of ${r.total} forks have released on it.`,
    };
  }
  return {
    ...base,
    title: `Rollout to template ${target}`,
    sub: `${r.merged} of ${r.total} merged · ${r.lanes.cap === null ? "unpaced" : `${r.lanes.busy} of ${r.lanes.cap} lanes busy`}`,
    cause: `osdu-spi main ${target} is on its way to the fleet: ${r.merged} of ${r.total} forks merged.`,
    effect: `The change reaches ${reach}, so ${lanesText}${r.lanes.needed > 0 ? " still to go" : ""}.`,
  };
}
