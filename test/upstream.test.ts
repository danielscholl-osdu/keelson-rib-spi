import { afterAll, describe, expect, test } from "bun:test";
import { expectView, type RibExec } from "@keelson/shared";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import {
  forkActions,
  PREPARE,
  planActions,
  RERUN_CASCADE,
  START,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
} from "../src/act/upstream";
import {
  type ActionItem,
  type Binding,
  bindingSchema,
  commandText,
  registerVerb,
} from "../src/act/verbs";
import { consoleHtml } from "../src/boards/console";
import { doctorStatus } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { buildBriefing } from "../src/brief/index";
import { builtInFleet, setFleet } from "../src/config";
import type { Facts } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel, type Model } from "../src/model/index";
import { wavesOf } from "../src/model/upstream";
import { parseRollout, useRollout } from "../src/rollout";
import { boardActions } from "./harness";
import {
  envHeld,
  heldFacts,
  pausedFacts,
  pilotFacts,
  planReadyFacts,
  prepared,
  stoppedFacts,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
  UPSTREAM_STATES,
  upstreamFacts,
  waveFacts,
} from "./upstream-states";

// Describe bodies build their models at load, before any hook runs.
setFleet(builtInFleet(UPSTREAM_SERVICES));

afterAll(() => {
  setFleet(builtInFleet());
  useRollout(undefined);
});

function modelOf(f: Facts): Model {
  useRollout(parseRollout(f.fleet.data?.rollout as string).rollout);
  return buildModel(f, UPSTREAM_NOW);
}

function fork(m: Model, service: string) {
  const f = m.upstream.forks.find((x) => x.service === service);
  if (!f) throw new Error(`no ${service}`);
  return f;
}

function opts(m: Model) {
  return { swept: m.sweptAt ?? "", load: m.lanes, now: UPSTREAM_NOW };
}

function binding(a: ActionItem): Binding {
  if (a.type !== "act" || a.disabled) throw new Error(`${a.label} is not pressable`);
  return bindingSchema.parse((a as { binding?: unknown }).binding);
}

function inspect(m: Model, id: string) {
  const b = inspectBoard(m, { selected: id }, UPSTREAM_NOW);
  expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
  return b;
}

describe("the plan before anything starts", () => {
  const m = modelOf(planReadyFacts());
  const u = m.upstream;

  test("counts the commits waiting upstream and the forks that move a toolchain", () => {
    expect(u.mode).toBe("planning");
    expect(u.commits).toBe(114);
    expect(u.behind).toBe(13);
    expect(u.moving).toHaveLength(12);
    expect(u.snapshots.map((f) => f.service)).toEqual(["legal"]);
    expect(u.halts.map((f) => f.service)).toEqual(["crs-catalog"]);
  });

  test("pilots the reference fork and every fork with no toolchain move", () => {
    expect(u.pilot).toEqual(["partition", "indexer-queue"]);
    expect(u.gate).toBe("waiting");
  });

  test("sizes waves to the lane cap and keeps search after storage and indexer", () => {
    expect(u.waves.map((w) => w.forks)).toEqual([
      ["entitlements", "schema", "file", "storage", "indexer"],
      ["search", "workflow", "unit", "crs-conversion"],
    ]);
    expect(u.waves[0]?.gate).toBe("partition's cascade is green");
  });

  test("holds the SNAPSHOT move and the coming halt out of every wave", () => {
    expect(u.held.map((f) => [f.service, f.held])).toEqual([
      ["legal", "snapshot"],
      ["crs-catalog", "halt"],
    ]);
    expect(fork(m, "crs-catalog").phase).toBe("halted");
    expect(fork(m, "crs-catalog").wait).toBe("halts on schemathesis-tests; add a filter rule");
  });

  test("reads the lanes the template rollout holds from the same ledger", () => {
    expect(u.lanes.cap).toBe(5);
    expect(u.lanes.busy).toBe(3);
  });

  test("the primary press prepares the pilot and nothing merges", () => {
    const a = planActions(u, opts(m));
    const b = binding(a.primary);
    expect(b.verb).toBe(PREPARE.id);
    expect(b.targets.map((t) => t.label)).toEqual(["partition", "indexer-queue"]);
    expect(commandText(PREPARE, b.targets[0]!)).toBe(
      "gh workflow run sync.yml -R Azure/osdu-spi-partition",
    );
  });

  test("a template rollout PR still open keeps Start off the fork", () => {
    const f = upstreamFacts();
    prepared(f, "partition");
    const pm = modelOf(f);
    const p = fork(pm, "partition");
    expect(p.phase).toBe("prepared");
    expect(p.wait).toContain("template");
    const a = forkActions(pm.upstream, p, opts(pm));
    expect(a.primary.type === "act" && a.primary.disabled).toBe(true);
  });
});

