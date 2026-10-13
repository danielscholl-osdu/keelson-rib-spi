import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { linesBoard } from "../src/boards/lines";
import { foldList, type OpenEntry, stackOpen } from "../src/boards/open";
import { stackBoard } from "../src/boards/stack";
import { parseRepo } from "../src/collect/github";
import { FORKS, STACK_REPO } from "../src/config";
import type { Facts, IssueFact, PrFact } from "../src/facts";
import { STACK_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { buildWork, issueKind, prKind } from "../src/model/work";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

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

  test("Services draws one row per fork, counts linked, unread forks as ?", () => {
    const f = seeded("Azure/osdu-spi-file");
    delete f.github.data?.repos["Azure/osdu-spi-schema"];
    const b = linesBoard(buildModel(f, FIXTURE_NOW), FIXTURE_NOW);
    const table = b.sections.at(-1);
    if (table?.kind !== "table") throw new Error("open work last");
    expect(table.caption).toContain("file: 3 issues past the page, not counted");
    const text = (c: unknown) =>
      typeof c === "object" && c !== null && "value" in c
        ? String(c.value).replaceAll("\u00a0", " ")
        : c;
    expect(table.rows.map((r) => text(r.repo))).toEqual(["entitlements", "schema", "file"]);
    const totals = b.sections.at(-2);
    if (totals?.kind !== "rows") throw new Error("totals above open work");
    expect(totals.items[0]?.text).toMatch(/^\d+ pipeline PRs · 1 Dependabot across 4 forks$/);
    expect(totals.items[0]?.href).toContain("repo%3AAzure%2Fosdu-spi-file");
    expect(totals.items[0]?.href).not.toContain("osdu-spi-schema");
    const schema = table.rows.find((r) => text(r.repo) === "schema");
    expect(text(schema?.people)).toBe("?");
    const file = table.rows.find((r) => text(r.repo) === "file");
    expect(file?.people).toMatchObject({ value: "3 · 2 outside · 1 draft", tone: "info" });
    expect(text(file?.issues)).toBe("4 · 2 bug · 1 enhancement · 1 other");
    expect(text(file?.automation)).toBe("1");
    expect(text(file?.oldest)).toBe("#323 · 4d");
    const tiles = b.sections[0];
    if (tiles?.kind !== "stats") throw new Error("tiles first");
    expect(tiles.items.at(-1)).toMatchObject({
      label: "Open work · people",
      sub: expect.stringContaining("2 from outside"),
    });
  });

  test("the stack's PRs and issues list on Environment, not on Services", () => {
    const m = buildModel(seeded(), FIXTURE_NOW);
    const lines = linesBoard(m, FIXTURE_NOW);
    const tiles = lines.sections[0];
    if (tiles?.kind !== "stats") throw new Error("tiles first");
    expect(tiles.items.at(-1)?.sub).not.toContain("outside");
    const b = stackBoard(m, FIXTURE_NOW);
    expect(() => expectView(STACK_KEY, "board")(b)).not.toThrow();
    const open = b.sections.at(-1);
    if (open?.kind !== "rows") throw new Error("open on the stack last");
    expect(open.title).toBe("Open on osdu-spi-stack · 5 PRs · 5 issues");
    expect(open.items.map((i) => [i.chip?.label, i.text.split(" ")[0]])).toEqual([
      ["Dependabot", "#340"],
      ["bug", "#324"],
      ["bug", "#321"],
      ["outside", "#323"],
      ["outside", "#341"],
      ["env bump", "#339"],
      [undefined, "and"],
    ]);
    expect(open.items[4]?.trailing).toContain("draft");
    expect(open.items.at(-1)).toMatchObject({
      icon: "↗",
      text: "and 1 PR, 1 enhancement, 1 issue, 1 automation issue, 3 past the page",
      trailing: "open on GitHub",
      href: "https://github.com/Azure/osdu-spi-stack/issues?q=is%3Aopen",
    });
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

  test("an open list shows six rows, then one row that counts the rest by kind and links them", () => {
    const entry = (n: number, kind: string, first = false): OpenEntry => ({
      row: { text: `#${n}` },
      at: `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`,
      first,
      kind,
      pr: false,
    });
    const six = [1, 2, 3, 4, 5, 6].map((n) => entry(n, "enhancement"));
    const none = { prs: 0, issues: 0 };
    expect(foldList(STACK_REPO, six, none).map((r) => r.text)).toEqual([
      "#6",
      "#5",
      "#4",
      "#3",
      "#2",
      "#1",
    ]);
    const seven = [...six, entry(7, "bug", true)];
    const folded = foldList(STACK_REPO, seven, none);
    expect(folded.map((r) => r.text)).toEqual([
      "#7",
      "#6",
      "#5",
      "#4",
      "#3",
      "#2",
      "and 1 enhancement",
    ]);
    expect(folded.at(-1)?.href).toBe("https://github.com/Azure/osdu-spi-stack/issues");
    expect(foldList(STACK_REPO, six, { prs: 2, issues: 0 }).at(-1)).toMatchObject({
      text: "and 2 past the page",
      href: "https://github.com/Azure/osdu-spi-stack/pulls",
    });
  });

  test("an outside PR whose runs wait approval says so", () => {
    const { stack } = buildWork(seeded().github.data?.repos ?? {});
    const open = stackOpen(stack, FIXTURE_NOW, new Set([323]));
    if (open?.kind !== "rows") throw new Error("open rows");
    const row = open.items.find((i) => i.text.startsWith("#323"));
    expect(row?.trailing).toBe("outside-a · waits approval · 4d");
  });
});
