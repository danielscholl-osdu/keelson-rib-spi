// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CheckFact, PrFact } from "../facts.ts";

export const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "CANCELLED",
]);

const SUMMARY = "Validation Summary";

// Only the newest check per workflow and name counts, so a stale failure on a
// re-run does not stay red. Two Validation lanes exist and one always skips,
// so a skipped check loses to a real one of the same name.
export function latestChecks(checks: readonly CheckFact[]): CheckFact[] {
  const byKey = new Map<string, CheckFact>();
  for (const c of checks) {
    const key = `${c.workflow ?? ""}\u0000${c.name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    const cSkipped = c.conclusion === "SKIPPED";
    const prevSkipped = prev.conclusion === "SKIPPED";
    if (cSkipped !== prevSkipped) {
      if (!cSkipped) byKey.set(key, c);
      continue;
    }
    if (c.id > prev.id) byKey.set(key, c);
  }
  return [...byKey.values()];
}

export function failedChecks(pr: PrFact): CheckFact[] {
  const failed = latestChecks(pr.checks).filter(
    (c) => c.status === "COMPLETED" && FAILED_CONCLUSIONS.has(c.conclusion ?? ""),
  );
  const real = failed.filter((c) => c.name !== SUMMARY);
  return real.length > 0 ? real : failed;
}

// External apps (a CLA bot) can sit queued forever, so only Actions checks
// count as pending.
export function pendingChecks(pr: PrFact): CheckFact[] {
  return latestChecks(pr.checks).filter((c) => c.workflow && c.status !== "COMPLETED");
}

export type PrVerdict = "red" | "pending" | "green" | "none";

export function prVerdict(pr: PrFact): PrVerdict {
  if (failedChecks(pr).length > 0) return "red";
  if (pendingChecks(pr).length > 0) return "pending";
  return latestChecks(pr.checks).some((c) => c.workflow) ? "green" : "none";
}

function needsReview(pr: PrFact): boolean {
  return pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED";
}

export function prReady(pr: PrFact, failures: readonly { hidden: boolean }[]): boolean {
  return (
    failures.every((f) => f.hidden) && prVerdict(pr) === "green" && !pr.draft && !needsReview(pr)
  );
}
