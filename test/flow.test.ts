import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView, type RibExec } from "@keelson/shared";
import { FLEET_RELEASE } from "../src/act/flow";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import { RERUN_LANES } from "../src/act/rerun";
import { ROLL_OUT, ROLLOUT_ITEM, SYNC_FORKS } from "../src/act/rollout";
import { bindingSchema, commandText, registerVerb } from "../src/act/verbs";
import { consoleHtml } from "../src/boards/console";
import { doctorStatus } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { buildBriefing } from "../src/brief/index";
import { nextWhy, upstreamPrs } from "../src/brief/rollout";
import type { Facts } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { parseRollout, useRollout } from "../src/rollout";
import { Store } from "../src/store";
import { Sweeper } from "../src/sweep";
import { plural } from "../src/util";
import { boardActions, boardCard, FIXTURE_NOW, fixtureFacts, NEW_HEAD } from "./harness";
import {
  doneFacts,
  environmentFacts,
  headSha,
  heldFacts,
  job,
  merged,
  ready,
  readyFacts,
  rollingFacts,
  settled,
  stoppedFacts,
} from "./states";

const HEAD = "bb49a03";

afterEach(() => useRollout(undefined));

function inspect(m: ReturnType<typeof buildModel>, scopes?: string[]) {
  const b = inspectBoard(m, { selected: "rollout" }, FIXTURE_NOW, undefined, { scopes });
  expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
  return b;
}

describe("a change only on main", () => {
  test("raises a P1 Rollout item with the plan, the reach and the schedule", () => {
    useRollout(
      parseRollout(
        JSON.stringify({
          schema: 1,
          lanes: 2,
          ordering: [{ service: "file", after: ["legal", "schema"] }],
        }),
      ).rollout,
    );
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "ready", next: "start", total: 5, merged: 0 });
    const item = m.queue.items.find((i) => i.id === "rollout");
    expect(item).toMatchObject({ rung: 1, cls: "ROLLOUT", scope: "fleet" });
    expect(m.queue.items.some((i) => i.id === "template-set")).toBe(false);
    const b = buildBriefing(m, doctorStatus(readyFacts(), FIXTURE_NOW), FIXTURE_NOW);
    const focus = b.focus.find((f) => f.id === "rollout");
    expect(focus?.verb).toBe("Start rollout");
    expect(focus?.next).toBe("Start the rollout: dispatch Sync Template to the first 2 forks.");
    expect(focus?.more?.find((x) => x.label === "Plan")?.text).toBe(
      "3 waves · lanes 2 from rollout.json · file merges after legal and schema",
    );
    expect(focus?.more?.map((x) => x.label)).toEqual(["Plan", "Watch", "Reaches"]);
  });

  test("Start rollout dispatches the first wave, carrying main's sha, and the rest wait", () => {
    useRollout({ lanes: 2 });
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    const [start, ...rest] = boardActions(inspect(m));
    expect(start?.label).toBe("Start rollout · dispatch Sync Template to 2 forks");
    const binding = bindingSchema.parse(start?.binding);
    expect(binding).toMatchObject({ verb: SYNC_FORKS.id, item: ROLLOUT_ITEM });
    expect(binding.targets.map((t) => [t.label, t.sha])).toEqual([
      ["partition", NEW_HEAD],
      ["entitlements", NEW_HEAD],
    ]);
    expect(start?.tone).toBe("brand");
    expect(rest.find((a) => a.label.startsWith("Dispatch"))).toMatchObject({
      label: "Dispatch legal, schema and file · on the next press",
      disabled: true,
    });
  });

  test("the console card only opens the inspector", () => {
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    const b = buildBriefing(m, doctorStatus(readyFacts(), FIXTURE_NOW), FIXTURE_NOW);
    const html = consoleHtml(b, FIXTURE_NOW);
    const card = html.slice(html.indexOf('data-detail="rollout"'));
    expect(card.slice(0, card.indexOf("</section>"))).toContain(
      '<button type="button" class="open" data-inspect="rollout">Open in inspector · Start rollout</button>',
    );
    expect(html).not.toContain("data-act=");
  });
});

