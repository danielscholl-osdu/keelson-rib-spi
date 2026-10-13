// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CheckFact, JobDetail, PrFact } from "../facts.ts";
import { failedChecks } from "./checks.ts";
import { summarizeReason } from "./reason.ts";

export type PrClass =
  | "sync"
  | "cascade"
  | "template"
  | "release"
  | "bump"
  | "agent"
  | "dependabot"
  | "human";

export function classifyPr(
  pr: Pick<PrFact, "head"> & Partial<Pick<PrFact, "labels" | "author">>,
): PrClass {
  const head = pr.head;
  const author = (pr.author ?? "").toLowerCase();
  if (head.startsWith("sync/upstream-")) return "sync";
  if (head.startsWith("release/upstream-")) return "cascade";
  if (head.startsWith("template-sync/") || pr.labels?.includes("template-sync")) return "template";
  if (head.startsWith("release-please--") || pr.labels?.includes("autorelease: pending")) {
    return "release";
  }
  if (head.startsWith("env-bump/")) return "bump";
  if (author.includes("dependabot") || head.startsWith("dependabot/")) return "dependabot";
  if (
    author.includes("copilot") ||
    head.startsWith("copilot/") ||
    head.startsWith("agent/") ||
    author.endsWith("[bot]")
  ) {
    return "agent";
  }
  return "human";
}

export const CLASS_LABEL: Record<PrClass, string> = {
  sync: "sync PR",
  cascade: "release/upstream PR",
  template: "template-sync PR",
  release: "release PR",
  bump: "env bump PR",
  agent: "agent PR",
  dependabot: "Dependabot PR",
  human: "PR",
};

export type FailureClass =
  | "ENV"
  | "TEST"
  | "HALT"
  | "TOOLCHAIN"
  | "CONFLICT"
  | "POLICY"
  | "INFRA"
  | "BUILD"
  | "UNREAD";

export interface Failure {
  cls: FailureClass;
  repo: string;
  pr: number;
  prClass: PrClass;
  prUrl: string;
  check: string;
  step?: string;
  reason?: string;
  raw?: string;
  at: string;
  url?: string;
  hidden: boolean;
}

// Steps of the Deploy and Test job that belong to the shared stack, not the
// service: a red check there is the environment until Prove says otherwise.
const ENV_STEPS = new Set([
  "Connect to cluster",
  "Match stack version",
  "Confirm environment deployable",
  "Borrow",
  "Verify",
]);
const TEST_STEPS = new Set(["Prove"]);
const POLICY_CHECKS = /^(Check Paths|Check Code Quality|PR Title|Validate PR Title|Check Commit)/i;
const TOOLCHAIN_RE =
  /RequireJavaVersion|invalid target release|release version \d+ not supported|class file (major )?version|Unsupported class file|has been compiled by a more recent version|maven-enforcer/i;
const NETWORK_RE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|other side closed|connection refused|timed out|unreachable|Bad Gateway|Service Unavailable|rate limit|lost communication|The runner has received a shutdown/i;

export function attributeCheck(
  pr: PrFact,
  prClass: PrClass,
  check: CheckFact,
  detail: JobDetail | undefined,
): Failure {
  const reason = summarizeReason(detail?.reason);
  const step = detail?.failedStep;
  const base = {
    repo: pr.repo,
    pr: pr.number,
    prClass,
    prUrl: pr.url,
    check: check.name,
    step,
    reason,
    raw: detail?.reason,
    at: check.completedAt ?? pr.updatedAt,
    url: check.url,
    hidden: false,
  };
  const cls = classOf(check.name, prClass, step, detail);
  return { ...base, cls, hidden: cls === "POLICY" && prClass === "dependabot" };
}

export function classOf(
  name: string,
  prClass: PrClass,
  step: string | undefined,
  detail: JobDetail | undefined,
): FailureClass {
  const text = detail?.reason ?? "";
  if (/^Deploy and Test$/i.test(name)) {
    if (!detail) return "UNREAD";
    if (step && ENV_STEPS.has(step)) return "ENV";
    if (step && TEST_STEPS.has(step)) return "TEST";
    if (/not deployable|maintenance|Reconciliation in progress/i.test(text)) return "ENV";
    return NETWORK_RE.test(text) ? "INFRA" : "TEST";
  }
  if (POLICY_CHECKS.test(name)) return "POLICY";
  if (/Java Build/i.test(name)) {
    if (!detail) return "UNREAD";
    if (TOOLCHAIN_RE.test(text) && (prClass === "sync" || prClass === "cascade")) {
      return "TOOLCHAIN";
    }
    return NETWORK_RE.test(text) ? "INFRA" : "BUILD";
  }
  if (!detail) return "UNREAD";
  return NETWORK_RE.test(text) ? "INFRA" : "BUILD";
}

export function prFailures(
  pr: PrFact,
  details: Record<string, JobDetail>,
): { prClass: PrClass; failures: Failure[] } {
  const prClass = classifyPr(pr);
  const failures = failedChecks(pr).map((c) =>
    attributeCheck(pr, prClass, c, details[`${pr.repo}#${c.id}`]),
  );
  return { prClass, failures };
}

// "upstream requires Java 25, the fork builds on 17" from the enforcer line.
export function toolchainText(reason: string | undefined): string | undefined {
  const m = /JDK (\d+)[^ ]* is outside the allowed range \[(\d+)/.exec(reason ?? "");
  return m ? `upstream requires Java ${m[2]}, the fork builds on ${m[1]}` : undefined;
}

export const CLASS_TONE: Record<FailureClass, "error" | "warn" | "caution" | "info" | "neutral"> = {
  ENV: "info",
  TEST: "error",
  HALT: "error",
  TOOLCHAIN: "caution",
  CONFLICT: "error",
  POLICY: "neutral",
  INFRA: "warn",
  BUILD: "error",
  UNREAD: "neutral",
};
