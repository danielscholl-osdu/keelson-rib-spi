import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectHtml } from "../src/boards/console";
import {
  RELEASE_OPEN_ACTION,
  RELEASE_PDF_ACTION,
  releaseBoard,
  releaseDocHtml,
  releasePrintHtml,
} from "../src/boards/release";
import { releaseDoc } from "../src/brief/release";
import type { ReleaseReads } from "../src/collect/releases";
import { javaOf, pinPoms } from "../src/collect/releases";
import rib from "../src/index";
import { CONSOLE_KEY, INSPECT_KEY, RELEASE_KEY } from "../src/keys";
import { monthFacts, parseBody, releaseMonths } from "../src/model/releases";
import { createNotes, type NotesRead, readNotes, skeleton } from "../src/notes/file";
import { pdfName } from "../src/notes/pdf";
import fixture from "./fixtures/releases.json";
import { fakeContext, fixtureFacts } from "./harness";

const NOW = new Date("2026-10-21T15:00:00Z");

function reads(): ReleaseReads {
  return structuredClone(fixture) as ReleaseReads;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rib-spi-notes-"));
}

afterEach(async () => {
  await rib.dispose?.();
});

describe("release bodies", () => {
  test("typed by section, with links, PR numbers and automation noise dropped", () => {
    const lines = parseBody(`## [1.3.3](https://x/compare/v1.3.2...v1.3.3) (2026-10-20)
### ⚠ BREAKING CHANGES
* build on Java 25 (#5)
### ✨ Features
* **sizing:** Write spi-sizing from resources ([abc1234](https://x/commit/abc1234))
* Upgrade the gateway to Istio
* Sync upstream changes from a2c4f7b7
### 🐛 Bug Fixes
* **deps:** Bump virtualenv to 21.14.5 to clear advisories (#361)
* **deps:** Bump jackson to 2.21.7
* [Venus] CI-friendly Maven versions
* CVE remediation wave 1 (tomcat, jackson-databind)
### 🔧 Miscellaneous
* Remove Azure provider`);
    expect(lines).toEqual([
      { type: "breaking", text: "build on Java 25", dep: false },
      { type: "new", text: "Write spi-sizing from resources", dep: false, scope: "sizing" },
      { type: "improved", text: "Upgrade the gateway to Istio", dep: false },
      {
        type: "security",
        text: "Bump virtualenv to 21.14.5 to clear advisories",
        dep: true,
        scope: "deps",
      },
      { type: "fixed", text: "Bump jackson to 2.21.7", dep: true, scope: "deps" },
      { type: "fixed", text: "CI-friendly Maven versions", dep: false },
      { type: "security", text: "CVE remediation wave 1 (tomcat, jackson-databind)", dep: false },
    ]);
  });

  test("poms: Java from the first property set, test modules never pin the library", () => {
    expect(javaOf("<java.version>25</java.version>")).toBe("25");
    expect(javaOf("<maven.compiler.target>1.8</maven.compiler.target>")).toBe("8");
    expect(javaOf("<project/>")).toBeNull();
    expect(
      pinPoms([
        "pom.xml",
        "provider/unit-azure/unit-aks/pom.xml",
        "indexer-queue-azure-enqueue/pom.xml",
        "testing/indexer-queue-azure-enqueue/pom.xml",
        "unit-core/pom.xml",
      ]),
    ).toEqual(["provider/unit-azure/unit-aks/pom.xml", "indexer-queue-azure-enqueue/pom.xml"]);
  });
});