describe("a rollout in flight", () => {
  test("merges the approved PRs into the free lanes and holds an ordered fork", () => {
    useRollout({ lanes: 2, ordering: [{ service: "file", after: ["legal", "schema"] }] });
    const f = settled(fixtureFacts());
    merged(f, "partition");
    for (const svc of ["legal", "schema", "file"]) ready(f, svc);
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "rolling", next: "merge", merged: 1 });
    const row = (svc: string) => m.rollout?.forks.find((x) => x.service === svc);
    expect(row("partition")?.merge.text).toMatch(/^\d{2}:\d{2}$/);
    expect(row("partition")?.main.text).toBe("green");
    expect(row("legal")?.merge).toMatchObject({ text: "next", note: "merges on the next press" });
    expect(row("file")?.merge).toMatchObject({
      text: "held",
      note: "merges after legal and schema",
    });
    const [merge] = boardActions(inspect(m));
    expect(merge?.label).toBe("Merge 2 of 2 approved: legal and schema");
    expect(bindingSchema.parse(merge?.binding)).toMatchObject({ verb: ROLL_OUT.id });
  });

  test("with one lane free the second merge waits and the button says so", () => {
    useRollout({ lanes: 1 });
    const f = settled(fixtureFacts());
    for (const svc of ["legal", "schema"]) ready(f, svc);
    const m = buildModel(f, FIXTURE_NOW);
    const [merge] = boardActions(inspect(m));
    expect(merge?.label).toBe("Merge 1 of 2 approved: legal · schema waits for a lane");
    expect(m.rollout?.forks.find((x) => x.service === "schema")?.merge.text).toBe("lane");
    const next = boardCard(inspect(m), "Next step");
    expect(next?.title).toBe("Merge legal. One lane is free.");
    expect(next?.fields?.[0]?.value).toBe(
      "legal and schema are approved and green. Only one lane is free, so legal merges on this press and schema on the next.",
    );
  });

  test("the inspector draws the lane meter, the fork table and the side panels", () => {
    useRollout({ lanes: 5 });
    const f = settled(fixtureFacts());
    merged(f, "partition", { status: "in_progress" });
    const b = inspect(buildModel(f, FIXTURE_NOW));
    const titles = b.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles).toContain("Lanes on the shared environment");
    expect(titles).toContain("Forks · 1 of 5 merged");
    expect(titles).toContain("Last-good pins");
    expect(titles.some((t) => t?.startsWith("What reaches the forks"))).toBe(true);
    const table = b.sections.find((s) => s.kind === "table");
    if (table?.kind !== "table") throw new Error("fork table");
    expect(table.columns.map((c) => c.label)).toEqual([
      "Fork",
      "Validation",
      "Review",
      "Merge",
      "Main",
    ]);
    expect(table.rows[0]?.fork).toMatchObject({ value: "partition" });
    expect(table.rows[0]?.main).toMatchObject({
      badges: [{ text: "running", tone: "info" }],
    });
    const notes = b.sections[b.sections.indexOf(table) + 1];
    if (notes?.kind !== "rows") throw new Error("fork notes");
    expect(notes.items.find((i) => i.text === "entitlements")?.trailing).toBe(
      "Validation failed on the environment's own hold · needs review",
    );
  });
});

