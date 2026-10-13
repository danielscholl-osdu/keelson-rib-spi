import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { attentionBoard, badge } from "../src/boards/attention";
import { PANEL_SOURCES, staleText } from "../src/boards/doctor";
import { engineeringBoard } from "../src/boards/engineering";
import { inspectBoard } from "../src/boards/inspect";
import { linesBoard } from "../src/boards/lines";
import { stackBoard } from "../src/boards/stack";
import { emptyFacts } from "../src/facts";
import { ATTENTION_KEY, ENGINEERING_KEY, LINES_KEY, STACK_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { buildTemplate } from "../src/model/template";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

function boards(m = model, f = facts) {
  return {
    [ATTENTION_KEY]: attentionBoard(m, f, FIXTURE_NOW),
    [STACK_KEY]: stackBoard(m, FIXTURE_NOW),
    [ENGINEERING_KEY]: engineeringBoard(m, FIXTURE_NOW),
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
  test("the banner pill is the verdict with the incident count, and rows carry rung and class", () => {
    const b = attentionBoard(model, facts, FIXTURE_NOW);
    expect(b.header?.status?.label).toMatch(/^BLOCKED · \d+ INCIDENTS?$/);
    expect(b.header?.chip).toBe("3 broke · 1 gate · 2 ready · 21:58 UTC");
    const rows = b.sections[0];
    expect(rows?.kind).toBe("rows");
    if (rows?.kind !== "rows") return;
    expect(rows.items[0]?.chip).toEqual({ label: "P0 · ENV", tone: "error" });
    expect(rows.items[0]?.text).toStartWith(
      "Environment · maintenance mode; env-upgrade v0.28.2 in verify",
    );
    expect(rows.items[0]?.action).toEqual({
      type: "inspect",
      payload: { id: model.queue.items[0]?.id },
    });
    expect(rows.items[0]?.href).toBeUndefined();
    expect(rows.items[0]?.detail).toBeUndefined();
  });

  test("every queue row leads its trailing text with the verb the inspector's Next line names", () => {
    const rows = attentionBoard(model, facts, FIXTURE_NOW).sections[0];
    if (rows?.kind !== "rows") throw new Error("queue first");
    expect(rows.items.map((r) => [r.chip?.label, r.trailing?.split(" · ")[0]])).toEqual([
      ["P0 · ENV", "Re-dispatch"],
      ["P0 · HALT", "Classify entry"],
      ["P1 · TOOLCHAIN", "Absorb toolchain"],
      ["P1 · GATE", "Approve runs"],
      ["P2 · READY", "Review, then Roll out"],
      ["P2 · READY", "Review on GitHub"],
    ]);
    model.queue.items.forEach((item, n) => {
      const next = inspectBoard(model, { selected: item.id, item }, FIXTURE_NOW).sections.find(
        (s) => "title" in s && s.title === "Next",
      );
      if (next?.kind !== "rows") throw new Error(`${item.id} has a Next line`);
      expect(next.items[0]?.chip?.label).toBe(rows.items[n]?.trailing?.split(" · ")[0]);
      expect(next.items[0]?.text.length).toBeGreaterThan(0);
    });
  });

  test("the open item's row is marked selected and no other is", () => {
    const id = model.queue.items[1]?.id;
    const b = attentionBoard(model, facts, FIXTURE_NOW, { selected: id });
    const rows = b.sections[0];
    if (rows?.kind !== "rows") throw new Error("queue first");
    expect(rows.items.filter((r) => r.selected)).toHaveLength(1);
    expect(rows.items[1]?.selected).toBe(true);
    expect(() => expectView(ATTENTION_KEY, "board")(b)).not.toThrow();
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
    expect(b.header?.chip).toMatch(/^⚠ DOCTOR · 1 PROBLEM · \d+ broke · /);
    expect(() => expectView(ATTENTION_KEY, "board")(b)).not.toThrow();
  });

  test("a panel whose source failed its last read says so in its header", () => {
    const f = fixtureFacts();
    f.github = {
      ...f.github,
      error: "API rate limit exceeded",
      errorAt: FIXTURE_NOW.toISOString(),
    };
    const m = buildModel(f, FIXTURE_NOW);
    const stale = staleText(f, PANEL_SOURCES.engineering, FIXTURE_NOW);
    expect(stale).toMatch(/^⚠ GitHub unread since \d\d:\d\d$/);
    expect(engineeringBoard(m, FIXTURE_NOW, { stale }).header?.chip).toBe(
      `${stale} · Azure/osdu-spi`,
    );
    const lines = linesBoard(m, FIXTURE_NOW, {
      stale: staleText(f, PANEL_SOURCES.lines, FIXTURE_NOW),
    });
    expect(lines.header?.chip).toMatch(/^⚠ GitHub unread since \d\d:\d\d · GitLab read /);
    expect(staleText(fixtureFacts(), PANEL_SOURCES.stack, FIXTURE_NOW)).toBeUndefined();
    expect(attentionBoard(m, f, FIXTURE_NOW).header?.chip).toStartWith("⚠ DOCTOR · ");
  });

  test("the badge counts P0 and P1 only", () => {
    const { p0, p1 } = model.queue.counts;
    expect(badge(model).count).toBe(p0 + p1);
  });

  test("services lead with the gate tiles, then one row per fork, worst first, then fleet lanes and open work", () => {
    const b = linesBoard(model, FIXTURE_NOW);
    expect(b.header?.status).toEqual({
      label: "1 HALTED · 1 BLOCKED · 3 UPDATES WAITING",
      tone: "warn",
    });
    expect(b.header?.chip).toMatch(/^GitLab read \d\d:\d\d · \d\d:\d\d /);
    expect(b.sections.map((s) => s.kind)).toEqual([
      "stats",
      "table",
      "grid",
      "rows",
      "rows",
      "table",
    ]);
    const [tiles, table, , fleet] = b.sections;
    if (tiles?.kind !== "stats" || table?.kind !== "table" || fleet?.kind !== "rows")
      throw new Error("tiles, table, fleet");
    expect(tiles.items.map((i) => i.label)).toEqual([
      "Upstream · oldest held",
      "Release · oldest PR",
      "Open work · people",
    ]);
    expect(tiles.items[0]).toMatchObject({
      clock: { at: "2026-10-08T00:08:17Z", mode: "since" },
      tone: "warn",
      sub: "upstream reaches main in 1 h 53 min at the median · 8 syncs in 21 d",
    });
    expect(tiles.items[1]).toMatchObject({
      value: "none",
      tone: "ok",
      sub: "5 releases cut in 21 d",
    });
    expect(table.columns.map((c) => c.label)).toEqual([
      "service",
      "upstream",
      "sync",
      "cascade",
      "main",
      "release",
      "lane",
      "template",
      "21 days",
    ]);
    expect(table.caption).toBe("storage, indexer and search have no fork yet");
    const text = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "value" in cell
        ? String(cell.value).replaceAll("\u00a0", " ")
        : cell;
    const tone = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "tone" in cell ? cell.tone : undefined;
    const row = (svc: string) => table.rows.find((r) => text(r.service) === svc);
    expect(table.rows.map((r) => text(r.service)).slice(0, 2)).toEqual(["entitlements", "legal"]);
    expect(text(row("partition")?.template)).toBe("◷ v1.2.0 → v1.2.1 · #174");
    expect(text(row("schema")?.template)).toBe("◷ v1.2.0 +2 → v1.2.1 · #37");
    expect(row("partition")?.upstream).toEqual({ value: "●", tone: "ok" });
    expect(text(row("entitlements")?.upstream)).toBe("2 behind");
    expect(tone(row("entitlements")?.upstream)).toBe("warn");
    expect(text(row("entitlements")?.sync)).toBe("✕ halted · 4d");
    expect(tone(row("entitlements")?.sync)).toBe("error");
    expect(text(row("legal")?.sync)).toBe("✕ PR #31 · 4d");
    expect(tone(row("legal")?.sync)).toBe("warn");
    expect(row("legal")?.cascade).toEqual({ value: "○", tone: "neutral" });
    expect(text(row("partition")?.release)).toBe("v1.3.1");
    const days = (svc: string) => {
      const cell = row(svc)?.days;
      if (typeof cell !== "object" || cell === null || !("bar" in cell))
        throw new Error("days bar");
      const bar = cell.bar;
      if (!bar || !("cells" in bar)) throw new Error("cells bar");
      return bar;
    };
    expect(days("entitlements").quiet).toBe(true);
    expect(days("entitlements").cells).toHaveLength(21);
    expect(
      days("entitlements")
        .cells.slice(-5)
        .map((c) => c.tone),
    ).toEqual(Array(5).fill("error"));
    expect(
      days("legal")
        .cells.slice(-5)
        .map((c) => c.tone),
    ).toEqual(Array(5).fill("warn"));
    expect(days("schema").cells.slice(0, 2)).toEqual([
      { label: "09-22 · no fork yet", hollow: true },
      { label: "09-23 · no fork yet", hollow: true },
    ]);
    expect(fleet.items.map((i) => i.text)).toEqual(["upstream", "template"]);
    const lane = (i: number) => {
      const bar = fleet.items[i]?.bar;
      if (!bar || !("columns" in bar)) throw new Error("columns bar");
      return bar;
    };
    expect(lane(1)).toMatchObject({ total: 5, rest: "ok" });
    expect(lane(1).columns).toHaveLength(21);
    expect(lane(1).columns.at(-1)?.segments).toEqual([
      { label: "waiting on review", n: 5, tone: "info" },
    ]);
    expect(lane(0).columns.at(-1)?.segments).toEqual([
      { label: "halted", n: 1, tone: "error" },
      { label: "failing", n: 1, tone: "warn" },
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
    const table = b.sections[1];
    if (table?.kind !== "table") throw new Error("table second");
    const text = (cell: unknown) =>
      typeof cell === "object" && cell !== null && "value" in cell
        ? String(cell.value).replaceAll("\u00a0", " ")
        : cell;
    const row = table.rows.find((r) => text(r.service) === "file");
    expect(row?.template).toMatchObject({ tone: "ok" });
    expect(text(row?.template)).toBe("v1.2.1");
    expect(text(row?.release)).toStartWith("◷ v1.2.0 → v1.2.1 · #60 · ");
    const tiles = b.sections[0];
    if (tiles?.kind !== "stats") throw new Error("tiles first");
    expect(tiles.items[1]?.clock?.at).toBe(release.createdAt);
  });

  function copies(n: number) {
    const f = fixtureFacts();
    const base = buildModel(f, FIXTURE_NOW);
    const lines = Array.from({ length: n + 1 }, (_, k) => k).flatMap((k) =>
      base.lines.map((line) => {
        const fork = { ...line.fork, id: `${line.fork.id}-${k}` };
        if (k === 0) return { ...line, fork };
        const pill = { label: "current", kind: "current" as const, tone: "ok" as const };
        if (line.halt || line.syncPr) return { ...line, fork, pill };
        return {
          ...line,
          fork,
          pill,
          releasePr: undefined,
          templatePr: undefined,
          template: { ...line.template, behind: 0 },
        };
      }),
    );
    const templateRepo = f.github.data?.repos["Azure/osdu-spi"];
    return {
      ...base,
      lines,
      template: buildTemplate(templateRepo, f.template.data, lines),
    };
  }

  function serviceNames(b: ReturnType<typeof linesBoard>): string[] {
    const table = b.sections[1];
    if (table?.kind !== "table") throw new Error("services table");
    return table.rows.map((r) =>
      typeof r.service === "object" && r.service ? String(r.service.value) : String(r.service),
    );
  }

  function foldText(b: ReturnType<typeof linesBoard>): string | undefined {
    const next = b.sections[2];
    return next?.kind === "rows" && !next.title ? next.items[0]?.text : undefined;
  }

  test("forks with nothing red fold once there are four; a red PR keeps a fork out", () => {
    const b = linesBoard(copies(3), FIXTURE_NOW);
    const rows = serviceNames(b);
    expect(rows).toHaveLength(11);
    expect(foldText(b)).toBe(
      "9 forks current · partition-1, schema-1, file-1, partition-2, schema-2, file-2, partition-3, schema-3 and file-3",
    );
    expect(rows).toContain("legal-2");
    expect(rows).toContain("entitlements-3");
    const fleet = b.sections[4];
    if (fleet?.kind !== "rows") throw new Error("fleet lanes");
    expect(fleet.items).toHaveLength(2);
    for (const item of fleet.items) expect(item.bar).toMatchObject({ total: 20 });
    expect(() => expectView(LINES_KEY, "board")(b)).not.toThrow();
  });

  test("three quiet forks stay as rows, as on the recorded sweep", () => {
    const few = linesBoard(copies(1), FIXTURE_NOW);
    expect(serviceNames(few)).toHaveLength(10);
    expect(foldText(few)).toBeUndefined();
    expect(serviceNames(linesBoard(model, FIXTURE_NOW))).toEqual([
      "entitlements",
      "legal",
      "partition",
      "schema",
      "file",
    ]);
  });

  test("the fold row counts the PRs its forks wait on, named in the banner", () => {
    const m = copies(3);
    const open = model.lines[0]?.templatePr;
    if (!open) throw new Error("fixture has a template-sync PR");
    const releasePr = {
      pr: { ...open.pr, title: "chore: release 1.3.2", checks: [] },
      prClass: "release" as const,
      failures: [],
    };
    const lines = m.lines.map((l) => (l.fork.id === "partition-1" ? { ...l, releasePr } : l));
    const text = foldText(linesBoard({ ...m, lines }, FIXTURE_NOW));
    expect(text).toEndWith("· 1 release PR waits, named in the banner");
    expect(text).toStartWith("9 forks current or waiting on review · ");
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

  test("the environment keeps its three tiles in place and shows how the outage unfolded", () => {
    const b = stackBoard(model, FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "MAINTENANCE MODE", tone: "error" });
    const stats = b.sections[0];
    if (stats?.kind !== "stats") throw new Error("stats first");
    expect(stats.items.map((i) => i.label)).toEqual([
      "Running",
      "Greenfield · smoke",
      "Brownfield · in maintenance since",
    ]);
    expect(model.stack.maintenance.since).toStartWith("2026-10-11T22:44");
    expect(stats.items[2]?.clock).toEqual({ at: model.stack.maintenance.since!, mode: "since" });
    expect(stats.items[0]).toMatchObject({ value: "v0.28.0", tone: "warn" });
    expect(stats.items[0]?.delta?.text).toBe("v0.28.2 declared");
    expect(stats.items[0]?.sub).toMatch(
      /^v0\.28\.2 is latest · landed 10-0[56] \d\d:\d\d · 50 min after release, usually 33$/,
    );
    expect(stats.items[1]).toMatchObject({ tone: "ok" });
    expect(stats.items[1]?.sub).toMatch(/^fresh cluster to green in 26 min, usually 32 · next /);
    const kinds = b.sections.map((s) => s.kind);
    expect(kinds.slice(0, 4)).toEqual(["stats", "grid", "timeline", "rows"]);
    const titled = (prefix: string) => {
      const s = b.sections.find((x) => x.kind === "rows" && x.title?.startsWith(prefix));
      if (s?.kind !== "rows") throw new Error(prefix);
      return s;
    };
    expect(titled("Greenfield").items.map((i) => i.text)).toEqual(["smoke · daily 08:00Z"]);
    const brown = titled("Brownfield");
    expect(brown.items.map((i) => i.text)).toEqual([
      "behind latest",
      "upgrade · on bump",
      "refresh · weekdays 04:00Z",
    ]);
    const cells = (i: number) => {
      const bar = brown.items[i]?.bar;
      if (!bar || !("cells" in bar)) throw new Error("cells");
      return bar.cells;
    };
    expect(cells(2)).toHaveLength(21);
    expect(cells(2).at(-1)).toMatchObject({ tone: "error" });
    expect(cells(2)[4]).toMatchObject({ hollow: true });
    expect(cells(2)[4]?.tone).toBeUndefined();
    const behind = brown.items[0]?.bar;
    if (!behind || !("columns" in behind)) throw new Error("columns");
    expect(behind.columns.map((c) => c.segments[0]?.n ?? 0)).toEqual([
      0, 1, 3, 5, 5, 5, 1, 0, 0, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 1, 2,
    ]);
    expect(titled("Housekeeping").items).toEqual([
      expect.objectContaining({ text: "sweeper · green on every run in 21 days" }),
    ]);
  });

  test("a healthy environment shows the version, smoke and the last refresh, and no incident", () => {
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
    expect(stats.items.map((i) => i.label)).toEqual([
      "Running",
      "Greenfield · smoke",
      "Brownfield · refresh",
    ]);
    expect(stats.items[2]?.sub).toMatch(/^re-proved in place in \d+ min(, usually \d+)? · next /);
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
    const refresh = stats.items[2];
    expect(refresh?.label).toBe("Brownfield · refresh");
    expect(refresh?.tone).toBe("warn");
    expect(refresh?.sub).toMatch(/^failed · then env-upgrade v0\.28\.2 green \d\d:\d\d · next /);
  });
});

describe("a template release the forks have not taken yet", () => {
  // v1.3.0 cut from main after the forks' PRs were opened at v1.2.0 +14.
  function released() {
    const f = fixtureFacts();
    const repo = f.github.data?.repos["Azure/osdu-spi"];
    if (!repo || !f.template.data) throw new Error("template facts");
    repo.release = {
      tag: "v1.3.0",
      at: "2026-10-12T21:00:00Z",
      url: "https://github.com/Azure/osdu-spi/releases/tag/v1.3.0",
    };
    repo.prs = repo.prs.filter((p) => !/release/.test(p.title));
    f.template.data.latestTag = "v1.3.0";
    f.template.data.mainAhead = 0;
    return buildModel(f, FIXTURE_NOW);
  }

  test("open PRs keep their position and the banner says a newer release is out", () => {
    const model = released();
    const set = model.queue.items.find((i) => i.id === "template-set");
    expect(set?.text).toStartWith("5 template-sync PRs to v1.2.0 +14 (v1.3.0 is out)");
    expect(set?.cause.find((c) => c.label === "latest")?.value).toBe(
      "v1.3.0 is out; these PRs carry the template before it",
    );
    expect(model.lines.map((l) => l.template.target).filter(Boolean)).not.toContain("v1.3.0");
  });
});
