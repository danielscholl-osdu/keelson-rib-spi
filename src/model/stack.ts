// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { HISTORY_DAYS, type LifecycleKind } from "../config.ts";
import type {
  Declaration,
  JobDetail,
  LifecycleRun,
  PrFact,
  ReleaseFact,
  RepoFact,
  StepFact,
} from "../facts.ts";
import { clip, took } from "../util.ts";
import {
  type BehindDay,
  behindDays,
  type Day,
  median,
  type RunDay,
  runDays,
  windowDays,
} from "./history.ts";
import { summarizeReason } from "./reason.ts";
import { type Cron, toCrons } from "./schedule.ts";

export type StageState = "ok" | "failed" | "running" | "waits" | "skipped" | "cancelled";

export interface Stage {
  label: string;
  state: StageState;
  startedAt?: string;
  completedAt?: string;
}

// Where a run is now, or where it stopped.
export interface Position {
  stage: string;
  step?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunView {
  run: LifecycleRun;
  stages: Stage[];
  // "provision › spi up"
  failedAt?: string;
  reason?: string;
  // The stage running now, for an in-flight run.
  current?: string;
  at?: Position;
}

export interface LifecycleStat {
  green: number;
  total: number;
  streak?: { green: boolean; n: number };
  last?: LifecycleRun;
  // Every run in the window, oldest first.
  runs: LifecycleRun[];
}

export interface StackModel {
  declaration?: Declaration;
  declared?: string;
  latest?: string;
  latestAt?: string;
  running?: { version: string; source: string; at: string };
  maintenance: { state: "set" | "clear" | "unknown"; since?: string; run?: LifecycleRun };
  deployable: { state: "yes" | "no" | "unknown"; reason: string };
  inflight?: RunView;
  lastGreen?: LifecycleRun;
  // Every refresh and upgrade since the newest green one, oldest first,
  // cancelled and running ones included.
  attempts: RunView[];
  // How long the in-flight run's current step took on green runs of its kind.
  usual?: { min: number; max: number; n: number };
  recent: RunView[];
  lifecycle: Record<LifecycleKind, LifecycleStat>;
  bumpPr?: PrFact;
  releasePr?: PrFact;
  // Undefined while the workflow files are unread.
  schedules?: Record<LifecycleKind, Cron[]>;
  history: {
    days: Day[];
    runs: Record<LifecycleKind, RunDay[]>;
    // Undefined while the releases are unread.
    behind?: BehindDay[];
  };
  // The green upgrade that put the running version in place, and how long after its release.
  landed?: { at: string; release?: ReleaseFact; lagMs?: number };
  usualLagMs?: number;
  durations: Record<"smoke" | "refresh", { lastMs?: number; usualMs?: number }>;
}

const SET_STEP = /set maintenance/i;
const CLEAR_STEP = /^Clear maintenance$/i;

function steps(jobs: readonly JobDetail[] | undefined) {
  return (jobs ?? []).flatMap((j) => j.steps.map((s) => ({ job: j, step: s })));
}

function stepOk(jobs: readonly JobDetail[] | undefined, re: RegExp): boolean {
  return steps(jobs).some(({ step }) => re.test(step.name) && step.conclusion === "success");
}

function stateOf(status: string, conclusion: string | undefined): StageState {
  if (status !== "completed") return status === "in_progress" ? "running" : "waits";
  switch (conclusion) {
    case "success":
      return "ok";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

const UPGRADE_JOBS: [RegExp, string][] = [
  [/^declare$/, "declare"],
  [/^verify-release$/, "verify-release"],
  [/^detect/, "detect"],
  [/^quiesce/, "quiesce"],
  [/^provision$/, "provision"],
  [/^verify$/, "verify"],
];

const REFRESH_STEPS: [RegExp, string][] = [
  [/^Quiesce/, "quiesce"],
  [/^spi reconcile$/, "reconcile"],
  [/^Wait for Flux/, "flux"],
  [/^Acceptance probe/, "probes"],
  [/^Verify stack version/, "verify"],
  [/^Clear maintenance$/, "clear"],
  [/^Require deployable/, "deployable"],
];

function worst(states: StageState[]): StageState {
  for (const s of ["failed", "running", "cancelled", "waits", "ok", "skipped"] as StageState[]) {
    if (states.includes(s)) return s;
  }
  return "waits";
}

function upgradeStages(jobs: readonly JobDetail[]): Stage[] {
  const out: Stage[] = UPGRADE_JOBS.map(([re, label]) => {
    const job = jobs.find((j) => re.test(j.name));
    if (!job) return { label, state: "waits" };
    return {
      label,
      state: stateOf(job.status, job.conclusion),
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  });
  const clear = steps(jobs).find(({ step }) => CLEAR_STEP.test(step.name));
  out.push(
    clear
      ? {
          label: "clear",
          state: stateOf(clear.step.status, clear.step.conclusion),
          startedAt: clear.step.startedAt,
          completedAt: clear.step.completedAt,
        }
      : { label: "clear", state: "waits" },
  );
  return out;
}

function refreshStages(jobs: readonly JobDetail[]): Stage[] {
  const all = steps(jobs);
  return REFRESH_STEPS.map(([re, label]) => {
    const matched = all.filter(({ step }) => re.test(step.name)).map(({ step }) => step);
    if (matched.length === 0) return { label, state: "waits" };
    const starts = matched.flatMap((m) => (m.startedAt ? [m.startedAt] : [])).sort();
    const ends = matched.flatMap((m) => (m.completedAt ? [m.completedAt] : [])).sort();
    return {
      label,
      state: worst(matched.map((m) => stateOf(m.status, m.conclusion))),
      startedAt: starts[0],
      completedAt: ends.length === matched.length ? ends[ends.length - 1] : undefined,
    };
  });
}

function stageLabel(kind: LifecycleKind, job: JobDetail, step: StepFact | undefined): string {
  if (kind === "upgrade") {
    if (step && CLEAR_STEP.test(step.name)) return "clear";
    return UPGRADE_JOBS.find(([re]) => re.test(job.name))?.[1] ?? job.name;
  }
  return (step && REFRESH_STEPS.find(([re]) => re.test(step.name))?.[1]) ?? job.name;
}

const STOPPED = new Set(["failure", "timed_out"]);
// Conclusions that are not a failure of the environment.
const SETTLED = new Set(["success", "cancelled", "skipped"]);

function positionOf(run: LifecycleRun): Position | undefined {
  const jobs = run.jobs ?? [];
  let job: JobDetail | undefined;
  let step: StepFact | undefined;
  if (run.status !== "completed") {
    job = jobs.find((j) => j.status === "in_progress");
    step = job?.steps.find((s) => s.status === "in_progress");
  } else if (run.conclusion === "cancelled") {
    job = jobs.find((j) => j.conclusion === "cancelled");
    step = job?.steps.find((s) => s.conclusion === "cancelled");
  } else if (run.conclusion !== "success") {
    job = jobs.find((j) => STOPPED.has(j.conclusion ?? ""));
    step = job?.steps.find((s) => STOPPED.has(s.conclusion ?? ""));
  }
  if (!job) return undefined;
  return {
    stage: stageLabel(run.kind, job, step),
    step: step?.name,
    startedAt: step?.startedAt ?? job.startedAt,
    completedAt: step?.completedAt ?? job.completedAt,
  };
}

function usualFor(view: RunView | undefined, runs: readonly LifecycleRun[]): StackModel["usual"] {
  const name = view?.at?.step;
  if (!view || !name) return undefined;
  const took: number[] = [];
  for (const run of runs) {
    if (run.kind !== view.run.kind || run.conclusion !== "success") continue;
    for (const { step } of steps(run.jobs)) {
      if (step.name !== name || !step.startedAt || !step.completedAt) continue;
      const ms = Date.parse(step.completedAt) - Date.parse(step.startedAt);
      if (Number.isFinite(ms) && ms >= 0) took.push(ms);
    }
  }
  if (took.length === 0) return undefined;
  return { min: Math.min(...took), max: Math.max(...took), n: took.length };
}

export function viewRun(run: LifecycleRun): RunView {
  const jobs = run.jobs ?? [];
  const built =
    run.kind === "upgrade"
      ? upgradeStages(jobs)
      : run.kind === "refresh"
        ? refreshStages(jobs)
        : [];
  // A finished run never reaches the stages still waiting, so they read as skipped.
  const stages =
    run.status === "completed"
      ? built.map((s) => (s.state === "waits" ? { ...s, state: "skipped" as const } : s))
      : built;
  const failedJob = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  const failedStep = failedJob?.failedStep;
  const current = stages.find((s) => s.state === "running")?.label;
  return {
    run,
    stages,
    failedAt: failedJob ? [failedJob.name, failedStep].filter(Boolean).join(" › ") : undefined,
    reason: summarizeReason(failedJob?.reason),
    current,
    at: positionOf(run),
  };
}

function byCreated(a: LifecycleRun, b: LifecycleRun): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// Remote mode cannot ask the cluster, so maintenance is replayed from the
// lifecycle runs: a run that set it and did not reach Clear maintenance left it set.
// A retry sets it again; the hold dates from the run that first set it.
export function inferMaintenance(runs: readonly LifecycleRun[]): StackModel["maintenance"] {
  let state: StackModel["maintenance"] = { state: "unknown" };
  for (const run of [...runs].sort(byCreated)) {
    if (!run.jobs) continue;
    if (stepOk(run.jobs, CLEAR_STEP)) {
      state = { state: "clear", since: run.updatedAt, run };
    } else if (stepOk(run.jobs, SET_STEP) && state.state !== "set") {
      state = { state: "set", since: run.createdAt, run };
    }
  }
  return state;
}

const DRIFT = /deployed ref \((v[\d.]+)\) drifted from declared stackVersion/;

// The running version is the newest proof: a green upgrade or refresh proves
// its target, and a refresh that failed on drift names what is deployed.
export function inferRunning(runs: readonly LifecycleRun[]): StackModel["running"] {
  const events: { version: string; source: string; at: string }[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const verb = run.kind === "upgrade" ? "env-upgrade" : "env-refresh";
    if (run.conclusion === "success" && run.target) {
      events.push({ version: run.target, source: `green ${verb}`, at: run.updatedAt });
    } else if (run.kind === "refresh" && run.conclusion === "failure") {
      const reason = (run.jobs ?? []).map((j) => j.reason ?? "").find((r) => DRIFT.test(r));
      const m = reason ? DRIFT.exec(reason) : null;
      if (m?.[1])
        events.push({ version: m[1], source: "env-refresh drift check", at: run.updatedAt });
    }
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return events[0];
}

function stat(runs: readonly LifecycleRun[], now: Date): LifecycleStat {
  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  const window = runs
    .filter((r) => r.conclusion !== "skipped" && Date.parse(r.createdAt) >= cutoff)
    .sort(byCreated);
  const done = runs
    .filter(
      (r) =>
        r.status === "completed" && r.conclusion !== "skipped" && Date.parse(r.createdAt) >= cutoff,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const green = done.filter((r) => r.conclusion === "success").length;
  let streak: LifecycleStat["streak"];
  if (done[0]) {
    const isGreen = done[0].conclusion === "success";
    let n = 0;
    for (const r of done) {
      if ((r.conclusion === "success") !== isGreen) break;
      n++;
    }
    streak = { green: isGreen, n };
  }
  return { green, total: done.length, streak, last: done[0], runs: window };
}

export function semverCmp(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function spanMs(run: LifecycleRun): number | undefined {
  const ms = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function durations(runs: readonly LifecycleRun[]): { lastMs?: number; usualMs?: number } {
  const done = runs
    .filter((r) => r.status === "completed" && r.conclusion !== "skipped")
    .sort((a, b) => byCreated(b, a));
  const last = done[0];
  const green = done.filter((r) => r.conclusion === "success").flatMap((r) => spanMs(r) ?? []);
  return { lastMs: last ? spanMs(last) : undefined, usualMs: median(green) };
}

// Each version's first green upgrade, against the release that published it.
function landings(
  upgrades: readonly LifecycleRun[],
  releases: readonly ReleaseFact[],
): { target: string; at: string; release?: ReleaseFact; lagMs?: number }[] {
  const seen = new Set<string>();
  const out: { target: string; at: string; release?: ReleaseFact; lagMs?: number }[] = [];
  for (const run of [...upgrades].sort(byCreated)) {
    if (run.status !== "completed" || run.conclusion !== "success" || !run.target) continue;
    if (seen.has(run.target)) continue;
    seen.add(run.target);
    const release = releases.find((r) => r.tag === run.target);
    const lag = release ? Date.parse(run.updatedAt) - Date.parse(release.at) : undefined;
    out.push({
      target: run.target,
      at: run.updatedAt,
      release,
      lagMs: lag !== undefined && lag >= 0 ? lag : undefined,
    });
  }
  return out;
}

export function buildStack(
  stackRepo: RepoFact | undefined,
  lifecycle: Partial<Record<LifecycleKind, LifecycleRun[]>> | undefined,
  now: Date,
): StackModel {
  const refresh = lifecycle?.refresh ?? [];
  const upgrade = lifecycle?.upgrade ?? [];
  const both = [...refresh, ...upgrade];
  const inflightRun = both
    .filter((r) => r.status !== "completed")
    .sort((a, b) => byCreated(b, a))[0];
  const completed = both.filter((r) => r.status === "completed").sort((a, b) => byCreated(b, a));
  const lastGreen = completed.find((r) => r.conclusion === "success");
  const sinceGreen = lastGreen ? Date.parse(lastGreen.createdAt) : Number.NEGATIVE_INFINITY;
  const attempts = both
    .filter((r) => r.conclusion !== "skipped" && Date.parse(r.createdAt) > sinceGreen)
    .sort(byCreated)
    .slice(-8)
    .map(viewRun);
  const failed = attempts.some(
    (a) => a.run.status === "completed" && !SETTLED.has(a.run.conclusion ?? ""),
  );
  const maintenance = inferMaintenance(both);
  const inflight = inflightRun ? viewRun(inflightRun) : undefined;

  let deployable: StackModel["deployable"];
  if (inflight) {
    deployable = {
      state: "no",
      reason: `env-${inflight.run.kind} in flight${inflight.current ? ` (${inflight.current})` : ""}`,
    };
  } else if (maintenance.state === "set") {
    deployable = { state: "no", reason: "The environment is in maintenance." };
  } else if (maintenance.state === "clear" && !failed) {
    deployable = { state: "yes", reason: "maintenance clear after the last lifecycle run" };
  } else {
    deployable = { state: "unknown", reason: "no lifecycle run in the window says" };
  }

  const prs = stackRepo?.prs ?? [];
  const running = inferRunning(both);
  const schedules = stackRepo?.schedules
    ? {
        refresh: toCrons(stackRepo.schedules.refresh),
        upgrade: toCrons(stackRepo.schedules.upgrade),
        smoke: toCrons(stackRepo.schedules.smoke),
        sweeper: toCrons(stackRepo.schedules.sweeper),
      }
    : undefined;
  const days = windowDays(now);
  const runsOf = (kind: LifecycleKind) =>
    runDays(lifecycle?.[kind] ?? [], schedules?.[kind] ?? [], days, now);
  const releases = stackRepo?.releases;
  const landed = releases ? landings(upgrade, releases) : [];
  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  const current = running ? landed.filter((l) => l.target === running.version).at(-1) : undefined;
  return {
    declaration: stackRepo?.declaration,
    declared: stackRepo?.declaration?.stackVersion,
    latest: stackRepo?.release?.tag,
    latestAt: stackRepo?.release?.at,
    running,
    maintenance,
    deployable,
    inflight,
    lastGreen,
    attempts,
    usual: usualFor(inflight, both),
    recent: completed.slice(0, 6).map(viewRun),
    lifecycle: {
      refresh: stat(refresh, now),
      upgrade: stat(upgrade, now),
      smoke: stat(lifecycle?.smoke ?? [], now),
      sweeper: stat(lifecycle?.sweeper ?? [], now),
    },
    bumpPr: prs.find((p) => p.head.startsWith("env-bump/")),
    releasePr: prs.find(
      (p) => p.head.startsWith("release-please--") || p.labels.includes("autorelease: pending"),
    ),
    schedules,
    history: {
      days,
      runs: {
        refresh: runsOf("refresh"),
        upgrade: runsOf("upgrade"),
        smoke: runsOf("smoke"),
        sweeper: runsOf("sweeper"),
      },
      behind: releases ? behindDays(releases, both, days) : undefined,
    },
    landed: current
      ? { at: current.at, release: current.release, lagMs: current.lagMs }
      : undefined,
    usualLagMs: median(
      landed.flatMap((l) => (l.lagMs !== undefined && Date.parse(l.at) >= cutoff ? [l.lagMs] : [])),
    ),
    durations: {
      smoke: durations(lifecycle?.smoke ?? []),
      refresh: durations(refresh),
    },
  };
}

// The attempts since the last green run that ended without one: failed and
// cancelled runs, which is what keeps forks off the stack.
export function stoppedAttempts(stack: StackModel): RunView[] {
  return stack.attempts.filter(
    (a) => a.run.status === "completed" && a.run.conclusion !== "success",
  );
}

// The step in flight has run past every green run of its kind, with room for noise.
export function overdue(stack: StackModel, now: Date): boolean {
  const started = stack.inflight?.at?.startedAt;
  const usual = stack.usual;
  if (!started || !usual) return false;
  return now.getTime() - Date.parse(started) > Math.max(usual.max * 1.5, usual.max + 5 * 60_000);
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 90 ? `${m}` : `${Math.floor(m / 60)}h ${m % 60}`;
}

// "green runs 1–12 min"
export function usualText(usual: StackModel["usual"]): string | undefined {
  if (!usual) return undefined;
  const lo = minutes(usual.min);
  const hi = minutes(usual.max);
  return lo === hi ? `green runs ${hi} min` : `green runs ${lo}–${hi} min`;
}

export function runName(run: LifecycleRun): string {
  return `env-${run.kind}${run.target ? ` ${run.target}` : ""}`;
}

export function runResult(run: LifecycleRun): string {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "green";
  if (run.conclusion === "cancelled") return "cancelled";
  return run.conclusion === "timed_out" ? "timed out" : "failed";
}

// "verify › Wait for Flux Kustomizations to be Ready" for an upgrade; a refresh
// is one job, so its step alone.
export function runWhere(view: RunView): string | undefined {
  const at = view.at;
  if (!at) return view.failedAt;
  if (view.run.kind !== "upgrade") return at.step ?? at.stage;
  return at.step ? `${at.stage} › ${at.step}` : at.stage;
}

export function attemptText(view: RunView, maintenanceRun?: number): string {
  const run = view.run;
  const name = `${runName(run)}${run.event === "workflow_dispatch" ? " (dispatched)" : ""}`;
  const where = runWhere(view);
  let text: string;
  if (run.status !== "completed") {
    text = `${name} in ${where ?? "progress"}`;
  } else if (run.conclusion === "cancelled") {
    const after = took(view.at?.startedAt, view.at?.completedAt);
    text = `${name} cancelled${after ? ` after ${after}` : ""}${where ? ` in ${where}` : ""}`;
  } else if (run.conclusion === "success") {
    text = `${name} green`;
  } else {
    text = `${name} failed${where ? ` in ${where}` : ""}${view.reason ? `: ${view.reason}` : ""}`;
  }
  return clip(run.id === maintenanceRun ? `${text} · set maintenance` : text, 220);
}
