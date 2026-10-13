import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect";
import { stackBoard } from "../src/boards/stack";
import { entryAcrossForks, filterSection } from "../src/collect/filters";
import { Gh, Glab } from "../src/forge";
import { INSPECT_KEY, STACK_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const model = buildModel(fixtureFacts(), FIXTURE_NOW);
const gate = expectView(INSPECT_KEY, "board");

type Board = ReturnType<typeof inspectBoard>;

function section(b: Board, title: string) {
  return b.sections.find((s) => "title" in s && s.title?.startsWith(title));
}

function item(id: string) {
  const found = model.queue.items.find((i) => i.id === id);
  if (!found) throw new Error(`fixture has no ${id}`);
  return found;
}

describe("the inspector", () => {
  test("every item in the recorded queue opens a board the host accepts, with its cause", () => {
    expect(model.queue.items.length).toBeGreaterThan(0);
    for (const i of model.queue.items) {
      const b = inspectBoard(model, { selected: i.id, item: i }, FIXTURE_NOW);
      expect(() => gate(b)).not.toThrow();
      expect(section(b, "Cause")).toBeDefined();
      expect(section(b, "Last action")).toBeDefined();
    }
  });

  test("the environment incident names its class and lists the lanes it folded", () => {
    const stack = model.queue.items.find((i) => i.kind === "stack");
    if (!stack) throw new Error("fixture has a stack incident");
    const b = inspectBoard(model, { selected: stack.id, item: stack }, FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "ENV", tone: "error" });
    const effects = section(b, "Effects");
    if (effects?.kind !== "rows") throw new Error("effects are rows");
    expect(effects.items.some((r) => r.text.includes("partition template-sync PR #174"))).toBe(
      true,
    );
  });

  test("a toolchain sync PR shows the failing check and the commits it holds", () => {
    const legal = item("gate1:legal");
    const b = inspectBoard(model, { selected: legal.id, item: legal }, FIXTURE_NOW);
    expect(b.header?.status?.label).toBe("TOOLCHAIN");
    const cause = section(b, "Cause");
    if (cause?.kind !== "rows") throw new Error("cause is rows");
    const labels = cause.items.map((r) => r.text);
    expect(labels).toContain("check");
    expect(labels).toContain("held");
  });

  test("a halt says it is reading the other forks, then shows each one's state", () => {
    const halt = item("halt:entitlements");
    expect(halt.halt).toEqual({
      fork: "entitlements",
      code: "UNKNOWN_TOP_LEVEL",
      entries: ["schemathesis-tests"],
    });
    const same = (b: Board) => section(b, "Same entry in other forks");
    expect(
      same(inspectBoard(model, { selected: halt.id, item: halt }, FIXTURE_NOW)),
    ).toBeUndefined();
    const reading = same(
      inspectBoard(model, { selected: halt.id, item: halt, reading: halt.id }, FIXTURE_NOW),
    );
    if (reading?.kind !== "rows") throw new Error("reading is a row");
    expect(reading.items[0]?.text).toBe("reading each fork's filter and upstream tree");
    const read = inspectBoard(
      model,
      {
        selected: halt.id,
        item: halt,
        others: {
          id: halt.id,
          entries: [
            { fork: "legal", entry: "schemathesis-tests", state: "unlisted" },
            { fork: "partition", entry: "schemathesis-tests", state: "absent" },
            { fork: "file", entry: "schemathesis-tests", state: "listed", verdict: "strip" },
          ],
        },
      },
      FIXTURE_NOW,
    );
    expect(() => gate(read)).not.toThrow();
    const rows = same(read);
    if (rows?.kind !== "rows") throw new Error("one row per fork");
    expect(rows.items.map((r) => [r.text, r.chip?.label, r.trailing])).toEqual([
      ["file", "listed", "strip"],
      ["legal", "unlisted", undefined],
      ["1 fork has no such entry upstream · partition", undefined, undefined],
    ]);
  });

  test("forks that list the entry lead, and absent forks fold into one line", () => {
    const halt = item("halt:entitlements");
    const absent = ["partition", "legal", "schema", "file", "indexer", "workflow"].map((fork) => ({
      fork,
      entry: "schemathesis-tests",
      state: "absent" as const,
    }));
    const b = inspectBoard(
      model,
      {
        selected: halt.id,
        item: halt,
        others: {
          id: halt.id,
          entries: [
            ...absent.slice(0, 3),
            { fork: "storage", entry: "schemathesis-tests", state: "listed", verdict: "strip" },
            { fork: "unit", entry: "schemathesis-tests", state: "unread" },
            ...absent.slice(3),
            { fork: "search", entry: "schemathesis-tests", state: "listed", verdict: "strip" },
          ],
        },
      },
      FIXTURE_NOW,
    );
    const rows = section(b, "Same entry in other forks");
    if (rows?.kind !== "rows") throw new Error("other forks");
    expect(rows.items.map((r) => [r.chip?.label, r.text, r.trailing])).toEqual([
      ["listed", "storage", "strip"],
      ["listed", "search", "strip"],
      ["?", "unit", undefined],
      [
        undefined,
        "6 forks have no such entry upstream · partition, legal, schema, file, indexer and workflow",
        undefined,
      ],
    ]);
  });

  test("an item a sweep no longer reads says it cleared instead of vanishing", () => {
    const legal = item("gate1:legal");
    const b = inspectBoard(
      model,
      { selected: "gate1:gone", item: { ...legal, id: "gate1:gone" } },
      FIXTURE_NOW,
    );
    expect(b.header?.status).toEqual({ label: "CLEARED", tone: "ok" });
    expect(() => gate(b)).not.toThrow();
  });

  test("with nothing picked it says how to open one", () => {
    const b = inspectBoard(model, {}, FIXTURE_NOW);
    expect(() => gate(b)).not.toThrow();
    expect(b.sections).toHaveLength(1);
  });

  test("the environment's incident attempts open the incident, not a run page", () => {
    const b = stackBoard(model, FIXTURE_NOW);
    expect(() => expectView(STACK_KEY, "board")(b)).not.toThrow();
    const attempts = b.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Attempts"));
    if (attempts?.kind !== "rows") throw new Error("the fixture is in incident mode");
    const id = model.queue.items.find((i) => i.kind === "stack")?.id;
    for (const r of attempts.items) {
      expect(r.action).toEqual({ type: "inspect", payload: { id } });
      expect(r.href).toBeUndefined();
    }
  });
});

