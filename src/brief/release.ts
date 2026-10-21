// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { githubUrl } from "../config.ts";
import {
  type ChangeType,
  type Component,
  type ComponentKind,
  type LibShare,
  type MonthFacts,
  shortDate,
} from "../model/releases.ts";
import type { Notes, NotesRead } from "../notes/file.ts";
import { plural } from "../util.ts";

export const RELEASE_PREFIX = "release:";

export type NotesState = "approved" | "draft" | "none" | "invalid";

export interface DocStat {
  figure: string;
  short: string;
  label: string;
  tone?: "bad";
  anchor: string;
}

export interface DocAction {
  level: "required" | "recommended" | "info";
  title: string;
  body?: string;
  owner?: string;
  when?: string;
  ifSkipped?: string;
}

export type DocVisual =
  | { kind: "coverage"; tiles: { id: string; version: string; fresh: boolean }[] }
  | { kind: "library"; shares: LibShare[] }
  | { kind: "commands" | "steps"; items: { text: string; sub?: string }[] };

export interface DocHighlight {
  title: string;
  body?: string;
  visual?: DocVisual;
}

export interface DocArea {
  area: string;
  items: { type: ChangeType; text: string }[];
}

export interface DocChip {
  id: string;
  from?: string;
  to: string;
  platform: boolean;
}

export interface DocRow {
  id: string;
  group: "Services" | "Platform";
  version: string;
  from?: string;
  to?: string;
  releases: number;
  upstream?: string;
  lib?: string | null;
  java?: string | null;
  state: "released" | "unreleased";
  url?: string;
}

export interface ReleaseDoc {
  id: string;
  month: string;
  name: string;
  open: boolean;
  stateText: string;
  eyebrow: string[];
  notes: NotesState;
  notesError?: string;
  headline: string;
  stats: DocStat[];
  keyChanges: string[];
  required: DocAction[];
  info: DocAction[];
  highlights: DocHighlight[];
  issues: { state: "open" | "resolved"; title: string; body?: string }[];
  openIssues: number;
  changelog: DocArea[];
  computedChangelog: boolean;
  deps: number;
  chips: DocChip[];
  rows: DocRow[];
  unchanged: string[];
  links: { label: string; url: string }[];
  unread: string[];
  built: string;
}

const AREA: Record<ComponentKind, string> = {
  service: "Services",
  library: "Library",
  stack: "Environment",
  template: "Engineering system",
};

const AREA_ORDER = ["Services", "Library", "Environment", "Engineering system"];

function notesOf(read: NotesRead | undefined): Notes | undefined {
  return read?.state === "ok" ? read.notes : undefined;
}

// Template changes reach fork maintainers, not consumers, so they fold into one line.
function computedChangelog(f: MonthFacts): DocArea[] {
  const areas = new Map<string, DocArea["items"]>();
  const add = (area: string, item: DocArea["items"][number]) =>
    areas.set(area, [...(areas.get(area) ?? []), item]);
  const internal = (c: MonthFacts["changes"][number]) =>
    c.kind === "template" && c.type !== "breaking" && c.type !== "security";
  for (const c of f.changes) {
    if (internal(c)) continue;
    const text =
      c.kind === "service" && !c.text.startsWith(c.component)
        ? `${c.component}: ${c.text}`
        : c.text;
    add(AREA[c.kind], { type: c.type, text });
  }
  const template = f.components.find((c) => c.kind === "template");
  const folded = f.changes.filter(internal).length;
  if (template?.to && folded > 0) {
    add(AREA.template, {
      type: "improved",
      text: `${template.id} ${template.from ? `${template.from} to ` : ""}${template.to}: ${plural(folded, "change")} to fork automation, listed in the template's release notes`,
    });
  }
  return AREA_ORDER.filter((a) => areas.has(a)).map((area) => ({
    area,
    items: areas.get(area) ?? [],
  }));
}

function computedHeadline(f: MonthFacts): string {
  if (f.releases === 0) return `No SPI releases ${f.open ? "yet " : ""}in ${f.label}.`;
  return `${plural(f.releases, "release")} across ${plural(f.released, "repository", "repositories")} in ${f.label}.`;
}

function visualOf(
  kind: NonNullable<Notes["highlights"][number]["visual"]>,
  items: { text: string; sub?: string }[] | undefined,
  f: MonthFacts,
): DocVisual | undefined {
  if (kind === "coverage") {
    return {
      kind,
      tiles: f.components
        .filter((c) => c.kind === "service")
        .map((c) => ({
          id: c.id,
          version: c.to ?? "no release",
          fresh: f.services.forkedNow.includes(c.id),
        })),
    };
  }
  if (kind === "library") return f.libs.length > 0 ? { kind, shares: f.libs } : undefined;
  return items && items.length > 0 ? { kind, items } : undefined;
}

function manifestRow(c: Component): DocRow {
  return {
    id: c.id,
    group: c.kind === "service" ? "Services" : "Platform",
    version: c.to ? (c.count > 0 ? `${c.from ?? "new"} → ${c.to}` : c.to) : "no release",
    ...(c.count > 0 && c.from ? { from: c.from } : {}),
    ...(c.count > 0 && c.to ? { to: c.to } : {}),
    releases: c.count,
    ...(c.upstream ? { upstream: c.upstream } : {}),
    ...(c.kind === "service" && c.to
      ? { lib: c.pins?.lib ?? null, java: c.pins?.java ?? null }
      : {}),
    state: c.to ? "released" : "unreleased",
    ...(c.to ? { url: tagUrl(c.repo, c.to) } : {}),
  };
}

