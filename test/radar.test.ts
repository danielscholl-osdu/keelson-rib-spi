import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect";
import type { Facts } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { parseFilter } from "../src/model/filter";
import { buildModel } from "../src/model/index";
import { nextText, verbOf } from "../src/model/next";
import { certainText, classifyPath, diffVerdicts } from "../src/model/radar";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const recorded = buildModel(fixtureFacts(), FIXTURE_NOW);

function filterOf(svc: string) {
  const text = fixtureFacts().radar.data?.filters[svc]?.text;
  if (!text) throw new Error(`fixture has ${svc}'s filter`);
  return parseFilter(text);
}

function station(m: ReturnType<typeof buildModel>, svc: string) {
  return m.lines.find((l) => l.fork.id === svc)?.stations.find((s) => s.id === "upstream")?.text;
}

// The sync has not yet run against the queued commits: no halt issue, no sync PR.
function unsynced(): Facts {
  const f = fixtureFacts();
  const repos = f.github.data?.repos;
  const ent = repos?.["Azure/osdu-spi-entitlements"];
  const legal = repos?.["Azure/osdu-spi-legal"];
  if (!ent || !legal) throw new Error("fixture has entitlements and legal");
  ent.issues = ent.issues.filter((i) => !i.labels.includes("sync-failed"));
  legal.prs = legal.prs.filter((p) => !p.head.startsWith("sync/") && p.base !== "fork_integration");
  return f;
}

describe("the classifier mirrors the upstream filter engine", () => {
  const ent = filterOf("entitlements");

  test("the filter parser reads the maps, the service key and fork_owned", () => {
    expect(ent.service).toBe("entitlements-v2");
    expect(ent.top_level[".gitlab-ci.yml"]).toBe("strip");
    expect(ent.testing["entitlements-v2-test-azure"]).toBe("fork");
    expect(ent.profiles.azure).toBe("inject");
    expect(ent.fossa_modules["entitlements-v2-core"]).toBe("keep");
    expect(ent.fork_owned).toBeUndefined();
    const owned = parseFilter("service: x\ntop_level:\n  ops: strip\nfork_owned:\n  - ops\n");
    expect(owned.fork_owned).toEqual(["ops"]);
    expect(classifyPath(owned, "ops/run.sh")).toEqual({ bucket: "Port", entry: "ops" });
  });

  test("a fork's own Azure trees are Port, never Halt; the rest of provider and devops is Filtered", () => {
    expect(classifyPath(ent, "provider/entitlements-v2-azure/pom.xml")).toEqual({
      bucket: "Port",
      entry: "provider/entitlements-v2-azure",
    });
    expect(classifyPath(ent, "testing/entitlements-v2-test-azure/src/A.java").bucket).toBe("Port");
    expect(classifyPath(ent, "provider/entitlements-v2-unknown-cloud/x").bucket).toBe("Filtered");
    expect(classifyPath(ent, "devops/anything/at/all.yaml")).toEqual({
      bucket: "Filtered",
      entry: "devops",
    });
  });

  test("entries are checked against their map: keep is Shared, strip is Filtered, absent halts", () => {
    expect(classifyPath(ent, "entitlements-v2-core/src/Main.java")).toMatchObject({
      bucket: "Shared",
      map: "top_level",
    });
    expect(classifyPath(ent, ".gitlab-ci.yml").bucket).toBe("Filtered");
    expect(classifyPath(ent, "schemathesis-tests/run.sh")).toEqual({
      bucket: "Halt",
      code: "UNKNOWN_TOP_LEVEL",
      entry: "schemathesis-tests",
      map: "top_level",
    });
    expect(classifyPath(ent, "testing/entitlements-v2-test-core/pom.xml").bucket).toBe("Shared");
    expect(classifyPath(ent, "testing/entitlements-v2-test-new/pom.xml")).toMatchObject({
      bucket: "Halt",
      code: "UNKNOWN_TESTING_ENTRY",
      entry: "entitlements-v2-test-new",
    });
    expect(
      classifyPath(ent, "entitlements-v2-core/src/main/java/provider/interfaces/IStore.java"),
    ).toEqual({ bucket: "Interface", entry: "entitlements-v2-core" });
  });

  test("profiles and fossa modules come only from a wholly added block", () => {
    const pom = [
      "+    <profile>",
      "+      <id>cimpl</id>",
      "+    </profile>",
      "-    <profile>",
      "-      <id>gc</id>",
      "+      <id>orphan</id>",
    ];
    expect(diffVerdicts(ent, { paths: [], hunks: { "pom.xml": pom } })).toEqual([
      { bucket: "Halt", code: "UNKNOWN_PROFILE", entry: "cimpl", map: "profiles", path: "pom.xml" },
    ]);
    const fossa = ["+  modules:", "+    - name: entitlements-v2-cimpl", "+      type: mvn"];
    expect(diffVerdicts(ent, { paths: [], hunks: { ".fossa.yml": fossa } })).toEqual([
      {
        bucket: "Halt",
        code: "UNKNOWN_FOSSA_MODULE",
        entry: "entitlements-v2-cimpl",
        map: "fossa_modules",
        path: ".fossa.yml",
      },
    ]);
    expect(
      diffVerdicts(ent, { paths: [], hunks: { ".fossa.yml": ["+    - name: unseen-module"] } }),
    ).toEqual([]);
  });
});

