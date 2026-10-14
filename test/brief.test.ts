import { describe, expect, test } from "bun:test";
import { doctorStatus } from "../src/boards/doctor";
import { buildBriefing, type DoctorView } from "../src/brief/index";
import { buildModel, type Model } from "../src/model/index";
import type { QueueItem } from "../src/model/queue";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const CLEAR: DoctorView = { state: "clear", problems: [] };

function fixtureModel(): Model {
  return buildModel(fixtureFacts(), FIXTURE_NOW);
}

function item(over: Partial<QueueItem>): QueueItem {
  return {
    id: "x",
    kind: "gate1",
    rung: 1,
    scope: "svc",
    text: "",
    effects: [],
    cause: [],
    incident: false,
    blocks: 1,
    ...over,
  };
}

// The fixture with its queue replaced and every line read as current.
function withQueue(items: QueueItem[]): Model {
  const m = fixtureModel();
  m.queue.items = items;
  m.queue.counts = {
    p0: items.filter((i) => i.rung === 0).length,
    p1: items.filter((i) => i.rung === 1).length,
    p2: items.filter((i) => i.rung === 2).length,
  };
  for (const l of m.lines) l.pill = { label: "current", kind: "current", tone: "ok" };
  return m;
}

const RELEASES = item({
  id: "releases",
  kind: "releases",
  rung: 2,
  scope: "fleet",
  text: "2 release PRs · partition v1.3.2, legal v1.2.1 · review required",
  effects: [{ text: "partition #175" }, { text: "legal #36" }],
});

describe("the recorded sweep", () => {
  const facts = fixtureFacts();
  const b = buildBriefing(fixtureModel(), doctorStatus(facts, FIXTURE_NOW), FIXTURE_NOW);

  test("the headline names two causes as imperatives and counts the rest", () => {
    expect(b.headline).toBe("Restore the environment. Unhalt entitlements. 1 more cause below.");
  });

  test("the summary leaves the environment to the headline that already names it", () => {
    expect(b.summary).toBe("2 forks have been stopped for 4 days. 6 PRs are ready for review.");
  });

  test("every fact's figure is a version or a count, never a status word", () => {
    expect(b.facts.map((f) => f.label)).toEqual([
      "Environment",
      "Upstream sync",
      "Template v1.2.0",
    ]);
    for (const f of b.facts) expect(f.figure).toMatch(/^(v\d+\.\d+\.\d+|\d+ of \d+|\?)$/);
    expect(b.facts[0]?.sub).toBe("upgrade running · at verify · declares v0.28.2");
  });

  test("focus puts incidents first and folds owed ports into one row", () => {
    expect(b.focus.map((f) => f.id)).toEqual([
      "stack:38181620856",
      "halt:entitlements",
      "gate1:legal",
      "approvals:Azure/osdu-spi-stack",
      "port:entitlements",
    ]);
    const port = b.focus[4]!;
    expect(port.ids).toEqual(["port:entitlements", "port:legal"]);
    expect(port.title).toBe("3 upstream provider changes not ported");
    expect(port.sub).toBe("entitlements 2 · legal 1");
  });

  test("every focus id is a queue item the inspector can open", () => {
    const ids = new Set(fixtureModel().queue.items.map((i) => i.id));
    for (const f of b.focus) for (const id of f.ids) expect(ids.has(id)).toBe(true);
  });

  test("a halt says what it is, what it holds and how far the entry reaches", () => {
    const halt = b.focus[1]!;
    expect(halt.title).toBe("Sync halted on schemathesis-tests");
    expect(halt.sub).toContain("the same entry is missing from 4 other filters");
    expect(halt.cause).toBe(
      "Upstream adds schemathesis-tests, a top-level entry the fork's filter has no rule for, so Sync Upstream stops with UNKNOWN_TOP_LEVEL.",
    );
    expect(halt.verb).toBe("Classify entry");
    expect(halt.next).toMatch(/\.$/);
  });

  test("themes group one cause across forks, certain apart from possible", () => {
    expect(b.themes.map((t) => t.id)).toEqual([
      "toolchain:Java 25",
      "halt:top_level:schemathesis-tests",
      "port",
      "deadline:azure-removal",
    ]);
    const java = b.themes[0]!;
    expect(java.certain.map((f) => f.fork)).toEqual(["legal"]);
    expect(java.possible.map((f) => f.fork).sort()).toEqual(["partition", "schema"]);
    const halt = b.themes[1]!;
    expect(halt.sub).toBe(
      "halted: entitlements · 4 other filters lack it · open MRs bring it to legal and file",
    );
    expect(halt.exposed).not.toContain("legal");
  });

  test("ready work is one line per kind and never ranked into focus", () => {
    expect(b.ready.map((r) => r.text)).toEqual([
      "5 template-sync PRs to v1.2.0 +14",
      "1 release PR",
    ]);
    expect(b.focus.some((f) => f.rung === 2)).toBe(false);
  });
});

