import { describe, expect, test } from "bun:test";
import { emptyFacts } from "../src/facts";
import { classOf } from "../src/model/attribution";
import { buildModel } from "../src/model/index";
import { nextText, verbOf } from "../src/model/next";
import { consequenceOf } from "../src/model/template";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

// The fixture is a real sweep from 12 October: the v0.28.1 upgrade failed on a
// GitLab outage, maintenance stayed set, and a v0.28.2 upgrade was in flight.
const model = buildModel(fixtureFacts(), FIXTURE_NOW);

describe("the fleet on 12 October", () => {
  test("a failed Sync Upstream reads as a P0 only once the fork's issues were read", () => {
    const f = fixtureFacts();
    const ent = f.github.data?.repos["Azure/osdu-spi-entitlements"];
    if (!ent) throw new Error("fixture has entitlements");
    ent.issues = ent.issues.filter((i) => !i.labels.includes("sync-failed"));
    const ids = (facts: typeof f) => buildModel(facts, FIXTURE_NOW).queue.items.map((i) => i.id);
    expect(ids(f)).toContain("sync-run:entitlements");
    const dark = fixtureFacts();
    dark.github = { error: "gh api graphql: HTTP 502" };
    expect(ids(dark)).not.toContain("sync-run:entitlements");
    expect(ids(dark)).not.toContain("halt:entitlements");
  });

  test("the verdict is BLOCKED and the badge counts P0 and P1", () => {
    expect(model.measured).toBe(true);
    expect(model.queue.verdict).toBe("BLOCKED");
    expect(model.queue.counts.p0).toBeGreaterThanOrEqual(2);
  });

  test("one stack incident folds the earlier attempts and every fork lane it turned red", () => {
    const stack = model.queue.items.find((i) => i.scope === "Environment" && i.rung === 0);
    expect(stack?.text).toBe(
      "maintenance mode; env-upgrade v0.28.2 in verify › Azure login (OIDC) now",
    );
    expect(stack?.since).toStartWith("2026-10-11T22:44");
    const effects = stack?.effects.map((e) => e.text) ?? [];
    expect(
      effects.some(
        (e) =>
          e.includes("env-upgrade v0.28.1 failed in provision › spi up") &&
          e.includes("set maintenance"),
      ),
    ).toBe(true);
    expect(effects.some((e) => e.includes("env-refresh") && e.includes("drifted"))).toBe(true);
    expect(
      effects.some((e) =>
        e.includes("(dispatched) cancelled after 1h 2m in verify › Wait for Flux Kustomizations"),
      ),
    ).toBe(true);
    for (const svc of ["partition", "entitlements", "legal", "schema", "file"]) {
      expect(effects.some((e) => e.startsWith(`${svc} template-sync PR`))).toBe(true);
    }
    expect(model.queue.items.some((i) => i.id === "stack:lanes")).toBe(false);
  });

  test("the entitlements halt is its own incident with its code", () => {
    const halt = model.queue.items.find((i) => i.id === "halt:entitlements");
    expect(halt?.rung).toBe(0);
    expect(halt?.text).toBe("sync halted on schemathesis-tests, an unclassified top-level entry");
    expect(halt?.cause.find((c) => c.label === "halt")?.value).toBe("UNKNOWN_TOP_LEVEL");
    expect(halt?.note).toBe("2 commits behind");
  });

  test("a red release build reads as one clause; the inspector keeps the surefire line", () => {
    const f = fixtureFacts();
    const pr = f.github.data?.repos["Azure/osdu-spi"]?.prs.find((p) => p.number === 248);
    const details = f.details.data;
    if (!pr || !details) throw new Error("fixture has the osdu-spi release PR");
    const raw =
      "Tests run: 24, Failures: 0, Errors: 24, Skipped: 0, Time elapsed: 0.793 s <<< FAILURE! -- in org.opengroup.osdu.crs.converter.CompoundWGS84TransformTests";
    pr.checks.push({
      id: 1,
      name: "Java Build",
      workflow: "Build",
      runId: 1,
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-10-12T21:00:00Z",
      completedAt: "2026-10-12T21:05:00Z",
      url: "https://github.com/Azure/osdu-spi/actions/runs/1/job/1",
    });
    details["Azure/osdu-spi#1"] = {
      id: 1,
      name: "Java Build",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/Azure/osdu-spi/actions/runs/1/job/1",
      steps: [],
      failedStep: "Run Java Build",
      reason: raw,
    };
    const item = buildModel(f, FIXTURE_NOW).queue.items.find((i) => i.kind === "release-red");
    expect(item?.text).toBe(
      "release PR #248 fails Java Build: 24 errors in CompoundWGS84TransformTests",
    );
    expect(item?.cause.find((c) => c.label === "reason")?.value).toBe(raw);
  });

  test("the legal sync PR reads as a toolchain move, not a code failure", () => {
    const legal = model.queue.items.find((i) => i.id === "gate1:legal");
    expect(legal?.rung).toBe(1);
    expect(legal?.text).toBe(
      "sync PR #31 fails Java Build: upstream requires Java 25, the fork builds on 17",
    );
    expect(legal?.incident).toBe(true);
  });

  test("release PRs read as the lines table reads them, ready only when nothing is owed", () => {
    expect(model.queue.items.find((i) => i.id === "releases")?.text).toBe(
      "1 release PR · osdu-spi v1.2.1 · review required",
    );
    const f = fixtureFacts();
    const release = f.github.data?.repos["Azure/osdu-spi"]?.prs.find((p) =>
      p.head.startsWith("release-please--"),
    );
    if (!release) throw new Error("fixture has the template release PR");
    release.reviewDecision = "APPROVED";
    expect(buildModel(f, FIXTURE_NOW).queue.items.find((i) => i.id === "releases")?.text).toBe(
      "1 release PR · osdu-spi v1.2.1 · ready",
    );
  });

  test("template-sync PRs blocked only by the stack wait as one set", () => {
    const set = model.queue.items.find((i) => i.id === "template-set");
    expect(set?.rung).toBe(2);
    expect(set?.text).toContain("5 template-sync PRs to v1.2.0 +14");
    expect(set?.text).toContain("once the stack is deployable");
  });

  test("once the stack is deployable again, the lanes it failed and the template set say so", () => {
    const f = fixtureFacts();
    const lc = f.lifecycle.data;
    if (!lc) throw new Error("fixture has lifecycle runs");
    const cut = Date.parse("2026-10-11T22:00:00Z");
    f.lifecycle.data = {
      ...lc,
      refresh: lc.refresh.filter((r) => Date.parse(r.createdAt) < cut),
      upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
    };
    const items = buildModel(f, FIXTURE_NOW).queue.items;
    const lanes = items.find((i) => i.id === "stack:lanes");
    expect(lanes?.text).toBe("deployable again; 5 fork lanes failed before it recovered");
    expect(lanes?.note).toBe("re-run now");
    expect(items.find((i) => i.id === "template-set")?.text).toBe(
      "5 template-sync PRs to v1.2.0 +14 · mergeable together after the lane re-run · review required",
    );
  });

  test("each line wears its worst state: a halt is red, a failing PR amber, an update calm", () => {
    const pill = Object.fromEntries(model.lines.map((l) => [l.fork.id, l.pill]));
    expect(pill).toEqual({
      partition: { label: "template update", kind: "waiting", tone: "info" },
      entitlements: { label: "sync halted", kind: "halted", tone: "error" },
      legal: { label: "sync blocked", kind: "blocked", tone: "warn" },
      schema: { label: "template update", kind: "waiting", tone: "info" },
      file: { label: "template update", kind: "waiting", tone: "info" },
    });
    expect(model.lines.filter((l) => l.current)).toHaveLength(0);
    const partition = model.lines.find((l) => l.fork.id === "partition");
    expect(partition?.stations.find((s) => s.id === "lane")?.state).toBe("stopped");
    expect(model.lines.find((l) => l.fork.id === "legal")?.upstream?.lag).toBe(4);
  });

  test("template currency: nobody is current and schema runs two commits past the release", () => {
    expect(model.template.current).toBe(0);
    expect(model.template.waiting).toBe(5);
    const schema = model.template.rows.find((r) => r.service === "schema");
    expect(schema?.label).toBe("v1.2.0 +2");
    expect(schema?.behind).toBe(12);
    const prewarm = model.template.changes.find((c) => c.pr === 247);
    expect(prewarm?.forks).toBe(4);
    expect(prewarm?.missing).not.toContain("schema");
  });

  test("the template ladder: one step per fork position, its changes read by what reaches a fork", () => {
    const steps = model.template.steps;
    expect(steps.map((s) => [s.label, s.head, s.adopted.length, s.changes.length])).toEqual([
      ["v1.2.0 +14", true, 0, 4],
      ["v1.2.0 +2", false, 1, 1],
      ["v1.2.0", false, 5, 0],
    ]);
    expect(steps[0]?.consequences).toEqual(["images", "actions", "workflows"]);
    expect(steps[0]?.templateOnly).toBe(1);
    expect(steps[1]?.adopted).toEqual(["schema"]);
    expect(steps[1]?.changes.map((c) => c.pr)).toEqual([247]);
  });

  test("a template path counts only when sync-config copies it into the forks", () => {
    const synced = {
      dirs: [".github/actions", "build", ".github/rulesets"],
      files: [".github/labels.json", ".github/template-workflows/build.yml"],
    };
    expect(consequenceOf("build/Dockerfile", synced)).toBe("images");
    expect(consequenceOf(".github/actions/java-build/action.yml", synced)).toBe("actions");
    expect(consequenceOf(".github/template-workflows/build.yml", synced)).toBe("workflows");
    expect(consequenceOf(".github/labels.json", synced)).toBe("settings");
    expect(consequenceOf(".github/rulesets/main.json", synced)).toBe("settings");
    expect(consequenceOf("doc/requirements.txt", synced)).toBeNull();
    expect(consequenceOf(".github/local-actions/x/run.sh", synced)).toBeNull();
    expect(consequenceOf(".github/workflows/dev-ci.yml", synced)).toBeNull();
  });

  test("a template-sync PR to main past the tag names main as git does, not the release PR's version", () => {
    const template = (svc: string) => model.lines.find((l) => l.fork.id === svc)?.template;
    expect(model.template.next).toBe("v1.2.1");
    expect(template("partition")).toMatchObject({
      label: "v1.2.0",
      target: "v1.2.0 +14",
    });
    expect(template("schema")).toMatchObject({
      label: "v1.2.0 +2",
      target: "v1.2.0 +14",
    });
  });

  test("with no release PR open, main past the tag reads the same", () => {
    const f = fixtureFacts();
    const template = f.github.data?.repos["Azure/osdu-spi"];
    if (!template) throw new Error("fixture has the template");
    template.prs = template.prs.filter((p) => !p.head.startsWith("release-please--"));
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "partition");
    expect(line?.template).toMatchObject({ label: "v1.2.0", target: "v1.2.0 +14" });
  });

  test("a fork already on main past the tag is on that commit, not on the release PR's version", () => {
    const f = fixtureFacts();
    const repo = f.github.data?.repos["Azure/osdu-spi-file"];
    const head = f.github.data?.repos["Azure/osdu-spi"]?.head?.sha;
    const compares = f.template.data?.compares;
    if (!repo || !head || !compares) throw new Error("fixture has the file fork and template");
    repo.marker = head;
    repo.prs = repo.prs.filter((p) => !p.head.startsWith("template-sync/"));
    compares[head] = { marker: head, head, label: "v1.2.0 +14", aheadBy: 0, shas: [], changes: [] };
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "file");
    expect(line?.template.label).toBe("v1.2.0 +14");
    expect(line?.pill.kind).toBe("current");
  });

  test("a failed Sync Template run stops the template line", () => {
    const f = fixtureFacts();
    const runs = f.runs.data?.["Azure/osdu-spi-partition"];
    if (!runs?.template[0]) throw new Error("fixture has partition template runs");
    runs.template[0] = { ...runs.template[0], conclusion: "failure" };
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "partition");
    expect(line?.pill).toEqual({ label: "template halted", kind: "halted", tone: "error" });
    expect(line?.why).toBe("Sync Template failed; template changes stop reaching this fork");
  });

  test("a fork behind the template with no template-sync PR is halted, not waiting", () => {
    const f = fixtureFacts();
    const repo = f.github.data?.repos["Azure/osdu-spi-file"];
    if (!repo) throw new Error("fixture has the file fork");
    repo.prs = repo.prs.filter((p) => !p.head.startsWith("template-sync/"));
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "file");
    expect(line?.pill.label).toBe("template halted");
    expect(line?.why).toBe("14 template commits behind and no template-sync PR open");
  });

  test("a template change newer than the last Sync Template run waits for the next run", () => {
    const f = fixtureFacts();
    const repos = f.github.data?.repos;
    const file = repos?.["Azure/osdu-spi-file"];
    const template = repos?.["Azure/osdu-spi"];
    if (!file || !template?.head) throw new Error("fixture has the file fork and the template");
    file.prs = file.prs.filter((p) => !p.head.startsWith("template-sync/"));
    template.head = { ...template.head, at: "2026-10-12T20:00:00Z" };
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "file");
    expect(line?.pill).toEqual({ label: "template behind", kind: "waiting", tone: "info" });
    expect(line?.template.awaitingRun).toBe(true);
  });

  test("a red main outranks every other state on its line", () => {
    const f = fixtureFacts();
    const runs = f.runs.data?.["Azure/osdu-spi-entitlements"];
    if (!runs?.main[0]) throw new Error("fixture has entitlements main runs");
    runs.main[0] = { ...runs.main[0], status: "completed", conclusion: "failure" };
    const line = buildModel(f, FIXTURE_NOW).lines.find((l) => l.fork.id === "entitlements");
    expect(line?.pill).toEqual({ label: "main red", kind: "broken", tone: "error" });
  });

  test("remote mode reads maintenance and the running version from lifecycle runs", () => {
    expect(model.stack.maintenance.state).toBe("set");
    expect(model.stack.running?.version).toBe("v0.28.0");
    expect(model.stack.inflight?.run.kind).toBe("upgrade");
  });
});

