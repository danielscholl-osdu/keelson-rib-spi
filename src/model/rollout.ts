// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { forkOf, githubUrl, SYNC_UPSTREAM_CRON, TEMPLATE_REPO } from "../config.ts";
import type { ForkRuns, JobDetail, PastPrFact, RunFact, TemplateChange } from "../facts.ts";
import { type Judgement, judgeRun, type OrderRule } from "../rollout.ts";
import { names, stamp } from "../util.ts";
import { classifyPr } from "./attribution.ts";
import { latestChecks } from "./checks.ts";
import { type LaneLoad, laneRoom } from "./lanes.ts";
import type { LineModel } from "./lines.ts";
import type { RadarModel } from "./radar.ts";
import { nextFire, toCrons } from "./schedule.ts";
import { type Consequence, heldBecause, type TemplateModel, type TemplateRow } from "./template.ts";

export type RolloutPhase = "ready" | "rolling" | "stopped" | "done";
// What the one primary button does next.
export type RolloutNext =
  | "start"
  | "merge"
  | "dispatch"
  | "rerun"
  | "wait"
  | "env"
  | "stopped"
  | "retarget"
  | "release";

export type CellTone = "ok" | "run" | "warn" | "bad" | "idle";

export interface Cell {
  // One or two words; the board lists the note beneath the table.
  text: string;
  tone: CellTone;
  url?: string;
  note?: string;
}

// A run that failed only on the shared environment, owed its one re-run.
export interface EnvRerun {
  service: string;
  repo: string;
  runId: number;
  where: "PR" | "main";
  pr?: number;
  headSha?: string;
  url?: string;
}

export interface RolloutFork {
  service: string;
  repo: string;
  pr?: { number: number; url: string; headSha: string };
  // Its open template-sync PR carries the target.
  carries: boolean;
  onTarget: boolean;
  // The template-sync merge this fork's main runs on, and the main run it started.
  merged?: { at: string; number: number; url: string };
  mainRun?: RunFact;
  validation: Cell;
  review: Cell;
  merge: Cell;
  main: Cell;
  // Approved, green and carrying the target; ordering may still hold it.
  ready: boolean;
  // Forks it merges after that have not merged with a green main run yet.
  heldBy: string[];
  env?: EnvRerun;
  red?: { run: RunFact; job?: JobDetail; judgement?: Judgement };
  // The last green main run before the merge, to pin back to.
  lastGood?: { sha: string; at: string; url: string };
  released: boolean;
  unread: boolean;
  // Why no fleet button touches it: a mirror never runs Sync Template.
  skip?: string;
}

export interface ReachingChange {
  change: TemplateChange;
  consequences: Consequence[] | null;
  paths: string[];
}

export interface RolloutModel {
  phase: RolloutPhase;
  next: RolloutNext;
  held?: string;
  target: { sha: string; label: string; url: string };
  // The oldest position a fork still runs, when it is not the target.
  from?: { sha: string; label: string };
  // Every change past the oldest fork position, and how many of them touch synced paths.
  changes: ReachingChange[];
  reaching: number;
  consequences: Consequence[];
  // The change reaches images, actions or workflows, so each PR and each merge borrows a lane.
  borrows: boolean;
  lanes: {
    cap: number | null;
    busy: number;
    room: number;
    needed: number;
    waves: number | null;
    unread?: string;
  };
  ordering: OrderRule[];
  forks: RolloutFork[];
  total: number;
  merged: number;
  mainGreen: number;
  stops: RolloutFork[];
  // What the next press of each verb would touch, in board order, after merges take their room.
  mergeNext: RolloutFork[];
  mergeWaits: RolloutFork[];
  dispatchNext: RolloutFork[];
  dispatchWaits: RolloutFork[];
  envReruns: EnvRerun[];
  reviews: RolloutFork[];
  started?: string;
  finished?: string;
  released: number;
  rerunsUsed: string[];
  schedule: {
    upstream?: string;
    // Forks whose next upstream sync opens a PR; `upstreamMaybe` of them carry only filtered paths
    // and may open none, and `upstreamHalts` open a sync-failed issue instead.
    upstreamForks: number;
    upstreamMaybe: number;
    upstreamHalts: string[];
    template?: string;
    templateOpens: number;
  };
}

