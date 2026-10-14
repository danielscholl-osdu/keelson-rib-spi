import { describe, expect, test } from "bun:test";
import type { LifecycleRun } from "../src/facts";
import {
  behindDays,
  deployDays,
  holdDays,
  lineHistory,
  median,
  runDays,
  windowDays,
} from "../src/model/history";
import { cadence, firesOn, nextFire, parseCron, toCrons } from "../src/model/schedule";

const DAY = 86_400_000;

// bun test runs in UTC; a test that needs another zone switches and always switches back.
function inZone(zone: string, fn: () => void) {
  const was = process.env.TZ ?? "Etc/UTC";
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    process.env.TZ = was;
  }
}

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
    expect(cadence([cron])).toBe("weekdays 04:00");
    expect(cadence(toCrons(["0 8 * * *"]))).toBe("daily 08:00");
    expect(cadence([], "on bump")).toBe("on bump");
  });

  test("the next run skips the weekend", () => {
    const next = nextFire(toCrons(["0 4 * * 1-5"]), new Date("2026-10-09T05:00:00Z"));
    expect(next).toBe(Date.parse("2026-10-12T04:00:00Z"));
  });

  test("a cadence reads in local time, so a UTC weekday cron runs Sunday to Thursday evening in Chicago", () => {
    inZone("America/Chicago", () => {
      const now = new Date("2026-10-13T12:00:00Z");
      expect(cadence(toCrons(["0 4 * * 1-5"]), undefined, now)).toBe("Sun-Thu 23:00");
      expect(cadence(toCrons(["0 8 * * *"]), undefined, now)).toBe("daily 03:00");
      expect(cadence(toCrons(["0 8 * * *"]), undefined, new Date("2026-11-10T12:00:00Z"))).toBe(
        "daily 02:00",
      );
    });
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

  test("the window is local days ending today, today cut at now", () => {
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
    expect(out.map((d) => [d.state, d.slots.length])).toEqual([
      ["idle", 0],
      ["ok", 1],
      ["missed", 1],
    ]);
  });

  test("a slot not reached yet, or only just passed, is due and not missed", () => {
    const early = new Date("2026-10-13T03:00:00Z");
    expect(runDays([], toCrons(["0 4 * * 1-5"]), windowDays(early, 1), early)[0]?.state).toBe(
      "due",
    );
    const after = new Date("2026-10-13T05:00:00Z");
    expect(runDays([], toCrons(["0 4 * * 1-5"]), windowDays(after, 1), after)[0]?.state).toBe(
      "due",
    );
  });

  test("a scheduled run counts toward the slot it answers, a dispatched one toward its own day", () => {
    inZone("America/Chicago", () => {
      // 23:00 CDT slots; the 10-11 run started 00:34 on 10-12, a dispatch ran 10-12 16:00.
      const now = new Date("2026-10-13T12:00:00Z");
      const local = windowDays(now, 3);
      expect(local.map((d) => d.key)).toEqual(["10-11", "10-12", "10-13"]);
      expect(local[0]?.start).toBe(Date.parse("2026-10-11T05:00:00Z"));
      const out = runDays(
        [
          run({ createdAt: "2026-10-12T05:34:00Z" }),
          run({
            createdAt: "2026-10-12T21:00:00Z",
            event: "workflow_dispatch",
            conclusion: "failure",
          }),
          run({ createdAt: "2026-10-13T04:05:00Z" }),
        ],
        toCrons(["0 4 * * *"]),
        local,
        now,
      );
      expect(out.map((d) => [d.state, d.runs.length])).toEqual([
        ["ok", 1],
        ["ok", 2],
        ["due", 0],
      ]);
    });
  });

  test("held hours are the holds' overlap with each day; an unread run marks its day", () => {
    const out = holdDays(
      [
        { from: Date.parse("2026-10-11T22:00:00Z"), to: Date.parse("2026-10-12T02:00:00Z") },
        { from: Date.parse("2026-10-13T11:00:00Z") },
      ],
      [Date.parse("2026-10-12T09:00:00Z")],
      days,
      now,
    );
    expect(out.map((d) => [d.heldMs / 3_600_000, d.unread])).toEqual([
      [2, false],
      [2, true],
      [2, false],
    ]);
  });

  test("deploys count per day as passed or failed; a deploy still running counts as neither", () => {
    const out = deployDays(
      [
        { createdAt: "2026-10-12T01:00:00Z", state: "SUCCESS" },
        { createdAt: "2026-10-12T02:00:00Z", state: "INACTIVE" },
        { createdAt: "2026-10-12T03:00:00Z", state: "FAILURE" },
        { createdAt: "2026-10-13T03:00:00Z", state: "ERROR" },
        { createdAt: "2026-10-13T04:00:00Z", state: "IN_PROGRESS" },
      ],
      days,
    );
    expect(out.map((d) => [d.passed, d.failed])).toEqual([
      [0, 0],
      [2, 1],
      [0, 1],
    ]);
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
