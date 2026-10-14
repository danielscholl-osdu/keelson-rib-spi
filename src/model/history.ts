// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { HISTORY_DAYS } from "../config.ts";
import type { LifecycleRun, PastIssueFact, PastPrFact, ReleaseFact } from "../facts.ts";
import { classifyPr } from "./attribution.ts";
import type { LinePr } from "./lines.ts";
import { type Cron, firesBetween } from "./schedule.ts";

const DAY_MS = 86_400_000;
// A scheduled run that has not started this long after its slot counts as missed,
// and a scheduled run that starts within it answers that slot.
const MISSED_AFTER_MS = 3 * 3_600_000;

// One local day of the history window; `end` stops at now for today.
export interface Day {
  key: string;
  start: number;
  end: number;
  // The next day's start; a DST day is 23 or 25 hours.
  stop: number;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export function windowDays(now: Date, n = HISTORY_DAYS): Day[] {
  const out: Day[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const stop = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1).getTime();
    out.push({
      key: `${two(start.getMonth() + 1)}-${two(start.getDate())}`,
      start: start.getTime(),
      end: Math.min(stop, now.getTime()),
      stop,
    });
  }
  return out;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// --- environment ---------------------------------------------------------

export type RunDayState = "ok" | "failed" | "cancelled" | "running" | "idle" | "missed" | "due";

export interface RunDay {
  day: Day;
  state: RunDayState;
  runs: LifecycleRun[];
  // The schedule's slots on this day.
  slots: number[];
}

function runState(run: LifecycleRun): RunDayState {
  if (run.status !== "completed") return "running";
  if (run.conclusion === "success") return "ok";
  return run.conclusion === "cancelled" ? "cancelled" : "failed";
}

// A scheduled run counts toward the slot it answers, so a 23:00 run GitHub
// starts after midnight still fills its own day; any other run counts on the
// day it started. Each day takes its newest run; a slot long past with no run
// is missed, and one not yet reached is due.
export function runDays(
  runs: readonly LifecycleRun[],
  crons: readonly Cron[],
  days: readonly Day[],
  now: Date,
): RunDay[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const slots = firesBetween(crons, first.start - MISSED_AFTER_MS, last.stop);
  const dayOf = (t: number) => days.findIndex((d) => t >= d.start && t < d.stop);
  const on: LifecycleRun[][] = days.map(() => []);
  for (const run of runs) {
    if (run.conclusion === "skipped") continue;
    const t = Date.parse(run.createdAt);
    const slot =
      run.event === "schedule"
        ? slots.filter((s) => s <= t && t - s <= MISSED_AFTER_MS).at(-1)
        : undefined;
    const i = dayOf(slot ?? t);
    if (i >= 0) on[i]?.push(run);
  }
  return days.map((day, i) => {
    const mine = (on[i] ?? []).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const own = slots.filter((s) => s >= day.start && s < day.stop);
    const newest = mine[mine.length - 1];
    if (newest) return { day, state: runState(newest), runs: mine, slots: own };
    const missed = own.some((s) => now.getTime() - s > MISSED_AFTER_MS);
    const state = own.length === 0 ? "idle" : missed ? "missed" : "due";
    return { day, state, runs: mine, slots: own };
  });
}

// A span the environment was held in maintenance; `to` is open while it still is.
export interface Hold {
  from: number;
  to?: number;
}

export interface HoldDay {
  day: Day;
  heldMs: number;
  // A lifecycle run that day was not read, so the hours are not known.
  unread: boolean;
}

export function holdDays(
  holds: readonly Hold[],
  unreadAt: readonly number[],
  days: readonly Day[],
  now: Date,
): HoldDay[] {
  return days.map((day) => ({
    day,
    heldMs: holds.reduce(
      (sum, h) =>
        sum + Math.max(0, Math.min(h.to ?? now.getTime(), day.end) - Math.max(h.from, day.start)),
      0,
    ),
    unread: unreadAt.some((t) => t >= day.start && t < day.stop),
  }));
}

const PASSED = new Set(["SUCCESS", "INACTIVE"]);
const FAILED = new Set(["FAILURE", "ERROR"]);

export function deployResult(state: string | undefined): "passed" | "failed" | undefined {
  if (!state) return undefined;
  if (PASSED.has(state)) return "passed";
  return FAILED.has(state) ? "failed" : undefined;
}

export interface DeployDay {
  day: Day;
  passed: number;
  failed: number;
}

export function deployDays(
  deployments: readonly { createdAt: string; state?: string }[],
  days: readonly Day[],
): DeployDay[] {
  return days.map((day) => {
    const on = deployments.filter((d) => {
      const t = Date.parse(d.createdAt);
      return t >= day.start && t < day.stop;
    });
    return {
      day,
      passed: on.filter((d) => deployResult(d.state) === "passed").length,
      failed: on.filter((d) => deployResult(d.state) === "failed").length,
    };
  });
}

export interface BehindDay {
  day: Day;
  // Releases newer than the running version at the end of the day; null when unknown.
  behind: number | null;
  running?: string;
  newest?: string;
}

function semver(tag: string): number[] {
  return tag
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

function newer(a: string, b: string): boolean {
  const pa = semver(a);
  const pb = semver(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The running version at a moment is the target of the newest green lifecycle
// run finished by then.
export function behindDays(
  releases: readonly ReleaseFact[],
  lifecycle: readonly LifecycleRun[],
  days: readonly Day[],
): BehindDay[] {
  const proofs = lifecycle
    .filter((r) => r.status === "completed" && r.conclusion === "success" && r.target)
    .map((r) => ({ at: Date.parse(r.updatedAt), version: r.target as string }))
    .sort((a, b) => a.at - b.at);
  return days.map((day) => {
    let running: string | undefined;
    for (const p of proofs) if (p.at <= day.end) running = p.version;
    const out = releases.filter((r) => Date.parse(r.at) <= day.end);
    const newest = out.reduce<string | undefined>(
      (best, r) => (best === undefined || newer(r.tag, best) ? r.tag : best),
      undefined,
    );
    if (!running || releases.length === 0) return { day, behind: null, running, newest };
    const v = running;
    return { day, behind: out.filter((r) => newer(r.tag, v)).length, running, newest };
  });
}

// --- service lines -------------------------------------------------------

export type TrackState = "ok" | "waiting" | "failing" | "halted" | "none";

export interface TrackDay {
  day: Day;
  state: TrackState;
  why?: string;
}

export interface LineHistory {
  upstream: TrackDay[];
  template: TrackDay[];
}

const RANK: Record<TrackState, number> = { none: 0, ok: 1, waiting: 2, failing: 3, halted: 4 };

export function worse(a: TrackState, b: TrackState): TrackState {
  return RANK[a] >= RANK[b] ? a : b;
}

interface Span {
  from: number;
  to: number;
  state: TrackState;
  why: string;
}

function openAt(span: Span, at: number): boolean {
  return span.from <= at && at < span.to;
}

function prSpans(past: readonly PastPrFact[], kinds: readonly string[], label: string): Span[] {
  return past.flatMap((p) => {
    const cls = classifyPr(p);
    if (!kinds.includes(cls)) return [];
    const end = p.mergedAt ?? p.closedAt;
    return [
      {
        from: Date.parse(p.createdAt),
        to: end ? Date.parse(end) : Number.POSITIVE_INFINITY,
        state: "waiting" as const,
        why: `${label} #${p.number} waits`,
      },
    ];
  });
}

// An open PR failing on a real failure reads amber from its first such failure.
function openPrSpans(open: readonly LinePr[], kinds: readonly string[], label: string): Span[] {
  return open.flatMap((p) => {
    if (!kinds.includes(p.prClass)) return [];
    const from = Date.parse(p.pr.createdAt);
    const real = p.failures.filter((f) => !f.hidden && f.cls !== "ENV" && f.cls !== "POLICY");
    const failedAt = real.length ? Math.min(...real.map((f) => Date.parse(f.at))) : undefined;
    const spans: Span[] = [
      {
        from,
        to: Number.POSITIVE_INFINITY,
        state: "waiting",
        why: `${label} #${p.pr.number} waits`,
      },
    ];
    if (failedAt !== undefined && Number.isFinite(failedAt))
      spans.push({
        from: Math.max(from, failedAt),
        to: Number.POSITIVE_INFINITY,
        state: "failing",
        why: `${label} #${p.pr.number} fails ${real[0]?.check ?? ""}`.trim(),
      });
    return spans;
  });
}

function issueSpans(
  issues: readonly { number: number; createdAt: string; closedAt?: string; labels: string[] }[],
): Span[] {
  return issues.flatMap((i) => {
    const halted = i.labels.includes("sync-failed");
    const blocked = ["conflict", "cascade-blocked", "cascade-failed"].some((l) =>
      i.labels.includes(l),
    );
    if (!halted && !blocked) return [];
    return [
      {
        from: Date.parse(i.createdAt),
        to: i.closedAt ? Date.parse(i.closedAt) : Number.POSITIVE_INFINITY,
        state: halted ? ("halted" as const) : ("failing" as const),
        why: halted ? `sync halted · issue #${i.number}` : `cascade blocked · issue #${i.number}`,
      },
    ];
  });
}

function trackDays(spans: readonly Span[], days: readonly Day[], seeded: number): TrackDay[] {
  return days.map((day) => {
    if (day.end <= seeded) return { day, state: "none" };
    // Today reads at now; an earlier day at its last moment.
    const at = day.end - 1;
    let state: TrackState = "ok";
    let why: string | undefined;
    for (const s of spans) {
      if (!openAt(s, at) || RANK[s.state] <= RANK[state]) continue;
      state = s.state;
      why = s.why;
    }
    return { day, state, ...(why ? { why } : {}) };
  });
}

// One fleet day: only forks that existed that day count toward it; unread when any fork's history is.
export interface FleetDay {
  day: Day;
  unread: boolean;
  forks: number;
  halted: number;
  failing: number;
  waiting: number;
}

export function fleetDays(tracks: readonly (readonly TrackDay[] | undefined)[]): FleetDay[] {
  const first = tracks.find((t) => t !== undefined);
  if (!first) return [];
  return first.map((d, i) => {
    const days = tracks.map((t) => t?.[i]);
    const count = (state: TrackState) => days.filter((x) => x?.state === state).length;
    return {
      day: d.day,
      unread: days.some((x) => x === undefined),
      forks: days.length - count("none"),
      halted: count("halted"),
      failing: count("failing"),
      waiting: count("waiting"),
    };
  });
}

export function lineHistory(input: {
  seeded?: string;
  past: readonly PastPrFact[];
  pastIssues: readonly PastIssueFact[];
  openPrs: readonly LinePr[];
  openIssues: readonly { number: number; createdAt: string; labels: string[] }[];
  templateDeliveryFailedAt?: string;
  days: readonly Day[];
}): LineHistory {
  const seeded = input.seeded ? Date.parse(`${input.seeded}T00:00:00Z`) : 0;
  const openNumbers = new Set(input.openPrs.map((p) => p.pr.number));
  const past = input.past.filter((p) => !openNumbers.has(p.number));
  const issues = [...input.pastIssues, ...input.openIssues];
  const upstream: Span[] = [
    ...prSpans(past, ["sync"], "sync PR"),
    ...prSpans(past, ["cascade"], "integration PR"),
    ...openPrSpans(input.openPrs, ["sync"], "sync PR"),
    ...openPrSpans(input.openPrs, ["cascade"], "integration PR"),
    ...issueSpans(issues),
  ];
  const template: Span[] = [
    ...prSpans(past, ["template"], "template-sync PR"),
    ...openPrSpans(input.openPrs, ["template"], "template-sync PR"),
  ];
  if (input.templateDeliveryFailedAt)
    template.push({
      from: Date.parse(input.templateDeliveryFailedAt),
      to: Number.POSITIVE_INFINITY,
      state: "halted",
      why: "Sync Template failed",
    });
  return {
    upstream: trackDays(upstream, input.days, seeded),
    template: trackDays(template, input.days, seeded),
  };
}

// --- gates ---------------------------------------------------------------

export interface GateWaits {
  // Upstream change reaches main: sync PR opened to the integration PR merged after it.
  upstreamMs: number[];
  templateMs: number[];
  releases: number;
}

export function gateWaits(past: readonly PastPrFact[], now: Date): GateWaits {
  const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
  const merged = past.filter((p) => p.mergedAt && Date.parse(p.mergedAt) >= cutoff);
  const cls = (p: PastPrFact) => classifyPr(p);
  const integrations = past
    .filter((p) => p.mergedAt && cls(p) === "cascade")
    .map((p) => Date.parse(p.mergedAt as string))
    .sort((a, b) => a - b);
  const upstreamMs: number[] = [];
  for (const p of merged) {
    if (cls(p) !== "sync") continue;
    const syncMerged = Date.parse(p.mergedAt as string);
    const landed = integrations.find((t) => t >= syncMerged);
    if (landed !== undefined && landed >= cutoff) upstreamMs.push(landed - Date.parse(p.createdAt));
  }
  const templateMs = merged
    .filter((p) => cls(p) === "template")
    .map((p) => Date.parse(p.mergedAt as string) - Date.parse(p.createdAt));
  return {
    upstreamMs,
    templateMs,
    releases: merged.filter((p) => cls(p) === "release").length,
  };
}
