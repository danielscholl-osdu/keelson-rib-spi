// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { FORKS, GITLAB_EVERY_MS, PLANNED, SWEEP_MS } from "../config.ts";
import { AREAS, type AreaName, type Facts } from "../facts.ts";
import { clip, stamp, zoned } from "../util.ts";

const AREA_LABEL: Record<AreaName, string> = {
  github: "PRs, checks, issues, markers, lane ledger (GraphQL)",
  runs: "Fork workflow runs",
  approvals: "Runs waiting for approval",
  lifecycle: "Stack lifecycle runs and jobs",
  details: "Failed job steps and reasons",
  upstream: "Upstream lag (GitLab)",
  template: "Template compares",
  auth: "Sign-in probes",
};

export function doctorBoard(facts: Facts, now: Date): CanvasBoardView {
  const auth = facts.auth.data;
  const errors = AREAS.filter((a) => facts[a].error);
  const dark = auth ? !auth.gh.ok : !!facts.github.error && !facts.github.data;
  const status: { label: string; tone: CanvasTone } = dark
    ? { label: "DARK", tone: "error" }
    : errors.length > 0
      ? { label: "PARTIAL", tone: "warn" }
      : facts.sweep
        ? { label: "SEEING", tone: "ok" }
        : { label: "WAITING", tone: "neutral" };
  const sweep = facts.sweep;
  const rate = facts.github.data?.rate;
  return {
    view: "board",
    header: {
      status,
      chip: sweep
        ? `swept ${zoned(sweep.at, now)} · ${(sweep.ms / 1000).toFixed(1)} s · ${sweep.calls} calls`
        : "no sweep yet",
    },
    sections: [
      {
        kind: "rows",
        boxed: true,
        items: [
          {
            glyph: auth ? (auth.gh.ok ? "ok" : "error") : "neutral",
            text: "gh",
            trailing: auth?.gh.detail ?? "not probed yet",
          },
          {
            glyph: auth ? (auth.glab.ok ? "ok" : "error") : "neutral",
            text: "glab",
            trailing: auth?.glab.detail ?? "not probed yet",
          },
          {
            glyph: rate ? (rate.remaining > 500 ? "ok" : "warn") : "neutral",
            text: "GitHub budget",
            trailing: rate
              ? `${rate.remaining} GraphQL points left · resets ${stamp(rate.resetAt, now)}`
              : "unknown",
          },
          ...AREAS.map((a) => {
            const m = facts[a];
            const read = m.at ? `read ${stamp(m.at, now)}` : "not read yet";
            const failed = m.error
              ? ` · last attempt failed ${stamp(m.errorAt, now)}: ${clip(m.error, 140)}`
              : "";
            return {
              glyph: (m.error ? (m.at ? "warn" : "error") : m.at ? "ok" : "neutral") as CanvasTone,
              text: AREA_LABEL[a],
              trailing: `${read}${failed}`,
            };
          }),
          {
            glyph: "neutral",
            text: "Cadence",
            trailing: `sweep every ${SWEEP_MS / 60_000} min · GitLab every ${GITLAB_EVERY_MS / 60_000} min · lifecycle runs every 15 s while one is in flight`,
          },
          {
            glyph: "neutral",
            text: "Service map",
            trailing: `${FORKS.map((f) => f.id).join(", ")} · planned ${PLANNED.map((p) => p.id).join(", ")}`,
          },
        ],
      },
    ],
  };
}