const FILTER = `# comment
service: legal

top_level:
  .config: keep
  docs: keep   # trailing note
  legal-core-plus: strip

testing:
  legal-test-azure: fork
`;

describe("filter reads", () => {
  test("a section reads as name to verdict, comments ignored, other sections excluded", () => {
    expect([...filterSection(FILTER, "top_level")]).toEqual([
      [".config", "keep"],
      ["docs", "keep"],
      ["legal-core-plus", "strip"],
    ]);
    expect([...filterSection(FILTER, "testing")]).toEqual([["legal-test-azure", "fork"]]);
  });

  test("each other fork is absent, listed, unlisted or unread, and only GETs are issued", async () => {
    const calls: string[][] = [];
    const exec: RibExec = {
      runJSON: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const path = args.find((a) => a.startsWith("repos/") || a.startsWith("projects/")) ?? "";
        if (cmd === "gh") {
          if (path.includes("osdu-spi-file")) return { ok: false as const, error: "404", code: 1 };
          const body = path.includes("osdu-spi-legal")
            ? FILTER
            : `top_level:\n  schemathesis-tests: strip\n`;
          return {
            ok: true as const,
            data: { content: Buffer.from(body).toString("base64") } as never,
          };
        }
        const names = path.includes("partition") ? ["docs"] : ["docs", "schemathesis-tests"];
        return { ok: true as const, data: names.map((name) => ({ name })) as never };
      },
      runText: async () => ({ ok: false as const, error: "unused", code: 1 }),
    };
    const out = await entryAcrossForks(new Gh(exec), new Glab(exec), {
      fork: "entitlements",
      code: "UNKNOWN_TOP_LEVEL",
      entries: ["schemathesis-tests"],
    });
    const byFork = Object.fromEntries(out.map((e) => [e.fork, e.state]));
    expect(byFork).toEqual({
      partition: "absent",
      legal: "unlisted",
      schema: "listed",
      file: "unread",
    });
    for (const c of calls) {
      expect(c[1]).toBe("api");
      expect(c).not.toContain("-X");
    }
  });

  test("a halt on something other than an entry is not checked across forks", async () => {
    const out = await entryAcrossForks(new Gh({} as RibExec), new Glab({} as RibExec), {
      fork: "legal",
      code: "CONFIG_INVALID",
      entries: ["line 4"],
    });
    expect(out).toEqual([]);
  });
});
