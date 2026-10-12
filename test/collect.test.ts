import { describe, expect, test } from "bun:test";
import {
  buildQuery,
  parseDeclaration,
  parseGithub,
  parseHalt,
  parseUpstreamSha,
} from "../src/collect/github";
import { changeOf, firstParentChanges } from "../src/collect/template";
import { FORKS, PLANNED, STACK_REPO, TEMPLATE_REPO } from "../src/config";

describe("GraphQL query", () => {
  test("reads the template, the stack, every fork and probes each planned repository", () => {
    const q = buildQuery();
    for (const repo of [TEMPLATE_REPO, STACK_REPO, ...FORKS.map((f) => f.repo)]) {
      expect(q).toContain(`name: "${repo.split("/")[1]}"`);
    }
    for (const p of PLANNED) expect(q).toContain(`name: "osdu-spi-${p.id}"`);
    expect(q).toContain('environments: ["spi-stack"]');
    expect(q).toContain("main:.github/.template-sync-commit");
    expect(q).toContain("main:ops/environments/shared.yaml");
  });

  test("a planned repository that does not exist reads as missing, not as an error", () => {
    const facts = parseGithub({
      rateLimit: { remaining: 4900, resetAt: "2026-10-12T22:19:00Z" },
      p_0: null,
      p_1: { nameWithOwner: "Azure/osdu-spi-indexer" },
      p_2: null,
    });
    expect(facts.planned).toEqual({ storage: false, indexer: true, search: false });
    expect(facts.rate?.remaining).toBe(4900);
  });
});

describe("parsers", () => {
  test("the halt line follows the ### Halt heading", () => {
    const body =
      "The upstream filter halted rather than guess.\n\n### Halt\nUNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests\n\nA halt usually means...";
    expect(parseHalt(body)).toBe(
      "UNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests",
    );
    expect(parseHalt("no heading here")).toBeUndefined();
  });

  test("the declaration yields version, location, profile and trusted forks", () => {
    const text =
      "env: shared\nstackVersion: v0.28.1\nprofile: core\nlocation: westus3\nforks:\n  - service: partition\n    repo: Azure/osdu-spi-partition\n  - service: legal\n    repo: Azure/osdu-spi-legal\n";
    expect(parseDeclaration(text)).toEqual({
      stackVersion: "v0.28.1",
      location: "westus3",
      profile: "core",
      forks: ["partition", "legal"],
    });
  });

  test("the newest Upstream-Sha trailer on fork_upstream is what the fork synced", () => {
    expect(
      parseUpstreamSha([
        {
          oid: "a",
          message: "Merge pull request #165 from Azure/sync/upstream-x",
          committedDate: "2026-09-30T01:32:32Z",
        },
        {
          oid: "b",
          message:
            "chore: generate filtered upstream tree\n\nUpstream-Sha: e3fa53b26e86140221eb1b621e92cdd0ac75df49\nFilter-Rev: 1.0.0+b4950c8de368",
          committedDate: "2026-09-30T00:36:13Z",
        },
      ]),
    ).toEqual({ sha: "e3fa53b26e86140221eb1b621e92cdd0ac75df49", at: "2026-09-30T00:36:13Z" });
  });
});

describe("template changes", () => {
  const commit = (sha: string, parents: string[], message: string) => ({
    sha,
    parents,
    message,
    date: "2026-10-10T16:12:46Z",
    url: `https://github.com/Azure/osdu-spi/commit/${sha}`,
  });

  test("a merge commit carries its PR title; a squash keeps its subject and number", () => {
    expect(
      changeOf(
        commit(
          "m1",
          ["a", "b"],
          "Merge pull request #251 from Azure/copilot/x\n\nPin Maven in java-build",
        ),
      ),
    ).toMatchObject({
      title: "Pin Maven in java-build",
      pr: 251,
      url: "https://github.com/Azure/osdu-spi/pull/251",
    });
    expect(changeOf(commit("s1", ["a"], "fix(build): pin maven (#251)"))).toMatchObject({
      title: "fix(build): pin maven (#251)",
      pr: 251,
    });
  });

  test("only main's first-parent chain counts as changes", () => {
    const commits = [
      commit("side1", ["marker"], "Initial plan"),
      commit("side2", ["side1"], "Apply remaining changes"),
      commit(
        "m1",
        ["marker", "side2"],
        "Merge pull request #251 from Azure/copilot/x\n\nPin Maven",
      ),
      commit(
        "m2",
        ["m1", "dep1"],
        "Merge pull request #252 from Azure/dependabot/y\n\nchore(deps): bump openjdk",
      ),
      commit("dep1", ["marker"], "chore(deps): bump openjdk"),
    ];
    expect(firstParentChanges("m2", commits).map((c) => c.pr)).toEqual([252, 251]);
  });
});
