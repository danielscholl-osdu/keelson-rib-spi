import { describe, expect, test } from "bun:test";
import { parseRepo } from "../src/collect/github";
import { FORKS, STACK_REPO } from "../src/config";
import type { Facts, IssueFact, PrFact } from "../src/facts";
import { buildWork, issueKind, prKind } from "../src/model/work";
import { fixtureFacts } from "./harness";

function pr(over: Partial<PrFact>): PrFact {
  return {
    repo: STACK_REPO,
    number: 1,
    title: "feat: something",
    url: "https://github.com/Azure/osdu-spi-stack/pull/1",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    draft: false,
    head: "feat/something",
    base: "main",
    headSha: "a".repeat(40),
    labels: [],
    checks: [],
    ...over,
  };
}

function issue(over: Partial<IssueFact>): IssueFact {
  return {
    repo: STACK_REPO,
    number: 1,
    title: "something",
    url: "https://github.com/Azure/osdu-spi-stack/issues/1",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    labels: [],
    comments: 0,
    ...over,
  };
}

function seeded(repo = STACK_REPO): Facts {
  const f = fixtureFacts();
  const stack = f.github.data?.repos[repo];
  if (!stack) throw new Error(`${repo} facts`);
  stack.prs = [
    pr({
      number: 323,
      author: "outside-a",
      association: "CONTRIBUTOR",
      createdAt: "2026-10-08T00:00:00Z",
    }),
    pr({
      number: 341,
      author: "outside-a",
      association: "NONE",
      draft: true,
      createdAt: "2026-10-01T00:00:00Z",
    }),
    pr({
      number: 330,
      author: "maintainer",
      association: "MEMBER",
      createdAt: "2026-10-09T00:00:00Z",
    }),
    pr({ number: 340, author: "dependabot", head: "dependabot/github_actions/x" }),
    pr({ number: 339, author: "osdu-spi-automation", head: "env-bump/v0.28.4" }),
  ];
  stack.issues = [
    issue({ number: 324, labels: ["bug"] }),
    issue({ number: 321, labels: ["bug"] }),
    issue({ number: 133, labels: ["enhancement"] }),
    issue({ number: 300 }),
    issue({ number: 299, bot: true, labels: ["human-required"] }),
  ];
  stack.openPrs = 5;
  stack.openIssues = 8;
  for (const item of [...stack.prs, ...stack.issues]) item.repo = repo;
  return f;
}

describe("open work", () => {
  test("people, bot and pipeline PRs split by class, with outside authors and drafts apart", () => {
    const work = buildWork(seeded().github.data?.repos ?? {});
    expect([work.template.name, work.stack.name]).toEqual(["osdu-spi", "osdu-spi-stack"]);
    expect(work.forks.map((r) => r.name)).toEqual(FORKS.map((f) => f.id));
    const { stack } = work;
    expect(stack.prs.people.map((p) => p.number)).toEqual([323, 341, 330]);
    expect(stack.prs.bots.map((p) => p.number)).toEqual([340]);
    expect(stack.prs.pipeline.map((p) => p.number)).toEqual([339]);
    expect(stack.contributors.map((p) => p.number)).toEqual([323, 341]);
    expect(stack.oldest?.number).toBe(323);
    expect(stack.unreadPrs).toBe(0);
  });

  test("automation issues stand apart from bugs, enhancements and the rest", () => {
    const { stack } = buildWork(seeded().github.data?.repos ?? {});
    expect(stack.issues.bug.map((i) => i.number)).toEqual([324, 321]);
    expect(stack.issues.enhancement.map((i) => i.number)).toEqual([133]);
    expect(stack.issues.other.map((i) => i.number)).toEqual([300]);
    expect(stack.issues.automation.map((i) => i.number)).toEqual([299]);
    expect(stack.unreadIssues).toBe(3);
    expect(issueKind(issue({ labels: ["sync-failed", "human-required"] }))).toBe("automation");
    expect(issueKind(issue({ labels: ["upstream-sync"] }))).toBe("automation");
  });

  test("the fixture's sync engine PRs and issues never count as people work", () => {
    const { forks } = buildWork(fixtureFacts().github.data?.repos ?? {});
    const legal = forks.find((r) => r.name === "legal");
    expect(legal?.prs.people).toEqual([]);
    expect(legal?.issues.automation.length).toBe(1);
    const entitlements = forks.find((r) => r.name === "entitlements");
    expect(entitlements?.issues.automation.map((i) => i.labels)).toContainEqual(
      expect.arrayContaining(["sync-failed"]),
    );
    expect(prKind(pr({ head: "template-sync/20261013-183716" }))).toBe("pipeline");
    expect(prKind(pr({ head: "release-please--branches--main" }))).toBe("pipeline");
  });

  test("a fork's open work counts its people, outside authors and issues; an unread fork is unread", () => {
    const f = seeded("Azure/osdu-spi-file");
    delete f.github.data?.repos["Azure/osdu-spi-schema"];
    const { forks } = buildWork(f.github.data?.repos ?? {});
    const fork = (name: string) => forks.find((r) => r.name === name);
    expect(fork("schema")?.read).toBe(false);
    const file = fork("file");
    expect(file?.read).toBe(true);
    expect(file?.prs.people.map((p) => p.number)).toEqual([323, 341, 330]);
    expect(file?.prs.people.filter((p) => p.draft).map((p) => p.number)).toEqual([341]);
    expect(file?.contributors.map((p) => p.number)).toEqual([323, 341]);
    expect(file?.oldest?.number).toBe(323);
    expect(file?.issues.automation.map((i) => i.number)).toEqual([299]);
    expect(file?.unreadIssues).toBe(3);
  });

  test("a repository read reports authors' association, app authors and open totals", () => {
    const fact = parseRepo({
      nameWithOwner: STACK_REPO,
      url: "https://github.com/Azure/osdu-spi-stack",
      pullRequests: {
        totalCount: 41,
        nodes: [
          {
            number: 323,
            title: "feat: onboard Seismic Store V3",
            url: "u",
            createdAt: "2026-10-08T00:00:00Z",
            updatedAt: "2026-10-08T00:00:00Z",
            isDraft: false,
            headRefName: "feat/add-seismic-service",
            baseRefName: "main",
            headRefOid: "a".repeat(40),
            author: { login: "outside-a" },
            authorAssociation: "CONTRIBUTOR",
          },
        ],
      },
      issues: {
        totalCount: 1,
        nodes: [
          {
            number: 47,
            title: "Upstream Sync Failed",
            url: "u",
            createdAt: "2026-10-08T00:00:00Z",
            updatedAt: "2026-10-08T00:00:00Z",
            author: { __typename: "Bot", login: "osdu-spi-automation" },
            authorAssociation: "NONE",
          },
        ],
      },
    });
    expect(fact.prs[0]?.association).toBe("CONTRIBUTOR");
    expect(fact.issues[0]).toMatchObject({ author: "osdu-spi-automation", bot: true });
    expect(fact.openPrs).toBe(41);
    expect(fact.openIssues).toBe(1);
    expect(buildWork({ [STACK_REPO]: fact }).stack.unreadPrs).toBe(40);
  });
});