describe("before the first sweep", () => {
  test("nothing is measured and nothing is queued", () => {
    const empty = buildModel(emptyFacts(), FIXTURE_NOW);
    expect(empty.measured).toBe(false);
    expect(empty.queue.items.filter((i) => i.rung < 2)).toHaveLength(0);
    expect(empty.lines.every((l) => l.upstream?.lag === undefined)).toBe(true);
  });
});

// No live run has failed this way yet; the job detail in the fixture is synthesized in
// the shape GHCR returns for a private package.
const BORROW_401 = "Azure/osdu-spi-partition#115000000175";

function withDescriptorPr(f = fixtureFacts()) {
  const repo = f.github.data?.repos["Azure/osdu-spi-partition"];
  const detail = f.details.data?.[BORROW_401];
  if (!repo || !detail) throw new Error("fixture has partition and the Borrow 401");
  repo.prs.push({
    repo: repo.repo,
    number: 175,
    title: "feat(deploy): add the spi descriptor",
    url: "https://github.com/Azure/osdu-spi-partition/pull/175",
    createdAt: "2026-10-12T21:05:00Z",
    updatedAt: "2026-10-12T21:14:45Z",
    draft: false,
    head: "feat/spi-descriptor",
    base: "main",
    headSha: "3f9c2e1000000000000000000000000000000175",
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    author: "contributor",
    labels: [],
    checks: [
      {
        id: detail.id,
        name: "Deploy and Test",
        workflow: "Validation",
        runId: 38230000175,
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: detail.startedAt,
        completedAt: detail.completedAt,
        url: detail.url,
      },
    ],
  } as unknown as (typeof repo.prs)[number]);
  return f;
}

