// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { githubUrl, REFERENCE_FORK, SYNC_UPSTREAM_CRON } from "../config.ts";
import type { ForkRuns, JobDetail, PastPrFact, RunFact } from "../facts.ts";
import type { OrderRule } from "../rollout.ts";
import { latestChecks, prVerdict } from "./checks.ts";
import { type LaneLoad, laneRoom } from "./lanes.ts";
import type { LineModel } from "./lines.ts";
import type { RadarModel } from "./radar.ts";
import type { Cell, CellTone } from "./rollout.ts";
import { nextFire, toCrons } from "./schedule.ts";

// The plan's inspector item, and the prefix of one fork's.
export const UPSTREAM_ITEM = "upstream";
export const UPSTREAM_PREFIX = "upstream:";

// Where a fork stands on its way from upstream to main, read from GitHub each sweep.
export type UpPhase =
  | "unread"
  | "current"
  | "idle"
  | "halted"
  | "preparing"
  | "prepared"
  | "merged"
  | "cascading"
  | "stopped"
  | "review"
  | "main"
  | "red"
  | "done";

export type UpRole = "pilot" | "wave" | "held" | "flight" | "stopped" | "done" | "quiet";

// What the rib can press for the fork now, when anything.
export type UpVerb = "prepare" | "start" | "dispatch" | "rerun" | "review";

export interface UpStop {
  // conflict, build failed, failed
  label: string;
  issue?: { number: number; url: string; title: string };
  run?: RunFact;
  job?: JobDetail;
  // The first error the failed job names, the key two forks share when the move is the cause.
  error?: string;
  // A commit landed on fork_integration after the failed run; null while unread.
  fixLanded: boolean | null;
}

export interface UpFork {
  service: string;
  repo: string;
  url: string;
  // Upstream commits not yet in fork_upstream; undefined while unmeasured.
  behind?: number;
  // Toolchain values the queued commits move to; undefined while the radar is unread.
  moves?: string[];
  snapshot?: string;
  // The filter entry the next sync halts on, or the halt already open.
  halt?: { entry?: string; code?: string; url?: string; open: boolean };
  phase: UpPhase;
  role: UpRole;
  // 1-based, for a fork in a wave.
  wave?: number;
  syncPr?: { number: number; url: string; headSha: string; verdict: string };
  tracking?: { number: number; url: string; labels: string[] };
  cascadeRun?: RunFact;
  stop?: UpStop;
  toMain?: { number: number; url: string; headSha: string; review?: string; validating: boolean };
  merged?: { number: number; url: string; at: string };
  mainRun?: RunFact;
  templatePr?: { number: number; url: string };
  releasePr?: { number: number; url: string };
  // Forks rollout.json orders before it that are not on main yet.
  heldBy: string[];
  // Why the plan holds it back.
  held?: "snapshot" | "halt";
  cells: { sync: Cell; cascade: Cell; toMain: Cell; main: Cell };
  verb?: UpVerb;
  // Why the verb the fork's own state calls for cannot run now, in either mode.
  wait?: string;
  // Why the plan holds the verb back: the wave's gate, a hold, a pause or a full lane.
  planWait?: string;
  // A cascade that is active blocks Sync Upstream on the fork.
  syncBlocked?: string;
}

export interface UpWave {
  name: string;
  forks: string[];
  // Why the wave's Start opens, or undefined once it has.
  gate?: string;
}

export interface UpstreamModel {
  // planning: nothing has started yet; flight: at least one fork is past its sync PR.
  mode: "planning" | "flight" | "quiet";
  forks: UpFork[];
  behind: number;
  commits: number;
  range?: [number, number];
  moving: UpFork[];
  // Toolchain value to the forks moving to it, released values first.
  moves: { value: string; forks: string[] }[];
  snapshots: UpFork[];
  halts: UpFork[];
  reference: string;
  // open once the reference fork's cascade is green, or it has nothing to prove.
  gate: "open" | "waiting" | "failed" | "held";
  pilot: string[];
  waves: UpWave[];
  held: UpFork[];
  paused?: { forks: string[]; error: string };
  envHeld?: string;
  lanes: {
    cap: number | null;
    busy: number;
    claims: number;
    room: number;
    unread?: string;
    holders: string[];
  };
  needed: number;
  prepareNext: UpFork[];
  prepareLater: UpFork[];
  startNext: UpFork[];
  startWaits: UpFork[];
  dispatches: UpFork[];
  reruns: UpFork[];
  reviews: UpFork[];
  stops: UpFork[];
  done: UpFork[];
  ordering: OrderRule[];
  schedule: { upstream?: string; opens: string[]; updates: string[]; halts: string[] };
}

