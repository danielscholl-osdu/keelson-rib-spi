import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { parseCodeAlert, parseDependencyAlert, readSecurity } from "../src/collect/security";
import { REPOS } from "../src/config";
import { Gh } from "../src/forge";

const DEP = {
  number: 82,
  severity: "high",
  package: "com.fasterxml.jackson.core:jackson-databind",
  ecosystem: "maven",
  manifest: "pom.xml",
  scope: "runtime",
  fixed: "2.21.7",
  advisory: "GHSA-0000-0000-0000",
  cve: null,
  summary: "jackson-databind: unbounded number parse",
  url: "https://github.com/Azure/osdu-spi-partition/security/dependabot/82",
  createdAt: "2026-10-04T20:20:40Z",
};

const CODE = {
  number: 3,
  severity: null,
  ruleSeverity: "error",
  rule: "java/spring-disabled-csrf-protection",
  description: "Disabled Spring CSRF protection",
  tool: "CodeQL",
  path: "provider/partition-azure/src/main/java/Config.java",
  url: "https://github.com/Azure/osdu-spi-partition/security/code-scanning/3",
  createdAt: "2026-02-27T00:01:04Z",
};

describe("alert parsing", () => {
  test("keeps a Dependabot alert's fix and scope, and reads moderate as medium", () => {
    expect(parseDependencyAlert(DEP)).toMatchObject({ severity: "high", fixed: "2.21.7" });
    expect(parseDependencyAlert(DEP)?.cve).toBeUndefined();
    const moderate = parseDependencyAlert({ ...DEP, severity: "moderate", fixed: null });
    expect(moderate?.severity).toBe("medium");
    expect(moderate && "fixed" in moderate).toBe(false);
    expect(parseDependencyAlert({ ...DEP, manifest: null })).toBeUndefined();
  });

  test("a code-scanning rule without a security severity keeps only its rule severity", () => {
    const a = parseCodeAlert(CODE);
    expect(a?.severity).toBeUndefined();
    expect(a).toMatchObject({ ruleSeverity: "error", tool: "CodeQL" });
    expect(parseCodeAlert({ ...CODE, severity: "high" })?.severity).toBe("high");
  });
});

function exec(answer: (path: string) => { ok: true; data: string } | { ok: false; error: string }) {
  return {
    runJSON: async () => ({ ok: false as const, error: "unused", code: 1 }),
    runText: async (_cmd: string, args: string[]) => {
      const r = answer(args[2] ?? "");
      return r.ok ? r : { ...r, code: 1 };
    },
  } as unknown as RibExec;
}

describe("readSecurity", () => {
  test("a hidden list reads as undefined, never as an empty one", async () => {
    const gh = new Gh(
      exec((path) =>
        path.includes("code-scanning")
          ? { ok: false, error: "gh: Not Found (HTTP 404)" }
          : { ok: true, data: `${JSON.stringify(DEP)}\n` },
      ),
    );
    const out = await readSecurity(gh, undefined);
    const first = out[REPOS[0] as string];
    expect(first?.dependabot).toHaveLength(1);
    expect(first?.code).toBeUndefined();
  });

  test("a repository whose read fails keeps its last good lists", async () => {
    const failing = REPOS[1] as string;
    const gh = new Gh(
      exec((path) =>
        path.includes(failing)
          ? { ok: false, error: "gh: Bad Gateway (HTTP 502)" }
          : { ok: true, data: "" },
      ),
    );
    const prev = { [failing]: { dependabot: [], code: [] } };
    const out = await readSecurity(gh, prev);
    expect(out[failing]).toBe(prev[failing]);
    expect(out[REPOS[0] as string]).toEqual({ dependabot: [], code: [] });
    await expect(
      readSecurity(new Gh(exec(() => ({ ok: false, error: "timeout" }))), undefined),
    ).rejects.toThrow("timeout");
  });
});
