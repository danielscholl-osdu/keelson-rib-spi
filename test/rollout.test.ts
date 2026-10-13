import { afterEach, describe, expect, test } from "bun:test";
import { expectView, type RibExec } from "@keelson/shared";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import {
  heldBecause,
  ROLL_OUT,
  ROLLOUT_ITEM,
  rolloutActions,
  rolloutTargets,
  SYNC_FORKS,
  syncTargets,
} from "../src/act/rollout";
import { commandText, registerVerb } from "../src/act/verbs";
import { engineeringBoard } from "../src/boards/engineering";
import type { Facts } from "../src/facts";
import { ENGINEERING_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, NEW_HEAD, releasedFacts } from "./harness";

const SWEPT = { swept: "2026-10-12T21:58:14.428Z" };

function model(edit?: (f: Facts) => void) {
  const f = releasedFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

// Approved, with every check green: a PR Roll out may merge.
function ready(f: Facts, repo: string, number: number) {
  const pr = f.github.data?.repos[repo]?.prs.find((p) => p.number === number);
  if (!pr) throw new Error(`${repo}#${number}`);
  pr.reviewDecision = "APPROVED";
  pr.mergeState = "CLEAN";
  pr.checks = pr.checks.map((c) => ({ ...c, status: "COMPLETED", conclusion: "SUCCESS" }));
}

let unregister: Array<() => void> = [];
afterEach(() => {
  for (const u of unregister) u();
  unregister = [];
});

describe("Sync all forks", () => {
  test("dispatches every fork behind main whose PR does not carry it", () => {
    const m = model();
    const { targets, skipped } = syncTargets(m.template);
    expect(targets.map((t) => t.label).sort()).toEqual([
      "entitlements",
      "file",
      "legal",
      "partition",
      "schema",
    ]);
    expect(skipped).toEqual([]);
    expect(commandText(SYNC_FORKS, targets[0] as never)).toMatch(
      /^gh workflow run sync-template\.yml -R Azure\/osdu-spi-\w+$/,
    );
  });

  test("skips a fork already syncing and one whose PR is at main", () => {
    const m = model((f) => {
      const legal = f.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.headMarker = NEW_HEAD;
      const runs = f.runs.data?.["Azure/osdu-spi-file"];
      const last = runs?.template[0];
      if (runs && last)
        runs.template = [{ ...last, id: 1, status: "in_progress" }, ...runs.template];
    });
    const { targets, skipped } = syncTargets(m.template);
    expect(targets.map((t) => t.label).sort()).toEqual(["entitlements", "partition", "schema"]);
    expect(skipped).toEqual(["file (Sync Template running)"]);
  });
});

describe("Roll out", () => {
  test("nothing is ready while every PR needs review and is red on the stack", () => {
    const m = model();
    const { targets, held } = rolloutTargets(m.template);
    expect(targets).toEqual([]);
    expect(held.map((h) => h.why)).toEqual(Array(5).fill("is red on the stack"));
    const [, roll] = rolloutActions(m.template, SWEPT, FIXTURE_NOW);
    expect(roll).toMatchObject({ label: "Roll out · 0 ready", disabled: true });
    expect(roll?.reason).toStartWith("nothing is ready: ");
  });

  test("merges the approved green PRs and names each one held back and why", () => {
    const m = model((f) => {
      ready(f, "Azure/osdu-spi-legal", 33);
      ready(f, "Azure/osdu-spi-schema", 37);
      ready(f, "Azure/osdu-spi-entitlements", 48);
      const ent = f.github.data?.repos["Azure/osdu-spi-entitlements"]?.prs.find(
        (p) => p.number === 48,
      );
      if (ent) ent.reviewDecision = "REVIEW_REQUIRED";
      ready(f, "Azure/osdu-spi-partition", 174);
      const part = f.github.data?.repos["Azure/osdu-spi-partition"]?.prs.find(
        (p) => p.number === 174,
      );
      if (part) part.mergeState = "DIRTY";
    });
    const { targets, held } = rolloutTargets(m.template);
    expect(targets.map((t) => t.label)).toEqual(["legal #33", "schema #37"]);
    expect(targets[0]).toMatchObject({ kind: "pr", state: "open", number: 33 });
    expect(commandText(ROLL_OUT, targets[0] as never)).toBe(
      "gh pr merge 33 -R Azure/osdu-spi-legal --merge",
    );
    expect(Object.fromEntries(held.map((h) => [h.row.service, h.why]))).toEqual({
      partition: "has conflicts",
      entitlements: "needs review",
      file: "is red on the stack",
    });
    const [, roll] = rolloutActions(m.template, SWEPT, FIXTURE_NOW);
    expect(roll?.label).toBe("Roll out · 2 ready");
    expect(roll?.confirm?.irreversible).toBe(true);
    expect(roll?.confirm?.subject).toBe("2");
    expect(roll?.confirm?.body).toContain(
      "Merges legal #33 and schema #37 into main with a merge commit, taking each fork to v1.2.0 +14.",
    );
    expect(roll?.confirm?.body).toContain("Held back: partition #174 has conflicts;");
    expect(roll?.confirm?.body).toContain("entitlements #48 needs review");
  });

  test("a draft and running checks hold a PR too", () => {
    const m = model((f) => {
      ready(f, "Azure/osdu-spi-legal", 33);
      const legal = f.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.draft = true;
    });
    const legal = m.template.rows.find((r) => r.service === "legal");
    expect(legal && heldBecause(legal)).toBe("is a draft");
  });
});

describe("the panel's buttons", () => {
  test("sit under the rollout table and say why they cannot run", () => {
    const b = engineeringBoard(model(), FIXTURE_NOW);
    expect(() => expectView(ENGINEERING_KEY, "board")(b)).not.toThrow();
    const actions = b.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("actions");
    expect(actions.items.map((i) => i.label)).toEqual(["Sync all forks · 5", "Roll out · 0 ready"]);
    expect(actions.items[0]?.confirm?.body).toStartWith(
      "Dispatches Sync Template on partition, entitlements, legal, schema and file, so each template-sync PR moves to v1.3.0 now instead of at 10-13 08:00.",
    );
    const scoped = engineeringBoard(model(), FIXTURE_NOW, { scopes: ["read:org"] });
    const blocked = scoped.sections.find((s) => s.kind === "actions");
    if (blocked?.kind !== "actions") throw new Error("actions");
    expect(blocked.items[0]).toMatchObject({
      disabled: true,
      reason: "gh's token lacks the repo scope; run gh auth refresh -s repo",
    });
  });
});

describe("a dispatch through the action path", () => {
  function github(running: Record<string, boolean>) {
    const writes: string[][] = [];
    const exec: RibExec = {
      runJSON: async (_cmd: string, args: string[]) => {
        const path = args[1] ?? "";
        const repo = /^repos\/([^/]+\/[^/]+)\//.exec(path)?.[1] ?? "";
        return {
          ok: true as const,
          data: (running[repo] ? ["in_progress"] : ["completed"]) as never,
        };
      },
      runText: async (_cmd: string, args: string[]) => {
        writes.push(args);
        return { ok: true as const, data: "" };
      },
    };
    return { exec, writes };
  }

  test("runs on idle forks and skips one that started syncing since the draw", async () => {
    unregister.push(registerVerb(SYNC_FORKS));
    const { exec, writes } = github({ "Azure/osdu-spi-file": true });
    const log = new ActionLog(undefined);
    const targets = syncTargets(model().template).targets;
    const res = await act(
      { verb: SYNC_FORKS.id, item: ROLLOUT_ITEM, ...SWEPT, targets },
      { exec, log, resweep: () => undefined, now: () => FIXTURE_NOW },
    );
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => w.slice(0, 3).join(" ") === "workflow run sync-template.yml")).toBe(
      true,
    );
    expect(log.lastFor(ROLLOUT_ITEM)?.results.find((r) => r.target === "file")).toEqual({
      target: "file",
      outcome: "refused",
      detail: "now running, was idle",
    });
  });
});
