// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Severity } from "../facts.ts";
import type { Model } from "../model/index.ts";
import type {
  AlertGroup,
  ChangePr,
  DependencyPr,
  Owner,
  PrState,
  RepoRow,
  Tally,
} from "../model/repos.ts";
import { age, plural } from "../util.ts";
import type { BriefFact, Tone } from "./index.ts";

export const REPO_PREFIX = "repo:";
const SECTION_MAX = 3;

export interface RepoCell {
  text: string;
  tone: Tone;
}

export interface RepoLine {
  tag: string;
  tone: Tone;
  text: string;
  sub: string;
}

export interface RepoSection {
  title: string;
  count: string;
  lines: RepoLine[];
}

export interface RepoEntry {
  id: string;
  name: string;
  group: RepoRow["group"];
  cells: {
    changes: RepoCell;
    dependabot: RepoCell;
    issues: RepoCell;
    vulnerabilities: RepoCell;
    codeScanning: RepoCell;
  };
  title: string;
  tone: Tone;
  sub: string;
  sections: RepoSection[];
  note?: string;
}

export interface Repositories {
  headline: string;
  facts: BriefFact[];
  rows: RepoEntry[];
  // The row the tab opens on.
  first?: string;
}

const OWNER_WORD: Record<Owner, string> = {
  spi: "SPI",
  template: "Template",
  upstream: "Upstream",
};
const SEVERITY_WORD: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "neutral",
};
const STATE_TONE: Record<PrState, Tone> = {
  draft: "neutral",
  conflicts: "bad",
  red: "bad",
  "changes requested": "warn",
  "needs review": "warn",
  behind: "neutral",
  running: "neutral",
  ready: "ok",
};

// How a count of PRs reads in one state.
const STATE_PHRASE: Record<PrState, string> = {
  draft: "drafts",
  conflicts: "with conflicts",
  red: "with red checks",
  "changes requested": "with changes requested",
  "needs review": "waiting on review",
  behind: "behind main",
  running: "running checks",
  ready: "ready",
};