describe("the recorded fixture predicts the next sync from the diffs alone", () => {
  test("entitlements: the queued schemathesis-tests commits halt on UNKNOWN_TOP_LEVEL", () => {
    const r = recorded.radar.services.entitlements;
    expect(r?.queued).toBe(2);
    const halt = r?.certain.find((v) => v.bucket === "Halt");
    expect(halt).toMatchObject({
      code: "UNKNOWN_TOP_LEVEL",
      entry: "schemathesis-tests",
      map: "top_level",
      elsewhere: ["partition", "legal", "schema", "file"],
    });
    expect(halt?.commit?.sha).toStartWith("485e4538");
    expect(r?.certain.filter((v) => v.bucket === "Halt")).toHaveLength(1);
    expect(r?.state).toBe("halted");
  });

  test("legal: Java 25 from the root pom.xml hunk and nothing from the acceptance test pom", () => {
    const r = recorded.radar.services.legal;
    const tool = r?.certain.filter((v) => v.bucket === "Toolchain");
    expect(tool?.map((v) => [v.value, v.paths])).toEqual([
      ["Java 25", ["pom.xml"]],
      ["os-core-common 9.2.0", ["pom.xml"]],
    ]);
    expect(r?.certain.some((v) => v.bucket === "Halt")).toBe(false);
    expect(r?.state).toBe("toolchain-blocked");
  });

  test("the five fixture forks", () => {
    const states = Object.fromEntries(
      Object.entries(recorded.radar.services).map(([svc, r]) => [svc, r.state]),
    );
    expect(states).toMatchObject({
      partition: "at-risk",
      entitlements: "halted",
      legal: "toolchain-blocked",
      schema: "at-risk",
      file: "at-risk",
    });
  });

  test("the Upstream station names the certain verdict after the existing suffix", () => {
    expect(station(recorded, "entitlements")).toBe(
      "2 behind · held by the halt · will halt on schemathesis-tests",
    );
    expect(station(recorded, "legal")).toBe("4 behind · in the sync PR · Java 25 queued");
    expect(station(recorded, "partition")).toBe("0 behind");
    const before = unsynced();
    const m = buildModel(before, FIXTURE_NOW);
    expect(station(m, "entitlements")).toBe("2 behind · will halt on schemathesis-tests");
    expect(station(m, "legal")).toBe("4 behind · Java 25 queued");
    expect(certainText([{ bucket: "Port", paths: ["provider/x-azure/a"] }])).toBe("port owed");
  });

  test("a draft MR is marked and never puts a fork at risk", () => {
    const f = fixtureFacts();
    const svc = f.radar.data?.services.partition;
    if (!svc) throw new Error("fixture has partition");
    svc.mrs = svc.mrs.map((m) =>
      m.draft
        ? { ...m, paths: ["schemathesis-tests/run.sh"] }
        : { ...m, paths: ["pom.xml"], hunks: undefined },
    );
    const r = buildModel(f, FIXTURE_NOW).radar.services.partition;
    const halt = r?.possible.find((v) => v.bucket === "Halt");
    expect(halt?.mr?.draft).toBe(true);
    expect(r?.state).toBe("clean");
  });

  test("an MR whose diff was not read adds nothing", () => {
    const f = fixtureFacts();
    const svc = f.radar.data?.services.partition;
    if (!svc) throw new Error("fixture has partition");
    svc.mrs = svc.mrs.map((m) => ({ ...m, paths: undefined, hunks: undefined }));
    const r = buildModel(f, FIXTURE_NOW).radar.services.partition;
    expect(r?.possible).toEqual([]);
    expect(r?.state).toBe("clean");
  });

  test("a fork with no filter text is unmeasured: station unchanged, no item", () => {
    const f = unsynced();
    const filters = f.radar.data?.filters;
    if (!filters) throw new Error("fixture has filters");
    delete filters.entitlements;
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.radar.services.entitlements?.state).toBe("unmeasured");
    expect(station(m, "entitlements")).toBe("2 behind");
    expect(m.queue.items.some((i) => i.id === "radar:entitlements")).toBe(false);
    const dark = fixtureFacts();
    dark.radar = {};
    expect(buildModel(dark, FIXTURE_NOW).radar.services.legal?.state).toBe("unmeasured");
  });
});

