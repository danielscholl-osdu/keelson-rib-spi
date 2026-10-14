import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibContext, RibExec, SnapshotManager } from "@keelson/shared";
import type { Facts, TemplateChange } from "../src/facts";
import fixture from "./fixtures/facts.json";

type Composer = () => Promise<unknown>;
type Validator = (data: unknown) => unknown;

// Grants are read from the host's config.json; tests read an empty home, never the operator's.
process.env.KEELSON_HOME = mkdtempSync(join(tmpdir(), "rib-spi-home-"));
delete process.env.KEELSON_RIB_WORKFLOW_GRANTS;
delete process.env.KEELSON_RIB_APPROVAL_GRANTS;

// The live sweep this fixture came from ran at this instant.
export const FIXTURE_NOW = new Date("2026-10-12T21:58:30Z");

export function fixtureFacts(): Facts {
  return structuredClone(fixture) as unknown as Facts;
}

export const NEW_HEAD = "c0de000000000000000000000000000000000130";

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
export function releasedFacts(): Facts {
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

// An in-memory SnapshotManager that runs each key's validator on compose, so a
// test fails the same way the host would refuse a frame.
export class FakeSnapshots implements SnapshotManager {
  readonly composers = new Map<string, { compose: Composer; validate?: Validator }>();
  readonly frames = new Map<string, unknown>();

  register<T>(
    key: string,
    compose: () => Promise<T> | T,
    opts?: { validate?: (data: unknown) => T },
  ): () => void {
    if (this.composers.has(key)) throw new Error(`duplicate key ${key}`);
    this.composers.set(key, { compose: async () => compose(), validate: opts?.validate });
    return () => {
      this.composers.delete(key);
    };
  }

  async recompose<T = unknown>(key: string): Promise<any> {
    const entry = this.composers.get(key);
    if (!entry) return undefined;
    const raw = await entry.compose();
    const data = entry.validate ? entry.validate(raw) : raw;
    this.frames.set(key, data);
    return { key, version: 1, data: data as T };
  }

  latest<T = unknown>(key: string): any {
    return this.frames.has(key) ? { key, version: 1, data: this.frames.get(key) as T } : undefined;
  }

  keys(): string[] {
    return [...this.composers.keys()];
  }

  async dispose(): Promise<void> {
    this.composers.clear();
    this.frames.clear();
  }

  async composeAll(): Promise<Map<string, unknown>> {
    for (const key of this.keys()) await this.recompose(key);
    return this.frames;
  }
}

export interface ExecCall {
  cmd: string;
  args: string[];
}

// An exec that fails every call and records it: the rib must stay renderable
// with gh and glab unreachable.
export function failingExec(): RibExec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    runJSON: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { ok: false as const, error: `${cmd} unavailable`, code: 1 };
    },
    runText: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { ok: false as const, error: `${cmd} unavailable`, code: 1 };
    },
  };
}

export function fakeContext(overrides: Partial<RibContext> = {}): {
  ctx: RibContext;
  snapshots: FakeSnapshots;
} {
  const snapshots = new FakeSnapshots();
  const ctx: RibContext = {
    getExec: () => failingExec(),
    getSnapshotManager: () => snapshots,
    ...overrides,
  };
  return { ctx, snapshots };
}

// The 12 October fleet with the stack green again since 11 October, so the
// template-sync lanes it failed are loose; `down` adds a refresh that failed after them.
export function laneFacts(down = false): Facts {
  const f = fixtureFacts();
  const lc = f.lifecycle.data;
  if (!lc) throw new Error("fixture has lifecycle runs");
  const cut = Date.parse("2026-10-11T22:00:00Z");
  const refresh = lc.refresh.filter((r) => Date.parse(r.createdAt) < cut);
  const last = refresh[0];
  if (!last) throw new Error("fixture has a refresh before the cut");
  const failed = {
    ...last,
    id: 99000001,
    createdAt: "2026-10-12T21:30:00Z",
    updatedAt: "2026-10-12T21:40:00Z",
    conclusion: "failure",
    jobs: undefined,
  };
  f.lifecycle.data = {
    ...lc,
    refresh: down ? [failed, ...refresh] : refresh,
    upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
  };
  return f;
}
