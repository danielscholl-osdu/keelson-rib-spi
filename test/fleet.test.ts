import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RibExec } from "@keelson/shared";
import { ActionLog } from "../src/act/log";
import { act, paceTargets } from "../src/act/path";
import { laneActions, RERUN_ALL } from "../src/act/rerun";
import { rolloutTargets, SYNC_FORKS, syncTargets } from "../src/act/rollout";
import { registerVerb, type Target, verbOf } from "../src/act/verbs";
import { doctorBoard, doctorStatus, fleetChecks } from "../src/boards/doctor";
import { inspectBoard } from "../src/boards/inspect";
import { readFleet, resolveFleet, resolveLessons, upstreamProject } from "../src/collect/fleet";
import { builtInFleet, FORKS, KNOWN_SERVICES, REPOS, setFleet } from "../src/config";
import { Dismissals } from "../src/dismiss";
import type { Facts, FleetFacts, JobDetail } from "../src/facts";
import { Gh } from "../src/forge";
import {
  governing,
  judgeJob,
  logHits,
  needsLogScan,
  parseLessons,
  scriptFree,
  useLessons,
  withoutNoise,
} from "../src/lessons";
import { failedChecks } from "../src/model/checks";
import { buildModel } from "../src/model/index";
import type { LaneLoad } from "../src/model/lanes";
import { nextText } from "../src/model/next";
import { Store } from "../src/store";
import { Sweeper } from "../src/sweep";
import {
  boardActions,
  dismissActions,
  FIXTURE_NOW,
  fixtureFacts,
  laneFacts,
  releasedFacts,
} from "./harness";

// Approved, with every check green: a PR Roll out may merge.
function ready(f: Facts, repo: string, number: number) {
  const pr = f.github.data?.repos[repo]?.prs.find((p) => p.number === number);
  if (!pr) throw new Error(`${repo}#${number}`);
  pr.reviewDecision = "APPROVED";
  pr.mergeState = "CLEAN";
  pr.checks = pr.checks.map((c) => ({ ...c, status: "COMPLETED", conclusion: "SUCCESS" }));
}

const LESSONS_TEXT = readFileSync(new URL("./fixtures/lessons.json", import.meta.url), "utf8");
const LESSONS = parseLessons(LESSONS_TEXT).lessons;
if (!LESSONS) throw new Error("the lessons fixture parses");

const KNOWN = KNOWN_SERVICES.map((s) => s.id);
const NEW_FORK = {
  service: "wellbore",
  repo: "Azure/osdu-spi-wellbore",
  upstream: "osdu/platform/domain-data-mgmt-services/wellbore/wellbore-domain-services",
};

function sharedYaml(extra: string[] = []): string {
  const forks = [...KNOWN, ...extra].map(
    (id) => `  - service: ${id}\n    repo: Azure/osdu-spi-${id}\n    canonicalSource: fork`,
  );
  return `env: shared\nstackVersion: v0.35.2\nforks:\n${forks.join("\n")}\nresources:\n  postgres:\n    walStorage: 8Gi\n`;
}

// GitHub for readFleet: one GraphQL answer and each fork's repository variables.
function fleetGh(
  blobs: { stack?: string | null; lessons?: string | null },
  vars: Record<string, { name: string; value: string }[] | Error> = {},
) {
  const calls: string[] = [];
  const exec: RibExec = {
    runText: async (_cmd, args) => {
      calls.push(args.join(" "));
      const blob = (text: string | null | undefined) =>
        text === undefined ? undefined : { object: text === null ? null : { text } };
      return {
        ok: true as const,
        exitCode: 0,
        data: JSON.stringify({
          data: { stack: blob(blobs.stack), template: blob(blobs.lessons) },
        }),
      };
    },
    runJSON: async <T>(_cmd: string, args: string[]) => {
      calls.push(args.join(" "));
      const repo = /repos\/([^/]+\/[^/]+)\/actions\/variables/.exec(args[1] ?? "")?.[1] ?? "";
      const v = vars[repo] ?? [];
      if (v instanceof Error) return { ok: false as const, error: v.message, code: 1 };
      return { ok: true as const, data: v as T };
    },
  };
  return { gh: new Gh(exec), calls };
}