// A merge to main this recent is this round's; its main run is the merge's own within 15 minutes.
const ROUND_MS = 3 * 86_400_000;
const MERGE_RUN_MS = 15 * 60_000;
const STOPS = ["conflict", "validation-failed", "cascade-failed", "cascade-blocked"];
const STARTED: ReadonlySet<UpPhase> = new Set(["merged", "cascading", "review", "main"]);
const WAITING: ReadonlySet<UpPhase> = new Set(["idle", "halted", "preparing", "prepared"]);

function cell(text: string, tone: CellTone, url?: string, note?: string): Cell {
  return { text, tone, ...(url ? { url } : {}), ...(note ? { note } : {}) };
}

const DASH: Cell = { text: "·", tone: "idle" };

function lastMerged(past: readonly PastPrFact[] | undefined, prefix: string) {
  return (past ?? [])
    .filter((p) => p.mergedAt && p.head.startsWith(prefix))
    .sort((a, b) => Date.parse(b.mergedAt as string) - Date.parse(a.mergedAt as string))[0];
}

function mergeRun(runs: ForkRuns | undefined, at: string): RunFact | undefined {
  return (runs?.main ?? []).find((r) => {
    const lag = Date.parse(r.createdAt) - Date.parse(at);
    return lag >= -60_000 && lag <= MERGE_RUN_MS;
  });
}

function stopOf(line: LineModel, runs: ForkRuns | undefined): UpStop | undefined {
  const label = line.cascadeLabels.find((l) => STOPS.includes(l));
  const issue = line.conflicts.find((i) => i.number !== line.tracking?.number) ?? line.conflicts[0];
  if (!label && !issue) return undefined;
  const failed =
    runs?.cascade[0]?.status === "completed" && runs.cascade[0].conclusion === "failure"
      ? runs.cascade[0]
      : undefined;
  const jobs = failed ? runs?.cascadeRunJobs?.[String(failed.id)] : undefined;
  const job = jobs?.find((j) => j.conclusion === "failure");
  const kind =
    issue?.labels.includes("conflict") || label === "conflict"
      ? "conflict"
      : issue?.labels.includes("validation-failed") || label === "validation-failed"
        ? "build failed"
        : "failed";
  const since = failed?.updatedAt ?? issue?.createdAt;
  const at = runs?.integration?.at;
  return {
    label: kind,
    ...(issue ? { issue: { number: issue.number, url: issue.url, title: issue.title } } : {}),
    ...(failed ? { run: failed } : {}),
    ...(job ? { job } : {}),
    ...(job?.reason ? { error: job.reason } : {}),
    fixLanded: !at || !since ? null : Date.parse(at) > Date.parse(since),
  };
}

function toMainOf(line: LineModel): UpFork["toMain"] {
  const p = line.cascadePr?.pr;
  if (!p) return undefined;
  const validating = latestChecks(p.checks).some(
    (c) => c.workflow === "Validation" && c.status !== "COMPLETED",
  );
  return {
    number: p.number,
    url: p.url,
    headSha: p.headSha,
    ...(p.reviewDecision ? { review: p.reviewDecision } : {}),
    validating,
  };
}