describe("a Borrow 401 on the fork's own image", () => {
  const items = buildModel(withDescriptorPr(), FIXTURE_NOW).queue.items;

  test("attributes to the fork as ACCESS, not ENV", () => {
    const m = buildModel(withDescriptorPr(), FIXTURE_NOW);
    const pr = m.lines.find((l) => l.fork.id === "partition")?.prs.find((p) => p.pr.number === 175);
    expect(pr?.failures.map((f) => [f.cls, f.step, f.reason])).toEqual([
      ["ACCESS", "Borrow", "cannot pull ghcr.io/azure/osdu-spi-partition: 401"],
    ]);
  });

  test("raises a P1 on the fork's PR that names the image and the code", () => {
    const access = items.find((i) => i.id === "access:Azure/osdu-spi-partition#175");
    expect(access).toMatchObject({
      rung: 1,
      scope: "partition",
      cls: "ACCESS",
      text: "PR #175: Borrow cannot pull ghcr.io/azure/osdu-spi-partition: 401",
    });
    expect(access && verbOf(access)).toBe("Open run, Open PR");
    expect(access && nextText(access)).toBe(
      "The fork's own image ghcr.io/azure/osdu-spi-partition cannot be pulled (401); the stack is not the cause",
    );
  });

  test("the stack incident does not fold it", () => {
    const stack = items.find((i) => i.kind === "stack");
    expect(stack?.effects.some((e) => e.text.includes("#175"))).toBe(false);
    expect(stack?.effects.some((e) => e.text.startsWith("partition template-sync PR"))).toBe(true);
    expect(items.some((i) => i.id === "stack:lanes")).toBe(false);
  });

  test("once the stack is deployable again, the lanes count only the stack's failures", () => {
    const f = withDescriptorPr();
    const lc = f.lifecycle.data;
    if (!lc) throw new Error("fixture has lifecycle runs");
    const cut = Date.parse("2026-10-11T22:00:00Z");
    f.lifecycle.data = {
      ...lc,
      refresh: lc.refresh.filter((r) => Date.parse(r.createdAt) < cut),
      upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
    };
    const after = buildModel(f, FIXTURE_NOW).queue.items;
    const lanes = after.find((i) => i.id === "stack:lanes");
    expect(lanes?.text).toBe("deployable again; 5 fork lanes failed before it recovered");
    expect(lanes?.effects.some((e) => e.text.includes("#175"))).toBe(false);
    expect(after.some((i) => i.id === "access:Azure/osdu-spi-partition#175")).toBe(true);
  });

  test("a Borrow or Verify failure with a stack reason stays ENV", () => {
    const job = (failedStep: string, reason: string) => ({
      id: 1,
      name: "Deploy and Test",
      status: "completed",
      url: "",
      steps: [],
      failedStep,
      reason,
    });
    const cls = (step: string, reason: string) =>
      classOf("Deploy and Test", "human", step, job(step, reason));
    expect(
      cls(
        "Borrow",
        "environment is not deployable after 10 minutes: The environment is in maintenance.",
      ),
    ).toBe("ENV");
    expect(cls("Borrow", "spi-redis: Reconciliation in progress")).toBe("ENV");
    expect(cls("Verify", "error: You must be logged in to the server (Unauthorized)")).toBe("ENV");
    expect(
      cls("Verify", 'Back-off pulling image "ghcr.io/azure/osdu-spi-legal:pr-9": 403 Forbidden'),
    ).toBe("ACCESS");
    expect(cls("Prove", "denied: ghcr.io/azure/osdu-spi-legal-test requires auth")).toBe("TEST");
  });
});