afterEach(() => {
  setFleet(builtInFleet());
  useLessons(undefined);
});

describe("the fleet list comes from the stack's forks: list", () => {
  test("14 forks: the 13 known by identity, the new one by its UPSTREAM_REPO_URL", async () => {
    const { gh } = fleetGh(
      { stack: sharedYaml([NEW_FORK.service]), lessons: null },
      {
        [NEW_FORK.repo]: [
          {
            name: "UPSTREAM_REPO_URL",
            value: `https://community.opengroup.org/${NEW_FORK.upstream}.git`,
          },
        ],
      },
    );
    const data = await readFleet(gh, undefined, FIXTURE_NOW, {});
    expect(data.forks).toHaveLength(14);
    const fleet = resolveFleet(data, null);
    expect(fleet.source).toBe("stack");
    expect(fleet.unresolved).toEqual([]);
    expect(fleet.services).toHaveLength(14);
    const wellbore = fleet.services.find((s) => s.id === NEW_FORK.service);
    expect(wellbore).toMatchObject({
      repo: NEW_FORK.repo,
      upstream: NEW_FORK.upstream,
      mirror: false,
    });
    expect(fleet.services.find((s) => s.id === "entitlements")?.prefix).toBe("entitlements-v2");

    setFleet(fleet.services);
    expect(FORKS).toHaveLength(14);
    expect(REPOS).toContain(NEW_FORK.repo);
    const model = buildModel(fixtureFacts(), FIXTURE_NOW);
    expect(model.lines.map((l) => l.fork.id)).toContain(NEW_FORK.service);
  });

  test("a fork with no upstream it can find is not followed, and the doctor names it", async () => {
    const { gh } = fleetGh({ stack: sharedYaml([NEW_FORK.service]), lessons: null });
    const data = await readFleet(gh, undefined, FIXTURE_NOW, {});
    const fleet = resolveFleet(data, null);
    expect(fleet.services).toHaveLength(13);
    expect(fleet.unresolved).toEqual([
      { service: NEW_FORK.service, why: "it has no UPSTREAM_REPO_URL variable" },
    ]);
    const facts: Facts = { ...fixtureFacts(), fleet: { at: FIXTURE_NOW.toISOString(), data } };
    const fleetCheck = fleetChecks(facts, FIXTURE_NOW, null)[0];
    expect(fleetCheck?.problem).toContain("not following wellbore");
  });

  test("variables are read again only on GitLab's cadence or for a new fork", async () => {
    const first = fleetGh({ stack: sharedYaml(), lessons: null });
    const data = await readFleet(first.gh, undefined, FIXTURE_NOW, {});
    expect(first.calls.filter((c) => c.includes("/actions/variables"))).toHaveLength(13);
    const again = fleetGh({ stack: sharedYaml(), lessons: null });
    await readFleet(again.gh, data, new Date(FIXTURE_NOW.getTime() + 5 * 60_000), {});
    expect(again.calls.filter((c) => c.includes("/actions/variables"))).toHaveLength(0);
  });

  test("a failed read keeps the last good list, and the doctor shows it stale", async () => {
    const { gh } = fleetGh(
      { stack: sharedYaml([NEW_FORK.service]), lessons: null },
      {
        [NEW_FORK.repo]: [
          {
            name: "UPSTREAM_REPO_URL",
            value: `https://community.opengroup.org/${NEW_FORK.upstream}`,
          },
        ],
      },
    );
    const good = await readFleet(gh, undefined, FIXTURE_NOW, {});
    const store = new Store(undefined);
    store.write("facts.json", { fleet: { at: "2026-10-12T20:00:00Z", data: good } });
    const down: RibExec = {
      runText: async () => ({ ok: false as const, error: "gh: network down", code: 1 }),
      runJSON: async () => ({ ok: false as const, error: "gh: network down", code: 1 }),
    };
    const sweeper = new Sweeper({
      exec: down,
      store,
      onChange: () => {},
      now: () => FIXTURE_NOW,
      fleetFiles: {},
    });
    expect(FORKS).toHaveLength(14);
    await sweeper.sweep({ force: true });
    expect(sweeper.facts.fleet.error).toContain("network down");
    expect(sweeper.facts.fleet.data?.forks).toHaveLength(14);
    expect(FORKS).toHaveLength(14);
    expect(doctorStatus(sweeper.facts, FIXTURE_NOW).problems.join()).toContain(
      "fleet list and lessons failed",
    );
  });

  test("a mirror fork (SYNC_MODE=mirror) is left out of Sync all forks and Roll out", () => {
    const facts = releasedFacts();
    ready(facts, "Azure/osdu-spi-legal", 33);
    const base = buildModel(facts, FIXTURE_NOW);
    const behind = syncTargets(base.template).targets.find(
      (t) => t.repo !== "Azure/osdu-spi-legal",
    );
    const merge = rolloutTargets(base.template).targets[0];
    if (!behind || !merge) throw new Error("fixture has a fork to sync and a PR to roll out");
    setFleet(
      builtInFleet().map((s) =>
        s.repo === behind.repo || s.repo === merge.repo ? { ...s, mirror: true } : s,
      ),
    );
    const m = buildModel(facts, FIXTURE_NOW);
    const sync = syncTargets(m.template);
    expect(sync.targets.map((t) => t.repo)).not.toContain(behind.repo);
    expect(sync.skipped.join()).toContain("(mirror)");
    const roll = rolloutTargets(m.template);
    expect(roll.targets.map((t) => t.repo)).not.toContain(merge.repo);
    expect(roll.held.map((h) => h.why)).toContain("is a mirror");
  });

  test("the upstream project comes from the GitLab URL, with or without .git", () => {
    expect(upstreamProject("https://community.opengroup.org/osdu/platform/system/file.git")).toBe(
      "osdu/platform/system/file",
    );
    expect(upstreamProject("https://gitlab.com/osdu/x")).toBeUndefined();
    expect(upstreamProject("https://communityXopengroup.org/osdu/x")).toBeUndefined();
    expect(upstreamProject("https://community.opengroup.org.evil.io/osdu/x")).toBeUndefined();
  });
});