// A main run started this long after a merge is the merge's own run.
const MERGE_RUN_MS = 15 * 60_000;
// A stop counts for merges this recent; older red mains are the line's own item.
const STOP_WINDOW_MS = 7 * 86_400_000;
// A finished rollout stays on the board this long, to offer Fleet Release.
const DONE_WINDOW_MS = 24 * 3_600_000;
const BORROWING: Consequence[] = ["images", "actions", "workflows"];
const VALIDATION = "Validation";

function cell(text: string, tone: CellTone, url?: string, note?: string): Cell {
  return { text, tone, ...(url ? { url } : {}), ...(note ? { note } : {}) };
}

const DASH = cell("·", "idle");

function lastMerge(past: readonly PastPrFact[] | undefined): PastPrFact | undefined {
  return (past ?? [])
    .filter((p) => p.mergedAt && classifyPr(p) === "template")
    .sort((a, b) => Date.parse(b.mergedAt as string) - Date.parse(a.mergedAt as string))[0];
}

// The main run the merge pushed, while nothing has pushed to main since.
function mergeRun(runs: ForkRuns | undefined, mergedAt: string): RunFact | undefined {
  const latest = runs?.main[0];
  if (!latest) return undefined;
  const lag = Date.parse(latest.createdAt) - Date.parse(mergedAt);
  return lag >= -60_000 && lag <= MERGE_RUN_MS ? latest : undefined;
}

function lastGoodBefore(runs: ForkRuns | undefined, at: string): RolloutFork["lastGood"] {
  const run = runs?.main.find(
    (r) => r.conclusion === "success" && Date.parse(r.createdAt) < Date.parse(at),
  );
  return run ? { sha: run.sha, at: run.createdAt, url: run.url } : undefined;
}

function mainCell(run: RunFact | undefined, judgement: Judgement | undefined, now: Date): Cell {
  if (!run) return cell("unread", "idle", undefined, "main run not read");
  if (run.status !== "completed") return cell("running", "run", run.url);
  if (run.conclusion === "success") {
    return run.attempt > 1
      ? cell(`green ×${run.attempt}`, "ok", run.url, `main run green on attempt ${run.attempt}`)
      : cell("green", "ok", run.url);
  }
  if (!judgement)
    return cell(
      "red",
      "warn",
      run.url,
      `main run red${stamp(run.updatedAt, now) ? ` at ${stamp(run.updatedAt, now)}` : ""}, failed jobs still being read`,
    );
  return judgement.class === "environment"
    ? cell("env", "warn", run.url, `main run hit an environment failure on attempt ${run.attempt}`)
    : cell("red", "bad", run.url);
}

