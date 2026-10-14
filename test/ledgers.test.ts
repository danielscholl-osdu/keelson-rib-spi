import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect";
import { radarBoard } from "../src/boards/radar";
import {
  emptyLedgerState,
  mrRefs,
  pinsOf,
  readLatest,
  readMerged,
  readPortPrs,
} from "../src/collect/ledgers";
import type { Facts } from "../src/facts";
import { Gh, Glab } from "../src/forge";
import { INSPECT_KEY, RADAR_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { nextText, verbOf } from "../src/model/next";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const AT = new Date("2026-10-13T23:30:00Z");
const ENT = "osdu/platform/security-and-compliance/entitlements";

function model(edit?: (f: Facts) => void) {
  const f = fixtureFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

const plain = (v: unknown) =>
  typeof v === "object" && v !== null && "value" in v
    ? String((v as { value: unknown }).value).replaceAll(" ", " ")
    : v;

function portsCells(m: ReturnType<typeof buildModel>) {
  const b = radarBoard(m, AT);
  expect(() => expectView(RADAR_KEY, "board")(b)).not.toThrow();
  const table = b.sections.find((s) => s.kind === "table");
  if (table?.kind !== "table") throw new Error("next-sync table");
  return Object.fromEntries(table.rows.map((r) => [plain(r.fork), plain(r.ports)]));
}

describe("the port ledger", () => {
  test("a fork PR cites an upstream MR by its GitLab URL, in the body or a commit message", () => {
    expect(
      mrRefs([
        "Ports https://community.opengroup.org/osdu/platform/security-and-compliance/entitlements/-/merge_requests/956 into the fork.",
        "fix: tomcat\n\nSee merge request osdu/platform/security-and-compliance/entitlements!963",
      ]),
    ).toEqual([`${ENT}!956`]);
  });

  test("upstream MRs that changed fork-owned paths since the seed are owed until a fork PR cites them", () => {
    const m = model();
    expect(
      Object.fromEntries(
        Object.entries(m.radar.services).map(([svc, r]) => [
          svc,
          r.ports?.owed.map((o) => [o.iid, o.trees]),
        ]),
      ),
    ).toEqual({
      partition: [],
      entitlements: [
        [963, ["testing/entitlements-v2-test-azure"]],
        [956, ["provider/entitlements-v2-azure"]],
      ],
      legal: [[783, ["provider/legal-azure"]]],
      schema: [],
      file: [],
    });
  });

  test("an owed MR shows on the fork's row and as a P1 item with its Next line", () => {
    expect(portsCells(model())).toMatchObject({ entitlements: "!963, !956", legal: "!783" });
    const m = model();
    const item = m.queue.items.find((i) => i.id === "port:entitlements");
    expect(item).toMatchObject({
      kind: "port",
      rung: 1,
      scope: "entitlements",
      text: "2 upstream MRs changed testing/entitlements-v2-test-azure and provider/entitlements-v2-azure since the seed, none ported",
      url: "https://github.com/Azure/osdu-spi-entitlements/pulls",
    });
    expect(item?.effects.map((e) => e.url)).toEqual([
      `https://community.opengroup.org/${ENT}/-/merge_requests/963`,
      `https://community.opengroup.org/${ENT}/-/merge_requests/956`,
    ]);
    expect(item?.links?.map((l) => l.label)).toEqual([
      "Open MR !963",
      "Open MR !956",
      "Open fork PRs",
    ]);
    if (!item) throw new Error("port item");
    expect(verbOf(item)).toBe("Open MR");
    expect(nextText(item)).toBe(
      "Port !963 into testing/entitlements-v2-test-azure; cite the MR URL in the PR body",
    );
    const b = inspectBoard(m, { selected: item.id, item }, FIXTURE_NOW);
    expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
  });

  test("a ported MR, its URL in a fork PR body, is no longer owed", () => {
    const m = model((f) => {
      const svc = f.radar.data?.services.entitlements;
      if (!svc?.forkPrs) throw new Error("fixture has entitlements fork PRs");
      svc.forkPrs.push({
        number: 99,
        url: "https://github.com/Azure/osdu-spi-entitlements/pull/99",
        state: "merged",
        refs: [`${ENT}!963`],
      });
    });
    const r = m.radar.services.entitlements;
    expect(r?.ports?.owed.map((o) => o.iid)).toEqual([956]);
    expect(r?.ports?.ported).toEqual([
      { iid: 963, pr: "https://github.com/Azure/osdu-spi-entitlements/pull/99" },
    ]);
    expect(m.queue.items.find((i) => i.id === "port:entitlements")?.text).toBe(
      "2 upstream MRs changed provider/entitlements-v2-azure since the seed, 1 of 2 ported",
    );
  });

  test("an unread fork PR list or merged diff leaves the ledger unmeasured: '?' and no item", () => {
    const m = model((f) => {
      const ent = f.radar.data?.services.entitlements;
      const legal = f.radar.data?.services.legal;
      if (!ent || !legal?.merged?.[0]) throw new Error("fixture services");
      delete ent.forkPrs;
      legal.merged[0] = { ...legal.merged[0], paths: undefined };
    });
    expect(m.radar.services.entitlements?.ports).toBeUndefined();
    expect(m.radar.services.legal?.ports).toBeUndefined();
    expect(portsCells(m)).toMatchObject({ entitlements: "?", legal: "?" });
    expect(m.queue.items.some((i) => i.kind === "port")).toBe(false);
  });
});

describe("the port ledger reads", () => {
  function exec(answer: (args: string[]) => unknown) {
    const queries: string[] = [];
    return {
      queries,
      exec: {
        runJSON: async (_cmd: string, args: string[]) => {
          queries.push(args.join(" "));
          const data = answer(args);
          return data instanceof Error
            ? { ok: false as const, error: data.message, code: 1 }
            : { ok: true as const, data: data as never };
        },
        runText: async (_cmd: string, args: string[]) => {
          queries.push(args.join(" "));
          const data = answer(args);
          return data instanceof Error
            ? { ok: false as const, error: data.message, code: 1 }
            : { ok: true as const, data: JSON.stringify(data), exitCode: 0 };
        },
      },
    };
  }

  test("merged fork PRs are kept by number and later reads ask only since the newest merge", async () => {
    const state = emptyLedgerState();
    const pr = (n: number, mergedAt: string | null, body: string) => ({
      number: n,
      url: `https://github.com/Azure/osdu-spi-partition/pull/${n}`,
      mergedAt,
      bodyText: body,
      commits: { nodes: [] },
    });
    const first = exec(() => ({
      data: {
        port_o0: { issueCount: 1, nodes: [pr(3, null, "draft port")] },
        port_m0: {
          issueCount: 1,
          nodes: [
            pr(
              2,
              "2026-09-01T10:00:00Z",
              "community.opengroup.org/osdu/platform/system/partition/-/merge_requests/826",
            ),
          ],
        },
      },
    }));
    const read = await readPortPrs(new Gh(first.exec), state);
    expect(read.prs.partition?.map((p) => [p.number, p.state, p.refs])).toEqual([
      [3, "open", []],
      [2, "merged", ["osdu/platform/system/partition!826"]],
    ]);
    expect(read.read).toEqual({ prs: 2, commits: 0 });
    expect(first.queries[0]).toContain("merged:>=2026-08-04");
    const second = exec(() => ({
      data: { port_o0: { issueCount: 0, nodes: [] }, port_m0: { issueCount: 0, nodes: [] } },
    }));
    const again = await readPortPrs(new Gh(second.exec), state);
    expect(second.queries[0]).toContain("merged:>=2026-09-01");
    expect(again.prs.partition?.map((p) => p.number)).toEqual([2]);
    const failed = await readPortPrs(new Gh(exec(() => new Error("HTTP 502")).exec), state);
    expect(failed.prs.partition?.map((p) => p.number)).toEqual([2]);
  });

  test("a failed merged-MR read keeps the last good list; a paged-out project stays unread", async () => {
    const state = emptyLedgerState();
    const node = {
      iid: "826",
      title: "fix",
      webUrl: "u",
      mergedAt: "2026-09-14T00:00:00Z",
      diffHeadSha: "abc",
    };
    const ok = exec(() => ({
      data: {
        p0: { mergeRequests: { pageInfo: { hasNextPage: false }, nodes: [node] } },
        p1: { mergeRequests: { pageInfo: { hasNextPage: true }, nodes: [node] } },
      },
    }));
    const merged = await readMerged(new Glab(ok.exec), state);
    expect(merged.partition?.map((m) => m.iid)).toEqual([826]);
    expect(merged.entitlements).toBeUndefined();
    const kept = await readMerged(new Glab(exec(() => new Error("timeout")).exec), state);
    expect(kept.partition?.map((m) => m.iid)).toEqual([826]);
  });
});

describe("library skew", () => {
  function libraries(m: ReturnType<typeof buildModel>) {
    const b = radarBoard(m, AT);
    expect(() => expectView(RADAR_KEY, "board")(b)).not.toThrow();
    const sec = b.sections.find((s) => s.kind === "rows" && s.title === "Libraries");
    if (sec?.kind !== "rows") throw new Error("libraries section");
    return sec.items.map((i) => [i.chip?.label ?? i.glyph, i.text, i.trailing]);
  }

  test("pins come from os-core-common.version and core-lib-azure.version, or the artifact's own version", () => {
    expect(
      pinsOf(
        "<properties>\n  <os-core-common.version>7.1.3</os-core-common.version>\n  <core-lib-azure.version>3.0.1</core-lib-azure.version>\n</properties>",
      ),
    ).toEqual({ osCoreCommon: "7.1.3", coreLibAzure: "3.0.1" });
    expect(
      pinsOf(
        "<dependency><groupId>org.opengroup.osdu</groupId><artifactId>core-lib-azure</artifactId>\n<version>3.0.4</version></dependency>",
      ),
    ).toEqual({ coreLibAzure: "3.0.4" });
    expect(pinsOf("<os-core-common.version>${core.version}</os-core-common.version>")).toEqual({});
  });

  test("a fork behind upstream is skewed; one on upstream folds, counting those behind the latest release", () => {
    expect(libraries(model())).toEqual([
      [
        "entitlements",
        "os-core-common · fork 7.1.3 · upstream 8.2.0 · latest 9.3.0",
        "core-lib-azure 3.0.1 · latest 3.0.4",
      ],
      [
        "legal",
        "os-core-common · fork 7.1.3 · upstream 9.2.0 · latest 9.3.0",
        "core-lib-azure 3.0.1 · latest 3.0.4",
      ],
      [
        "info",
        "3 forks match upstream · partition, schema and file",
        "3 behind the latest release",
      ],
    ]);
    expect(model().radar.services.entitlements?.libraries?.state).toBe("skewed");
  });

  test("an unread pom draws '?' and never counts as matching", () => {
    const rows = libraries(
      model((f) => {
        const legal = f.radar.data?.services.legal;
        const file = f.radar.data?.services.file;
        if (!legal || !file?.pins) throw new Error("fixture pins");
        delete legal.pins;
        file.pins = { upstream: file.pins.upstream };
      }),
    );
    expect(rows.at(-1)).toEqual([
      "neutral",
      "2 forks unread · legal and file",
      "os-core-common ? · upstream ?",
    ]);
    expect(rows.some((r) => String(r[1]).includes("match upstream · partition and schema"))).toBe(
      true,
    );
  });

  test("the latest release is the newest semver tag, read at most hourly", async () => {
    const state = emptyLedgerState();
    let calls = 0;
    const glab = new Glab({
      runJSON: async () => {
        calls++;
        return {
          ok: true as const,
          data: [
            { name: "v8.4.0" },
            { name: "v9.3.0" },
            { name: "v9.10.0-rc1" },
            { name: "v9.2.0" },
          ] as never,
        };
      },
      runText: async () => ({ ok: false as const, error: "unused", code: 1 }),
    });
    const now = Date.parse("2026-10-13T23:00:00Z");
    expect(await readLatest(glab, state, now)).toEqual({
      osCoreCommon: "9.3.0",
      coreLibAzure: "9.3.0",
    });
    await readLatest(glab, state, now + 30 * 60_000);
    expect(calls).toBe(2);
    await readLatest(glab, state, now + 61 * 60_000);
    expect(calls).toBe(4);
  });
});
