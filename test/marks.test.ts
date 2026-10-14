import { describe, expect, test } from "bun:test";
import { doctorBoard, doctorStatus } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { radarBreaks } from "../src/boards/radar";
import { STEP_PREFIX } from "../src/boards/template";
import { buildBriefing } from "../src/brief/index";
import { fleetDays, type TrackDay, windowDays } from "../src/model/history";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);

// Every drawn string but links, so "?" in a query string never counts.
function marks(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") {
    if (/(^|[\s(·])\?($|[\s)·])/.test(x)) out.push(x);
  } else if (Array.isArray(x)) for (const v of x) marks(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) if (k !== "href" && k !== "url") marks(v, out);
  return out;
}

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

  test("on the recorded sweep a September day counts 3 forks and today 5", () => {
    for (const lane of ["upstream", "template"] as const) {
      const days = fleetDays(model.lines.map((l) => l.history?.[lane]));
      expect(days[0]?.day.key).toBe("09-22");
      expect(days[0]?.forks).toBe(3);
      expect(days.at(-1)?.day.key).toBe("10-12");
      expect(days.at(-1)?.forks).toBe(5);
      expect(days.every((d) => !d.unread)).toBe(true);
    }
  });
});

describe("? is for a read that failed", () => {
  test("no ? in the briefing or any inspector of the recorded sweep while the doctor is all clear", () => {
    const doctor = doctorBoard(facts, FIXTURE_NOW);
    expect(doctor.header?.status?.label).toBe("ALL CLEAR");
    const ids = [
      ...model.queue.items.map((i) => i.id),
      ...model.template.steps.map((s) => `${STEP_PREFIX}${s.marker}`),
      ...radarBreaks(model).map((b) => `mr:${b.fork}:${b.iid}`),
    ];
    const boards = [doctor, ...ids.map((id) => inspectBoard(model, { selected: id }, FIXTURE_NOW))];
    const briefing = buildBriefing(model, doctorStatus(facts, FIXTURE_NOW), FIXTURE_NOW);
    expect(marks(boards)).toEqual([]);
    expect(marks(briefing)).toEqual([]);
  });
});
