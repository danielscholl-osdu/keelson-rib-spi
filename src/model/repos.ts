// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, type ServiceDef, STACK_REPO, TEMPLATE_REPO } from "../config.ts";
import type {
  CodeAlertFact,
  DependencyAlertFact,
  IssueFact,
  Measured,
  PrFact,
  RadarFacts,
  RepoAlerts,
  RepoFact,
  Severity,
  SyncedPaths,
} from "../facts.ts";
import { prVerdict } from "./checks.ts";
import { parseFilter } from "./filter.ts";
import { forkOwned } from "./radar.ts";
import { type IssueKind, issueKind, outsider, prKind } from "./work.ts";

// Who fixes a file: the program, the template that syncs it, or the upstream project.
export type Owner = "spi" | "template" | "upstream";
// Whether a file reaches the running service, only its tests, or only its tooling.
export type Reach = "shipped" | "tests" | "tooling";
export type PrState =
  | "draft"
  | "conflicts"
  | "red"
  | "changes requested"
  | "needs review"
  | "behind"
  | "running"
  | "ready";
export type ChangeKind = "feature" | "fix" | "maintenance" | "other";

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];
const OWNER_RANK: Record<Owner, number> = { spi: 0, template: 1, upstream: 2 };
const REACH_RANK: Record<Reach, number> = { shipped: 0, tooling: 1, tests: 2 };

const MAINTENANCE = new Set(["refactor", "chore", "docs", "ci", "build", "test", "perf", "style"]);
const TOOLING_TOPS = new Set([".github", "deployments", "devops", "scripts", "tools", "docs"]);
const TEST_SEGMENT = /^testing$|(^|[-_.])tests?([-_.]|$)/i;

export interface ChangePr {
  pr: PrFact;
  // The conventional-commit type, empty when the title carries none.
  type: string;
  kind: ChangeKind;
  breaking: boolean;
  subject: string;
  state: PrState;
  outsider: boolean;
  // Other repositories with the same change open, by short name.
  elsewhere: string[];
}

export interface DependencyPr {
  pr: PrFact;
  package?: string;
  from?: string;
  to?: string;
  // The manifest directory, relative to the repository root.
  dir: string;
  owner: Owner;
  reach: Reach;
  state: PrState;
  // Open alerts on the same package and directory.
  closes: number;
}

export interface AlertGroup {
  id: string;
  source: "dependabot" | "code";
  // The package, or the rule's description.
  name: string;
  // The manifest, or the tree the findings sit in.
  where: string;
  owner: Owner;
  reach: Reach;
  // The worst severity; undefined for code rules that carry none.
  severity?: Severity;
  count: number;
  counts: Partial<Record<Severity, number>>;
  // The version that closes every alert in the group; undefined when one has no fix.
  fix?: string;
  unfixed: number;
  pr?: number;
  tool?: string;
  rule?: string;
  url: string;
  // Other repositories where the same package or rule is ours, by short name.
  elsewhere: string[];
}

export interface Tally {
  ours: number;
  upstream: number;
}

export interface RepoRow {
  repo: string;
  name: string;
  group: "program" | "fork";
  url: string;
  changes: ChangePr[];
  dependabot: DependencyPr[];
  pipeline: number;
  issues: Record<IssueKind, IssueFact[]>;
  alerts: AlertGroup[];
  // Undefined while a list is unread or hidden from this token.
  dependabotAlerts?: number;
  codeAlerts?: number;
  // Critical and high alerts in shipped code, by kind.
  vulnerabilities?: Tally;
  codeScanning?: Tally;
  unreadPrs: number;
  unreadIssues: number;
}

export interface ReposModel {
  alertsAt?: string;
  rows: RepoRow[];
}

