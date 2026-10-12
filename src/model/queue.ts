// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { githubUrl, shortRepo } from "../config.ts";
import type { PrFact, RepoFact, RunFact } from "../facts.ts";
import { plural, short, stamp } from "../util.ts";
import { CLASS_LABEL, type Failure, prFailures, toolchainText } from "./attribution.ts";
import { prVerdict } from "./checks.ts";
import type { LineModel, LinePr } from "./lines.ts";
import type { RunView, StackModel } from "./stack.ts";
import type { TemplateModel } from "./template.ts";

export type Rung = 0 | 1 | 2;
export type Verdict = "BLOCKED" | "ATTENTION" | "MOVING" | "CONVERGED";

export interface Effect {
  text: string;
  url?: string;
}

export interface QueueItem {
  id: string;
  rung: Rung;
  scope: string;
  text: string;
  since?: string;
  url?: string;
  note?: string;
  effects: Effect[];
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

function stackRunText(view: RunView): string {
  const run = view.run;
  const what =
    run.kind === "upgrade" ? `upgrade${run.target ? ` to ${run.target}` : ""}` : `env-${run.kind}`;
  return `${what} failed${view.failedAt ? ` in ${view.failedAt}` : ""}`;
}

function failureLine(service: string, f: Failure, now: Date): string {
  const parts = [`${service} ${CLASS_LABEL[f.prClass]} #${f.pr}`];
  if (f.step) parts.push(f.step);
  if (f.reason) parts.push(f.reason);
  parts.push(stamp(f.at, now) ?? "");
  return parts.filter(Boolean).join(" · ");
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
  const cause = stack.failure;
  const heldWithoutCause =
    !cause && !stack.inflight && stack.maintenance.state === "set" && stack.maintenance.run;
  if (cause && stack.deployable.state !== "yes") {
    const effects: Effect[] = [];
    for (const later of stack.failureChain.slice(0, -1)) {
      effects.push({
        text: `env-${later.run.kind} ${stamp(later.run.createdAt, now)} · ${later.failedAt ?? "failed"}${later.reason ? ` · ${later.reason}` : ""}`,
        url: later.run.url,
      });
    }
    const since = Date.parse(cause.run.createdAt);
    for (const { line, f } of envFailures) {
      if (Date.parse(f.at) < since) continue;
      folded.add(f);
      effects.push({ text: failureLine(line.fork.id, f, now), url: f.url ?? f.prUrl });
    }
    const held = stack.maintenance.state === "set" ? "; maintenance held" : "";
    const live = stack.inflight;
    const where = live?.current ?? "progress";
    const now_ = !live
      ? ""
      : live.run.kind !== "upgrade"
        ? ` · env-${live.run.kind} in ${where} now`
        : live.run.target && live.run.target !== cause.run.target
          ? ` · upgrade to ${live.run.target} in ${where} now`
          : ` · re-run in ${where} now`;
    items.push({
      id: `stack:${cause.run.id}`,
      rung: 0,
      scope: "Shared stack",
      text: `${stackRunText(cause)}${cause.reason ? ` (${cause.reason})` : ""}${held}${now_}`,
      since: cause.run.createdAt,
      url: cause.run.url,
      note: effects.length > 0 ? `folds ${plural(effects.length, "effect")}` : undefined,
      effects,
      incident: true,
      blocks: new Set(
        envFailures.filter(({ f }) => folded.has(f)).map(({ f }) => `${f.repo}#${f.pr}`),
      ).size,
    });
  } else if (heldWithoutCause && stack.maintenance.run) {
    items.push({
      id: "stack:maintenance",
      rung: 0,
      scope: "Shared stack",
      text: `maintenance held since ${stamp(stack.maintenance.since, now)} with no lifecycle run in flight`,
      since: stack.maintenance.since,
      url: stack.maintenance.run.url,
      effects: [],
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
      rung: 1,
      scope: "Shared stack",
      text: `${plural(loose.length, "fork lane")} failed on the environment${oldest.f.reason ? `: ${oldest.f.reason}` : ""}`,
      since: oldest.f.at,
      url: oldest.f.url ?? oldest.f.prUrl,
      note: stack.deployable.state === "yes" ? "re-run now" : undefined,
      effects: loose.map(({ line, f }) => ({
        text: failureLine(line.fork.id, f, now),
        url: f.url ?? f.prUrl,
      })),
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

function lineItems(line: LineModel): QueueItem[] {
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
    items.push({
      id: `halt:${svc}`,
      rung: 0,
      scope: svc,
      text: `sync halted: ${h.code}: ${h.detail}`,
      since: h.issue.createdAt,
      url: h.issue.url,
      note: lag ? `${plural(lag, "commit")} held` : undefined,
      effects,
      incident: true,
      blocks: lag ?? 1,
    });
  } else if (line.syncRun?.conclusion === "failure" && !line.syncPr) {
    items.push({
      id: `sync-run:${svc}`,
      rung: 0,
      scope: svc,
      text: "Sync Upstream failed with no halt issue open",
      since: line.syncRun.createdAt,
      url: line.syncRun.url,
      effects: [],
      incident: true,
      blocks: lag ?? 1,
    });
  }
  for (const issue of line.conflicts) {
    items.push({
      id: `conflict:${svc}:${issue.number}`,
      rung: 0,
      scope: svc,
      text: `cascade blocked: ${issue.title}`,
      since: issue.createdAt,
      url: issue.url,
      effects: [],
      incident: true,
      blocks: 1,
    });
  }
  const stop = line.cascadeLabels.find((l) => l === "cascade-failed" || l === "validation-failed");
  if (stop && line.conflicts.length === 0 && line.tracking) {
    items.push({
      id: `cascade:${svc}`,
      rung: 0,
      scope: svc,
      text: `cascade stopped: tracking issue labeled ${stop}`,
      since: line.tracking.updatedAt,
      url: line.tracking.url,
      effects: [],
      incident: true,
      blocks: 1,
    });
  }
  if (line.mainRed && line.mainRed.cls !== "ENV") {
    const m = line.mainRed;
    items.push({
      id: `main:${svc}`,
      rung: 0,
      scope: svc,
      text: `main red: ${m.job?.name ?? "Validation"}${m.job?.failedStep ? ` › ${m.job.failedStep}` : ""} failed on ${short(m.run.sha)}${m.job?.reason ? ` (${m.job.reason})` : ""}`,
      since: m.run.createdAt,
      url: m.job?.url ?? m.run.url,
      effects: [],
      incident: true,
      blocks: 1,
    });
  }
  if (line.templateRun && line.templateRun.conclusion !== "success") {
    items.push({
      id: `template-run:${svc}`,
      rung: 0,
      scope: svc,
      text: "Sync Template failed; template changes stop reaching this fork",
      since: line.templateRun.createdAt,
      url: line.templateRun.url,
      effects: [],
      incident: true,
      blocks: 1,
    });
  }
  if (line.syncPr) {
    const p = line.syncPr;
    const red = prVerdict(p.pr) === "red";
    items.push({
      id: `gate1:${svc}`,
      rung: 1,
      scope: svc,
      text: red
        ? `sync PR #${p.pr.number}${gateText(p) || " is red"}`
        : `gate 1: sync PR #${p.pr.number} waits for review`,
      since: p.pr.createdAt,
      url: p.pr.url,
      note: lag ? `${plural(lag, "commit")} held` : undefined,
      effects: [],
      incident: red && p.failures.some((f) => f.cls !== "ENV" && f.cls !== "POLICY"),
      blocks: lag ?? 1,
    });
  }
  if (line.cascadePr) {
    const p = line.cascadePr;
    const red = prVerdict(p.pr) === "red";
    items.push({
      id: `gate2:${svc}`,
      rung: 1,
      scope: svc,
      text: red
        ? `release/upstream PR #${p.pr.number}${gateText(p) || " is red"}`
        : `gate 2: release/upstream PR #${p.pr.number} waits for approval; merge with a merge commit`,
      since: p.pr.createdAt,
      url: p.pr.url,
      effects: [],
      incident: red && p.failures.some((f) => f.cls !== "ENV" && f.cls !== "POLICY"),
      blocks: 1,
    });
  }
  if (line.templatePr) {
    const real = line.templatePr.failures.filter((f) => f.cls !== "ENV" && f.cls !== "POLICY");
    if (real.length > 0) {
      items.push({
        id: `template-red:${svc}`,
        rung: 1,
        scope: svc,
        text: `template-sync PR #${line.templatePr.pr.number}${gateText(line.templatePr)}`,
        since: line.templatePr.pr.updatedAt,
        url: line.templatePr.pr.url,
        effects: [],
        incident: true,
        blocks: 1,
      });
    }
  }
  if (line.labelsIssue) {
    items.push({
      id: `labels:${svc}`,
      rung: 1,
      scope: svc,
      text: "label configuration changed in the template; apply labels by hand",
      since: line.labelsIssue.createdAt,
      url: line.labelsIssue.url,
      effects: [],
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
    stack.deployable.state !== "yes" && blockedByEnv
      ? "mergeable together once the stack is deployable"
      : "mergeable together",
    review ? "review required" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: "template-set",
    rung: 2,
    scope: "fleet",
    text: `${plural(open.length, "template-sync PR")} at template ${short(template.head?.sha)} · ${suffix}`,
    since: oldest.templatePr?.pr.createdAt,
    url: oldest.templatePr?.pr.url,
    effects: open.map((l) => ({
      text: `${l.fork.id} #${l.templatePr?.pr.number} · ${l.templatePr ? prVerdict(l.templatePr.pr) : ""}${l.templatePr?.failures[0] ? ` · ${l.templatePr.failures[0].cls} ${l.templatePr.failures[0].step ?? l.templatePr.failures[0].check}` : ""} · updated ${stamp(l.templatePr?.pr.updatedAt, now)}`,
      url: l.templatePr?.pr.url,
    })),
    incident: false,
    blocks: open.length,
  };
}

function releaseVersion(pr: PrFact): string {
  return /release\s+v?(\S+)/i.exec(pr.title)?.[1] ?? `#${pr.number}`;
}

function releaseItems(
  repos: Record<string, RepoFact>,
  details: Parameters<typeof prFailures>[1],
): QueueItem[] {
  const ready: { repo: string; pr: PrFact }[] = [];
  const items: QueueItem[] = [];
  for (const fact of Object.values(repos)) {
    for (const pr of fact.prs) {
      if (!(pr.head.startsWith("release-please--") || pr.labels.includes("autorelease: pending")))
        continue;
      const { failures } = prFailures(pr, details);
      const real = failures.filter((f) => f.cls !== "POLICY" && f.cls !== "ENV");
      if (real.length > 0) {
        items.push({
          id: `release-red:${pr.repo}#${pr.number}`,
          rung: 1,
          scope: shortRepo(pr.repo),
          text: `release PR ${releaseVersion(pr)} fails ${real[0]?.check}${real[0]?.reason ? `: ${real[0].reason}` : ""}`,
          since: pr.createdAt,
          url: pr.url,
          effects: [],
          incident: true,
          blocks: 1,
        });
      } else {
        ready.push({ repo: fact.repo, pr });
      }
    }
  }
  if (ready.length > 0) {
    const oldest = ready.reduce((a, b) =>
      Date.parse(a.pr.createdAt) < Date.parse(b.pr.createdAt) ? a : b,
    );
    items.push({
      id: "releases",
      rung: 2,
      scope: "fleet",
      text: `${plural(ready.length, "release PR")} ready · ${ready.map((r) => `${shortRepo(r.repo)} ${releaseVersion(r.pr)}`).join(", ")}`,
      since: oldest.pr.createdAt,
      url: oldest.pr.url,
      effects: ready.map((r) => ({
        text: `${shortRepo(r.repo)} #${r.pr.number} ${r.pr.title}`,
        url: r.pr.url,
      })),
      incident: false,
      blocks: ready.length,
    });
  }
  return items;
}

function approvalItems(approvals: Record<string, RunFact[]> | undefined): QueueItem[] {
  const items: QueueItem[] = [];
  for (const [repo, runs] of Object.entries(approvals ?? {})) {
    if (runs.length === 0) continue;
    const titles = [...new Set(runs.map((r) => r.title))];
    const oldest = runs.reduce((a, b) =>
      Date.parse(a.createdAt) < Date.parse(b.createdAt) ? a : b,
    );
    items.push({
      id: `approvals:${repo}`,
      rung: 1,
      scope: shortRepo(repo),
      text: `${plural(titles.length, "outside PR")} ${titles.length === 1 ? "waits" : "wait"} for workflow approval`,
      since: oldest.createdAt,
      url: githubUrl(repo, "/actions?query=is%3Aaction_required"),
      effects: titles.map((t) => ({ text: t })),
      incident: false,
      blocks: titles.length,
    });
  }
  return items;
}

function bumpItem(stack: StackModel): QueueItem | undefined {
  const pr = stack.bumpPr;
  if (!pr) return undefined;
  const version = /(v\d+\.\d+\.\d+)/.exec(pr.title)?.[1] ?? `#${pr.number}`;
  return {
    id: `bump:${pr.number}`,
    rung: 2,
    scope: "Shared stack",
    text: `env bump to ${version} is open; merging it starts env-upgrade${stack.inflight ? " (wait for the run in flight)" : ""}`,
    since: pr.createdAt,
    url: pr.url,
    effects: [],
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
  approvals: Record<string, RunFact[]> | undefined;
  now: Date;
}): Queue {
  const { stack, lines, template, repos, details, approvals, now } = input;
  const items: QueueItem[] = [];
  items.push(...stackItems(stack, lines, now).items);
  for (const line of lines) items.push(...lineItems(line));
  items.push(...approvalItems(approvals));
  const set = templateSetItem(template, lines, stack, now);
  if (set) items.push(set);
  items.push(...releaseItems(repos, details));
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