describe("a main run that fails after its merge", () => {
  test("without an Environment title stops the line: merges pause and the job is linked", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", jobs: [job([])] });
    ready(f, "legal");
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "stopped", next: "stopped" });
    const item = m.queue.items.find((i) => i.id === "rollout");
    expect(item).toMatchObject({ rung: 0, incident: true });
    expect(m.rollout?.mergeNext).toEqual([]);
    expect(m.rollout?.forks.find((x) => x.service === "legal")?.merge.text).toBe("paused");
    const b = inspect(m);
    expect(b.header?.status?.label).toBe("P0 · ROLLOUT STOPPED");
    const [primary, ...rest] = boardActions(b);
    expect(primary).toMatchObject({ label: "Merging paused · 1 main run red", disabled: true });
    expect(rest.map((a) => [a.label, a.disabled])).toEqual([
      [`Retarget to main · once a template fix merges · main is still ${HEAD}`, true],
    ]);
    const next = boardCard(b, "Next step");
    expect(next?.title).toBe("Fix it forward in the template. Merges and dispatches are paused.");
    expect(next?.fields?.map((x) => x.href)).toContain(
      "https://github.com/Azure/osdu-spi-partition/actions/runs/1/job/7",
    );
    const failed = boardCard(b, "What failed");
    expect(failed?.fields?.find((x) => x.label === "Class")?.value).toBe(
      "real · no Environment annotation on any failed job",
    );
    expect(b.sections.some((s) => "title" in s && s.title === "Where each fork stopped")).toBe(
      true,
    );
  });

  test("once a fix lands on main, Retarget dispatches every fork whose PR lacks it", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", jobs: [job([])] });
    const old = headSha(f);
    const fix = "f1x0000000000000000000000000000000000001";
    const template = f.github.data?.repos["Azure/osdu-spi"];
    const t = f.template.data;
    if (!template?.head || !t) throw new Error("template");
    template.head = { ...template.head, sha: fix };
    const change = {
      sha: fix,
      title: "fix(acceptance): restore the suite path (#300)",
      pr: 300,
      url: "https://github.com/Azure/osdu-spi/pull/300",
      at: FIXTURE_NOW.toISOString(),
    };
    t.compares[old] = {
      marker: old,
      head: fix,
      label: "v1.2.0 +14",
      aheadBy: 1,
      shas: [fix],
      changes: [change],
    };
    t.compares[fix] = {
      marker: fix,
      head: fix,
      label: "v1.2.0 +15",
      aheadBy: 0,
      shas: [],
      changes: [],
    };
    t.files = { ...(t.files ?? {}), [fix]: ["build/acceptance.Dockerfile"] };
    for (const c of Object.values(t.compares)) {
      if (c.marker === old || c.marker === fix) continue;
      c.shas = [...c.shas, fix];
      c.changes = [change, ...c.changes];
      c.aheadBy += 1;
    }
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "stopped", next: "retarget" });
    const [primary] = boardActions(inspect(m));
    expect(primary?.label).toStartWith("Retarget the rollout to main · dispatch partition");
    const binding = bindingSchema.parse(primary?.binding);
    expect(binding.verb).toBe(SYNC_FORKS.id);
    expect(new Set(binding.targets.map((x) => x.sha))).toEqual(new Set([fix]));
  });

  test("with an Environment title on attempt 1 it is re-run once, not a stop", () => {
    const f = settled(fixtureFacts());
    const id = merged(f, "partition", {
      conclusion: "failure",
      jobs: [job(["Shared environment did not answer within 20m"])],
    });
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout?.phase).toBe("rolling");
    expect(m.rollout?.stops).toEqual([]);
    expect(m.rollout?.forks[0]?.main).toMatchObject({
      text: "env",
      note: "main run hit an environment failure on attempt 1",
    });
    expect(m.rollout?.next).toBe("rerun");
    const [rerun] = boardActions(inspect(m));
    expect(rerun?.label).toBe("Re-run partition once · environment failure, attempt 1");
    const binding = bindingSchema.parse(rerun?.binding);
    expect(binding.verb).toBe(RERUN_LANES.id);
    expect(binding.targets).toEqual([
      {
        repo: "Azure/osdu-spi-partition",
        kind: "run",
        number: id,
        state: "failure",
        label: "partition main",
      },
    ]);
  });

  test("an Environment title on a second attempt stops the line", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", attempt: 2, jobs: [job(["timeout"], 2)] });
    expect(buildModel(f, FIXTURE_NOW).rollout?.phase).toBe("stopped");
  });
});

describe("every fork on the change", () => {
  function done(ago = 60) {
    const f = settled(fixtureFacts());
    for (const svc of ["partition", "entitlements", "legal", "schema", "file"]) {
      merged(f, svc, {}, ago);
    }
    return f;
  }

  test("offers Fleet Release with publish off, and the Template card counts against main", () => {
    const f = done();
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "done", next: "release", merged: 5, mainGreen: 5 });
    expect(m.queue.items.find((i) => i.id === "rollout")?.rung).toBe(2);
    const b = inspect(m);
    expect(b.header?.status?.label).toBe("ROLLOUT DONE");
    const [release] = boardActions(b);
    expect(release?.label).toBe(`Run Fleet Release · target ${HEAD} · publish off`);
    const binding = bindingSchema.parse(release?.binding);
    expect(binding.verb).toBe(FLEET_RELEASE.id);
    expect(commandText(FLEET_RELEASE, binding.targets[0] as never)).toBe(
      `gh workflow run fleet-release.yml -R Azure/osdu-spi -f template_target=${headSha(f)} -f publish=false`,
    );
    const brief = buildBriefing(m, doctorStatus(f, FIXTURE_NOW), FIXTURE_NOW);
    expect(brief.facts[2]).toMatchObject({ figure: "5 of 5", tone: "ok" });
    expect(brief.facts[2]?.sub).toStartWith("on main · nothing waiting to roll out");
  });

  test("a day after the last merge the item leaves the queue", () => {
    expect(buildModel(done(25 * 60), FIXTURE_NOW).rollout).toBeUndefined();
  });
});

