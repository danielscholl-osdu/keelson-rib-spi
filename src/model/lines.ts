// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasTone } from "@keelson/shared";
import { type ForkDef, HISTORY_DAYS } from "../config.ts";
import type {
  DeploymentFact,
  ForkRuns,
  IssueFact,
  JobDetail,
  PrFact,
  RepoFact,
  RunFact,
  TemplateCompare,
  UpstreamFact,
} from "../facts.ts";
import { days, plural, stamp } from "../util.ts";
import {
  classOf,
  type Failure,
  type FailureClass,
  type PrClass,
  prFailures,
  toolchainText,
} from "./attribution.ts";
import { prVerdict } from "./checks.ts";
import type { StackModel } from "./stack.ts";

export type StationId = "upstream" | "sync" | "cascade" | "main" | "release" | "lane";
export type StationState = "idle" | "moving" | "waiting" | "stopped" | "unknown";

export interface Station {
  id: StationId;
  state: StationState;
  text: string;
}

export interface Halt {
  code: string;
  detail: string;
  issue: IssueFact;
  days: number;
}

export interface LinePr {
  pr: PrFact;
  prClass: PrClass;
  failures: Failure[];
}

export interface Delivery {
  run?: RunFact;
  state: "ok" | "failed" | "stale" | "unknown";
}

export interface MainFailure {
  run: RunFact;
  job?: JobDetail;
  cls: FailureClass;
}

export interface LineModel {
  fork: ForkDef;
  url: string;
  stations: Station[];
  pill: { label: string; tone: CanvasTone };
  current: boolean;
  upstream?: UpstreamFact;
  release?: RepoFact["release"];
  releasePr?: LinePr;
  syncPr?: LinePr;
  cascadePr?: LinePr;
  templatePr?: LinePr;
  tracking?: IssueFact;
  halt?: Halt;
  conflicts: IssueFact[];
  cascadeLabels: string[];
  labelsIssue?: IssueFact;
  mainRed?: MainFailure;
  mainRun?: RunFact;
  runsRead: boolean;
  cascadeRunning: boolean;
  cascadeStop: boolean;
  syncRun?: RunFact;
  syncFailedSince?: number;
  templateRun?: RunFact;
  templateDelivery: Delivery;
  lane: { ok: number; failed: number; last?: DeploymentFact };
  template: {
    marker?: string;
    label?: string;
    behind?: number;
    target?: string;
    awaitingRun?: boolean;
  };
  autoMerge?: boolean;
  why?: string;
  prs: LinePr[];
}

const CASCADE_STOP = ["cascade-failed", "cascade-blocked", "conflict", "validation-failed"];

// Sync Template runs daily, so a delivery older than one and a half days is stale.
const STALE_MS = 36 * 3_600_000;

export function deliveryOf(run: RunFact | undefined, now: Date): Delivery {
  if (!run) return { state: "unknown" };
  if (run.conclusion !== "success") return { run, state: "failed" };
  return { run, state: now.getTime() - Date.parse(run.createdAt) > STALE_MS ? "stale" : "ok" };
}

export function parseHaltCode(issue: IssueFact, now: Date): Halt | undefined {
  if (!issue.halt) return undefined;
  const m = /^([A-Z][A-Z_]+):\s*(.*)$/.exec(issue.halt);
  return {
    code: m?.[1] ?? "HALT",
    detail: (m?.[2] ?? issue.halt).trim(),
    issue,
    days: days(issue.createdAt, now) ?? 0,
  };
}

// "unclassified top-level entries: schemathesis-tests" reads as its subject.
function haltSubject(detail: string): string {
  const parts = detail.split(":");
  return (parts[parts.length - 1] ?? detail).trim();
}

function laneStats(deployments: readonly DeploymentFact[], now: Date): LineModel["lane"] {
  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  const recent = deployments.filter((d) => Date.parse(d.createdAt) >= cutoff);
  return {
    ok: recent.filter((d) => d.state === "SUCCESS").length,
    failed: recent.filter((d) => d.state === "FAILURE" || d.state === "ERROR").length,
    last: deployments.find(
      (d) => d.state === "SUCCESS" || d.state === "FAILURE" || d.state === "ERROR",
    ),
  };
}

function prRed(p: LinePr | undefined): boolean {
  return !!p && prVerdict(p.pr) === "red";
}

function failureText(f: Failure | undefined): string {
  if (!f) return "red";
  const tool = f.cls === "TOOLCHAIN" ? toolchainText(f.reason) : undefined;
  return `${f.check}${tool ? `: ${tool}` : f.reason ? `: ${f.reason}` : ""}`;
}

function mainFailure(runs: ForkRuns | undefined): MainFailure | undefined {
  const last = runs?.main.find((r) => r.status === "completed");
  if (
    !last ||
    last.conclusion === "success" ||
    last.conclusion === "cancelled" ||
    last.conclusion === "skipped"
  ) {
    return undefined;
  }
  const job = runs?.mainJobs?.find(
    (j) => j.conclusion === "failure" && j.name !== "Validation Summary",
  );
  const cls = job ? classOf(job.name, "human", job.failedStep, job) : "UNREAD";
  return { run: last, job, cls };
}

