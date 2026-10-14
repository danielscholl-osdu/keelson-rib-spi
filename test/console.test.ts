import { describe, expect, test } from "bun:test";
import { CONSOLE_MAX_BYTES, consoleHtml, expectHtml } from "../src/boards/console";
import { doctorStatus } from "../src/boards/doctor";
import { type Briefing, buildBriefing } from "../src/brief/index";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

function briefing(): Briefing {
  const facts = fixtureFacts();
  return buildBriefing(
    buildModel(facts, FIXTURE_NOW),
    doctorStatus(facts, FIXTURE_NOW),
    FIXTURE_NOW,
  );
}

describe("the console frame", () => {
  const b = briefing();
  const html = consoleHtml(b, FIXTURE_NOW);

  test("passes its own validator", () => {
    expect(expectHtml(html)).toBe(html);
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(CONSOLE_MAX_BYTES);
  });

  test("shows the headline, the facts and every focus row", () => {
    expect(html).toContain("Restore the environment. Unhalt entitlements. 1 more cause below.");
    for (const f of b.facts) expect(html).toContain(f.figure);
    for (const f of b.focus) expect(html).toContain(`data-sel="${f.id}"`);
  });

  test("every focus row and ready line opens an inspector item", () => {
    const ids = [...html.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(
      expect.arrayContaining([...b.focus.map((f) => f.id), ...b.ready.map((r) => r.id)]),
    );
  });

  test("the first focus item is selected and the other details stay hidden", () => {
    const shown = [...html.matchAll(/data-detail="([^"]+)"(?! hidden)>/g)].map((m) => m[1]);
    expect(shown).toEqual([b.focus[0]?.id]);
  });

  test("the frame carries no links, since a sandboxed frame cannot open them", () => {
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("text from the forges is escaped", () => {
    const evil = { ...b, headline: '<img src=x onerror="alert(1)">' };
    const out = consoleHtml(evil, FIXTURE_NOW);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("a frame with nothing measured still renders its headline", () => {
    const out = consoleHtml(
      { ...b, headline: "The first sweep has not finished.", summary: "", facts: [], focus: [] },
      FIXTURE_NOW,
    );
    expect(out).toContain("The first sweep has not finished.");
    expect(out).not.toContain('class="facts"');
  });

  test("the validator refuses anything but html under the cap", () => {
    expect(() => expectHtml({ view: "board" })).toThrow();
    expect(() => expectHtml("")).toThrow();
    expect(() => expectHtml("x".repeat(CONSOLE_MAX_BYTES + 1))).toThrow();
  });
});