describe("waves", () => {
  test("a fork ordered after another waits for a later wave though lanes are free", () => {
    const order = [{ service: "search", after: ["storage"] }];
    expect(wavesOf(["search", "storage", "file"], 5, order)).toEqual([
      ["storage", "file"],
      ["search"],
    ]);
  });

  test("no lane cap puts every fork in one wave", () => {
    expect(wavesOf(["a", "b", "c"], null, [])).toEqual([["a", "b", "c"]]);
  });
});

describe("the pilot in cascade", () => {
  const m = modelOf(pilotFacts());
  const u = m.upstream;

  test("a merged sync PR with its cascade running reads as cascading", () => {
    expect(fork(m, "partition").phase).toBe("cascading");
    expect(fork(m, "indexer-queue").phase).toBe("cascading");
    expect(u.mode).toBe("flight");
  });

  test("a running cascade claims a lane before its Sync to Main opens", () => {
    expect(u.lanes.claims).toBe(2);
  });

  test("wave 1 sync PRs are prepared but Start waits for the pilot's green cascade", () => {
    expect(u.startNext).toEqual([]);
    expect(fork(m, "file").phase).toBe("prepared");
    expect(fork(m, "file").planWait).toBe("wave 1 starts once partition's cascade is green");
  });

  test("the headline says what runs and that nothing waits on you", () => {
    const v = buildBriefing(m, doctorStatus(pilotFacts(), UPSTREAM_NOW), UPSTREAM_NOW).flow;
    expect(v.headline).toBe(
      "Partition and indexer-queue are in cascade; nothing waits on you. 0 of 13 forks are on main.",
    );
  });
});

describe("a wave in progress", () => {
  const m = modelOf(waveFacts());
  const u = m.upstream;

  test("gates come to you as Start and Review", () => {
    expect(u.startNext.map((f) => f.service)).toEqual(["file", "workflow"]);
    expect(u.reviews.map((f) => f.service)).toEqual(["schema"]);
    expect(fork(m, "entitlements").phase).toBe("review");
    expect(fork(m, "entitlements").cells.toMain.text).toBe("lane · testing");
  });

  test("Start merges the sync PR, then dispatches the cascade with its tracking issue", () => {
    const b = binding(planActions(u, opts(m)).primary);
    expect(b.verb).toBe(START.id);
    expect(b.targets.map((t) => t.label.split(" ")[0])).toEqual(["file", "workflow"]);
    const t = b.targets[0]!;
    expect(commandText(START, t)).toBe(
      `gh pr merge ${t.number} -R Azure/osdu-spi-file --merge && gh workflow run cascade.yml -R Azure/osdu-spi-file -f issue_number=${t.issue}`,
    );
  });

  test("Review is a link, never a verb", () => {
    const a = forkActions(u, fork(m, "schema"), opts(m));
    for (const x of [a.primary, ...a.secondary]) {
      if (x.type === "act" && !x.disabled) expect(binding(x).verb).not.toBe("approve");
    }
  });

  test("search waits until storage and indexer are on main", () => {
    expect(fork(m, "search").wait).toBe("after storage, indexer are on main");
  });

  test("a stopped cascade waits for a fix on fork_integration before Re-run", () => {
    const s = fork(m, "storage");
    expect(s.phase).toBe("stopped");
    expect(s.stop?.label).toBe("build failed");
    expect(s.stop?.fixLanded).toBe(false);
    const a = forkActions(u, s, opts(m));
    expect(a.primary.type === "act" && a.primary.disabled).toBe(true);
  });
});

describe("one fork stopped with its fix landed", () => {
  const m = modelOf(stoppedFacts());

  test("Re-run dispatches the cascade again with the tracking issue", () => {
    const s = fork(m, "storage");
    expect(s.stop?.fixLanded).toBe(true);
    const b = binding(forkActions(m.upstream, s, opts(m)).primary);
    expect(b.verb).toBe(RERUN_CASCADE.id);
    expect(b.targets[0]?.issue).toBe(s.tracking?.number);
  });
});

describe("two forks stopped on the same first error", () => {
  const m = modelOf(pausedFacts());
  const u = m.upstream;

  test("pauses the wave and asks the rest to absorb the move", () => {
    expect(u.paused?.forks).toEqual(["file", "storage"]);
    expect(u.startNext).toEqual([]);
    expect(fork(m, "workflow").planWait).toBe("the wave is paused: absorb the move first");
  });

  test("the plan board leads with the pause", () => {
    const b = inspect(m, UPSTREAM_ITEM);
    expect(b.header?.status?.label).toBe("UPSTREAM PLAN PAUSED");
  });
});

