import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { consoleHtml } from "../src/boards/console";
import { inspectBoard } from "../src/boards/inspect";
import { repoBoard } from "../src/boards/repo";
import { buildBriefing } from "../src/brief/index";
import { repositoriesOf } from "../src/brief/repos";
import type { DependencyAlertFact, Facts, PrFact } from "../src/facts";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { nextText } from "../src/model/next";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const CRITICAL: DependencyAlertFact = {
  number: 900,
  severity: "critical",
  package: "org.asynchttpclient:async-http-client",
  ecosystem: "maven",
  manifest: "provider/partition-azure/pom.xml",
  scope: "runtime",
  advisory: "GHSA-0000-0000-0001",
  summary: "async-http-client leaks credentials on redirect",
  url: "https://github.com/Azure/osdu-spi-partition/security/dependabot/900",
  createdAt: "2026-10-01T00:00:00Z",
};

function model(edit?: (f: Facts) => void) {
  const f = fixtureFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

function withCritical(f: Facts) {
  f.security.data?.["Azure/osdu-spi-partition"]?.dependabot?.push(CRITICAL);
}

function openPr(number: number, title: string, extra: Partial<PrFact> = {}): PrFact {
  return {
    repo: "Azure/osdu-spi-partition",
    number,
    title,
    url: `https://github.com/Azure/osdu-spi-partition/pull/${number}`,
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

function withPrs(f: Facts) {
  withCritical(f);
  f.github.data?.repos["Azure/osdu-spi-partition"]?.prs.push(
    openPr(70, "chore(spi): add service descriptor for partition"),
    openPr(
      71,
      "Bump org.asynchttpclient:async-http-client from 2.16.0 to 2.16.1 in /provider/partition-azure",
      { author: "dependabot", head: "dependabot/maven/ahc" },
    ),
  );
}

describe("the Repositories briefing", () => {
  test("leads with the absence of severe alerts in our shipped code when there are none", () => {
    const r = repositoriesOf(model(), FIXTURE_NOW);
    expect(r.facts.map((f) => f.label)).toEqual([
      "Issues",
      "Pull Requests",
      "Dependabot Bumps",
      "Vulnerabilities · ours",
      "Code scanning · ours",
    ]);
    expect(r.rows.map((x) => x.id)).toContain("repo:partition");
    const partition = r.rows.find((x) => x.name === "partition");
    expect(partition?.cells.vulnerabilities).toMatchObject({ text: "0", rest: " · 3", fade: true });
    expect(partition?.sections.map((s) => s.title)).toEqual(["Vulnerabilities", "Code scanning"]);
    expect(partition?.sections[0]).toMatchObject({ count: "0 ours", rest: " · 1 upstream" });
  });

  test("a critical alert in our shipped code leads the tab and opens first", () => {
    const r = repositoriesOf(model(withCritical), FIXTURE_NOW);
    expect(r.headline).toBe(
      "Critical vulnerability in async-http-client, in SPI code on partition; no fix is published.",
    );
    expect(r.first).toBe("repo:partition");
    const partition = r.rows.find((x) => x.name === "partition");
    expect(partition?.title).toBe("Critical vulnerability in async-http-client");
    expect(partition?.cells.vulnerabilities).toEqual({
      text: "1",
      tone: "bad",
      rest: " · 3",
      fade: true,
    });
    expect(r.facts[3]).toMatchObject({ figure: "4", tone: "bad" });
    expect(r.facts[4]?.label).toBe("Code scanning · ours");
  });

  test("an unread alert area reads as unknown, never as zero", () => {
    const r = repositoriesOf(
      model((f) => {
        f.security = {};
      }),
      FIXTURE_NOW,
    );
    expect(r.facts[3]).toMatchObject({ figure: "?", sub: "not read yet" });
    expect(r.facts[4]).toMatchObject({ figure: "?", sub: "not read yet" });
    expect(r.rows[0]?.cells.vulnerabilities.text).toBe("?");
  });
});

describe("the Repositories tab", () => {
  const b = buildBriefing(model(withCritical), { state: "clear", problems: [] }, FIXTURE_NOW);
  const html = consoleHtml(b, FIXTURE_NOW);
  const pane = html.slice(
    html.indexOf('data-view-pane="repositories"'),
    html.indexOf('data-view-pane="environment"'),
  );

  test("lists the program, then the forks, one selectable row each", () => {
    const rows = [...pane.matchAll(/data-repo="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(b.repositories.rows.map((r) => r.id));
    expect(pane.indexOf(">Program<")).toBeLessThan(pane.indexOf(">Forks<"));
    expect(pane).toContain('data-repo="repo:partition" aria-pressed="true"');
  });

  test("shows one detail at a time, and only the button opens the inspector", () => {
    const shown = [...pane.matchAll(/data-repo-detail="([^"]+)"(?! hidden)>/g)].map((m) => m[1]);
    expect(shown).toEqual(["repo:partition"]);
    const opens = [...pane.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1]);
    expect(opens).toEqual(b.repositories.rows.map((r) => r.id));
  });
});

describe("a repository's detail", () => {
  test("open PRs lead and the alerts follow, below the work", () => {
    const partition = repositoriesOf(model(withPrs), FIXTURE_NOW).rows.find(
      (x) => x.name === "partition",
    );
    expect(partition?.title).toBe("1 pull request waiting on review");
    expect(partition?.sub).toContain("1 Dependabot bump open; #71 closes 1 vulnerability.");
    expect(partition?.sections.map((s) => s.title)).toEqual([
      "Pull Requests",
      "Dependabot Bumps",
      "Vulnerabilities",
      "Code scanning",
    ]);
    expect(partition?.sections.find((s) => s.title === "Dependabot Bumps")?.weight).toBe("minor");
    expect(partition?.sections.filter((s) => s.weight === "quiet").map((s) => s.title)).toEqual([
      "Vulnerabilities",
      "Code scanning",
    ]);
  });

  test("a Dependabot PR leads when no change PR is open", () => {
    const partition = repositoriesOf(
      model((f) => {
        withPrs(f);
        const prs = f.github.data?.repos["Azure/osdu-spi-partition"]?.prs;
        if (prs)
          prs.splice(
            prs.findIndex((p) => p.number === 70),
            1,
          );
      }),
      FIXTURE_NOW,
    ).rows.find((x) => x.name === "partition");
    expect(partition?.title).toBe("1 Dependabot bump open");
    expect(partition?.sub).toBe(
      "#71 bumps async-http-client 2.16.0 to 2.16.1 and closes 1 vulnerability; needs review.",
    );
  });

  test("alerts sit in a quieter block where upstream lines fade and ours do not", () => {
    const b = buildBriefing(model(withPrs), { state: "clear", problems: [] }, FIXTURE_NOW);
    const html = consoleHtml(b, FIXTURE_NOW);
    const detail = html.slice(
      html.indexOf('data-repo-detail="repo:partition"'),
      html.indexOf("</section>", html.indexOf('data-repo-detail="repo:partition"')),
    );
    const quiet = detail.slice(detail.indexOf('<div class="rquiet">'));
    expect(detail.indexOf("Pull Requests")).toBeLessThan(detail.indexOf('<div class="rquiet">'));
    expect(quiet).toMatch(/<div class="rl"><span class="tag t-bad">Critical<\/span>/);
    expect(quiet).toMatch(/<div class="rl up"><span class="tag [^"]*">High<\/span>/);
  });
});

describe("human-required issues", () => {
  const r = repositoriesOf(model(), FIXTURE_NOW);
  const entitlements = r.rows.find((x) => x.name === "entitlements");

  test("split out in the Issues cell, the tile, and lead the detail", () => {
    expect(entitlements?.cells.issues).toMatchObject({
      text: "1",
      tone: "bad",
      rest: " · 0",
      fade: true,
    });
    expect(r.facts[0]).toMatchObject({ label: "Issues", tone: "bad" });
    expect(r.facts[0]?.sub).toStartWith("2 human-required");
    expect(entitlements?.title).toBe("1 issue needs a person");
    expect(entitlements?.sections[0]).toMatchObject({
      title: "Issues",
      count: "1 human-required",
      rest: " · 0 other",
    });
    expect(entitlements?.sections[0]?.lines[0]).toMatchObject({
      tag: "human-required",
      tone: "bad",
    });
  });

  test("come first in the inspector's Issues tab", () => {
    const board = repoBoard(model(), "repo:entitlements", FIXTURE_NOW);
    const tabs = board.sections.find((s) => s.kind === "tabs");
    const issues = tabs?.kind === "tabs" ? tabs.tabs[0] : undefined;
    const list = issues?.sections[0];
    expect(issues?.label).toBe("Issues");
    expect(list?.kind === "rows" && list.items[0]?.chip).toEqual({
      label: "human-required",
      tone: "error",
    });
  });

  test("the table leads with Issues and fades upstream figures", () => {
    const b = buildBriefing(model(), { state: "clear", problems: [] }, FIXTURE_NOW);
    const html = consoleHtml(b, FIXTURE_NOW);
    expect(html).toContain(
      '<span>Repository</span><span>Issues<small>human<span class="rup"> · other</span></small></span><span>Pull Requests</span><span>Dependabot Bumps</span>',
    );
    expect(html).toMatch(
      /<span class="rc"><span class="z">0<\/span><span class="rup"> · 3<\/span><\/span>/,
    );
  });
});

describe("the repository inspector", () => {
  test("draws vulnerabilities and code scanning apart from PRs and issues", () => {
    const board = repoBoard(model(withCritical), "repo:partition", FIXTURE_NOW);
    expect(() => expectView(INSPECT_KEY, "board")(board)).not.toThrow();
    expect(board.title).toBe("Critical vulnerability in async-http-client");
    const tabs = board.sections.find((s) => s.kind === "tabs");
    expect(tabs?.kind === "tabs" && tabs.tabs.map((t) => t.label)).toEqual([
      "Issues",
      "PRs",
      "Vulnerabilities",
      "Code scanning",
    ]);
  });

  test("a list GitHub hides says so instead of drawing nothing", () => {
    const board = repoBoard(
      model((f) => {
        const a = f.security.data?.["Azure/osdu-spi-legal"];
        if (a) delete a.code;
      }),
      "repo:legal",
      FIXTURE_NOW,
    );
    expect(JSON.stringify(board)).toContain("Code-scanning alerts are not readable");
  });
});

describe("the Today rule", () => {
  test("only a critical alert in our shipped code joins the queue", () => {
    expect(model().queue.items.some((i) => i.kind === "security")).toBe(false);
    const item = model(withCritical).queue.items.find((i) => i.kind === "security");
    expect(item).toMatchObject({ rung: 1, cls: "SECURITY", scope: "partition", incident: false });
    expect(item && nextText(item)).toBe(
      "No fixed release is published; replace the dependency or record the accepted risk",
    );
    const m = model(withCritical);
    const board = inspectBoard(m, { selected: item?.id }, FIXTURE_NOW);
    expect(() => expectView(INSPECT_KEY, "board")(board)).not.toThrow();
    const b = buildBriefing(m, { state: "clear", problems: [] }, FIXTURE_NOW);
    const focus = [...b.focus, ...b.rest].find((f) => f.id === item?.id);
    expect(focus?.title).toBe("Critical vulnerability in async-http-client");
    expect(focus?.cause).toBe(
      "1 open vulnerability in async-http-client in SPI-owned shipped code; no fixed release is published.",
    );
    const upstream = model((f) => {
      f.security.data?.["Azure/osdu-spi-partition"]?.dependabot?.push({
        ...CRITICAL,
        manifest: "partition-core/pom.xml",
      });
    });
    expect(upstream.queue.items.some((i) => i.kind === "security")).toBe(false);
  });
});
