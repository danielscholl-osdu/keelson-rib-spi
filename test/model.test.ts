import { describe, expect, test } from "bun:test";
import { emptyFacts } from "../src/facts";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

// The fixture is a real sweep from 12 October: the v0.28.1 upgrade failed on a
// GitLab outage, maintenance stayed set, and a v0.28.2 upgrade was in flight.
const model = buildModel(fixtureFacts(), FIXTURE_NOW);

describe("the fleet on 12 October", () => {
  test("the verdict is BLOCKED and the badge counts P0 and P1", () => {
    expect(model.measured).toBe(true);
    expect(model.queue.verdict).toBe("BLOCKED");
    expect(model.queue.counts.p0).toBeGreaterThanOrEqual(2);
  });

  test("one stack incident folds the earlier attempts and every fork lane it turned red", () => {
    const stack = model.queue.items.find((i) => i.scope === "Shared stack" && i.rung === 0);
    expect(stack?.text).toBe(
      "not deployable; env-upgrade v0.28.2 in verify › Azure login (OIDC) now",
    );
    expect(stack?.since).toStartWith("2026-10-11T22:44");
    const effects = stack?.effects.map((e) => e.text) ?? [];
    expect(
      effects.some(
        (e) =>
          e.includes("env-upgrade v0.28.1 failed in provision › spi up") &&
          e.includes("set maintenance"),
      ),
    ).toBe(true);
    expect(effects.some((e) => e.includes("env-refresh") && e.includes("drifted"))).toBe(true);
    expect(
      effects.some((e) =>
        e.includes("(dispatched) cancelled after 1h 2m in verify › Wait for Flux Kustomizations"),
      ),
    ).toBe(true);
    for (const svc of ["partition", "entitlements", "legal", "schema", "file"]) {
      expect(effects.some((e) => e.startsWith(`${svc} template-sync PR`))).toBe(true);
    }
    expect(model.queue.items.some((i) => i.id === "stack:lanes")).toBe(false);
  });

  test("the entitlements halt is its own incident with its code", () => {
    const halt = model.queue.items.find((i) => i.id === "halt:entitlements");
    expect(halt?.rung).toBe(0);
    expect(halt?.text).toBe(
      "sync halted: UNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests",
    );
  });

  test("the legal sync PR reads as a toolchain move, not a code failure", () => {
    const legal = model.queue.items.find((i) => i.id === "gate1:legal");
    expect(legal?.rung).toBe(1);
    expect(legal?.text).toBe(
      "sync PR #31 fails Java Build: upstream requires Java 25, the fork builds on 17",
    );
    expect(legal?.incident).toBe(true);
  });

  test("template-sync PRs blocked only by the stack wait as one set", () => {
    const set = model.queue.items.find((i) => i.id === "template-set");
    expect(set?.rung).toBe(2);
    expect(set?.text).toContain("5 template-sync PRs");
    expect(set?.text).toContain("once the stack is deployable");
  });

  test("each line wears its own state; the stack fault does not change a current line's pill", () => {
    const pill = Object.fromEntries(model.lines.map((l) => [l.fork.id, l.pill.label]));
    expect(pill).toEqual({
      partition: "current",
      entitlements: "sync halted",
      legal: "sync blocked",
      schema: "current",
      file: "current",
    });
    const partition = model.lines.find((l) => l.fork.id === "partition");
    expect(partition?.stations.find((s) => s.id === "lane")?.state).toBe("stopped");
    expect(model.lines.find((l) => l.fork.id === "legal")?.upstream?.lag).toBe(4);
  });

  test("template currency: nobody is current and schema runs two commits past the release", () => {
    expect(model.template.current).toBe(0);
    expect(model.template.waiting).toBe(5);
    const schema = model.template.rows.find((r) => r.service === "schema");
    expect(schema?.label).toBe("v1.2.0 +2");
    expect(schema?.behind).toBe(12);
    const prewarm = model.template.changes.find((c) => c.pr === 247);
    expect(prewarm?.forks).toBe(4);
  });

  test("remote mode reads maintenance and the running version from lifecycle runs", () => {
    expect(model.stack.maintenance.state).toBe("set");
    expect(model.stack.running?.version).toBe("v0.28.0");
    expect(model.stack.inflight?.run.kind).toBe("upgrade");
  });
});

describe("before the first sweep", () => {
  test("nothing is measured and nothing is queued", () => {
    const empty = buildModel(emptyFacts(), FIXTURE_NOW);
    expect(empty.measured).toBe(false);
    expect(empty.queue.items.filter((i) => i.rung < 2)).toHaveLength(0);
    expect(empty.lines.every((l) => l.upstream?.lag === undefined)).toBe(true);
  });
});