describe("the environment held", () => {
  const m = modelOf(heldFacts());
  const u = m.upstream;

  test("Start waits, Review and the cascade carry on", () => {
    expect(u.envHeld).toBeDefined();
    expect(u.startNext).toEqual([]);
    expect(fork(m, "file").wait).toBe("the environment is held");
    expect(u.reviews.map((f) => f.service)).toEqual(["schema"]);
  });

  test("Prepare is not gated on the environment", () => {
    const pm = modelOf(envHeld(planReadyFacts()));
    expect(pm.upstream.envHeld).toBeDefined();
    const a = forkActions(pm.upstream, fork(pm, "partition"), opts(pm));
    expect(binding(a.primary).verb).toBe(PREPARE.id);
  });
});

describe("every state", () => {
  for (const [name, build] of Object.entries(UPSTREAM_STATES)) {
    test(`${name}: the console and every inspector board render and validate`, () => {
      const f = build();
      const m = modelOf(f);
      const b = buildBriefing(m, doctorStatus(f, UPSTREAM_NOW), UPSTREAM_NOW);
      const html = consoleHtml(b, UPSTREAM_NOW);
      const start = html.indexOf('data-view-pane="flow"');
      const pane = html.slice(start, html.indexOf("data-view-pane=", start + 1));
      expect(pane).toContain(`<h2>${b.flow.headline.replace(/'/g, "&#39;")}</h2>`);
      const ids = new Set([...pane.matchAll(/data-inspect="([^"]+)"/g)].map((x) => x[1]));
      expect(ids.size).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id === UPSTREAM_ITEM || id?.startsWith(UPSTREAM_PREFIX)).toBe(true);
        inspect(m, id as string);
      }
      inspect(m, UPSTREAM_ITEM);
    });
  }

  test("text from the forges is escaped in the board", () => {
    const f = waveFacts();
    const repo = f.github.data?.repos["Azure/osdu-spi-schema"];
    const pr = repo?.prs.find((p) => p.head.startsWith("release/upstream-"));
    if (pr) pr.title = "<b>x</b>";
    const m = modelOf(f);
    const html = consoleHtml(
      buildBriefing(m, doctorStatus(f, UPSTREAM_NOW), UPSTREAM_NOW),
      UPSTREAM_NOW,
    );
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("a Start press", () => {
  function github(syncPr: { state: string; merged: boolean; sha: string }) {
    const writes: string[] = [];
    const exec: RibExec = {
      runJSON: async () => ({ ok: true as const, data: syncPr as never }),
      runText: async (_cmd: string, args: string[]) => {
        writes.push(args.join(" "));
        return { ok: true as const, data: "" };
      },
    };
    return { exec, writes };
  }

  async function pressed(m: Model, b: Binding, deps: Partial<Parameters<typeof act>[1]>) {
    const off = registerVerb(START);
    try {
      return await act(b, {
        exec: deps.exec as RibExec,
        log: new ActionLog(undefined),
        resweep: () => undefined,
        now: () => UPSTREAM_NOW,
        lanes: () => m.lanes,
        ...deps,
      });
    } finally {
      off();
    }
  }

  function press(m: Model): Binding {
    const b = binding(planActions(m.upstream, opts(m)).primary);
    return { ...b, targets: b.targets.slice(0, 1) };
  }

  test("merges the sync PR, then dispatches the cascade", async () => {
    const m = modelOf(waveFacts());
    const b = press(m);
    const t = b.targets[0]!;
    const { exec, writes } = github({ state: "open", merged: false, sha: t.sha ?? "" });
    const res = await pressed(m, b, { exec });
    expect(res.ok).toBe(true);
    expect(writes).toEqual([
      `pr merge ${t.number} -R Azure/osdu-spi-file --merge`,
      `workflow run cascade.yml -R Azure/osdu-spi-file -f issue_number=${t.issue}`,
    ]);
  });

  test("is refused when the sync PR merged since the board drew it", async () => {
    const m = modelOf(waveFacts());
    const b = press(m);
    const { exec, writes } = github({
      state: "closed",
      merged: true,
      sha: b.targets[0]?.sha ?? "",
    });
    const res = await pressed(m, b, { exec });
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  test("is refused while the environment is held", async () => {
    const m = modelOf(waveFacts());
    const b = press(m);
    const { exec, writes } = github({ state: "open", merged: false, sha: b.targets[0]?.sha ?? "" });
    const res = await pressed(m, b, { exec, held: () => "env-upgrade in flight" });
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

test("the plan board offers every press in the inspector and none in the console", () => {
  const m = modelOf(waveFacts());
  const acts = boardActions(inspect(m, UPSTREAM_ITEM)).filter((a) => a.type === "act");
  expect(acts.length).toBeGreaterThan(0);
  const html = consoleHtml(
    buildBriefing(m, doctorStatus(waveFacts(), UPSTREAM_NOW), UPSTREAM_NOW),
    UPSTREAM_NOW,
  );
  expect(html).not.toContain("start-upstream");
  expect(html).not.toContain("sync-upstream");
});