// The shape of a Validation push that ran no build: crs-conversion's init push, 13 October.
function skippedRun(
  f: ReturnType<typeof fixtureFacts>,
  repo: string,
  id: number,
  conclusion: string,
) {
  const runs = f.runs.data?.[repo];
  const newest = runs?.main[0];
  const jobs = newest && runs.mainRunJobs?.[String(newest.id)];
  if (!runs || !newest || !jobs) throw new Error(`fixture has ${repo} main jobs`);
  runs.main.unshift({
    ...newest,
    id,
    conclusion,
    createdAt: "2026-10-12T21:00:00Z",
    updatedAt: "2026-10-12T21:00:20Z",
    url: `https://github.com/${repo}/actions/runs/${id}`,
  });
  runs.mainRunJobs = {
    ...runs.mainRunJobs,
    [String(id)]: jobs.map((j) => ({
      ...j,
      id: j.id + 1_000_000,
      conclusion: /^(Deploy Gate|Validation Summary)$/.test(j.name) ? "success" : "skipped",
      steps: [],
      failedStep: undefined,
    })),
  };
  return runs;
}

describe("main reads only from a run whose Java Build ran", () => {
  const PARTITION = "Azure/osdu-spi-partition";
  const partition = (f: ReturnType<typeof fixtureFacts>) => {
    const m = buildModel(f, FIXTURE_NOW);
    return { m, line: m.lines.find((l) => l.fork.id === "partition") };
  };
  const station = (line: ReturnType<typeof partition>["line"]) =>
    line?.stations.find((s) => s.id === "main");

  test("a run whose Java Build was skipped, with no built run behind it, reads unproven", () => {
    const f = fixtureFacts();
    const runs = skippedRun(f, PARTITION, 38444623292, "success");
    runs.main = runs.main.slice(0, 1);
    const { m, line } = partition(f);
    expect(station(line)).toEqual({ id: "main", state: "unknown", text: "unproven" });
    expect(line?.mainRun).toBeUndefined();
    expect(line?.mainRed).toBeUndefined();
    expect(line?.pill.kind).not.toBe("broken");
    expect(m.queue.items.some((i) => i.id === "main:partition")).toBe(false);
  });

  test("a failed run whose Java Build was skipped sets nothing red", () => {
    const f = fixtureFacts();
    const runs = skippedRun(f, PARTITION, 38444623293, "failure");
    runs.main = runs.main.slice(0, 1);
    const { m, line } = partition(f);
    expect(station(line)?.text).toBe("unproven");
    expect(m.queue.items.some((i) => i.id === "main:partition")).toBe(false);
  });

  test("a skipped newest run over a built green run reads green from the built run", () => {
    const f = fixtureFacts();
    const built = f.runs.data?.[PARTITION]?.main[0];
    skippedRun(f, PARTITION, 38444623294, "success");
    const { line } = partition(f);
    expect(station(line)).toEqual({ id: "main", state: "idle", text: "idle" });
    expect(line?.mainRun?.id).toBe(built?.id);
  });

  test("a skipped newest run over a built red run stays red", () => {
    const f = fixtureFacts();
    const runs = f.runs.data?.[PARTITION];
    const built = runs?.main[0];
    const jobs = built && runs?.mainRunJobs?.[String(built.id)];
    if (!runs || !built || !jobs) throw new Error("fixture has partition main jobs");
    runs.main[0] = { ...built, conclusion: "failure" };
    runs.mainRunJobs = {
      [String(built.id)]: jobs.map((j) =>
        j.name === "Java Build" ? { ...j, conclusion: "failure", failedStep: "Build" } : j,
      ),
    };
    skippedRun(f, PARTITION, 38444623295, "success");
    const { m, line } = partition(f);
    expect(line?.mainRed?.run.id).toBe(built.id);
    expect(line?.mainRed?.job?.name).toBe("Java Build");
    expect(station(line)?.text).toBe("main red");
    expect(m.queue.items.find((i) => i.id === "main:partition")?.rung).toBe(0);
  });
});
