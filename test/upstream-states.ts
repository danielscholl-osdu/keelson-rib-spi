// Upstream sync states built on the recorded 13-fork sweep, for the tests and dev/upstream-states.ts.
import { emptyFacts, type Facts, type JobDetail, type PrFact, type RunFact } from "../src/facts";
import fixture from "./fixtures/upstream.json";

export const UPSTREAM_NOW = new Date(
  (fixture as unknown as Facts).sweep?.at ?? "2026-11-04T23:42:58Z",
);
export const UPSTREAM_SERVICES = new URL("./fixtures/upstream-services.json", import.meta.url)
  .pathname;

const MIN = 60_000;
let seq = 990_000;

function ago(min: number): string {
  return new Date(UPSTREAM_NOW.getTime() - min * MIN).toISOString();
}

export function upstreamFacts(): Facts {
  return { ...emptyFacts(), ...(structuredClone(fixture) as unknown as Partial<Facts>) };
}

function repoOf(f: Facts, svc: string) {
  const repo = f.github.data?.repos[`Azure/osdu-spi-${svc}`];
  if (!repo) throw new Error(`fixture has ${svc}`);
  return repo;
}

function runsOf(f: Facts, svc: string) {
  const runs = f.runs.data?.[`Azure/osdu-spi-${svc}`];
  if (!runs) throw new Error(`fixture has ${svc} runs`);
  return runs;
}

function run(
  svc: string,
  name: string,
  path: string,
  at: string,
  status = "completed",
  conclusion?: string,
): RunFact {
  const id = seq++;
  return {
    id,
    name,
    path,
    event: name === "Validation" ? "push" : "workflow_dispatch",
    status,
    ...(status === "completed" ? { conclusion: conclusion ?? "success" } : {}),
    createdAt: at,
    updatedAt: status === "completed" ? new Date(Date.parse(at) + 12 * MIN).toISOString() : at,
    branch: "main",
    sha: `f${String(id).padStart(39, "0")}`,
    title: name,
    url: `https://github.com/Azure/osdu-spi-${svc}/actions/runs/${id}`,
    attempt: 1,
  };
}

function validation(svc: string, state: "green" | "pending" | "red") {
  const id = seq++;
  return {
    id,
    name: "Validation Summary",
    workflow: "Validation",
    runId: id,
    status: state === "pending" ? "IN_PROGRESS" : "COMPLETED",
    ...(state === "pending" ? {} : { conclusion: state === "green" ? "SUCCESS" : "FAILURE" }),
    url: `https://github.com/Azure/osdu-spi-${svc}/actions/runs/${id}/job/${id}`,
  };
}

// The template rollout has finished: every template-sync PR merged and no lane is held.
export function templateDone(f: Facts): Facts {
  for (const repo of Object.values(f.github.data?.repos ?? {})) {
    repo.prs = repo.prs.filter((p) => !p.head.startsWith("template-sync/"));
    for (const p of repo.prs) {
      p.checks = p.checks.map((c) =>
        c.status === "COMPLETED" ? c : { ...c, status: "COMPLETED", conclusion: "SUCCESS" },
      );
    }
  }
  for (const runs of Object.values(f.runs.data ?? {})) {
    for (const list of [runs.sync, runs.template, runs.cascade, runs.main]) {
      for (const r of list) {
        if (r.status === "completed") continue;
        r.status = "completed";
        r.conclusion = "success";
      }
    }
  }
  return f;
}

// The fork's queued commits now sit in fork_upstream: nothing left upstream.
function caughtUp(f: Facts, svc: string): void {
  const up = f.upstream.data?.[svc];
  if (up) {
    up.lag = 0;
    up.commits = [];
  }
  const radar = f.radar.data?.services[svc];
  if (radar) radar.queued = [];
}

function tracking(f: Facts, svc: string, labels: string[]): number {
  const repo = repoOf(f, svc);
  const number = 500 + (seq++ % 400);
  repo.issues = [
    ...repo.issues.filter((i) => !/Upstream Sync/i.test(i.title)),
    {
      repo: repo.repo,
      number,
      title: "📥 Upstream Sync Ready for Review - 2026-11-04",
      url: `https://github.com/${repo.repo}/issues/${number}`,
      createdAt: ago(120),
      updatedAt: ago(30),
      author: "osdu-spi-automation",
      bot: true,
      labels,
      comments: 1,
    },
  ];
  return number;
}