export function buildLine(input: {
  fork: ForkDef;
  repo: RepoFact | undefined;
  runs: ForkRuns | undefined;
  upstream: UpstreamFact | undefined;
  compares: Record<string, TemplateCompare>;
  targets: Record<string, string>;
  templateHead?: { sha: string; at: string };
  details: Record<string, JobDetail>;
  stack: StackModel;
  now: Date;
}): LineModel {
  const { fork, repo, runs, upstream, compares, targets, templateHead, details, stack, now } =
    input;
  const prs: LinePr[] = (repo?.prs ?? []).map((pr) => ({ pr, ...prFailures(pr, details) }));
  const pick = (cls: PrClass) => prs.find((p) => p.prClass === cls);
  const syncPr = pick("sync");
  const cascadePr = pick("cascade");
  const templatePr = pick("template");
  const releasePr = pick("release");
  const issues = repo?.issues ?? [];
  const haltIssue = issues.find((i) => i.labels.includes("sync-failed"));
  const halt = haltIssue ? parseHaltCode(haltIssue, now) : undefined;
  const tracking = issues.find(
    (i) => i.labels.includes("upstream-sync") && /Upstream Sync/i.test(i.title),
  );
  const conflicts = issues.filter(
    (i) => i.labels.includes("conflict") || i.labels.includes("cascade-blocked"),
  );
  const cascadeLabels =
    tracking?.labels.filter(
      (l) => l.startsWith("cascade-") || l === "validated" || l === "upstream-held",
    ) ?? [];
  const labelsIssue = issues.find((i) => /Label Configuration Update Required/i.test(i.title));
  const mainRed = mainFailure(runs);
  const syncRun = runs?.sync.find((r) => r.status === "completed");
  const templateRun = runs?.template.find((r) => r.status === "completed");
  const cascadeRunning = runs?.cascade.some((r) => r.status !== "completed") ?? false;
  const syncFailedSince = halt
    ? runs?.sync.filter(
        (r) =>
          r.conclusion === "failure" && Date.parse(r.createdAt) >= Date.parse(halt.issue.createdAt),
      ).length
    : undefined;
  const lag = upstream?.lag;
  const marker = repo?.marker;
  const compare = marker ? compares[marker] : undefined;
  const templateBehind = compare?.aheadBy;
  const templateDelivery = deliveryOf(templateRun, now);
  const targetSha = templatePr?.pr.headMarker;
  const templateFailure = templatePr?.failures.find(
    (f) => !f.hidden && f.cls !== "ENV" && f.cls !== "POLICY",
  );
  // A template change that landed after the last Sync Template run waits for the next one.
  const awaitingRun =
    !!templateBehind &&
    !templatePr &&
    (!templateRun ||
      (!!templateHead && Date.parse(templateHead.at) > Date.parse(templateRun.createdAt)));

  const stations: Station[] = [];
  // upstream
  if (lag === undefined)
    stations.push({ id: "upstream", state: "unknown", text: "lag unmeasured" });
  else if (lag === 0) stations.push({ id: "upstream", state: "idle", text: "0 behind" });
  else
    stations.push({
      id: "upstream",
      state: "waiting",
      text: `${lag} behind${halt ? " · held by the halt" : syncPr ? " · in the sync PR" : ""}`,
    });
  // sync
  if (halt) stations.push({ id: "sync", state: "stopped", text: `halted: ${halt.code}` });
  else if (syncPr && prRed(syncPr))
    stations.push({ id: "sync", state: "stopped", text: `PR #${syncPr.pr.number} red` });
  else if (syncPr)
    stations.push({ id: "sync", state: "waiting", text: `gate 1 · PR #${syncPr.pr.number}` });
  else if (syncRun && syncRun.conclusion === "failure")
    stations.push({ id: "sync", state: "stopped", text: "Sync Upstream failed" });
  else stations.push({ id: "sync", state: "idle", text: "clean" });
  // cascade
  const cascadeStop = conflicts.length > 0 || cascadeLabels.some((l) => CASCADE_STOP.includes(l));
  if (cascadeStop)
    stations.push({
      id: "cascade",
      state: "stopped",
      text:
        conflicts.length > 0
          ? "conflict"
          : (cascadeLabels.find((l) => CASCADE_STOP.includes(l)) ?? "blocked"),
    });
  else if (cascadeRunning || cascadeLabels.includes("cascade-active"))
    stations.push({ id: "cascade", state: "moving", text: "running" });
  else if (cascadeLabels.includes("upstream-held"))
    stations.push({ id: "cascade", state: "waiting", text: "held" });
  else stations.push({ id: "cascade", state: "idle", text: "idle" });
  // main
  if (cascadePr && prRed(cascadePr))
    stations.push({
      id: "main",
      state: "stopped",
      text: `gate 2 · PR #${cascadePr.pr.number} red`,
    });
  else if (cascadePr)
    stations.push({ id: "main", state: "waiting", text: `gate 2 · PR #${cascadePr.pr.number}` });
  else if (mainRed && mainRed.cls !== "ENV")
    stations.push({ id: "main", state: "stopped", text: "main red" });
  else stations.push({ id: "main", state: "idle", text: "idle" });
  // release
  if (releasePr)
    stations.push({ id: "release", state: "waiting", text: `gate 3 · PR #${releasePr.pr.number}` });
  else stations.push({ id: "release", state: "idle", text: repo?.release?.tag ?? "no release" });
  // stack lane
  const lane = laneStats(repo?.deployments ?? [], now);
  if (stack.deployable.state === "no")
    stations.push({ id: "lane", state: "stopped", text: "blocked by the stack" });
  else if (lane.last && lane.last.state !== "SUCCESS")
    stations.push({ id: "lane", state: "waiting", text: "last run failed" });
  else if (lane.last) stations.push({ id: "lane", state: "idle", text: "last run ok" });
  else stations.push({ id: "lane", state: "unknown", text: "no run yet" });

  let pill: LineModel["pill"];
  let why: string | undefined;
  const syncFailure = syncPr?.failures.find((f) => f.cls !== "POLICY") ?? syncPr?.failures[0];
  if (halt) {
    pill = { label: "sync halted", tone: "error" };
    why = `${halt.code} ${haltSubject(halt.detail)} · halted ${plural(halt.days, "day")}`;
  } else if (cascadeStop) {
    pill = { label: "cascade blocked", tone: "error" };
    why = conflicts[0]
      ? `${conflicts[0].title}`
      : `tracking issue labeled ${cascadeLabels.join(", ")}`;
  } else if (syncPr && prRed(syncPr)) {
    pill = { label: "sync blocked", tone: "error" };
    why = `${failureText(syncFailure)} · ${plural(days(syncPr.pr.createdAt, now) ?? 0, "day")}`;
  } else if (mainRed && mainRed.cls !== "ENV") {
    pill = { label: "main red", tone: "error" };
    why = `${mainRed.job?.name ?? "Validation"} failed on main${mainRed.job?.failedStep ? ` › ${mainRed.job.failedStep}` : ""}`;
  } else if (templateDelivery.state === "failed") {
    pill = { label: "template blocked", tone: "error" };
    why = "Sync Template failed; template changes stop reaching this fork";
  } else if (templateBehind && !templatePr && !awaitingRun) {
    pill = { label: "template blocked", tone: "error" };
    why = `${plural(templateBehind, "template commit")} behind and no template-sync PR open`;
  } else if (templatePr && templateFailure) {
    pill = { label: "template blocked", tone: "error" };
    why = `template-sync PR #${templatePr.pr.number} fails ${failureText(templateFailure)}`;
  } else if (syncPr) {
    pill = { label: "gate 1 waiting", tone: "warn" };
  } else if (cascadePr) {
    pill = { label: "gate 2 waiting", tone: "warn" };
  } else if (lag !== undefined && lag > 0) {
    pill = { label: "behind", tone: "warn" };
    why = `${plural(lag, "upstream commit")} not yet synced; the next daily sync runs at 00:00Z`;
  } else if (templateDelivery.state === "stale" && templateDelivery.run) {
    pill = { label: "template stale", tone: "warn" };
    why = `Sync Template last ran ${stamp(templateDelivery.run.createdAt, now)}; it runs daily`;
  } else if (templatePr && templateBehind) {
    pill = { label: "template waiting", tone: "warn" };
  } else if (awaitingRun) {
    pill = { label: "template behind", tone: "warn" };
    why = templateRun
      ? "osdu-spi main moved after the last Sync Template run; the next daily run opens the PR"
      : "no Sync Template run read for this fork";
  } else if (lag === undefined) {
    pill = { label: "lag unmeasured", tone: "neutral" };
  } else if (templateBehind === undefined) {
    pill = { label: "template unmeasured", tone: "neutral" };
  } else if (releasePr) {
    pill = { label: "release ready", tone: "info" };
  } else {
    pill = { label: "current", tone: "ok" };
  }
  const current = pill.label === "current" || pill.label === "release ready";

  return {
    fork,
    url: repo?.url ?? `https://github.com/${fork.repo}`,
    stations,
    pill,
    current,
    upstream,
    release: repo?.release,
    releasePr,
    syncPr,
    cascadePr,
    templatePr,
    tracking,
    halt,
    conflicts,
    cascadeLabels,
    labelsIssue,
    mainRed,
    mainRun: runs?.main.find((r) => r.status === "completed"),
    runsRead: runs !== undefined,
    cascadeRunning,
    cascadeStop,
    syncRun,
    syncFailedSince,
    templateRun,
    templateDelivery,
    lane,
    template: {
      marker,
      label: compare?.label,
      behind: templateBehind,
      target: targetSha && targetSha !== marker ? targets[targetSha] : undefined,
      awaitingRun,
    },
    autoMerge: repo?.autoMergeAllowed,
    why,
    prs,
  };
}
