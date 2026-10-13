// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { forkOf, githubUrl, shortRepo } from "../config.ts";
import type { OutsidePr, PrFact, RepoFact, WaitingRun } from "../facts.ts";
import { plural, releaseTag, short, stamp } from "../util.ts";
import {
  CLASS_LABEL,
  type Failure,
  type FailureClass,
  prFailures,
  toolchainText,
} from "./attribution.ts";
import { prReady, prVerdict } from "./checks.ts";
import type { LineModel, LinePr } from "./lines.ts";
import {
  attemptText,
  overdue,
  runName,
  runWhere,
  type StackModel,
  stoppedAttempts,
  usualText,
} from "./stack.ts";
import { predates, type TemplateModel } from "./template.ts";

export type Rung = 0 | 1 | 2;
export type Verdict = "BLOCKED" | "ATTENTION" | "MOVING" | "CONVERGED";

export interface Effect {
  text: string;
  url?: string;
}

// One key-value line of an item's cause, as the inspector lists it.
export interface Fact {
  label: string;
  value: string;
  url?: string;
}

export type ItemKind =
  | "stack"
  | "maintenance"
  | "lanes"
  | "halt"
  | "sync-run"
  | "conflict"
  | "cascade"
  | "main"
  | "template-run"
  | "gate1"
  | "gate2"
  | "template-red"
  | "labels"
  | "approvals"
  | "template-set"
  | "release-red"
  | "releases"
  | "bump";

// The entries a halt names, for checking whether other forks will halt on them too.
export interface HaltEntries {
  fork: string;
  code: string;
  entries: string[];
}

// One outside PR whose runs at its current head wait for a maintainer.
export interface ApprovePr {
  repo: string;
  pr: OutsidePr;
  runs: { id: number; name: string }[];
  since: string;
  // Approved runs execute these as the PR changed them.
  workflowFiles: string[];
}

export interface QueueItem {
  id: string;
  kind: ItemKind;
  rung: Rung;
  scope: string;
  text: string;
  since?: string;
  url?: string;
  note?: string;
  effects: Effect[];
  cause: Fact[];
  cls?: FailureClass;
  halt?: HaltEntries;
  approve?: ApprovePr[];
  // An incident is a cause that broke or blocks; gates and ready work are not.
  incident: boolean;
  blocks: number;
}

export interface Queue {
  items: QueueItem[];
  counts: { p0: number; p1: number; p2: number };
  verdict: Verdict;
  incidents: number;
}

function failureLine(service: string, f: Failure, now: Date): string {
  const parts = [`${service} ${CLASS_LABEL[f.prClass]} #${f.pr}`];
  if (f.step) parts.push(f.step);
  if (f.reason) parts.push(f.reason);
  parts.push(stamp(f.at, now) ?? "");
  return parts.filter(Boolean).join(" · ");
}

function prFacts(p: LinePr, now: Date): Fact[] {
  const facts: Fact[] = [
    {
      label: "PR",
      value: `#${p.pr.number} · ${p.pr.title} · opened ${stamp(p.pr.createdAt, now)}`,
      url: p.pr.url,
    },
  ];
  const f = p.failures.find((x) => x.cls !== "POLICY" && x.cls !== "ENV") ?? p.failures[0];
  if (f) {
    facts.push({ label: "check", value: f.step ? `${f.check} › ${f.step}` : f.check, url: f.url });
    if (f.reason) facts.push({ label: "reason", value: f.reason });
  }
  facts.push({ label: "head", value: short(p.pr.headSha) });
  if (p.pr.reviewDecision) {
    facts.push({ label: "review", value: p.pr.reviewDecision.toLowerCase().replaceAll("_", " ") });
  }
  return facts;
}

function realFailure(p: LinePr): Failure | undefined {
  return p.failures.find((f) => f.cls !== "ENV" && f.cls !== "POLICY");
}

