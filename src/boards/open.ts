// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, CanvasTone } from "@keelson/shared";
import { githubUrl } from "../config.ts";
import type { IssueFact, PrFact } from "../facts.ts";
import { classifyPr } from "../model/attribution.ts";
import { type IssueKind, issueKind, outsider, type WorkRow } from "../model/work.ts";
import { plural, since } from "../util.ts";
import { LIST_AT } from "./fold.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

// One row of an open list, with what ranks it and the word that counts it once folded.
export interface OpenEntry {
  row: Row;
  at: string;
  first: boolean;
  kind: string;
  pr: boolean;
}

const KIND_ORDER = [
  "outside PR",
  "Dependabot PR",
  "bug",
  "release PR",
  "agent PR",
  "env bump PR",
  "PR",
  "enhancement",
  "issue",
  "automation issue",
];

const ISSUE_CHIP: Record<IssueKind, { label: string; tone: CanvasTone }> = {
  bug: { label: "bug", tone: "warn" },
  enhancement: { label: "enhancement", tone: "neutral" },
  other: { label: "issue", tone: "neutral" },
  automation: { label: "automation", tone: "info" },
};

const ISSUE_WORD: Record<IssueKind, string> = {
  bug: "bug",
  enhancement: "enhancement",
  other: "issue",
  automation: "automation issue",
};

const REVIEW: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

export function issueEntries(row: WorkRow, now: Date): OpenEntry[] {
  const issues = [
    ...row.issues.bug,
    ...row.issues.enhancement,
    ...row.issues.other,
    ...row.issues.automation,
  ];
  return issues.map((i: IssueFact) => {
    const kind = issueKind(i);
    return {
      row: {
        chip: ISSUE_CHIP[kind],
        text: `#${i.number} ${i.title}`,
        trailing: [i.author, since(i.createdAt, now)].filter(Boolean).join(" · "),
        href: i.url,
      },
      at: i.createdAt,
      first: kind === "bug",
      kind: ISSUE_WORD[kind],
      pr: false,
    };
  });
}

// Outside PRs, Dependabot and bugs lead, newest first; the rest fold into one counted, linked row.
export function foldList(
  repo: string,
  entries: readonly OpenEntry[],
  unread: { prs: number; issues: number },
): Row[] {
  const sorted = [...entries].sort(
    (a, b) => Number(b.first) - Number(a.first) || Date.parse(b.at) - Date.parse(a.at),
  );
  const past = unread.prs + unread.issues;
  if (sorted.length <= LIST_AT && past === 0) return sorted.map((e) => e.row);
  const shown = sorted.slice(0, LIST_AT);
  const rest = sorted.slice(LIST_AT);
  const counts = KIND_ORDER.map((k) => [k, rest.filter((e) => e.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => plural(n, k));
  if (past > 0) counts.push(`${past} past the page`);
  const prs = unread.prs > 0 || rest.some((e) => e.pr);
  const issues = unread.issues > 0 || rest.some((e) => !e.pr);
  const href =
    prs && issues
      ? githubUrl(repo, `/issues?q=${encodeURIComponent("is:open")}`)
      : githubUrl(repo, prs ? "/pulls" : "/issues");
  return [
    ...shown.map((e) => e.row),
    { icon: "↗", text: `and ${counts.join(", ")}`, trailing: "open on GitHub", href },
  ];
}

function prChip(pr: PrFact): { label: string; tone: CanvasTone; kind: string } {
  const cls = classifyPr(pr);
  if (cls === "dependabot") return { label: "Dependabot", tone: "neutral", kind: "Dependabot PR" };
  if (cls === "bump") return { label: "env bump", tone: "neutral", kind: "env bump PR" };
  if (cls === "agent") return { label: "agent", tone: "neutral", kind: "agent PR" };
  if (cls === "human" && outsider(pr))
    return { label: "outside", tone: "info", kind: "outside PR" };
  return { label: "feature", tone: "neutral", kind: "PR" };
}

// The stack's own PRs; its release PR has a row of its own.
export function stackOpen(
  row: WorkRow,
  now: Date,
  waitsApproval: ReadonlySet<number> = new Set(),
): Section | undefined {
  if (!row.read) return undefined;
  const prs = [...row.prs.people, ...row.prs.bots, ...row.prs.pipeline].filter(
    (p) => classifyPr(p) !== "release",
  );
  const prEntries: OpenEntry[] = prs.map((p) => {
    const { kind, ...chip } = prChip(p);
    return {
      row: {
        chip,
        text: `#${p.number} ${p.title}`,
        trailing: [
          p.author,
          waitsApproval.has(p.number)
            ? "waits approval"
            : p.draft
              ? "draft"
              : p.reviewDecision
                ? REVIEW[p.reviewDecision]
                : undefined,
          since(p.createdAt, now),
        ]
          .filter(Boolean)
          .join(" · "),
        href: p.url,
      },
      at: p.createdAt,
      first: kind === "outside PR" || kind === "Dependabot PR",
      kind,
      pr: true,
    };
  });
  const items = foldList(row.repo, [...prEntries, ...issueEntries(row, now)], {
    prs: row.unreadPrs,
    issues: row.unreadIssues,
  });
  if (items.length === 0) return undefined;
  const issues = Object.values(row.issues).reduce((n, list) => n + list.length, 0);
  return { kind: "rows", title: openTitle(row.name, prs.length, issues), items };
}

export function openTitle(repo: string, prs: number, issues: number): string {
  return [
    `Open on ${repo}`,
    prs ? plural(prs, "PR") : undefined,
    issues ? plural(issues, "issue") : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
