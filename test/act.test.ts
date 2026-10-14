import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView, type OpHandle, type RibContext, type RibExec } from "@keelson/shared";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import { readReadiness } from "../src/act/readiness";
import {
  DeployableWait,
  DISPATCH_REFRESH,
  laneTargets,
  NO_OPS,
  RERUN_LANES,
  WAIT_ACTION,
} from "../src/act/rerun";
import { changed } from "../src/act/revalidate";
import { type Binding, registerVerb, type Target, verbAction } from "../src/act/verbs";
import { actChecks, doctorRow } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { tokenScopes } from "../src/forge";
import rib from "../src/index";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import type { QueueItem } from "../src/model/queue";
import { INSPECT_ACTION } from "../src/surfaces";
import { FIXTURE_NOW, fakeContext, fixtureFacts, laneFacts } from "./harness";

const NOW = () => new Date("2026-10-13T16:00:00Z");

const PR: Target = {
  repo: "Azure/osdu-spi-legal",
  kind: "pr",
  number: 31,
  sha: "aaaaaaa1111",
  state: "open",
  label: "legal #31",
};
const RUN: Target = {
  repo: "Azure/osdu-spi-file",
  kind: "run",
  number: 41000103,
  sha: "bbbbbbb2222",
  state: "failure",
  label: "file run 41000103",
};

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

function testVerb() {
  const verb = {
    id: "poke",
    label: "Poke",
    command: (t: Target) => ["api", "-X", "POST", `repos/${t.repo}/poke/${t.number}`],
  };
  unregister = registerVerb(verb);
  return verb;
}

// GitHub as the verb finds it: reads answer from `now`, writes record and succeed
// unless the path is listed in `failWrites`.
function github(
  now: Record<string, { sha?: string; state?: string } | Error>,
  failWrites: string[] = [],
) {
  const writes: string[][] = [];
  const exec: RibExec = {
    runJSON: async (_cmd: string, args: string[]) => {
      const path = args[1] ?? "";
      const hit = Object.entries(now).find(([k]) => path.endsWith(k))?.[1];
      if (!hit) return { ok: false as const, error: `no fake for ${path}`, code: 1 };
      if (hit instanceof Error) return { ok: false as const, error: hit.message, code: 1 };
      const state = hit.state ?? "open";
      const data = path.includes("/pulls/")
        ? { state: state === "merged" ? "closed" : state, merged: state === "merged", sha: hit.sha }
        : { status: "completed", conclusion: state, sha: hit.sha };
      return { ok: true as const, data: data as never };
    },
    runText: async (_cmd: string, args: string[]) => {
      writes.push(args);
      const path = args[3] ?? "";
      return failWrites.some((f) => path.includes(f))
        ? { ok: false as const, error: "HTTP 403: Resource not accessible", code: 1 }
        : { ok: true as const, data: "" };
    },
  };
  return { exec, writes };
}

function binding(targets: Target[]): Binding {
  return { verb: "poke", item: "gate1:legal", swept: "2026-10-13T15:55:00Z", targets };
}

