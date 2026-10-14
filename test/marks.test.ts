import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { attentionBoard } from "../src/boards/attention";
import { engineeringBoard } from "../src/boards/engineering";
import { inspectBoard } from "../src/boards/inspect";
import { linesBoard } from "../src/boards/lines";
import { stackBoard } from "../src/boards/stack";
import { ENGINEERING_KEY, LINES_KEY, STACK_KEY } from "../src/keys";
import { fleetDays, type TrackDay, windowDays } from "../src/model/history";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

type Board = ReturnType<typeof linesBoard>;

function grid(b: Board, prefix: string) {
  const s = b.sections.find((x) => x.kind === "grid" && x.title?.startsWith(prefix));
  if (s?.kind !== "grid") throw new Error(`a key titled ${prefix}`);
  return s;
}

// Every drawn string but links, so "?" in a query string never counts.
function marks(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") {
    if (/(^|[\s(·])\?($|[\s)·])/.test(x)) out.push(x);
  } else if (Array.isArray(x)) for (const v of x) marks(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) if (k !== "href" && k !== "url") marks(v, out);
  return out;
}

describe("keys and spans", () => {
  test("the Environment history opens with one key that names its span once", () => {
    const b = stackBoard(model, FIXTURE_NOW);
    expect(() => expectView(STACK_KEY, "board")(b)).not.toThrow();
    const key = grid(b, "History · ");
    expect(key.title).toBe("History · 09-22 to today, one cell per day");
    expect(key.cells.map((c) => [c.label, c.badge?.tone, c.badge?.text])).toEqual([
      ["passed", "ok", "■"],
      ["failed or held", "error", "■"],
      ["cancelled", "warn", "■"],
      ["running", "info", "■"],
      ["missed its slot", "error", "□"],
      ["due later today", "info", "□"],
      ["nothing due", "neutral", "□"],
      ["releases behind", "neutral", "■"],
    ]);
    const titles = b.sections.map((s) => ("title" in s ? s.title : undefined));
    expect(titles.indexOf(key.title)).toBeLessThan(titles.indexOf("Environment"));
    expect(titles.indexOf("Environment")).toBeLessThan(titles.indexOf("Lifecycle"));
    expect(titles.filter((t) => t?.includes("one cell per day"))).toHaveLength(1);
  });

  test("the Services fleet block opens with its key and its span", () => {
    const b = linesBoard(model, FIXTURE_NOW);
    expect(() => expectView(LINES_KEY, "board")(b)).not.toThrow();
    const key = grid(b, "Fleet · ");
    expect(key.title).toBe(
      "Fleet · forks not caught up at day end · 09-22 to today, one column per day",
    );
    expect(key.cells.map((c) => [c.label, c.badge?.tone])).toEqual([
      ["halted", "error"],
      ["failing", "warn"],
      ["waiting on review", "info"],
    ]);
  });
});

describe("fleet denominators", () => {
  test("a day counts only the forks that existed on it", () => {
    const days = windowDays(FIXTURE_NOW, 3);
    const track = (states: TrackDay["state"][]): TrackDay[] =>
      states.map((state, i) => ({ day: days[i] as TrackDay["day"], state }));
    const fleet = fleetDays([
      track(["ok", "waiting", "ok"]),
      track(["halted", "halted", "ok"]),
      track(["none", "none", "failing"]),
    ]);
    expect(fleet.map((d) => [d.forks, d.halted, d.failing, d.waiting])).toEqual([
      [2, 1, 0, 0],
      [2, 1, 0, 1],
      [3, 0, 1, 0],
    ]);
    expect(fleetDays([track(["ok", "ok", "ok"]), undefined]).every((d) => d.unread)).toBe(true);
  });

  test("on the recorded sweep a September day reads of 3 and today of 5", () => {
    const b = linesBoard(model, FIXTURE_NOW);
    const at = b.sections.findIndex((s) => s.kind === "grid");
    const lanes = b.sections[at + 1];
    if (lanes?.kind !== "rows") throw new Error("fleet lanes under the key");
    const bar = lanes.items[0]?.bar;
    if (!bar || !("columns" in bar)) throw new Error("a column bar");
    const first = bar.columns[0];
    const today = bar.columns.at(-1);
    expect(first?.label).toMatch(/^09-22 · \d+ of 3 not caught up, 2 not forked yet$/);
    expect(first?.segments.map((s) => s.tone)).not.toContain("neutral");
    expect(today?.label).toMatch(/^10-12 · \d+ of 5 not caught up$/);
    expect(today?.label).not.toContain("forked");
  });
});

describe("? is for a read that failed", () => {
  test("no ? on any board of the recorded sweep while the doctor is all clear", () => {
    const boards = [
      attentionBoard(model, facts, FIXTURE_NOW),
      stackBoard(model, FIXTURE_NOW),
      linesBoard(model, FIXTURE_NOW),
      engineeringBoard(model, FIXTURE_NOW),
      ...model.queue.items.map((i) =>
        inspectBoard(model, { selected: i.id, item: i }, FIXTURE_NOW),
      ),
    ];
    const doctor = boards[0]?.sections.at(-1);
    expect(doctor?.kind === "rows" && doctor.items[0]?.text).toBe("Doctor · all clear");
    expect(marks(boards)).toEqual([]);
  });

  function rollout(edit: (m: typeof model) => typeof model) {
    const b = engineeringBoard(edit(model), FIXTURE_NOW);
    expect(() => expectView(ENGINEERING_KEY, "board")(b)).not.toThrow();
    const table = b.sections.find((s) => s.kind === "table");
    if (table?.kind !== "table") throw new Error("rollout table");
    const row = table.rows.find((r) => typeof r.fork === "object" && r.fork?.value === "file");
    const text = (c: unknown) =>
      typeof c === "object" && c && "value" in c ? String(c.value).replaceAll(" ", " ") : c;
    return { on: text(row?.on), pr: text(row?.pr), sync: text(row?.sync) };
  }

  const noRun = (m: typeof model, runsRead: boolean) => ({
    ...m,
    template: {
      ...m.template,
      rows: m.template.rows.map((r) =>
        r.service === "file" ? { ...r, delivery: { state: "unknown" as const } } : r,
      ),
    },
    lines: m.lines.map((l) => (l.fork.id === "file" ? { ...l, runsRead } : l)),
  });

  test("a fork with no Sync Template run in the window says so; ? only when runs were unread", () => {
    expect(rollout((m) => noRun(m, true)).sync).toBe("no run in 21 d");
    expect(rollout((m) => noRun(m, false)).sync).toBe("?");
  });

  test("a fork read with no template marker reads —; a marker whose compare failed reads ?", () => {
    const unplaced = (marker: string | undefined) => (m: typeof model) => ({
      ...m,
      template: {
        ...m.template,
        rows: m.template.rows.map((r) =>
          r.service === "file"
            ? { ...r, marker, label: undefined, behind: undefined, pr: undefined }
            : r,
        ),
      },
    });
    expect(rollout(unplaced(undefined))).toMatchObject({ on: "—", pr: "—" });
    expect(rollout(unplaced("c0de"))).toMatchObject({ on: "?", pr: "?" });
  });
});
