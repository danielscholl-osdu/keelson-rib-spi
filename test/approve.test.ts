import { afterEach, describe, expect, test } from "bun:test";
import { expectView, type RibExec } from "@keelson/shared";
import { APPROVE_RUNS, approveAction } from "../src/act/approve";
import { ActionLog } from "../src/act/log";
import { act } from "../src/act/path";
import { registerVerb } from "../src/act/verbs";
import { inspectBoard } from "../src/boards/inspect";
import { readApprovals } from "../src/collect/runs";
import type { OutsidePr, WaitingRun } from "../src/facts";
import { Gh } from "../src/forge";
import { INSPECT_KEY } from "../src/keys";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";

const STACK = "Azure/osdu-spi-stack";
const HEAD_343 = "541ab075615710332d1212659f536d027e6c72c3";
const HEAD_327 = "c1c308ae709bd66451a299509b69097888ac5f81";

const PR_343: OutsidePr = {
  number: 343,
  title: "fix(k8s): Harden Reference Catalog Downloads",
  url: "https://github.com/Azure/osdu-spi-stack/pull/343",
  author: "contributor-a",
  association: "CONTRIBUTOR",
  draft: false,
  headSha: HEAD_343,
  files: [".github/workflows/validate.yml", "k8s/reference/download.sh"],
  changedFiles: 2,
  additions: 90,
  deletions: 12,
};
const PR_327: OutsidePr = {
  number: 327,
  title: "feat: add RAFS service",
  url: "https://github.com/Azure/osdu-spi-stack/pull/327",
  author: "contributor-b",
  association: "FIRST_TIME_CONTRIBUTOR",
  draft: false,
  headSha: HEAD_327,
  files: Array.from({ length: 14 }, (_, i) => `services/rafs/file-${i}.yaml`),
  changedFiles: 41,
  additions: 2271,
  deletions: 81,
};

function run(id: number, name: string, sha: string, at: string, pr?: OutsidePr | null): WaitingRun {
  return {
    id,
    name,
    path: `.github/workflows/${name.toLowerCase()}.yml`,
    event: "pull_request",
    status: "completed",
    conclusion: "action_required",
    createdAt: at,
    updatedAt: at,
    sha,
    title: pr?.title ?? "feat: add RAFS service",
    url: `https://github.com/${STACK}/actions/runs/${id}`,
    attempt: 1,
    ...(pr !== undefined ? { pr } : {}),
  };
}

const WAITING: WaitingRun[] = [
  run(38380539981, "CodeQL", HEAD_343, "2026-10-12T20:01:49Z", PR_343),
  run(38380540082, "Validate", HEAD_343, "2026-10-12T20:01:49Z", PR_343),
  run(38268575770, "CodeQL", HEAD_327, "2026-10-12T15:12:52Z", PR_327),
  run(38268575898, "Validate", HEAD_327, "2026-10-12T15:12:52Z", PR_327),
  run(
    38260195110,
    "CodeQL",
    "1ad08ed999501f788a48cce241ca3a289a4dbb38",
    "2026-10-12T14:04:03Z",
    null,
  ),
  run(
    38260194924,
    "Validate",
    "1ad08ed999501f788a48cce241ca3a289a4dbb38",
    "2026-10-12T14:04:03Z",
    null,
  ),
];

function modelWith(waiting: WaitingRun[]) {
  const facts = fixtureFacts();
  facts.approvals.data = { ...facts.approvals.data, [STACK]: waiting };
  return buildModel(facts, FIXTURE_NOW);
}

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("waiting runs in the queue", () => {
  test("group by the PR at their head; runs on superseded heads have nothing to approve", () => {
    const item = modelWith(WAITING).queue.items.find((i) => i.id === `approvals:${STACK}`);
    expect(item?.rung).toBe(1);
    expect(item?.text).toBe("2 outside PRs wait for workflow approval");
    expect(item?.since).toBe("2026-10-12T15:12:52Z");
    expect(item?.approve?.map((a) => [a.pr.number, a.runs.length, a.workflowFiles])).toEqual([
      [327, 2, []],
      [343, 2, [".github/workflows/validate.yml"]],
    ]);
    expect(item?.cause.find((f) => f.label === "superseded")?.value).toBe(
      "2 runs on heads since pushed past; nothing to approve",
    );
  });

  test("only superseded runs leave no item; unread PRs fall back to counting titles", () => {
    const stale = WAITING.slice(4);
    expect(modelWith(stale).queue.items.find((i) => i.id === `approvals:${STACK}`)).toBeUndefined();
    const unread = WAITING.map(({ pr: _, ...r }) => r);
    const item = modelWith(unread).queue.items.find((i) => i.id === `approvals:${STACK}`);
    expect(item?.text).toBe("2 outside PRs wait for workflow approval");
    expect(item?.approve).toBeUndefined();
  });
});

