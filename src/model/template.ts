// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { githubUrl, TEMPLATE_REPO } from "../config.ts";
import type {
  PrFact,
  RepoFact,
  RunFact,
  SyncedPaths,
  TemplateChange,
  TemplateFacts,
} from "../facts.ts";
import type { Failure } from "./attribution.ts";
import { type PrVerdict, prVerdict } from "./checks.ts";
import type { LineModel } from "./lines.ts";

export interface TemplateRow {
  service: string;
  repo: string;
  marker?: string;
  label?: string;
  target?: string;
  behind?: number;
  pr?: PrFact;
  verdict?: PrVerdict;
  failures: Failure[];
  awaitingRun?: boolean;
  delivery: { run?: RunFact; state: "ok" | "failed" | "stale" | "unknown" };
}

// What a template change does to a fork, read from the synced paths it touches.
export type Consequence = "images" | "actions" | "workflows" | "settings" | "fork resources";
const CONSEQUENCE_ORDER: Consequence[] = [
  "images",
  "actions",
  "workflows",
  "settings",
  "fork resources",
];

// One step of the template's history: the changes from the next older fork
// position up to this one, and how far across the fleet they have spread.
export interface TemplateStep {
  label: string;
  marker: string;
  head: boolean;
  url?: string;
  changes: TemplateChange[];
  consequences: Consequence[];
  templateOnly: number;
  unread: number;
  adopted: string[];
  waiting: string[];
  failing: string[];
  noPr: string[];
  unmeasured: string[];
}

