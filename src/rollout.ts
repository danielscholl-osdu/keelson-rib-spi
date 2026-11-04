// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { JobDetail } from "./facts.ts";

// The fleet rollout file in osdu-spi. The rib reads `lanes` and `ordering`; other fields pass unread.
export const ROLLOUT_SCHEMA = 1;

// A fork that merges only once each fork it names has merged and its main run is green.
export interface OrderRule {
  service: string;
  after: string[];
  reason?: string;
}

export interface Rollout {
  lanes?: number;
  ordering?: OrderRule[];
}

function orderingOf(raw: unknown): { ordering?: OrderRule[]; warnings: string[] } {
  if (raw === undefined) return { warnings: [] };
  const rules = Array.isArray(raw) ? raw : [];
  const ordering: OrderRule[] = [];
  for (const r of rules) {
    const rule = (r ?? {}) as { service?: unknown; after?: unknown; reason?: unknown };
    if (
      typeof rule.service !== "string" ||
      !Array.isArray(rule.after) ||
      !rule.after.every((a) => typeof a === "string")
    )
      continue;
    ordering.push({
      service: rule.service,
      after: rule.after as string[],
      ...(typeof rule.reason === "string" ? { reason: rule.reason } : {}),
    });
  }
  const dropped = Array.isArray(raw) ? rules.length - ordering.length : 1;
  return {
    ordering,
    warnings:
      dropped > 0
        ? [
            `rollout file has ${dropped === 1 ? "an ordering rule" : `${dropped} ordering rules`} the rib cannot read; merges ignore it`,
          ]
        : [],
  };
}

export interface ParsedRollout {
  rollout?: Rollout;
  warnings: string[];
}

export function parseRollout(text: string): ParsedRollout {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { warnings: [`rollout file is not JSON: ${(err as Error).message}`] };
  }
  const doc = (raw ?? {}) as { schema?: unknown; lanes?: unknown; ordering?: unknown };
  if (doc.schema !== ROLLOUT_SCHEMA) {
    return {
      warnings: [
        `rollout file has schema ${JSON.stringify(doc.schema)}, the rib reads ${ROLLOUT_SCHEMA}; fleet buttons unpaced`,
      ],
    };
  }
  const order = orderingOf(doc.ordering);
  const ordering = order.ordering?.length ? { ordering: order.ordering } : {};
  if (doc.lanes === undefined) return { rollout: { ...ordering }, warnings: order.warnings };
  if (typeof doc.lanes !== "number" || !Number.isInteger(doc.lanes) || doc.lanes < 1) {
    return {
      rollout: { ...ordering },
      warnings: [
        `rollout file has lanes ${JSON.stringify(doc.lanes)}, not a positive whole number; fleet buttons unpaced`,
        ...order.warnings,
      ],
    };
  }
  return { rollout: { lanes: doc.lanes, ...ordering }, warnings: order.warnings };
}

// The rollout file the model reads, set once per sweep beside the fleet list.
let active: Rollout | undefined;

export function useRollout(rollout: Rollout | undefined): void {
  active = rollout;
}

export function activeRollout(): Rollout | undefined {
  return active;
}

// The annotation title validate.yml gives its shared-environment timeouts.
export const ENVIRONMENT_TITLE = "Environment";

// What to do about a failed run: an environment failure is re-run once, anything else stops the line.
export interface Judgement {
  class: "environment" | "real";
  response: "rerun-failed" | "stop";
  // The first Environment annotation's message.
  cause?: string;
  note?: string;
}

// A run is environment-class when any failed job carries a failure-level annotation titled
// Environment; undefined until every failed job's annotations are read.
export function judgeRun(jobs: readonly (JobDetail | undefined)[]): Judgement | undefined {
  if (jobs.length === 0 || jobs.some((j) => j?.environment === undefined)) return undefined;
  const messages = jobs.flatMap((j) => j?.environment ?? []);
  if (messages.length === 0) return { class: "real", response: "stop" };
  const cause = messages[0];
  const attempt = Math.max(...jobs.map((j) => j?.attempt ?? 1));
  if (attempt > 1) return { class: "real", response: "stop", cause, note: "already rerun once" };
  return { class: "environment", response: "rerun-failed", cause };
}

// The judgement that frames an item folding several runs: any real failure stops the line.
export function governing(judgements: readonly (Judgement | undefined)[]): Judgement | undefined {
  const found = judgements.filter((j): j is Judgement => !!j);
  return found.find((j) => j.response === "stop") ?? found[0];
}
