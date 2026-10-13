import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibExec } from "@keelson/shared";
import { engineeringBoard } from "../src/boards/engineering";
import { emptyFacts, type LifecycleRun } from "../src/facts";
import { Store } from "../src/store";
import { Sweeper } from "../src/sweep";
import { FIXTURE_NOW, failingExec, fixtureFacts } from "./harness";

const RUN_ID = 900;

function job(status: string, conclusion: string | null, verify: [string, string | null]) {
  return {
    id: 901,
    name: "verify",
    status,
    conclusion,
    started_at: "2026-10-12T21:50:00Z",
    completed_at: status === "completed" ? "2026-10-12T22:20:00Z" : null,
    html_url: "https://github.com/Azure/osdu-spi-stack/actions/runs/900/job/901",
    steps: [
      {
        number: 1,
        name: "Wait for Flux Kustomizations to be Ready",
        status: verify[0],
        conclusion: verify[1],
      },
      { number: 2, name: "Clear maintenance", status: verify[0], conclusion: verify[1] },
    ],
  };
}

function inflightRun(): LifecycleRun {
  return {
    id: RUN_ID,
    kind: "upgrade",
    name: "Environment Upgrade",
    path: ".github/workflows/env-upgrade.yml",
    event: "push",
    status: "in_progress",
    createdAt: "2026-10-12T21:42:00Z",
    updatedAt: "2026-10-12T21:50:00Z",
    sha: "abc",
    title: "chore(env): bump shared stackVersion to v0.28.2 (#335)",
    url: "https://github.com/Azure/osdu-spi-stack/actions/runs/900",
    attempt: 1,
    target: "v0.28.2",
    jobs: [
      {
        id: 901,
        name: "verify",
        status: "in_progress",
        startedAt: "2026-10-12T21:50:00Z",
        url: "https://github.com/Azure/osdu-spi-stack/actions/runs/900/job/901",
        steps: [
          { number: 1, name: "Wait for Flux Kustomizations to be Ready", status: "in_progress" },
          { number: 2, name: "Clear maintenance", status: "queued" },
        ],
      },
    ],
  };
}

// Answers the two calls the in-flight poll makes; anything else fails.
function pollExec(state: { done: boolean }): RibExec {
  const fail = failingExec();
  return {
    runJSON: async <T>(cmd: string, args: string[]) => {
      const path = args[1] ?? "";
      if (cmd === "gh" && path === `repos/Azure/osdu-spi-stack/actions/runs/${RUN_ID}`) {
        return {
          ok: true as const,
          data: {
            id: RUN_ID,
            name: "Environment Upgrade",
            path: ".github/workflows/env-upgrade.yml",
            event: "push",
            status: state.done ? "completed" : "in_progress",
            conclusion: state.done ? "success" : null,
            created_at: "2026-10-12T21:42:00Z",
            updated_at: "2026-10-12T22:20:00Z",
            head_branch: "main",
            head_sha: "abc",
            display_title: "chore(env): bump shared stackVersion to v0.28.2 (#335)",
            html_url: "https://github.com/Azure/osdu-spi-stack/actions/runs/900",
            run_attempt: 1,
          } as T,
        };
      }
      if (
        cmd === "gh" &&
        path.startsWith(`repos/Azure/osdu-spi-stack/actions/runs/${RUN_ID}/jobs`)
      ) {
        const jobs = state.done
          ? [job("completed", "success", ["completed", "success"])]
          : [job("in_progress", null, ["in_progress", null])];
        jobs[0]!.steps[1] = state.done
          ? { number: 2, name: "Clear maintenance", status: "completed", conclusion: "success" }
          : { number: 2, name: "Clear maintenance", status: "queued", conclusion: null };
        return { ok: true as const, data: jobs as T };
      }
      return fail.runJSON<T>(cmd, args);
    },
    runText: fail.runText,
  };
}

