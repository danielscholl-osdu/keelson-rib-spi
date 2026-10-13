// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { HISTORY_DAYS, type LifecycleKind } from "../config.ts";
import type { LifecycleRun } from "../facts.ts";
import type { RunDay, RunDayState } from "../model/history.ts";
import type { Model } from "../model/index.ts";
import { cadence, nextFire } from "../model/schedule.ts";
import {
  attemptText,
  overdue,
  type RunView,
  runName,
  runResult,
  type Stage,
  type StageState,
  semverCmp,
  stoppedAttempts,
  usualText,
} from "../model/stack.ts";
import { againstUsual, clip, span, stamp, took, zoned } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Bar = NonNullable<Row["bar"]>;
type Cell = Extract<Bar, { cells: unknown }>["cells"][number];
type Span = Extract<Section, { kind: "timeline" }>["spans"][number];
type Mark = Extract<Section, { kind: "timeline" }>["marks"][number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const STAGE_TONE: Record<StageState, CanvasTone> = {
  ok: "ok",
  failed: "error",
  running: "info",
  waits: "neutral",
  skipped: "neutral",
  cancelled: "warn",
};

const RESULT_GLYPH: Record<string, string> = {
  green: "✓",
  cancelled: "⊘",
  failed: "✕",
  "timed out": "✕",
};

function runTone(run: LifecycleRun): CanvasTone {
  if (run.status !== "completed") return "info";
  if (run.conclusion === "success") return "ok";
  return run.conclusion === "cancelled" ? "warn" : "error";
}

// Forks are kept off the stack by a failed or cancelled attempt since the last
// green run, or by a hold no run is working on; a routine run in flight is not
// an incident.
function incident(model: Model): boolean {
  const { stack } = model;
  if (stack.deployable.state === "yes") return false;
  return (
    stoppedAttempts(stack).length > 0 || (stack.maintenance.state === "set" && !stack.inflight)
  );
}

function statusOf(model: Model, hurt: boolean): { label: string; tone: CanvasTone } {
  const { stack } = model;
  if (stack.deployable.state === "yes") return { label: "DEPLOYABLE", tone: "ok" };
  if (hurt) {
    const held = stack.maintenance.state === "set";
    return { label: held ? "MAINTENANCE MODE" : "NOT DEPLOYABLE", tone: "error" };
  }
  if (stack.inflight) {
    return { label: `${stack.inflight.run.kind.toUpperCase()} RUNNING`, tone: "info" };
  }
  return { label: "UNKNOWN", tone: "neutral" };
}

function runningStat(model: Model, now: Date): Stat {
  const { stack } = model;
  const running = stack.running;
  const { declared, latest } = stack;
  const cmp = running && declared ? semverCmp(running.version, declared) : undefined;
  const newer = running && latest ? semverCmp(latest, running.version) > 0 : false;
  const delta =
    cmp === undefined
      ? undefined
      : cmp < 0
        ? { text: `${declared} declared`, direction: "down" as const, tone: "warn" as const }
        : cmp > 0
          ? { text: `${declared} declared`, direction: "up" as const, tone: "caution" as const }
          : newer
            ? { text: `${latest} out`, direction: "up" as const, tone: "info" as const }
            : {
                text: latest ? "latest · declared" : "declared",
                direction: "flat" as const,
                tone: "ok" as const,
              };
  const landed = stack.landed;
  const lag = againstUsual(landed?.lagMs, stack.usualLagMs, " after release");
  const proof = landed
    ? [`landed ${stamp(landed.at, now) ?? ""}`.trim(), lag].filter(Boolean).join(" · ")
    : running
      ? `${running.source} ${stamp(running.at, now) ?? ""}`.trim()
      : "no lifecycle run proves it";
  return {
    label: "Running",
    value: running?.version ?? null,
    ...(cmp !== undefined && cmp < 0 ? { tone: "warn" as const } : {}),
    ...(delta ? { delta } : {}),
    sub: [cmp !== undefined && cmp !== 0 && newer ? `${latest} is latest` : undefined, proof]
      .filter(Boolean)
      .join(" · "),
  };
}

function nextText(model: Model, kind: LifecycleKind, now: Date): string | undefined {
  const crons = model.stack.schedules?.[kind];
  const at = crons ? nextFire(crons, now) : undefined;
  return at === undefined ? undefined : `next ${stamp(new Date(at).toISOString(), now)}`;
}

function greenfieldStat(model: Model, now: Date): Stat {
  const { stack } = model;
  const last = stack.lifecycle.smoke.last;
  const label = "Greenfield · smoke";
  if (!last) return { label, value: null, sub: `no smoke run in ${HISTORY_DAYS} days` };
  const { lastMs, usualMs } = stack.durations.smoke;
  const spent = runTone(last) === "ok" ? againstUsual(lastMs, usualMs) : span(lastMs);
  const what =
    runTone(last) === "ok"
      ? spent && `fresh cluster to green in ${spent}`
      : `${runResult(last)}${spent ? ` after ${spent}` : ""}`;
  return {
    label,
    clock: { at: last.updatedAt, mode: "since" },
    tone: runTone(last),
    sub: [what, nextText(model, "smoke", now)].filter(Boolean).join(" · "),
  };
}

function blockedStat(model: Model, now: Date): Stat {
  const { stack } = model;
  const held = stack.maintenance.state === "set" ? stack.maintenance : undefined;
  const since = held ? held.since : stoppedAttempts(stack)[0]?.run.createdAt;
  const prs = model.lines.flatMap((l) =>
    l.prs.filter((p) => p.failures.some((f) => f.cls === "ENV")),
  ).length;
  return {
    label: held ? "Brownfield · in maintenance since" : "Brownfield · not deployable since",
    ...(since ? { clock: { at: since, mode: "since" as const } } : { value: null }),
    tone: "error",
    sub: [
      "no fork can deploy",
      prs > 0 ? `${prs === 1 ? "1 PR waits" : `${prs} PRs wait`} on it` : undefined,
      held?.run
        ? `set by ${runName(held.run)} ${stamp(held.run.createdAt, now) ?? ""}`.trim()
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function inflightStat(model: Model, now: Date): Stat | undefined {
  const { stack } = model;
  const live = stack.inflight;
  if (!live?.at) return undefined;
  const startedAt = live.at.startedAt;
  return {
    label: `Brownfield · in ${live.at.stage} since`,
    ...(startedAt ? { clock: { at: startedAt, mode: "since" as const } } : { value: null }),
    tone: overdue(stack, now) ? "warn" : "info",
    sub: [runName(live.run), live.at.step, usualText(stack.usual)].filter(Boolean).join(" · "),
  };
}

// A later green upgrade proves the stack, so a failed refresh before it is amber.
function brownfieldStat(model: Model, now: Date): Stat {
  const { stack } = model;
  const refresh = stack.lifecycle.refresh.last;
  const label = "Brownfield · refresh";
  if (!refresh) return { label, value: null, sub: `no refresh in ${HISTORY_DAYS} days` };
  const green = stack.lastGreen;
  const proven =
    runTone(refresh) === "error" &&
    green !== undefined &&
    Date.parse(green.createdAt) > Date.parse(refresh.createdAt);
  const { lastMs, usualMs } = stack.durations.refresh;
  const what = proven
    ? `${runResult(refresh)} · then ${runName(green)} green ${stamp(green.updatedAt, now) ?? ""}`.trim()
    : runTone(refresh) === "ok"
      ? `re-proved in place in ${againstUsual(lastMs, usualMs) ?? "?"}`
      : `${runResult(refresh)}${span(lastMs) ? ` after ${span(lastMs)}` : ""}`;
  return {
    label,
    clock: { at: refresh.updatedAt, mode: "since" },
    tone: proven ? "warn" : runTone(refresh),
    sub: [what, nextText(model, "refresh", now)].filter(Boolean).join(" · "),
  };
}

// A running stage's time would go stale between frames; the tile's clock carries it.
function badge(s: Stage): string {
  if (s.state === "running" || s.state === "waits" || s.state === "skipped") return s.state;
  const t = took(s.startedAt, s.completedAt);
  return t ? `${s.state} ${t}` : s.state;
}

function ladder(view: RunView, now: Date): Section | undefined {
  if (view.stages.length === 0) return undefined;
  const run = view.run;
  const what =
    run.title && run.title !== run.name
      ? clip(run.title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ""), 72)
      : undefined;
  const how =
    run.event === "workflow_dispatch"
      ? "dispatched"
      : run.event === "schedule"
        ? "scheduled"
        : "started";
  return {
    kind: "grid",
    title: [runName(run), what, `${how} ${stamp(run.createdAt, now) ?? ""}`.trim()]
      .filter(Boolean)
      .join(" · "),
    cells: view.stages.map((s) => ({
      label: s.label,
      href: run.url,
      badge: { text: badge(s), tone: STAGE_TONE[s.state] },
    })),
  };
}

function timeline(model: Model, now: Date): Section | undefined {
  const { stack } = model;
  const first = stack.attempts[0];
  if (!first) return undefined;
  const anchor = stack.lastGreen ?? first.run;
  const from =
    Math.floor(
      Math.max(Date.parse(anchor.createdAt) - 2 * HOUR, now.getTime() - 72 * HOUR) / HOUR,
    ) * HOUR;
  const until = Math.ceil((now.getTime() + HOUR) / HOUR) * HOUR;
  const spans: Span[] = [];
  const marks: Mark[] = [];
  if (stack.maintenance.state === "set" && stack.maintenance.since) {
    spans.push({
      lane: "maintenance",
      from: stack.maintenance.since,
      tone: "error",
      title: "held · forks cannot deploy",
    });
  }
  for (const kind of ["upgrade", "refresh"] as const) {
    for (const run of stack.lifecycle[kind].runs) {
      const end = run.status === "completed" ? run.updatedAt : undefined;
      if (end && Date.parse(end) < from) continue;
      spans.push({
        lane: kind,
        from: run.createdAt,
        ...(end ? { to: end } : {}),
        tone: runTone(run),
        ...(run.conclusion === "cancelled" ? { hatched: true } : {}),
        title: run.target ?? runResult(run),
      });
      const glyph = RESULT_GLYPH[runResult(run)];
      if (end && glyph && Date.parse(end) - Date.parse(run.createdAt) < 30 * MINUTE) {
        marks.push({
          lane: kind,
          at: run.createdAt,
          glyph,
          title: `${runName(run)} ${runResult(run)}`,
        });
      }
    }
  }
  if (stack.latest && stack.latestAt && Date.parse(stack.latestAt) >= from) {
    marks.push({
      lane: "upgrade",
      at: stack.latestAt,
      glyph: "⇡",
      title: `${stack.latest} released`,
    });
  }
  for (const line of model.lines) {
    for (const p of line.prs) {
      for (const f of p.failures) {
        if (f.cls !== "ENV" || Date.parse(f.at) < from) continue;
        marks.push({
          lane: "lanes",
          at: f.at,
          glyph: "✕",
          title: `${line.fork.id} #${f.pr}${f.reason ? ` · ${f.reason}` : ""}`,
        });
      }
    }
  }
  return {
    kind: "timeline",
    title: "Since the last green run",
    window: {
      from: new Date(from).toISOString(),
      clock: { until: new Date(until).toISOString() },
    },
    lanes: [
      { id: "maintenance", label: "maintenance", tone: "neutral" },
      { id: "upgrade", label: "env-upgrade", tone: "neutral" },
      { id: "refresh", label: "env-refresh", tone: "neutral" },
      { id: "lanes", label: "fork lanes", tone: "neutral" },
    ],
    spans,
    marks,
    legend:
      "Hatched: cancelled. An open outline is still running or still held. ✕ on fork lanes: a lane check that failed on the environment.",
  };
}

function attempts(model: Model, now: Date): Section {
  const { stack } = model;
  const green = stack.lastGreen;
  return {
    kind: "rows",
    title: green
      ? `Attempts since the last green run, env-${green.kind} ${stamp(green.createdAt, now)}`
      : "Attempts in the last 21 days",
    items: stack.attempts.map(
      (v): Row => ({
        glyph: runTone(v.run),
        text: attemptText(v, stack.maintenance.run?.id),
        href: v.run.url,
        trailing: [
          stamp(v.run.createdAt, now),
          v.run.status === "completed" ? took(v.run.createdAt, v.run.updatedAt) : "running",
        ]
          .filter(Boolean)
          .join(" · "),
      }),
    ),
  };
}

const DAY_TONE: Record<RunDayState, CanvasTone | undefined> = {
  ok: "ok",
  failed: "error",
  cancelled: "warn",
  running: "info",
  idle: undefined,
  missed: "error",
};

function dayText(day: RunDay, kind: LifecycleKind, now: Date): string {
  if (day.runs.length > 0)
    return day.runs
      .map((r) => `${runName(r)} ${runResult(r)} ${stamp(r.createdAt, now) ?? ""}`.trim())
      .join(", ");
  if (day.state === "missed") return `no ${kind} ran in its scheduled slot`;
  return day.due ? `${kind} not run yet` : "nothing due";
}

function cellsOf(days: readonly RunDay[], kind: LifecycleKind, now: Date): Cell[] {
  return days.map((d) => {
    const tone = DAY_TONE[d.state];
    return {
      label: `${d.day.key} · ${dayText(d, kind, now)}`,
      ...(tone ? { tone } : {}),
      ...(d.state === "idle" || d.state === "missed" ? { hollow: true } : {}),
    };
  });
}

function lane(model: Model, kind: LifecycleKind, now: Date, unscheduled?: string): Row {
  const { stack } = model;
  const when = stack.schedules ? cadence(stack.schedules[kind], unscheduled) : undefined;
  const last = stack.lifecycle[kind].last;
  return {
    text: when ? `${kind} · ${when}` : kind,
    ...(last ? { href: last.url } : {}),
    bar: { cells: cellsOf(stack.history.runs[kind], kind, now), quiet: true },
  };
}

function behindLane(model: Model): Row | undefined {
  const behind = model.stack.history.behind;
  if (!behind) return undefined;
  const most = Math.max(3, ...behind.map((b) => b.behind ?? 0));
  return {
    text: "behind latest",
    bar: {
      total: most,
      rest: "ok",
      columns: behind.map((b) => ({
        label:
          b.behind === null
            ? `${b.day.key} · running version unknown`
            : b.behind === 0
              ? `${b.day.key} · on ${b.running}, the latest`
              : `${b.day.key} · running ${b.running}, ${b.behind} behind ${b.newest}`,
        segments:
          b.behind === null
            ? [{ label: "unknown", n: null }]
            : b.behind > 0
              ? [{ label: "releases behind", n: b.behind, tone: "warn" as const }]
              : [],
      })),
    },
  };
}

// A housekeeping lane that never failed folds to one line, and returns on its first red.
function housekeeping(model: Model, now: Date): Section {
  const days = model.stack.history.runs.sweeper;
  const clean =
    days.some((d) => d.state === "ok") &&
    days.every((d) => d.state === "ok" || (d.state === "idle" && !d.due));
  return {
    kind: "rows",
    title: "Housekeeping",
    items: [
      clean
        ? {
            text: `sweeper · green on every run in ${HISTORY_DAYS} days`,
            ...(model.stack.lifecycle.sweeper.last
              ? { href: model.stack.lifecycle.sweeper.last.url }
              : {}),
          }
        : lane(model, "sweeper", now),
    ],
  };
}

function history(model: Model, now: Date): Section[] {
  const behind = behindLane(model);
  return [
    {
      kind: "rows",
      title: `Greenfield · last ${HISTORY_DAYS} days, one cell per UTC day`,
      items: [lane(model, "smoke", now)],
    },
    {
      kind: "rows",
      title: "Brownfield",
      items: [
        ...(behind ? [behind] : []),
        lane(model, "upgrade", now, "on bump"),
        lane(model, "refresh", now),
      ],
    },
    housekeeping(model, now),
  ];
}

export function stackBoard(model: Model, now: Date): CanvasBoardView {
  const { stack } = model;
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const chip = [
    stack.declaration?.location,
    stack.declaration?.profile,
    "remote",
    model.sweptAt ? zoned(model.sweptAt, now) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const hurt = incident(model);
  const live = inflightStat(model, now);
  const tiles: Stat[] = [
    runningStat(model, now),
    greenfieldStat(model, now),
    hurt ? blockedStat(model, now) : (live ?? brownfieldStat(model, now)),
  ];
  const sections: Section[] = [{ kind: "stats", items: tiles }];
  const focus = stack.inflight ?? (hurt ? stack.attempts[stack.attempts.length - 1] : undefined);
  const steps = focus ? ladder(focus, now) : undefined;
  if (steps) sections.push(steps);
  if (hurt) {
    const plot = timeline(model, now);
    if (plot) sections.push(plot);
    sections.push(attempts(model, now));
  }
  sections.push(...history(model, now));
  if (stack.releasePr) {
    sections.push({
      kind: "rows",
      items: [
        {
          icon: "⇡",
          text: `release PR ${stack.releasePr.title.replace(/^chore:\s*/, "")} is open`,
          href: stack.releasePr.url,
          trailing: stamp(stack.releasePr.createdAt, now) ?? "",
        },
      ],
    });
  }
  return { view: "board", header: { status: statusOf(model, hurt), chip }, sections };
}