describe("the approve button", () => {
  test("names the author, the diff and the files, and lists one call per run", () => {
    const model = modelWith(WAITING);
    const a = model.queue.items.find((i) => i.kind === "approvals")?.approve?.[0];
    if (!a) throw new Error("no approval");
    const button = approveAction(a, { item: `approvals:${STACK}`, swept: "2026-10-12T21:58:30Z" });
    expect(button.label).toBe("Approve #327 · 2 runs");
    expect(button.confirm?.irreversible).toBeUndefined();
    const body = button.confirm?.body ?? "";
    expect(body).toContain(
      "#327 feat: add RAFS service, by contributor-b (first-time-contributor) · 41 files · +2271 −81.",
    );
    expect(body).toContain("services/rafs/file-7.yaml, and 33 more.");
    expect(body).not.toContain("file-8.yaml");
    expect(body).toContain(`gh api --method POST repos/${STACK}/actions/runs/38268575770/approve`);
    expect(body).toContain(`gh api --method POST repos/${STACK}/actions/runs/38268575898/approve`);
  });

  test("a PR that changes .github/ is approved only after its number is typed", () => {
    const model = modelWith(WAITING);
    const a = model.queue.items.find((i) => i.kind === "approvals")?.approve?.[1];
    if (!a) throw new Error("no approval");
    const button = approveAction(a, { item: `approvals:${STACK}`, swept: "2026-10-12T21:58:30Z" });
    expect(button.confirm).toMatchObject({
      irreversible: true,
      subject: "343",
      label: "Type 343: this PR changes .github/",
    });
    expect(button.confirm?.body).toContain(
      "It changes .github/workflows/validate.yml, and approved runs execute that change.",
    );
  });

  test("the inspector lists each PR with a button, and validates", () => {
    const model = modelWith(WAITING);
    const id = `approvals:${STACK}`;
    const b = inspectBoard(model, { selected: id }, FIXTURE_NOW);
    expect(() => expectView(INSPECT_KEY, "board")(b)).not.toThrow();
    const prs = b.sections.find((s) => s.kind === "rows" && s.title === "Outside PRs · 2");
    if (prs?.kind !== "rows") throw new Error("no PR rows");
    expect(prs.items.map((r) => [r.chip?.label, r.text, r.trailing])).toEqual([
      [undefined, "#327 feat: add RAFS service", "contributor-b · 41 files · +2271 −81"],
      [
        ".github",
        "#343 fix(k8s): Harden Reference Catalog Downloads",
        "contributor-a · 2 files · +90 −12",
      ],
    ]);
    const actions = b.sections.find((s) => s.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("no actions");
    expect(actions.items.map((i) => i.label)).toEqual([
      "Approve #327 · 2 runs",
      "Approve #343 · 2 runs",
    ]);
    expect(b.sections.some((s) => s.kind === "rows" && s.title?.startsWith("Effects"))).toBe(false);

    const noRepo = inspectBoard(model, { selected: id }, FIXTURE_NOW, undefined, {
      scopes: ["gist", "workflow"],
    });
    const blocked = noRepo.sections.find((s) => s.kind === "actions");
    if (blocked?.kind !== "actions") throw new Error("no actions");
    expect(blocked.items[0]).toMatchObject({
      disabled: true,
      reason: "gh's token lacks the repo scope; run gh auth refresh -s repo",
    });
  });
});

// GitHub as the approve verb finds it: run and PR reads answer from `state`.
function github(state: { prSha: string; prState?: string; run?: string }) {
  const writes: string[][] = [];
  const exec: RibExec = {
    runJSON: async (_cmd: string, args: string[]) => {
      const path = args[1] ?? "";
      const data = path.includes("/pulls/")
        ? { state: state.prState ?? "open", merged: false, sha: state.prSha }
        : { status: "completed", conclusion: state.run ?? "action_required", sha: HEAD_343 };
      return { ok: true as const, data: data as never };
    },
    runText: async (_cmd: string, args: string[]) => {
      writes.push(args);
      return { ok: true as const, data: "" };
    },
  };
  return { exec, writes };
}

describe("approving through the action path", () => {
  function approve343(exec: RibExec, log = new ActionLog(undefined)) {
    unregister = registerVerb(APPROVE_RUNS);
    const a = modelWith(WAITING).queue.items.find((i) => i.kind === "approvals")?.approve?.[1];
    if (!a) throw new Error("no approval");
    const button = approveAction(a, { item: `approvals:${STACK}`, swept: "2026-10-12T21:58:30Z" });
    return act(button.binding, { exec, log, resweep: () => {}, now: () => FIXTURE_NOW });
  }

  test("an unchanged PR has each waiting run approved", async () => {
    const { exec, writes } = github({ prSha: HEAD_343 });
    const res = await approve343(exec);
    expect(res).toEqual({ ok: true, data: { message: "Approve runs: 2 of 2 done" } });
    expect(writes).toEqual([
      ["api", "--method", "POST", `repos/${STACK}/actions/runs/38380539981/approve`],
      ["api", "--method", "POST", `repos/${STACK}/actions/runs/38380540082/approve`],
    ]);
  });

  test("a push to the PR after the board drew it refuses every run", async () => {
    const { exec, writes } = github({ prSha: "9999999aaaaaaa" });
    const res = await approve343(exec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("#343 CodeQL skipped (head moved 541ab07 → 9999999)");
    expect(writes).toEqual([]);
  });

  test("a closed PR, or a run someone already approved, is not approved again", async () => {
    const closed = github({ prSha: HEAD_343, prState: "closed" });
    const res = await approve343(closed.exec);
    if (!res.ok) expect(res.error).toContain("now PR #343 closed, was action_required");
    expect(closed.writes).toEqual([]);
    unregister?.();
    const running = github({ prSha: HEAD_343, run: "in_progress" });
    expect((await approve343(running.exec)).ok).toBe(false);
    expect(running.writes).toEqual([]);
  });
});

describe("reading waiting runs", () => {
  test("matches each run to the open PR at its head and reads its files once per head", async () => {
    let fileReads = 0;
    const exec: RibExec = {
      runJSON: async (_cmd: string, args: string[]) => {
        const path = args[1] ?? "";
        const ok = (data: unknown) => ({ ok: true as const, data: data as never });
        if (path.startsWith(`repos/${STACK}/actions/runs`)) {
          return ok(
            WAITING.map((r) => ({
              id: r.id,
              name: r.name,
              path: r.path,
              event: r.event,
              status: r.status,
              conclusion: r.conclusion,
              created_at: r.createdAt,
              updated_at: r.updatedAt,
              head_branch: null,
              head_sha: r.sha,
              display_title: r.title,
              html_url: r.url,
              run_attempt: 1,
            })),
          );
        }
        if (path.includes("/actions/runs")) return ok([]);
        if (path.endsWith("pulls?state=open&per_page=100")) {
          return ok(
            [PR_343, PR_327].map((p) => ({
              number: p.number,
              title: p.title,
              url: p.url,
              author: p.author,
              association: p.association,
              draft: p.draft,
              sha: p.headSha,
            })),
          );
        }
        if (path.includes("/files")) {
          fileReads++;
          const p = path.includes("/343/") ? PR_343 : PR_327;
          return ok(p.files.map((f) => ({ path: f, additions: 1, deletions: 0 })));
        }
        const p = path.endsWith("/343") ? PR_343 : PR_327;
        return ok({ changed: p.changedFiles, additions: p.additions, deletions: p.deletions });
      },
      runText: async () => ({ ok: false as const, error: "no writes", code: 1 }),
    };
    const cache = {};
    const first = await readApprovals(new Gh(exec), cache);
    expect(first[STACK]?.map((r) => r.pr?.number ?? r.pr)).toEqual([
      343,
      343,
      327,
      327,
      null,
      null,
    ]);
    expect(first[STACK]?.[0]?.pr).toEqual(PR_343);
    expect(fileReads).toBe(2);
    await readApprovals(new Gh(exec), cache);
    expect(fileReads).toBe(2);
  });
});
