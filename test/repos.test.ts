import { describe, expect, test } from "bun:test";
import type { Facts, PrFact } from "../src/facts";
import { buildModel } from "../src/model/index";
import {
  conventional,
  newerVersion,
  ownerOf,
  parseBump,
  prState,
  reachOf,
  titleShape,
} from "../src/model/repos";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const SYNCED = {
  dirs: [".github/actions", "build"],
  files: [".github/template-workflows/sync.yml", ".github/labels.json"],
};
const FORK = {
  owned: ["provider/partition-azure", "testing/partition-test-azure"],
  synced: SYNCED,
  program: false,
};

function rows(edit?: (f: Facts) => void) {
  const f = fixtureFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW).repositories.rows;
}

function pr(repo: string, number: number, title: string, extra: Partial<PrFact> = {}): PrFact {
  return {
    repo,
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    draft: false,
    head: `feature/${number}`,
    base: "main",
    headSha: "0".repeat(40),
    reviewDecision: "REVIEW_REQUIRED",
    mergeState: "BLOCKED",
    labels: [],
    checks: [],
    ...extra,
  };
}

describe("owner and reach", () => {
  test("the fork's own tree is ours, synced files are the template's, the rest is upstream", () => {
    expect(ownerOf("provider/partition-azure/pom.xml", FORK)).toBe("spi");
    expect(ownerOf(".github/workflows/sync.yml", FORK)).toBe("template");
    expect(ownerOf(".github/actions/java/action.yml", FORK)).toBe("template");
    expect(ownerOf(".github/workflows/local.yml", FORK)).toBe("upstream");
    expect(ownerOf("partition-core/pom.xml", FORK)).toBe("upstream");
    expect(ownerOf("partition-core/pom.xml", { owned: [], program: true })).toBe("spi");
  });

  test("test trees and development scope reach only tests; scripts are tooling", () => {
    expect(reachOf("pom.xml")).toBe("shipped");
    expect(reachOf("pom.xml", "development")).toBe("tests");
    expect(reachOf("testing/partition-test-core/pom.xml")).toBe("tests");
    expect(reachOf("unit-acceptance-test/v3/requirements.txt")).toBe("tests");
    expect(reachOf("testing/unit_test_azure/requirements.txt")).toBe("tests");
    expect(reachOf("deployments/scripts/cleaner/requirements.txt")).toBe("tooling");
    expect(reachOf("attestation/pom.xml")).toBe("shipped");
  });
});

describe("titles", () => {
  test("conventional commits give the type, scope aside, and a breaking mark", () => {
    expect(conventional("feat(cli)!: drop v1 loads")).toEqual({
      type: "feat",
      breaking: true,
      subject: "drop v1 loads",
    });
    expect(conventional("Test External Contribution flow").type).toBe("");
  });

  test("a Dependabot title names package, versions and directory in either style", () => {
    expect(
      parseBump("Bump jackson.version from 2.21.2 to 2.21.7 in /testing/storage-test-azure"),
    ).toEqual({
      package: "jackson.version",
      from: "2.21.2",
      to: "2.21.7",
      dir: "testing/storage-test-azure",
    });
    expect(
      parseBump(
        "chore(deps): bump openjdk/jdk from `1f04a62` to `292f024` in /build in the docker group",
      ),
    ).toMatchObject({ from: "1f04a62", to: "292f024", dir: "build" });
    expect(parseBump("chore(deps): bump urllib3 from 2.5.0 to 2.8.0")?.dir).toBe("");
    expect(parseBump("Bump the maven group across 2 directories with 3 updates")).toBeUndefined();
  });

  test("one change across forks reads as one title", () => {
    const unit = { id: "unit", upstream: "osdu/platform/system/reference/unit-service" };
    const queue = { id: "indexer-queue", upstream: "osdu/platform/system/indexer-queue" };
    expect(titleShape("chore(spi): add service descriptor for unit service", unit)).toBe(
      titleShape("chore(spi): add service descriptor for indexer-queue", queue),
    );
  });

  test("versions compare by number", () => {
    expect(newerVersion("2.21.10", "2.21.7")).toBe(true);
    expect(newerVersion("2.21.7", "2.21.10")).toBe(false);
    expect(newerVersion("32.0.0-android", "31.1")).toBe(true);
  });
});