describe("a calendar month from the recorded release read", () => {
  test("October: versions move from the last release before the month to the last inside it", () => {
    const f = monthFacts(reads(), "2026-10", NOW);
    expect(f.open).toBe(true);
    expect(f.through).toBe("Oct 1 to 21");
    // The suite runs on the five forks the recorded sweep watched.
    expect(f.releases).toBe(37);
    expect(f.released).toBe(8);
    const by = Object.fromEntries(f.components.map((c) => [c.id, c]));
    expect([by.partition?.from, by.partition?.to, by.partition?.count]).toEqual([
      "v1.3.0",
      "v1.3.3",
      3,
    ]);
    expect(by.entitlements?.from).toBeUndefined();
    expect(by.entitlements?.pins).toEqual({ lib: "3.0.3", java: "25" });
    expect(f.services.forkedNow).toEqual([]);
    expect(monthFacts(reads(), "2026-09", NOW).services.forkedNow).toEqual([
      "entitlements",
      "legal",
      "schema",
      "file",
    ]);
    expect(f.stack).toBe("v0.30.2");
  });

  test("a fork's first release is one line, not the template history it inherits", () => {
    const f = monthFacts(reads(), "2026-10", NOW);
    const legal = f.changes.filter((c) => c.component === "legal");
    expect(legal[0]?.text).toBe("legal forked and released as v1.2.0");
    expect(legal.slice(1).map((c) => c.tag)).toEqual(["v1.2.1", "v1.2.1"]);
    expect(f.changes.some((c) => c.component === "core-lib-azure" && c.type === "breaking")).toBe(
      true,
    );
  });

  test("months run newest first and always include the month in progress", () => {
    const months = releaseMonths(reads(), new Date("2026-12-02T00:00:00Z"));
    expect(months[0]).toBe("2026-12");
    expect(months).toContain("2026-09");
  });

  test("a closed month reads its whole window", () => {
    const f = monthFacts(reads(), "2026-09", NOW);
    expect(f.open).toBe(false);
    expect(f.through).toBe("Sep 1 to 30");
    expect(f.components.find((c) => c.id === "core-lib-azure")).toBeUndefined();
  });
});

describe("the document", () => {
  test("without notes it is a draft from computed facts, breaking changes ask for review", () => {
    const doc = releaseDoc(monthFacts(reads(), "2026-10", NOW), undefined, NOW);
    expect(doc.notes).toBe("none");
    expect(doc.headline).toBe("37 releases across 8 repositories in October 2026.");
    expect(doc.required.every((a) => a.level === "recommended")).toBe(true);
    expect(doc.required.length).toBeGreaterThan(0);
    const engineering = doc.changelog.find((a) => a.area === "Engineering system");
    expect(engineering?.items).toHaveLength(1);
    expect(engineering?.items[0]?.text).toContain("to fork automation");
  });

  test("an unread pin is ?, never a version", () => {
    const r = reads();
    for (const k of Object.keys(r.pins)) if (k.startsWith("Azure/osdu-spi-file@")) delete r.pins[k];
    const doc = releaseDoc(monthFacts(r, "2026-10", NOW), undefined, NOW);
    expect(doc.rows.find((x) => x.id === "file")?.lib).toBeNull();
    expect(releaseDocHtml(doc)).toContain('<td class="m">?</td>');
  });

  test("approved notes lead, replace the changelog and drop the draft banner", () => {
    const read: NotesRead = {
      state: "ok",
      path: "/x/2026-10.json",
      notes: {
        ...skeleton(),
        status: "approved",
        headline: "All 13 services <now> ship from SPI forks.",
        actions: [{ level: "required", title: "Move unit off 2.5.10", owner: "unit fork" }],
        knownIssues: [{ state: "open", title: "Stray upstream tags." }],
        highlights: [{ title: "Coverage", visual: "coverage" }],
        changelog: [{ area: "Services", items: [{ type: "new", text: "Eight forks" }] }],
      },
    };
    const doc = releaseDoc(monthFacts(reads(), "2026-10", NOW), read, NOW);
    expect(doc.stats.map((s) => s.figure)).toEqual(["5/5", "37", "1", "1"]);
    expect(doc.computedChangelog).toBe(false);
    const visual = doc.highlights[0]?.visual;
    expect(visual?.kind === "coverage" ? visual.tiles.length : 0).toBe(5);
    const html = releasePrintHtml(doc);
    expect(html).toContain('data-theme="light"');
    expect(html).toContain("&lt;now&gt;");
    expect(html).not.toContain('class="draft"');
    expect(releasePrintHtml({ ...doc, notes: "draft" })).toContain('class="draft"');
    expect(expectHtml(releaseDocHtml(doc))).toBeString();
    // The sandboxed drawer cannot follow links; only the PDF carries them.
    expect(releaseDocHtml(doc)).not.toContain("<a ");
    expect(html).toContain('<a href="https://github.com/Azure/osdu-spi-stack/releases">');
    expect(html).toContain('<a href="https://github.com/Azure/osdu-spi-stack/releases/tag/');
    expect(html).toContain('content: "Page " counter(page) " of " counter(pages)');
    expect(html).toContain('@top-right { content: "2026.10 · APPROVED"');
    expect(html).not.toContain("Version summary");
    expect(releaseDocHtml(doc)).toContain("Version summary");
  });

  test("without a notes file, actions and known issues are unreviewed, not zero", () => {
    const doc = releaseDoc(monthFacts(reads(), "2026-10", NOW), undefined, NOW);
    expect(doc.stats.slice(2).map((s) => s.figure)).toEqual(["?", "?"]);
    expect(doc.stats[3]?.label).toBe("known issues not reviewed yet");
    expect(releaseDocHtml(doc)).not.toContain("No action required.");
    const sept = releaseDoc(monthFacts(reads(), "2026-09", NOW), undefined, NOW);
    const unreleased = sept.rows.find((r) => r.state === "unreleased");
    expect(unreleased?.lib).toBeUndefined();
    expect(doc.rows.filter((r) => r.group === "Platform").map((r) => r.id)).toEqual([
      "spi-template",
      "spi-stack",
      "core-lib-azure",
    ]);
  });

  test("the inspector carries read, PDF and create, and drops the PDF when no browser exists", () => {
    const doc = releaseDoc(monthFacts(reads(), "2026-10", NOW), undefined, NOW);
    const base = { doc, notesPath: "/x/2026-10.json", notesExists: false, errors: [] };
    const labels = (b: ReturnType<typeof releaseBoard>) =>
      b.sections
        .flatMap((s) => (s.kind === "cards" ? s.items.flatMap((c) => c.actions ?? []) : []))
        .map((a) => a.label);
    expect(labels(releaseBoard({ ...base, pdfReady: true }))).toEqual([
      "Read release notes",
      "Download PDF",
      "Create notes file",
    ]);
    expect(labels(releaseBoard({ ...base, pdfReady: false, notesExists: true }))).toEqual([
      "Read release notes",
    ]);
    expect(pdfName("2026.10", false)).toBe("SPI Release Notes 2026.10 (draft).pdf");
  });
});

