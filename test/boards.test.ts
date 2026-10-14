import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { badge, verdictLabel } from "../src/boards/badge";
import { doctorBoard } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { radarBreaks } from "../src/boards/radar";
import { emptyFacts } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { itemClass, nextText, verbOf } from "../src/model/next";
import { boardCard, FIXTURE_NOW, fixtureFacts } from "./harness";

function sentenceOf(text: string): string {
  const t = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const facts = fixtureFacts();
const model = buildModel(facts, FIXTURE_NOW);
const gate = expectView(INSPECT_KEY, "board");

describe("the badge and the verdict", () => {
  test("the badge counts P0 and P1 only", () => {
    const { p0, p1 } = model.queue.counts;
    expect(badge(model)).toEqual({ count: p0 + p1, title: `SPI · ${p0} P0 · ${p1} P1` });
  });

  test("before any sweep the badge is empty", () => {
    expect(badge(buildModel(emptyFacts(), FIXTURE_NOW))).toEqual({ count: 0 });
  });

  test("the verdict carries the incident count", () => {
    expect(verdictLabel(model)).toMatch(/^BLOCKED · \d+ INCIDENTS?$/);
  });
});

describe("the queue", () => {
  test("each item carries its rung and class, the environment incident first", () => {
    const first = model.queue.items[0];
    if (!first) throw new Error("fixture has a queue");
    expect([first.rung, itemClass(first)]).toEqual([0, "ENV"]);
    expect(`${first.scope} · ${first.text}`).toStartWith(
      "Environment · maintenance mode; env-upgrade v0.28.2 in verify",
    );
  });

  test("every item has a verb, and the inspector's Next step card says its next step", () => {
    expect(model.queue.items.map((i) => [`P${i.rung} · ${itemClass(i)}`, verbOf(i)])).toEqual([
      ["P0 · ENV", "Re-dispatch"],
      ["P0 · HALT", "Classify entry"],
      ["P1 · TOOLCHAIN", "Absorb toolchain"],
      ["P1 · PORT", "Port"],
      ["P1 · PORT", "Port"],
      ["P1 · GATE", "Approve runs"],
      ["P2 · READY", "Review, then Roll out"],
      ["P2 · READY", "Review on GitHub"],
    ]);
    for (const item of model.queue.items) {
      const next = boardCard(
        inspectBoard(model, { selected: item.id, item }, FIXTURE_NOW),
        "Next step",
      );
      expect(next?.title).toBe(sentenceOf(nextText(item)));
    }
  });
});

describe("the doctor inspector", () => {
  function rows(b: ReturnType<typeof doctorBoard>, title: string) {
    const s = b.sections.find((x) => x.kind === "rows" && x.title === title);
    if (s?.kind !== "rows") throw new Error(title);
    return s.items;
  }

  test("all clear: the sweep's stamp, then every source with its last read", () => {
    const b = doctorBoard(facts, FIXTURE_NOW);
    expect(() => gate(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "ALL CLEAR", tone: "ok" });
    const head = b.sections[0];
    if (head?.kind !== "rows") throw new Error("doctor row first");
    expect(head.items[0]).toMatchObject({ glyph: "ok", text: "Doctor · all clear" });
    expect(head.items[0]?.trailing).toMatch(/^swept \d\d:\d\d · 13\.0 s · 38 calls$/);
    const sources = rows(b, "Sources");
    expect(sources[0]).toEqual({ glyph: "ok", text: "gh", trailing: "signed in as operator" });
    expect(sources.find((r) => r.text === "GitLab upstream lag")?.trailing).toStartWith("read ");
    expect(rows(b, "What the verbs need").map((r) => r.text)).toEqual([
      "Act · gh scopes",
      "Act · projects and grants",
    ]);
  });

  test("a source that stops reading names it and turns the header partial", () => {
    const f = fixtureFacts();
    f.upstream = {
      ...f.upstream,
      error: "glab: 401 Unauthorized",
      errorAt: FIXTURE_NOW.toISOString(),
    };
    const b = doctorBoard(f, FIXTURE_NOW);
    expect(() => gate(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "PARTIAL", tone: "warn" });
    const head = b.sections[0];
    if (head?.kind !== "rows") throw new Error("doctor row first");
    expect(head.items[0]?.glyph).toBe("warn");
    expect(head.items[0]?.text).toMatch(
      /^Doctor · GitLab upstream lag failed \d\d:\d\d: glab: 401 Unauthorized$/,
    );
    expect(rows(b, "Sources").find((r) => r.text === "GitLab upstream lag")?.glyph).not.toBe("ok");
  });

  test("a GitHub that could not be read is dark", () => {
    const f = emptyFacts();
    f.github = { error: "gh api graphql: HTTP 502", errorAt: FIXTURE_NOW.toISOString() };
    const b = doctorBoard(f, FIXTURE_NOW);
    expect(() => gate(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "DARK", tone: "error" });
    const head = b.sections[0];
    if (head?.kind !== "rows") throw new Error("doctor row first");
    expect(head.items[0]).toMatchObject({
      glyph: "error",
      text: "Doctor · GitHub unreadable: gh api graphql: HTTP 502",
    });
  });

  test("before any sweep it says the first sweep has not finished", () => {
    const b = doctorBoard(emptyFacts(), FIXTURE_NOW);
    expect(() => gate(b)).not.toThrow();
    expect(b.sections).toEqual([
      { kind: "rows", items: [{ glyph: "neutral", text: "The first sweep has not finished." }] },
    ]);
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

  test("open PRs keep their position and the item says a newer release is out", () => {
    const model = released();
    const set = model.queue.items.find((i) => i.id === "template-set");
    expect(set?.text).toStartWith("5 template-sync PRs to v1.2.0 +14 (v1.3.0 is out)");
    expect(set?.cause.find((c) => c.label === "latest")?.value).toBe(
      "v1.3.0 is out; these PRs carry the template before it",
    );
    expect(model.lines.map((l) => l.template.target).filter(Boolean)).not.toContain("v1.3.0");
  });
});

describe("upstream MRs that would break a fork", () => {
  // Just after the radar frame in the fixture was read.
  const AT = new Date("2026-10-13T23:30:00Z");

  test("one break per MR and kind, in fork order, with the forks a halt also reaches", () => {
    const breaks = radarBreaks(model);
    expect(breaks.map((b) => [b.fork, b.iid, b.kind, b.bucket])).toEqual([
      ["partition", 830, "toolchain", "Java 25"],
      ["legal", 756, "halt", "UNKNOWN_TOP_LEVEL"],
      ["legal", 756, "toolchain", "os-core-common 9.3.0"],
      ["legal", 785, "halt", "UNKNOWN_TOP_LEVEL"],
      ["schema", 867, "toolchain", "Java 25"],
      ["file", 752, "halt", "UNKNOWN_TOP_LEVEL"],
      ["file", 752, "toolchain", "os-core-common 8.4.0"],
    ]);
    expect(breaks[0]?.items).toEqual(["Java 25", "os-core-common 9.2.0"]);
    expect(breaks[1]?.items).toEqual(["schemathesis-tests"]);
    expect(breaks[1]?.elsewhere).toEqual(["partition", "entitlements", "schema", "file"]);
    expect(breaks.every((b) => !b.draft)).toBe(true);
  });

  test("a draft MR is kept and marked", () => {
    const f = fixtureFacts();
    const partition = f.radar.data?.services.partition;
    const java = partition?.mrs.find((m) => m.iid === 830);
    if (!partition || !java) throw new Error("fixture has partition !830");
    partition.mrs.push({ ...java, iid: 900, draft: true, title: "Draft: Java 25 again" });
    const breaks = radarBreaks(buildModel(f, FIXTURE_NOW));
    expect(breaks.filter((b) => b.draft).map((b) => [b.fork, b.iid])).toEqual([["partition", 900]]);
  });

  test("an MR opens an inspector with its paths by bucket and the forks it reaches", () => {
    const b = inspectBoard(model, { selected: "mr:legal:756" }, AT);
    expect(() => gate(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "HALT", tone: "warn" });
    const titles = b.sections.flatMap((s) => (s.kind === "rows" && s.title ? [s.title] : []));
    expect(titles).toEqual([
      "Halt · 5 paths",
      "Toolchain · 1 path",
      "Shared · 53 paths",
      "Filtered · 5 paths",
      "Forks it reaches",
      "Evidence",
    ]);
    const reach = b.sections.find((s) => s.kind === "rows" && s.title === "Forks it reaches");
    if (reach?.kind !== "rows") throw new Error("reach");
    expect(reach.items.map((i) => i.text)).toEqual([
      "legal",
      "partition, entitlements, schema and file",
    ]);
    const gone = inspectBoard(model, { selected: "mr:legal:1" }, AT);
    expect(gone.header?.status?.label).toBe("CLOSED");
  });
});
