import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  columnRegions,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import rib from "../src/index";
import { ATTENTION_KEY, BADGE_KEY, BOARD_KEYS } from "../src/keys";
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

  test("one SPI tab: banner, stack, lines, template, doctor footer, badge", () => {
    const surface = rib.surfaces?.[0];
    expect(rib.surfaces).toHaveLength(1);
    expect(surface?.title).toBe("SPI");
    expect(surface?.badgeKey).toBe(BADGE_KEY);
    expect(surface?.layout.banner?.key).toBe(ATTENTION_KEY);
    expect(regionKeys()).toEqual([...BOARD_KEYS]);
  });

  test("every key lives under the rib namespace and every region binds a declared view", () => {
    const views = new Set((rib.views ?? []).map((v) => v.key));
    for (const key of [...BOARD_KEYS, BADGE_KEY, ...regionKeys()])
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
  test("registers every board and the badge, and each resting frame passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    const tools = rib.registerTools?.(ctx) ?? [];
    expect(snapshots.keys().sort()).toEqual([...BOARD_KEYS, BADGE_KEY].sort());
    const frames = await snapshots.composeAll();
    expect(frames.size).toBe(BOARD_KEYS.length + 1);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "spi_incidents",
      "spi_line",
      "spi_prs",
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
    const frame = await snapshots.recompose(ATTENTION_KEY);
    expect(
      (frame.data as { header?: { status?: { label: string } } }).header?.status?.label,
    ).toMatch(/^BLOCKED/);
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