describe("the action path", () => {
  test("an unchanged target is written, logged and reswept", async () => {
    testVerb();
    const { exec, writes } = github({ "pulls/31": { sha: PR.sha, state: "open" } });
    const log = new ActionLog(undefined);
    let resweeps = 0;
    const res = await act(binding([PR]), { exec, log, resweep: () => resweeps++, now: NOW });
    expect(res).toEqual({ ok: true, data: { message: "Poke: 1 of 1 done" } });
    expect(writes).toEqual([["api", "-X", "POST", "repos/Azure/osdu-spi-legal/poke/31"]]);
    expect(resweeps).toBe(1);
    expect(log.lastFor("gate1:legal")?.results).toEqual([{ target: "legal #31", outcome: "done" }]);
  });

  test("a target that moved since the board drew it is refused without a write", async () => {
    testVerb();
    const { exec, writes } = github({ "pulls/31": { sha: "ccccccc3333", state: "open" } });
    const log = new ActionLog(undefined);
    let resweeps = 0;
    const res = await act(binding([PR]), { exec, log, resweep: () => resweeps++, now: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("legal #31 skipped (head moved aaaaaaa → ccccccc)");
    expect(res.error).toContain("the board redraws");
    expect(writes).toEqual([]);
    expect(resweeps).toBe(1);
  });

  test("a set reports each target: done, skipped because it changed, or failed with gh's error", async () => {
    testVerb();
    const { exec, writes } = github(
      {
        "pulls/31": { sha: PR.sha, state: "merged" },
        "runs/41000103": { sha: RUN.sha, state: "failure" },
        "runs/41000104": new Error("HTTP 404"),
        "runs/41000105": { sha: "ddddddd4444", state: "failure" },
      },
      ["41000105"],
    );
    const extra = { ...RUN, number: 41000104, label: "schema run 41000104" };
    const failing = {
      ...RUN,
      number: 41000105,
      sha: "ddddddd4444",
      label: "entitlements run 41000105",
    };
    const log = new ActionLog(undefined);
    const res = await act(binding([PR, RUN, extra, failing]), {
      exec,
      log,
      resweep: () => {},
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(2);
    expect(log.lastFor("gate1:legal")?.results.map((r) => [r.target, r.outcome])).toEqual([
      ["legal #31", "refused"],
      ["file run 41000103", "done"],
      ["schema run 41000104", "refused"],
      ["entitlements run 41000105", "failed"],
    ]);
    if (res.ok) {
      expect((res.data as { message: string }).message).toStartWith("Poke: 1 of 4 done");
    }
  });

  test("only the stamped binding counts; a missing binding or an unknown verb never writes", async () => {
    testVerb();
    const { exec, writes } = github({ "pulls/31": { sha: PR.sha, state: "open" } });
    const deps = { exec, log: new ActionLog(undefined), resweep: () => {}, now: NOW };
    expect(await act({ verb: "poke" }, deps)).toEqual({
      ok: false,
      error: "act needs the binding the board stamped",
    });
    expect(await act({ ...binding([PR]), verb: "merge-everything" }, deps)).toEqual({
      ok: false,
      error: "spi has no verb 'merge-everything'",
    });
    const res = await act({ ...binding([PR]), comment: "a form field" }, deps);
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test("revalidation compares only what was stamped", () => {
    expect(changed(PR, { sha: PR.sha, state: "open" })).toBeUndefined();
    expect(changed(PR, { sha: PR.sha, state: "merged" })).toBe("now merged, was open");
    expect(
      changed({ ...PR, sha: undefined, state: undefined }, { sha: "x", state: "closed" }),
    ).toBeUndefined();
  });
});

describe("the button", () => {
  test("carries the binding apart from its payload and confirms with the exact commands", () => {
    const verb = testVerb();
    const item = verbAction(verb, {
      item: "gate1:legal",
      swept: "2026-10-13T15:55:00Z",
      targets: [PR, RUN],
    });
    expect(item.binding).toMatchObject({ verb: "poke", item: "gate1:legal" });
    expect(item.payload).toBeUndefined();
    expect(item.label).toBe("Poke 2");
    expect(item.confirm?.body).toContain("gh api -X POST repos/Azure/osdu-spi-legal/poke/31");
    expect(item.confirm?.body).toContain("gh api -X POST repos/Azure/osdu-spi-file/poke/41000103");
    const board = {
      view: "board" as const,
      sections: [{ kind: "actions" as const, items: [item] }],
    };
    expect(() => expectView(INSPECT_KEY, "board")(board)).not.toThrow();
  });

  test("a verb that cannot run renders disabled with its reason and no confirmation", () => {
    const verb = testVerb();
    const item = verbAction(
      verb,
      { item: "template-set", swept: "2026-10-13T15:55:00Z", targets: [PR] },
      { disabled: "2 need review" },
    );
    expect(item).toMatchObject({ disabled: true, reason: "2 need review" });
    expect(item.confirm).toBeUndefined();
  });
});

describe("the action log", () => {
  test("survives a restart and answers the newest entry per item", () => {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-log-"));
    const log = new ActionLog(dir);
    const entry = (at: string, outcome: "done" | "refused") => ({
      at,
      verb: "poke",
      label: "Poke",
      item: "gate1:legal",
      results: [{ target: "legal #31", outcome }],
    });
    log.append(entry("2026-10-13T15:00:00Z", "refused"));
    log.append(entry("2026-10-13T15:10:00Z", "done"));
    const again = new ActionLog(dir);
    expect(again.lastFor("gate1:legal")?.at).toBe("2026-10-13T15:10:00Z");
    expect(again.lastFor("halt:entitlements")).toBeUndefined();
  });

  test("the inspector shows the last action and what it skipped", () => {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW);
    const item = model.queue.items.find((i) => i.id === "gate1:legal");
    const b = inspectBoard(model, { selected: "gate1:legal", item }, FIXTURE_NOW, {
      at: "2026-10-12T21:50:00Z",
      verb: "poke",
      label: "Poke",
      item: "gate1:legal",
      results: [
        { target: "legal #31", outcome: "done" },
        { target: "legal run 9", outcome: "refused", detail: "now success, was failure" },
      ],
    });
    expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
    const last = b.sections.find((s) => s.kind === "rows" && s.title === "Last action");
    if (last?.kind !== "rows") throw new Error("last action");
    expect(last.items.map((r) => r.text)).toEqual([
      "Poke · 1 of 2 done",
      "legal run 9 skipped: now success, was failure",
    ]);
  });
});

describe("readiness", () => {
  test("gh scopes come from the sign-in probe; a fine-grained token lists none", () => {
    expect(tokenScopes("  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n")).toEqual([
      "gist",
      "read:org",
      "repo",
      "workflow",
    ]);
    expect(tokenScopes("  ✓ Logged in to github.com account someone (GH_TOKEN)\n")).toBeUndefined();
  });

  test("projects match forks by git remote, whatever they are named", async () => {
    const exec: RibExec = {
      runJSON: async () => ({ ok: false as const, error: "unused", code: 1 }),
      runText: async (_cmd: string, args: string[]) => {
        const root = args[1] ?? "";
        const remote: Record<string, string> = {
          "/w/legal": "git@github.com:Azure/osdu-spi-legal.git\n",
          "/w/tmpl": "https://github.com/azure/osdu-spi\n",
          "/w/other": "https://github.com/someone/else.git\n",
        };
        return remote[root]
          ? { ok: true as const, data: remote[root] }
          : { ok: false as const, error: "not a git repository", code: 128 };
      },
    };
    const project = (name: string, rootPath: string) => ({
      id: name,
      name,
      rootPath,
      createdAt: "",
    });
    const r = await readReadiness(
      exec,
      [
        project("lgl", "/w/legal"),
        project("t", "/w/tmpl"),
        project("o", "/w/other"),
        project("x", "/w/none"),
      ],
      () => ({ workflow: ["investigate"], approval: [] }),
    );
    expect(r.projects).toEqual({ "Azure/osdu-spi-legal": "lgl", "Azure/osdu-spi": "t" });
    expect(r.grants).toEqual({ workflow: ["investigate"], approval: [] });
  });

  test("the doctor's Act lines name the fix, and never raise the doctor", () => {
    const facts = fixtureFacts();
    if (facts.auth.data) facts.auth.data.gh.scopes = ["repo", "read:org"];
    const lines = actChecks(facts, {
      projects: { "Azure/osdu-spi-legal": "lgl" },
      grants: { workflow: ["investigate"], approval: [] },
    });
    expect(lines.map((c) => [c.label, c.health])).toEqual([
      ["Act · gh scopes", "warn"],
      ["Act · Keelson projects", "warn"],
      ["Act · grants", "warn"],
    ]);
    expect(lines[0]?.value).toBe("missing workflow; run gh auth refresh -s workflow");
    expect(lines[1]?.value).toStartWith("1 of 6; none for ");
    expect(lines[2]?.value).toContain(
      "ribWorkflowGrants lacks spi-classify-entry, spi-absorb-toolchain",
    );
    const row = doctorRow(facts, FIXTURE_NOW, {
      projects: {},
      grants: { workflow: [], approval: [] },
    });
    expect(row?.tone).toBe("ok");
    const detail = row?.section.kind === "rows" ? row.section.items[0]?.detail : undefined;
    expect(detail).toContain("! Act · grants");
  });
});

// Lane runs and lifecycle workflows as gh reads them; writes are recorded and
// fail when they name a run in `failRuns`.
function forge(opts: {
  runs?: Record<number, { status?: string; conclusion?: string }>;
  heads?: Record<number, string>;
  lifecycle?: Record<string, string[]>;
  failRuns?: number[];
}) {
  const writes: string[][] = [];
  const exec: RibExec = {
    runJSON: async (_cmd: string, args: string[]) => {
      const path = args[1] ?? "";
      const wf = /actions\/workflows\/([\w.-]+)\/runs/.exec(path);
      if (wf) return { ok: true as const, data: (opts.lifecycle?.[wf[1] ?? ""] ?? []) as never };
      const run = /actions\/runs\/(\d+)$/.exec(path);
      if (run) {
        const r = opts.runs?.[Number(run[1])] ?? {};
        return {
          ok: true as const,
          data: {
            status: r.status ?? "completed",
            conclusion: r.conclusion ?? "failure",
            sha: "",
          } as never,
        };
      }
      const pr = /pulls\/(\d+)$/.exec(path);
      if (pr) {
        const sha = opts.heads?.[Number(pr[1])];
        return { ok: true as const, data: { state: "open", merged: false, sha } as never };
      }
      return { ok: false as const, error: `no fake for ${path}`, code: 1 };
    },
    runText: async (_cmd: string, args: string[]) => {
      writes.push(args);
      return (opts.failRuns ?? []).some((id) => args.includes(String(id)))
        ? { ok: false as const, error: "HTTP 403: Must have admin rights to Repository.", code: 1 }
        : { ok: true as const, data: "" };
    },
  };
  return { exec, writes };
}

function lanesOf(down: boolean): { item: QueueItem; model: ReturnType<typeof buildModel> } {
  const model = buildModel(laneFacts(down), FIXTURE_NOW);
  const item = model.queue.items.find((i) => i.id === "stack:lanes");
  if (!item?.lanes) throw new Error("fixture has loose lanes");
  return { item, model };
}

function fakeOp(id = "op-1") {
  const abort = new AbortController();
  const events: [string, unknown][] = [];
  const op: OpHandle = {
    id,
    signal: abort.signal,
    log: (m) => events.push(["log", m]),
    progress: (m) => events.push(["progress", m]),
    done: (r) => events.push(["done", r]),
    error: (m) => events.push(["error", m]),
  };
  return { op, events, cancel: () => abort.abort() };
}

describe("the re-run verbs", () => {
  test("Re-run lanes re-runs each lane's failed jobs and names each one it skips or fails", async () => {
    unregister = registerVerb(RERUN_LANES);
    const { item } = lanesOf(false);
    const lanes = item.lanes ?? [];
    const heads = Object.fromEntries(lanes.map((l) => [l.pr, l.headSha]));
    heads[37] = "eeeeeee0000";
    const { exec, writes } = forge({
      heads,
      runs: { 38224167314: { status: "in_progress" } },
      failRuns: [38223915937],
    });
    const log = new ActionLog(undefined);
    const res = await act(
      { verb: RERUN_LANES.id, item: item.id, swept: "s", targets: laneTargets(lanes) },
      { exec, log, resweep: () => {}, now: NOW },
    );
    expect(writes).toEqual([
      ["run", "rerun", "38222934119", "--failed", "-R", "Azure/osdu-spi-partition"],
      ["run", "rerun", "38224153176", "--failed", "-R", "Azure/osdu-spi-entitlements"],
      ["run", "rerun", "38223915937", "--failed", "-R", "Azure/osdu-spi-file"],
    ]);
    expect(res).toEqual({
      ok: true,
      data: {
        message:
          "Re-run lanes: 2 of 5 done · legal #33 skipped (now in_progress, was failure) · schema #37 skipped (head moved 073b651 → eeeeeee) · file #51 failed (HTTP 403: Must have admin rights to Repository.)",
      },
    });
    expect(log.lastFor("stack:lanes")?.results.map((r) => r.outcome)).toEqual([
      "done",
      "done",
      "refused",
      "refused",
      "failed",
    ]);
  });

  test("Re-dispatch is refused while env-refresh or env-upgrade is active, and dispatches otherwise", async () => {
    unregister = registerVerb(DISPATCH_REFRESH);
    const target: Target = {
      repo: "Azure/osdu-spi-stack",
      kind: "workflow",
      state: "idle",
      label: "env-refresh",
    };
    const binding = { verb: DISPATCH_REFRESH.id, item: "stack:1", swept: "s", targets: [target] };
    const deps = (exec: RibExec) => ({
      exec,
      log: new ActionLog(undefined),
      resweep: () => {},
      now: NOW,
    });
    const busy = forge({
      lifecycle: { "env-refresh.yml": ["completed"], "env-upgrade.yml": ["queued", "completed"] },
    });
    const refused = await act(binding, deps(busy.exec));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain(
      "env-refresh skipped (now running, was idle)",
    );
    expect(busy.writes).toEqual([]);
    const idle = forge({
      lifecycle: { "env-refresh.yml": ["completed"], "env-upgrade.yml": ["completed"] },
    });
    expect(await act(binding, deps(idle.exec))).toEqual({
      ok: true,
      data: { message: "Re-dispatch env-refresh: 1 of 1 done" },
    });
    expect(idle.writes).toEqual([
      ["workflow", "run", "env-refresh.yml", "-R", "Azure/osdu-spi-stack"],
    ]);
  });
});

describe("the re-run wait", () => {
  function binding(item: QueueItem) {
    return {
      verb: RERUN_LANES.id,
      item: item.id,
      swept: "s",
      targets: laneTargets(item.lanes ?? []),
    };
  }

  test("waits while the stack is not deployable, then runs the stamped binding once", async () => {
    const down = lanesOf(true);
    const up = lanesOf(false);
    const { op, events } = fakeOp();
    const runs: unknown[] = [];
    const wait = new DeployableWait(op, binding(down.item), "t", down.model.stack, async (b) => {
      runs.push(b);
      return { ok: true, data: { message: "Re-run lanes: 5 of 5 done" } };
    });
    expect(await wait.wake(down.model.stack)).toBe(false);
    expect(runs).toHaveLength(0);
    expect(await wait.wake(up.model.stack)).toBe(true);
    expect(await wait.wake(up.model.stack)).toBe(true);
    expect(runs).toEqual([binding(down.item)]);
    expect(events.at(-1)).toEqual([
      "done",
      { outcome: "re-ran", message: "Re-run lanes: 5 of 5 done" },
    ]);
  });

  test("stands down without writing when a lifecycle run fails again", async () => {
    const down = lanesOf(true);
    const facts = laneFacts(true);
    const lc = facts.lifecycle.data;
    const first = lc?.refresh[0];
    if (!lc || !first) throw new Error("fixture has the failed refresh");
    lc.refresh.unshift({ ...first, id: 99000002, createdAt: "2026-10-12T21:50:00Z" });
    const again = buildModel(facts, FIXTURE_NOW).stack;
    const { op, events } = fakeOp();
    let ran = false;
    const wait = new DeployableWait(op, binding(down.item), "t", down.model.stack, async () => {
      ran = true;
      return { ok: true, data: {} };
    });
    expect(await wait.wake(again)).toBe(true);
    expect(ran).toBe(false);
    const [kind, result] = events.at(-1) ?? [];
    expect(kind).toBe("done");
    expect(result).toMatchObject({ outcome: "stood-down" });
    expect((result as { message: string }).message).toContain("no lane was re-run");
  });

  test("a cancelled wait never writes", async () => {
    const down = lanesOf(true);
    const up = lanesOf(false);
    const { op, events, cancel } = fakeOp();
    let ran = false;
    const wait = new DeployableWait(op, binding(down.item), "t", down.model.stack, async () => {
      ran = true;
      return { ok: true, data: {} };
    });
    cancel();
    expect(await wait.wake(up.model.stack)).toBe(true);
    expect(ran).toBe(false);
    expect(events.some(([k]) => k === "done" || k === "error")).toBe(false);
  });

  describe("through the rib", () => {
    afterEach(async () => {
      await rib.dispose?.();
    });

    function bound(registerOp?: RibContext["registerOp"]) {
      const dir = mkdtempSync(join(tmpdir(), "rib-spi-"));
      writeFileSync(join(dir, "facts.json"), JSON.stringify(laneFacts(true)));
      const { ctx, snapshots } = fakeContext({
        getDataDir: () => dir,
        ...(registerOp ? { registerOp } : {}),
      });
      rib.registerTools?.(ctx);
      return { ctx, snapshots };
    }

    async function lanesInspector(
      ctx: RibContext,
      snapshots: ReturnType<typeof bound>["snapshots"],
    ) {
      await rib.onAction?.({ type: INSPECT_ACTION, payload: { id: "stack:lanes" } }, ctx);
      const frame = await snapshots.recompose(INSPECT_KEY);
      const board = frame.data as ReturnType<typeof inspectBoard>;
      const actions = board.sections.find((s) => s.kind === "actions");
      if (actions?.kind !== "actions") throw new Error("the lanes inspector has actions");
      return actions.items;
    }

    test("on a harness without ops the wait is disabled with its reason and refused", async () => {
      const { ctx, snapshots } = bound();
      const [wait] = await lanesInspector(ctx, snapshots);
      expect(wait).toMatchObject({ type: WAIT_ACTION, disabled: true, reason: NO_OPS });
      const res = await rib.onAction?.({ type: WAIT_ACTION, payload: wait?.binding }, ctx);
      expect(res).toEqual({ ok: false, error: NO_OPS });
    });

    test("the wait is one op that the inspector names until it is cancelled", async () => {
      const ops: {
        kind: string;
        title?: string;
        cancel: () => void;
        events: [string, unknown][];
      }[] = [];
      const { ctx, snapshots } = bound((req) => {
        const { op, events, cancel } = fakeOp(`op-${ops.length + 1}`);
        ops.push({ kind: req.kind, title: req.title, cancel, events });
        return op;
      });
      const [wait] = await lanesInspector(ctx, snapshots);
      expect(wait).toMatchObject({ type: WAIT_ACTION, label: "Re-run when deployable" });
      expect(wait?.confirm?.body).toContain("stands down without writing");
      const res = await rib.onAction?.({ type: WAIT_ACTION, payload: wait?.binding }, ctx);
      expect(res).toEqual({
        ok: true,
        data: {
          message: "Waiting for the stack to read deployable as op op-1; run_cancel drops it",
        },
      });
      expect(ops.map((o) => [o.kind, o.title])).toEqual([
        [WAIT_ACTION, "Re-run 5 fork lanes when the stack is deployable"],
      ]);
      const twice = await rib.onAction?.({ type: WAIT_ACTION, payload: wait?.binding }, ctx);
      expect(twice).toEqual({ ok: false, error: "a wait already holds this item as op op-1" });
      const [held] = await lanesInspector(ctx, snapshots);
      expect(held?.disabled).toBe(true);
      expect(held?.reason).toContain("as op op-1; run_cancel drops it");
      ops[0]?.cancel();
      const [free] = await lanesInspector(ctx, snapshots);
      expect(free?.disabled).toBeUndefined();
      expect(ops[0]?.events.some(([k]) => k === "done" || k === "error")).toBe(false);
    });
  });
});
