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
import { bindingSchema, commandText, registerVerb } from "../src/act/verbs";
import { inspectBoard } from "../src/boards/inspect";
import { rolloutActionItems } from "../src/boards/template";
import type { Facts } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { boardActions, FIXTURE_NOW, NEW_HEAD, releasedFacts } from "./harness";

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
    expect(roll?.pendingLabel).toBe("Merging 2…");
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

describe("the template-set inspector's buttons", () => {
  function actions(m: ReturnType<typeof model>, scopes?: string[]) {
    const b = inspectBoard(m, { selected: "template-set" }, FIXTURE_NOW, undefined, { scopes });
    expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
    const found = boardActions(b);
    if (!found[0]?.label.startsWith("Sync all forks")) throw new Error("rollout actions");
    return found;
  }

  test("Sync all forks names up to three forks, then counts", () => {
    const label = (behind: string[]) => {
      const m = model();
      const rows = m.template.rows.map((r) =>
        behind.includes(r.service) ? r : { ...r, behind: 0, pr: undefined },
      );
      return rolloutActionItems(
        { ...m, template: { ...m.template, rows } },
        FIXTURE_NOW,
        undefined,
      )[0];
    };
    expect(label(["file"])).toMatchObject({
      label: "Sync all forks · file",
      confirm: { confirmLabel: "Sync all forks · file" },
    });
    expect(label(["legal", "schema", "file"])?.label).toBe("Sync all forks · legal, schema, file");
    expect(label(["entitlements", "legal", "schema", "file"])?.label).toBe("Sync all forks · 4");
  });

  test("lead with Sync all forks and Roll out, and say why they cannot run", () => {
    const items = actions(model());
    expect(items.map((i) => i.label)).toEqual(["Sync all forks · 5", "Roll out · 0 ready"]);
    expect(items[0]?.pendingLabel).toBe("Dispatching 5…");
    expect(items[0]?.confirm?.body).toStartWith(
      "Dispatches Sync Template on partition, entitlements, legal, schema and file, so each template-sync PR moves to v1.3.0 now instead of at 10-13 08:00.",
    );
    expect(items[1]).toMatchObject({ disabled: true });
    expect(items[1]?.reason).toStartWith("nothing is ready: ");
    expect(actions(model(), ["read:org"])[0]).toMatchObject({
      disabled: true,
      reason: "gh's token lacks the repo scope; run gh auth refresh -s repo",
    });
  });

  test("Roll out binds the ready PRs to the rollout item", () => {
    const [, roll] = actions(
      model((f) => {
        ready(f, "Azure/osdu-spi-legal", 33);
        ready(f, "Azure/osdu-spi-schema", 37);
      }),
    );
    expect(roll).toMatchObject({ type: "act", label: "Roll out · 2 ready" });
    expect(roll?.disabled).toBeUndefined();
    const binding = bindingSchema.parse(roll?.binding);
    expect(binding).toMatchObject({ verb: ROLL_OUT.id, item: ROLLOUT_ITEM, ...SWEPT });
    expect(binding.targets.map((t) => t.label)).toEqual(["legal #33", "schema #37"]);
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
