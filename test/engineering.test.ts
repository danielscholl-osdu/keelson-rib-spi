import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { inspectBoard } from "../src/boards/inspect";
import type { Facts, PrFact } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts, NEW_HEAD, releasedFacts as released } from "./harness";

function dependabotPr(repo: string, number: number): PrFact {
  return {
    repo,
    number,
    title: "build(deps): bump spring-boot",
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    draft: false,
    head: `dependabot/maven/spring-boot-${number}`,
    base: "main",
    headSha: "d0d0",
    author: "dependabot",
    labels: [],
    checks: [],
  };
}

function model(edit?: (f: Facts) => void) {
  const f = released();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

function inspectSet(m: ReturnType<typeof buildModel>) {
  const b = inspectBoard(m, { selected: "template-set" }, FIXTURE_NOW);
  expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
  return b;
}

describe("the template-set inspector", () => {
  test("the ladder names each step by release and says no PR carries the newest yet", () => {
    const ladder = inspectSet(model()).sections.find(
      (s) => s.kind === "rows" && s.title === "Release ladder · newest first",
    );
    if (ladder?.kind !== "rows") throw new Error("ladder");
    expect(ladder.items.map((i) => [i.chip?.label, i.trailing])).toEqual([
      ["v1.3.0", "0 of 5 · no PR carries it yet"],
      ["v1.2.0 +2", "1 of 5 · 4 waiting"],
      ["v1.2.0", "5 of 5"],
    ]);
    expect(ladder.items[0]?.text).toStartWith("8 changes · ");
    expect(ladder.items[0]?.text).toEndWith("resolve the Java release from the root pom");
    expect(ladder.items[0]?.action).toEqual({
      type: "inspect",
      payload: { id: `step:${NEW_HEAD}` },
    });
  });

  test("the rollout verbs sit above the ladder", () => {
    const kinds = inspectSet(model()).sections.map((s) =>
      s.kind === "actions" ? s.items.map((i) => i.label.split(" · ")[0]).join(", ") : s.title,
    );
    const verbs = kinds.indexOf("Sync all forks, Roll out");
    expect(verbs).toBeGreaterThan(0);
    expect(kinds[verbs + 1]).toBe("Release ladder · newest first");
  });

  test("with no ladder step the inspector draws the verbs alone", () => {
    const m = model();
    const b = inspectSet({ ...m, template: { ...m.template, steps: [] } });
    expect(b.sections.some((s) => s.kind === "actions")).toBe(true);
    expect(b.sections.some((s) => "title" in s && s.title?.startsWith("Release ladder"))).toBe(
      false,
    );
  });
});

describe("the template rollout", () => {
  test("each fork's row reads its position, PR, review and open Dependabot PRs", () => {
    const m = model((f) => {
      const repos = f.github.data?.repos;
      repos?.["Azure/osdu-spi-entitlements"]?.prs.push(
        dependabotPr("Azure/osdu-spi-entitlements", 52),
        dependabotPr("Azure/osdu-spi-entitlements", 54),
      );
      const legal = repos?.["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.reviewDecision = "APPROVED";
    });
    const row = (svc: string) => m.template.rows.find((r) => r.service === svc);
    expect(row("schema")?.label).toBe("v1.2.0 +2");
    expect(row("entitlements")?.pr?.number).toBe(48);
    expect(row("entitlements")?.dependabot.map((p) => p.number)).toEqual([52, 54]);
    expect(row("file")?.dependabot).toEqual([]);
    expect(row("legal")?.pr?.reviewDecision).toBe("APPROVED");
  });

  test("a template-sync PR failing on its own counts as failing; one red on the stack does not", () => {
    const m = model((f) => {
      const file = f.github.data?.repos["Azure/osdu-spi-file"]?.prs.find((p) => p.number === 51);
      const deploy = file?.checks.find((c) => c.name === "Deploy and Test");
      const key = `Azure/osdu-spi-file#${deploy?.id}`;
      const detail = f.details.data?.[key];
      if (!detail || !f.details.data) throw new Error("file #51 Deploy and Test");
      f.details.data[key] = { ...detail, failedStep: "Prove", reason: "2 acceptance tests failed" };
    });
    const step = m.template.steps.find((s) => s.label === "v1.2.0 +2");
    expect(step?.failing).toEqual(["file"]);
    expect(step?.waiting).toHaveLength(3);
  });

  test("a ladder step opens an inspector with its changes and where each fork stands", () => {
    const m = model();
    const b = inspectBoard(m, { selected: `step:${NEW_HEAD}` }, FIXTURE_NOW);
    expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "v1.3.0", tone: "info" });
    expect(b.header?.chip).toBe("0 of 5 · no PR carries it yet");
    const changes = b.sections.find((s) => s.kind === "rows" && s.title?.startsWith("Changes"));
    if (changes?.kind !== "rows") throw new Error("changes");
    expect(changes.items[1]?.text).toBe(
      "feat(java): resolve the Java release from the root pom (#255)",
    );
    const forks = b.sections.find((s) => s.kind === "rows" && s.title === "Forks");
    if (forks?.kind !== "rows") throw new Error("forks");
    expect(forks.items.every((i) => i.trailing === "no PR carries it")).toBe(true);
    const gone = inspectBoard(m, { selected: "step:feedface" }, FIXTURE_NOW);
    expect(gone.header?.status?.label).toBe("MOVED");
  });

  test("open PRs on osdu-spi wait in the queue; a draft does not", () => {
    const m = model((f) => {
      const repo = f.github.data?.repos["Azure/osdu-spi"];
      repo?.prs.push(
        { ...dependabotPr("Azure/osdu-spi", 260), reviewDecision: "REVIEW_REQUIRED" },
        {
          ...dependabotPr("Azure/osdu-spi", 261),
          head: "release-please--branches--main",
          author: "osdu-spi-automation",
          title: "chore: release 1.3.1",
        },
        { ...dependabotPr("Azure/osdu-spi", 262), head: "feat/x", author: "someone", draft: true },
      );
    });
    const item = m.queue.items.find((i) => i.id === "template-pr:260");
    expect(item).toMatchObject({
      kind: "template-pr",
      rung: 2,
      scope: "osdu-spi",
      text: "Dependabot PR #260 build(deps): bump spring-boot · review required",
    });
    expect(m.queue.items.some((i) => i.id === "template-pr:262")).toBe(false);
    expect(m.queue.items.find((i) => i.id === "releases")?.text).toContain("osdu-spi v1.3.1");
    const insp = inspectBoard(m, { selected: "template-pr:260" }, FIXTURE_NOW);
    expect(insp.header?.status?.label).toBe("READY");
  });

  test("a red PR on osdu-spi is a P1", () => {
    const m = model((f) => {
      f.github.data?.repos["Azure/osdu-spi"]?.prs.push({
        ...dependabotPr("Azure/osdu-spi", 263),
        checks: [
          { id: 9, name: "Lint", workflow: "CI", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      });
    });
    const item = m.queue.items.find((i) => i.id === "template-pr:263");
    expect(item?.rung).toBe(1);
    expect(item?.text).toEndWith("· fails Lint");
  });
});

describe("main past the latest tag with a release PR open", () => {
  // Four forks on template main (v1.2.0 +14), file behind the tag with PR #51 to main,
  // while the osdu-spi release PR for 1.2.1 is open.
  function ahead() {
    const f = fixtureFacts();
    const repos = f.github.data?.repos;
    const head = repos?.["Azure/osdu-spi"]?.head?.sha;
    const compares = f.template.data?.compares;
    if (!repos || !head || !compares) throw new Error("fixture has the template");
    compares[head] = { marker: head, head, label: "v1.2.0 +14", aheadBy: 0, shas: [], changes: [] };
    compares.old = { marker: "old", head, label: "v1.1.0 +3", aheadBy: 20, shas: [], changes: [] };
    for (const svc of ["partition", "entitlements", "legal", "schema"]) {
      const repo = repos[`Azure/osdu-spi-${svc}`];
      if (!repo) throw new Error(`fixture has ${svc}`);
      repo.marker = head;
      repo.prs = repo.prs.filter((p) => !p.head.startsWith("template-sync/"));
    }
    const file = repos["Azure/osdu-spi-file"];
    if (!file) throw new Error("fixture has file");
    file.marker = "old";
    return buildModel(f, FIXTURE_NOW);
  }

  test("the model and the inspector name main v1.2.0 +14; v1.2.1 is only the release PR's version", () => {
    const m = ahead();
    expect(m.template.next).toBe("v1.2.1");
    const line = (svc: string) => m.lines.find((l) => l.fork.id === svc)?.template;
    expect(line("partition")?.label).toBe("v1.2.0 +14");
    expect(line("file")).toMatchObject({ label: "v1.1.0 +3", target: "v1.2.0 +14" });
    expect(m.template.steps[0]?.label).toBe("v1.2.0 +14");
    const b = inspectSet(m);
    const ladder = b.sections.find(
      (s) => s.kind === "rows" && s.title?.startsWith("Release ladder"),
    );
    if (ladder?.kind !== "rows") throw new Error("ladder");
    expect(ladder.items[0]).toMatchObject({
      chip: { label: "v1.2.0 +14" },
      trailing: expect.stringMatching(/^4 of 5/),
    });
    expect(JSON.stringify(b)).not.toContain("v1.2.1");
  });
});
