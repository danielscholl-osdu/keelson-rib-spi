import { describe, expect, test } from "bun:test";
import type { JobDetail, LifecycleRun } from "../src/facts";
import {
  attemptText,
  buildStack,
  inferMaintenance,
  inferRunning,
  overdue,
  usualText,
  viewRun,
} from "../src/model/stack";

let nextId = 1;

function job(
  name: string,
  steps: [string, string | undefined, string?][],
  over: Partial<JobDetail> = {},
): JobDetail {
  const id = nextId++;
  const s = steps.map(([n, conclusion, status], i) => ({
    number: i + 1,
    name: n,
    status: status ?? (conclusion ? "completed" : "queued"),
    conclusion,
  }));
  const failed = s.find((x) => x.conclusion === "failure");
  return {
    id,
    name,
    status: s.every((x) => x.status === "completed") ? "completed" : "in_progress",
    conclusion: failed
      ? "failure"
      : s.every((x) => x.conclusion === "success" || x.conclusion === "skipped")
        ? "success"
        : undefined,
    url: `https://github.com/Azure/osdu-spi-stack/actions/runs/1/job/${id}`,
    steps: s,
    failedStep: failed?.name,
    ...over,
  };
}

function run(
  kind: "refresh" | "upgrade",
  createdAt: string,
  conclusion: string | undefined,
  jobs: JobDetail[],
  over: Partial<LifecycleRun> = {},
): LifecycleRun {
  return {
    id: nextId++,
    kind,
    name: kind === "upgrade" ? "Environment Upgrade" : "Environment Refresh",
    path: `.github/workflows/env-${kind}.yml`,
    event: "schedule",
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    createdAt,
    updatedAt: createdAt,
    sha: "abc",
    title:
      kind === "upgrade"
        ? "chore(env): bump shared stackVersion to v0.28.1 (#329)"
        : "Environment Refresh",
    url: `https://github.com/Azure/osdu-spi-stack/actions/runs/${nextId}`,
    attempt: 1,
    jobs,
    ...over,
  };
}

const greenRefresh = (at: string) =>
  run(
    "refresh",
    at,
    "success",
    [
      job("refresh", [
        ["Quiesce (set maintenance)", "success"],
        ["Verify stack version and source suspension are unchanged", "success"],
        ["Clear maintenance", "success"],
      ]),
    ],
    { target: "v0.28.0" },
  );

const failedUpgrade = (at: string) =>
  run(
    "upgrade",
    at,
    "failure",
    [
      job("quiesce-existing-environment", [["Set maintenance", "success"]]),
      job("provision", [["spi up", "failure"]], {
        reason: "Deployment failed: GitLab API unreachable after 3 attempts",
      }),
      job("verify", [], { status: "completed", conclusion: "skipped" }),
    ],
    { target: "v0.28.1" },
  );

const cancelledUpgrade = (at: string) => {
  const verify = job("verify", [["Wait for Flux Kustomizations to be Ready", "cancelled"]], {
    conclusion: "cancelled",
  });
  verify.steps[0]!.startedAt = "2026-10-12T20:37:00Z";
  verify.steps[0]!.completedAt = "2026-10-12T21:39:00Z";
  return run(
    "upgrade",
    at,
    "cancelled",
    [job("quiesce-existing-environment", [["Set maintenance", "success"]]), verify],
    { target: "v0.28.1", event: "workflow_dispatch", title: "Environment Upgrade" },
  );
};

const driftRefresh = (at: string) =>
  run(
    "refresh",
    at,
    "failure",
    [
      job(
        "refresh",
        [
          ["Quiesce (set maintenance)", "success"],
          ["Verify stack version and source suspension are unchanged", "failure"],
          ["Clear maintenance", "skipped"],
        ],
        { reason: "deployed ref (v0.28.0) drifted from declared stackVersion (v0.28.1)" },
      ),
    ],
    { target: "v0.28.1" },
  );

