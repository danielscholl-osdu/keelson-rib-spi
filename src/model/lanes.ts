// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, LANES_OVERRIDE } from "../config.ts";
import type { ForkRuns, RepoFact } from "../facts.ts";
import { activeRollout } from "../rollout.ts";
import { latestChecks } from "./checks.ts";

// The workflow whose PR and main runs borrow the shared environment.
const VALIDATION = "Validation";

export interface LaneInFlight {
  repo: string;
  service: string;
  what: string;
}

// How many forks hold a lane on the shared environment, against the cap a press tops up to.
export interface LaneLoad {
  // Null when no cap is set: the fleet buttons act on every eligible fork, as before pacing.
  cap: number | null;
  capFrom?: "RIB_SPI_LANES" | "rollout";
  inflight: LaneInFlight[];
  // What the rib has not read yet, so it cannot count lanes; a paced press starts nothing.
  unread?: string;
  // Forks whose cascade runs now: no lane yet, but a green one opens a Sync to Main that borrows.
  claims?: LaneInFlight[];
}

export function laneCap(): Pick<LaneLoad, "cap" | "capFrom"> {
  if (LANES_OVERRIDE) return { cap: LANES_OVERRIDE, capFrom: "RIB_SPI_LANES" };
  const lanes = activeRollout()?.lanes;
  return lanes ? { cap: lanes, capFrom: "rollout" } : { cap: null };
}

// One entry per fork: a Sync Template run in flight or dispatched, an open PR whose
// head Validation run has not concluded, a main Validation run, or a press the sweep
// has not seen land yet.
export function laneLoad(input: {
  repos: Record<string, RepoFact>;
  runs: Record<string, ForkRuns> | undefined;
  prsRead: boolean;
  dispatched?: Record<string, string>;
  pressed?: Record<string, string>;
}): LaneLoad {
  const inflight: LaneInFlight[] = [];
  const claims: LaneInFlight[] = [];
  for (const fork of FORKS) {
    const runs = input.runs?.[fork.repo];
    // fork_upstream builds core only and never borrows the environment.
    const pending = (input.repos[fork.repo]?.prs ?? []).find(
      (pr) =>
        pr.base !== "fork_upstream" &&
        latestChecks(pr.checks).some((c) => c.workflow === VALIDATION && c.status !== "COMPLETED"),
    );
    const what = (runs?.template ?? []).some((r) => r.status !== "completed")
      ? "Sync Template running"
      : input.dispatched?.[fork.repo]
        ? "Sync Template dispatched"
        : pending
          ? `Validation running on #${pending.number}`
          : (runs?.main ?? []).some((r) => r.status !== "completed")
            ? "main Validation running"
            : input.pressed?.[fork.repo]
              ? "just merged or re-run"
              : undefined;
    if (what) inflight.push({ repo: fork.repo, service: fork.id, what });
    else if ((runs?.cascade ?? []).some((r) => r.status !== "completed")) {
      claims.push({ repo: fork.repo, service: fork.id, what: "cascade running" });
    }
  }
  const unread = !input.runs ? "fork workflow runs" : !input.prsRead ? "PR checks" : undefined;
  return { ...laneCap(), inflight, claims, ...(unread ? { unread } : {}) };
}

// How many more forks a press may start, once every running cascade has taken the lane its
// Sync to Main will borrow.
export function laneRoom(load: LaneLoad): number {
  if (load.cap === null) return Number.POSITIVE_INFINITY;
  if (load.unread) return 0;
  return Math.max(0, load.cap - load.inflight.length - (load.claims?.length ?? 0));
}
