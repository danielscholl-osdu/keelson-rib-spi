// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type BuildPins,
  pinKey,
  type ReleaseFact,
  type ReleaseReads,
} from "../collect/releases.ts";
import { CORE_LIB_REPO, FORKS, RELEASE_REPOS, STACK_REPO, TEMPLATE_REPO } from "../config.ts";

export type ComponentKind = "template" | "stack" | "library" | "service";
export type ChangeType = "breaking" | "new" | "improved" | "fixed" | "security";

export interface Component {
  id: string;
  repo: string;
  kind: ComponentKind;
  from?: string;
  to?: string;
  count: number;
  first: boolean;
  created?: string;
  upstream?: string;
  pins?: BuildPins;
}

export interface Change {
  type: ChangeType;
  text: string;
  component: string;
  kind: ComponentKind;
  tag: string;
}

export interface LibShare {
  version: string;
  services: string[];
}

export interface MonthFacts {
  month: string;
  name: string;
  label: string;
  start: string;
  end: string;
  open: boolean;
  through: string;
  components: Component[];
  releases: number;
  released: number;
  services: { total: number; forked: number; shipping: number; forkedNow: string[] };
  stack?: string;
  template?: string;
  libs: LibShare[];
  changes: Change[];
  deps: number;
  unread: string[];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const KIND_OF: Record<string, ComponentKind> = {
  [TEMPLATE_REPO]: "template",
  [STACK_REPO]: "stack",
  [CORE_LIB_REPO]: "library",
};

const ID_OF: Record<string, string> = {
  [TEMPLATE_REPO]: "spi-template",
  [STACK_REPO]: "spi-stack",
  [CORE_LIB_REPO]: "core-lib-azure",
};

export function componentId(repo: string): string {
  return ID_OF[repo] ?? FORKS.find((f) => f.repo === repo)?.id ?? repo;
}

function kindOf(repo: string): ComponentKind {
  return KIND_OF[repo] ?? "service";
}

export function isMonth(text: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function bounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function monthName(month: string): string {
  return month.replace("-", ".");
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

// "Oct 21": a release-notes date, in UTC like the month windows.
export function shortDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]?.slice(0, 3)} ${d.getUTCDate()}`;
}

// Months with a release, newest first, and always the month in progress.
export function releaseMonths(reads: ReleaseReads, now: Date): string[] {
  const set = new Set<string>([monthOf(now.toISOString())]);
  for (const list of Object.values(reads.releases)) for (const r of list) set.add(monthOf(r.at));
  return [...set].sort().reverse();
}

const SECTION_TYPE: Array<[RegExp, ChangeType | undefined]> = [
  [/breaking/i, "breaking"],
  [/feature/i, "new"],
  [/bug ?fix/i, "fixed"],
  [/performance/i, "improved"],
  [/security/i, "security"],
];

const NOISE = [
  /^sync (upstream|template)/i,
  /^generate filtered upstream tree/i,
  /^stamp fork-owned/i,
  /^release\b/i,
  /^initial code$/i,
];

const SECURITY = /\bCVEs?\b|vulnerab|advisor(y|ies)|managed identity|\bsecurity\b/i;
const IMPROVED = /^(improve|upgrade|update|switch|move|speed|reduce|enhance|simplif)/i;

function sectionType(heading: string): ChangeType | undefined {
  for (const [re, type] of SECTION_TYPE) if (re.test(heading)) return type;
  return undefined;
}

// Links, commit refs and PR numbers are for maintainers; consumers read the sentence.
export function plainLine(text: string): string {
  return text
    .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s*\((#\d+[,\s]*)+\)/g, "")
    .replace(/^(\[[^\]]+\]\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BodyLine {
  type: ChangeType;
  text: string;
  scope?: string;
  dep: boolean;
}

// One release-please body into typed lines; sections that do not reach a consumer are dropped.
export function parseBody(body: string): BodyLine[] {
  const out: BodyLine[] = [];
  let type: ChangeType | undefined;
  for (const raw of body.split("\n")) {
    const heading = /^#{2,4}\s+(.*)$/.exec(raw);
    if (heading) {
      type = /^#{3,4}/.test(raw) ? sectionType(heading[1] ?? "") : undefined;
      continue;
    }
    if (!type) continue;
    const item = /^\s{0,1}[*-]\s+(?:\*\*([^*]+?):?\*\*:?\s*)?(.+)$/.exec(raw);
    if (!item) continue;
    const scope = item[1]?.trim();
    const text = plainLine(item[2] ?? "");
    if (!text || NOISE.some((re) => re.test(text))) continue;
    const dep = scope === "deps" || /^bump\b/i.test(text);
    let t = type;
    if (SECURITY.test(text) && t !== "breaking") t = "security";
    else if (t === "new" && IMPROVED.test(text)) t = "improved";
    out.push({ type: t, text, dep, ...(scope ? { scope } : {}) });
  }
  return out;
}

export function upstreamOf(body: string): string | undefined {
  return (
    /Correlation Tag:\s*\S*?-upstream-(\S+)/.exec(body)?.[1] ??
    /Upstream Version:\s*(\S+)/.exec(body)?.[1]
  );
}

function before(list: readonly ReleaseFact[], at: Date): ReleaseFact[] {
  return list.filter((r) => Date.parse(r.at) < at.getTime());
}

function firstLine(c: Component, tag: string): string {
  if (c.kind === "library")
    return `First core-lib-azure release built and published from GitHub (${tag})`;
  if (c.kind === "service") return `${c.id} forked and released as ${tag}`;
  return `First ${c.id} release (${tag})`;
}

export function monthFacts(reads: ReleaseReads, month: string, now: Date): MonthFacts {
  const { start, end } = bounds(month);
  const open = now.getTime() < end.getTime();
  const last = new Date(Math.min(now.getTime(), end.getTime() - 1));
  const changes: Change[] = [];
  const seen = new Set<string>();
  let deps = 0;
  const components: Component[] = [];

  for (const repo of RELEASE_REPOS) {
    const list = reads.releases[repo] ?? [];
    const created = reads.created[repo];
    if (created && Date.parse(created) >= end.getTime()) continue;
    if (!created && list.length === 0) continue;
    const prior = before(list, start);
    const upTo = before(list, end);
    const within = upTo.filter((r) => Date.parse(r.at) >= start.getTime());
    const latest = upTo[0];
    const kind = kindOf(repo);
    const c: Component = {
      id: componentId(repo),
      repo,
      kind,
      count: within.length,
      first: prior.length === 0 && within.length > 0,
      ...(prior[0] ? { from: prior[0].tag } : {}),
      ...(latest ? { to: latest.tag } : {}),
      ...(created ? { created } : {}),
    };
    const up = latest ? upstreamOf(latest.body) : undefined;
    if (up) c.upstream = up;
    if (kind === "service" && latest) {
      const pins = reads.pins[pinKey(repo, latest.tag)];
      if (pins) c.pins = pins;
    }
    components.push(c);

    const oldestFirst = [...within].reverse();
    oldestFirst.forEach((r, i) => {
      if (c.first && i === 0) {
        changes.push({ type: "new", text: firstLine(c, r.tag), component: c.id, kind, tag: r.tag });
        return;
      }
      for (const line of parseBody(r.body)) {
        if (line.dep && line.type !== "security" && line.type !== "breaking") {
          deps++;
          continue;
        }
        const key = `${c.id}:${line.text.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        changes.push({ type: line.type, text: line.text, component: c.id, kind, tag: r.tag });
      }
    });
  }

  const services = components.filter((c) => c.kind === "service");
  const libs = new Map<string, string[]>();
  for (const s of services) {
    if (!s.to) continue;
    const v = s.pins?.lib ?? "?";
    libs.set(v, [...(libs.get(v) ?? []), s.id]);
  }
  const unread = RELEASE_REPOS.filter((r) => reads.errors[r]).map(componentId);
  const stack = components.find((c) => c.kind === "stack")?.to;
  const template = components.find((c) => c.kind === "template")?.to;
  return {
    month,
    name: monthName(month),
    label: monthLabel(month),
    start: start.toISOString(),
    end: end.toISOString(),
    open,
    through: open
      ? `${shortDate(start)} to ${last.getUTCDate()}`
      : `${shortDate(start)} to ${new Date(end.getTime() - 1).getUTCDate()}`,
    components,
    releases: components.reduce((n, c) => n + c.count, 0),
    released: components.filter((c) => c.count > 0).length,
    services: {
      total: FORKS.length,
      forked: services.length,
      shipping: services.filter((s) => !!s.to).length,
      forkedNow: services.filter((s) => s.created && monthOf(s.created) === month).map((s) => s.id),
    },
    ...(stack ? { stack } : {}),
    ...(template ? { template } : {}),
    libs: [...libs.entries()]
      .map(([version, ids]) => ({ version, services: ids }))
      .sort((a, b) => compareVersions(b.version, a.version)),
    changes,
    deps,
    unread,
  };
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((p) => Number.parseInt(p, 10));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d =
      (Number.isNaN(x[i] ?? 0) ? -1 : (x[i] ?? 0)) - (Number.isNaN(y[i] ?? 0) ? -1 : (y[i] ?? 0));
    if (d !== 0) return d;
  }
  return 0;
}