function tagUrl(repo: string, tag: string): string {
  return githubUrl(repo, `/releases/tag/${encodeURIComponent(tag)}`);
}

function stateText(f: MonthFacts): string {
  const close = shortDate(new Date(Date.parse(f.end) - 1));
  return f.open ? `In progress, closes ${close}` : `Closed ${close}`;
}

// The month's document: computed facts with the reviewed notes laid over them.
export function releaseDoc(f: MonthFacts, read: NotesRead | undefined, now: Date): ReleaseDoc {
  const n = notesOf(read);
  const notes: NotesState =
    read?.state === "invalid"
      ? "invalid"
      : !n
        ? "none"
        : n.status === "approved"
          ? "approved"
          : "draft";
  const breaking: DocAction[] = f.changes
    .filter((c) => c.type === "breaking")
    .map((c) => ({
      level: "recommended",
      title: `${c.component} ${c.tag}: ${c.text}`,
      body: "A breaking change. Check it before taking this version.",
    }));
  const actions: DocAction[] = n && n.actions.length > 0 ? n.actions : breaking;
  const required = actions.filter((a) => a.level !== "info");
  const issues = n?.knownIssues ?? [];
  const openIssues = issues.filter((i) => i.state === "open").length;
  const services = f.services;
  const mustDo = actions.filter((a) => a.level === "required").length;
  const word = (k: number, one: string, many = `${one}s`) => (k === 1 ? one : many);
  const stats: DocStat[] = [
    {
      figure: `${services.shipping}/${services.total}`,
      short: "Services released",
      label: `services released from SPI forks${services.forkedNow.length > 0 ? `, ${services.forkedNow.length} forked this month` : ""}`,
      anchor: "components",
    },
    {
      short: "Releases",
      figure: String(f.releases),
      label: `${word(f.releases, "release")} across ${plural(f.released, "repository", "repositories")}`,
      anchor: "components",
    },
    {
      short: "Required actions",
      figure: n ? String(mustDo) : "?",
      label: !n
        ? "actions not reviewed yet"
        : mustDo > 0
          ? word(mustDo, "required action")
          : "no action required",
      ...(mustDo > 0 ? { tone: "bad" as const } : {}),
      anchor: "action",
    },
    {
      short: "Open issues",
      figure: n ? String(openIssues) : "?",
      label: n ? `open known ${word(openIssues, "issue")}` : "known issues not reviewed yet",
      anchor: "issues",
    },
  ];
  const highlights: DocHighlight[] = (n?.highlights ?? []).map((h) => {
    const visual = h.visual ? visualOf(h.visual, h.items, f) : undefined;
    return { title: h.title, ...(h.body ? { body: h.body } : {}), ...(visual ? { visual } : {}) };
  });
  const comps = f.components;
  const chips: DocChip[] = comps
    .filter((c) => c.count > 0 && c.to)
    .map((c) => ({
      id: c.id,
      ...(c.from ? { from: c.from } : {}),
      to: c.to as string,
      platform: c.kind !== "service",
    }))
    .sort((a, b) => Number(b.platform) - Number(a.platform));
  const rows = [
    ...comps.filter((c) => c.kind === "service"),
    ...comps.filter((c) => c.kind !== "service"),
  ].map(manifestRow);
  const eyebrow = [
    f.label,
    f.through,
    ...(f.stack ? [`spi-stack ${f.stack}`] : []),
    ...(f.template ? [`spi-template ${f.template}`] : []),
  ];
  return {
    id: `${RELEASE_PREFIX}${f.month}`,
    month: f.month,
    name: f.name,
    open: f.open,
    stateText: stateText(f),
    eyebrow,
    notes,
    ...(read?.state === "invalid" ? { notesError: read.error } : {}),
    headline: n?.headline.trim() || computedHeadline(f),
    stats,
    keyChanges: n?.keyChanges ?? [],
    required,
    info: actions.filter((a) => a.level === "info"),
    highlights,
    issues,
    openIssues,
    changelog: n?.changelog ?? computedChangelog(f),
    computedChangelog: !n?.changelog,
    deps: f.deps,
    chips,
    rows,
    unchanged: comps
      .filter((c) => c.kind !== "service" && c.count === 0 && c.to)
      .map((c) => `${c.id} ${c.to}`),
    links: comps
      .filter((c) => c.to)
      .map((c) => ({ label: c.id, url: githubUrl(c.repo, "/releases") })),
    unread: f.unread,
    built: `${shortDate(now)}, ${now.getUTCFullYear()}`,
  };
}

export interface ReleaseLine {
  id: string;
  month: string;
  name: string;
  open: boolean;
  stateText: string;
  notes: NotesState;
  headline: string;
  stats: DocStat[];
  keyChanges: string[];
}

export function releaseLine(d: ReleaseDoc): ReleaseLine {
  return {
    id: d.id,
    month: d.month,
    name: d.name,
    open: d.open,
    stateText: d.stateText,
    notes: d.notes,
    headline: d.headline,
    stats: d.stats,
    keyChanges: d.keyChanges,
  };
}

export const NOTES_LABEL: Record<NotesState, string> = {
  approved: "Approved",
  draft: "Draft",
  none: "No notes yet",
  invalid: "Notes file invalid",
};
