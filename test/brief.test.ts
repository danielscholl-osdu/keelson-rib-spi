import { describe, expect, test } from "bun:test";
import { doctorStatus } from "../src/boards/doctor";
import { buildBriefing, type DoctorView } from "../src/brief/index";
import { buildModel, type Model } from "../src/model/index";
import type { StationState } from "../src/model/lines";
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

  test("the horizon names how many future halts one filter entry would stop", () => {
    expect(b.horizon.headline).toBe("One filter entry would stop 4 future halts.");
  });

  test("each theme says its next step in one sentence", () => {
    expect(Object.fromEntries(b.themes.map((t) => [t.kind, t.next]))).toEqual({
      toolchain:
        "Move one fork's Java pin to 25 and repeat it for the others before the next sync carries it.",
      halt: "Add a rule for schemathesis-tests to every fork's .github/upstream-filter.yml, starting with entitlements.",
      port: "Port each MR into its fork-owned tree and cite the MR URL in the PR body.",
      deadline:
        "Upstream removes the Azure provider code at the deadline; forks keep their own copy.",
    });
  });

  test("a theme opens the queue item that carries its verbs, and only a real one", () => {
    expect(b.themes.map((t) => t.inspect)).toEqual([
      "gate1:legal",
      "halt:entitlements",
      "port:entitlements",
      undefined,
    ]);
    const ids = new Set(fixtureModel().queue.items.map((i) => i.id));
    for (const t of b.themes) if (t.inspect) expect(ids.has(t.inspect)).toBe(true);
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

describe("the horizon", () => {
  const RADAR_PARTITION = item({
    id: "radar:partition",
    kind: "radar",
    scope: "partition",
    cls: "TOOLCHAIN",
    text: "next sync carries Java 25 · 2 commits queued",
    cause: [{ label: "value", value: "Java 25" }],
  });

  test("a quiet sweep says nothing new reaches the forks", () => {
    const m = withQueue([]);
    m.radar.services = {};
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW);
    expect(b.horizon.headline).toBe("Nothing new reaches the forks at the next sync.");
    expect(b.themes.every((t) => t.kind === "deadline")).toBe(true);
  });

  test("with no incident to open, a theme falls back to the radar item that carries it", () => {
    const radarHalt = item({
      id: "radar:legal",
      kind: "radar",
      scope: "legal",
      cls: "HALT",
      halt: { fork: "legal", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
    });
    const b = buildBriefing(withQueue([radarHalt]), CLEAR, FIXTURE_NOW);
    expect(b.themes.find((t) => t.kind === "halt")?.inspect).toBe("radar:legal");
    expect(b.themes.find((t) => t.kind === "toolchain")?.inspect).toBeUndefined();
    expect(b.themes.find((t) => t.kind === "port")?.inspect).toBeUndefined();
  });

  test("a queued Java move leads the horizon with every queued fork and the sync time", () => {
    const m = withQueue([RADAR_PARTITION]);
    const svc = m.radar.services.partition!;
    const java = m.radar.services.legal!.certain.find((v) => v.bucket === "Toolchain")!;
    svc.certain = [...svc.certain, java];
    svc.possible = svc.possible.filter((v) => v.bucket !== "Toolchain");
    const b = buildBriefing(m, CLEAR, FIXTURE_NOW);
    expect(b.horizon.headline).toBe(
      "Java 25 reaches partition and legal at 00:00. One filter entry would stop 4 future halts.",
    );
    expect(b.themes[0]?.inspect).toBe("radar:partition");
  });
});

describe("wording", () => {
  test("ready lines keep the lead of a long PR text", () => {
    const bump = item({
      id: "bump",
      kind: "bump",
      rung: 2,
      text: "env bump to v0.28.6 is open; merging it starts env-upgrade",
    });
    expect(buildBriefing(withQueue([bump]), CLEAR, FIXTURE_NOW).ready[0]?.text).toBe(
      "env bump to v0.28.6 is open",
    );
  });
});

describe("the flow", () => {
  const facts = fixtureFacts();
  const flow = buildBriefing(fixtureModel(), doctorStatus(facts, FIXTURE_NOW), FIXTURE_NOW).flow;

  // Every fork current, every station idle, the environment deployable.
  function quiet(): Model {
    const m = withQueue([]);
    m.stack.deployable = { state: "yes", reason: "maintenance clear" };
    m.stack.inflight = undefined;
    for (const l of m.lines) {
      l.stations = [
        { id: "upstream", state: "idle", text: "0 behind" },
        { id: "sync", state: "idle", text: "clean" },
        { id: "cascade", state: "idle", text: "idle" },
        { id: "main", state: "idle", text: "idle" },
        { id: "release", state: "idle", text: "v1.2.0" },
        { id: "lane", state: "idle", text: "last run ok" },
      ];
      const svc = m.radar.services[l.fork.id];
      if (svc) svc.state = "clean";
    }
    return m;
  }

  function set(m: Model, fork: string, id: string, state: StationState, text: string): void {
    const s = m.lines.find((l) => l.fork.id === fork)?.stations.find((x) => x.id === id);
    if (s) Object.assign(s, { state, text });
  }

  const flowOf = (m: Model) => buildBriefing(m, CLEAR, FIXTURE_NOW).flow;

  test("the recorded sweep stops at Sync for the halted and the red fork", () => {
    expect(flow.headline).toBe("Change stops at Sync for entitlements and legal.");
    expect(flow.rows.map((r) => r.fork)).toEqual(["entitlements", "legal"]);
    expect(flow.rows.map((r) => r.inspect)).toEqual(["halt:entitlements", "gate1:legal"]);
    expect(flow.rows[0]?.items[0]).toBe("Sync halted on schemathesis-tests");
  });

  test("the environment is one row, toned like its fact, opening the stack incident", () => {
    expect(flow.environment).toEqual({
      text: "Environment v0.28.0 · upgrade running · at verify · declares v0.28.2",
      tone: "warn",
      inspect: "stack:38181620856",
    });
  });

  test("columns every fork agrees on band once and leave the matrix", () => {
    expect(flow.bands.map((b) => [b.column, b.text])).toEqual([
      ["Cascade and Main", "idle in every fork"],
      ["Lane", "blocked by the stack in every fork"],
    ]);
    expect(flow.columns).toEqual(["Upstream", "Sync", "Release", "Template"]);
    for (const r of flow.rows)
      expect(r.cells.map((c) => c.id)).toEqual(["upstream", "sync", "release", "template"]);
  });

  test("a long station text shortens in the cell and keeps the whole in full", () => {
    const up = flow.rows[0]?.cells[0];
    expect(up).toMatchObject({
      state: "waiting",
      tone: "warn",
      text: "2 behind · held by the halt",
    });
    expect(up?.full).toBe("2 behind · held by the halt · will halt on schemathesis-tests");
    expect(flow.rows[0]?.cells[1]).toMatchObject({ state: "stopped", tone: "bad" });
  });

  test("a held stack stopping every lane does not show a fork; the rest fold", () => {
    expect(flow.fold).toEqual({
      forks: ["partition", "schema", "file"],
      text: "upstream current, sync clean, main idle",
    });
  });

  test("every inspect id is a queue item", () => {
    const ids = new Set(fixtureModel().queue.items.map((i) => i.id));
    const all = [
      flow.environment.inspect,
      ...flow.rows.map((r) => r.inspect),
      ...flow.bands.map((b) => b.inspect),
    ].filter((id): id is string => !!id);
    for (const id of all) expect(ids.has(id)).toBe(true);
  });

  test("a quiet fleet folds every fork and says change is flowing", () => {
    const f = flowOf(quiet());
    expect(f.headline).toBe("Change is flowing from upstream to the environment.");
    expect(f.rows).toEqual([]);
    expect(f.fold?.forks).toHaveLength(5);
    expect(f.fold?.text).toBe("upstream current, sync clean, main idle");
    expect(f.environment).toMatchObject({
      text: "Environment v0.28.0 · deployable · declares v0.28.2",
      tone: "ok",
    });
  });

  test("a fork with no lane run yet folds; a failed lane run shows", () => {
    const m = quiet();
    set(m, "partition", "lane", "unknown", "no run yet");
    set(m, "schema", "lane", "unknown", "no run yet");
    set(m, "legal", "lane", "waiting", "last run failed");
    const f = flowOf(m);
    expect(f.rows.map((r) => r.fork)).toEqual(["legal"]);
    expect(f.fold?.forks).toEqual(["partition", "entitlements", "schema", "file"]);
    expect(f.fold?.text).toBe("upstream current, sync clean, main idle · 2 with no lane run yet");
    expect(f.rows[0]?.cells.find((c) => c.id === "lane")).toMatchObject({
      state: "waiting",
      text: "last run failed",
    });
  });

  test("a radar state that will stop the fork shows it though every station is idle", () => {
    const m = quiet();
    const svc = m.radar.services.file;
    if (svc) svc.state = "will-halt";
    expect(flowOf(m).rows.map((r) => r.fork)).toEqual(["file"]);
  });

  test("a release band forms only when every fork has a release PR waiting", () => {
    const m = quiet();
    m.queue.items = [RELEASES];
    for (const l of m.lines) set(m, l.fork.id, "release", "waiting", "gate 3 · PR #9");
    expect(flowOf(m).bands.find((b) => b.column === "Release")).toEqual({
      column: "Release",
      text: "a release PR waits in every fork",
      tone: "warn",
      inspect: "releases",
    });
    set(m, "file", "release", "idle", "v1.2.0");
    const f = flowOf(m);
    expect(f.bands.some((b) => b.column === "Release")).toBe(false);
    expect(f.columns).toContain("Release");
  });

  test("a template band names the one move every fork's PR makes", () => {
    const m = quiet();
    for (const r of m.template.rows) r.label = "v1.2.0";
    const band = flowOf(m).bands.find((b) => b.column === "Template");
    expect(band?.text).toBe("v1.2.0 → v1.2.0 +14 · a sync PR waits in every fork");
    const row = m.template.rows.find((r) => r.service === "schema");
    if (row) row.label = "v1.2.0 +2";
    const f = flowOf(m);
    expect(f.bands.some((b) => b.column === "Template")).toBe(false);
    expect(f.columns).toContain("Template");
  });

  test("the headline groups stopped forks by their first stopped station", () => {
    const m = quiet();
    set(m, "entitlements", "sync", "stopped", "halted: UNKNOWN_TOP_LEVEL");
    set(m, "file", "sync", "stopped", "PR #9 red");
    set(m, "legal", "main", "stopped", "main red");
    set(m, "legal", "lane", "waiting", "last run failed");
    expect(flowOf(m).headline).toBe(
      "Change stops at Sync for entitlements and file and at Main for legal.",
    );
  });

  test("a fork queued to stop is named with the sync time unless it already stopped", () => {
    const m = quiet();
    set(m, "entitlements", "sync", "stopped", "halted: UNKNOWN_TOP_LEVEL");
    set(m, "partition", "upstream", "waiting", "2 behind · Java 25 queued");
    const svc = m.radar.services;
    if (svc.partition) svc.partition.state = "toolchain-queued";
    if (svc.entitlements) svc.entitlements.state = "will-halt";
    expect(flowOf(m).headline).toBe(
      "Change stops at Sync for entitlements. Partition is queued to stop at 00:00.",
    );
  });

  test("a held environment with no fork stopped stops change at the environment", () => {
    const m = quiet();
    m.stack.deployable = { state: "no", reason: "The environment is in maintenance." };
    for (const l of m.lines) set(m, l.fork.id, "lane", "stopped", "blocked by the stack");
    const f = flowOf(m);
    expect(f.headline).toBe("Change stops at the environment.");
    expect(f.rows).toEqual([]);
    expect(f.bands.find((b) => b.column === "Lane")).toMatchObject({ tone: "bad" });
  });
});
