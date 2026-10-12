// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { HISTORY_DAYS, type LifecycleKind } from "../config.ts";
import type { Declaration, JobDetail, LifecycleRun, PrFact, RepoFact } from "../facts.ts";
import { summarizeReason } from "./reason.ts";

export type StageState = "ok" | "failed" | "running" | "waits" | "skipped" | "cancelled";

export interface Stage {
  label: string;
  state: StageState;
}

export interface RunView {
  run: LifecycleRun;
  stages: Stage[];
  // "provision › spi up"
  failedAt?: string;
  reason?: string;
  // The stage running now, for an in-flight run.
  current?: string;
}

export interface LifecycleStat {
  green: number;
  total: number;
  streak?: { green: boolean; n: number };
  last?: LifecycleRun;
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
  // The oldest failure in the unbroken run of failed refreshes and upgrades
  // since the last green one: the cause the later failures inherit.
  failure?: RunView;
  failureChain: RunView[];
  recent: RunView[];
  lifecycle: Record<LifecycleKind, LifecycleStat>;
  bumpPr?: PrFact;
  releasePr?: PrFact;
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
    return { label, state: job ? stateOf(job.status, job.conclusion) : "waits" };
  });
  const clear = steps(jobs).find(({ step }) => CLEAR_STEP.test(step.name));
  out.push({
    label: "clear",
    state: clear ? stateOf(clear.step.status, clear.step.conclusion) : "waits",
  });
  return out;
}

function refreshStages(jobs: readonly JobDetail[]): Stage[] {
  const all = steps(jobs);
  return REFRESH_STEPS.map(([re, label]) => {
    const matched = all.filter(({ step }) => re.test(step.name));
    return {
      label,
      state:
        matched.length === 0
          ? "waits"
          : worst(matched.map(({ step }) => stateOf(step.status, step.conclusion))),
    };
  });
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
  };
}

function byCreated(a: LifecycleRun, b: LifecycleRun): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// Remote mode cannot ask the cluster, so maintenance is replayed from the
// lifecycle runs: a run that set it and did not reach Clear maintenance left it set.
export function inferMaintenance(runs: readonly LifecycleRun[]): StackModel["maintenance"] {
  let state: StackModel["maintenance"] = { state: "unknown" };
  for (const run of [...runs].sort(byCreated)) {
    if (!run.jobs) continue;
    if (stepOk(run.jobs, CLEAR_STEP)) {
      state = { state: "clear", since: run.updatedAt, run };
    } else if (stepOk(run.jobs, SET_STEP)) {
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
  return { green, total: done.length, streak, last: done[0] };
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
  const chain: LifecycleRun[] = [];
  for (const run of completed) {
    if (run.conclusion === "cancelled" || run.conclusion === "skipped") continue;
    if (run.conclusion === "success") break;
    chain.push(run);
  }
  const failureChain = chain.map(viewRun);
  const failure = failureChain[failureChain.length - 1];
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
  } else if (maintenance.state === "clear" && !failure) {
    deployable = { state: "yes", reason: "maintenance clear after the last lifecycle run" };
  } else {
    deployable = { state: "unknown", reason: "no lifecycle run in the window says" };
  }

  const prs = stackRepo?.prs ?? [];
  return {
    declaration: stackRepo?.declaration,
    declared: stackRepo?.declaration?.stackVersion,
    latest: stackRepo?.release?.tag,
    latestAt: stackRepo?.release?.at,
    running: inferRunning(both),
    maintenance,
    deployable,
    inflight,
    failure,
    failureChain,
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
  };
}
