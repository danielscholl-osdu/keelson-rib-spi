import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import {
  buildQueries,
  mergeReads,
  parseCrons,
  parseDeclaration,
  parseGithub,
  parseHalt,
  parseUpstreamSha,
} from "../src/collect/github";
import { changeOf, firstParentChanges, readTemplate } from "../src/collect/template";
import { FORKS, PLANNED, STACK_REPO, TEMPLATE_REPO } from "../src/config";
import { Gh } from "../src/forge";

describe("GraphQL query", () => {
  test("reads the template, the stack, every fork and probes each planned repository", () => {
    const q = buildQueries().join("\n");
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
    expect(q).toContain(
      'r_template: repository(owner: "Azure", name: "osdu-spi") { ...Base ...Template }',
    );
    expect(q).toContain(
      'syncTemplate: object(expression: "main:.github/workflows/sync-template.yml")',
    );
  });

  test("the template's merged PRs keep their author and a fork reads its Sync Template schedule", () => {
    const facts = parseGithub({
      r_template: {
        nameWithOwner: "Azure/osdu-spi",
        url: "https://github.com/Azure/osdu-spi",
        pastPrs: {
          nodes: [
            {
              number: 254,
              title: "build(deps): bump setup-java",
              url: "u",
              createdAt: "2026-10-11T00:00:00Z",
              mergedAt: "2026-10-12T00:00:00Z",
              headRefName: "dependabot/github_actions/setup-java-5",
              baseRefName: "main",
              author: { login: "dependabot" },
            },
          ],
        },
      },
      r_fork0: {
        nameWithOwner: "Azure/osdu-spi-partition",
        url: "https://github.com/Azure/osdu-spi-partition",
        syncTemplate: { text: "on:\n  schedule:\n    - cron: '0 8 * * *'\n" },
      },
    });
    expect(facts.repos["Azure/osdu-spi"]?.pastPrs?.[0]?.author).toBe("dependabot");
    expect(facts.repos["Azure/osdu-spi"]?.syncCrons).toBeUndefined();
    expect(facts.repos["Azure/osdu-spi-partition"]?.syncCrons).toEqual(["0 8 * * *"]);
  });

  test("the sweep keeps what its own query cost beside the budget", () => {
    const facts = parseGithub({
      rateLimit: { cost: 14, remaining: 4870, resetAt: "2026-10-13T19:33:02Z" },
    });
    expect(facts.rate).toEqual({ cost: 14, remaining: 4870, resetAt: "2026-10-13T19:33:02Z" });
    for (const q of buildQueries()) expect(q).toContain("rateLimit { cost remaining resetAt }");
  });

  test("forks are read in batches, and the budget sums each query's cost", () => {
    const queries = buildQueries(2);
    expect(queries).toHaveLength(1 + Math.ceil(FORKS.length / 2));
    expect(queries[0]).toContain("r_template:");
    expect(queries[1]).toContain("r_fork0:");
    expect(queries[1]).not.toContain("r_fork2:");
    const merged = mergeReads([
      { rateLimit: { cost: 3, remaining: 4900, resetAt: "t" }, r_template: { a: 1 } },
      { rateLimit: { cost: 9, remaining: 4891, resetAt: "t" }, r_fork0: { b: 2 } },
    ]);
    expect(merged).toEqual({
      r_template: { a: 1 },
      r_fork0: { b: 2 },
      rateLimit: { cost: 12, remaining: 4891, resetAt: "t" },
    });
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

describe("GraphQL reads", () => {
  function scripted(replies: { data: string; exitCode: number }[]) {
    const calls: string[][] = [];
    const exec: RibExec = {
      runJSON: async () => ({ ok: false as const, error: "unused", code: 1 }),
      runText: async (_cmd: string, args: string[]) => {
        calls.push(args);
        const r = replies.shift() ?? { data: "", exitCode: 1 };
        return { ok: true as const, data: r.data, exitCode: r.exitCode };
      },
    };
    return { exec, calls };
  }

  test("a response GitHub cut short is read again once", async () => {
    const { exec, calls } = scripted([
      { data: "", exitCode: 1 },
      { data: JSON.stringify({ data: { viewer: { login: "operator" } } }), exitCode: 0 },
    ]);
    const counter = { calls: 0 };
    const res = await new Gh(exec, counter).graphql<{ viewer: { login: string } }>(
      "{viewer{login}}",
    );
    expect(res.data.viewer.login).toBe("operator");
    expect(calls).toHaveLength(2);
    expect(counter.calls).toBe(2);
  });

  test("half a body is read again too", async () => {
    const { exec, calls } = scripted([
      { data: '{"data":{"viewer":{"lo', exitCode: 1 },
      { data: JSON.stringify({ data: { viewer: { login: "operator" } } }), exitCode: 0 },
    ]);
    const res = await new Gh(exec).graphql<{ viewer: { login: string } }>("{viewer{login}}");
    expect(res.data.viewer.login).toBe("operator");
    expect(calls).toHaveLength(2);
    const twice = scripted([
      { data: "", exitCode: 1 },
      { data: '{"data":', exitCode: 1 },
    ]);
    await expect(new Gh(twice.exec).graphql("{viewer{login}}")).rejects.toThrow(
      "GitHub cut the response short twice (exit 1, 8 bytes that were not JSON)",
    );
  });

  test("cut short twice names what happened instead of a parse error", async () => {
    const { exec } = scripted([]);
    await expect(new Gh(exec).graphql("{viewer{login}}")).rejects.toThrow(
      "gh api graphql: GitHub cut the response short twice (exit 1, empty response)",
    );
  });

  test("a missing repository's error comes back beside the others' data", async () => {
    const { exec, calls } = scripted([
      {
        data: JSON.stringify({
          data: { a: { name: "x" }, b: null },
          errors: [{ type: "NOT_FOUND", path: ["b"], message: "Could not resolve" }],
        }),
        exitCode: 1,
      },
    ]);
    const res = await new Gh(exec).graphql<{ a: { name: string } }>("{a:repository{name}}");
    expect(res.data.a.name).toBe("x");
    expect(res.errors[0]?.type).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });
});

describe("template positions", () => {
  test("a commit is named by the newest release it contains, even from a cached compare", async () => {
    const head = "5af540b0000000000000000000000000000000000";
    const marker = "ea9a2e10000000000000000000000000000000000";
    const target = "bb49a030000000000000000000000000000000000";
    const status: Record<string, { status: string; ahead_by: number }> = {
      [`v1.3.0...${marker}`]: { status: "behind", ahead_by: 0 },
      [`v1.2.0...${marker}`]: { status: "identical", ahead_by: 0 },
      [`v1.3.0...${target}`]: { status: "behind", ahead_by: 0 },
      [`v1.2.0...${target}`]: { status: "ahead", ahead_by: 14 },
      [`v1.3.0...${head}`]: { status: "identical", ahead_by: 0 },
    };
    const reads: string[] = [];
    const exec: RibExec = {
      runJSON: async (_cmd: string, args: string[]) => {
        const path = args[1] ?? "";
        reads.push(path);
        if (path.endsWith("/tags?per_page=30")) {
          return { ok: true as const, data: ["v1.2.0", "v1.3.0", "v1.1.0"] as never };
        }
        const cmp = status[path.split("/compare/")[1] ?? ""];
        return cmp
          ? { ok: true as const, data: { ...cmp, behind_by: 0, commits: [] } as never }
          : { ok: false as const, error: `no fake for ${path}`, code: 1 };
      },
      runText: async () => ({ ok: false as const, error: "unused", code: 1 }),
    };
    const fork = FORKS[0];
    if (!fork) throw new Error("fork");
    const repos = {
      [TEMPLATE_REPO]: {
        repo: TEMPLATE_REPO,
        url: "",
        head: { sha: head, at: "2026-10-13T17:55:00Z" },
        release: { tag: "v1.3.0", at: "2026-10-13T17:55:57Z", url: "" },
        prs: [],
        issues: [],
        deployments: [],
      },
      [fork.repo]: {
        repo: fork.repo,
        url: "",
        marker,
        prs: [{ headMarker: target }],
        issues: [],
        deployments: [],
      },
    } as never;
    const state = {
      compares: {
        [`${marker}...${head}@v1.3.0#parents`]: {
          marker,
          head,
          label: "ea9a2e1 (before v1.3.0)",
          aheadBy: 30,
          shas: [],
          changes: [],
        },
      },
      labels: {},
      aheads: {},
    };
    const facts = await readTemplate(new Gh(exec), repos, state);
    expect(facts.compares[marker]?.label).toBe("v1.2.0");
    expect(facts.targets?.[target]).toBe("v1.2.0 +14");
    const before = reads.length;
    await readTemplate(new Gh(exec), repos, state);
    expect(
      reads.slice(before).filter((r) => r.includes("/tags") || r.includes("v1.2.0...")),
    ).toEqual([]);
  });
});
