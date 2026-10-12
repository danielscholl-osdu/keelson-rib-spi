import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { attentionBoard, badge } from "../src/boards/attention";
import { doctorBoard } from "../src/boards/doctor";
import { linesBoard } from "../src/boards/lines";
import { stackBoard } from "../src/boards/stack";
import { templateBoard } from "../src/boards/template";
import { emptyFacts } from "../src/facts";
import { ATTENTION_KEY, DOCTOR_KEY, LINES_KEY, STACK_KEY, TEMPLATE_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

function boards(m = model, f = facts) {
  return {
    [ATTENTION_KEY]: attentionBoard(m, f, FIXTURE_NOW),
    [STACK_KEY]: stackBoard(m, FIXTURE_NOW),
    [LINES_KEY]: linesBoard(m, FIXTURE_NOW),
    [TEMPLATE_KEY]: templateBoard(m, FIXTURE_NOW),
    [DOCTOR_KEY]: doctorBoard(f, FIXTURE_NOW),
  };
}

describe("every board passes the host's render gate", () => {
  test("with the 12 October sweep", () => {
    for (const [key, board] of Object.entries(boards()))
      expect(() => expectView(key, "board")(board)).not.toThrow();
  });

  test("before any sweep", () => {
    const f = emptyFacts();
    const m = buildModel(f, FIXTURE_NOW);
    for (const [key, board] of Object.entries(boards(m, f)))
      expect(() => expectView(key, "board")(board)).not.toThrow();
    expect(attentionBoard(m, f, FIXTURE_NOW).header?.status?.label).toBe("SWEEPING");
    expect(badge(m)).toEqual({ count: 0 });
  });

  test("when GitHub could not be read", () => {
    const f = emptyFacts();
    f.github = { error: "gh api graphql: HTTP 502", errorAt: FIXTURE_NOW.toISOString() };
    const m = buildModel(f, FIXTURE_NOW);
    const board = attentionBoard(m, f, FIXTURE_NOW);
    expect(board.header?.status?.label).toBe("DARK");
    expect(() => expectView(ATTENTION_KEY, "board")(board)).not.toThrow();
  });
});

describe("what the boards say", () => {
  test("the banner pill is the verdict with the incident count, and rows carry P chips", () => {
    const b = attentionBoard(model, facts, FIXTURE_NOW);
    expect(b.header?.status?.label).toMatch(/^BLOCKED · \d+ INCIDENTS?$/);
    const rows = b.sections[0];
    expect(rows?.kind).toBe("rows");
    if (rows?.kind !== "rows") return;
    expect(rows.items[0]?.chip).toEqual({ label: "P0", tone: "error" });
    expect(rows.items[0]?.text).toStartWith("Shared stack · upgrade to v0.28.1 failed");
    expect(rows.items[0]?.detail).toContain("partition template-sync PR #174");
  });

  test("the badge counts P0 and P1 only", () => {
    const { p0, p1 } = model.queue.counts;
    expect(badge(model).count).toBe(p0 + p1);
  });

  test("five line cards with a six-station strip, then three empty seats", () => {
    const b = linesBoard(model, FIXTURE_NOW);
    const cards = b.sections[0];
    expect(cards?.kind).toBe("cards");
    if (cards?.kind !== "cards") return;
    expect(cards.items.map((c) => c.title)).toEqual([
      "partition",
      "entitlements",
      "legal",
      "schema",
      "file",
      "storage",
      "indexer",
      "search",
    ]);
    const legal = cards.items[2];
    expect(legal?.bar && "segments" in legal.bar ? legal.bar.segments.length : 0).toBe(6);
    expect(legal?.reason?.text).toContain("upstream requires Java 25");
    expect(cards.items.slice(5).every((c) => c.ghost)).toBe(true);
    expect(b.header?.status?.label).toBe("3 OF 5 CURRENT");
  });

  test("the stack strip shows maintenance with the upgrade in flight and the 21-day bars", () => {
    const b = stackBoard(model, FIXTURE_NOW);
    expect(b.header?.status?.label).toMatch(/^MAINTENANCE · UPGRADE IN /);
    expect(b.sections.map((s) => s.kind)).toContain("bars");
    const stats = b.sections[0];
    if (stats?.kind !== "stats") throw new Error("stats first");
    expect(stats.items.find((i) => i.label === "Running")?.value).toBe("v0.28.0");
  });
});
