// Rollout states built on the recorded sweep, for the tests and for dev/states.ts to replay.
import type { Facts, JobDetail } from "../src/facts";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const MIN = 60_000;

export function headSha(f: Facts): string {
  const sha = f.github.data?.repos["Azure/osdu-spi"]?.head?.sha;
  if (!sha) throw new Error("fixture has a template head");
  return sha;
}

function repoOf(f: Facts, svc: string) {
  const repo = f.github.data?.repos[`Azure/osdu-spi-${svc}`];
  if (!repo) throw new Error(`fixture has ${svc}`);
  return repo;
}

// Approved, with every check green: a PR the rollout may merge.
export function ready(f: Facts, svc: string) {
  const pr = repoOf(f, svc).prs.find((p) => p.head.startsWith("template-sync/"));
  if (!pr) throw new Error(`${svc} has a template-sync PR`);
  pr.reviewDecision = "APPROVED";
  pr.mergeState = "CLEAN";
  pr.checks = pr.checks.map((c) => ({ ...c, status: "COMPLETED", conclusion: "SUCCESS" }));
}

let runId = 99_100_000;

// The fork merged its template-sync PR at `ago` minutes before the fixture's clock; its
// merge pushed one main run that ended as `run` says.
export function merged(
  f: Facts,
  svc: string,
  run: { conclusion?: string; status?: string; attempt?: number; jobs?: JobDetail[] } = {},
  ago = 60,
) {
  const head = headSha(f);
  const t = f.template.data;
  if (!t) throw new Error("fixture has template facts");
  t.compares[head] ??= {
    marker: head,
    head,
    label: "v1.2.0 +14",
    aheadBy: 0,
    shas: [],
    changes: [],
  };
  const repo = repoOf(f, svc);
  const pr = repo.prs.find((p) => p.head.startsWith("template-sync/"));
  if (!pr) throw new Error(`${svc} has a template-sync PR`);
  repo.marker = head;
  repo.prs = repo.prs.filter((p) => p !== pr);
  const at = new Date(FIXTURE_NOW.getTime() - ago * MIN).toISOString();
  repo.pastPrs = [
    {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      head: pr.head,
      base: "main",
      createdAt: pr.createdAt,
      mergedAt: at,
    },
    ...(repo.pastPrs ?? []),
  ];
  const runs = f.runs.data?.[repo.repo];
  if (!runs) throw new Error(`fixture has ${svc} runs`);
  const id = runId++;
  runs.main.unshift({
    id,
    name: "Validation",
    path: ".github/workflows/validate.yml",
    event: "push",
    status: run.status ?? "completed",
    ...(run.status && run.status !== "completed"
      ? {}
      : { conclusion: run.conclusion ?? "success" }),
    createdAt: new Date(Date.parse(at) + 20_000).toISOString(),
    updatedAt: new Date(Date.parse(at) + 20 * MIN).toISOString(),
    branch: "main",
    sha: `m${String(id).padStart(39, "0")}`,
    title: `Merge pull request #${pr.number} from Azure/${pr.head}`,
    url: `https://github.com/${repo.repo}/actions/runs/${id}`,
    attempt: run.attempt ?? 1,
  });
  if (run.jobs) runs.mainRunJobs = { ...(runs.mainRunJobs ?? {}), [String(id)]: run.jobs };
  return id;
}

export function job(environment: string[], attempt = 1): JobDetail {
  return {
    id: 7,
    name: "Deploy and Test",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/Azure/osdu-spi-partition/actions/runs/1/job/7",
    steps: [],
    failedStep: "Run acceptance suite",
    reason: "expected 200 but was 500",
    environment,
    attempt,
  };
}

const FORKS = ["partition", "entitlements", "legal", "schema", "file"];

// Two forks merged and green, three PRs approved and green: merges wait on lanes and order.
export function rollingFacts(): Facts {
  const f = fixtureFacts();
  merged(f, "partition", {}, 90);
  merged(f, "entitlements", { status: "in_progress" }, 10);
  for (const svc of ["legal", "schema", "file"]) ready(f, svc);
  return f;
}

// The first merge's main run failed with no Environment title on any failed job.
export function stoppedFacts(): Facts {
  const f = fixtureFacts();
  merged(f, "partition", {}, 120);
  merged(f, "entitlements", { conclusion: "failure", jobs: [job([])] }, 45);
  ready(f, "legal");
  return f;
}

// The first merge's main run timed out on the shared environment, attempt 1.
export function environmentFacts(): Facts {
  const f = fixtureFacts();
  merged(f, "partition", {
    conclusion: "failure",
    jobs: [job(["Shared environment did not answer within 20m"])],
  });
  return f;
}

// Every fork merged, every main run green, one of them on a second attempt.
export function doneFacts(): Facts {
  const f = fixtureFacts();
  for (const [i, svc] of FORKS.entries()) {
    merged(f, svc, i === 2 ? { attempt: 2 } : {}, 300 - i * 40);
  }
  return f;
}
