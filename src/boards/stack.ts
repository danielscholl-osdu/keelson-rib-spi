// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import type { LifecycleKind } from "../config.ts";
import type { Model } from "../model/index.ts";
import { type LifecycleStat, type RunView, type StageState, semverCmp } from "../model/stack.ts";
import { age, clip, stamp } from "../util.ts";

type Section = CanvasBoardView["sections"][number];

const STAGE_TONE: Record<StageState, CanvasTone> = {
  ok: "ok",
  failed: "error",
  running: "info",
  waits: "neutral",
  skipped: "neutral",
  cancelled: "warn",
};

function statusOf(model: Model): { label: string; tone: CanvasTone } {
  const { stack } = model;
  const held = stack.maintenance.state === "set";
  if (stack.inflight) {
    const what = `${stack.inflight.run.kind === "upgrade" ? "UPGRADE" : stack.inflight.run.kind.toUpperCase()} IN ${(stack.inflight.current ?? "PROGRESS").toUpperCase()}`;
    return { label: held ? `MAINTENANCE · ${what}` : what, tone: "warn" };
  }
  if (held) return { label: "MAINTENANCE", tone: "error" };
  if (stack.failure) return { label: "LIFECYCLE FAILED", tone: "error" };
  if (stack.deployable.state === "yes") return { label: "DEPLOYABLE", tone: "ok" };
  return { label: "UNKNOWN", tone: "neutral" };
}

function runTitle(view: RunView, now: Date, verb: string): string {
  const run = view.run;
  const target = run.target ? ` ${run.target}` : "";
  const how =
    run.event === "workflow_dispatch"
      ? "dispatched"
      : run.event === "schedule"
        ? "scheduled"
        : "started";
  return `env-${run.kind}${target} · ${verb} · ${how} ${age(run.createdAt, now)} ago`;
}

function ladder(view: RunView, now: Date, verb: string): Section | undefined {
  if (view.stages.length === 0) return undefined;
  return {
    kind: "grid",
    title: runTitle(view, now, verb),
    cells: view.stages.map((s) => ({
      label: s.label,
      href: view.run.url,
      badge: { text: s.state, tone: STAGE_TONE[s.state] },
    })),
  };
}

const KIND_LABEL: Record<LifecycleKind, string> = {
  refresh: "refresh",
  upgrade: "upgrade",
  smoke: "smoke",
  sweeper: "sweeper",
};

// The current streak outranks the 21-day ratio: a workflow that failed today is
// red whatever its history, and three greens in a row read as recovered.
function ratioTone(s: LifecycleStat): CanvasTone {
  if (s.total === 0) return "neutral";
  if (s.streak && !s.streak.green) return "error";
  if (s.streak && s.streak.n >= 3) return "ok";
  const r = s.green / s.total;
  return r >= 0.9 ? "ok" : r >= 0.6 ? "warn" : "error";
}

function streakText(s: LifecycleStat): string {
  if (!s.streak) return "";
  return s.streak.green ? ` · ${s.streak.n} green in a row` : ` · ${s.streak.n} red in a row`;
}

