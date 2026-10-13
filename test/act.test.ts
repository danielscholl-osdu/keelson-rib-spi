import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView, type RibExec } from "@keelson/shared";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import { readReadiness } from "../src/act/readiness";
import { changed } from "../src/act/revalidate";
import { type Binding, registerVerb, type Target, verbAction } from "../src/act/verbs";
import { actChecks, doctorRow } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { tokenScopes } from "../src/forge";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

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
