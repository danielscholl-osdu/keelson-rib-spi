import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { attentionBoard, badge } from "../src/boards/attention";
import { linesBoard } from "../src/boards/lines";
import { stackBoard } from "../src/boards/stack";
import { emptyFacts } from "../src/facts";
import { ATTENTION_KEY, LINES_KEY, STACK_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { buildTemplate } from "../src/model/template";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

function boards(m = model, f = facts) {
  return {
    [ATTENTION_KEY]: attentionBoard(m, f, FIXTURE_NOW),
    [STACK_KEY]: stackBoard(m, FIXTURE_NOW),
    [LINES_KEY]: linesBoard(m, FIXTURE_NOW),
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
    const rows = board.sections[0];
    if (rows?.kind !== "rows") throw new Error("doctor row first");
    expect(rows.items[0]).toMatchObject({
      glyph: "error",
      text: "Doctor · GitHub unreadable: gh api graphql: HTTP 502",
    });
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

  test("the doctor is one quiet row under the queue while every source reads", () => {
    const b = attentionBoard(model, facts, FIXTURE_NOW);
    expect(b.sections).toHaveLength(2);
    const doctor = b.sections[1];
    if (doctor?.kind !== "rows") throw new Error("doctor row last");
    expect(doctor.items).toHaveLength(1);
    expect(doctor.items[0]).toMatchObject({ glyph: "ok", text: "Doctor · all clear" });
    expect(doctor.items[0]?.trailing).toMatch(/^swept \d\d:\d\d · 13\.0 s · 38 calls$/);
    expect(doctor.items[0]?.detail).toContain("✓ gh · signed in as operator");
    expect(doctor.items[0]?.detail).toContain("✓ GitLab upstream lag · read ");
  });

  test("a source that stops reading moves the doctor above the queue and names it", () => {
    const f = fixtureFacts();
    f.upstream = {
      ...f.upstream,
      error: "glab: 401 Unauthorized",
      errorAt: FIXTURE_NOW.toISOString(),
    };
    const b = attentionBoard(buildModel(f, FIXTURE_NOW), f, FIXTURE_NOW);
    const doctor = b.sections[0];
    if (doctor?.kind !== "rows") throw new Error("doctor row first");
    expect(doctor.items[0]?.glyph).toBe("warn");
    expect(doctor.items[0]?.text).toMatch(
      /^Doctor · GitLab upstream lag failed \d\d:\d\d: glab: 401 Unauthorized$/,
    );
    expect(doctor.items[0]?.detail).toStartWith("Each panel keeps a source's last good read");
    expect(b.sections[1]?.kind).toBe("rows");
    expect(() => expectView(ATTENTION_KEY, "board")(b)).not.toThrow();
  });

  test("the badge counts P0 and P1 only", () => {
    const { p0, p1 } = model.queue.counts;
    expect(badge(model).count).toBe(p0 + p1);
  });

  test("one row per fork, worst first, then the template ladder", () => {
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
    expect(table.rows.map((r) => text(r.service)).slice(0, 2)).toEqual(["entitlements", "legal"]);
    expect(text(row("partition")?.template)).toBe("◷ v1.2.0 · PR #174");
    expect(text(row("schema")?.template)).toBe("◷ v1.2.0 +2 · PR #37");
    expect(text(row("partition")?.upstream)).toBe("✓ current");
    expect(text(row("entitlements")?.upstream)).toBe("✕ 2 behind · halted");
    expect(text(row("legal")?.upstream)).toBe("✕ 4 behind · PR #31 failing");
    const tone = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "tone" in cell ? cell.tone : undefined;
    expect(tone(row("entitlements")?.upstream)).toBe("error");
    expect(tone(row("legal")?.upstream)).toBe("warn");
    expect(tone(row("partition")?.template)).toBe("info");
    expect(tone(row("partition")?.upstream)).toBe("ok");
    expect(tone(row("partition")?.release)).toBe("ok");
    expect(text(row("partition")?.release)).toBe("✓ v1.3.1 · 6d");
    expect(row("entitlements")?.notes).toBe("UNKNOWN_TOP_LEVEL: schemathesis-tests · 4d");
    expect(row("legal")?.notes).toBe(
      "Java Build: upstream requires Java 25, the fork builds on 17 · 4d",
    );
    expect(row("partition")?.notes).toBe("");
    const ladder = b.sections[1];
    if (ladder?.kind !== "bars") throw new Error("ladder second");
    expect(b.sections).toHaveLength(2);
    expect(ladder.title).toBe("Template · osdu-spi main is v1.2.1, 5 changes past v1.2.0");
    expect(ladder.items.map((i) => [i.label, i.value, i.total, i.trailing])).toEqual([
      [
        "v1.2.1 · 4 changes: images, actions, workflows, 1 template only",
        0,
        5,
        "0 of 5 · 5 waiting",
      ],
      ["v1.2.0 +2 · 1 change: images, actions, workflows", 1, 5, "1 of 5 · 4 waiting"],
      ["v1.2.0", 5, 5, "5 of 5 · every fork"],
    ]);
    expect(ladder.items[0]?.href).toBe(
      "https://github.com/Azure/osdu-spi/compare/ddfd9ff376b1f49a2f41b7a9f55e9541796cba45...bb49a034a3dcdaa922a1905e708ec66bde930888",
    );
    expect(ladder.items[1]?.segments).toEqual([
      { label: "adopted", n: 1, tone: "ok" },
      { label: "PR waiting", n: 4, tone: "info" },
    ]);
  });

  test("a fork that took the template reads current, with its release PR as a version move", () => {
    const f = fixtureFacts();
    const repos = f.github.data?.repos;
    const file = repos?.["Azure/osdu-spi-file"];
    const template = repos?.["Azure/osdu-spi"];
    const head = template?.head?.sha;
    const compares = f.template.data?.compares;
    const release = template?.prs.find((p) => p.head.startsWith("release-please--"));
    if (!file || !head || !compares || !release)
      throw new Error("fixture has file and the template");
    file.marker = head;
    file.prs = [
      ...file.prs.filter((p) => !p.head.startsWith("template-sync/")),
      {
        ...release,
        repo: "Azure/osdu-spi-file",
        number: 60,
        title: "chore: release 1.2.1",
        url: "https://github.com/Azure/osdu-spi-file/pull/60",
      },
    ];
    compares[head] = { marker: head, head, label: "v1.2.0 +14", aheadBy: 0, shas: [], changes: [] };
    const b = linesBoard(buildModel(f, FIXTURE_NOW), FIXTURE_NOW);
    const table = b.sections[0];
    if (table?.kind !== "table") throw new Error("table first");
    const text = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "value" in cell
        ? String(cell.value).replaceAll("\u00a0", " ")
        : cell;
    const row = table.rows.find((r) => text(r.service) === "file");
    expect(row?.state).toEqual({ badges: [{ text: "current", tone: "ok" }] });
    expect(row?.template).toMatchObject({ tone: "ok" });
    expect(text(row?.template)).toBe("✓ v1.2.1");
    expect(text(row?.release)).toStartWith("◷ v1.2.0 → v1.2.1 · PR #60");
    expect(b.header?.chip).toStartWith("main green on all 5 forks · 1 current · ");
    const ladder = b.sections[1];
    if (ladder?.kind !== "bars") throw new Error("ladder second");
    expect(ladder.items[0]).toMatchObject({ value: 1 });
    expect(ladder.items[0]?.label).toStartWith("v1.2.1 · ");
  });

  test("at twenty forks the ladder keeps one row per template step and current forks fold", () => {
    const f = fixtureFacts();
    const base = buildModel(f, FIXTURE_NOW);
    const lines = [0, 1, 2, 3].flatMap((k) =>
      base.lines.map((line, i) => {
        const fork = { ...line.fork, id: `${line.fork.id}-${k}` };
        if (k === 0 || (k === 1 && i === 0)) return { ...line, fork };
        return {
          ...line,
          fork,
          pill: { label: "current", kind: "current" as const, tone: "ok" as const },
          releasePr: undefined,
        };
      }),
    );
    const templateRepo = f.github.data?.repos["Azure/osdu-spi"];
    const model = {
      ...base,
      lines,
      template: buildTemplate(templateRepo, f.template.data, lines),
    };
    const b = linesBoard(model, FIXTURE_NOW);
    const table = b.sections[0];
    const ladder = b.sections[1];
    if (table?.kind !== "table" || ladder?.kind !== "bars") throw new Error("table, then ladder");
    expect(ladder.items).toHaveLength(3);
    expect(ladder.items.every((i) => i.total === 20)).toBe(true);
    const folded = table.rows.at(-1);
    expect(folded?.service).toBe("14 current");
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]?.state).toEqual({
      badges: [{ text: "sync\u00a0halted", tone: "error" }],
    });
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

  test("a refresh that failed before a green upgrade is amber, not red", () => {
    const f = fixtureFacts();
    const lc = f.lifecycle.data;
    const [latest, ...older] = lc?.upgrade ?? [];
    const green = older.find((r) => r.conclusion === "success" && r.jobs);
    if (!lc || !latest || !green) throw new Error("fixture has upgrade runs");
    f.lifecycle.data = {
      ...lc,
      upgrade: [
        {
          ...latest,
          status: "completed",
          conclusion: "success",
          updatedAt: "2026-10-12T22:05:00Z",
          jobs: green.jobs,
        },
        ...older,
      ],
    };
    const b = stackBoard(buildModel(f, FIXTURE_NOW), FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "DEPLOYABLE", tone: "ok" });
    const stats = b.sections[0];
    if (stats?.kind !== "stats") throw new Error("stats first");
    const refresh = stats.items[1];
    expect(refresh?.label).toBe("Last refresh");
    expect(refresh?.tone).toBe("warn");
    expect(refresh?.sub).toMatch(/^failed · then env-upgrade v0\.28\.2 green \d\d:\d\d$/);
  });
});