describe("the lessons file", () => {
  test("missing, the rib behaves as before: no pacing, no noise, no lesson framing", async () => {
    const { gh } = fleetGh({ stack: sharedYaml(), lessons: null });
    const data = await readFleet(gh, undefined, FIXTURE_NOW, {});
    expect(data.lessons).toBeNull();
    const parsed = resolveLessons(data);
    expect(parsed).toEqual({ warnings: [] });
    useLessons(parsed.lessons);

    const before = buildModel(laneFacts(), FIXTURE_NOW);
    expect(before.lanes.cap).toBeNull();
    expect(before.noise).toEqual({});
    expect(before.queue.items.some((i) => i.lesson)).toBe(false);
    const sync = syncTargets(before.template, before.lanes);
    expect(sync.waiting).toEqual([]);
    expect(sync.targets).toEqual(syncTargets(before.template).targets);
  });

  test("an override path that does not exist reads as missing, without a GitHub call", async () => {
    const { gh, calls } = fleetGh({});
    const data = await readFleet(gh, undefined, FIXTURE_NOW, {
      services: "/pinned/services.json",
      lessons: "/nowhere/lessons.json",
    });
    expect(calls).toEqual([]);
    expect(data).toMatchObject({ lessons: null, lessonsFrom: "/nowhere/lessons.json" });
    expect(data.forks).toBeUndefined();
  });

  test("an unknown schema falls back to built-in behavior with a warning", () => {
    const parsed = parseLessons(JSON.stringify({ schema: 2, lanes: 3 }));
    expect(parsed.lessons).toBeUndefined();
    expect(parsed.warnings[0]).toContain("built-in behavior");
  });

  test("unknown fields are ignored and the draft parses whole", () => {
    expect(LESSONS.lanes).toBe(5);
    expect(LESSONS.noise.map((n) => n.id)).toContain("license-cla-app-authored");
    expect(LESSONS.failures.map((f) => f.id)[0]).toBe("environment-maintenance");
    const extra = parseLessons(
      JSON.stringify({ ...JSON.parse(LESSONS_TEXT), owner: "someone", future: [1] }),
    );
    expect(extra.warnings).toEqual([]);
    expect(extra.lessons?.failures).toHaveLength(LESSONS.failures.length);
  });

  test("license/cla on an app's PR neither fails nor pends it; on a person's PR it still counts", () => {
    const facts = fixtureFacts();
    const repos = facts.github.data?.repos ?? {};
    const app = repos["Azure/osdu-spi-partition"]?.prs.find((p) => p.number === 174);
    const human = repos["Azure/osdu-spi-entitlements"]?.prs.find((p) => p.number === 49);
    if (!app || !human) throw new Error("fixture PRs");
    for (const pr of [app, human]) {
      pr.checks = pr.checks.map((c) =>
        c.name === "license/cla" ? { ...c, status: "COMPLETED", conclusion: "FAILURE" } : c,
      );
    }
    expect(failedChecks(app).map((c) => c.name)).toContain("license/cla");

    const { repos: quiet, ignored } = withoutNoise(repos, LESSONS);
    const appAfter = quiet["Azure/osdu-spi-partition"]?.prs.find((p) => p.number === 174);
    const humanAfter = quiet["Azure/osdu-spi-entitlements"]?.prs.find((p) => p.number === 49);
    expect(appAfter?.checks.some((c) => c.name === "license/cla")).toBe(false);
    expect(failedChecks(appAfter ?? app).map((c) => c.name)).not.toContain("license/cla");
    expect(humanAfter?.checks.some((c) => c.name === "license/cla")).toBe(true);
    expect(ignored["license-cla-app-authored"]).toBeGreaterThan(0);

    useLessons(LESSONS);
    const m = buildModel(facts, FIXTURE_NOW);
    expect(m.noise["license-cla-app-authored"]).toBe(ignored["license-cla-app-authored"]);
  });

  test("a failure matches its annotations first, then the cleaned log, then the rerun limit", () => {
    const job = (over: Partial<JobDetail>): JobDetail => ({
      id: 1,
      name: "Deploy and Test",
      status: "completed",
      conclusion: "failure",
      url: "",
      steps: [],
      ...over,
    });
    const annotated = job({
      annotations: ["environment is not deployable after 10 minutes: spi-redis"],
    });
    expect(needsLogScan(annotated, LESSONS)).toBe(false);
    expect(judgeJob(annotated, LESSONS)).toMatchObject({
      id: "environment-not-deployable",
      class: "environment",
      response: "rerun-failed",
      drainFirst: true,
    });

    // The script echoes its own error strings; only the wrapped CLI error is real.
    const log = [
      "2026-11-04T10:00:00.0000000Z ##[group]Run ./deploy.sh",
      "2026-11-04T10:00:00.1000000Z \u001b[36;1mecho 'environment is not deployable after 10 minutes'\u001b[0m",
      "2026-11-04T10:09:00.0000000Z ERROR: could not update",
      "2026-11-04T10:09:00.1000000Z   osdu-image-lock: The request is invalid",
    ].join("\n");
    expect(scriptFree(log)).toBe("ERROR: could not update osdu-image-lock: The request is invalid");
    const pinned = job({
      annotations: ["pin refused while the environment is deployable"],
      attempt: 1,
    });
    expect(needsLogScan(pinned, LESSONS)).toBe(true);
    const scanned = { ...pinned, logScan: { signature: "s", hits: logHits(log, LESSONS) } };
    expect(judgeJob(scanned, LESSONS)).toMatchObject({
      id: "image-lock-race",
      class: "environment",
      response: "rerun-failed",
    });
    expect(judgeJob({ ...scanned, attempt: 2 }, LESSONS)).toMatchObject({
      id: "image-lock-race",
      class: "real",
      response: "stop",
      note: "rerun limit reached",
    });

    const echoOnly = log.split("\n").slice(0, 2).join("\n");
    expect(logHits(echoOnly, LESSONS)).toEqual([]);
    expect(
      judgeJob(
        { ...pinned, logScan: { signature: "s", hits: logHits(echoOnly, LESSONS) } },
        LESSONS,
      ),
    ).toEqual({ class: "real", response: "stop", rerunLimit: 0, drainFirst: false });
  });

  test("the lanes item is framed by its lesson instead of a bare re-run", () => {
    useLessons(LESSONS);
    const m = buildModel(laneFacts(), FIXTURE_NOW);
    const lanes = m.queue.items.find((i) => i.kind === "lanes");
    if (!lanes) throw new Error("fixture has failed lanes");
    expect(lanes.lesson?.id).toBe("environment-maintenance");
    expect(nextText(lanes)).toBe(
      "Wait for the environment (lesson environment-maintenance); no re-run yet",
    );
  });
});

