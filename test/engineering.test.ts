import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { engineeringBoard } from "../src/boards/engineering";
import { inspectBoard } from "../src/boards/inspect";
import type { Facts, PrFact, TemplateChange } from "../src/facts";
import { ENGINEERING_KEY, INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const NEW_HEAD = "c0de000000000000000000000000000000000130";

function change(n: number, title: string): TemplateChange {
  const sha = `c0de${String(n).padStart(36, "0")}`;
  return {
    sha,
    parent: undefined,
    title,
    pr: 250 + n,
    url: `https://github.com/Azure/osdu-spi/pull/${250 + n}`,
    at: `2026-10-12T1${n}:00:00Z`,
  };
}

// v1.3.0 cut four changes past the head the forks' PRs carry (v1.2.0 +14).
function released(): Facts {
  const f = fixtureFacts();
  const repos = f.github.data?.repos;
  const repo = repos?.["Azure/osdu-spi"];
  const t = f.template.data;
  if (!repos || !repo || !t) throw new Error("template facts");
  const fresh = [
    change(4, "chore(release): release 1.3.0"),
    change(3, "feat(java): resolve the Java release from the root pom (#255)"),
    change(2, "build(deps): bump actions/setup-java from 4 to 5 (#254)"),
    change(1, "fix(maven): pin the Maven version (#247)"),
  ];
  repo.head = { sha: NEW_HEAD, at: "2026-10-12T20:55:00Z" };
  repo.release = {
    tag: "v1.3.0",
    at: "2026-10-12T21:00:00Z",
    url: "https://github.com/Azure/osdu-spi/releases/tag/v1.3.0",
  };
  repo.releases = [
    { tag: "v1.3.0", at: "2026-10-12T21:00:00Z", url: repo.release.url },
    { tag: "v1.2.0", at: "2026-10-05T22:43:47Z", url: "" },
  ];
  repo.pastPrs = [
    {
      number: 248,
      title: "chore: release 1.3.0",
      url: "",
      head: "release-please--branches--main",
      base: "main",
      createdAt: "2026-10-06T00:00:00Z",
      mergedAt: "2026-10-12T20:55:00Z",
    },
    {
      number: 255,
      title: "feat(java): resolve the Java release",
      url: "",
      head: "feat/java",
      base: "main",
      createdAt: "2026-10-12T00:00:00Z",
      mergedAt: "2026-10-12T13:00:00Z",
    },
    {
      number: 254,
      title: "build(deps): bump setup-java",
      url: "",
      head: "dependabot/github_actions/setup-java-5",
      base: "main",
      createdAt: "2026-10-11T00:00:00Z",
      mergedAt: "2026-10-12T12:00:00Z",
      author: "dependabot",
    },
    {
      number: 240,
      title: "older",
      url: "",
      head: "feat/old",
      base: "main",
      createdAt: "2026-10-01T00:00:00Z",
      mergedAt: "2026-10-02T00:00:00Z",
    },
  ];
  repo.prs = [];
  t.latestTag = "v1.3.0";
  t.mainAhead = 0;
  for (const c of Object.values(t.compares)) {
    c.head = NEW_HEAD;
    c.aheadBy += fresh.length;
    c.shas = [...fresh.map((x) => x.sha), ...c.shas];
    c.changes = [...fresh, ...c.changes];
  }
  for (const fork of Object.values(repos)) {
    if (fork.repo.startsWith("Azure/osdu-spi-") && fork.repo !== "Azure/osdu-spi-stack")
      fork.syncCrons = ["0 8 * * *"];
  }
  return f;
}

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

const text = (cell: unknown) =>
  typeof cell === "object" && cell !== null && "value" in cell
    ? String(cell.value).replaceAll(" ", " ")
    : cell;

function model(edit?: (f: Facts) => void) {
  const f = released();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

describe("the engineering system panel", () => {
  test("leads with the release, the rollout and the template's own PRs", () => {
    const b = engineeringBoard(model(), FIXTURE_NOW);
    expect(() => expectView(ENGINEERING_KEY, "board")(b)).not.toThrow();
    expect(b.header?.status).toEqual({ label: "v1.3.0 ON 0 OF 5", tone: "info" });
    const tiles = b.sections[0];
    if (tiles?.kind !== "stats") throw new Error("tiles first");
    expect(tiles.items.map((i) => i.label)).toEqual([
      "Release",
      "Rollout · oldest PR",
      "Template PRs · osdu-spi",
    ]);
    expect(tiles.items[0]).toMatchObject({
      value: "v1.3.0",
      delta: { text: "on 0 of 5 forks", tone: "info" },
      sub: "released 21:00 · main is the release · 8 changes past v1.2.0 +2",
    });
    expect(tiles.items[1]?.clock?.mode).toBe("since");
    expect(tiles.items[1]?.sub).toMatch(
      /^5 PRs carry v1\.2\.0 \+14 · next Sync Template 10-13 \d\d:00 · usually merged in /,
    );
    expect(tiles.items[2]).toMatchObject({
      value: "none open",
      tone: "ok",
      sub: "v1.3.0 took 2 merged PRs · 1 from Dependabot",
    });
  });

  test("the ladder names each step by release and says no PR carries the newest yet", () => {
    const b = engineeringBoard(model(), FIXTURE_NOW);
    const ladder = b.sections[1];
    if (ladder?.kind !== "rows") throw new Error("ladder second");
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

  test("the rollout table reads each fork's PR, checks, review, delivery and Dependabot", () => {
    const m = model((f) => {
      const repos = f.github.data?.repos;
      repos?.["Azure/osdu-spi-entitlements"]?.prs.push(
        dependabotPr("Azure/osdu-spi-entitlements", 52),
        dependabotPr("Azure/osdu-spi-entitlements", 54),
      );
      const legal = repos?.["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.reviewDecision = "APPROVED";
    });
    const b = engineeringBoard(m, FIXTURE_NOW);
    const table = b.sections.find((s) => s.kind === "table");
    if (table?.kind !== "table") throw new Error("rollout table");
    const row = (fork: string) => table.rows.find((r) => text(r.fork) === fork);
    expect(text(row("schema")?.on)).toBe("v1.2.0 +2");
    expect(text(row("entitlements")?.pr)).toBe("#48 → v1.2.0 +14");
    expect(text(row("entitlements")?.checks)).toBe("⊘ red on the stack");
    expect(text(row("entitlements")?.review)).toBe("required");
    expect(text(row("legal")?.review)).toBe("approved");
    expect(row("entitlements")?.dependabot).toMatchObject({ value: "2\u00a0open", tone: "info" });
    expect(row("file")?.dependabot).toMatchObject({ tone: "ok" });
    expect(text(row("file")?.sync)).toMatch(/^● \d\d:\d\d$/);
    const review = b.sections.at(-1);
    if (review?.kind !== "rows") throw new Error("review link last");
    expect(review.items[0]?.text).toBe("Review on GitHub · 5 template-sync PRs in one list");
    expect(review.items[0]?.href).toContain("label%3Atemplate-sync");
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
    const b = engineeringBoard(m, FIXTURE_NOW);
    expect(b.header?.status).toEqual({ label: "v1.3.0 ON 0 OF 5 · 1 FAILING", tone: "warn" });
    const table = b.sections.find((s) => s.kind === "table");
    if (table?.kind !== "table") throw new Error("rollout table");
    const file = table.rows.find((r) => text(r.fork) === "file");
    expect(file?.checks).toMatchObject({ tone: "warn" });
    expect(text(file?.checks)).toBe("✕ TEST Deploy and Test");
    expect(file?.pr).toMatchObject({ tone: "warn" });
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

  test("open PRs on osdu-spi itself show with their verdicts", () => {
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
      );
    });
    expect(m.template.prs.map((p) => p.cls)).toEqual(["dependabot", "release"]);
    const tiles = engineeringBoard(m, FIXTURE_NOW).sections[0];
    if (tiles?.kind !== "stats") throw new Error("tiles");
    expect(tiles.items[2]).toMatchObject({ value: "2 open", tone: "info" });
    expect(tiles.items[2]?.sub).toStartWith("release PR #261 · 1 from Dependabot · 1 need review");
  });
});