describe("remote-mode inference", () => {
  test("a run that set maintenance and never cleared it leaves it set", () => {
    const m = inferMaintenance([
      greenRefresh("2026-10-11T21:41:00Z"),
      failedUpgrade("2026-10-11T22:44:00Z"),
    ]);
    expect(m.state).toBe("set");
    expect(inferMaintenance([greenRefresh("2026-10-11T21:41:00Z")]).state).toBe("clear");
  });

  test("a refresh that failed on drift names the running version", () => {
    const running = inferRunning([
      greenRefresh("2026-10-11T21:41:00Z"),
      failedUpgrade("2026-10-11T22:44:00Z"),
      driftRefresh("2026-10-12T04:16:00Z"),
    ]);
    expect(running).toEqual({
      version: "v0.28.0",
      source: "env-refresh drift check",
      at: "2026-10-12T04:16:00Z",
    });
  });

  test("every attempt since the last green run is kept in order, the one that set maintenance marked", () => {
    const stack = buildStack(
      undefined,
      {
        refresh: [greenRefresh("2026-10-11T21:41:00Z"), driftRefresh("2026-10-12T04:16:00Z")],
        upgrade: [failedUpgrade("2026-10-11T22:44:00Z")],
      },
      new Date("2026-10-12T21:00:00Z"),
    );
    expect(stack.lastGreen?.kind).toBe("refresh");
    expect(stack.attempts.map((v) => v.run.kind)).toEqual(["upgrade", "refresh"]);
    expect(attemptText(stack.attempts[0]!, stack.maintenance.run?.id)).toBe(
      "env-upgrade v0.28.1 failed in provision › spi up: GitLab API unreachable while resolving images · set maintenance",
    );
    expect(stack.deployable.state).toBe("no");
    expect(stack.lifecycle.refresh).toMatchObject({
      green: 1,
      total: 2,
      streak: { green: false, n: 1 },
    });
  });

  test("stages a finished run never reached read as skipped, not waiting", () => {
    const view = viewRun(failedUpgrade("2026-10-11T22:44:00Z"));
    expect(view.stages.find((s) => s.label === "provision")?.state).toBe("failed");
    expect(view.stages.find((s) => s.label === "clear")?.state).toBe("skipped");
    expect(view.stages.some((s) => s.state === "waits")).toBe(false);
  });

  test("an upgrade in flight blocks deployment and shows where it is", () => {
    const inflight = run("upgrade", "2026-10-12T21:40:00Z", undefined, [
      job("quiesce-existing-environment", [["Set maintenance", "success"]]),
      job("provision", [["spi up", "success"]]),
      job("verify", [
        ["Wait for Flux Kustomizations to be Ready", undefined, "in_progress"],
        ["Clear maintenance", undefined],
      ]),
    ]);
    const stack = buildStack(undefined, { upgrade: [inflight] }, new Date("2026-10-12T21:50:00Z"));
    expect(stack.inflight?.current).toBe("verify");
    expect(stack.deployable).toEqual({ state: "no", reason: "env-upgrade in flight (verify)" });
  });

  test("a retry keeps the hold dated from the run that first set it", () => {
    const m = inferMaintenance([
      greenRefresh("2026-10-11T21:41:00Z"),
      failedUpgrade("2026-10-11T22:44:00Z"),
      cancelledUpgrade("2026-10-12T20:20:00Z"),
    ]);
    expect(m.state).toBe("set");
    expect(m.since).toBe("2026-10-11T22:44:00Z");
  });

  test("a cancelled attempt says where it stopped and how long it waited there", () => {
    expect(attemptText(viewRun(cancelledUpgrade("2026-10-12T20:20:00Z")))).toBe(
      "env-upgrade v0.28.1 (dispatched) cancelled after 1h 2m in verify › Wait for Flux Kustomizations to be Ready",
    );
  });

  test("the step in flight is measured against the same step on green runs", () => {
    const green = (at: string, took: [string, string]) =>
      run(
        "upgrade",
        at,
        "success",
        [
          job("verify", [
            ["Wait for Flux Kustomizations to be Ready", "success"],
            ["Clear maintenance", "success"],
          ]),
        ].map((j) => {
          j.steps[0]!.startedAt = took[0];
          j.steps[0]!.completedAt = took[1];
          return j;
        }),
        { target: "v0.28.0" },
      );
    const live = run("upgrade", "2026-10-12T21:42:00Z", undefined, [
      job("verify", [
        ["Wait for Flux Kustomizations to be Ready", undefined, "in_progress"],
        ["Clear maintenance", undefined],
      ]),
    ]);
    live.jobs![0]!.steps[0]!.startedAt = "2026-10-12T21:58:00Z";
    const runs = {
      upgrade: [
        green("2026-10-02T03:13:00Z", ["2026-10-02T03:20:00Z", "2026-10-02T03:21:00Z"]),
        green("2026-10-06T02:32:00Z", ["2026-10-06T02:50:00Z", "2026-10-06T03:02:00Z"]),
        live,
      ],
    };
    const early = buildStack(undefined, runs, new Date("2026-10-12T22:08:00Z"));
    expect(early.inflight?.at).toMatchObject({
      stage: "verify",
      step: "Wait for Flux Kustomizations to be Ready",
      startedAt: "2026-10-12T21:58:00Z",
    });
    expect(usualText(early.usual)).toBe("green runs 1–12 min");
    expect(overdue(early, new Date("2026-10-12T22:08:00Z"))).toBe(false);
    expect(overdue(early, new Date("2026-10-12T22:29:00Z"))).toBe(true);
  });
});