function phaseOf(
  f: Omit<UpFork, "phase" | "role" | "cells" | "heldBy">,
  line: LineModel,
  now: Date,
) {
  if (f.toMain) return "review" as const;
  if (f.stop) return "stopped" as const;
  if (f.cascadeRun && f.cascadeRun.status !== "completed") return "cascading" as const;
  if (f.tracking?.labels.includes("cascade-active")) return "cascading" as const;
  if (f.syncPr) return "prepared" as const;
  const sync = lastMerged(line.past, "sync/upstream-");
  if (
    f.tracking &&
    !f.tracking.labels.includes("validated") &&
    sync?.mergedAt &&
    Date.parse(sync.mergedAt) >= Date.parse(line.tracking?.createdAt ?? sync.mergedAt)
  ) {
    return "merged" as const;
  }
  // A fork behind again starts its next round; only a main run still going keeps this one.
  if (f.merged && now.getTime() - Date.parse(f.merged.at) <= ROUND_MS) {
    const run = f.mainRun;
    if (run && run.status !== "completed") return "main" as const;
    if (!f.behind)
      return run && run.conclusion !== "success" ? ("red" as const) : ("done" as const);
  }
  if (f.halt?.open) return "halted" as const;
  if (f.behind === undefined) return "unread" as const;
  if (f.behind === 0) return "current" as const;
  return f.halt ? ("halted" as const) : ("idle" as const);
}

function cellsOf(f: UpFork): UpFork["cells"] {
  const sync = (() => {
    if (f.phase === "halted") {
      return cell(
        "halt",
        "bad",
        f.halt?.url,
        f.halt?.open ? "the sync halted" : "the next sync halts",
      );
    }
    if (f.phase === "preparing") return cell("preparing", "run");
    if (f.syncPr) {
      const pr = f.syncPr;
      if (pr.verdict === "red") return cell("red", "bad", pr.url, "sync PR checks red");
      if (pr.verdict === "pending") return cell("building", "run", pr.url, "sync PR builds core");
      return cell("prepared", "idle", pr.url);
    }
    if (STARTED.has(f.phase) || ["stopped", "red", "done"].includes(f.phase)) {
      return cell("merged", "ok");
    }
    return DASH;
  })();
  const cascade = (() => {
    if (f.phase === "merged") return cell("waiting", "warn", undefined, "cascade not dispatched");
    if (f.phase === "cascading") return cell("running", "run", f.cascadeRun?.url);
    if (f.stop) {
      return cell(
        f.stop.label === "conflict" ? "conflict" : "failed",
        "bad",
        f.stop.run?.url ?? f.stop.issue?.url,
        f.stop.label,
      );
    }
    if (["review", "main", "red", "done"].includes(f.phase)) return cell("green", "ok");
    return DASH;
  })();
  const toMain = (() => {
    if (f.toMain) {
      const p = f.toMain;
      if (p.validating) return cell("testing", "run", p.url, "Sync to Main validates on a lane");
      if (p.review === "REVIEW_REQUIRED" || p.review === "CHANGES_REQUESTED") {
        return cell("review", "warn", p.url, "needs a review on GitHub");
      }
      return cell("merging", "ok", p.url, "auto-merges when green");
    }
    if (["main", "red", "done"].includes(f.phase)) return cell("merged", "ok", f.merged?.url);
    return DASH;
  })();
  const main = (() => {
    if (!["main", "red", "done"].includes(f.phase)) return DASH;
    const run = f.mainRun;
    if (!run) return cell("unread", "idle");
    if (run.status !== "completed") return cell("testing", "run", run.url, "main run on a lane");
    return run.conclusion === "success"
      ? cell("green", "ok", run.url)
      : cell("red", "bad", run.url);
  })();
  return { sync, cascade, toMain, main };
}

