import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  columnRegions,
  expectView,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import { ROLLOUT_ITEM, SYNC_FORKS } from "../src/act/rollout";
import { registerVerb } from "../src/act/verbs";
import { DOCTOR_ID } from "../src/boards/doctor";
import rib from "../src/index";
import { BADGE_KEY, CONSOLE_KEY, INSPECT_KEY, RELEASE_KEY } from "../src/keys";
import { failingExec, fakeContext, fixtureFacts } from "./harness";

afterEach(async () => {
  await rib.dispose?.();
});

function regionKeys(): string[] {
  return (rib.surfaces ?? []).flatMap((s) => [
    ...(s.layout.banner ? [s.layout.banner.key] : []),
    ...s.layout.rows.flatMap((r) => r.columns.flatMap((c) => columnRegions(c).map((x) => x.key))),
    ...(s.layout.footer ? [s.layout.footer.key] : []),
  ]);
}

describe("rib contract shape", () => {
  test("id matches the package basename", () => {
    expect(ribIdSchema.parse(rib.id)).toBe("spi");
  });

  test("every view and surface parses against the host schemas", () => {
    for (const view of rib.views ?? []) ribViewDescriptorSchema.parse(view);
    for (const surface of rib.surfaces ?? []) ribSurfaceDescriptorSchema.parse(surface);
  });

  test("one SPI tab: the console banner is its only region", () => {
    const surface = rib.surfaces?.[0];
    expect(rib.surfaces).toHaveLength(1);
    expect(surface?.title).toBe("SPI");
    expect(surface?.badgeKey).toBe(BADGE_KEY);
    expect(surface?.layout.banner?.key).toBe(CONSOLE_KEY);
    expect(surface?.layout.rows).toEqual([]);
    expect(regionKeys()).toEqual([CONSOLE_KEY]);
    expect(rib.views?.find((v) => v.key === CONSOLE_KEY)?.canvasKind).toBe("html");
  });

  test("every key lives under the rib namespace and every region binds a declared view", () => {
    const views = new Set((rib.views ?? []).map((v) => v.key));
    for (const key of [INSPECT_KEY, BADGE_KEY, ...regionKeys()])
      expect(key.startsWith("rib:spi:")).toBe(true);
    for (const key of regionKeys()) expect(views.has(key)).toBe(true);
  });

  test("the watch officer resolves; other slugs do not", async () => {
    const agents = await rib.listAgents?.(fakeContext().ctx);
    expect(agents?.map((a) => a.slug)).toEqual(["watch-officer"]);
    const seed = await rib.resolveAgent?.("watch-officer", fakeContext().ctx);
    expect(seed?.systemPrompt).toContain("spi_watchstand");
    expect(await rib.resolveAgent?.("nope", fakeContext().ctx)).toBeNull();
  });
});

