// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { REPOS } from "../config.ts";
import type { CodeAlertFact, DependencyAlertFact, RepoAlerts, Severity } from "../facts.ts";
import type { Gh } from "../forge.ts";
import { errorText, pool } from "../util.ts";

const DEPENDABOT_JQ = `.[] | {number, severity: .security_advisory.severity, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, manifest: .dependency.manifest_path, scope: .dependency.scope, fixed: .security_vulnerability.first_patched_version.identifier, advisory: .security_advisory.ghsa_id, cve: .security_advisory.cve_id, summary: .security_advisory.summary, url: .html_url, createdAt: .created_at}`;

const CODE_JQ = `.[] | {number, severity: .rule.security_severity_level, ruleSeverity: .rule.severity, rule: .rule.id, description: .rule.description, tool: .tool.name, path: .most_recent_instance.location.path, url: .html_url, createdAt: .created_at}`;

const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function severity(v: unknown): Severity | undefined {
  const s = str(v)?.toLowerCase();
  if (s === "moderate") return "medium";
  return s && SEVERITIES.has(s) ? (s as Severity) : undefined;
}

export function parseDependencyAlert(r: Raw): DependencyAlertFact | undefined {
  const sev = severity(r.severity);
  const pkg = str(r.package);
  const manifest = str(r.manifest);
  const url = str(r.url);
  if (typeof r.number !== "number" || !sev || !pkg || !manifest || !url) return undefined;
  const scope = str(r.scope);
  const fixed = str(r.fixed);
  const cve = str(r.cve);
  return {
    number: r.number,
    severity: sev,
    package: pkg,
    ecosystem: str(r.ecosystem) ?? "",
    manifest,
    ...(scope === "runtime" || scope === "development" ? { scope } : {}),
    ...(fixed ? { fixed } : {}),
    advisory: str(r.advisory) ?? "",
    ...(cve ? { cve } : {}),
    summary: str(r.summary) ?? pkg,
    url,
    createdAt: str(r.createdAt) ?? "",
  };
}

export function parseCodeAlert(r: Raw): CodeAlertFact | undefined {
  const rule = str(r.rule);
  const url = str(r.url);
  if (typeof r.number !== "number" || !rule || !url) return undefined;
  const sev = severity(r.severity);
  const ruleSeverity = str(r.ruleSeverity);
  const path = str(r.path);
  return {
    number: r.number,
    ...(sev ? { severity: sev } : {}),
    ...(ruleSeverity ? { ruleSeverity } : {}),
    rule,
    description: str(r.description) ?? rule,
    tool: str(r.tool) ?? "",
    ...(path ? { path } : {}),
    url,
    createdAt: str(r.createdAt) ?? "",
  };
}

// GitHub answers 404 or 403 when a list is off or hidden from this token.
function hidden(err: unknown): boolean {
  return /HTTP 40[34]\b/.test(errorText(err));
}

async function list<T>(
  gh: Gh,
  path: string,
  jq: string,
  parse: (r: Raw) => T | undefined,
): Promise<T[] | undefined> {
  try {
    const raw = await gh.pages<Raw>(`${path}?state=open&per_page=100`, jq);
    return raw.flatMap((r) => parse(r) ?? []);
  } catch (err) {
    if (hidden(err)) return undefined;
    throw err;
  }
}

// Open Dependabot and code-scanning alerts per repository. A repository whose read
// fails keeps its last good lists; the read fails only when no repository answered.
export async function readSecurity(
  gh: Gh,
  prev: Record<string, RepoAlerts> | undefined,
): Promise<Record<string, RepoAlerts>> {
  const out: Record<string, RepoAlerts> = {};
  const errors: string[] = [];
  await pool(REPOS, 4, async (repo) => {
    try {
      const [dependabot, code] = await Promise.all([
        list(gh, `repos/${repo}/dependabot/alerts`, DEPENDABOT_JQ, parseDependencyAlert),
        list(gh, `repos/${repo}/code-scanning/alerts`, CODE_JQ, parseCodeAlert),
      ]);
      out[repo] = { ...(dependabot ? { dependabot } : {}), ...(code ? { code } : {}) };
    } catch (err) {
      errors.push(`${repo}: ${errorText(err)}`);
      const last = prev?.[repo];
      if (last) out[repo] = last;
    }
  });
  if (errors.length === REPOS.length) throw new Error(errors[0]);
  return out;
}