function validationCell(
  row: TemplateRow,
  carries: boolean,
): { cell: Cell; env?: Omit<EnvRerun, "service" | "repo"> } {
  const pr = row.pr;
  if (!pr) {
    if (row.syncing) return { cell: cell("syncing", "run", row.syncing.url) };
    if (row.dispatched) {
      return {
        cell: cell("dispatched", "run", undefined, "Sync Template dispatched, holding a lane"),
      };
    }
    return { cell: cell("lane", "idle", undefined, "Sync Template waits for a lane") };
  }
  if (!carries) {
    if (row.syncing) return { cell: cell("syncing", "run", row.syncing.url) };
    return {
      cell: cell("behind", "warn", pr.url, `its PR carries ${row.target ?? "an older template"}`),
    };
  }
  const validation = latestChecks(pr.checks).filter((c) => c.workflow === VALIDATION);
  if (validation.some((c) => c.status !== "COMPLETED")) {
    return { cell: cell("running", "run", pr.url, "Validation running, holding a lane") };
  }
  const env = row.failures.find((f) => !f.hidden && f.cls === "ENV");
  if (env?.judgement?.response === "rerun-failed") {
    const runId = pr.checks.find((c) => c.name === env.check && c.url === env.url)?.runId;
    return {
      cell: cell(
        "env",
        "warn",
        env.url ?? pr.url,
        "Validation hit an environment failure on attempt 1, owed one re-run",
      ),
      ...(runId
        ? { env: { runId, where: "PR" as const, pr: pr.number, headSha: pr.headSha, url: env.url } }
        : {}),
    };
  }
  if (env?.judgement?.response === "stop") {
    return {
      cell: cell(
        "red",
        "bad",
        env.url ?? pr.url,
        `Validation red: ${env.judgement.note ?? "real failure"}`,
      ),
    };
  }
  if (env) {
    return {
      cell: cell(
        "env",
        "warn",
        env.url ?? pr.url,
        "Validation failed on the environment's own hold",
      ),
    };
  }
  const own = row.failures.find((f) => !f.hidden && f.cls !== "POLICY" && f.cls !== "ENV");
  if (own || row.verdict === "red") {
    return {
      cell: cell("red", "bad", own?.url ?? pr.url, own ? `Validation red: ${own.cls}` : undefined),
    };
  }
  if (row.verdict === "pending") return { cell: cell("running", "run", pr.url) };
  return { cell: cell("green", "ok", pr.url) };
}

function reviewCell(row: TemplateRow): Cell {
  const decision = row.pr?.reviewDecision;
  if (decision === "APPROVED") return cell("approved", "ok");
  if (decision === "CHANGES_REQUESTED")
    return cell("changes", "bad", undefined, "changes requested");
  if (decision === "REVIEW_REQUIRED") return cell("review", "warn", undefined, "needs review");
  return cell("not needed", "idle");
}

function upstreamOpens(
  queued: readonly LineModel[],
  radar: RadarModel | undefined,
): { upstreamForks: number; upstreamMaybe: number; upstreamHalts: string[] } {
  const halts: string[] = [];
  let forks = 0;
  let maybe = 0;
  for (const l of queued) {
    const svc = radar?.services[l.fork.id];
    if (l.halt || svc?.state === "halted" || svc?.state === "will-halt") {
      halts.push(l.fork.id);
      continue;
    }
    forks++;
    const verdicts = [...(svc?.certain ?? []), ...(svc?.possible ?? [])];
    if (verdicts.length > 0 && verdicts.every((v) => v.bucket === "Filtered")) maybe++;
  }
  return { upstreamForks: forks, upstreamMaybe: maybe, upstreamHalts: halts };
}

// Each change past the oldest fork position, with what it reaches in a fork.
function reachingChanges(t: TemplateModel): ReachingChange[] {
  const reach = new Map<string, { consequences: Consequence[]; paths: string[] } | null>();
  for (const step of t.steps) for (const [sha, r] of Object.entries(step.reach)) reach.set(sha, r);
  return t.changes
    .filter((c) => c.forks > 0)
    .map((change) => {
      const r = reach.get(change.sha);
      return {
        change,
        consequences: r === undefined || r === null ? null : r.consequences,
        paths: r?.paths ?? [],
      };
    });
}

