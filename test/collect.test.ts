import { describe, expect, test } from "bun:test";
import {
  buildQuery,
  parseCrons,
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
    expect(q).toContain("pastPrs: pullRequests(states: [MERGED, CLOSED]");
    expect(q).toContain('labels: ["sync-failed","conflict","cascade-blocked","cascade-failed"]');
    expect(q).toContain('wf_refresh: object(expression: "main:.github/workflows/env-refresh.yml")');
  });

  test("the stack's releases and workflow schedules, and a fork's past gates, are parsed", () => {
    const facts = parseGithub({
      r_stack: {
        nameWithOwner: "Azure/osdu-spi-stack",
        url: "https://github.com/Azure/osdu-spi-stack",
        releases: {
          nodes: [
            { tagName: "v0.28.3", publishedAt: "2026-10-13T00:18:28Z", url: "u3" },
            { tagName: "v0.29.0", publishedAt: null, url: "u4", isDraft: true },
          ],
        },
        wf_refresh: { text: 'on:\n  schedule:\n    - cron: "0 4 * * 1-5"\n' },
        wf_upgrade: { text: "on:\n  push:\n" },
        wf_smoke: null,
      },
      r_fork0: {
        nameWithOwner: "Azure/osdu-spi-legal",
        url: "https://github.com/Azure/osdu-spi-legal",
        pastPrs: {
          nodes: [
            {
              number: 21,
              title: "Sync with upstream",
              url: "u21",
              createdAt: "2026-09-30T00:08:00Z",
              mergedAt: "2026-09-30T01:33:00Z",
              closedAt: "2026-09-30T01:33:00Z",
              headRefName: "sync/upstream-20260930",
              baseRefName: "fork_upstream",
            },
          ],
        },
        pastIssues: {
          nodes: [
            {
              number: 9,
              url: "u9",
              createdAt: "2026-09-30T01:34:00Z",
              closedAt: "2026-09-30T01:38:00Z",
              labels: { nodes: [{ name: "conflict" }] },
            },
          ],
        },
      },
    });
    const stack = facts.repos["Azure/osdu-spi-stack"];
    expect(stack?.releases).toEqual([{ tag: "v0.28.3", at: "2026-10-13T00:18:28Z", url: "u3" }]);
    expect(stack?.schedules).toEqual({ refresh: ["0 4 * * 1-5"], upgrade: [], smoke: [] });
    const legal = facts.repos["Azure/osdu-spi-legal"];
    expect(legal?.pastPrs?.[0]).toMatchObject({ number: 21, head: "sync/upstream-20260930" });
    expect(legal?.pastIssues?.[0]).toMatchObject({ number: 9, labels: ["conflict"] });
    expect(legal?.releases).toBeUndefined();
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
  test("every cron line in a workflow file is a schedule", () => {
    expect(
      parseCrons(
        "on:\n  schedule:\n    # comment\n    - cron: \"0 4 * * 1-5\"\n    - cron: '30 8 * * *'\n",
      ),
    ).toEqual(["0 4 * * 1-5", "30 8 * * *"]);
    expect(parseCrons(undefined)).toEqual([]);
  });

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