describe("other days", () => {
  test("a quiet day says nothing needs you and when the next sync runs", () => {
    const b = buildBriefing(withQueue([]), CLEAR, FIXTURE_NOW);
    expect(b.headline).toBe("Nothing needs you. Next sync at 00:00.");
    expect(b.focus).toEqual([]);
    expect(b.facts[1]).toMatchObject({ figure: "0 of 5", tone: "ok" });
  });

  test("a day with only ready work says nothing is broken", () => {
    const b = buildBriefing(withQueue([RELEASES]), CLEAR, FIXTURE_NOW);
    expect(b.headline).toBe("Nothing is broken. 2 PRs are ready for review.");
    expect(b.summary).not.toContain("ready for review");
  });

  test("a toolchain incident joins the fork that the next sync will break the same way", () => {
    const m = withQueue([
      item({
        id: "gate1:legal",
        scope: "legal",
        cls: "TOOLCHAIN",
        incident: true,
        text: "sync PR #31 fails Java Build: upstream requires Java 25, the fork builds on 17",
        cause: [{ label: "reason", value: "JDK 17.0.20-1 is outside the allowed range [25,)" }],
      }),
      item({
        id: "radar:partition",
        kind: "radar",
        scope: "partition",
        cls: "TOOLCHAIN",
        text: "next sync carries Java 25 · 2 commits queued",
        cause: [{ label: "value", value: "Java 25" }],
      }),
    ]);
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW);
    expect(b.headline).toBe("Move legal to Java 25 before partition follows at 00:00.");
    expect(b.focus[1]?.sub).toBe(
      "2 commits queued · syncs at 00:00 · expected to fail the way legal's did",
    );
    expect(b.focus[1]?.effect).toBe(
      "2 commits reach the fork at the 00:00 sync. Legal's sync PR failed on the same move.",
    );
  });

  test("a queued break with no incident still leads the headline", () => {
    const m = withQueue([
      item({
        id: "radar:partition",
        kind: "radar",
        scope: "partition",
        cls: "TOOLCHAIN",
        text: "next sync carries Java 25 · 2 commits queued",
        cause: [{ label: "value", value: "Java 25" }],
      }),
    ]);
    expect(buildBriefing(m, CLEAR, FIXTURE_NOW).headline).toBe(
      "Move partition to Java 25 before the 00:00 sync.",
    );
  });

  test("six incidents name two causes and count the rest", () => {
    const m = withQueue([
      item({ id: "stack:1", kind: "stack", rung: 0, scope: "Environment", incident: true }),
      item({ id: "lanes", kind: "lanes", rung: 0, scope: "fleet", incident: true }),
      item({ id: "halt:a", kind: "halt", rung: 0, scope: "a", incident: true }),
      item({ id: "main:b", kind: "main", rung: 0, scope: "b", incident: true }),
      item({ id: "conflict:c", kind: "conflict", rung: 0, scope: "c", incident: true }),
      item({ id: "gate1:d", scope: "d", cls: "BUILD", incident: true }),
    ]);
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW);
    expect(b.headline).toBe("Restore the environment. Unhalt a. 3 more causes below.");
    expect(b.focus).toHaveLength(5);
    expect(b.more).toBe(1);
  });

  test("a dark GitHub leads with the source and its last read", () => {
    const dark: DoctorView = { state: "dark", problems: ["⚠ GitHub unread since 11:20"] };
    const b = buildBriefing(fixtureModel(), dark, FIXTURE_NOW);
    expect(b.headline).toBe("GitHub unread since 11:20. Figures are from the last good read.");
  });

  test("a partial read opens the summary with the source that failed", () => {
    const partial: DoctorView = { state: "partial", problems: ["⚠ GitLab unread since 09:10"] };
    const b = buildBriefing(fixtureModel(), partial, FIXTURE_NOW);
    expect(b.summary.startsWith("GitLab unread since 09:10.")).toBe(true);
  });

  test("before the first sweep there is nothing to brief", () => {
    const m = fixtureModel();
    m.measured = false;
    const b = buildBriefing(m, { state: "waiting", problems: [] }, FIXTURE_NOW);
    expect(b.headline).toBe("The first sweep has not finished.");
    expect(b.facts).toEqual([]);
  });
});
