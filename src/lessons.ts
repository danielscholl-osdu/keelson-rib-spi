// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "@keelson/shared";
import { AUTOMATION_APP } from "./config.ts";
import type { CheckFact, JobDetail, PrFact, RepoFact } from "./facts.ts";

// The fleet lessons file in osdu-spi. Its field names are a contract shared with the
// spi-fleet script and the fleet-release workflow, so unknown fields pass through unread.
export const LESSONS_SCHEMA = 1;

const noiseSchema = z
  .object({
    id: z.string().min(1),
    check: z.string().min(1),
    conclusion: z.string().optional(),
    author: z.literal("app").optional(),
    reason: z.string(),
    source: z.string().optional(),
  })
  .loose();

const failureSchema = z
  .object({
    id: z.string().min(1),
    pattern: z.string().min(1),
    class: z.enum(["environment", "real"]),
    response: z.enum(["wait", "rerun-failed", "rerun-all", "stop"]),
    rerunLimit: z.number().int().min(0),
    drainFirst: z.boolean(),
    source: z.string().optional(),
  })
  .loose();

const lessonsSchema = z
  .object({
    schema: z.number(),
    lanes: z.number().int().positive().optional(),
    noise: z.array(noiseSchema).default([]),
    failures: z.array(failureSchema).default([]),
    unmatched: z
      .object({ class: z.enum(["environment", "real"]), response: failureSchema.shape.response })
      .loose()
      .default({ class: "real", response: "stop" }),
  })
  .loose();

export type NoiseRule = z.infer<typeof noiseSchema>;
export type FailureRule = z.infer<typeof failureSchema>;
export type LessonClass = FailureRule["class"];
export type LessonResponse = FailureRule["response"];

export interface Lessons {
  lanes?: number;
  noise: NoiseRule[];
  failures: (FailureRule & { re: RegExp })[];
  unmatched: { class: LessonClass; response: LessonResponse };
}

// What the lessons file says about one failure: the rule it matched, or the unmatched default.
export interface LessonMatch {
  id?: string;
  class: LessonClass;
  response: LessonResponse;
  rerunLimit: number;
  drainFirst: boolean;
  source?: string;
  // Why the rule's own response no longer applies, as "rerun limit reached".
  note?: string;
}

export interface ParsedLessons {
  lessons?: Lessons;
  warnings: string[];
}

export function parseLessons(text: string): ParsedLessons {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { warnings: [`lessons file is not JSON: ${(err as Error).message}`] };
  }
  const schema = (raw as { schema?: unknown } | null)?.schema;
  if (schema !== LESSONS_SCHEMA) {
    return {
      warnings: [
        `lessons file has schema ${JSON.stringify(schema)}, the rib reads ${LESSONS_SCHEMA}; built-in behavior applies`,
      ],
    };
  }
  const parsed = lessonsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      warnings: [
        `lessons file does not match schema ${LESSONS_SCHEMA}: ${issue?.path.join(".")} ${issue?.message}`,
      ],
    };
  }
  const warnings: string[] = [];
  const failures: Lessons["failures"] = [];
  for (const f of parsed.data.failures) {
    try {
      failures.push({ ...f, re: new RegExp(f.pattern, "i") });
    } catch {
      warnings.push(`lesson ${f.id} has a pattern that is not a regular expression; skipped`);
    }
  }
  return {
    lessons: {
      ...(parsed.data.lanes !== undefined ? { lanes: parsed.data.lanes } : {}),
      noise: parsed.data.noise,
      failures,
      unmatched: { class: parsed.data.unmatched.class, response: parsed.data.unmatched.response },
    },
    warnings,
  };
}

// The lessons the model reads, set once per sweep beside the fleet list.
let active: Lessons | undefined;

export function useLessons(lessons: Lessons | undefined): void {
  active = lessons;
}

export function activeLessons(): Lessons | undefined {
  return active;
}

// The first rule, in file order, whose pattern matches any of the texts.
export function ruleFor(
  texts: readonly string[],
  lessons: Lessons | undefined = active,
): FailureRule | undefined {
  if (!lessons) return undefined;
  return lessons.failures.find((rule) => texts.some((t) => rule.re.test(t)));
}

// Names the patterns a log was scanned with, so a changed lessons file scans it again.
export function lessonsSignature(lessons: Lessons): string {
  return lessons.failures.map((f) => f.pattern).join("\u0000");
}

