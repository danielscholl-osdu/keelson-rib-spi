// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ToolDefinition, z } from "@keelson/shared";
import { verdictLabel } from "./boards/attention.ts";
import { doctorStatus } from "./boards/doctor.ts";
import { nextSyncAt, radarBreaks } from "./boards/radar.ts";
import { FORKS, REPOS, shortRepo } from "./config.ts";
import { classifyPr, type PrClass, prFailures } from "./model/attribution.ts";
import { prVerdict } from "./model/checks.ts";
import type { Model } from "./model/index.ts";
import type { LinePr } from "./model/lines.ts";
import { attemptText, overdue, type RunView, usualText } from "./model/stack.ts";
import { type IssueKind, issueKind, outsider, prKind } from "./model/work.ts";
import type { Sweeper } from "./sweep.ts";
import { age, errorText, took } from "./util.ts";

const MAX_CHARS = 16_000;

function payload(data: unknown): string {
  const compact = JSON.stringify(data);
  if (compact.length <= MAX_CHARS) return compact;
  return JSON.stringify({
    truncated: true,
    note: `result exceeded ${MAX_CHARS} characters`,
    head: compact.slice(0, MAX_CHARS - 200),
  });
}

function tool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  inputSchema: S,
  run: (input: z.infer<S>) => unknown,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    async execute(input, ctx) {
      try {
        const parsed = inputSchema.parse(input ?? {});
        ctx.emit({ type: "tool_result", toolUseId: "", content: payload(run(parsed)) });
      } catch (err) {
        ctx.emit({
          type: "tool_result",
          toolUseId: "",
          content: JSON.stringify({ error: errorText(err) }),
          isError: true,
        });
      }
    },
  };
}

function gate(p: LinePr | undefined, now: Date) {
  if (!p) return undefined;
  return {
    number: p.pr.number,
    title: p.pr.title,
    url: p.pr.url,
    age: age(p.pr.createdAt, now),
    verdict: prVerdict(p.pr),
    review: p.pr.reviewDecision,
    failures: p.failures.map((f) => ({
      class: f.cls,
      check: f.check,
      step: f.step,
      reason: f.reason,
    })),
  };
}

function runView(v: RunView | undefined, now: Date) {
  if (!v) return undefined;
  return {
    workflow: `env-${v.run.kind}`,
    target: v.run.target,
    status: v.run.status,
    conclusion: v.run.conclusion,
    started: v.run.createdAt,
    age: age(v.run.createdAt, now),
    failedAt: v.failedAt,
    reason: v.reason,
    current: v.current,
    at: v.at,
    stages: v.stages
      .map((s) => {
        const t = s.state === "running" ? undefined : took(s.startedAt, s.completedAt);
        return `${s.label}:${s.state}${t ? `(${t})` : ""}`;
      })
      .join(" "),
    url: v.run.url,
  };
}

function notMeasured(model: Model) {
  return model.measured ? undefined : { measured: false, note: "the first sweep has not finished" };
}

const PR_CLASSES = [
  "sync",
  "cascade",
  "template",
  "release",
  "bump",
  "agent",
  "dependabot",
  "human",
] as const satisfies readonly PrClass[];

const ISSUE_KINDS = [
  "bug",
  "enhancement",
  "other",
  "automation",
] as const satisfies readonly IssueKind[];

function repoMatch(r: string, repo: string | undefined): boolean {
  return !repo || shortRepo(r) === repo || r === repo || shortRepo(r).endsWith(repo);
}