describe("the radar queue item", () => {
  test("is absent on the recorded fixture, where the sync already ran against the commits", () => {
    expect(recorded.queue.items.some((i) => i.kind === "radar")).toBe(false);
  });

  test("names a queued halt and a queued Java move before the sync runs", () => {
    const m = buildModel(unsynced(), FIXTURE_NOW);
    const ent = m.queue.items.find((i) => i.id === "radar:entitlements");
    expect(ent).toMatchObject({
      kind: "radar",
      rung: 1,
      scope: "entitlements",
      cls: "HALT",
      text: "next sync will halt on schemathesis-tests (UNKNOWN_TOP_LEVEL) · 2 commits queued",
      url: "https://github.com/Azure/osdu-spi-entitlements/blob/main/.github/upstream-filter.yml",
    });
    expect(ent?.effects.map((e) => e.text)).toEqual([
      "schemathesis-tests · no rule in top_level · UNKNOWN_TOP_LEVEL",
      "schemathesis-tests also unlisted in partition, legal, schema and file",
    ]);
    expect(ent?.links?.map((l) => l.label)).toEqual(["Open commit", "Open filter"]);
    expect(ent && verbOf(ent)).toBe("Pre-classify");
    expect(ent && nextText(ent)).toBe(
      "Pre-classify: add schemathesis-tests to top_level in .github/upstream-filter.yml before the next Sync Upstream",
    );
    const legal = m.queue.items.find((i) => i.id === "radar:legal");
    expect(legal?.text).toBe("next sync carries Java 25 · 4 commits queued");
    expect(legal && nextText(legal)).toBe(
      "Move the fork's Java pin to 25 before the next Sync Upstream carries it",
    );
    for (const item of [ent, legal]) {
      if (!item) throw new Error("radar items");
      const b = inspectBoard(m, { selected: item.id, item }, FIXTURE_NOW);
      expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
    }
  });

  test("open MRs never enter the queue", () => {
    const m = buildModel(unsynced(), FIXTURE_NOW);
    expect(m.radar.services.file?.state).toBe("at-risk");
    expect(m.queue.items.some((i) => i.id === "radar:file")).toBe(false);
  });
});
