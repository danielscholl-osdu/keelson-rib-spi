import { describe, expect, test } from "bun:test";
import { CONSOLE_MAX_BYTES, consoleHtml, expectHtml } from "../src/boards/console";
import { DOCTOR_ID, doctorStatus } from "../src/boards/doctor";
import { MR_PREFIX, mrTitle } from "../src/boards/radar";
import { type Briefing, buildBriefing } from "../src/brief/index";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

function paneOf(html: string, view: string): string {
  const start = html.indexOf(`data-view-pane="${view}"`);
  const next = html.indexOf("<div data-view-pane=", start + 1);
  return html.slice(start, next === -1 ? html.indexOf("<script>", start) : next);
}

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

  test("the sweep stamp sits at the end of the tab strip and opens the doctor", () => {
    expect(html).toMatch(
      new RegExp(
        `<span class="stamp">(?:<button type="button" class="link alert" data-inspect="${DOCTOR_ID}">[^<]+</button> · )?<button type="button" class="link quiet" data-inspect="${DOCTOR_ID}">swept [^<]+</button>(?: · next sync [^<]+)?</span></div>`,
      ),
    );
    expect(html).not.toContain("every source read");
  });

  test("a clear read adds no words, a short one says what is unread", () => {
    const clear = consoleHtml({ ...b, doctor: { ...b.doctor, state: "clear" } }, FIXTURE_NOW);
    expect(clear).not.toContain('class="link alert"');
    const dark = consoleHtml({ ...b, doctor: { ...b.doctor, state: "dark" } }, FIXTURE_NOW);
    expect(dark).toContain(`class="link alert" data-inspect="${DOCTOR_ID}">GitHub unread</button>`);
  });

  test("focus past the cap folds into a details list whose rows still select a detail", () => {
    const rest = b.focus.slice(0, 2).map((f) => ({ ...f, id: `${f.id}:more` }));
    const out = consoleHtml({ ...b, more: rest.length, rest }, FIXTURE_NOW);
    const more = out.slice(out.indexOf('<details class="more">'), out.indexOf("</details>"));
    expect(more).toStartWith('<details class="more"><summary>2 more in the queue</summary>');
    for (const f of rest) {
      expect(more).toContain(`data-sel="${f.id}" aria-pressed="false"`);
      expect(out).toContain(`data-detail="${f.id}" hidden>`);
      expect(out).toContain(`data-inspect="${f.id}"`);
    }
    expect(html).not.toContain('<details class="more">');
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

  test("a tab strip switches between Today, the default, Repositories, Environment, Flow and Horizon", () => {
    const tabs = [...html.matchAll(/data-view="([^"]+)" aria-selected="([^"]+)"/g)];
    expect(tabs.map((m) => [m[1], m[2]])).toEqual([
      ["today", "true"],
      ["repositories", "false"],
      ["environment", "false"],
      ["flow", "false"],
      ["horizon", "false"],
    ]);
    expect(html).toContain('<div data-view-pane="flow" hidden>');
    expect(html).toContain('<div data-view-pane="horizon" hidden>');
    expect(html).toContain('<div data-view-pane="environment" hidden>');
    expect(html).toContain(
      "saveState({ view: state.view, sel: state.sel, theme: state.theme, cell: state.cell, event: state.event, repo: state.repo, rel: state.rel })",
    );
    expect(html).toContain('["event", "data-event", "data-event-detail", "aria-pressed"]');
  });

  describe("the Flow view", () => {
    const flow = paneOf(html, "flow");

    test("leads with the flow headline and the environment row once", () => {
      expect(flow).toContain(`<h2>${b.flow.headline}</h2>`);
      expect(flow.split(b.flow.environment.text)).toHaveLength(2);
    });

    test("a banded column renders once, as a band, and never as a matrix column", () => {
      const head = flow.slice(flow.indexOf("<thead>"), flow.indexOf("</thead>"));
      expect(b.flow.bands.length).toBeGreaterThan(0);
      for (const band of b.flow.bands) {
        expect(head).not.toContain(`<th>${band.column}</th>`);
        const row = `<th scope="row">${band.column}</th><td colspan="${b.flow.columns.length}">${band.text}</td>`;
        expect(flow.split(row)).toHaveLength(2);
      }
      for (const r of b.flow.rows) {
        for (const band of b.flow.bands) {
          expect(flow).not.toContain(`data-cell="${r.fork}:${band.column.toLowerCase()}"`);
        }
      }
    });

    test("every inspector button opens a queue item", () => {
      const queue = new Set(buildModel(fixtureFacts(), FIXTURE_NOW).queue.items.map((i) => i.id));
      const ids = [...flow.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(queue.has(id as string)).toBe(true);
    });

    test("the fold row names every folded fork", () => {
      const fold = flow.slice(flow.indexOf('class="fold"'));
      for (const fork of b.flow.fold?.forks ?? []) expect(fold).toContain(fork);
      expect(fold).toContain(b.flow.fold?.text ?? "?");
    });

    test("every shown cell selects a detail, the first stopped one by default", () => {
      for (const r of b.flow.rows) {
        for (const c of r.cells) {
          expect(flow).toContain(`data-cell="${r.fork}:${c.id}"`);
          expect(flow).toContain(`data-cell-detail="${r.fork}:${c.id}"`);
        }
      }
      const shown = [...flow.matchAll(/data-cell-detail="([^"]+)"(?! hidden)>/g)].map((m) => m[1]);
      expect(shown).toEqual(["entitlements:sync"]);
    });

    test("flow text from the forges is escaped", () => {
      const row = b.flow.rows[0]!;
      const evil: Briefing = {
        ...b,
        flow: {
          ...b.flow,
          rows: [{ ...row, fork: '"><i>', items: ["<b>x</b>"] }],
          fold: { forks: ["<s>"], text: "&" },
        },
      };
      const out = consoleHtml(evil, FIXTURE_NOW);
      expect(out).not.toContain('"><i>');
      expect(out).not.toContain("<b>x</b>");
      expect(out).not.toContain("<s>");
      expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    });
  });

  describe("the Horizon view", () => {
    const horizon = paneOf(html, "horizon");

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

    test("every theme button opens a queue item and every possible fork's button an MR", () => {
      const model = buildModel(fixtureFacts(), FIXTURE_NOW);
      const queue = new Set(model.queue.items.map((i) => i.id));
      const ids = [...horizon.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1] as string);
      const mrs = ids.filter((id) => id.startsWith(MR_PREFIX));
      const items = ids.filter((id) => !id.startsWith(MR_PREFIX));
      expect(items.length).toBe(b.themes.filter((t) => t.inspect).length);
      for (const id of items) expect(queue.has(id)).toBe(true);
      expect(mrs.length).toBeGreaterThan(0);
      expect(mrs).toEqual(b.themes.flatMap((t) => t.possible.flatMap((f) => f.inspect ?? [])));
      for (const id of mrs) expect(mrTitle(model, id)).toBeDefined();
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

  describe("the Environment view", () => {
    const env = paneOf(html, "environment");

    test("leads with the environment headline and its three facts", () => {
      expect(env).toContain(`<h2>${b.environment.headline}</h2>`);
      expect(b.environment.facts).toHaveLength(3);
      for (const f of b.environment.facts) {
        expect(env).toContain(`<div class="k">${f.label}</div><div class="v">${f.figure}</div>`);
      }
    });

    test("every lane renders a row and every event a bar with a visible label and a detail", () => {
      for (const lane of b.environment.lanes) {
        expect(env).toContain(`<div class="tl-lab">${lane.label}</div>`);
        for (const e of lane.events) {
          const key = `${lane.id}:${e.id}`;
          const bar = new RegExp(
            `data-event="${key}"[^>]*title="[^"]+"[^>]*><span class="evl[^"]*">[^<]+</span>`,
          );
          expect(env).toMatch(bar);
          expect(env).toContain(`data-event-detail="${key}"`);
        }
      }
    });

    test("every bar sits inside the window", () => {
      const bars = [...env.matchAll(/style="left:([\d.]+)%;width:([\d.]+)%;/g)];
      const count = b.environment.lanes.reduce((n, l) => n + l.events.length, 0);
      expect(bars).toHaveLength(count);
      for (const m of bars) {
        const left = Number(m[1]);
        const width = Number(m[2]);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(width).toBeGreaterThanOrEqual(0);
        expect(left + width).toBeLessThanOrEqual(100.01);
      }
    });

    test("the newest failed event is selected by default", () => {
      const shown = [...env.matchAll(/data-event-detail="([^"]+)"(?! hidden)>/g)].map((m) => m[1]);
      expect(shown).toEqual(["refresh:38203142060"]);
      expect(env).toContain('data-event="refresh:38203142060" aria-pressed="true"');
    });

    test("every inspector button opens a queue item", () => {
      const queue = new Set(buildModel(fixtureFacts(), FIXTURE_NOW).queue.items.map((i) => i.id));
      const ids = [...env.matchAll(/data-inspect="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(queue.has(id as string)).toBe(true);
    });

    test("the hour axis prints local clock times", () => {
      expect(env).toMatch(/class="tl-hour" style="left:[\d.]+%">\d\d:00</);
    });

    test("environment text from the forges is escaped and carries no links", () => {
      expect(env).not.toContain("<a ");
      expect(env).not.toMatch(/https?:\/\//);
      const lane = b.environment.lanes[0]!;
      const event = lane.events[0]!;
      const evil: Briefing = {
        ...b,
        environment: {
          ...b.environment,
          note: "<s>",
          lanes: [{ ...lane, events: [{ ...event, label: "<b>x</b>", detail: '"><i>' }] }],
        },
      };
      const out = consoleHtml(evil, FIXTURE_NOW);
      expect(out).not.toContain("<b>x</b>");
      expect(out).not.toContain('"><i>');
      expect(out).not.toContain("<s>");
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