function earliest(times: readonly (string | undefined)[]): string | undefined {
  const ok = times.filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  return ok.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

function latest(times: readonly (string | undefined)[]): string | undefined {
  const ok = times.filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  return ok.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

// The rollout of osdu-spi main to the fleet, or undefined when main carries nothing a
// fork lacks that reaches it and no rollout has just stopped or finished.
export function buildRollout(input: {
  template: TemplateModel;
  lines: readonly LineModel[];
  runs: Record<string, ForkRuns> | undefined;
  lanes: LaneLoad;
  ordering?: readonly OrderRule[];
  // Why the shared environment takes no new lanes right now, when it is held.
  held?: string;
  radar?: RadarModel;
  now: Date;
}): RolloutModel | undefined {
  const { template: t, lines, runs, lanes, now } = input;
  const head = t.head;
  if (!head || t.rows.length === 0) return undefined;
  const label = t.steps[0]?.label ?? t.headLabel;
  const changes = reachingChanges(t);
  const reaching = changes.filter((c) => c.consequences === null || c.consequences.length > 0);
  const found = new Set(reaching.flatMap((c) => c.consequences ?? []));
  const consequences = (
    ["images", "actions", "workflows", "settings", "fork resources"] as const
  ).filter((c) => found.has(c));
  const borrows =
    consequences.some((c) => BORROWING.includes(c)) ||
    reaching.some((c) => c.consequences === null);

  const byService = new Map(lines.map((l) => [l.fork.id, l]));
  const forks: RolloutFork[] = t.rows.map((row) => {
    const line = byService.get(row.service);
    const forkRuns = runs?.[row.repo];
    const carries = !!row.pr && row.pr.headMarker === head.sha;
    const onTarget = row.behind === 0;
    const merge = lastMerge(line?.past);
    const run = merge?.mergedAt ? mergeRun(forkRuns, merge.mergedAt) : undefined;
    const jobs = run ? forkRuns?.mainRunJobs?.[String(run.id)] : undefined;
    const failed = (jobs ?? []).filter(
      (j) => j.conclusion === "failure" && j.name !== "Validation Summary",
    );
    const judgement =
      run?.status === "completed" && run.conclusion === "failure" && failed.length > 0
        ? judgeRun(failed)
        : undefined;
    const recent =
      !!merge?.mergedAt && now.getTime() - Date.parse(merge.mergedAt) <= STOP_WINDOW_MS;
    const v = validationCell(row, carries);
    const red =
      recent && run?.status === "completed" && run.conclusion === "failure"
        ? { run, ...(failed[0] ? { job: failed[0] } : {}), ...(judgement ? { judgement } : {}) }
        : undefined;
    const mainEnv =
      red && judgement?.response === "rerun-failed"
        ? { runId: run?.id as number, where: "main" as const, url: run?.url }
        : undefined;
    const env = v.env ?? mainEnv;
    const fork: RolloutFork = {
      service: row.service,
      repo: row.repo,
      ...(row.pr
        ? { pr: { number: row.pr.number, url: row.pr.url, headSha: row.pr.headSha } }
        : {}),
      carries,
      onTarget,
      ...(merge?.mergedAt && (onTarget || red)
        ? { merged: { at: merge.mergedAt, number: merge.number, url: merge.url } }
        : {}),
      ...(run && (onTarget || red) ? { mainRun: run } : {}),
      validation: onTarget ? cell("green", "ok") : v.cell,
      review: onTarget ? cell("reviewed", "ok") : carries ? reviewCell(row) : DASH,
      merge: DASH,
      main: onTarget || red ? mainCell(run, judgement, now) : DASH,
      ready: carries && !heldBecause(row),
      heldBy: [],
      ...(env ? { env: { service: row.service, repo: row.repo, ...env } } : {}),
      ...(red && judgement?.response !== "rerun-failed" ? { red } : {}),
      ...(merge?.mergedAt && (onTarget || red)
        ? (() => {
            const good = lastGoodBefore(forkRuns, merge.mergedAt as string);
            return good ? { lastGood: good } : {};
          })()
        : {}),
      released:
        !!merge?.mergedAt &&
        !!line?.release?.at &&
        Date.parse(line.release.at) > Date.parse(merge.mergedAt),
      unread: row.behind === undefined,
      ...(() => {
        const mirror = forkOf(row.repo)?.mirror;
        return mirror ? { skip: "mirror" } : mirror === null ? { skip: "sync mode unread" } : {};
      })(),
    };
    if (onTarget && merge?.mergedAt) {
      fork.merge = cell(stamp(merge.mergedAt, now) ?? "merged", "ok", merge.url);
    } else if (onTarget) fork.merge = cell("on main", "ok");
    return fork;
  });

  const green = (f: RolloutFork) =>
    f.onTarget && f.mainRun?.status === "completed" && f.mainRun.conclusion === "success";
  const ordering = (input.ordering ?? []).filter((r) => forks.some((f) => f.service === r.service));
  for (const rule of ordering) {
    const fork = forks.find((f) => f.service === rule.service);
    if (!fork || fork.onTarget) continue;
    fork.heldBy = rule.after.filter((a) => {
      const before = forks.find((f) => f.service === a);
      return before !== undefined && !green(before);
    });
  }

  const stops = forks.filter((f) => f.red);
  const total = forks.length;
  const merged = forks.filter((f) => f.onTarget).length;
  const allOn = forks.every((f) => f.onTarget);
  const lastMerged = latest(forks.map((f) => f.merged?.at));
  const recentDone =
    allOn && !!lastMerged && now.getTime() - Date.parse(lastMerged) <= DONE_WINDOW_MS;
  if (reaching.length === 0 && stops.length === 0 && !recentDone) return undefined;

  const moving = forks.some((f) => f.carries || (!f.onTarget && f.validation.tone === "run"));
  const phase: RolloutPhase =
    stops.length > 0
      ? "stopped"
      : allOn && forks.every(green)
        ? "done"
        : merged === 0 && !moving
          ? "ready"
          : "rolling";

  // Merges take the free lanes first; dispatches get what is left.
  const room = laneRoom(lanes);
  const stoppedHere = new Set(stops.map((f) => f.service));
  const mergeable = forks.filter(
    (f) =>
      f.ready &&
      !f.skip &&
      f.heldBy.length === 0 &&
      (phase !== "stopped" || stoppedHere.has(f.service)) &&
      !lanes.inflight.some((l) => l.repo === f.repo),
  );
  const mergeNext = mergeable.slice(0, Math.min(mergeable.length, room));
  const mergeWaits = mergeable.slice(mergeNext.length);
  const dispatchable =
    phase === "stopped"
      ? []
      : forks.filter(
          (f) =>
            !f.onTarget &&
            !f.unread &&
            !f.skip &&
            !f.carries &&
            f.validation.tone !== "run" &&
            !lanes.inflight.some((l) => l.repo === f.repo),
        );
  const left = Math.max(0, room - mergeNext.length);
  const dispatchNext = dispatchable.slice(0, Math.min(dispatchable.length, left));
  const dispatchWaits = dispatchable.slice(dispatchNext.length);

  if (phase === "stopped") {
    for (const f of forks) if (!f.onTarget && !f.red) f.merge = cell("paused", "idle");
  } else {
    for (const f of mergeNext) {
      f.merge = input.held
        ? cell("env", "idle", undefined, "merges once the environment is deployable")
        : cell("next", "warn", undefined, "merges on the next press");
    }
    for (const f of mergeWaits) f.merge = cell("lane", "idle", undefined, "merge waits for a lane");
    for (const f of forks) {
      if (f.onTarget || !f.carries || f.heldBy.length === 0) continue;
      f.merge = cell("held", "idle", undefined, `merges after ${names(f.heldBy)}`);
    }
  }
  for (const f of dispatchWaits) {
    if (!f.pr) f.validation = cell("lane", "idle", undefined, "Sync Template waits for a lane");
  }
  for (const f of dispatchNext) {
    if (f.pr) continue;
    f.validation = input.held
      ? cell("env", "idle", undefined, "dispatches once the environment is deployable")
      : cell("next", "warn", undefined, "Sync Template dispatches on the next press");
  }

  // A PR still to validate takes a lane for that and one for its merge; a green one only the merge.
  const needed = borrows
    ? forks.reduce((n, f) => {
        if (f.onTarget) return n;
        if (f.carries && f.validation.tone === "ok") return n + 1;
        return n + 2;
      }, 0)
    : 0;
  const togo = forks.filter((f) => !f.onTarget).length;
  const fire = nextFire(toCrons([SYNC_UPSTREAM_CRON]), now);
  const stepFrom = t.steps[t.steps.length - 1];
  const sync = (l: LineModel) => (l.upstream?.commits.length ?? 0) > 0;

  // An environment failure is re-run once, after the other lanes drain.
  const drained = lanes.inflight.length === 0 && !lanes.unread && !input.held;
  const envReruns = forks.flatMap((f) => (f.env ? [f.env] : []));
  const retarget = stops.some(
    (f) => t.rows.find((r) => r.service === f.service)?.marker !== head.sha,
  );
  const chosen: RolloutNext =
    phase === "done"
      ? "release"
      : phase === "stopped"
        ? mergeNext.length > 0
          ? "merge"
          : retarget && stops.some((f) => !f.carries)
            ? "retarget"
            : "stopped"
        : mergeNext.length > 0
          ? "merge"
          : dispatchNext.length > 0
            ? phase === "ready"
              ? "start"
              : "dispatch"
            : envReruns.length > 0 && drained
              ? "rerun"
              : phase === "ready"
                ? "start"
                : "wait";
  // A held environment takes no new lane: nothing that deploys is offered until it reads deployable.
  const next: RolloutNext =
    input.held && ["start", "merge", "dispatch", "rerun", "retarget", "wait"].includes(chosen)
      ? "env"
      : chosen;

  return {
    phase,
    next,
    ...(input.held ? { held: input.held } : {}),
    target: {
      sha: head.sha,
      label,
      url: githubUrl(TEMPLATE_REPO, `/commit/${head.sha}`),
    },
    ...(stepFrom && stepFrom.marker !== head.sha
      ? { from: { sha: stepFrom.marker, label: stepFrom.label } }
      : {}),
    changes,
    reaching: reaching.length,
    consequences,
    borrows,
    lanes: {
      cap: lanes.cap,
      busy: lanes.inflight.length,
      room: Number.isFinite(room) ? room : togo,
      needed,
      waves: lanes.cap ? Math.ceil(togo / lanes.cap) : null,
      ...(lanes.unread ? { unread: lanes.unread } : {}),
    },
    ordering,
    forks,
    total,
    merged,
    mainGreen: forks.filter(green).length,
    stops,
    mergeNext,
    mergeWaits,
    dispatchNext,
    dispatchWaits,
    envReruns,
    reviews: forks.filter(
      (f) => f.carries && (f.review.tone === "warn" || f.review.tone === "bad"),
    ),
    ...(() => {
      const started = earliest(
        forks.flatMap((f) => [
          f.carries ? t.rows.find((r) => r.service === f.service)?.pr?.createdAt : undefined,
          f.onTarget ? f.merged?.at : undefined,
          t.rows.find((r) => r.service === f.service)?.syncing?.createdAt,
          t.rows.find((r) => r.service === f.service)?.dispatched,
        ]),
      );
      return started ? { started } : {};
    })(),
    ...(phase === "done" && lastMerged ? { finished: lastMerged } : {}),
    released: forks.filter((f) => f.released).length,
    rerunsUsed: forks
      .filter((f) => f.onTarget && (f.mainRun?.attempt ?? 1) > 1)
      .map((f) => f.service),
    schedule: {
      ...(fire !== undefined ? { upstream: new Date(fire).toISOString() } : {}),
      ...upstreamOpens(lines.filter(sync), input.radar),
      ...(t.nextSync ? { template: t.nextSync } : {}),
      templateOpens: forks.filter((f) => !f.onTarget && !f.pr && f.validation.tone !== "run")
        .length,
    },
  };
}