const target = (n: number): Target => ({
  repo: `Azure/osdu-spi-f${n}`,
  kind: "workflow",
  state: "idle",
  label: `f${n}`,
});
const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(target);
const THREE_BUSY: LaneLoad = {
  cap: 5,
  capFrom: "lessons",
  inflight: ["a", "b", "c"].map((s) => ({
    repo: `Azure/osdu-spi-${s}`,
    service: s,
    what: "Validation running on #1",
  })),
};

// Every target reads as idle; every write succeeds and is recorded.
function idleGithub() {
  const writes: string[][] = [];
  const exec: RibExec = {
    runJSON: async <T>() => ({ ok: true as const, data: ["completed"] as T }),
    runText: async (_cmd, args) => {
      writes.push(args);
      return { ok: true as const, data: "" };
    },
  };
  return { exec, writes };
}

describe("paced fleet buttons", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  test("with 3 lanes in flight and a cap of 5, a press dispatches 2 and the rest wait", async () => {
    if (!verbOf(SYNC_FORKS.id)) unregister = registerVerb(SYNC_FORKS);
    const { exec, writes } = idleGithub();
    let load = THREE_BUSY;
    const res = await act(
      { verb: SYNC_FORKS.id, item: "engineering", swept: "s", targets: SEVEN },
      {
        exec,
        log: new ActionLog(undefined),
        resweep: () => {},
        now: () => FIXTURE_NOW,
        lanes: () => load,
        hold: (repos) => {
          load = {
            ...load,
            inflight: [
              ...load.inflight,
              ...repos.map((repo) => ({ repo, service: repo, what: "Sync Template dispatched" })),
            ],
          };
        },
      },
    );
    expect(writes.map((w) => w.at(-1))).toEqual(["Azure/osdu-spi-f1", "Azure/osdu-spi-f2"]);
    expect(res.ok).toBe(true);
    expect((res as { data: { message: string } }).data.message).toContain(
      "5 targets wait for the next press (5 of 5 lanes in flight)",
    );

    // A second press a minute later, from the same stale board, adds nothing past the cap.
    const again = await act(
      { verb: SYNC_FORKS.id, item: "engineering", swept: "s", targets: SEVEN },
      {
        exec,
        log: new ActionLog(undefined),
        resweep: () => {},
        now: () => new Date(FIXTURE_NOW.getTime() + 60_000),
        lanes: () => load,
      },
    );
    expect(writes).toHaveLength(2);
    expect(again.ok).toBe(false);
  });

  test("a press tops up; it never adds N on top of what is running", () => {
    expect(paceTargets(SEVEN, { ...THREE_BUSY, inflight: [] }).go).toHaveLength(5);
    expect(paceTargets(SEVEN, THREE_BUSY).go).toHaveLength(2);
    const full = { ...THREE_BUSY, cap: 3 };
    const none = paceTargets(SEVEN, full);
    expect(none.go).toEqual([]);
    expect(none.held.every((h) => h.outcome === "waiting")).toBe(true);
    expect(paceTargets(SEVEN, { cap: null, inflight: THREE_BUSY.inflight }).go).toHaveLength(7);
  });

  test("the board names what this press starts and how many wait", () => {
    useLessons(LESSONS);
    const m = buildModel(releasedFacts(), FIXTURE_NOW);
    const all = syncTargets(m.template).targets;
    if (all.length < 2) throw new Error("fixture has forks to sync");
    const busy = m.lanes.inflight.map((l) => l.repo);
    const eligible = all.filter((t) => !busy.includes(t.repo));
    const load: LaneLoad = { ...m.lanes, cap: m.lanes.inflight.length + 1 };
    const sync = syncTargets(m.template, load);
    expect(sync.targets).toEqual(eligible.slice(0, 1));
    expect(sync.waiting).toEqual(eligible.slice(1));
  });

  test("Re-run lanes takes the same cap", () => {
    const m = buildModel(laneFacts(), FIXTURE_NOW);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item?.lanes || item.lanes.length < 2) throw new Error("fixture has several lanes");
    const load: LaneLoad = { cap: 1, capFrom: "RIB_SPI_LANES", inflight: [] };
    const [button] = laneActions(item, m.stack, { swept: "s", now: FIXTURE_NOW, ops: true, load });
    const targets = (button?.binding as { targets: Target[] } | undefined)?.targets ?? [];
    expect(new Set(targets.map((t) => t.repo)).size).toBe(1);
    expect(button?.label).toMatch(/· \d+ wait$/);
  });

  test("lanes in flight are read from Sync Template runs, PR Validation and main runs", () => {
    useLessons(LESSONS);
    const facts = fixtureFacts();
    const repo = FORKS[0]?.repo ?? "";
    const runs = facts.runs.data?.[repo];
    const pr = facts.github.data?.repos[repo]?.prs[0];
    if (!runs || !pr) throw new Error("fixture runs and PRs");
    for (const r of Object.values(facts.runs.data ?? {})) {
      r.template = r.template.map((x) => ({ ...x, status: "completed" }));
      r.main = r.main.map((x) => ({ ...x, status: "completed" }));
    }
    for (const p of Object.values(facts.github.data?.repos ?? {}).flatMap((r) => r.prs)) {
      p.checks = p.checks.map((c) => ({ ...c, status: "COMPLETED" }));
    }
    pr.checks.push({
      id: 9e12,
      name: "Deploy and Test",
      workflow: "Validation",
      status: "IN_PROGRESS",
    });
    const m = buildModel(facts, FIXTURE_NOW, { pressed: { [FORKS[1]?.repo ?? ""]: "x" } });
    expect(m.lanes.cap).toBe(5);
    expect(m.lanes.inflight).toEqual([
      { repo, service: FORKS[0]?.id ?? "", what: `Validation running on #${pr.number}` },
      { repo: FORKS[1]?.repo ?? "", service: FORKS[1]?.id ?? "", what: "just merged or re-run" },
    ]);
  });
});

