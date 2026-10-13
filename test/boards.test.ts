import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { attentionBoard, badge } from "../src/boards/attention";
import { doctorBoard } from "../src/boards/doctor";
import { linesBoard } from "../src/boards/lines";
import { stackBoard } from "../src/boards/stack";
import { emptyFacts } from "../src/facts";
import { ATTENTION_KEY, DOCTOR_KEY, LINES_KEY, STACK_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

function boards(m = model, f = facts) {
  return {
    [ATTENTION_KEY]: attentionBoard(m, f, FIXTURE_NOW),
    [STACK_KEY]: stackBoard(m, FIXTURE_NOW),
    [LINES_KEY]: linesBoard(m, FIXTURE_NOW),
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
    expect(rows.items[0]?.text).toStartWith(
      "Shared stack · maintenance mode; env-upgrade v0.28.2 in verify",
    );
    expect(rows.items[0]?.detail).toContain("partition template-sync PR #174");
  });

  test("the badge counts P0 and P1 only", () => {
    const { p0, p1 } = model.queue.counts;
    expect(badge(model).count).toBe(p0 + p1);
  });

  test("one row per fork with its stations in flow order, then the template changes", () => {
    const b = linesBoard(model, FIXTURE_NOW);
    expect(b.header?.status).toEqual({
      label: "1 HALTED · 1 BLOCKED · 3 UPDATES WAITING",
      tone: "warn",
    });
    expect(b.header?.chip).toStartWith("main green on all 5 forks · 0 current · ");
    const table = b.sections[0];
    if (table?.kind !== "table") throw new Error("table first");
    expect(table.columns.map((c) => c.label)).toEqual([
      "service",
      "state",
      "upstream",
      "template",
      "release",
      "notes",
    ]);
    expect(table.caption).toBe("storage, indexer and search have no fork yet");
    const text = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "value" in cell
        ? String(cell.value).replaceAll("\u00a0", " ")
        : cell;
    const row = (svc: string) => table.rows.find((r) => text(r.service) === svc);
    expect(text(row("partition")?.template)).toBe("◷ PR #174 · v1.2.0 → v1.2.1 (unreleased)");
    expect(text(row("schema")?.template)).toBe("◷ PR #37 · v1.2.0 +2 → v1.2.1 (unreleased)");
    expect(text(row("entitlements")?.upstream)).toBe("✕ halted · 2 behind");
    expect(text(row("legal")?.upstream)).toBe("✕ PR #31 failing · 4 behind");
    const tone = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "tone" in cell ? cell.tone : undefined;
    expect(tone(row("entitlements")?.upstream)).toBe("error");
    expect(tone(row("legal")?.upstream)).toBe("warn");
    expect(tone(row("partition")?.template)).toBe("info");
    expect(text(row("partition")?.release)).toBe("✓ v1.3.1 · 6d");
    expect(row("legal")?.notes).toContain("upstream requires Java 25");
    expect(row("partition")?.notes).toBe("");
    const changes = b.sections[1];
    if (changes?.kind !== "rows") throw new Error("change list second");
    expect(changes.title).toBe(
      "Template changes not on every fork · v1.2.1 (unreleased), 14 commits past v1.2.0",
    );
    expect(changes.items.find((i) => i.text.endsWith("(#247)"))?.trailing).toStartWith(
      "all but schema",
    );
  });

  test("the header is red only for a red main, and calm when only updates wait", () => {
    const red = fixtureFacts();
    const runs = red.runs.data?.["Azure/osdu-spi-partition"];
    if (!runs?.main[0]) throw new Error("fixture has partition main runs");
    runs.main[0] = { ...runs.main[0], status: "completed", conclusion: "failure" };
    const redBoard = linesBoard(buildModel(red, FIXTURE_NOW), FIXTURE_NOW);
    expect(redBoard.header?.status).toEqual({
      label: "1 MAIN RED · 1 HALTED · 1 BLOCKED · 2 UPDATES WAITING",
      tone: "error",
    });
    expect(redBoard.header?.chip).toStartWith("main green on 4 of 5 forks");

    const calm = fixtureFacts();
    const repos = calm.github.data?.repos;
    const entitlements = repos?.["Azure/osdu-spi-entitlements"];
    const legal = repos?.["Azure/osdu-spi-legal"];
    if (!entitlements || !legal) throw new Error("fixture has entitlements and legal");
    entitlements.issues = entitlements.issues.filter((i) => !i.labels.includes("sync-failed"));
    legal.prs = legal.prs.filter((p) => p.number !== 31);
    const calmBoard = linesBoard(buildModel(calm, FIXTURE_NOW), FIXTURE_NOW);
    expect(calmBoard.header?.status).toEqual({ label: "5 UPDATES WAITING", tone: "info" });
  });

  test("the stack panel answers whether forks can deploy, then shows how the outage unfolded", () => {
    const b = stackBoard(model, FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "MAINTENANCE MODE", tone: "error" });
    const stats = b.sections[0];
    if (stats?.kind !== "stats") throw new Error("stats first");
    expect(stats.items.map((i) => i.label)).toEqual([
      "In maintenance since",
      "Running",
      "In verify since",
    ]);
    expect(model.stack.maintenance.since).toStartWith("2026-10-11T22:44");
    expect(stats.items[0]?.clock).toEqual({ at: model.stack.maintenance.since!, mode: "since" });
    expect(stats.items[1]?.value).toBe("v0.28.0");
    expect(stats.items[1]?.delta?.text).toBe("v0.28.2 declared");
    const kinds = b.sections.map((s) => s.kind);
    expect(kinds.slice(0, 4)).toEqual(["stats", "grid", "timeline", "rows"]);
    const strips = b.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Each run"));
    if (strips?.kind !== "rows") throw new Error("run strips");
    expect(strips.items.map((i) => i.text)).toEqual(["refresh", "upgrade", "smoke", "sweeper"]);
  });

  test("a healthy stack shows the version, the last refresh and smoke, and no incident", () => {
    const f = fixtureFacts();
    const lc = f.lifecycle.data!;
    const cut = Date.parse("2026-10-11T22:00:00Z");
    f.lifecycle.data = {
      ...lc,
      refresh: lc.refresh.filter((r) => Date.parse(r.createdAt) < cut),
      upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
    };
    const b = stackBoard(buildModel(f, FIXTURE_NOW), FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "DEPLOYABLE", tone: "ok" });
    const stats = b.sections[0];
    if (stats?.kind !== "stats") throw new Error("stats first");
    expect(stats.items.map((i) => i.label)).toEqual(["Running", "Last refresh", "Smoke"]);
    expect(b.sections.some((s) => s.kind === "timeline")).toBe(false);
    expect(() => expectView(STACK_KEY, "board")(b)).not.toThrow();
  });
});
