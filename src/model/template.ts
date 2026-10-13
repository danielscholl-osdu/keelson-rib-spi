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
import { classifyPr, type Failure, type PrClass, prFailures } from "./attribution.ts";
import { type PrVerdict, prReady, prVerdict } from "./checks.ts";
import type { LineModel } from "./lines.ts";
import { nextFire, toCrons } from "./schedule.ts";
import { semverCmp } from "./stack.ts";

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
  syncing?: RunFact;
  dispatched?: string;
  // Approved, green and not a draft: what Roll out would merge.
  ready: boolean;
  dependabot: PrFact[];
}

// An open PR on osdu-spi itself: a change waiting to enter the engineering system.
export interface TemplatePr {
  pr: PrFact;
  cls: PrClass;
  verdict: PrVerdict;
  failures: Failure[];
}

// Merged PRs since the newest release, or, when none, the ones that release took.
export interface TemplateMerged {
  tag: string;
  after: boolean;
  n: number;
  dependabot: number;
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
  release?: { tag: string; at: string; url: string };
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
  // Forks on the newest release or past it, of the forks whose position was read.
  onRelease: number;
  read: number;
  prs: TemplatePr[];
  merged?: TemplateMerged;
  nextSync?: string;
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

// "v1.2.0 +14" as a release and the commits past it; "main" or a sha is not a position.
function position(label: string | undefined): { version: string; ahead: number } | undefined {
  const m = label ? /^(v?\d+\.\d+\.\d+)(?: \+(\d+))?$/.exec(label) : null;
  return m ? { version: m[1] as string, ahead: Number(m[2] ?? 0) } : undefined;
}

export function positionCmp(a: string | undefined, b: string | undefined): number | undefined {
  const pa = position(a);
  const pb = position(b);
  if (!pa || !pb) return undefined;
  return semverCmp(pa.version, pb.version) || pa.ahead - pb.ahead;
}

// The failure that is the PR's own; ENV belongs to the stack and POLICY is expected.
export function ownFailure(row: TemplateRow): Failure | undefined {
  return row.failures.find((f) => !f.hidden && f.cls !== "ENV" && f.cls !== "POLICY");
}

function realFailure(row: TemplateRow): boolean {
  return !!ownFailure(row);
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
  // Whether a fork's PR takes it to this position; unknown counts as carrying it.
  const carries = (row: TemplateRow, pos: { marker: string; behind: number; label: string }) => {
    const at = row.pr?.headMarker ? positions.get(row.pr.headMarker) : undefined;
    if (at) return at.behind <= pos.behind;
    const cmp = positionCmp(row.target, pos.label);
    return cmp === undefined || cmp >= 0;
  };
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
      else if (row.pr && !carries(row, pos)) step.noPr.push(row.service);
      else if (row.pr && realFailure(row)) step.failing.push(row.service);
      else if (row.pr || (row.awaitingRun && pos.behind > 0)) step.waiting.push(row.service);
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

// Whether a position like "v1.2.0 +14" sits before release `tag`; a bare sha is not known to.
export function predates(position: string | undefined, tag: string | undefined): boolean {
  const version = position ? /^v?\d+\.\d+\.\d+/.exec(position)?.[0] : undefined;
  return !!version && !!tag && semverCmp(version, tag) < 0;
}

// "chore: release 1.2.1" with tags like v1.2.0 names the next tag v1.2.1.
export function nextTag(templateRepo: RepoFact | undefined, latestTag: string | undefined) {
  const pr = templateReleasePr(templateRepo);
  const version = pr ? /release\s+v?(\S+)/i.exec(pr.title)?.[1] : undefined;
  if (!version) return undefined;
  return `${latestTag?.startsWith("v") ? "v" : ""}${version}`;
}

function isDependabot(p: { head: string; author?: string }): boolean {
  return classifyPr(p) === "dependabot";
}

export function mergedSince(templateRepo: RepoFact | undefined): TemplateMerged | undefined {
  const past = templateRepo?.pastPrs;
  const releases = [...(templateRepo?.releases ?? [])].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );
  const latest = releases[0];
  if (!past || !latest) return undefined;
  const merged = past.filter((p) => p.mergedAt && classifyPr(p) !== "release");
  const count = (list: typeof merged, tag: string, after: boolean): TemplateMerged => ({
    tag,
    after,
    n: list.length,
    dependabot: list.filter(isDependabot).length,
  });
  const at = (p: (typeof merged)[number]) => Date.parse(p.mergedAt as string);
  const after = merged.filter((p) => at(p) > Date.parse(latest.at));
  if (after.length > 0 || !releases[1]) return count(after, latest.tag, true);
  const prev = Date.parse(releases[1].at);
  return count(
    merged.filter((p) => at(p) > prev && at(p) <= Date.parse(latest.at)),
    latest.tag,
    false,
  );
}

export function buildTemplate(
  templateRepo: RepoFact | undefined,
  facts: TemplateFacts | undefined,
  lines: readonly LineModel[],
  opts: {
    syncCrons?: readonly string[];
    now?: Date;
    details?: Parameters<typeof prFailures>[1];
  } = {},
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
      ...(line.templateSyncing ? { syncing: line.templateSyncing } : {}),
      ...(line.templateDispatched ? { dispatched: line.templateDispatched } : {}),
      ready: !!line.templatePr && prReady(line.templatePr.pr, line.templatePr.failures),
      dependabot: line.prs.filter((p) => p.prClass === "dependabot").map((p) => p.pr),
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
  const read = rows.filter((r) => r.label !== undefined);
  const fire = opts.now && opts.syncCrons ? nextFire(toCrons(opts.syncCrons), opts.now) : undefined;
  const merged = mergedSince(templateRepo);
  return {
    head: templateRepo?.head,
    latestTag,
    release: templateRepo?.release,
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
    onRelease: read.filter((r) => r.behind === 0 || (positionCmp(r.label, latestTag) ?? -1) >= 0)
      .length,
    read: read.length,
    prs: (templateRepo?.prs ?? []).map((pr) => {
      const { prClass, failures } = prFailures(pr, opts.details ?? {});
      return { pr, cls: prClass, verdict: prVerdict(pr), failures };
    }),
    ...(merged ? { merged } : {}),
    ...(fire !== undefined ? { nextSync: new Date(fire).toISOString() } : {}),
  };
}