function syncPrFact(f: Facts, svc: string, state: "green" | "pending" | "red"): PrFact {
  const repo = repoOf(f, svc);
  const number = 300 + (seq++ % 200);
  return {
    repo: repo.repo,
    number,
    title: "⬆️ Sync with upstream 1a2b3c4d",
    url: `https://github.com/${repo.repo}/pull/${number}`,
    createdAt: ago(120),
    updatedAt: ago(100),
    draft: false,
    head: "sync/upstream-20261104-180012",
    base: "fork_upstream",
    headSha: `5${String(number).padStart(39, "0")}`,
    author: "osdu-spi-automation",
    authorApp: true,
    labels: ["upstream-sync", "human-required"],
    checks: [validation(svc, state)],
  };
}

// The 18:00 schedule, or a Prepare, opened a sync PR and its tracking issue.
export function prepared(f: Facts, svc: string, state: "green" | "pending" | "red" = "green") {
  const repo = repoOf(f, svc);
  repo.prs = [
    ...repo.prs.filter((p) => !p.head.startsWith("sync/upstream-")),
    syncPrFact(f, svc, state),
  ];
  tracking(f, svc, ["upstream-sync", "human-required"]);
}

function syncMerged(f: Facts, svc: string, at: number): void {
  const repo = repoOf(f, svc);
  const pr =
    repo.prs.find((p) => p.head.startsWith("sync/upstream-")) ?? syncPrFact(f, svc, "green");
  repo.prs = repo.prs.filter((p) => p !== pr);
  repo.pastPrs = [
    {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      head: pr.head,
      base: "fork_upstream",
      createdAt: pr.createdAt,
      mergedAt: ago(at),
    },
    ...(repo.pastPrs ?? []),
  ];
  caughtUp(f, svc);
}

// Start pressed: the sync PR merged and the cascade runs now.
export function cascading(f: Facts, svc: string) {
  prepared(f, svc);
  syncMerged(f, svc, 20);
  tracking(f, svc, ["upstream-sync", "cascade-active"]);
  runsOf(f, svc).cascade.unshift(
    run(svc, "Cascade Integration", ".github/workflows/cascade.yml", ago(19), "in_progress"),
  );
}

// The cascade went green and opened Sync to Main; it validates on a lane or waits for review.
export function toMain(f: Facts, svc: string, how: "validating" | "review") {
  prepared(f, svc);
  syncMerged(f, svc, 90);
  tracking(f, svc, ["upstream-sync", "validated"]);
  runsOf(f, svc).cascade.unshift(
    run(svc, "Cascade Integration", ".github/workflows/cascade.yml", ago(88)),
  );
  const repo = repoOf(f, svc);
  const number = 700 + (seq++ % 200);
  repo.prs.push({
    repo: repo.repo,
    number,
    title: "⬆️ Upstream Integration to Main 1a2b3c4d",
    url: `https://github.com/${repo.repo}/pull/${number}`,
    createdAt: ago(70),
    updatedAt: ago(10),
    draft: false,
    head: "release/upstream-20261104-223012",
    base: "main",
    headSha: `7${String(number).padStart(39, "0")}`,
    reviewDecision: how === "review" ? "REVIEW_REQUIRED" : "APPROVED",
    author: "osdu-spi-automation",
    authorApp: true,
    labels: ["upstream-sync", "human-required"],
    checks: [validation(svc, how === "validating" ? "pending" : "green")],
  });
}

// Sync to Main merged and its main run went green: the fork is on main.
export function onMain(f: Facts, svc: string, at = 60) {
  prepared(f, svc);
  syncMerged(f, svc, at + 90);
  runsOf(f, svc).cascade.unshift(
    run(svc, "Cascade Integration", ".github/workflows/cascade.yml", ago(at + 88)),
  );
  const repo = repoOf(f, svc);
  repo.issues = repo.issues.filter((i) => !/Upstream Sync/i.test(i.title));
  const number = 700 + (seq++ % 200);
  repo.pastPrs = [
    {
      number,
      title: "⬆️ Upstream Integration to Main 1a2b3c4d",
      url: `https://github.com/${repo.repo}/pull/${number}`,
      head: "release/upstream-20261104-200012",
      base: "main",
      createdAt: ago(at + 60),
      mergedAt: ago(at),
    },
    ...(repo.pastPrs ?? []),
  ];
  runsOf(f, svc).main.unshift(
    run(
      svc,
      "Validation",
      ".github/workflows/validate.yml",
      new Date(Date.parse(ago(at)) + 20_000).toISOString(),
    ),
  );
}

export function cascadeJob(svc: string, reason: string): JobDetail {
  return {
    id: seq++,
    name: "Validate integration",
    status: "completed",
    conclusion: "failure",
    url: `https://github.com/Azure/osdu-spi-${svc}/actions/runs/1/job/2`,
    steps: [],
    failedStep: "Maven build (core,azure)",
    reason,
    attempt: 1,
  };
}