describe("binding", () => {
  test("registers the console, the inspector and the badge, and each resting frame passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    const tools = rib.registerTools?.(ctx) ?? [];
    expect(snapshots.keys().sort()).toEqual(
      [BADGE_KEY, CONSOLE_KEY, INSPECT_KEY, RELEASE_KEY].sort(),
    );
    const frames = await snapshots.composeAll();
    expect(frames.size).toBe(4);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "spi_brief",
      "spi_incidents",
      "spi_issues",
      "spi_line",
      "spi_prs",
      "spi_radar",
      "spi_release_notes",
      "spi_security",
      "spi_stack",
      "spi_template",
      "spi_watchstand",
    ]);
    expect(tools.every((t) => !t.state_changing)).toBe(true);
  });

  test("a stored sweep renders at boot, before any new read lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-"));
    writeFileSync(join(dir, "facts.json"), JSON.stringify(fixtureFacts()));
    const { ctx, snapshots } = fakeContext({ getDataDir: () => dir });
    rib.registerTools?.(ctx);
    const frame = await snapshots.recompose(CONSOLE_KEY);
    expect(frame.data as string).toContain("Restore the environment.");
    const badge = await snapshots.recompose(BADGE_KEY);
    expect((badge.data as { count: number }).count).toBeGreaterThan(0);
  });

  test("gh and glab are only ever asked to read", async () => {
    const exec = failingExec();
    const { ctx } = fakeContext({ getExec: () => exec });
    rib.registerTools?.(ctx);
    await new Promise((r) => setTimeout(r, 50));
    for (const call of exec.calls) {
      expect(["gh", "glab"]).toContain(call.cmd);
      expect(call.args).not.toContain("-X");
      expect(call.args).not.toContain("--method");
      expect(["api", "auth"]).toContain(call.args[0] ?? "");
    }
  });

  test("binding twice replaces the registrations instead of throwing", () => {
    const { ctx } = fakeContext();
    rib.registerTools?.(ctx);
    expect(() => rib.registerTools?.(ctx)).not.toThrow();
  });

  test("refresh is handled and unknown actions fail closed", async () => {
    rib.registerTools?.(fakeContext().ctx);
    const refresh = await rib.onAction?.({ type: "refresh" }, fakeContext().ctx);
    expect(refresh?.ok).toBe(true);
    const nope = await rib.onAction?.({ type: "merge-everything" }, fakeContext().ctx);
    expect(nope).toEqual({ ok: false, error: "spi does not handle 'merge-everything'" });
  });

  test("the console frame may open the inspector and nothing else", async () => {
    const { ctx } = fakeContext();
    rib.registerTools?.(ctx);
    for (const type of ["act", "refresh", "rerun-when-deployable"]) {
      const res = await rib.onAction?.({ type, payload: {}, origin: "canvas-html" }, ctx);
      expect(res).toEqual({
        ok: false,
        error: "the console only opens the inspector; act from its buttons",
      });
    }
    const open = await rib.onAction?.(
      { type: "inspect", payload: { id: "halt:nope" }, origin: "canvas-html" },
      ctx,
    );
    expect(open?.ok === false && open.error).not.toContain("console");
  });
});