function forkOf(
  line: LineModel,
  radar: RadarModel | undefined,
  runs: ForkRuns | undefined,
  now: Date,
): UpFork {
  const svc = radar?.services[line.fork.id];
  const measured = svc && svc.state !== "unmeasured";
  const moves = measured
    ? [
        ...new Set(
          svc.certain
            .filter((v) => v.bucket === "Toolchain" && v.value)
            .map((v) => v.value as string),
        ),
      ]
    : undefined;
  const snapshot = moves?.find((v) => /SNAPSHOT/i.test(v));
  const haltVerdict = svc?.certain.find((v) => v.bucket === "Halt");
  const halt = line.halt
    ? {
        code: line.halt.code,
        url: line.halt.issue.url,
        open: true,
        ...(haltVerdict?.entry ? { entry: haltVerdict.entry } : {}),
      }
    : haltVerdict || svc?.state === "will-halt"
      ? {
          ...(haltVerdict?.entry ? { entry: haltVerdict.entry } : {}),
          ...(haltVerdict?.code ? { code: haltVerdict.code } : {}),
          url: githubUrl(line.fork.repo, "/blob/main/.github/upstream-filter.yml"),
          open: false,
        }
      : undefined;
  const sync = line.syncPr?.pr;
  const toMain = toMainOf(line);
  const mergedPr = lastMerged(line.past, "release/upstream-");
  const merged = mergedPr?.mergedAt
    ? { number: mergedPr.number, url: mergedPr.url, at: mergedPr.mergedAt }
    : undefined;
  const base: Omit<UpFork, "phase" | "role" | "cells" | "heldBy"> = {
    service: line.fork.id,
    repo: line.fork.repo,
    url: line.url,
    ...(line.upstream?.lag !== undefined ? { behind: line.upstream.lag } : {}),
    ...(moves ? { moves } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(halt ? { halt } : {}),
    ...(sync
      ? {
          syncPr: {
            number: sync.number,
            url: sync.url,
            headSha: sync.headSha,
            verdict: prVerdict(sync),
          },
        }
      : {}),
    ...(line.tracking
      ? {
          tracking: {
            number: line.tracking.number,
            url: line.tracking.url,
            labels: line.tracking.labels,
          },
        }
      : {}),
    ...(runs?.cascade[0] ? { cascadeRun: runs.cascade[0] } : {}),
    ...(toMain ? { toMain } : {}),
    ...(merged ? { merged } : {}),
    ...(merged
      ? (() => {
          const run = mergeRun(runs, merged.at);
          return run ? { mainRun: run } : {};
        })()
      : {}),
    ...(line.templatePr
      ? { templatePr: { number: line.templatePr.pr.number, url: line.templatePr.pr.url } }
      : {}),
    ...(line.releasePr
      ? { releasePr: { number: line.releasePr.pr.number, url: line.releasePr.pr.url } }
      : {}),
  };
  const stop = stopOf(line, runs);
  const withStop = stop ? { ...base, stop } : base;
  const preparing =
    !sync && (runs?.sync ?? []).some((r) => r.status !== "completed") ? "preparing" : undefined;
  const phase: UpPhase = preparing && !stop && !toMain ? "preparing" : phaseOf(withStop, line, now);
  const fork: UpFork = {
    ...withStop,
    phase,
    role: "quiet",
    heldBy: [],
    cells: { sync: DASH, cascade: DASH, toMain: DASH, main: DASH },
    ...(line.tracking?.labels.includes("cascade-active")
      ? { syncBlocked: "a cascade is active on the fork" }
      : {}),
  };
  if (WAITING.has(phase) && snapshot) fork.held = "snapshot";
  if (WAITING.has(phase) && halt) fork.held = "halt";
  fork.cells = cellsOf(fork);
  return fork;
}

// The first error without the file and position it names, so the same break in two forks matches.
export function errorKey(error: string): string {
  return error
    .replace(/^\s*\[(?:ERROR|WARNING)\]\s*/i, "")
    .replace(/^\S+?:(?:\[\d+(?:,\d+)?\]|\d+(?::\d+)?):?\s*/, "")
    .replace(/^(?:error|warning):\s*/i, "")
    .trim();
}

// Forks in board order, each wave at most `cap` forks; a fork ordered after another in the
// same list waits for a later wave.
export function wavesOf(
  forks: readonly string[],
  cap: number | null,
  ordering: readonly OrderRule[],
): string[][] {
  const size = cap ?? Number.POSITIVE_INFINITY;
  const waves: string[][] = [];
  let left = [...forks];
  while (left.length > 0) {
    const wave: string[] = [];
    for (const f of left) {
      if (wave.length >= size) break;
      const after = ordering.find((o) => o.service === f)?.after ?? [];
      if (after.some((a) => left.includes(a))) continue;
      wave.push(f);
    }
    if (wave.length === 0) wave.push(...left.slice(0, Math.min(left.length, size)));
    waves.push(wave);
    left = left.filter((f) => !wave.includes(f));
  }
  return waves;
}

function onMain(f: UpFork | undefined): boolean {
  return !f || f.phase === "current" || f.phase === "done";
}

export function buildUpstream(input: {
  lines: readonly LineModel[];
  radar?: RadarModel;
  runs: Record<string, ForkRuns> | undefined;
  lanes: LaneLoad;
  ordering?: readonly OrderRule[];
  held?: string;
  now: Date;
}): UpstreamModel {
  const { lines, radar, runs, lanes, now } = input;
  const forks = lines.map((l) => forkOf(l, radar, runs?.[l.fork.repo], now));
  const byId = new Map(forks.map((f) => [f.service, f]));
  const ordering = (input.ordering ?? []).filter((r) => byId.has(r.service));
  const reference = REFERENCE_FORK;
  const ref = byId.get(reference);

  const waiting = forks.filter((f) => WAITING.has(f.phase));
  const started = forks.filter((f) => STARTED.has(f.phase));
  const stops = forks.filter((f) => f.phase === "stopped");
  const done = forks.filter((f) => f.phase === "done");
  const held = waiting.filter((f) => f.held);

  const gate: UpstreamModel["gate"] = !ref
    ? "open"
    : ["review", "main", "red", "done"].includes(ref.phase) || ref.phase === "current"
      ? "open"
      : ref.phase === "stopped"
        ? "failed"
        : ref.held
          ? "held"
          : "waiting";

  const free = waiting.filter((f) => !f.held);
  const pilot = [
    ...(ref && !ref.held && (WAITING.has(ref.phase) || STARTED.has(ref.phase)) ? [reference] : []),
    ...free.filter((f) => f.service !== reference && f.moves?.length === 0).map((f) => f.service),
    ...(gate === "open"
      ? []
      : started.filter((f) => f.service !== reference).map((f) => f.service)),
  ];
  const queue = [
    ...(gate === "open" ? started.filter((f) => f.service !== reference) : []),
    ...free.filter((f) => !pilot.includes(f.service)),
  ].map((f) => f.service);
  const planned = wavesOf(queue, lanes.cap, ordering);
  const waves: UpWave[] = planned.map((list, i) => {
    const gateText =
      i === 0
        ? gate === "open"
          ? undefined
          : gate === "failed"
            ? `${reference}'s cascade failed; its fix comes first`
            : gate === "held"
              ? `${reference} is held`
              : `${reference}'s cascade is green`
        : `wave ${i} frees its lanes`;
    return { name: `Wave ${i + 1}`, forks: list, ...(gateText ? { gate: gateText } : {}) };
  });
  for (const f of forks) {
    if (pilot.includes(f.service)) f.role = "pilot";
    else if (f.held) f.role = "held";
    else if (f.phase === "stopped" || f.phase === "red") f.role = "stopped";
    else if (f.phase === "done") f.role = "done";
    const w = planned.findIndex((list) => list.includes(f.service));
    if (w >= 0) {
      f.role = STARTED.has(f.phase) ? "flight" : "wave";
      f.wave = w + 1;
    } else if (STARTED.has(f.phase) && f.role === "quiet") f.role = "flight";
    if (!WAITING.has(f.phase) && !STARTED.has(f.phase)) continue;
    const after = ordering.find((o) => o.service === f.service)?.after ?? [];
    f.heldBy = after.filter((a) => !onMain(byId.get(a)));
  }

  // Two forks failing the cascade on the same first error point at the move, not the fork.
  const byError = new Map<string, string[]>();
  for (const f of stops) {
    const e = f.stop?.error ? errorKey(f.stop.error) : undefined;
    if (e) byError.set(e, [...(byError.get(e) ?? []), f.service]);
  }
  const shared = [...byError.entries()].find(([, list]) => list.length >= 2);
  const paused = shared ? { forks: shared[1], error: shared[0] } : undefined;

  const opens = (f: UpFork) => f.role === "pilot" || (gate === "open" && f.wave === 1);
  const own = (f: UpFork): string | undefined => {
    if (f.phase !== "prepared" || !f.syncPr) return undefined;
    if (f.syncPr.verdict === "red") return "its sync PR is red";
    if (f.syncPr.verdict === "pending") return "its sync PR is still building";
    if (!f.tracking) return "no tracking issue read for its sync PR";
    if (f.templatePr) return `template first: #${f.templatePr.number} is open`;
    if (f.heldBy.length > 0)
      return `after ${f.heldBy.join(", ")} ${f.heldBy.length === 1 ? "is" : "are"} on main`;
    if (input.held) return "the environment is held";
    if (lanes.inflight.some((l) => l.repo === f.repo)) return "its lane is in flight";
    return undefined;
  };
  for (const f of forks) {
    if (f.phase === "idle") {
      f.verb = "prepare";
      if (f.syncBlocked) f.wait = f.syncBlocked;
      else if (f.held === "halt")
        f.wait = `halts on ${f.halt?.entry ?? "an unlisted entry"}; add a filter rule`;
    } else if (f.phase === "halted") {
      f.wait = f.halt?.open
        ? "the sync halted; add a filter rule"
        : `halts on ${f.halt?.entry ?? "an unlisted entry"}; add a filter rule`;
    } else if (f.phase === "prepared") {
      f.verb = "start";
      const why = own(f);
      if (why) f.wait = why;
    } else if (f.phase === "merged") {
      f.verb = "dispatch";
      if (input.held) f.wait = "the environment is held";
    } else if (f.phase === "stopped") {
      f.verb = "rerun";
      if (f.stop?.fixLanded === null) f.wait = "fork_integration not read yet";
      else if (!f.stop?.fixLanded) f.wait = "once a fix lands on fork_integration";
      else if (input.held) f.wait = "the environment is held";
    } else if (
      f.phase === "review" &&
      (f.toMain?.review === "REVIEW_REQUIRED" || f.toMain?.review === "CHANGES_REQUESTED")
    ) {
      f.verb = "review";
    }
    if (f.verb !== "prepare" && f.verb !== "start") continue;
    if (f.held === "snapshot") f.planWait = `held: upstream moved to ${f.snapshot}`;
    else if (f.held === "halt") f.planWait = "held until the filter carries a rule";
    else if (paused && f.verb === "start") f.planWait = "the wave is paused: absorb the move first";
    else if (!opens(f)) {
      const w = f.wave ? waves[f.wave - 1] : undefined;
      f.planWait = w?.gate ? `${w.name.toLowerCase()} starts once ${w.gate}` : "waits for its wave";
    }
  }

  const claims = (lanes.claims ?? []).length;
  // A green cascade opens a Sync to Main that borrows a lane, so every cascade press shares the room.
  let room = laneRoom(lanes);
  const laneWait = lanes.unread
    ? `lanes unknown until ${lanes.unread} are read`
    : "waits for a lane";
  const fits = (f: UpFork): boolean => {
    if (room > 0) {
      room--;
      return true;
    }
    f.planWait = laneWait;
    return false;
  };
  const dispatches = forks.filter((f) => f.verb === "dispatch" && !f.wait).filter(fits);
  const reruns = stops.filter((f) => f.verb === "rerun" && !f.wait).filter(fits);
  const startNext: UpFork[] = [];
  const startWaits: UpFork[] = [];
  for (const f of forks) {
    if (f.verb !== "start" || f.wait || f.planWait) continue;
    if (fits(f)) startNext.push(f);
    else startWaits.push(f);
  }
  for (const f of startNext) f.cells.sync = { ...f.cells.sync, text: "ready", tone: "warn" };
  const prepareNext = forks.filter((f) => f.verb === "prepare" && !f.wait && !f.planWait);
  const nextWave = gate === "open" ? 2 : 1;
  const prepareLater = forks.filter(
    (f) => f.verb === "prepare" && !f.wait && !f.held && !opens(f) && f.wave === nextWave,
  );
  const reviews = forks.filter((f) => f.verb === "review");

  const behindForks = forks.filter((f) => (f.behind ?? 0) > 0);
  const counts = behindForks.map((f) => f.behind as number);
  const moveMap = new Map<string, string[]>();
  for (const f of forks) {
    if (!WAITING.has(f.phase)) continue;
    const value = f.snapshot ?? f.moves?.find((v) => !/SNAPSHOT/i.test(v));
    if (value) moveMap.set(value, [...(moveMap.get(value) ?? []), f.service]);
  }
  const moves = [...moveMap.entries()]
    .map(([value, list]) => ({ value, forks: list }))
    .sort(
      (a, b) =>
        Number(/SNAPSHOT/i.test(a.value)) - Number(/SNAPSHOT/i.test(b.value)) ||
        b.forks.length - a.forks.length,
    );
  const fire = nextFire(toCrons([SYNC_UPSTREAM_CRON]), now);
  const moving = forks.filter(
    (f) => STARTED.has(f.phase) || f.phase === "stopped" || f.phase === "red" || f.phase === "done",
  );
  const inPlan = forks.filter((f) => WAITING.has(f.phase) || STARTED.has(f.phase));
  return {
    mode: moving.length > 0 ? "flight" : inPlan.length > 0 ? "planning" : "quiet",
    forks,
    behind: behindForks.length,
    commits: counts.reduce((a, b) => a + b, 0),
    ...(counts.length > 0
      ? { range: [Math.min(...counts), Math.max(...counts)] as [number, number] }
      : {}),
    moving: waiting.filter((f) => (f.moves?.length ?? 0) > 0),
    moves,
    snapshots: waiting.filter((f) => f.snapshot),
    halts: forks.filter((f) => f.phase === "halted"),
    reference,
    gate,
    pilot,
    waves,
    held,
    ...(paused ? { paused } : {}),
    ...(input.held ? { envHeld: input.held } : {}),
    lanes: {
      cap: lanes.cap,
      busy: lanes.inflight.length,
      claims,
      room: Number.isFinite(laneRoom(lanes)) ? laneRoom(lanes) : inPlan.length,
      ...(lanes.unread ? { unread: lanes.unread } : {}),
      holders: lanes.inflight.map((l) => l.service),
    },
    needed: forks.reduce(
      (n, f) =>
        n +
        ((WAITING.has(f.phase) && !f.held) || f.phase === "merged" || f.phase === "cascading"
          ? 2
          : f.phase === "review"
            ? 1
            : 0),
      0,
    ),
    prepareNext,
    prepareLater,
    startNext,
    startWaits,
    dispatches,
    reruns,
    reviews,
    stops,
    done,
    ordering,
    schedule: {
      ...(fire !== undefined ? { upstream: new Date(fire).toISOString() } : {}),
      opens: forks.filter((f) => f.phase === "idle" && !f.syncBlocked).map((f) => f.service),
      updates: forks.filter((f) => f.phase === "prepared").map((f) => f.service),
      halts: forks.filter((f) => f.phase === "halted" && !f.halt?.open).map((f) => f.service),
    },
  };
}

export type PlanStepKind =
  | "start"
  | "dispatch"
  | "prepare"
  | "rerun"
  | "paused"
  | "env"
  | "early"
  | "wait";

// The plan's one next press, in the order the line runs; the board and its button both read it.
export function planStep(u: UpstreamModel): { kind: PlanStepKind; forks: UpFork[] } {
  if (u.startNext.length > 0) return { kind: "start", forks: u.startNext };
  if (u.dispatches.length > 0) return { kind: "dispatch", forks: u.dispatches };
  if (u.prepareNext.length > 0) return { kind: "prepare", forks: u.prepareNext };
  if (u.reruns.length > 0) return { kind: "rerun", forks: u.reruns };
  if (u.paused) return { kind: "paused", forks: [] };
  const env = u.forks.filter(
    (f) => f.verb === "start" && !f.held && f.wait === "the environment is held",
  );
  if (u.envHeld && env.length > 0) return { kind: "env", forks: env };
  if (u.prepareLater.length > 0) return { kind: "early", forks: u.prepareLater };
  return { kind: "wait", forks: u.startWaits };
}