// The cascade's Maven build failed: a validation-failed issue, the tracking issue blocked.
export function stopped(f: Facts, svc: string, reason: string, fixed = false) {
  prepared(f, svc);
  syncMerged(f, svc, 80);
  tracking(f, svc, ["upstream-sync", "cascade-blocked"]);
  const failed = run(
    svc,
    "Cascade Integration",
    ".github/workflows/cascade.yml",
    ago(78),
    "completed",
    "failure",
  );
  const runs = runsOf(f, svc);
  runs.cascade = [
    failed,
    ...runs.cascade.filter((r) => r.conclusion !== "failure" || r.id < 990_000),
  ];
  runs.cascadeRunJobs = { [String(failed.id)]: [cascadeJob(svc, reason)] };
  runs.integration = { sha: "1".repeat(40), at: fixed ? ago(15) : ago(75) };
  const repo = repoOf(f, svc);
  const number = 800 + (seq++ % 100);
  repo.issues = repo.issues.filter((i) => !i.labels.includes("validation-failed"));
  repo.issues.push({
    repo: repo.repo,
    number,
    title: "🚨 Integration Validation Failed: Build/Test Errors - 2026-11-04",
    url: `https://github.com/${repo.repo}/issues/${number}`,
    createdAt: ago(66),
    updatedAt: ago(66),
    author: "osdu-spi-automation",
    bot: true,
    labels: ["validation-failed", "cascade-blocked", "high-priority", "human-required"],
    comments: 0,
  });
}

// An env-upgrade in flight holds the shared environment.
export function envHeld(f: Facts): Facts {
  const lc = f.lifecycle.data;
  if (!lc) throw new Error("fixture has lifecycle runs");
  const id = seq++;
  lc.upgrade = [
    {
      id,
      name: "env-upgrade",
      path: ".github/workflows/env-upgrade.yml",
      event: "workflow_dispatch",
      status: "in_progress",
      createdAt: ago(8),
      updatedAt: ago(1),
      branch: "main",
      sha: "e".repeat(40),
      title: "env-upgrade",
      url: `https://github.com/Azure/osdu-spi-stack/actions/runs/${id}`,
      attempt: 1,
      kind: "upgrade",
    },
    ...(lc.upgrade ?? []),
  ];
  return f;
}

const STORAGE_ERROR =
  "[ERROR] /home/runner/work/osdu-spi-storage/provider/storage-azure/src/main/java/org/opengroup/osdu/storage/provider/azure/StorageAzureConfig.java:[42,8] cannot find symbol: class TenantFactory";
const FILE_ERROR =
  "[ERROR] /home/runner/work/osdu-spi-file/provider/file-azure/src/main/java/org/opengroup/osdu/file/provider/azure/FileAzureConfig.java:[31,15] cannot find symbol: class TenantFactory";

// 1 · The recorded sweep: nothing started, the plan proposed.
export function planReadyFacts(): Facts {
  return upstreamFacts();
}

// 2 · The pilot pressed: partition and indexer-queue in cascade, wave 1 prepared by the schedule.
export function pilotFacts(): Facts {
  const f = templateDone(upstreamFacts());
  cascading(f, "partition");
  cascading(f, "indexer-queue");
  for (const svc of ["entitlements", "schema", "file", "storage", "indexer"]) prepared(f, svc);
  return f;
}

// 3 · Wave 1 under way: the gates come to you (one Start, one Review), storage stopped.
export function waveFacts(): Facts {
  const f = templateDone(upstreamFacts());
  onMain(f, "partition", 120);
  onMain(f, "indexer-queue", 100);
  prepared(f, "file");
  toMain(f, "schema", "review");
  stopped(f, "storage", STORAGE_ERROR);
  toMain(f, "entitlements", "validating");
  toMain(f, "indexer", "validating");
  for (const svc of ["search", "workflow", "unit", "crs-conversion", "legal"]) prepared(f, svc);
  return f;
}

// 4 · One fork stopped in cascade, its fix landed on fork_integration: Re-run opens.
export function stoppedFacts(): Facts {
  const f = waveFacts();
  stopped(f, "storage", STORAGE_ERROR, true);
  return f;
}

// 5 · storage and file fail the cascade on the same first error: the wave pauses.
export function pausedFacts(): Facts {
  const f = waveFacts();
  stopped(f, "file", FILE_ERROR);
  return f;
}

// 6 · An env-upgrade holds the environment while storage's fix has landed: Start and Re-run wait.
export function heldFacts(): Facts {
  return envHeld(stoppedFacts());
}

export const UPSTREAM_STATES: Record<string, () => Facts> = {
  "plan-ready": planReadyFacts,
  "pilot-cascade": pilotFacts,
  "wave-gates": waveFacts,
  "fork-stopped": stoppedFacts,
  "same-cause": pausedFacts,
  "env-held": heldFacts,
};