export interface TemplateModel {
  head?: { sha: string; at: string };
  latestTag?: string;
  mainAhead?: number;
  releasePr?: PrFact;
  next?: string;
  rows: TemplateRow[];
  current: number;
  waiting: number;
  behindNoPr: number;
  unmeasured: number;
  changes: (TemplateChange & { forks: number; missing: string[] })[];
  commits: number;
  steps: TemplateStep[];
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export function consequenceOf(path: string, synced: SyncedPaths): Consequence | null {
  if (!synced.files.includes(path) && !synced.dirs.some((d) => under(path, d))) return null;
  if (under(path, "build")) return "images";
  if (under(path, ".github/actions")) return "actions";
  if (under(path, ".github/template-workflows")) return "workflows";
  if (under(path, ".github/fork-resources")) return "fork resources";
  return "settings";
}

function realFailure(row: TemplateRow): boolean {
  return row.failures.some((f) => !f.hidden && f.cls !== "ENV" && f.cls !== "POLICY");
}

export function templateSteps(
  facts: TemplateFacts | undefined,
  rows: readonly TemplateRow[],
  head: { sha: string } | undefined,
  headLabel: string,
): TemplateStep[] {
  const compares = facts?.compares ?? {};
  const positions = new Map<string, { marker: string; behind: number; label: string }>();
  if (head) positions.set(head.sha, { marker: head.sha, behind: 0, label: headLabel });
  for (const row of rows) {
    const compare = row.marker ? compares[row.marker] : undefined;
    if (!compare || positions.has(compare.marker)) continue;
    const label = compare.aheadBy === 0 ? headLabel : compare.label;
    positions.set(compare.marker, { marker: compare.marker, behind: compare.aheadBy, label });
  }
  const ordered = [...positions.values()].sort((a, b) => a.behind - b.behind);
  return ordered.map((pos, i) => {
    const older = ordered[i + 1];
    const newerShas = new Set(compares[pos.marker]?.shas ?? []);
    const changes = older
      ? (compares[older.marker]?.changes ?? []).filter((c) => !newerShas.has(c.sha))
      : [];
    const found = new Set<Consequence>();
    let templateOnly = 0;
    let unread = 0;
    const synced = facts?.synced;
    for (const change of changes) {
      const files = facts?.files?.[change.sha];
      if (!files || !synced) {
        unread++;
        continue;
      }
      const hits = files
        .map((f) => consequenceOf(f, synced))
        .filter((c): c is Consequence => c !== null);
      if (hits.length === 0) templateOnly++;
      for (const hit of hits) found.add(hit);
    }
    const step: TemplateStep = {
      label: pos.label,
      marker: pos.marker,
      head: pos.behind === 0,
      url: older ? githubUrl(TEMPLATE_REPO, `/compare/${older.marker}...${pos.marker}`) : undefined,
      changes,
      consequences: CONSEQUENCE_ORDER.filter((c) => found.has(c)),
      templateOnly,
      unread,
      adopted: [],
      waiting: [],
      failing: [],
      noPr: [],
      unmeasured: [],
    };
    for (const row of rows) {
      if (row.behind === undefined) step.unmeasured.push(row.service);
      else if (row.behind <= pos.behind) step.adopted.push(row.service);
      else if (row.pr && realFailure(row)) step.failing.push(row.service);
      else if (row.pr || row.awaitingRun) step.waiting.push(row.service);
      else step.noPr.push(row.service);
    }
    return step;
  });
}

export function templateReleasePr(templateRepo: RepoFact | undefined): PrFact | undefined {
  return templateRepo?.prs.find(
    (p) => p.head.startsWith("release-please--") || p.labels.includes("autorelease: pending"),
  );
}

// "chore: release 1.2.1" with tags like v1.2.0 names the next tag v1.2.1.
export function nextTag(templateRepo: RepoFact | undefined, latestTag: string | undefined) {
  const pr = templateReleasePr(templateRepo);
  const version = pr ? /release\s+v?(\S+)/i.exec(pr.title)?.[1] : undefined;
  if (!version) return undefined;
  return `${latestTag?.startsWith("v") ? "v" : ""}${version}`;
}

export function buildTemplate(
  templateRepo: RepoFact | undefined,
  facts: TemplateFacts | undefined,
  lines: readonly LineModel[],
): TemplateModel {
  const compares = facts?.compares ?? {};
  const latestTag = facts?.latestTag ?? templateRepo?.release?.tag;
  const rows: TemplateRow[] = lines.map((line) => {
    const marker = line.template.marker;
    const compare = marker ? compares[marker] : undefined;
    return {
      service: line.fork.id,
      repo: line.fork.repo,
      marker,
      label: line.template.label,
      target: line.template.target,
      behind: compare?.aheadBy,
      pr: line.templatePr?.pr,
      verdict: line.templatePr ? prVerdict(line.templatePr.pr) : undefined,
      failures: line.templatePr?.failures ?? [],
      awaitingRun: line.template.awaitingRun,
      delivery: line.templateDelivery,
    };
  });

  // A change is unadopted by every fork whose marker compare still lists it.
  const allChanges = new Map<string, TemplateChange>();
  const missing = new Map<string, string[]>();
  let commits = 0;
  for (const row of rows) {
    const compare = row.marker ? compares[row.marker] : undefined;
    if (!compare) continue;
    commits = Math.max(commits, compare.aheadBy);
    const shas = new Set(compare.shas);
    for (const change of compare.changes) {
      allChanges.set(change.sha, change);
      if (shas.has(change.sha))
        missing.set(change.sha, [...(missing.get(change.sha) ?? []), row.service]);
    }
  }
  const changes = [...allChanges.values()]
    .map((c) => {
      const lacking = missing.get(c.sha) ?? [];
      return { ...c, forks: lacking.length, missing: lacking };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const next = nextTag(templateRepo, latestTag);
  const headLabel = facts?.mainAhead === 0 && latestTag ? latestTag : (next ?? "main");
  return {
    head: templateRepo?.head,
    latestTag,
    mainAhead: facts?.mainAhead,
    releasePr: templateReleasePr(templateRepo),
    next,
    rows,
    current: rows.filter((r) => r.behind === 0).length,
    waiting: rows.filter((r) => (r.behind ?? 0) > 0 && r.pr).length,
    behindNoPr: rows.filter((r) => (r.behind ?? 0) > 0 && !r.pr).length,
    unmeasured: rows.filter((r) => r.behind === undefined).length,
    changes,
    commits,
    steps: templateSteps(facts, rows, templateRepo?.head, headLabel),
  };
}