describe("the dismiss file", () => {
  test("a dismissed item stays quiet until its inputs change", () => {
    const facts = laneFacts();
    const m = buildModel(facts, FIXTURE_NOW);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item?.fingerprint || !item.lanes?.[0]) throw new Error("fixture has failed lanes");
    const entry = { id: item.id, fingerprint: item.fingerprint };

    const quiet = buildModel(facts, FIXTURE_NOW, { dismissed: [entry] });
    expect(quiet.queue.items.find((i) => i.id === item.id)).toBeUndefined();
    expect(quiet.queue.dismissed.map((d) => d.item.id)).toEqual([item.id]);
    expect(quiet.queue.counts.p1).toBe(m.queue.counts.p1 - 1);

    // The same inputs a day later stay quiet: the fingerprint ignores how stamps print.
    const tomorrow = new Date(FIXTURE_NOW.getTime() + 24 * 3600_000);
    expect(
      buildModel(facts, tomorrow, { dismissed: [entry] }).queue.dismissed.map((d) => d.item.id),
    ).toEqual([item.id]);

    // A new head on one lane's PR is a new input, so the item comes back.
    const lane = item.lanes[0];
    const pr = facts.github.data?.repos[lane.repo]?.prs.find((p) => p.number === lane.pr);
    if (!pr) throw new Error("lane PR");
    pr.headSha = "f".repeat(40);
    const back = buildModel(facts, FIXTURE_NOW, { dismissed: [entry] });
    expect(back.queue.items.find((i) => i.id === item.id)?.fingerprint).not.toBe(item.fingerprint);
    expect(back.queue.dismissed).toEqual([]);
  });

  test("an until that has passed brings it back, and prune drops the entry", () => {
    const facts = laneFacts();
    const m = buildModel(facts, FIXTURE_NOW);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item?.fingerprint) throw new Error("fixture has failed lanes");
    const store = new Store(undefined);
    const quiet = new Dismissals(store);
    quiet.add({ id: item.id, fingerprint: item.fingerprint, until: "2026-10-12T22:30:00Z" });
    expect(new Dismissals(store).list()).toHaveLength(1);
    const before = buildModel(facts, FIXTURE_NOW, { dismissed: quiet.list() });
    expect(before.queue.dismissed).toHaveLength(1);
    expect(quiet.prune(before.queue, FIXTURE_NOW)).toBe(false);

    const later = new Date("2026-10-12T23:00:00Z");
    const after = buildModel(facts, later, { dismissed: quiet.list() });
    expect(after.queue.items.some((i) => i.id === item.id)).toBe(true);
    expect(quiet.prune(after.queue, later)).toBe(true);
    expect(quiet.list()).toEqual([]);
  });

  test("the inspector offers Dismiss beside the verbs and Bring back once dismissed", () => {
    const facts = laneFacts();
    const m = buildModel(facts, FIXTURE_NOW);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item?.fingerprint) throw new Error("fixture has failed lanes");
    const live = inspectBoard(m, { selected: item.id, item }, FIXTURE_NOW);
    expect(dismissActions(live)).toMatchObject([
      { type: "dismiss", payload: { id: item.id, fingerprint: item.fingerprint } },
    ]);
    expect(boardActions(live).length).toBeGreaterThan(0);
    const quiet = buildModel(facts, FIXTURE_NOW, {
      dismissed: [{ id: item.id, fingerprint: item.fingerprint }],
    });
    const board = inspectBoard(quiet, { selected: item.id, item }, FIXTURE_NOW);
    expect(board.header?.status?.label).toBe("DISMISSED");
    expect(dismissActions(board)).toMatchObject([{ type: "undismiss" }]);
    expect(boardActions(board)).toEqual([]);
  });
});