export function registerSpiTools(sweeper: Sweeper): ToolDefinition[] {
  const now = () => sweeper.now();
  return [
    tool(
      "spi_watchstand",
      "One-word SPI verdict (BLOCKED, ATTENTION, MOVING or CONVERGED) with the ranked needs-a-person queue behind it. Start here for 'is the SPI fleet healthy'. P0 broke unattended, P1 is a gate or decision, P2 is ready work. Each line's kind is broken (main red), halted (automation stopped, no PR open), blocked (an open PR fails on a real failure), stale, waiting (an update waits on review or the stack), unmeasured or current. doctor says whether the rib read every source (clear, partial, dark); when it did not, panels show each source's last good read.",
      z.object({}),
      () => {
        const m = sweeper.model;
        const t = now();
        const doctor = doctorStatus(sweeper.facts, t);
        const waiting = notMeasured(m);
        return waiting
          ? { ...waiting, doctor }
          : {
              verdict: m.queue.verdict,
              label: verdictLabel(m),
              counts: m.queue.counts,
              swept: m.sweptAt,
              doctor,
              stack: {
                declared: m.stack.declared,
                running: m.stack.running?.version,
                deployable: m.stack.deployable,
                maintenance: m.stack.maintenance.state,
                inflight: runView(m.stack.inflight, t),
              },
              lines: m.lines.map((l) => ({
                service: l.fork.id,
                state: l.pill.label,
                kind: l.pill.kind,
                why: l.why,
              })),
              queue: m.queue.items.map((i) => ({
                rung: `P${i.rung}`,
                scope: i.scope,
                text: i.text,
                age: age(i.since, t),
                note: i.note,
                url: i.url,
                effects: i.effects.length,
              })),
            };
      },
    ),
    tool(
      "spi_line",
      "One service line from upstream GitLab to the shared stack: the six stations, upstream lag and the commits behind it, the open gate PRs with failure classes, a sync halt, the release, the template version with the one its template-sync PR moves it to, and the 21-day lane ledger.",
      z.object({ service: z.enum(FORKS.map((f) => f.id) as [string, ...string[]]) }),
      ({ service }) => {
        const m = sweeper.model;
        const t = now();
        const line = m.lines.find((l) => l.fork.id === service);
        if (!line) return { error: `unknown service ${service}` };
        return (
          notMeasured(m) ?? {
            service,
            repo: line.fork.repo,
            upstreamProject: line.fork.upstream,
            state: line.pill.label,
            kind: line.pill.kind,
            why: line.why,
            stations: line.stations,
            upstream: {
              lag: line.upstream?.lag,
              synced: line.upstream?.synced,
              head: line.upstream?.head,
              behind: line.upstream?.commits
                .slice(0, 15)
                .map((c) => `${c.sha.slice(0, 8)} ${c.title}`),
            },
            halt: line.halt
              ? {
                  code: line.halt.code,
                  detail: line.halt.detail,
                  days: line.halt.days,
                  url: line.halt.issue.url,
                }
              : undefined,
            gates: {
              sync: gate(line.syncPr, t),
              cascade: gate(line.cascadePr, t),
              release: gate(line.releasePr, t),
              template: gate(line.templatePr, t),
            },
            cascade: { labels: line.cascadeLabels, conflicts: line.conflicts.map((c) => c.url) },
            release: line.release,
            template: line.template,
            lane: line.lane,
            autoMergeAllowed: line.autoMerge,
          }
        );
      },
    ),
    tool(
      "spi_stack",
      "The shared spi-stack environment in remote mode: declared, running and latest stack versions, inferred maintenance and deployability, the run in flight with the step it is on and how long green runs take there, every refresh and upgrade attempt since the last green one (cancelled ones included), and 21-day pass rates for refresh, upgrade, smoke and sweeper.",
      z.object({}),
      () => {
        const m = sweeper.model;
        const t = now();
        const s = m.stack;
        return (
          notMeasured(m) ?? {
            mode: "remote",
            declared: s.declared,
            running: s.running,
            latest: s.latest,
            maintenance: {
              state: s.maintenance.state,
              since: s.maintenance.since,
              run: s.maintenance.run?.url,
            },
            deployable: s.deployable,
            inflight: runView(s.inflight, t),
            usual: s.usual
              ? { text: usualText(s.usual), overdue: overdue(s, t), runs: s.usual.n }
              : undefined,
            lastGreen: s.lastGreen
              ? {
                  workflow: `env-${s.lastGreen.kind}`,
                  at: s.lastGreen.createdAt,
                  url: s.lastGreen.url,
                }
              : undefined,
            attempts: s.attempts.map((v) => ({
              text: attemptText(v, s.maintenance.run?.id),
              ...runView(v, t),
            })),
            recent: s.recent.map((v) => runView(v, t)),
            lifecycle: Object.fromEntries(
              Object.entries(s.lifecycle).map(([k, v]) => [
                k,
                { green: v.green, total: v.total, streak: v.streak, last: v.last?.url },
              ]),
            ),
            bumpPr: s.bumpPr
              ? { number: s.bumpPr.number, title: s.bumpPr.title, url: s.bumpPr.url }
              : undefined,
            releasePr: s.releasePr
              ? { number: s.releasePr.number, title: s.releasePr.title, url: s.releasePr.url }
              : undefined,
          }
        );
      },
    ),
    tool(
      "spi_template",
      "The engineering system: the newest osdu-spi release and how many forks are on it, the open PRs on osdu-spi itself (Dependabot, features, the release PR) with their verdicts, PRs merged since the release, the next scheduled Sync Template, and per fork: the osdu-spi commit it last adopted (.github/.template-sync-commit) and the version its template-sync PR moves it to, how far behind main it is, what blocks the PR, its review decision and whether it is ready to merge, the last Sync Template delivery or one running now, its open Dependabot PRs, the unadopted changes by title, and the ladder: one step per fork position on template history, newest first, with the step's changes, what they reach in a fork (images, actions, workflows, settings, fork resources, or template only per sync-config.json) and which forks have adopted it.",
      z.object({}),
      () => {
        const m = sweeper.model;
        const t = now();
        const tm = m.template;
        return (
          notMeasured(m) ?? {
            latestTag: tm.latestTag,
            next: tm.next,
            head: tm.head,
            mainAhead: tm.mainAhead,
            releasePr: tm.releasePr?.url,
            current: tm.current,
            onRelease: tm.onRelease,
            nextSync: tm.nextSync,
            mergedPrs: tm.merged,
            templatePrs: tm.prs.map((p) => ({
              number: p.pr.number,
              title: p.pr.title,
              url: p.pr.url,
              class: p.cls,
              verdict: p.verdict,
              review: p.pr.reviewDecision,
              age: age(p.pr.createdAt, t),
            })),
            forks: tm.rows.map((r) => ({
              service: r.service,
              on: r.label,
              to: r.target,
              behind: r.behind,
              pr: r.pr
                ? {
                    number: r.pr.number,
                    url: r.pr.url,
                    age: age(r.pr.createdAt, t),
                    verdict: r.verdict,
                    review: r.pr.reviewDecision,
                    ready: r.ready,
                  }
                : undefined,
              blockedBy: [...new Set(r.failures.map((f) => f.cls))],
              delivery: {
                state: r.delivery.state,
                at: r.delivery.run?.createdAt,
                url: r.delivery.run?.url,
                running: r.syncing?.url,
              },
              dependabot: r.dependabot.map((p) => ({
                number: p.number,
                title: p.title,
                url: p.url,
              })),
            })),
            unadopted: tm.changes.map((c) => ({
              title: c.title,
              pr: c.pr,
              forks: c.forks,
              url: c.url,
            })),
            ladder: tm.steps.map((st) => ({
              step: st.label,
              compare: st.url,
              changes: st.changes.map((c) => ({ title: c.title, pr: c.pr, url: c.url })),
              reaches: st.consequences,
              templateOnly: st.templateOnly,
              adopted: st.adopted,
              waiting: st.waiting,
              failing: st.failing,
              noPr: st.noPr,
            })),
          }
        );
      },
    ),
    tool(
      "spi_incidents",
      "Incidents folded by cause: each names its cause, its failure class and every effect folded under it (for example the fork lanes a failed stack upgrade turned red).",
      z.object({}),
      () => {
        const m = sweeper.model;
        const t = now();
        return (
          notMeasured(m) ?? {
            incidents: m.queue.items
              .filter((i) => i.incident)
              .map((i) => ({
                rung: `P${i.rung}`,
                scope: i.scope,
                cause: i.text,
                since: i.since,
                age: age(i.since, t),
                url: i.url,
                effects: i.effects,
              })),
          }
        );
      },
    ),
    tool(
      "spi_prs",
      "Open PRs across the template, the stack and every fork, each with its class (sync, cascade, template, release, bump, agent, dependabot, human), its kind (people, bots, pipeline), whether its author is outside the organization, check verdict and attributed failures. Filter by repository short name or class.",
      z.object({
        repo: z.string().optional(),
        class: z.enum(PR_CLASSES).optional(),
      }),
      ({ repo, class: cls }) => {
        const facts = sweeper.facts;
        const repos = facts.github.data?.repos ?? {};
        const details = facts.details.data ?? {};
        const t = now();
        const rows = REPOS.filter((r) => repoMatch(r, repo))
          .flatMap((r) => repos[r]?.prs ?? [])
          .filter((pr) => !cls || classifyPr(pr) === cls)
          .map((pr) => {
            const { prClass, failures } = prFailures(pr, details);
            return {
              repo: shortRepo(pr.repo),
              number: pr.number,
              title: pr.title,
              class: prClass,
              kind: prKind(pr),
              author: pr.author,
              outside: outsider(pr),
              draft: pr.draft,
              verdict: prVerdict(pr),
              review: pr.reviewDecision,
              mergeState: pr.mergeState,
              age: age(pr.createdAt, t),
              url: pr.url,
              failures: failures.map((f) => ({
                class: f.cls,
                check: f.check,
                step: f.step,
                reason: f.reason,
                hidden: f.hidden,
              })),
            };
          });
        return sweeper.model.measured ? { prs: rows } : notMeasured(sweeper.model);
      },
    ),
    tool(
      "spi_issues",
      "Open issues across the template, the stack and every fork, each with its kind (bug, enhancement, other, or automation for the sync engine's halt and tracking issues), labels, author, comment count and age. unread names repositories with more open issues than the sweep read. Filter by repository short name or kind.",
      z.object({
        repo: z.string().optional(),
        kind: z.enum(ISSUE_KINDS).optional(),
      }),
      ({ repo, kind }) => {
        const repos = sweeper.facts.github.data?.repos ?? {};
        const t = now();
        const matched = REPOS.filter((r) => repoMatch(r, repo));
        const issues = matched
          .flatMap((r) => repos[r]?.issues ?? [])
          .filter((i) => !kind || issueKind(i) === kind)
          .map((i) => ({
            repo: shortRepo(i.repo),
            number: i.number,
            title: i.title,
            kind: issueKind(i),
            labels: i.labels,
            author: i.author,
            comments: i.comments,
            age: age(i.createdAt, t),
            updated: age(i.updatedAt, t),
            url: i.url,
            ...(i.halt ? { halt: i.halt } : {}),
          }));
        const unread = matched.flatMap((r) => {
          const fact = repos[r];
          const n = (fact?.openIssues ?? 0) - (fact?.issues.length ?? 0);
          return n > 0 ? [{ repo: shortRepo(r), issues: n }] : [];
        });
        return sweeper.model.measured
          ? { issues, ...(unread.length ? { unread } : {}) }
          : notMeasured(sweeper.model);
      },
    ),
    tool(
      "spi_radar",
      "The upstream radar: per fork, what the next daily Sync Upstream (00:00 UTC) does with the commits already queued upstream and what each open GitLab MR would do if merged, classified with the fork's own .github/upstream-filter.yml as Halt (with the engine's code and the filter map and entry), Toolchain (Java or os-core-common moves), Port, Interface, Shared or Filtered; the fork's state; and the open MRs that would break a fork. A queued commit is certain, an open MR is possible; drafts are marked.",
      z.object({}),
      () => {
        const m = sweeper.model;
        return (
          notMeasured(m) ?? {
            nextSyncAt: nextSyncAt(now()),
            services: Object.fromEntries(
              Object.entries(m.radar.services).map(([svc, r]) => [
                svc,
                {
                  state: r.state,
                  queued: r.queued,
                  mrs: r.mrs,
                  certain: r.certain,
                  possible: r.possible,
                  filterSha: r.filterSha,
                },
              ]),
            ),
            breaks: radarBreaks(m),
            ledgers: {
              ports: Object.fromEntries(
                Object.entries(m.radar.services).map(([svc, r]) => [svc, r.ports ?? null]),
              ),
              libraries: Object.fromEntries(
                Object.entries(m.radar.services).map(([svc, r]) => [svc, r.libraries ?? null]),
              ),
            },
          }
        );
      },
    ),
  ];
}