describe("a press against a stale board", () => {
  let unregister: (() => void)[] = [];
  afterEach(() => {
    for (const u of unregister) u();
    unregister = [];
  });

  function github(main: string) {
    const writes: string[][] = [];
    const reads: string[] = [];
    const exec: RibExec = {
      runJSON: async (_cmd: string, args: string[]) => {
        const path = args[1] ?? "";
        reads.push(path);
        return {
          ok: true as const,
          data: (path.endsWith("/commits/main") ? { sha: main } : ["completed"]) as never,
        };
      },
      runText: async (_cmd: string, args: string[]) => {
        writes.push(args);
        return { ok: true as const, data: "" };
      },
    };
    return { exec, writes, reads };
  }

  test("is refused when osdu-spi main moved since the board drew the dispatch", async () => {
    unregister.push(registerVerb(SYNC_FORKS));
    const { exec, writes } = github("a".repeat(40));
    const log = new ActionLog(undefined);
    const res = await act(
      {
        verb: SYNC_FORKS.id,
        item: ROLLOUT_ITEM,
        swept: "s",
        targets: [
          {
            repo: "Azure/osdu-spi-file",
            kind: "workflow",
            state: "idle",
            sha: NEW_HEAD,
            label: "file",
          },
        ],
      },
      { exec, log, resweep: () => undefined, now: () => FIXTURE_NOW },
    );
    expect(res.ok).toBe(false);
    expect(writes).toEqual([]);
    expect(log.lastFor(ROLLOUT_ITEM)?.results[0]).toEqual({
      target: "file",
      outcome: "refused",
      detail: `osdu-spi main moved ${NEW_HEAD.slice(0, 7)} → aaaaaaa`,
    });
  });

  test("Fleet Release reads the fleet-release runs before it dispatches", async () => {
    unregister.push(registerVerb(FLEET_RELEASE));
    const { exec, writes, reads } = github(NEW_HEAD);
    const res = await act(
      {
        verb: FLEET_RELEASE.id,
        item: ROLLOUT_ITEM,
        swept: "s",
        targets: [
          {
            repo: "Azure/osdu-spi",
            kind: "workflow",
            state: "idle",
            sha: NEW_HEAD,
            label: "osdu-spi",
          },
        ],
      },
      { exec, log: new ActionLog(undefined), resweep: () => undefined, now: () => FIXTURE_NOW },
    );
    expect(res.ok).toBe(true);
    expect(reads.some((p) => p.includes("/workflows/fleet-release.yml/runs"))).toBe(true);
    expect(writes).toEqual([
      [
        "workflow",
        "run",
        "fleet-release.yml",
        "-R",
        "Azure/osdu-spi",
        "-f",
        `template_target=${NEW_HEAD}`,
        "-f",
        "publish=false",
      ],
    ]);
  });
});

describe("the rollout file's ordering", () => {
  test("a rule the rib cannot read is dropped with a warning", () => {
    const parsed = parseRollout(
      JSON.stringify({ schema: 1, lanes: 5, ordering: [{ service: "search", after: "storage" }] }),
    );
    expect(parsed.rollout).toEqual({ lanes: 5 });
    expect(parsed.warnings[0]).toContain("an ordering rule the rib cannot read");
  });
});

describe("the states dev/states.ts replays", () => {
  test("each lands in the phase and next press it is named for", () => {
    useRollout({ lanes: 2, ordering: [{ service: "file", after: ["legal", "schema"] }] });
    const phase = (f: Facts) => {
      const r = buildModel(f, FIXTURE_NOW).rollout;
      return [r?.phase, r?.next];
    };
    expect(phase(readyFacts())).toEqual(["ready", "start"]);
    expect(phase(rollingFacts())).toEqual(["rolling", "merge"]);
    expect(phase(stoppedFacts())).toEqual(["stopped", "stopped"]);
    expect(phase(environmentFacts())).toEqual(["rolling", "rerun"]);
    expect(phase(heldFacts())).toEqual(["rolling", "env"]);
    expect(phase(doneFacts())).toEqual(["done", "release"]);
  });
});