function list(items: readonly string[], max = 3): string {
  if (items.length <= max) {
    return items.length < 2
      ? (items[0] ?? "")
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A Maven coordinate reads by its artifact.
export function shortPackage(name: string): string {
  return name.includes(":") ? (name.split(":").pop() ?? name) : name;
}

function severe(g: AlertGroup): boolean {
  return g.severity === "critical" || g.severity === "high";
}

function ours(g: AlertGroup): boolean {
  return g.owner !== "upstream";
}

function severeCount(g: AlertGroup): number {
  return (g.counts.critical ?? 0) + (g.counts.high ?? 0);
}

// Dependabot alerts are vulnerabilities in a library; code scanning flags the source itself.
export const KIND_LABEL: Record<AlertGroup["source"], string> = {
  dependabot: "Vulnerabilities",
  code: "Code scanning",
};

function counted(g: AlertGroup, n = g.count): string {
  return g.source === "dependabot"
    ? plural(n, "vulnerability", "vulnerabilities")
    : plural(n, "alert");
}

// "Critical vulnerability in async-http-client", "High code-scanning alert: Log Injection".
export function alertTitle(g: AlertGroup): string {
  const sev = g.severity ? SEVERITY_WORD[g.severity] : "Open";
  return g.source === "dependabot"
    ? `${sev} vulnerability in ${groupName(g)}`
    : `${sev} code-scanning alert: ${g.name}`;
}

export function groupName(g: AlertGroup): string {
  return g.source === "dependabot" ? shortPackage(g.name) : g.name;
}

function whereText(g: AlertGroup): string {
  return g.where || "repository settings";
}

export function fixText(g: AlertGroup): string {
  if (g.source === "code") return `found by ${g.tool || "code scanning"}`;
  const fix = g.fix ? `fixed in ${g.fix}` : "no fix published";
  return g.pr ? `${fix} · Dependabot PR #${g.pr} open` : fix;
}

export function alertLine(g: AlertGroup): RepoLine {
  const sub = [
    OWNER_WORD[g.owner],
    g.reach,
    whereText(g),
    fixText(g),
    g.elsewhere.length > 0 ? `also ours on ${list(g.elsewhere)}` : undefined,
  ].filter(Boolean);
  return {
    tag: g.severity ? SEVERITY_WORD[g.severity] : "Note",
    tone: g.severity ? SEVERITY_TONE[g.severity] : "neutral",
    text: `${groupName(g)} · ${counted(g)}`,
    sub: sub.join(" · "),
  };
}

export function changeLine(c: ChangePr, now: Date): RepoLine {
  const sub = [
    c.state,
    age(c.pr.createdAt, now) ? `opened ${age(c.pr.createdAt, now)} ago` : undefined,
    c.pr.author ? `by ${c.pr.author}` : undefined,
    c.outsider ? "outside contributor" : undefined,
    c.elsewhere.length > 0 ? `also open on ${list(c.elsewhere)}` : undefined,
  ].filter(Boolean);
  return {
    tag: `${c.type || "untyped"}${c.breaking ? "!" : ""}`,
    tone: STATE_TONE[c.state],
    text: `${c.subject} · #${c.pr.number}`,
    sub: sub.join(" · "),
  };
}

export function dependencyLine(d: DependencyPr): RepoLine {
  const text = d.package
    ? `${shortPackage(d.package)} ${d.from} to ${d.to} · #${d.pr.number}`
    : `${d.pr.title} · #${d.pr.number}`;
  const sub = [
    d.state,
    `${OWNER_WORD[d.owner]} ${d.reach}`,
    d.dir ? `/${d.dir}` : "root",
    d.closes > 0 ? `closes ${plural(d.closes, "vulnerability", "vulnerabilities")}` : undefined,
    d.owner === "upstream" ? "diverges from upstream" : undefined,
  ].filter(Boolean);
  return { tag: "deps", tone: STATE_TONE[d.state], text, sub: sub.join(" · ") };
}

function issueCount(r: RepoRow): number {
  return Object.values(r.issues).reduce((n, list) => n + list.length, 0);
}

function countCell(n: number, unread: number, tone: Tone = "neutral"): RepoCell {
  return { text: unread > 0 ? `${n}+` : String(n), tone: n === 0 ? "neutral" : tone };
}

function pairCell(t: Tally | undefined, critical: boolean): RepoCell {
  if (!t) return { text: "?", tone: "neutral" };
  return {
    text: `${t.ours} · ${t.upstream}`,
    tone: critical ? "bad" : t.ours > 0 ? "warn" : "neutral",
  };
}

function criticalOurs(r: RepoRow, source?: AlertGroup["source"]): AlertGroup[] {
  return r.alerts.filter(
    (g) =>
      (!source || g.source === source) &&
      ours(g) &&
      g.reach === "shipped" &&
      g.severity === "critical",
  );
}

function severeOurs(r: RepoRow): number {
  return (r.vulnerabilities?.ours ?? 0) + (r.codeScanning?.ours ?? 0);
}

function lead(r: RepoRow, now: Date): { title: string; sub: string; tone: Tone } {
  const top = r.alerts.find((g) => ours(g) && g.reach === "shipped" && severe(g));
  if (top) {
    const owner = top.owner === "template" ? "template-owned" : "SPI-owned";
    return {
      title: alertTitle(top),
      sub: [
        `${cap(counted(top))} in ${owner} shipped code at ${whereText(top)}, ${top.source === "code" ? fixText(top) : top.fix ? `fixed in ${top.fix}` : "no fix published"}.`,
        top.pr ? `Dependabot PR #${top.pr} is open.` : undefined,
        top.elsewhere.length > 0 ? `Also ours on ${list(top.elsewhere)}.` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      tone: SEVERITY_TONE[top.severity as Severity],
    };
  }
  const stuck = r.changes.filter((c) => c.state === "conflicts" || c.state === "red");
  if (stuck.length > 0) {
    return {
      title: `${plural(stuck.length, "change PR")} ${stuck.length === 1 ? "has" : "have"} ${stuck[0]?.state === "red" ? "red checks" : "conflicts"}`,
      sub: stuck.map((c) => `#${c.pr.number} ${c.subject}`).join("; "),
      tone: "warn",
    };
  }
  const waiting = r.changes.filter((c) => c.state === "needs review" || c.state === "ready");
  if (waiting.length > 0) {
    const oldest = waiting.reduce((a, c) => (c.pr.createdAt < a.pr.createdAt ? c : a));
    const since = age(oldest.pr.createdAt, now);
    return {
      title: `${plural(waiting.length, "change PR")} waiting on review`,
      sub: `Oldest is #${oldest.pr.number} ${oldest.subject}${since ? `, open ${since}` : ""}.`,
      tone: "neutral",
    };
  }
  const inherited = r.alerts.find(
    (g) => g.owner === "upstream" && g.reach === "shipped" && severe(g),
  );
  if (inherited) {
    return {
      title: `${alertTitle(inherited)}, from upstream`,
      sub: `${cap(counted(inherited))} at ${whereText(inherited)}${inherited.fix ? `, fixed in ${inherited.fix}` : ""}. The fix arrives with Sync Upstream.`,
      tone: "neutral",
    };
  }
  return {
    title: "Nothing open that is ours to fix",
    sub:
      r.dependabotAlerts === undefined
        ? "Vulnerabilities are not readable here."
        : "No critical or high vulnerability or code-scanning alert in SPI-owned shipped code, and no change PR waiting.",
    tone: "ok",
  };
}

function section(
  title: string,
  lines: RepoLine[],
  total: number,
  count = String(total),
): RepoSection | undefined {
  if (total === 0) return undefined;
  return { title, count, lines: lines.slice(0, SECTION_MAX) };
}

// Ours first, then what ships from upstream; test findings stay in the inspector.
function alertSection(r: RepoRow, source: AlertGroup["source"]): RepoSection | undefined {
  const mine = r.alerts.filter((g) => g.source === source && ours(g) && g.reach !== "tests");
  const inherited = r.alerts.filter(
    (g) => g.source === source && g.owner === "upstream" && g.reach === "shipped",
  );
  const shown = [...mine, ...inherited];
  return section(
    KIND_LABEL[source],
    shown.map(alertLine),
    shown.length,
    `${mine.length} ours · ${inherited.length} upstream`,
  );
}

function entryOf(r: RepoRow, now: Date): RepoEntry {
  const vulns = alertSection(r, "dependabot");
  const code = alertSection(r, "code");
  const shown = (vulns?.lines.length ?? 0) + (code?.lines.length ?? 0);
  const hidden = r.alerts.length - shown;
  const testGroups = r.alerts.filter((g) => g.reach === "tests").length;
  const issues = [...r.issues.bug, ...r.issues.enhancement, ...r.issues.other];
  const automation = r.issues.automation.length;
  const sections = [
    vulns,
    code,
    section(
      "Changes",
      r.changes.map((c) => changeLine(c, now)),
      r.changes.length,
    ),
    section(
      "Dependabot PRs",
      [...r.dependabot].sort((a, b) => b.closes - a.closes).map(dependencyLine),
      r.dependabot.length,
    ),
    section(
      "Issues",
      issues.map((i) => ({
        tag: r.issues.bug.includes(i)
          ? "bug"
          : r.issues.enhancement.includes(i)
            ? "enhancement"
            : "issue",
        tone: "neutral" as Tone,
        text: `${i.title} · #${i.number}`,
        sub: [
          age(i.createdAt, now) ? `opened ${age(i.createdAt, now)} ago` : undefined,
          plural(i.comments, "comment"),
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      issues.length,
    ),
  ].filter((s): s is RepoSection => s !== undefined);
  const notes = [
    hidden > 0
      ? `${plural(hidden, "more alert group")}${testGroups > 0 ? `, ${testGroups} in tests` : ""}`
      : undefined,
    automation > 0 ? `${plural(automation, "sync engine issue")}, already on Today` : undefined,
    r.pipeline > 0 ? `${plural(r.pipeline, "pipeline PR")}, on Flow` : undefined,
  ].filter(Boolean);
  const head = lead(r, now);
  return {
    id: `${REPO_PREFIX}${r.name}`,
    name: r.name,
    group: r.group,
    cells: {
      changes: countCell(r.changes.length, r.unreadPrs),
      dependabot: countCell(r.dependabot.length, r.unreadPrs),
      issues: countCell(issueCount(r), r.unreadIssues),
      vulnerabilities: pairCell(r.vulnerabilities, criticalOurs(r, "dependabot").length > 0),
      codeScanning: pairCell(r.codeScanning, criticalOurs(r, "code").length > 0),
    },
    title: head.title,
    tone: head.tone,
    sub: head.sub,
    sections,
    ...(notes.length > 0
      ? { note: `Not shown here: ${notes.join("; ")}. The inspector lists every item.` }
      : {}),
  };
}

function byType(changes: readonly ChangePr[]): string {
  const counts = new Map<string, number>();
  for (const c of changes)
    counts.set(c.type || "untyped", (counts.get(c.type || "untyped") ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${n} ${t}`)
    .join(" · ");
}

// Critical and high alerts of one kind in SPI-owned shipped code, with what ships from upstream.
function alertFact(rows: readonly RepoRow[], source: AlertGroup["source"]): BriefFact {
  const tally = (r: RepoRow) => (source === "dependabot" ? r.vulnerabilities : r.codeScanning);
  const read = rows.filter((r) => tally(r));
  const label = `${KIND_LABEL[source]} · ours`;
  if (read.length === 0) return { label, figure: "?", sub: "not read yet", tone: "neutral" };
  const groups = rows.flatMap((r) =>
    r.alerts.filter((g) => g.source === source && ours(g) && g.reach === "shipped" && severe(g)),
  );
  const count = groups.reduce((n, g) => n + severeCount(g), 0);
  const upstream = read.reduce((n, r) => n + (tally(r)?.upstream ?? 0), 0);
  const names = new Set(groups.map((g) => g.name.toLowerCase())).size;
  const what = source === "dependabot" ? plural(names, "package") : plural(names, "rule");
  return {
    label,
    figure: String(count),
    sub: [
      count > 0
        ? `critical or high in shipped code · ${what}`
        : "no critical or high in shipped code",
      `${upstream} more from upstream`,
      read.length < rows.length ? `${rows.length - read.length} unread` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    tone: groups.some((g) => g.severity === "critical") ? "bad" : count > 0 ? "warn" : "ok",
  };
}

function factsOf(rows: readonly RepoRow[]): BriefFact[] {
  const changes = rows.flatMap((r) => r.changes);
  const blocked = changes.filter((c) => c.state === "conflicts" || c.state === "red").length;
  const deps = rows.flatMap((r) => r.dependabot);
  const depStates = new Map<PrState, number>();
  for (const d of deps) depStates.set(d.state, (depStates.get(d.state) ?? 0) + 1);
  const closing = deps.filter((d) => d.closes > 0).length;
  const issues = rows.flatMap((r) => [...r.issues.bug, ...r.issues.enhancement, ...r.issues.other]);
  const bugs = rows.reduce((n, r) => n + r.issues.bug.length, 0);
  const enh = rows.reduce((n, r) => n + r.issues.enhancement.length, 0);
  const automation = rows.reduce((n, r) => n + r.issues.automation.length, 0);
  return [
    {
      label: "Change PRs",
      figure: String(changes.length),
      sub:
        [byType(changes), blocked > 0 ? `${blocked} with conflicts or red checks` : undefined]
          .filter(Boolean)
          .join(" · ") || "none open",
      tone: blocked > 0 ? "warn" : "neutral",
    },
    {
      label: "Dependabot PRs",
      figure: String(deps.length),
      sub:
        [
          ...[...depStates.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([s, n]) => `${n} ${STATE_PHRASE[s]}`),
          closing > 0 ? `${closing} close vulnerabilities` : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || "none open",
      tone: "neutral",
    },
    {
      label: "Issues",
      figure: String(issues.length + automation),
      sub:
        [
          bugs > 0 ? plural(bugs, "bug") : undefined,
          enh > 0 ? plural(enh, "enhancement") : undefined,
          automation > 0 ? `${automation} from the sync engine` : undefined,
        ]
          .filter(Boolean)
          .join(" · ") || "none open",
      tone: "neutral",
    },
    alertFact(rows, "dependabot"),
    alertFact(rows, "code"),
  ];
}

function headlineOf(rows: readonly RepoRow[]): string {
  const read = rows.filter((r) => r.vulnerabilities || r.codeScanning);
  if (read.length === 0) return "Security alerts have not been read yet.";
  const critical = new Map<string, { g: AlertGroup; repos: string[] }>();
  for (const r of rows) {
    for (const g of criticalOurs(r)) {
      const key = `${g.source}:${g.name.toLowerCase()}`;
      const at = critical.get(key) ?? { g, repos: [] };
      at.repos.push(r.name);
      critical.set(key, at);
    }
  }
  const first = [...critical.values()][0];
  if (first) {
    const fix =
      first.g.source === "code"
        ? ""
        : first.g.fix
          ? `; ${first.g.fix} fixes it`
          : "; no fix is published";
    const more = critical.size > 1 ? ` ${critical.size - 1} more critical in SPI code.` : "";
    return `${alertTitle(first.g)}, in SPI code on ${list(first.repos)}${fix}.${more}`;
  }
  const vulns = rows.reduce((n, r) => n + (r.vulnerabilities?.ours ?? 0), 0);
  const code = rows.reduce((n, r) => n + (r.codeScanning?.ours ?? 0), 0);
  if (vulns + code === 0) {
    return "No critical or high vulnerability or code-scanning alert in SPI-owned shipped code.";
  }
  return `In SPI-owned shipped code: ${[
    vulns > 0 ? `${plural(vulns, "high vulnerability", "high vulnerabilities")}` : undefined,
    code > 0 ? `${plural(code, "high code-scanning alert")}` : undefined,
  ]
    .filter(Boolean)
    .join(" and ")}.`;
}

// Rows that hold something ours open first; otherwise the first row.
function firstOf(entries: readonly RepoEntry[], rows: readonly RepoRow[]): string | undefined {
  const pick =
    rows.find((r) => criticalOurs(r).length > 0) ??
    rows.find((r) => (r.vulnerabilities?.ours ?? 0) > 0) ??
    rows.find((r) => severeOurs(r) > 0) ??
    rows.find((r) => r.changes.some((c) => c.state === "conflicts" || c.state === "red")) ??
    rows[0];
  return entries.find((e) => e.name === pick?.name)?.id;
}

export function repositoriesOf(model: Model, now: Date): Repositories {
  const rows = model.repositories.rows;
  const entries = rows.map((r) => entryOf(r, now));
  const first = firstOf(entries, rows);
  return {
    headline: headlineOf(rows),
    facts: factsOf(rows),
    rows: entries,
    ...(first ? { first } : {}),
  };
}
