// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { clip } from "../util.ts";

export interface Annotation {
  level: string;
  message: string;
}

const GENERIC = /^Process completed with exit code \d+\.?$/;
const MAX = 220;

// A job's own failure annotation is the reason, unless it is only the runner's
// exit-code line; the environment wait notice is the next best.
export function reasonFromAnnotations(annotations: readonly Annotation[]): string | undefined {
  const failures = annotations
    .filter((a) => a.level === "failure")
    .map((a) => a.message.trim())
    .filter((m) => m.length > 0 && !GENERIC.test(m));
  if (failures[0]) return clip(failures[0], MAX);
  const waiting = annotations.find((a) => /^waiting for the environment:/i.test(a.message.trim()));
  return waiting ? clip(waiting.message, MAX) : undefined;
}

function cleanLines(text: string): string[] {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes in job logs
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s?/, ""))
  );
}

function joinWrapped(lines: readonly string[], start: number, first: string): string {
  const parts = [first.trim()];
  for (let i = start + 1; i < Math.min(lines.length, start + 12); i++) {
    const l = (lines[i] ?? "").trim();
    if (l.length === 0 || l.startsWith("##[") || /^(ERROR|INFO|WARN|DEBUG)\b/.test(l)) break;
    parts.push(l);
  }
  return parts.join(" ");
}

// Retried errors repeat their message; a later segment that the first one
// already ends with adds nothing.
function dedupeSegments(text: string): string {
  const kept: string[] = [];
  for (const seg of text.split(/;\s*/)) {
    const key = seg.trim();
    if (key.length === 0 || kept.some((k) => k === key || k.endsWith(key))) continue;
    kept.push(key);
  }
  return kept.join("; ");
}

const NOISE = [
  /^BUILD FAILURE$/,
  /^-> \[Help \d+\]$/,
  /^To see the full stack trace/,
  /^Re-run Maven/,
  /^For more information about the errors/,
  /^\[Help \d+\]/,
  /^After correcting the problems/,
  /^\S+ \.+ FAILURE \[/,
  /^Failed to execute goal .*enforce/,
  /^Rule \d+: .* failed with message:$/,
];

// The log is the fallback when annotations carry nothing but the exit code: a
// Maven enforcer line, a "Deployment failed:" paragraph, or the first real error.
export function reasonFromLog(text: string): string | undefined {
  const lines = cleanLines(text);
  for (const l of lines) {
    const jdk =
      /Detected JDK .* is version (\S+) which is not in the allowed range (\S+?)\.?$/.exec(l);
    if (jdk) return `RequireJavaVersion: JDK ${jdk[1]} is outside the allowed range ${jdk[2]}`;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /(Deployment failed|Unable to resolve OSDU service images): (.*)$/.exec(
      lines[i] ?? "",
    );
    if (m) return clip(dedupeSegments(joinWrapped(lines, i, `${m[1]}: ${m[2]}`)), MAX);
  }
  for (const l of lines) {
    const m = /^\[ERROR\]\s+(.*)$/.exec(l);
    if (!m) continue;
    const msg = (m[1] ?? "").trim();
    if (msg.length === 0 || NOISE.some((re) => re.test(msg))) continue;
    return clip(msg, MAX);
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:Error|ERROR|error): (.*)$/.exec((lines[i] ?? "").trim());
    if (m) return clip(dedupeSegments(joinWrapped(lines, i, m[1] ?? "")), MAX);
  }
  for (const l of lines) {
    const m = /^##\[error\](.*)$/.exec(l);
    if (m && !GENERIC.test((m[1] ?? "").trim())) return clip(m[1] ?? "", MAX);
  }
  return undefined;
}

// "GitLab API unreachable after 3 attempts: <urlopen error ...>" reads as the
// outage it is; the rest stay verbatim.
export function summarizeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (/GitLab API unreachable/i.test(reason))
    return "GitLab API unreachable while resolving images";
  const aad = /AADSTS(\d+): ([^.]+)/.exec(reason);
  if (aad) return `Azure sign-in failed: AADSTS${aad[1]} ${aad[2]?.trim()}`;
  const drift = /deployed ref \((v[\d.]+)\) drifted from declared stackVersion \((v[\d.]+)\)/.exec(
    reason,
  );
  if (drift) return `deployed ${drift[1]} drifted from declared ${drift[2]}`;
  const notDeployable = /environment is not deployable after \d+ minutes: (.*)$/.exec(reason);
  if (notDeployable) return `not deployable: ${notDeployable[1]}`;
  const waiting = /^waiting for the environment: (.*)$/i.exec(reason);
  if (waiting) return `waiting: ${waiting[1]}`;
  return reason;
}