interface Paths {
  owned: string[];
  synced?: SyncedPaths;
  program: boolean;
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

// A template workflow lands in a fork's .github/workflows under the same name.
function templateFile(path: string, synced: SyncedPaths): boolean {
  if (synced.dirs.some((d) => under(path, d)) || synced.files.includes(path)) return true;
  const wf = /^\.github\/workflows\/([^/]+)$/.exec(path)?.[1];
  return !!wf && synced.files.includes(`.github/template-workflows/${wf}`);
}

export function ownerOf(path: string, p: Paths): Owner {
  if (p.program) return "spi";
  if (p.owned.some((o) => under(path, o))) return "spi";
  if (p.synced && templateFile(path, p.synced)) return "template";
  return "upstream";
}

export function reachOf(path: string, scope?: string): Reach {
  if (scope === "development") return "tests";
  const dirs = path.split("/").slice(0, -1);
  if (dirs.some((d) => TEST_SEGMENT.test(d))) return "tests";
  if (TOOLING_TOPS.has(dirs[0] ?? "")) return "tooling";
  return "shipped";
}

function treeOf(path: string | undefined, p: Paths): string {
  if (!path) return "";
  const owned = p.owned.find((o) => under(path, o));
  if (owned && !p.program) return owned;
  const parts = path.split("/");
  const top = parts[0] ?? path;
  if (parts.length > 2 && (top === "testing" || top === "provider")) return `${top}/${parts[1]}`;
  return parts.length > 1 ? top : path;
}

export function prState(pr: PrFact): PrState {
  if (pr.draft) return "draft";
  if (pr.mergeState === "DIRTY") return "conflicts";
  const verdict = prVerdict(pr);
  if (verdict === "red") return "red";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "needs review";
  if (pr.mergeState === "BEHIND") return "behind";
  if (verdict === "pending") return "running";
  return "ready";
}

export function conventional(title: string): { type: string; breaking: boolean; subject: string } {
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(title.trim());
  if (!m) return { type: "", breaking: false, subject: title.trim() };
  return { type: (m[1] as string).toLowerCase(), breaking: !!m[3], subject: m[4] as string };
}

function changeKind(type: string): ChangeKind {
  if (type === "feat") return "feature";
  if (type === "fix") return "fix";
  return MAINTENANCE.has(type) ? "maintenance" : "other";
}

// "Bump x from 1 to 2 in /dir", with or without a conventional prefix or a group suffix.
export function parseBump(
  title: string,
): { package: string; from: string; to: string; dir: string } | undefined {
  const { subject } = conventional(title);
  const m = /^bump (\S+) from (\S+) to (\S+?)(?: in (\/\S*))?(?: in the .*)?$/i.exec(subject);
  if (!m) return undefined;
  const strip = (v: string) => v.replace(/^`|`$/g, "");
  return {
    package: m[1] as string,
    from: strip(m[2] as string),
    to: strip(m[3] as string),
    dir: (m[4] ?? "/").replace(/^\/+|\/+$/g, ""),
  };
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

// Numeric-aware: 2.21.10 is newer than 2.21.7.
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(/[^0-9A-Za-z]+/);
  const pb = b.split(/[^0-9A-Za-z]+/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== "" && y !== "") return nx > ny;
    return x > y;
  }
  return false;
}

function worst(counts: Partial<Record<Severity, number>>): Severity | undefined {
  return SEVERITY_ORDER.find((s) => (counts[s] ?? 0) > 0);
}

function severeCount(counts: Partial<Record<Severity, number>>): number {
  return (counts.critical ?? 0) + (counts.high ?? 0);
}

function dependencyGroups(alerts: readonly DependencyAlertFact[], p: Paths): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const a of alerts) {
    const id = `dep:${a.manifest}:${a.package.toLowerCase()}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        source: "dependabot",
        name: a.package,
        where: a.manifest,
        owner: ownerOf(a.manifest, p),
        reach: reachOf(a.manifest, a.scope),
        count: 0,
        counts: {},
        unfixed: 0,
        url: a.url,
        elsewhere: [],
      };
      groups.set(id, g);
    } else {
      const reach = reachOf(a.manifest, a.scope);
      if (REACH_RANK[reach] < REACH_RANK[g.reach]) g.reach = reach;
    }
    g.count++;
    g.counts[a.severity] = (g.counts[a.severity] ?? 0) + 1;
    if (!a.fixed) g.unfixed++;
    else if (!g.fix || newerVersion(a.fixed, g.fix)) g.fix = a.fixed;
  }
  return [...groups.values()].map((g) => {
    const out = { ...g, severity: worst(g.counts) };
    if (g.unfixed > 0) delete out.fix;
    return out;
  });
}

function codeGroups(alerts: readonly CodeAlertFact[], p: Paths): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const a of alerts) {
    // A repository-level finding names no file; GitHub fills the path with a sentence.
    const path = a.path && !/\s/.test(a.path) ? a.path : undefined;
    const tree = treeOf(path, p);
    const id = `code:${a.tool}:${a.rule}:${tree}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        source: "code",
        name: a.description,
        where: tree,
        owner: ownerOf(path ?? "", p),
        reach: reachOf(path ?? ""),
        count: 0,
        counts: {},
        unfixed: 0,
        tool: a.tool,
        rule: a.rule,
        url: a.url,
        elsewhere: [],
      };
      groups.set(id, g);
    }
    g.count++;
    if (a.severity) g.counts[a.severity] = (g.counts[a.severity] ?? 0) + 1;
  }
  return [...groups.values()].map((g) => ({ ...g, severity: worst(g.counts) }));
}

