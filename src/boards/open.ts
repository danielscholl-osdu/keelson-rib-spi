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

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

// Past this many, a list ends in one row that opens the rest on GitHub.
const LIST_AT = 10;

const ISSUE_CHIP: Record<IssueKind, { label: string; tone: CanvasTone }> = {
  bug: { label: "bug", tone: "warn" },
  enhancement: { label: "enhancement", tone: "neutral" },
  other: { label: "issue", tone: "neutral" },
  automation: { label: "automation", tone: "info" },
};

const REVIEW: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
};

function more(n: number, noun: string, href: string): Row {
  return { icon: "↗", text: `${plural(n, noun)} more on GitHub`, href };
}

export function issueItems(row: WorkRow, now: Date): Row[] {
  const issues = [
    ...row.issues.bug,
    ...row.issues.enhancement,
    ...row.issues.other,
    ...row.issues.automation,
  ];
  const items: Row[] = issues.slice(0, LIST_AT).map((i: IssueFact) => ({
    chip: ISSUE_CHIP[issueKind(i)],
    text: `#${i.number} ${i.title}`,
    trailing: [i.author, since(i.createdAt, now)].filter(Boolean).join(" · "),
    href: i.url,
  }));
  const rest = issues.length - items.length + row.unreadIssues;
  return rest > 0 ? [...items, more(rest, "issue", githubUrl(row.repo, "/issues"))] : items;
}

function prChip(pr: PrFact): { label: string; tone: CanvasTone } {
  const cls = classifyPr(pr);
  if (cls === "dependabot") return { label: "Dependabot", tone: "neutral" };
  if (cls === "bump") return { label: "env bump", tone: "neutral" };
  if (cls === "agent") return { label: "agent", tone: "neutral" };
  if (cls === "human" && outsider(pr)) return { label: "outside", tone: "info" };
  return { label: "feature", tone: "neutral" };
}

// The stack's own PRs; its release PR has a row of its own.
export function stackOpen(row: WorkRow, now: Date): Section | undefined {
  if (!row.read) return undefined;
  const prs = [...row.prs.people, ...row.prs.bots, ...row.prs.pipeline].filter(
    (p) => classifyPr(p) !== "release",
  );
  const prItems: Row[] = prs.slice(0, LIST_AT).map((p) => ({
    chip: prChip(p),
    text: `#${p.number} ${p.title}`,
    trailing: [
      p.author,
      p.draft ? "draft" : p.reviewDecision ? REVIEW[p.reviewDecision] : undefined,
      since(p.createdAt, now),
    ]
      .filter(Boolean)
      .join(" · "),
    href: p.url,
  }));
  const restPrs = prs.length - prItems.length + row.unreadPrs;
  const items = [
    ...prItems,
    ...(restPrs > 0 ? [more(restPrs, "PR", githubUrl(row.repo, "/pulls"))] : []),
    ...issueItems(row, now),
  ];
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