test("a fleet read with lessons and the stack fills the facts the model reads", async () => {
  const { gh } = fleetGh({ stack: sharedYaml(), lessons: LESSONS_TEXT });
  const data: FleetFacts = await readFleet(gh, undefined, FIXTURE_NOW, {});
  expect(resolveLessons(data).lessons?.lanes).toBe(5);
  expect(data.lessonsFrom).toBe("Azure/osdu-spi:.github/fleet/lessons.json");
});

describe("review fixes", () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  test("overlapping presses never start more than the cap between them", async () => {
    if (!verbOf(SYNC_FORKS.id)) unregister = registerVerb(SYNC_FORKS);
    const { exec, writes } = idleGithub();
    let load: LaneLoad = { cap: 1, capFrom: "lessons", inflight: [] };
    const deps = {
      exec,
      log: new ActionLog(undefined),
      resweep: () => {},
      now: () => FIXTURE_NOW,
      lanes: () => load,
      hold: (repos: string[]) => {
        load = {
          ...load,
          inflight: [
            ...load.inflight,
            ...repos.map((repo) => ({ repo, service: repo, what: "x" })),
          ],
        };
      },
    };
    const press = (t: Target) =>
      act({ verb: SYNC_FORKS.id, item: "engineering", swept: "s", targets: [t] }, deps);
    await Promise.all([press(target(1)), press(target(2))]);
    expect(writes).toHaveLength(1);
  });

  test("a failed variables read keeps the last good values; never read fails closed", async () => {
    const url = `https://community.opengroup.org/${NEW_FORK.upstream}.git`;
    const first = fleetGh(
      { stack: sharedYaml([NEW_FORK.service]), lessons: null },
      {
        [NEW_FORK.repo]: [{ name: "UPSTREAM_REPO_URL", value: url }],
        "Azure/osdu-spi-file": [{ name: "SYNC_MODE", value: "mirror" }],
      },
    );
    const good = await readFleet(first.gh, undefined, FIXTURE_NOW, {});
    const down = Object.fromEntries(
      [...KNOWN.map((id) => `Azure/osdu-spi-${id}`), NEW_FORK.repo].map((r) => [
        r,
        new Error("HTTP 502"),
      ]),
    );
    const later = new Date(FIXTURE_NOW.getTime() + 60 * 60_000);
    const again = await readFleet(
      fleetGh({ stack: sharedYaml([NEW_FORK.service]), lessons: null }, down).gh,
      good,
      later,
      {},
    );
    const fleet = resolveFleet(again, null);
    expect(fleet.services.find((s) => s.id === NEW_FORK.service)?.upstream).toBe(NEW_FORK.upstream);
    expect(fleet.services.find((s) => s.id === "file")?.mirror).toBe(true);

    const never = await readFleet(
      fleetGh({ stack: sharedYaml(), lessons: null }, down).gh,
      undefined,
      FIXTURE_NOW,
      {},
    );
    expect(resolveFleet(never, null).services.every((s) => s.mirror === null)).toBe(true);
  });

  test("a services file wins over a stack list read before it was set", async () => {
    const { gh } = fleetGh({ stack: sharedYaml([NEW_FORK.service]), lessons: null });
    const data = await readFleet(gh, undefined, FIXTURE_NOW, {});
    const file = new URL("./fixtures/services.json", import.meta.url).pathname;
    const pinned = resolveFleet(data, file);
    expect(pinned.source).toBe("file");
    expect(pinned.services.map((s) => s.id)).toEqual(builtInFleet(file).map((s) => s.id));
  });

  test("the doctor lists dismissed items, each opening its inspector", () => {
    const board = doctorBoard(fixtureFacts(), FIXTURE_NOW, undefined, [
      { id: "stack:lanes", scope: "Environment", text: "2 fork lanes failed", at: "x" },
    ]);
    const section = board.sections.find(
      (s) => s.kind === "rows" && s.title?.startsWith("Dismissed"),
    );
    expect(section).toMatchObject({
      title: "Dismissed · 1",
      items: [{ action: { type: "inspect", payload: { id: "stack:lanes" } } }],
    });
  });

  test("a new head on a template-sync PR changes the rollout's fingerprint", () => {
    const facts = releasedFacts();
    const before = buildModel(facts, FIXTURE_NOW).queue.items.find(
      (i) => i.kind === "template-set",
    );
    const pr = facts.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
    if (!before || !pr) throw new Error("fixture has a template-sync set");
    pr.headSha = "e".repeat(40);
    const after = buildModel(facts, FIXTURE_NOW).queue.items.find((i) => i.kind === "template-set");
    expect(after?.fingerprint).not.toBe(before.fingerprint);
  });

  test("a rerun-all lesson draws a button whose command re-runs every job", () => {
    const m = buildModel(laneFacts(), FIXTURE_NOW);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item) throw new Error("fixture has failed lanes");
    const lesson = {
      id: "pin-refused-moved-tag",
      class: "environment" as const,
      response: "rerun-all" as const,
      rerunLimit: 1,
      drainFirst: false,
    };
    const [button] = laneActions({ ...item, lesson }, m.stack, {
      swept: "s",
      now: FIXTURE_NOW,
      ops: true,
    });
    const binding = button?.binding as { verb: string; targets: Target[] } | undefined;
    expect(binding?.verb).toBe(RERUN_ALL.id);
    const body = (button?.confirm as { body: string } | undefined)?.body ?? "";
    expect(body).toContain("gh run rerun");
    expect(body).not.toContain("--failed");
  });

  test("the governing lesson stops the line when any failure is real", () => {
    const retry = {
      id: "digest-not-live",
      class: "environment" as const,
      response: "rerun-failed" as const,
      rerunLimit: 1,
      drainFirst: true,
    };
    const stop = {
      class: "real" as const,
      response: "stop" as const,
      rerunLimit: 0,
      drainFirst: false,
    };
    expect(governing([retry, stop])?.response).toBe("stop");
    expect(governing([retry, undefined])?.id).toBe("digest-not-live");
  });
});
