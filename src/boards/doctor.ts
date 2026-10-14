// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  APPROVAL_GRANTS,
  NEEDED_SCOPES,
  PROJECT_REPOS,
  type Readiness,
  WORKFLOW_GRANTS,
} from "../act/readiness.ts";
import { FORKS, GITLAB_EVERY_MS, PLANNED, SWEEP_MS, shortRepo } from "../config.ts";
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
  radar: "GitLab MRs, queued diffs and fork filters",
  template: "template compares",
  auth: "sign-in probes",
  security: "Dependabot and code-scanning alerts",
};

const MARK: Record<Health, string> = { ok: "✓", warn: "!", error: "✕", neutral: "·" };

interface Check {
  health: Health;
  label: string;
  value: string;
  problem?: string;
}

// Lists GitHub hides from this token draw as unread, never as zero.
function alertsNote(facts: Facts): string {
  const repos = Object.values(facts.security.data ?? {});
  if (repos.length === 0) return "";
  const hidden = (n: number, what: string) => (n > 0 ? `${what} hidden on ${n}` : undefined);
  return [
    hidden(repos.filter((r) => !r.dependabot).length, "Dependabot"),
    hidden(repos.filter((r) => !r.code).length, "code scanning"),
    "secret scanning not read",
  ]
    .filter(Boolean)
    .join(" · ");
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
        ? `${rate.remaining} GraphQL points left, resets ${stamp(rate.resetAt, now)}${rate.cost !== undefined ? ` · a sweep costs ${rate.cost}` : ""}`
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
      const note = a === "security" ? alertsNote(facts) : "";
      return {
        health: m.error ? (m.at ? "warn" : "error") : m.at ? "ok" : "neutral",
        label: AREA_LABEL[a],
        value: [read, note, failed].filter(Boolean).join(" · "),
        ...(m.error ? { problem: `${AREA_LABEL[a]} ${failed}` } : {}),
      };
    }),
  ];
}

// What the board needs before its verbs can run. These never raise the doctor:
// a missing grant disables a verb, it does not stop the rib from seeing.
export function actChecks(facts: Facts, act: Readiness | undefined): Check[] {
  const scopes = facts.auth.data?.gh.scopes;
  const missingScopes = scopes ? NEEDED_SCOPES.filter((n) => !scopes.includes(n)) : undefined;
  const checks: Check[] = [
    {
      health: !scopes ? "neutral" : missingScopes?.length ? "warn" : "ok",
      label: "Act · gh scopes",
      value: !scopes
        ? "not listed by gh; writes need repo and workflow"
        : missingScopes?.length
          ? `missing ${missingScopes.join(", ")}; run gh auth refresh -s ${missingScopes.join(",")}`
          : NEEDED_SCOPES.join(", "),
    },
  ];
  if (!act) {
    checks.push({ health: "neutral", label: "Act · projects and grants", value: "not read yet" });
    return checks;
  }
  const missing = PROJECT_REPOS.filter((r) => !act.projects[r]);
  checks.push({
    health: missing.length ? "warn" : "ok",
    label: "Act · Keelson projects",
    value: `${PROJECT_REPOS.length - missing.length} of ${PROJECT_REPOS.length}${missing.length ? `; none for ${missing.map(shortRepo).join(", ")}` : ""}`,
  });
  const g = act.grants;
  const lackWork = g ? WORKFLOW_GRANTS.filter((w) => !g.workflow.includes(w)) : WORKFLOW_GRANTS;
  const lackGate = g ? APPROVAL_GRANTS.filter((w) => !g.approval.includes(w)) : APPROVAL_GRANTS;
  checks.push({
    health: !g ? "neutral" : lackWork.length || lackGate.length ? "warn" : "ok",
    label: "Act · grants",
    value: !g
      ? "config.json unreadable"
      : [
          lackWork.length ? `ribWorkflowGrants lacks ${lackWork.join(", ")}` : "workflows granted",
          lackGate.length ? `ribApprovalGrants lacks ${lackGate.join(", ")}` : "gates granted",
        ].join("; "),
  });
  return checks;
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

function detail(list: readonly Check[], troubled: boolean, act: readonly Check[]): string {
  const line = (c: Check) => `${MARK[c.health]} ${c.label} · ${c.value}`;
  const lines = [...list.map(line), "", ...act.map(line)];
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
  act?: Readiness,
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
          detail: detail(list, tone !== "ok", actChecks(facts, act)),
        },
      ],
    },
  };
}

export const DOCTOR_ID = "doctor";

// The console's read line opens this: every source with its last read, then what the verbs need.
export function doctorBoard(facts: Facts, now: Date, act?: Readiness): CanvasBoardView {
  const row = doctorRow(facts, now, act);
  if (!row) {
    return {
      view: "board",
      sections: [
        { kind: "rows", items: [{ glyph: "neutral", text: "The first sweep has not finished." }] },
      ],
    };
  }
  const line = (c: Check) => ({ glyph: c.health, text: c.label, trailing: c.value });
  const head = row.section.kind === "rows" ? row.section.items[0] : undefined;
  return {
    view: "board",
    header: {
      status: {
        label: row.tone === "ok" ? "ALL CLEAR" : row.tone === "warn" ? "PARTIAL" : "DARK",
        tone: row.tone,
      },
    },
    sections: [
      {
        kind: "rows",
        items: [
          {
            glyph: row.tone,
            text: head?.text ?? "Doctor",
            ...(head?.trailing ? { trailing: head.trailing } : {}),
          },
        ],
      },
      { kind: "rows", title: "Sources", boxed: true, items: checks(facts, now).map(line) },
      {
        kind: "rows",
        title: "What the verbs need",
        boxed: true,
        items: actChecks(facts, act).map(line),
      },
      {
        kind: "rows",
        items: [
          {
            glyph: "neutral",
            text: `Sweeps every ${SWEEP_MS / 60_000} min, GitLab every ${GITLAB_EVERY_MS / 60_000} min. Watching ${FORKS.map((f) => f.id).join(", ")}${PLANNED.length ? `; ${PLANNED.map((p) => p.id).join(", ")} planned` : ""}.`,
          },
        ],
      },
    ],
  };
}