export function stackBoard(model: Model, now: Date): CanvasBoardView {
  const { stack } = model;
  const chip = [
    stack.declaration?.location,
    stack.declaration?.profile,
    "remote",
    model.sweptAt ? stamp(model.sweptAt, now) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!model.measured) {
    return {
      view: "board",
      header: { status: { label: "NOT READ", tone: "neutral" } },
      sections: [],
    };
  }
  const running = stack.running;
  const declared = stack.declared;
  const refresh = stack.lifecycle.refresh;
  const smoke = stack.lifecycle.smoke;
  const runningDelta =
    running && declared
      ? semverCmp(running.version, declared) < 0
        ? { text: "behind", direction: "down" as const, tone: "warn" as const }
        : semverCmp(running.version, declared) === 0
          ? { text: "declared", direction: "flat" as const, tone: "ok" as const }
          : { text: "ahead", direction: "up" as const, tone: "caution" as const }
      : undefined;
  const refreshView = stack.recent.find((v) => v.run.kind === "refresh");
  const sections: Section[] = [
    {
      kind: "stats",
      items: [
        { label: "Declared", value: declared ?? null, sub: "shared.yaml on main" },
        {
          label: "Running",
          value: running?.version ?? null,
          sub: running
            ? `${running.source} ${stamp(running.at, now)}`
            : "no lifecycle run proves it",
          ...(runningDelta ? { delta: runningDelta } : {}),
        },
        {
          label: "Latest release",
          value: stack.latest ?? null,
          sub: stack.bumpPr
            ? `bump PR #${stack.bumpPr.number} open`
            : stack.latestAt
              ? `released ${age(stack.latestAt, now)} ago`
              : undefined,
        },
        {
          label: "Deployable",
          value: stack.deployable.state === "unknown" ? null : stack.deployable.state,
          tone:
            stack.deployable.state === "yes"
              ? "ok"
              : stack.deployable.state === "no"
                ? "error"
                : "neutral",
          sub: stack.deployable.reason,
        },
        {
          label: "Last refresh",
          value: refresh.last ? (refresh.last.conclusion === "success" ? "green" : "failed") : null,
          tone: refresh.last ? (refresh.last.conclusion === "success" ? "ok" : "error") : "neutral",
          sub: refreshView
            ? `${stamp(refreshView.run.createdAt, now)}${refreshView.failedAt ? ` · ${refreshView.failedAt.split(" › ").pop()}` : ""}`
            : undefined,
        },
        {
          label: "Smoke",
          value: smoke.streak ? `${smoke.streak.n} ${smoke.streak.green ? "green" : "red"}` : null,
          tone: smoke.streak ? (smoke.streak.green ? "ok" : "error") : "neutral",
          sub: "daily runs in a row, ephemeral cluster",
        },
      ],
    },
  ];
  const run = stack.inflight ?? stack.failure ?? stack.recent[0];
  const verb = stack.inflight ? "in flight" : stack.failure ? "failed" : "last run";
  const steps = run ? ladder(run, now, verb) : undefined;
  if (steps) sections.push(steps);
  if (stack.failure && stack.failure !== run) {
    const f = ladder(stack.failure, now, "failed");
    if (f) sections.push(f);
  }
  sections.push({
    kind: "bars",
    title: "Lifecycle · 21 days",
    inline: true,
    items: (Object.keys(KIND_LABEL) as LifecycleKind[]).map((kind) => {
      const s = stack.lifecycle[kind];
      return {
        label: KIND_LABEL[kind],
        value: s.total === 0 ? null : s.green,
        total: Math.max(1, s.total),
        tone: ratioTone(s),
        trailing: s.total === 0 ? "no runs" : `${s.green} of ${s.total} green${streakText(s)}`,
        ...(s.last ? { href: s.last.url } : {}),
      };
    }),
  });
  if (stack.recent.length > 0) {
    sections.push({
      kind: "rows",
      title: "Recent refreshes and upgrades",
      items: stack.recent.map((v) => ({
        glyph:
          v.run.conclusion === "success"
            ? "ok"
            : v.run.conclusion === "cancelled"
              ? "warn"
              : "error",
        text: clip(
          `env-${v.run.kind}${v.run.target ? ` ${v.run.target}` : ""} · ${
            v.run.conclusion === "success" ? "green" : (v.failedAt ?? v.run.conclusion ?? "")
          }${v.reason ? ` · ${v.reason}` : ""}`,
          180,
        ),
        href: v.run.url,
        trailing: stamp(v.run.createdAt, now) ?? "",
      })),
    });
  }
  if (stack.releasePr) {
    sections.push({
      kind: "rows",
      items: [
        {
          icon: "⇡",
          text: `release PR ${stack.releasePr.title.replace(/^chore:\s*/, "")} is open`,
          href: stack.releasePr.url,
          trailing: age(stack.releasePr.createdAt, now) ?? "",
        },
      ],
    });
  }
  return { view: "board", header: { status: statusOf(model), chip }, sections };
}
