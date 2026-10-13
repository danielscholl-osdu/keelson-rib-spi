// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { FORKS, GITLAB_EVERY_MS, PLANNED, SWEEP_MS } from "../config.ts";
import { AREAS, type AreaName, type Facts } from "../facts.ts";
import { clip, plural, stamp } from "../util.ts";

type Section = CanvasBoardView["sections"][number];
type Health = "ok" | "warn" | "error" | "neutral";

const AREA_LABEL: Record<AreaName, string> = {
  github: "GitHub PRs, checks and issues",
  runs: "fork workflow runs",
  approvals: "runs waiting for approval",
  lifecycle: "stack lifecycle runs",
  details: "failed job steps",
  upstream: "GitLab upstream lag",
  template: "template compares",
  auth: "sign-in probes",
};

const MARK: Record<Health, string> = { ok: "✓", warn: "!", error: "✕", neutral: "·" };

interface Check {
  health: Health;
  label: string;
  value: string;
  problem?: string;
}

function checks(facts: Facts, now: Date): Check[] {
  const auth = facts.auth.data;
  const rate = facts.github.data?.rate;
  const signIn = (label: string, probe: { ok: boolean; detail: string } | undefined): Check => ({
    health: probe ? (probe.ok ? "ok" : "error") : "neutral",
    label,
    value: probe?.detail ?? "not probed yet",
    ...(probe && !probe.ok ? { problem: `${label}: ${clip(probe.detail, 120)}` } : {}),
  });
  const low = rate !== undefined && rate.remaining <= 500;
  return [
    signIn("gh", auth?.gh),
    signIn("glab", auth?.glab),
    {
      health: rate ? (low ? "warn" : "ok") : "neutral",
      label: "GitHub budget",
      value: rate
        ? `${rate.remaining} GraphQL points left, resets ${stamp(rate.resetAt, now)}`
        : "unknown",
      ...(low
        ? {
            problem: `GitHub budget low: ${rate.remaining} points left, resets ${stamp(rate.resetAt, now)}`,
          }
        : {}),
    },
    ...AREAS.map((a): Check => {
      const m = facts[a];
      const read = m.at ? `read ${stamp(m.at, now)}` : "not read yet";
      const failed = m.error ? `failed ${stamp(m.errorAt, now)}: ${clip(m.error, 140)}` : "";
      return {
        health: m.error ? (m.at ? "warn" : "error") : m.at ? "ok" : "neutral",
        label: AREA_LABEL[a],
        value: failed ? `${read} · ${failed}` : read,
        ...(m.error ? { problem: `${AREA_LABEL[a]} ${failed}` } : {}),
      };
    }),
  ];
}

export interface DoctorStatus {
  state: "dark" | "partial" | "clear" | "waiting";
  problems: string[];
}

export function doctorStatus(facts: Facts, now: Date): DoctorStatus {
  const auth = facts.auth.data;
  const problems = checks(facts, now).flatMap((c) => (c.problem ? [c.problem] : []));
  const dark = auth ? !auth.gh.ok : !!facts.github.error && !facts.github.data;
  const state = dark ? "dark" : problems.length > 0 ? "partial" : facts.sweep ? "clear" : "waiting";
  return { state, problems };
}

function detail(list: readonly Check[], troubled: boolean): string {
  const lines = list.map((c) => `${MARK[c.health]} ${c.label} · ${c.value}`);
  const lead = troubled
    ? ["Each panel keeps a source's last good read until it reads again.", ""]
    : [];
  return [
    ...lead,
    ...lines,
    "",
    `Sweeps every ${SWEEP_MS / 60_000} min, GitLab every ${GITLAB_EVERY_MS / 60_000} min, and lifecycle runs every 15 s while one is in flight.`,
    `Watching ${FORKS.map((f) => f.id).join(", ")}; ${PLANNED.map((p) => p.id).join(", ")} planned.`,
  ].join("\n");
}

export function doctorRow(
  facts: Facts,
  now: Date,
): { tone: "ok" | "warn" | "error"; section: Section } | undefined {
  const status = doctorStatus(facts, now);
  if (status.state === "waiting") return undefined;
  const list = checks(facts, now);
  const sweep = facts.sweep;
  const swept = sweep ? `swept ${stamp(sweep.at, now)}` : undefined;
  let tone: "ok" | "warn" | "error";
  let text: string;
  let trailing: string | undefined;
  if (status.state === "dark") {
    const gh = facts.auth.data?.gh;
    const reason = gh && !gh.ok ? gh.detail : (facts.github.error ?? "no read yet");
    tone = "error";
    text = `Doctor · GitHub unreadable: ${clip(reason, 160)}`;
    trailing = facts.github.at ? `last good read ${stamp(facts.github.at, now)}` : swept;
  } else if (status.state === "partial") {
    tone = "warn";
    const troubled = list.filter((c) => c.problem);
    text =
      troubled.length === 1
        ? `Doctor · ${troubled[0]?.problem}`
        : `Doctor · ${plural(troubled.length, "problem")}: ${troubled.map((c) => c.label).join(", ")}`;
    trailing = swept;
  } else {
    tone = "ok";
    text = "Doctor · all clear";
    trailing = sweep
      ? `${swept} · ${(sweep.ms / 1000).toFixed(1)} s · ${plural(sweep.calls, "call")}`
      : undefined;
  }
  return {
    tone,
    section: {
      kind: "rows",
      items: [
        {
          glyph: tone,
          text: clip(text, 220),
          ...(trailing ? { trailing } : {}),
          detail: detail(list, tone !== "ok"),
        },
      ],
    },
  };
}