describe("the notes file", () => {
  test("missing, then created once and never overwritten", () => {
    const dir = tmp();
    expect(readNotes(dir, "2026-10").state).toBe("missing");
    expect(createNotes(dir, "2026-10").created).toBe(true);
    const path = join(dir, "2026-10.json");
    writeFileSync(path, JSON.stringify({ ...skeleton(), headline: "kept" }));
    expect(createNotes(dir, "2026-10").created).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).headline).toBe("kept");
    const read = readNotes(dir, "2026-10");
    expect(read.state === "ok" ? read.notes.headline : undefined).toBe("kept");
  });

  test("a file that does not parse says where", () => {
    const dir = tmp();
    writeFileSync(join(dir, "2026-10.json"), JSON.stringify({ status: "shipped" }));
    const read = readNotes(dir, "2026-10");
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" ? read.error : "").toStartWith("status:");
    writeFileSync(join(dir, "2026-09.json"), "{");
    expect(readNotes(dir, "2026-09").state).toBe("invalid");
  });
});

describe("the rib", () => {
  function stored() {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-"));
    writeFileSync(join(dir, "releases.json"), JSON.stringify(fixture));
    writeFileSync(join(dir, "facts.json"), JSON.stringify(fixtureFacts()));
    return fakeContext({ getDataDir: () => dir });
  }

  test("a month opens its inspector, and Read opens the document in the drawer", async () => {
    const { ctx, snapshots } = stored();
    rib.registerTools?.(ctx);
    const res = await rib.onAction?.({ type: "inspect", payload: { id: "release:2026-10" } }, ctx);
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: INSPECT_KEY,
        title: "SPI 2026.10 release notes",
        placement: "side",
      },
    });
    const open = await rib.onAction?.(
      { type: RELEASE_OPEN_ACTION, origin: "board", payload: { month: "2026-10" } },
      ctx,
    );
    expect(open?.ok && (open.data as { key: string }).key).toBe(RELEASE_KEY);
    expect(String(snapshots.latest(RELEASE_KEY)?.data)).toContain("SPI 2026.10");
    await snapshots.recompose(CONSOLE_KEY);
    const console = String(snapshots.latest(CONSOLE_KEY)?.data ?? "");
    expect(console).toContain('data-view="releases"');
    expect(console).toContain('data-inspect="release:2026-10"');
  });

  test("the console frame cannot export, and a bad month is refused", async () => {
    const { ctx } = stored();
    rib.registerTools?.(ctx);
    const frame = await rib.onAction?.(
      { type: RELEASE_PDF_ACTION, origin: "canvas-html", payload: { month: "2026-10" } },
      ctx,
    );
    expect(frame?.ok).toBe(false);
    const bad = await rib.onAction?.(
      { type: RELEASE_PDF_ACTION, origin: "board", payload: { month: "2026-13" } },
      ctx,
    );
    expect(bad).toEqual({ ok: false, error: "release actions need { month: 'YYYY-MM' }" });
  });
});