function severityRank(s: Severity | undefined): number {
  return s ? SEVERITY_ORDER.indexOf(s) : SEVERITY_ORDER.length;
}

export function groupRank(a: AlertGroup, b: AlertGroup): number {
  return (
    OWNER_RANK[a.owner === "template" ? "spi" : a.owner] -
      OWNER_RANK[b.owner === "template" ? "spi" : b.owner] ||
    REACH_RANK[a.reach] - REACH_RANK[b.reach] ||
    severityRank(a.severity) - severityRank(b.severity) ||
    b.count - a.count ||
    a.name.localeCompare(b.name)
  );
}

function tally(groups: readonly AlertGroup[], keep: (g: AlertGroup) => boolean): Tally {
  const out: Tally = { ours: 0, upstream: 0 };
  for (const g of groups) {
    if (!keep(g)) continue;
    out[g.owner === "upstream" ? "upstream" : "ours"] += severeCount(g.counts);
  }
  return out;
}

// The words a fork's name takes in a title, so one change across forks reads as one.
function nameTokens(fork: ServiceDef | undefined): string[] {
  if (!fork) return [];
  const tail = fork.upstream.split("/").pop();
  return [...new Set([fork.id, fork.prefix, tail].filter((t): t is string => !!t))].sort(
    (a, b) => b.length - a.length,
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function titleShape(title: string, fork: ServiceDef | undefined): string {
  let out = title.toLowerCase().trim();
  for (const t of nameTokens(fork)) {
    out = out.replace(new RegExp(`\\b${escapeRe(t.toLowerCase())}\\b( service)?`, "g"), "<svc>");
  }
  return out;
}

interface RowInput {
  repo: string;
  name: string;
  group: RepoRow["group"];
  fork?: ServiceDef;
  fact?: RepoFact;
  alerts?: RepoAlerts;
  paths: Paths;
}

function buildRow(input: RowInput): RepoRow {
  const { fact, alerts, paths } = input;
  const issues: RepoRow["issues"] = { bug: [], enhancement: [], other: [], automation: [] };
  for (const issue of fact?.issues ?? []) issues[issueKind(issue)].push(issue);
  const deps = alerts?.dependabot;
  const groups = [
    ...(deps ? dependencyGroups(deps, paths) : []),
    ...(alerts?.code ? codeGroups(alerts.code, paths) : []),
  ];
  const changes: ChangePr[] = [];
  const dependabot: DependencyPr[] = [];
  let pipeline = 0;
  for (const pr of fact?.prs ?? []) {
    const kind = prKind(pr);
    if (kind === "pipeline") {
      pipeline++;
      continue;
    }
    if (kind === "bots") {
      const bump = parseBump(pr.title);
      const dir = bump?.dir ?? "";
      const probe = `${dir ? `${dir}/` : ""}manifest`;
      const matched = bump
        ? groups.filter(
            (g) =>
              g.source === "dependabot" &&
              dirOf(g.where) === dir &&
              g.name.toLowerCase() === bump.package.toLowerCase(),
          )
        : [];
      for (const g of matched) g.pr = pr.number;
      dependabot.push({
        pr,
        ...(bump ? { package: bump.package, from: bump.from, to: bump.to } : {}),
        dir,
        owner: ownerOf(probe, paths),
        reach: reachOf(probe),
        state: prState(pr),
        closes: matched.reduce((n, g) => n + g.count, 0),
      });
      continue;
    }
    const cc = conventional(pr.title);
    changes.push({
      pr,
      type: cc.type,
      kind: changeKind(cc.type),
      breaking: cc.breaking,
      subject: cc.subject,
      state: prState(pr),
      outsider: outsider(pr),
      elsewhere: [],
    });
  }
  groups.sort(groupRank);
  return {
    repo: input.repo,
    name: input.name,
    group: input.group,
    url: fact?.url ?? `https://github.com/${input.repo}`,
    changes,
    dependabot,
    pipeline,
    issues,
    alerts: groups,
    ...(deps ? { dependabotAlerts: deps.length } : {}),
    ...(alerts?.code ? { codeAlerts: alerts.code.length } : {}),
    ...(deps
      ? {
          vulnerabilities: tally(groups, (g) => g.source === "dependabot" && g.reach === "shipped"),
        }
      : {}),
    ...(alerts?.code
      ? { codeScanning: tally(groups, (g) => g.source === "code" && g.reach === "shipped") }
      : {}),
    unreadPrs: Math.max(0, (fact?.openPrs ?? 0) - (fact?.prs.length ?? 0)),
    unreadIssues: Math.max(0, (fact?.openIssues ?? 0) - (fact?.issues.length ?? 0)),
  };
}

function link(rows: readonly RepoRow[], forks: ReadonlyMap<string, ServiceDef>): void {
  const shapes = new Map<string, string[]>();
  for (const r of rows) {
    for (const c of r.changes) {
      const shape = titleShape(c.pr.title, forks.get(r.repo));
      shapes.set(shape, [...(shapes.get(shape) ?? []), r.name]);
    }
  }
  for (const r of rows) {
    for (const c of r.changes) {
      const shape = titleShape(c.pr.title, forks.get(r.repo));
      c.elsewhere = (shapes.get(shape) ?? []).filter((n) => n !== r.name);
    }
  }
  const ours = new Map<string, Set<string>>();
  const keyOf = (g: AlertGroup) =>
    g.source === "dependabot" ? `dep:${g.name.toLowerCase()}` : `code:${g.tool}:${g.name}`;
  for (const r of rows) {
    for (const g of r.alerts) {
      if (g.owner === "upstream") continue;
      const set = ours.get(keyOf(g)) ?? new Set<string>();
      set.add(r.name);
      ours.set(keyOf(g), set);
    }
  }
  for (const r of rows) {
    for (const g of r.alerts) {
      if (g.owner === "upstream") continue;
      g.elsewhere = [...(ours.get(keyOf(g)) ?? [])].filter((n) => n !== r.name);
    }
  }
}

// Every open PR, issue and alert per repository, sorted by who can fix it.
export function buildRepos(input: {
  repos: Record<string, RepoFact>;
  alerts: Measured<Record<string, RepoAlerts>>;
  filters?: RadarFacts["filters"];
  synced?: SyncedPaths;
}): ReposModel {
  const alerts = input.alerts.data;
  const program = (repo: string, name: string): RepoRow =>
    buildRow({
      repo,
      name,
      group: "program",
      fact: input.repos[repo],
      alerts: alerts?.[repo],
      paths: { owned: [], program: true },
    });
  const forkMap = new Map(FORKS.map((f) => [f.repo, f] as const));
  const rows = [
    program(TEMPLATE_REPO, TEMPLATE_REPO.split("/")[1] as string),
    program(STACK_REPO, STACK_REPO.split("/")[1] as string),
    ...FORKS.map((f) => {
      const text = input.filters?.[f.id]?.text;
      const owned = text
        ? forkOwned(parseFilter(text))
        : [`provider/${f.prefix ?? f.id}-azure`, `testing/${f.prefix ?? f.id}-test-azure`];
      return buildRow({
        repo: f.repo,
        name: f.id,
        group: "fork",
        fork: f,
        fact: input.repos[f.repo],
        alerts: alerts?.[f.repo],
        paths: { owned, ...(input.synced ? { synced: input.synced } : {}), program: false },
      });
    }),
  ];
  link(rows, forkMap);
  return { ...(input.alerts.at ? { alertsAt: input.alerts.at } : {}), rows };
}