// "unclassified top-level entries: schemathesis-tests, other" names its entries last.
export function haltEntries(detail: string): string[] {
  const tail = detail.split(":").pop() ?? "";
  return tail
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

function stackItems(
  stack: StackModel,
  lines: readonly LineModel[],
  now: Date,
): { items: QueueItem[]; folded: Set<Failure> } {
  const items: QueueItem[] = [];
  const folded = new Set<Failure>();
  const envFailures = lines.flatMap((l) =>
    l.prs.flatMap((p) => p.failures.filter((f) => f.cls === "ENV").map((f) => ({ line: l, f }))),
  );
  const stopped = stoppedAttempts(stack);
  const heldWithoutCause =
    stopped.length === 0 &&
    !stack.inflight &&
    stack.maintenance.state === "set" &&
    stack.maintenance.run;
  const first = stopped[0];
  const last = stack.attempts[stack.attempts.length - 1];
  if (first && last && stack.deployable.state !== "yes") {
    const setter = stack.maintenance.run?.id;
    const effects: Effect[] = stack.attempts
      .filter((a) => a !== last)
      .map((a) => ({
        text: `${stamp(a.run.createdAt, now)} · ${attemptText(a, setter)}`,
        url: a.run.url,
      }));
    const since = Date.parse(first.run.createdAt);
    for (const { line, f } of envFailures) {
      if (Date.parse(f.at) < since) continue;
      folded.add(f);
      effects.push({ text: failureLine(line.fork.id, f, now), url: f.url ?? f.prUrl });
    }
    const live = stack.inflight;
    const usual = usualText(stack.usual);
    const state = stack.maintenance.state === "set" ? "maintenance mode" : "not deployable";
    const text = live
      ? `${state}; ${runName(live.run)} in ${runWhere(live) ?? "progress"} now${
          overdue(stack, now) && usual ? `, past ${usual}` : ""
        }`
      : `${state}; last attempt ${attemptText(last)}`;
    const cause: Fact[] = [
      {
        label: "state",
        value: `${state} since ${stamp(stack.maintenance.since ?? first.run.createdAt, now)}`,
      },
      { label: "first", value: attemptText(first), url: first.run.url },
      { label: "last", value: attemptText(last), url: last.run.url },
    ];
    if (stack.declared) {
      cause.push({
        label: "versions",
        value: `declared ${stack.declared} · running ${stack.running?.version ?? "?"}`,
      });
    }
    items.push({
      id: `stack:${first.run.id}`,
      kind: "stack",
      rung: 0,
      scope: "Environment",
      text,
      since:
        stack.maintenance.state === "set" && stack.maintenance.since
          ? stack.maintenance.since
          : first.run.createdAt,
      url: last.run.url,
      note: effects.length > 0 ? `folds ${plural(effects.length, "effect")}` : undefined,
      effects,
      cause,
      cls: "ENV",
      incident: true,
      blocks: new Set(
        envFailures.filter(({ f }) => folded.has(f)).map(({ f }) => `${f.repo}#${f.pr}`),
      ).size,
    });
  } else if (heldWithoutCause && stack.maintenance.run) {
    items.push({
      id: "stack:maintenance",
      kind: "maintenance",
      rung: 0,
      scope: "Environment",
      text: `maintenance held since ${stamp(stack.maintenance.since, now)} with no lifecycle run in flight`,
      since: stack.maintenance.since,
      url: stack.maintenance.run.url,
      effects: [],
      cause: [
        {
          label: "set by",
          value: `${runName(stack.maintenance.run)} ${stamp(stack.maintenance.run.createdAt, now)}`,
          url: stack.maintenance.run.url,
        },
      ],
      cls: "ENV",
      incident: true,
      blocks: 0,
    });
  }
  // ENV failures the stack does not explain still need a re-run by a person.
  const loose = envFailures.filter(({ f }) => !folded.has(f));
  if (loose.length > 0 && !stack.inflight) {
    const oldest = loose.reduce((a, b) => (Date.parse(a.f.at) < Date.parse(b.f.at) ? a : b));
    items.push({
      id: "stack:lanes",
      kind: "lanes",
      rung: 1,
      scope: "Environment",
      text:
        stack.deployable.state === "yes"
          ? `deployable again; ${plural(loose.length, "fork lane")} failed before it recovered`
          : `${plural(loose.length, "fork lane")} failed on the environment${oldest.f.reason ? `: ${oldest.f.reason}` : ""}`,
      since: oldest.f.at,
      url: oldest.f.url ?? oldest.f.prUrl,
      note: stack.deployable.state === "yes" ? "re-run now" : undefined,
      effects: loose.map(({ line, f }) => ({
        text: failureLine(line.fork.id, f, now),
        url: f.url ?? f.prUrl,
      })),
      cause: [
        {
          label: "environment",
          value: `${stack.deployable.state === "yes" ? "deployable" : "not deployable"} · ${stack.deployable.reason}`,
        },
        {
          label: "first failure",
          value: failureLine(oldest.line.fork.id, oldest.f, now),
          url: oldest.f.url ?? oldest.f.prUrl,
        },
      ],
      cls: "ENV",
      incident: true,
      blocks: loose.length,
    });
  }
  return { items, folded };
}

function gateText(p: LinePr): string {
  const failure = p.failures.find((f) => f.cls !== "POLICY" && f.cls !== "ENV");
  if (!failure) return "";
  const tool = failure.cls === "TOOLCHAIN" ? toolchainText(failure.reason) : undefined;
  return ` fails ${failure.check}${tool ? `: ${tool}` : failure.reason ? `: ${failure.reason}` : ""}`;
}

function lineItems(line: LineModel, now: Date): QueueItem[] {
  const items: QueueItem[] = [];
  const svc = line.fork.id;
  const lag = line.upstream?.lag;
  if (line.halt) {
    const h = line.halt;
    const effects: Effect[] = [];
    if (line.syncFailedSince) {
      effects.push({
        text: `${plural(line.syncFailedSince, "daily Sync Upstream run")} failed since the halt`,
        url: line.syncRun?.url,
      });
    }
    if (lag) effects.push({ text: `${plural(lag, "upstream commit")} wait behind the halt` });
    const entries = haltEntries(h.detail);
    const cause: Fact[] = [
      {
        label: "issue",
        value: `#${h.issue.number} · sync-failed · opened ${stamp(h.issue.createdAt, now)}`,
        url: h.issue.url,
      },
      { label: "halt", value: h.code },
    ];
    if (entries.length > 0) {
      cause.push({ label: entries.length === 1 ? "entry" : "entries", value: entries.join(", ") });
    }
    cause.push({
      label: "filter",
      value: ".github/upstream-filter.yml on main · no rule matches",
      url: githubUrl(line.fork.repo, "/blob/main/.github/upstream-filter.yml"),
    });
    if (lag)
      cause.push({ label: "held", value: `${plural(lag, "upstream commit")} behind the halt` });
    items.push({
      id: `halt:${svc}`,
      kind: "halt",
      rung: 0,
      scope: svc,
      text: `sync halted: ${h.code}: ${h.detail}`,
      since: h.issue.createdAt,
      url: h.issue.url,
      note: lag ? `${plural(lag, "commit")} behind` : undefined,
      effects,
      cause,
      cls: "HALT",
      halt: { fork: svc, code: h.code, entries },
      incident: true,
      blocks: lag ?? 1,
    });
  } else if (line.syncRun?.conclusion === "failure" && !line.syncPr) {
    items.push({
      id: `sync-run:${svc}`,
      kind: "sync-run",
      rung: 0,
      scope: svc,
      text: "Sync Upstream failed with no halt issue open",
      since: line.syncRun.createdAt,
      url: line.syncRun.url,
      effects: [],
      cause: [
        {
          label: "run",
          value: `Sync Upstream ${stamp(line.syncRun.createdAt, now)} · ${line.syncRun.conclusion ?? line.syncRun.status}`,
          url: line.syncRun.url,
        },
      ],
      incident: true,
      blocks: lag ?? 1,
    });
  }
  for (const issue of line.conflicts) {
    items.push({
      id: `conflict:${svc}:${issue.number}`,
      kind: "conflict",
      rung: 0,
      scope: svc,
      text: `cascade blocked: ${issue.title}`,
      since: issue.createdAt,
      url: issue.url,
      effects: [],
      cause: [
        {
          label: "issue",
          value: `#${issue.number} · ${issue.labels.join(", ")} · opened ${stamp(issue.createdAt, now)}`,
          url: issue.url,
        },
      ],
      cls: "CONFLICT",
      incident: true,
      blocks: 1,
    });
  }
  const stop = line.cascadeLabels.find((l) => l === "cascade-failed" || l === "validation-failed");
  if (stop && line.conflicts.length === 0 && line.tracking) {
    items.push({
      id: `cascade:${svc}`,
      kind: "cascade",
      rung: 0,
      scope: svc,
      text: `cascade stopped: tracking issue labeled ${stop}`,
      since: line.tracking.updatedAt,
      url: line.tracking.url,
      effects: [],
      cause: [
        {
          label: "tracking",
          value: `#${line.tracking.number} · ${line.cascadeLabels.join(", ")}`,
          url: line.tracking.url,
        },
      ],
      incident: true,
      blocks: 1,
    });
  }
  if (line.mainRed && line.mainRed.cls !== "ENV") {
    const m = line.mainRed;
    items.push({
      id: `main:${svc}`,
      kind: "main",
      rung: 0,
      scope: svc,
      text: `main red: ${m.job?.name ?? "Validation"}${m.job?.failedStep ? ` › ${m.job.failedStep}` : ""} failed on ${short(m.run.sha)}${m.job?.reason ? ` (${m.job.reason})` : ""}`,
      since: m.run.createdAt,
      url: m.job?.url ?? m.run.url,
      effects: [],
      cause: [
        {
          label: "run",
          value: `${m.run.name ?? "Validation"} on ${short(m.run.sha)} · ${stamp(m.run.createdAt, now)}`,
          url: m.run.url,
        },
        ...(m.job
          ? [
              {
                label: "job",
                value: m.job.failedStep ? `${m.job.name} › ${m.job.failedStep}` : m.job.name,
                url: m.job.url,
              },
            ]
          : []),
        ...(m.job?.reason ? [{ label: "reason", value: m.job.reason }] : []),
      ],
      cls: m.cls,
      incident: true,
      blocks: 1,
    });
  }
  if (line.templateRun && line.templateRun.conclusion !== "success") {
    items.push({
      id: `template-run:${svc}`,
      kind: "template-run",
      rung: 0,
      scope: svc,
      text: "Sync Template failed; template changes stop reaching this fork",
      since: line.templateRun.createdAt,
      url: line.templateRun.url,
      effects: [],
      cause: [
        {
          label: "run",
          value: `Sync Template ${stamp(line.templateRun.createdAt, now)} · ${line.templateRun.conclusion ?? line.templateRun.status}`,
          url: line.templateRun.url,
        },
      ],
      incident: true,
      blocks: 1,
    });
  }
  if (line.syncPr) {
    const p = line.syncPr;
    const red = prVerdict(p.pr) === "red";
    items.push({
      id: `gate1:${svc}`,
      kind: "gate1",
      rung: 1,
      scope: svc,
      text: red
        ? `sync PR #${p.pr.number}${gateText(p) || " is red"}`
        : `gate 1: sync PR #${p.pr.number} waits for review`,
      since: p.pr.createdAt,
      url: p.pr.url,
      note: lag ? `${plural(lag, "commit")} behind` : undefined,
      effects: [],
      cause: [
        ...prFacts(p, now),
        ...(lag
          ? [{ label: "held", value: `${plural(lag, "upstream commit")} wait on this PR` }]
          : []),
      ],
      cls: red ? realFailure(p)?.cls : undefined,
      incident: red && p.failures.some((f) => f.cls !== "ENV" && f.cls !== "POLICY"),
      blocks: lag ?? 1,
    });
  }
  if (line.cascadePr) {
    const p = line.cascadePr;
    const red = prVerdict(p.pr) === "red";
    items.push({
      id: `gate2:${svc}`,
      kind: "gate2",
      rung: 1,
      scope: svc,
      text: red
        ? `release/upstream PR #${p.pr.number}${gateText(p) || " is red"}`
        : `gate 2: release/upstream PR #${p.pr.number} waits for approval; merge with a merge commit`,
      since: p.pr.createdAt,
      url: p.pr.url,
      effects: [],
      cause: [...prFacts(p, now), { label: "merge", value: "merge commit, never a squash" }],
      cls: red ? realFailure(p)?.cls : undefined,
      incident: red && p.failures.some((f) => f.cls !== "ENV" && f.cls !== "POLICY"),
      blocks: 1,
    });
  }
  if (line.templatePr) {
    const real = line.templatePr.failures.filter((f) => f.cls !== "ENV" && f.cls !== "POLICY");
    if (real.length > 0) {
      items.push({
        id: `template-red:${svc}`,
        kind: "template-red",
        rung: 1,
        scope: svc,
        text: `template-sync PR #${line.templatePr.pr.number}${gateText(line.templatePr)}`,
        since: line.templatePr.pr.updatedAt,
        url: line.templatePr.pr.url,
        effects: [],
        cause: [
          ...prFacts(line.templatePr, now),
          ...(line.template.target
            ? [
                {
                  label: "moves to",
                  value: `${line.template.label ?? "?"} → ${line.template.target}`,
                },
              ]
            : []),
        ],
        cls: real[0]?.cls,
        incident: true,
        blocks: 1,
      });
    }
  }
  if (line.labelsIssue) {
    items.push({
      id: `labels:${svc}`,
      kind: "labels",
      rung: 1,
      scope: svc,
      text: "label configuration changed in the template; apply labels by hand",
      since: line.labelsIssue.createdAt,
      url: line.labelsIssue.url,
      effects: [],
      cause: [
        {
          label: "issue",
          value: `#${line.labelsIssue.number} · opened ${stamp(line.labelsIssue.createdAt, now)}`,
          url: line.labelsIssue.url,
        },
      ],
      incident: false,
      blocks: 0,
    });
  }
  return items;
}

function templateSetItem(
  template: TemplateModel,
  lines: readonly LineModel[],
  stack: StackModel,
  now: Date,
): QueueItem | undefined {
  const open = lines.filter((l) => l.templatePr);
  if (open.length === 0) return undefined;
  const blockedByEnv = open.some((l) => l.templatePr?.failures.some((f) => f.cls === "ENV"));
  const review = open.some((l) => l.templatePr?.pr.reviewDecision === "REVIEW_REQUIRED");
  const oldest = open.reduce((a, b) =>
    Date.parse(a.templatePr?.pr.createdAt ?? "") < Date.parse(b.templatePr?.pr.createdAt ?? "")
      ? a
      : b,
  );
  const suffix = [
    !blockedByEnv
      ? "mergeable together"
      : stack.deployable.state === "yes"
        ? "mergeable together after the lane re-run"
        : "mergeable together once the stack is deployable",
    review ? "review required" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const targets = [...new Set(open.map((l) => l.template.target))];
  const to =
    targets.length === 1 && targets[0]
      ? `to ${targets[0]}`
      : `at template ${short(template.head?.sha)}`;
  const tag = template.latestTag;
  const behindRelease = targets.length === 1 && predates(targets[0], tag);
  const red = open.filter((l) => l.templatePr && realFailure(l.templatePr));
  const cause: Fact[] = [
    {
      label: "target",
      value:
        targets.length === 1 && targets[0] ? targets[0] : `template ${short(template.head?.sha)}`,
    },
    {
      label: "PRs",
      value: `${plural(open.length, "fork")} · ${open.map((l) => l.fork.id).join(", ")}`,
    },
    ...(behindRelease
      ? [{ label: "latest", value: `${tag} is out; these PRs carry the template before it` }]
      : []),
    {
      label: "review",
      value: `${open.filter((l) => l.templatePr?.pr.reviewDecision === "APPROVED").length} of ${open.length} approved`,
    },
  ];
  if (red.length > 0) {
    cause.push({
      label: "failing",
      value: red.map((l) => `${l.fork.id} #${l.templatePr?.pr.number}`).join(", "),
    });
  }
  return {
    id: "template-set",
    kind: "template-set",
    rung: 2,
    scope: "fleet",
    text: `${plural(open.length, "template-sync PR")} ${to}${behindRelease ? ` (${tag} is out)` : ""} · ${suffix}`,
    since: oldest.templatePr?.pr.createdAt,
    url: oldest.templatePr?.pr.url,
    effects: open.map((l) => ({
      text: `${l.fork.id} #${l.templatePr?.pr.number} · ${l.templatePr ? prVerdict(l.templatePr.pr) : ""}${l.templatePr?.failures[0] ? ` · ${l.templatePr.failures[0].cls} ${l.templatePr.failures[0].step ?? l.templatePr.failures[0].check}` : ""} · updated ${stamp(l.templatePr?.pr.updatedAt, now)}`,
      url: l.templatePr?.pr.url,
    })),
    cause,
    incident: false,
    blocks: open.length,
  };
}

// Forks by service name, as the lines table names them; other repositories by short name.
function repoName(repo: string): string {
  return forkOf(repo)?.id ?? shortRepo(repo);
}

function releaseItems(
  repos: Record<string, RepoFact>,
  details: Parameters<typeof prFailures>[1],
  now: Date,
): QueueItem[] {
  const open: { repo: string; pr: PrFact; tag: string; ready: boolean }[] = [];
  const items: QueueItem[] = [];
  for (const fact of Object.values(repos)) {
    for (const pr of fact.prs) {
      if (!(pr.head.startsWith("release-please--") || pr.labels.includes("autorelease: pending")))
        continue;
      const { failures } = prFailures(pr, details);
      const real = failures.filter((f) => f.cls !== "POLICY" && f.cls !== "ENV");
      const tag = releaseTag(pr.title, fact.release?.tag) ?? `#${pr.number}`;
      if (real.length > 0) {
        items.push({
          id: `release-red:${pr.repo}#${pr.number}`,
          kind: "release-red",
          rung: 1,
          scope: repoName(pr.repo),
          text: `release PR ${tag} fails ${real[0]?.check}${real[0]?.reason ? `: ${real[0].reason}` : ""}`,
          since: pr.createdAt,
          url: pr.url,
          effects: [],
          cause: prFacts({ pr, prClass: "release", failures }, now),
          cls: real[0]?.cls,
          incident: true,
          blocks: 1,
        });
      } else {
        open.push({ repo: fact.repo, pr, tag, ready: prReady(pr, failures) });
      }
    }
  }
  if (open.length > 0) {
    const oldest = open.reduce((a, b) =>
      Date.parse(a.pr.createdAt) < Date.parse(b.pr.createdAt) ? a : b,
    );
    const state = open.every((r) => r.ready)
      ? "ready"
      : open.some((r) => r.pr.reviewDecision === "REVIEW_REQUIRED")
        ? "review required"
        : undefined;
    items.push({
      id: "releases",
      kind: "releases",
      rung: 2,
      scope: "fleet",
      text: [
        plural(open.length, "release PR"),
        open.map((r) => `${repoName(r.repo)} ${r.tag}`).join(", "),
        state,
      ]
        .filter(Boolean)
        .join(" · "),
      since: oldest.pr.createdAt,
      url: oldest.pr.url,
      effects: open.map((r) => ({
        text: `${repoName(r.repo)} #${r.pr.number} ${r.pr.title}`,
        url: r.pr.url,
      })),
      cause: open.map((r) => ({
        label: repoName(r.repo),
        value: `${r.tag} · #${r.pr.number} · ${r.ready ? "approved and green" : (r.pr.reviewDecision ?? "pending").toLowerCase().replaceAll("_", " ")}`,
        url: r.pr.url,
      })),
      incident: false,
      blocks: open.length,
    });
  }
  return items;
}

export function diffText(pr: OutsidePr): string {
  return `${plural(pr.changedFiles, "file")} · +${pr.additions} −${pr.deletions}`;
}

export function associationText(association: string): string {
  return association.toLowerCase().replaceAll("_", "-");
}

const WHY_APPROVAL: Fact = {
  label: "why",
  value: "outside contributors' runs wait until a maintainer approves them",
};

// Before the runs are matched to PRs, the item can only count titles.
function titledApprovals(repo: string, runs: readonly WaitingRun[]): QueueItem {
  const titles = [...new Set(runs.map((r) => r.title))];
  const oldest = runs.reduce((a, b) => (Date.parse(a.createdAt) < Date.parse(b.createdAt) ? a : b));
  return {
    id: `approvals:${repo}`,
    kind: "approvals",
    rung: 1,
    scope: shortRepo(repo),
    text: `${plural(titles.length, "outside PR")} ${titles.length === 1 ? "waits" : "wait"} for workflow approval`,
    since: oldest.createdAt,
    url: githubUrl(repo, "/actions?query=is%3Aaction_required"),
    effects: titles.map((t) => ({ text: t })),
    cause: [
      { label: "repository", value: repo, url: githubUrl(repo) },
      {
        label: "waiting",
        value: `${plural(runs.length, "run")} on ${plural(titles.length, "PR")}`,
      },
      WHY_APPROVAL,
    ],
    incident: false,
    blocks: titles.length,
  };
}

function matchedApprovals(repo: string, runs: readonly WaitingRun[]): QueueItem | undefined {
  const prs = new Map<number, ApprovePr>();
  let superseded = 0;
  for (const r of runs) {
    if (!r.pr) {
      superseded++;
      continue;
    }
    const entry = prs.get(r.pr.number) ?? {
      repo,
      pr: r.pr,
      runs: [],
      since: r.createdAt,
      workflowFiles: r.pr.files.filter((f) => f.startsWith(".github/")),
    };
    entry.runs.push({ id: r.id, name: r.name });
    if (Date.parse(r.createdAt) < Date.parse(entry.since)) entry.since = r.createdAt;
    prs.set(r.pr.number, entry);
  }
  if (prs.size === 0) return undefined;
  const approve = [...prs.values()].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const live = approve.reduce((n, a) => n + a.runs.length, 0);
  const cause: Fact[] = [
    { label: "repository", value: repo, url: githubUrl(repo) },
    { label: "waiting", value: `${plural(live, "run")} on ${plural(approve.length, "PR")}` },
  ];
  if (superseded > 0) {
    cause.push({
      label: "superseded",
      value: `${plural(superseded, "run")} on heads since pushed past; nothing to approve`,
    });
  }
  cause.push(WHY_APPROVAL);
  return {
    id: `approvals:${repo}`,
    kind: "approvals",
    rung: 1,
    scope: shortRepo(repo),
    text: `${plural(approve.length, "outside PR")} ${approve.length === 1 ? "waits" : "wait"} for workflow approval`,
    since: approve[0]?.since,
    url: githubUrl(repo, "/actions?query=is%3Aaction_required"),
    effects: approve.map((a) => ({
      text: `#${a.pr.number} ${a.pr.title} · ${a.pr.author}`,
      url: a.pr.url,
    })),
    cause,
    approve,
    incident: false,
    blocks: approve.length,
  };
}

function approvalItems(approvals: Record<string, WaitingRun[]> | undefined): QueueItem[] {
  const items: QueueItem[] = [];
  for (const [repo, runs] of Object.entries(approvals ?? {})) {
    if (runs.length === 0) continue;
    const item = runs.some((r) => r.pr === undefined)
      ? titledApprovals(repo, runs)
      : matchedApprovals(repo, runs);
    if (item) items.push(item);
  }
  return items;
}

function bumpItem(stack: StackModel): QueueItem | undefined {
  const pr = stack.bumpPr;
  if (!pr) return undefined;
  const version = /(v\d+\.\d+\.\d+)/.exec(pr.title)?.[1] ?? `#${pr.number}`;
  return {
    id: `bump:${pr.number}`,
    kind: "bump",
    rung: 2,
    scope: "Environment",
    text: `env bump to ${version} is open; merging it starts env-upgrade${stack.inflight ? " (wait for the run in flight)" : ""}`,
    since: pr.createdAt,
    url: pr.url,
    effects: [],
    cause: [
      { label: "PR", value: `#${pr.number} · ${pr.title}`, url: pr.url },
      { label: "declared", value: stack.declared ?? "?" },
    ],
    incident: false,
    blocks: 0,
  };
}

export function buildQueue(input: {
  stack: StackModel;
  lines: readonly LineModel[];
  template: TemplateModel;
  repos: Record<string, RepoFact>;
  details: Parameters<typeof prFailures>[1];
  approvals: Record<string, WaitingRun[]> | undefined;
  now: Date;
}): Queue {
  const { stack, lines, template, repos, details, approvals, now } = input;
  const items: QueueItem[] = [];
  items.push(...stackItems(stack, lines, now).items);
  for (const line of lines) items.push(...lineItems(line, now));
  items.push(...approvalItems(approvals));
  const set = templateSetItem(template, lines, stack, now);
  if (set) items.push(set);
  items.push(...releaseItems(repos, details, now));
  const bump = bumpItem(stack);
  if (bump) items.push(bump);

  items.sort(
    (a, b) =>
      a.rung - b.rung ||
      b.blocks - a.blocks ||
      Date.parse(a.since ?? "") - Date.parse(b.since ?? ""),
  );
  const counts = {
    p0: items.filter((i) => i.rung === 0).length,
    p1: items.filter((i) => i.rung === 1).length,
    p2: items.filter((i) => i.rung === 2).length,
  };
  const verdict: Verdict =
    counts.p0 > 0
      ? "BLOCKED"
      : counts.p1 > 0
        ? "ATTENTION"
        : stack.inflight || counts.p2 > 0
          ? "MOVING"
          : "CONVERGED";
  return {
    items,
    counts,
    verdict,
    incidents: items.filter((i) => i.incident && i.rung < 2).length,
  };
}