test("a PR's state names what holds it first", () => {
  const p = pr("Azure/osdu-spi-legal", 1, "fix: x");
  expect(prState({ ...p, draft: true })).toBe("draft");
  expect(prState({ ...p, mergeState: "DIRTY" })).toBe("conflicts");
  expect(prState(p)).toBe("needs review");
  expect(prState({ ...p, reviewDecision: "APPROVED", mergeState: "BEHIND" })).toBe("behind");
  expect(prState({ ...p, reviewDecision: "APPROVED", mergeState: "CLEAN" })).toBe("ready");
});

describe("the repositories model", () => {
  test("lists the template and the stack, then every fork", () => {
    const r = rows();
    expect(r.map((x) => `${x.group}:${x.name}`)).toEqual([
      "program:osdu-spi",
      "program:osdu-spi-stack",
      "fork:partition",
      "fork:entitlements",
      "fork:legal",
      "fork:schema",
      "fork:file",
    ]);
  });

  test("groups alerts by package and says who fixes them", () => {
    const partition = rows().find((x) => x.name === "partition");
    const jackson = partition?.alerts.find((g) => g.name.endsWith("jackson-databind"));
    expect(jackson).toMatchObject({
      source: "dependabot",
      where: "pom.xml",
      owner: "upstream",
      reach: "shipped",
      severity: "high",
      fix: "2.21.7",
    });
    expect(partition?.shipped).toEqual({ ours: 0, upstream: 3 });
    expect(partition?.alerts[0]?.owner).toBe("spi");
  });

  test("a rule in our code on several forks names the others", () => {
    const r = rows();
    const csrf = (name: string) =>
      r
        .find((x) => x.name === name)
        ?.alerts.find((g) => g.name === "Disabled Spring CSRF protection");
    expect(csrf("partition")?.owner).toBe("spi");
    expect(csrf("partition")?.elsewhere).toContain("legal");
    expect(csrf("partition")?.elsewhere).not.toContain("partition");
  });

  test("schema's highs sit in tooling and tests, not in shipped code", () => {
    const schema = rows().find((x) => x.name === "schema");
    expect(schema?.shipped).toEqual({ ours: 0, upstream: 0 });
    expect(schema?.alerts.some((g) => g.reach === "tooling" && g.severity === "high")).toBe(true);
  });

  test("a Dependabot PR is matched to the alerts it closes", () => {
    const r = rows((f) => {
      const repo = f.github.data?.repos["Azure/osdu-spi-partition"];
      repo?.prs.push(
        pr(
          "Azure/osdu-spi-partition",
          90,
          "Bump com.fasterxml.jackson.core:jackson-databind from 2.21.6 to 2.21.7",
          { author: "dependabot", head: "dependabot/maven/jackson", mergeState: "BEHIND" },
        ),
      );
    });
    const partition = r.find((x) => x.name === "partition");
    expect(partition?.dependabot[0]).toMatchObject({
      owner: "upstream",
      reach: "shipped",
      state: "needs review",
      closes: 5,
    });
    expect(partition?.alerts.find((g) => g.name.endsWith("jackson-databind"))?.pr).toBe(90);
    expect(partition?.changes).toEqual([]);
  });

  test("the same change on several forks links them, and its type is read from the title", () => {
    const r = rows((f) => {
      for (const id of ["legal", "file"]) {
        const repo = f.github.data?.repos[`Azure/osdu-spi-${id}`];
        repo?.prs.push(
          pr(`Azure/osdu-spi-${id}`, 70, `chore(spi): add service descriptor for ${id}`),
        );
      }
    });
    const legal = r.find((x) => x.name === "legal")?.changes[0];
    expect(legal).toMatchObject({ type: "chore", kind: "maintenance", elsewhere: ["file"] });
  });

  test("a list GitHub hides reads as unread, never as zero", () => {
    const r = rows((f) => {
      const a = f.security.data?.["Azure/osdu-spi-legal"];
      if (a) delete a.code;
    });
    const legal = r.find((x) => x.name === "legal");
    expect(legal?.code).toBeUndefined();
    expect(legal?.codeAlerts).toBeUndefined();
    expect(legal?.shipped).toBeDefined();
  });
});