describe("a held environment", () => {
  test("pauses every press that deploys and keeps the re-run for after the hold", () => {
    const m = buildModel(heldFacts(), FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ next: "env", held: "env-upgrade in verify" });
    const b = inspect(m);
    const next = boardCard(b, "Next step");
    expect(next?.title).toBe(
      "Wait for the environment: env-upgrade in verify. Nothing that deploys starts until it reads deployable.",
    );
    expect(next?.fields?.[0]?.value).toContain(
      "a re-run now would spend its one attempt on the hold",
    );
    expect(next?.fields?.[0]?.value).not.toContain("stays held until");
    const actions = next?.actions ?? [];
    expect(actions.every((a) => a.disabled)).toBe(true);
    expect(actions[0]?.label).toBe("Waiting for the environment · env-upgrade in verify");
    expect(actions.map((a) => a.label)).toContain(
      "Re-run partition once · after the environment reads deployable",
    );
  });

  test("an approved PR waits on the environment, not on the next press", () => {
    const f = heldFacts();
    ready(f, "legal");
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout?.next).toBe("env");
    expect(m.rollout?.forks.find((x) => x.service === "legal")?.merge).toMatchObject({
      text: "env",
      note: "merges once the environment is deployable",
    });
  });
});

describe("the words around a rollout", () => {
  test("the upstream sync counts only the forks it opens a PR on", () => {
    const r = buildModel(readyFacts(), FIXTURE_NOW).rollout;
    expect(r?.schedule).toMatchObject({ upstreamHalts: ["entitlements"] });
    expect(upstreamPrs(r as NonNullable<typeof r>)).toBe(
      `${plural(r?.schedule.upstreamForks ?? 0, "PR")} (entitlements halts instead)`,
    );
  });

  test("the evidence leads with main's sha and how far the forks trail it", () => {
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    const b = buildBriefing(m, doctorStatus(readyFacts(), FIXTURE_NOW), FIXTURE_NOW);
    const evidence = b.focus.find((f) => f.id === "rollout")?.evidence.map((e) => e.label);
    expect(evidence?.slice(0, 2)).toEqual(["main c0de000", "forks on ea9a2e1"]);
  });

  test("a last-good pin from an earlier day carries its date", () => {
    const b = inspect(buildModel(doneFacts(), FIXTURE_NOW));
    const pins = b.sections.find((s) => "title" in s && s.title === "Last-good pins");
    if (pins?.kind !== "rows") throw new Error("pins");
    expect(pins.items.find((i) => i.text === "legal")?.trailing).toMatch(
      /^main \w{7} · green \d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  test("a fork whose name ends in s takes a bare apostrophe", () => {
    const m = buildModel(stoppedFacts(), FIXTURE_NOW);
    expect(nextWhy(m.rollout as NonNullable<typeof m.rollout>)).toStartWith(
      "entitlements' main run failed after its merge.",
    );
  });
});

describe("replaying recorded facts", () => {
  const before = process.env.RIB_SPI_FACTS_FILE;
  afterEach(() => {
    if (before === undefined) delete process.env.RIB_SPI_FACTS_FILE;
    else process.env.RIB_SPI_FACTS_FILE = before;
  });

  test("draws the file at its own sweep time, never sweeps and never writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-replay-"));
    const file = join(dir, "stopped.json");
    writeFileSync(file, JSON.stringify(stoppedFacts()));
    process.env.RIB_SPI_FACTS_FILE = file;
    const calls: string[] = [];
    const exec: RibExec = {
      runJSON: async (_c: string, args: string[]) => {
        calls.push(args.join(" "));
        return { ok: false as const, error: "no network", code: 1 } as never;
      },
      runText: async (_c: string, args: string[]) => {
        calls.push(args.join(" "));
        return { ok: false as const, error: "no network", code: 1 } as never;
      },
    };
    const s = new Sweeper({ exec, store: new Store(dir), onChange: () => {} });
    expect(s.now().toISOString()).toBe("2026-10-12T21:58:14.428Z");
    await s.sweep({ force: true });
    expect(s.model.rollout?.phase).toBe("stopped");
    expect(calls).toEqual([]);
    unregisterAll.push(registerVerb(SYNC_FORKS));
    const res = await act(
      {
        verb: SYNC_FORKS.id,
        item: ROLLOUT_ITEM,
        swept: "s",
        targets: [{ repo: "Azure/osdu-spi-file", kind: "workflow", label: "file" }],
      },
      { exec, log: new ActionLog(undefined), resweep: () => undefined, now: () => FIXTURE_NOW },
    );
    expect(res).toEqual({
      ok: false,
      error: "replaying recorded facts (RIB_SPI_FACTS_FILE); nothing writes",
    });
    expect(calls).toEqual([]);
  });
});

let unregisterAll: (() => void)[] = [];
afterEach(() => {
  for (const u of unregisterAll) u();
  unregisterAll = [];
});
