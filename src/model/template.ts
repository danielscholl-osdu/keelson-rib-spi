// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { PrFact, RepoFact, RunFact, TemplateChange, TemplateFacts } from "../facts.ts";
import type { Failure } from "./attribution.ts";
import { type PrVerdict, prVerdict } from "./checks.ts";
import type { LineModel } from "./lines.ts";

export interface TemplateRow {
  service: string;
  repo: string;
  marker?: string;
  label?: string;
  behind?: number;
  pr?: PrFact;
  verdict?: PrVerdict;
  failures: Failure[];
  delivery: { run?: RunFact; state: "ok" | "failed" | "stale" | "unknown" };
}

export interface TemplateModel {
  head?: { sha: string; at: string };
  latestTag?: string;
  mainAhead?: number;
  releasePr?: PrFact;
  rows: TemplateRow[];
  current: number;
  waiting: number;
  behindNoPr: number;
  unmeasured: number;
  changes: (TemplateChange & { forks: number; missing: string[] })[];
  commits: number;
}

export function buildTemplate(
  templateRepo: RepoFact | undefined,
  facts: TemplateFacts | undefined,
  lines: readonly LineModel[],
): TemplateModel {
  const compares = facts?.compares ?? {};
  const rows: TemplateRow[] = lines.map((line) => {
    const marker = line.template.marker;
    const compare = marker ? compares[marker] : undefined;
    return {
      service: line.fork.id,
      repo: line.fork.repo,
      marker,
      label: compare?.label,
      behind: compare?.aheadBy,
      pr: line.templatePr?.pr,
      verdict: line.templatePr ? prVerdict(line.templatePr.pr) : undefined,
      failures: line.templatePr?.failures ?? [],
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

  const prs = templateRepo?.prs ?? [];
  return {
    head: templateRepo?.head,
    latestTag: facts?.latestTag ?? templateRepo?.release?.tag,
    mainAhead: facts?.mainAhead,
    releasePr: prs.find(
      (p) => p.head.startsWith("release-please--") || p.labels.includes("autorelease: pending"),
    ),
    rows,
    current: rows.filter((r) => r.behind === 0).length,
    waiting: rows.filter((r) => (r.behind ?? 0) > 0 && r.pr).length,
    behindNoPr: rows.filter((r) => (r.behind ?? 0) > 0 && !r.pr).length,
    unmeasured: rows.filter((r) => r.behind === undefined).length,
    changes,
    commits,
  };
}
