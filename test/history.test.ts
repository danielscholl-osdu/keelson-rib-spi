import { describe, expect, test } from "bun:test";
import type { LifecycleRun } from "../src/facts";
import { behindDays, lineHistory, median, runDays, windowDays } from "../src/model/history";
import { cadence, firesOn, nextFire, parseCron, toCrons } from "../src/model/schedule";

const DAY = 86_400_000;

function run(over: Partial<LifecycleRun>): LifecycleRun {
  return {
    id: 1,
    name: "Environment Refresh",
    path: ".github/workflows/env-refresh.yml",
    event: "schedule",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-10-12T04:10:00Z",
    updatedAt: "2026-10-12T04:13:00Z",
    sha: "abc",
    title: "Environment Refresh",
    url: "https://example.test/run",
    attempt: 1,
    kind: "refresh",
    ...over,
  };
}

describe("schedules", () => {
  test("a weekday cron fires Monday to Friday, and says so", () => {
    const cron = parseCron("0 4 * * 1-5");
    if (!cron) throw new Error("parses");
    expect(firesOn(cron, Date.parse("2026-10-12T00:00:00Z"))).toBe(true);
    expect(firesOn(cron, Date.parse("2026-10-10T00:00:00Z"))).toBe(false);
    expect(cadence([cron])).toBe("weekdays 04:00Z");
    expect(cadence(toCrons(["0 8 * * *"]))).toBe("daily 08:00Z");
    expect(cadence([], "on bump")).toBe("on bump");
  });

  test("the next run skips the weekend", () => {
    const next = nextFire(toCrons(["0 4 * * 1-5"]), new Date("2026-10-09T05:00:00Z"));
    expect(next).toBe(Date.parse("2026-10-12T04:00:00Z"));
  });

  test("a malformed cron is ignored, not guessed", () => {
    expect(parseCron("0 4 * *")).toBeUndefined();
    expect(parseCron("0 25 * * *")).toBeUndefined();
    expect(toCrons(["nonsense", "0 4 * * *"])).toHaveLength(1);
  });
});

describe("day history", () => {
  const now = new Date("2026-10-13T13:00:00Z");
  const days = windowDays(now, 3);

  test("the window is UTC days ending today, today cut at now", () => {
    expect(days.map((d) => d.key)).toEqual(["10-11", "10-12", "10-13"]);
    expect(days[2]?.end).toBe(now.getTime());
    expect(days[0]?.end).toBe(days[0]!.start + DAY);
  });

  test("a day takes its newest run; a scheduled day with no run is missed, a weekend is idle", () => {
    const crons = toCrons(["0 4 * * 1-5"]);
    const out = runDays(
      [
        run({ createdAt: "2026-10-12T04:10:00Z", conclusion: "failure" }),
        run({ createdAt: "2026-10-12T09:00:00Z", conclusion: "success" }),
      ],
      crons,
      days,
      now,
    );
    expect(out.map((d) => [d.state, d.due])).toEqual([
      ["idle", false],
      ["ok", true],
      ["missed", true],
    ]);
  });

  test("a slot that has not come round yet is not missed", () => {
    const early = new Date("2026-10-13T05:00:00Z");
    const out = runDays([], toCrons(["0 4 * * 1-5"]), windowDays(early, 1), early);
    expect(out[0]?.state).toBe("idle");
  });

  test("behind counts releases newer than what the newest green run proved by day end", () => {
    const out = behindDays(
      [
        { tag: "v0.28.0", at: "2026-10-06T02:00:00Z", url: "" },
        { tag: "v0.28.1", at: "2026-10-11T22:00:00Z", url: "" },
        { tag: "v0.28.2", at: "2026-10-12T21:00:00Z", url: "" },
      ],
      [run({ target: "v0.28.0", updatedAt: "2026-10-06T03:00:00Z" })],
      days,
    );
    expect(out.map((d) => d.behind)).toEqual([1, 2, 2]);
    expect(out[1]?.newest).toBe("v0.28.2");
    expect(behindDays([], [], days)[0]?.behind).toBeNull();
  });

  test("a line's track is waiting while a gate PR is open and halted while a sync-failed issue is", () => {
    const h = lineHistory({
      seeded: "2026-10-11",
      past: [
        {
          number: 5,
          title: "Sync",
          url: "",
          head: "sync/upstream-1",
          base: "fork_upstream",
          createdAt: "2026-10-11T01:00:00Z",
          mergedAt: "2026-10-12T02:00:00Z",
        },
      ],
      pastIssues: [],
      openPrs: [],
      openIssues: [{ number: 7, createdAt: "2026-10-13T00:20:00Z", labels: ["sync-failed"] }],
      days,
    });
    expect(h.upstream.map((d) => d.state)).toEqual(["waiting", "ok", "halted"]);
    expect(h.template.map((d) => d.state)).toEqual(["ok", "ok", "ok"]);
    expect(h.upstream[0]?.why).toBe("sync PR #5 waits");
  });

  test("median of an even count is the mean of the middle two", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});
