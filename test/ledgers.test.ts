import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect";
import {
  emptyLedgerState,
  mrRefs,
  pinsOf,
  readLatest,
  readMerged,
  readPortPrs,
  readRemoval,
} from "../src/collect/ledgers";
import type { Facts } from "../src/facts";
import { Gh, Glab } from "../src/forge";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { itemClass, nextText, verbOf } from "../src/model/next";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const ENT = "osdu/platform/security-and-compliance/entitlements";

function model(edit?: (f: Facts) => void) {
  const f = fixtureFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

function owed(m: ReturnType<typeof buildModel>) {
  return Object.fromEntries(
    Object.entries(m.radar.services).map(([svc, r]) => [svc, r.ports?.owed.map((o) => o.iid)]),
  );
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

  test("an owed MR is owed on its fork and a P1 item with its Next line", () => {
    expect(owed(model())).toMatchObject({ entitlements: [963, 956], legal: [783] });
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
    expect(itemClass(item)).toBe("PORT");
    expect(verbOf(item)).toBe("Port");
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

  test("an upstream MR that only deletes fork-owned code is the removal, not a port", () => {
    const m = model((f) => {
      const ent = f.radar.data?.services.entitlements;
      if (!ent?.merged) throw new Error("fixture has entitlements merged MRs");
      const gone = [
        "provider/entitlements-v2-azure/pom.xml",
        "testing/entitlements-v2-test-azure/pom.xml",
      ];
      ent.merged.push({
        iid: 969,
        title: "chore: remove Azure provider and Azure CI/CD",
        url: "u",
        mergedAt: "2026-10-20T00:00:00Z",
        headSha: "f00",
        paths: [...gone, "README.md"],
        deleted: gone,
      });
      ent.merged.push({
        iid: 970,
        title: "Delete one file, edit another",
        url: "u",
        mergedAt: "2026-10-21T00:00:00Z",
        headSha: "f01",
        paths: [
          "provider/entitlements-v2-azure/src/Old.java",
          "provider/entitlements-v2-azure/src/New.java",
        ],
        deleted: ["provider/entitlements-v2-azure/src/Old.java"],
      });
    });
    expect(owed(m)).toMatchObject({ entitlements: [963, 956, 970] });
    expect(m.radar.services.entitlements?.removal).toBe("fork-only");
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
    expect(owed(m)).toMatchObject({ entitlements: undefined, legal: undefined });
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
    return Object.fromEntries(
      Object.entries(m.radar.services).map(([svc, r]) => [svc, r.libraries?.state]),
    );
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

  test("a fork behind upstream is skewed; one on upstream but behind the latest release is behind", () => {
    const m = model();
    expect(libraries(m)).toEqual({
      partition: "behind",
      entitlements: "skewed",
      legal: "skewed",
      schema: "behind",
      file: "behind",
    });
    expect(m.radar.services.entitlements?.libraries).toMatchObject({
      osCoreCommon: { fork: "7.1.3", upstream: "8.2.0", latest: "9.3.0" },
      coreLibAzure: { fork: "3.0.1", latest: "3.0.4" },
    });
    expect(m.radar.services.legal?.libraries?.osCoreCommon.upstream).toBe("9.2.0");
  });

  test("an unread pom is unread and never counts as matching", () => {
    const states = libraries(
      model((f) => {
        const legal = f.radar.data?.services.legal;
        const file = f.radar.data?.services.file;
        if (!legal || !file?.pins) throw new Error("fixture pins");
        delete legal.pins;
        file.pins = { upstream: file.pins.upstream };
      }),
    );
    expect(states).toMatchObject({ partition: "behind", schema: "behind" });
    expect(states.legal).toBeUndefined();
    expect(states.file).toBe("unread");
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

describe("the Azure removal stage", () => {
  function stages(m: ReturnType<typeof buildModel>) {
    return Object.fromEntries(Object.entries(m.radar.services).map(([svc, r]) => [svc, r.removal]));
  }

  test("each service takes its stage from its removal issue's SPI fork label", () => {
    const m = model();
    expect(stages(m)).toEqual({
      partition: "established",
      entitlements: "established",
      legal: "established",
      schema: "established",
      file: "established",
    });
    expect(m.radar.removalDue).toBe("2026-11-13");
  });

  test("a merged MR that deletes the fork's Azure provider tree makes it fork-only", () => {
    const m = model((f) => {
      const partition = f.radar.data?.services.partition;
      if (!partition?.merged) throw new Error("fixture has partition merged MRs");
      const gone = ["provider/partition-azure/pom.xml", "provider/partition-azure/src/A.java"];
      partition.merged.push({
        iid: 999,
        title: "Remove Azure provider",
        url: "u",
        mergedAt: "2026-10-13T00:00:00Z",
        headSha: "f00",
        paths: gone,
        deleted: gone,
      });
    });
    expect(m.radar.services.partition?.removal).toBe("fork-only");
  });

  test("a service no removal issue names has no stage", () => {
    const m = model((f) => {
      const removal = f.radar.data?.removal;
      if (!removal) throw new Error("fixture has removal labels");
      delete removal.labels["osdu/platform/security-and-compliance/legal"];
    });
    expect(m.radar.services.legal?.removal).toBeUndefined();
  });
});

describe("the removal read", () => {
  test("labels map by upstream project, established wins, the milestone gives the due date", async () => {
    const state = emptyLedgerState();
    let fail = false;
    const asked: string[] = [];
    const glab = new Glab({
      runJSON: async (_cmd: string, args: string[]) => {
        const path = args[3] ?? "";
        asked.push(path);
        if (fail) return { ok: false as const, error: "HTTP 500", code: 1 };
        const issue = (full: string) => ({
          references: { full },
          milestone: { due_date: "2026-11-13" },
        });
        const data = path.includes("pending")
          ? [issue("osdu/platform/system/storage#1"), issue("osdu/platform/system/file#297")]
          : [issue("osdu/platform/system/file#297")];
        return { ok: true as const, data: data as never };
      },
      runText: async () => ({ ok: false as const, error: "unused", code: 1 }),
    });
    const now = Date.parse("2026-10-13T23:00:00Z");
    const read = await readRemoval(glab, state, now);
    expect(read).toEqual({
      due: "2026-11-13",
      labels: {
        "osdu/platform/system/storage": "pending",
        "osdu/platform/system/file": "established",
      },
    });
    expect(asked[0]).toContain("groups/osdu%2Fplatform/issues?labels=SPI%20fork%3A%3Apending");
    fail = true;
    expect(await readRemoval(glab, state, now + 2 * 60 * 60_000)).toEqual(read);
  });
});