const ECHOED = /\[36;1m|##\[group\]/;
const TIMESTAMP = /^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes in job logs
const COLOR = /(?:\u001b|\^\[)\[[0-9;]*m/g;

// A job log without the script text it echoes, timestamps or colors, as one line:
// the script prints its own error strings, so an echoed line would match every pattern.
export function scriptFree(log: string): string {
  const kept: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (ECHOED.test(line)) continue;
    kept.push(line.replace(TIMESTAMP, "").replace(COLOR, ""));
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

const HIT_CONTEXT = 160;

// The stretch of a cleaned log around each pattern that matches, kept in place of the log.
export function logHits(log: string, lessons: Lessons): string[] {
  const text = scriptFree(log);
  const hits: string[] = [];
  for (const rule of lessons.failures) {
    const m = new RegExp(rule.re.source, "i").exec(text);
    if (!m) continue;
    const from = Math.max(0, m.index - HIT_CONTEXT);
    hits.push(text.slice(from, m.index + m[0].length + HIT_CONTEXT));
  }
  return hits;
}

// Whether a failed job's log has to be read to judge it: no failure annotation matched.
export function needsLogScan(job: JobDetail, lessons: Lessons | undefined = active): boolean {
  if (!lessons || lessons.failures.length === 0) return false;
  if (job.name === "Validation Summary") return false;
  if (ruleFor(job.annotations ?? [], lessons)) return false;
  return job.logScan?.signature !== lessonsSignature(lessons);
}

// The failure-level annotations first, then the cleaned log; then the rerun limit, which
// turns an environment failure already re-run enough times into a real one.
export function judgeJob(
  job: JobDetail,
  lessons: Lessons | undefined = active,
): LessonMatch | undefined {
  if (!lessons) return undefined;
  const annotations = job.annotations ?? (job.reason ? [job.reason] : []);
  const rule = ruleFor(annotations, lessons) ?? ruleFor(job.logScan?.hits ?? [], lessons);
  if (!rule) {
    return {
      class: lessons.unmatched.class,
      response: lessons.unmatched.response,
      rerunLimit: 0,
      drainFirst: false,
    };
  }
  const match: LessonMatch = {
    id: rule.id,
    class: rule.class,
    response: rule.response,
    rerunLimit: rule.rerunLimit,
    drainFirst: rule.drainFirst,
    ...(rule.source ? { source: rule.source } : {}),
  };
  const attempt = job.attempt ?? 1;
  if (
    match.class === "environment" &&
    match.response !== "wait" &&
    attempt - 1 >= match.rerunLimit
  ) {
    return { ...match, class: "real", response: "stop", note: "rerun limit reached" };
  }
  return match;
}

const RESPONSE_ORDER: readonly LessonResponse[] = ["stop", "wait", "rerun-all", "rerun-failed"];

// The match that decides an item's framing when it folds several failures: stop beats wait beats rerun.
export function governing(matches: readonly (LessonMatch | undefined)[]): LessonMatch | undefined {
  const found = matches.filter((m): m is LessonMatch => !!m);
  return found.sort(
    (a, b) => RESPONSE_ORDER.indexOf(a.response) - RESPONSE_ORDER.indexOf(b.response),
  )[0];
}

export function appAuthored(pr: PrFact): boolean {
  if (pr.authorApp !== undefined) return pr.authorApp;
  const who = pr.author ?? "";
  return who === AUTOMATION_APP || who.startsWith("app/") || /\[bot\]$/.test(who);
}

export function noiseRule(
  pr: PrFact,
  check: CheckFact,
  lessons: Lessons | undefined = active,
): NoiseRule | undefined {
  return lessons?.noise.find(
    (n) =>
      n.check === check.name &&
      (!n.conclusion || n.conclusion.toUpperCase() === (check.conclusion ?? "").toUpperCase()) &&
      (n.author !== "app" || appAuthored(pr)),
  );
}

// Open PRs with the noisy checks removed, and how many each rule took out.
export function withoutNoise(
  repos: Record<string, RepoFact>,
  lessons: Lessons | undefined = active,
): { repos: Record<string, RepoFact>; ignored: Record<string, number> } {
  const ignored: Record<string, number> = {};
  if (!lessons || lessons.noise.length === 0) return { repos, ignored };
  const out: Record<string, RepoFact> = {};
  for (const [name, repo] of Object.entries(repos)) {
    out[name] = {
      ...repo,
      prs: repo.prs.map((pr) => {
        const checks = pr.checks.filter((c) => {
          const rule = noiseRule(pr, c, lessons);
          if (rule) ignored[rule.id] = (ignored[rule.id] ?? 0) + 1;
          return !rule;
        });
        return checks.length === pr.checks.length ? pr : { ...pr, checks };
      }),
    };
  }
  return { repos: out, ignored };
}