describe("inspect", () => {
  function stored() {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-"));
    writeFileSync(join(dir, "facts.json"), JSON.stringify(fixtureFacts()));
    return fakeContext({ getDataDir: () => dir });
  }

  test("a queue item opens the side inspector holding that item", async () => {
    const { ctx, snapshots } = stored();
    rib.registerTools?.(ctx);
    const res = await rib.onAction?.({ type: "inspect", payload: { id: "gate1:legal" } }, ctx);
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: INSPECT_KEY,
        title: "legal · sync PR",
        placement: "side",
      },
    });
    const frame = snapshots.latest(INSPECT_KEY)?.data as {
      header?: { status?: { label: string } };
    };
    expect(frame.header?.status?.label).toBe("P1 · TOOLCHAIN");
  });

  test("a halt opens at once, then fills in each fork; an unreachable forge reads as unknown", async () => {
    const { ctx, snapshots } = stored();
    rib.registerTools?.(ctx);
    type Frame = {
      sections: { title?: string; items?: { text: string; chip?: { label: string } }[] }[];
    };
    const same = () =>
      (snapshots.latest(INSPECT_KEY)?.data as Frame | undefined)?.sections.find(
        (s) => s.title === "Same entry in other forks",
      );
    const res = await rib.onAction?.(
      { type: "inspect", payload: { id: "halt:entitlements" } },
      ctx,
    );
    expect(res?.ok).toBe(true);
    expect(same()?.items?.[0]?.text).toBe("reading each fork's filter and upstream tree");
    for (let i = 0; i < 50 && same()?.items?.length !== 4; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(same()?.items?.map((r) => r.chip?.label)).toEqual(["?", "?", "?", "?"]);
  });

  test("a verb whose target cannot be read again is refused, logged and shown in the inspector", async () => {
    const unregister = registerVerb({
      id: "poke",
      label: "Poke",
      command: (t) => ["api", "-X", "POST", `repos/${t.repo}/poke/${t.number}`],
    });
    try {
      const { ctx, snapshots } = stored();
      rib.registerTools?.(ctx);
      await rib.onAction?.({ type: "inspect", payload: { id: "gate1:legal" } }, ctx);
      const res = await rib.onAction?.(
        {
          type: "act",
          payload: {
            verb: "poke",
            item: "gate1:legal",
            swept: "2026-10-12T21:58:30Z",
            targets: [
              {
                repo: "Azure/osdu-spi-legal",
                kind: "pr",
                number: 31,
                sha: "abc",
                label: "legal #31",
              },
            ],
          },
        },
        ctx,
      );
      expect(res?.ok).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      const frame = snapshots.latest(INSPECT_KEY)?.data as {
        sections: { title?: string; items?: { text: string }[] }[];
      };
      const last = frame.sections.find((s) => s.title === "Last action");
      expect(last?.items?.[0]?.text).toBe("Poke · 0 of 1 done");
    } finally {
      unregister();
    }
  });

  test("a repository row opens its inspector from the console frame", async () => {
    const { ctx, snapshots } = stored();
    rib.registerTools?.(ctx);
    const res = await rib.onAction?.(
      { type: "inspect", payload: { id: "repo:partition" }, origin: "canvas-html" },
      ctx,
    );
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: INSPECT_KEY,
        title: "osdu-spi-partition",
        placement: "side",
      },
    });
    const frame = snapshots.latest(INSPECT_KEY)?.data;
    expect(() => expectView(INSPECT_KEY, "board")(frame)).not.toThrow();
    const gone = await rib.onAction?.({ type: "inspect", payload: { id: "repo:nope" } }, ctx);
    expect(gone?.ok).toBe(false);
    await rib.dispose?.();
  });

  test("the doctor opens the side inspector, from the drawer or the console frame", async () => {
    for (const origin of [undefined, "canvas-html"] as const) {
      const { ctx, snapshots } = stored();
      rib.registerTools?.(ctx);
      const res = await rib.onAction?.(
        { type: "inspect", payload: { id: DOCTOR_ID }, ...(origin ? { origin } : {}) },
        ctx,
      );
      expect(res).toEqual({
        ok: true,
        data: { effect: "open-canvas", key: INSPECT_KEY, title: "Doctor", placement: "side" },
      });
      const frame = snapshots.latest(INSPECT_KEY)?.data;
      expect(() => expectView(INSPECT_KEY, "board")(frame)).not.toThrow();
      expect((frame as { sections: { title?: string }[] }).sections.map((s) => s.title)).toContain(
        "Sources",
      );
      await rib.dispose?.();
    }
  });

  test("the template-set inspector shows the last rollout verb as its last action", async () => {
    const { ctx, snapshots } = stored();
    rib.registerTools?.(ctx);
    const res = await rib.onAction?.(
      {
        type: "act",
        payload: {
          verb: SYNC_FORKS.id,
          item: ROLLOUT_ITEM,
          swept: "2026-10-12T21:58:30Z",
          targets: [{ repo: "Azure/osdu-spi-legal", kind: "repo", label: "legal" }],
        },
      },
      ctx,
    );
    expect(res?.ok).toBe(false);
    await rib.onAction?.({ type: "inspect", payload: { id: "template-set" } }, ctx);
    const frame = snapshots.latest(INSPECT_KEY)?.data as {
      sections: { title?: string; items?: { text: string }[] }[];
    };
    const last = frame.sections.find((s) => s.title === "Last action");
    expect(last?.items?.[0]?.text).toBe("Sync all forks · 0 of 1 done");
  });

  test("a missing or stale id fails without opening anything", async () => {
    const { ctx } = stored();
    rib.registerTools?.(ctx);
    expect(await rib.onAction?.({ type: "inspect", payload: {} }, ctx)).toEqual({
      ok: false,
      error: "inspect payload must be { id: string }",
    });
    const gone = await rib.onAction?.({ type: "inspect", payload: { id: "halt:nope" } }, ctx);
    expect(gone?.ok).toBe(false);
  });
});

describe("tools answer from the sweep", () => {
  test("spi_watchstand returns the verdict and the queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rib-spi-"));
    writeFileSync(join(dir, "facts.json"), JSON.stringify(fixtureFacts()));
    const tools = rib.registerTools?.(fakeContext({ getDataDir: () => dir }).ctx) ?? [];
    const watch = tools.find((t) => t.name === "spi_watchstand");
    const out: string[] = [];
    await watch?.execute(
      {},
      {
        cwd: dir,
        abortSignal: new AbortController().signal,
        emit: (chunk) => {
          if (chunk.type === "tool_result") out.push(chunk.content as string);
        },
      },
    );
    const result = JSON.parse(out[0] ?? "{}");
    expect(result.verdict).toBe("BLOCKED");
    expect(result.queue[0].rung).toBe("P0");
    expect(result.lines).toHaveLength(5);
  });
});
