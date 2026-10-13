// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { FORKS, STACK_REPO, TEMPLATE_REPO } from "../config.ts";
import type { IssueFact, PrFact, RepoFact } from "../facts.ts";
import { classifyPr, type PrClass } from "./attribution.ts";

export type PrKind = "people" | "bots" | "pipeline";
export type IssueKind = "bug" | "enhancement" | "other" | "automation";

const PR_KIND: Record<PrClass, PrKind> = {
  sync: "pipeline",
  cascade: "pipeline",
  template: "pipeline",
  release: "pipeline",
  bump: "pipeline",
  dependabot: "bots",
  agent: "people",
  human: "people",
};

const INSIDERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Labels the sync engine and cascade put on the issues they open.
const AUTOMATION_LABELS = [
  "sync-failed",
  "upstream-sync",
  "conflict",
  "cascade-blocked",
  "cascade-failed",
];

export interface WorkRow {
  repo: string;
  name: string;
  read: boolean;
  prs: Record<PrKind, PrFact[]>;
  // People PRs from authors outside the repository's organization.
  contributors: PrFact[];
  issues: Record<IssueKind, IssueFact[]>;
  // The oldest ready people PR: work a person waits on.
  oldest?: PrFact;
  // Open totals the page did not reach, so a count is never silently short.
  unreadPrs: number;
  unreadIssues: number;
}

export function prKind(pr: PrFact): PrKind {
  return PR_KIND[classifyPr(pr)];
}

export function outsider(pr: Pick<PrFact, "association">): boolean {
  return pr.association !== undefined && !INSIDERS.has(pr.association);
}

export function issueKind(issue: IssueFact): IssueKind {
  if (issue.bot || issue.labels.some((l) => AUTOMATION_LABELS.includes(l))) return "automation";
  const labels = issue.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => l === "bug" || l.startsWith("bug"))) return "bug";
  if (labels.some((l) => l === "enhancement" || l === "feature" || l.startsWith("feat")))
    return "enhancement";
  return "other";
}

function workRow(repo: string, name: string, fact: RepoFact | undefined): WorkRow {
  const prs: WorkRow["prs"] = { people: [], bots: [], pipeline: [] };
  const issues: WorkRow["issues"] = { bug: [], enhancement: [], other: [], automation: [] };
  for (const pr of fact?.prs ?? []) prs[prKind(pr)].push(pr);
  for (const issue of fact?.issues ?? []) issues[issueKind(issue)].push(issue);
  const oldest = prs.people
    .filter((p) => !p.draft)
    .reduce<PrFact | undefined>((a, p) => (!a || p.createdAt < a.createdAt ? p : a), undefined);
  return {
    repo,
    name,
    read: fact !== undefined,
    prs,
    contributors: prs.people.filter(outsider),
    issues,
    ...(oldest ? { oldest } : {}),
    unreadPrs: Math.max(0, (fact?.openPrs ?? 0) - (fact?.prs.length ?? 0)),
    unreadIssues: Math.max(0, (fact?.openIssues ?? 0) - (fact?.issues.length ?? 0)),
  };
}

// Every open PR and issue on every repository, whether or not it sits on a line.
export function buildWork(repos: Record<string, RepoFact>): WorkRow[] {
  return [
    workRow(TEMPLATE_REPO, "template", repos[TEMPLATE_REPO]),
    workRow(STACK_REPO, "stack", repos[STACK_REPO]),
    ...FORKS.map((f) => workRow(f.repo, f.id, repos[f.repo])),
  ];
}
