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

  test("a tab strip switches between Today, the default, and Horizon", () => {
    expect(html).toContain('data-view="today" aria-selected="true"');
    expect(html).toContain('data-view="horizon" aria-selected="false"');
    expect(html).toContain('<div data-view-pane="horizon" hidden>');
    expect(html).toContain("saveState({ view: state.view, sel: state.sel, theme: state.theme })");
  });

  describe("the Horizon view", () => {
    const horizon = html.slice(html.indexOf('data-view-pane="horizon"'), html.indexOf("<script>"));

    test("leads with the horizon headline and renders every theme with the first selected", () => {
      expect(horizon).toContain(`<h2>${b.horizon.headline}</h2>`);
      for (const t of b.themes) {
        expect(horizon).toContain(`data-theme-sel="${t.id}"`);
        expect(horizon).toContain(`data-theme-detail="${t.id}"`);
      }
      const shown = [...horizon.matchAll(/data-theme-detail="([^"]+)"(?! hidden)>/g)].map(
        (m) => m[1],
      );
      expect(shown).toEqual([b.themes[0]?.id]);
    });

    test("every inspector button opens a queue item", () => {
      const queue = new Set(buildModel(fixtureFacts(), FIXTURE_NOW).queue.items.map((i) => i.id));
      const ids = [...horizon.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBe(b.themes.filter((t) => t.inspect).length);
      for (const id of ids) expect(queue.has(id as string)).toBe(true);
    });

    test("theme text from the forges is escaped", () => {
      const theme = b.themes[0]!;
      const evil: Briefing = {
        ...b,
        themes: [{ ...theme, title: "<b>x</b>", certain: [{ fork: '"><i>', state: "&" }] }],
      };
      const out = consoleHtml(evil, FIXTURE_NOW);
      expect(out).not.toContain("<b>x</b>");
      expect(out).not.toContain('"><i>');
      expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    });
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