describe("the in-flight poll", () => {
  test("recomposes only when the run moved, and sweeps once it settles", async () => {
    const store = new Store(undefined);
    const facts = emptyFacts();
    facts.lifecycle = {
      at: FIXTURE_NOW.toISOString(),
      data: { refresh: [], upgrade: [inflightRun()], smoke: [], sweeper: [] },
    };
    store.write("facts.json", facts);
    const state = { done: false };
    let changes = 0;
    const sweeper = new Sweeper({
      exec: pollExec(state),
      store,
      onChange: () => changes++,
      now: () => FIXTURE_NOW,
    });
    expect(sweeper.hasInflight()).toBe(true);

    await sweeper.pollInflight();
    expect(changes).toBe(0);

    state.done = true;
    await sweeper.pollInflight();
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(sweeper.hasInflight()).toBe(false);
    expect(sweeper.model.stack.maintenance.state).toBe("clear");
  });

  test("a Sync Template dispatch reads starting, then queued, then settles into a sweep", async () => {
    const LEGAL = "Azure/osdu-spi-legal";
    const store = new Store(undefined);
    const facts = fixtureFacts();
    facts.lifecycle = emptyFacts().lifecycle;
    store.write("facts.json", facts);
    const state: { run?: { status: string; conclusion: string | null } } = {};
    const fail = failingExec();
    const reads: string[] = [];
    const exec: RibExec = {
      runJSON: async <T>(cmd: string, args: string[]) => {
        const path = args[1] ?? "";
        if (path.startsWith(`repos/${LEGAL}/actions/workflows/sync-template.yml/runs`)) {
          reads.push(path);
          const runs = state.run
            ? [
                {
                  id: 77,
                  name: "Sync Template",
                  path: ".github/workflows/sync-template.yml",
                  event: "workflow_dispatch",
                  ...state.run,
                  created_at: "2026-10-12T21:58:33Z",
                  updated_at: "2026-10-12T21:58:40Z",
                  head_branch: "main",
                  head_sha: "abc",
                  display_title: "Sync Template",
                  html_url: `https://github.com/${LEGAL}/actions/runs/77`,
                  run_attempt: 1,
                },
              ]
            : [];
          return { ok: true as const, data: runs as T };
        }
        return fail.runJSON<T>(cmd, args);
      },
      runText: fail.runText,
    };
    const sweeper = new Sweeper({ exec, store, onChange: () => {}, now: () => FIXTURE_NOW });
    expect(sweeper.hasInflight()).toBe(false);

    sweeper.expectTemplateRuns([LEGAL], FIXTURE_NOW.toISOString());
    expect(sweeper.hasInflight()).toBe(true);
    const cell = () => {
      const table = engineeringBoard(sweeper.model, FIXTURE_NOW).sections.find(
        (x) => x.kind === "table",
      );
      if (table?.kind !== "table") throw new Error("rollout table");
      const row = table.rows.find((r) => (r.fork as { value: string }).value === "legal");
      return String((row?.sync as { value: string } | undefined)?.value).replaceAll("\u00a0", " ");
    };
    expect(cell()).toMatch(/^↻ starting · \d\d:\d\d$/);

    await sweeper.pollInflight();
    expect(reads).toHaveLength(1);
    expect(cell()).toStartWith("↻ starting");

    state.run = { status: "queued", conclusion: null };
    await sweeper.pollInflight();
    expect(cell()).toMatch(/^↻ queued · \d\d:\d\d$/);
    expect(sweeper.model.template.rows.find((r) => r.service === "legal")?.dispatched).toBe(
      undefined,
    );

    state.run = { status: "completed", conclusion: "success" };
    await sweeper.pollInflight();
    expect(sweeper.hasInflight()).toBe(false);
    expect(cell()).toMatch(/^● \d\d:\d\d$/);
    expect(sweeper.facts.sweep?.at).toBe(FIXTURE_NOW.toISOString());
  });

  test("a fork GitLab has not been read for is read on the next sweep, not after the cadence", async () => {
    const glabCalls = async (drop: string | undefined) => {
      const store = new Store(mkdtempSync(join(tmpdir(), "rib-spi-test-")));
      const facts = fixtureFacts();
      facts.upstream.at = FIXTURE_NOW.toISOString();
      if (drop) delete facts.upstream.data?.[drop];
      store.write("facts.json", facts);
      const exec = failingExec();
      const sweeper = new Sweeper({ exec, store, onChange: () => {}, now: () => FIXTURE_NOW });
      await sweeper.sweep();
      return exec.calls.filter((c) => c.cmd === "glab" && c.args[0] === "api").length;
    };
    expect(await glabCalls(undefined)).toBe(0);
    expect(await glabCalls("file")).toBeGreaterThan(0);
  });

  test("a sweep with gh and glab unreachable records errors and keeps rendering", async () => {
    const sweeper = new Sweeper({
      exec: failingExec(),
      store: new Store(undefined),
      onChange: () => {},
    });
    await sweeper.sweep({ force: true });
    expect(sweeper.facts.github.error).toContain("gh");
    expect(sweeper.facts.auth.data?.gh.ok).toBe(false);
    expect(sweeper.model.measured).toBe(false);
    expect(sweeper.facts.sweep?.errors).toBeGreaterThan(0);
  });
});
