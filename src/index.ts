// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CanvasBoardView,
  expectView,
  type Rib,
  type RibAction,
  type RibActionResult,
  type RibAgentTurn,
  type RibAgentTurnRequest,
  type RibContext,
  type RibExec,
  type RibSurfaceBadge,
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import { APPROVE_RUNS } from "./act/approve.ts";
import { ActionLog } from "./act/log.ts";
import { act, parseBinding } from "./act/path.ts";
import { type Readiness, readReadiness } from "./act/readiness.ts";
import {
  DeployableWait,
  DISPATCH_REFRESH,
  DISPATCH_UPGRADE,
  NO_OPS,
  RERUN_LANES,
  WAIT_ACTION,
} from "./act/rerun.ts";
import { ROLL_OUT, ROLLOUT_ITEM, SYNC_FORKS } from "./act/rollout.ts";
import { ACT_ACTION, registerVerb } from "./act/verbs.ts";
import { AGENTS, resolveAgent } from "./agent.ts";
import { badge } from "./boards/badge.ts";
import { consoleHtml, expectHtml } from "./boards/console.ts";
import { DOCTOR_ID, doctorBoard, doctorStatus } from "./boards/doctor.ts";
import { type InspectState, inspectBoard, inspectTitle, stepTitle } from "./boards/inspect.ts";
import { MR_PREFIX, mrTitle } from "./boards/radar.ts";
import {
  type NotesUpdate,
  RELEASE_NOTES_ACTION,
  RELEASE_OPEN_ACTION,
  RELEASE_PDF_ACTION,
  RELEASE_STATUS_ACTION,
  RELEASE_UPDATE_ACTION,
  releaseBoard,
  releaseDocHtml,
  releaseHtmlEmpty,
  releasePrintHtml,
  releaseTitle,
} from "./boards/release.ts";
import { repoTitle } from "./boards/repo.ts";
import { STEP_PREFIX } from "./boards/template.ts";
import { buildBriefing } from "./brief/index.ts";
import { RELEASE_PREFIX, type ReleaseDoc, releaseDoc, releaseLine } from "./brief/release.ts";
import { REPO_PREFIX } from "./brief/repos.ts";
import { checkable, entryAcrossForks, type ForkEntry } from "./collect/filters.ts";
import { ReleaseReader } from "./collect/releases.ts";
import { FORKS, INFLIGHT_POLL_MS, SWEEP_MS } from "./config.ts";
import { Gh, Glab } from "./forge.ts";
import { BADGE_KEY, CONSOLE_KEY, INSPECT_KEY, RELEASE_KEY, RIB_ID } from "./keys.ts";
import type { QueueItem } from "./model/queue.ts";
import { isMonth, monthFacts, monthName, releaseMonths } from "./model/releases.ts";
import { DRAFT_SYSTEM, draftPrompt, parseDraft } from "./notes/draft.ts";
import {
  createNotes,
  notesDir,
  notesPath,
  notesText,
  parseNotes,
  readNotes,
  setNotesStatus,
  watchNotes,
  writeDraft,
} from "./notes/file.ts";
import { findBrowser, pdfDir, writePdf } from "./notes/pdf.ts";
import { Store } from "./store.ts";
import { INSPECT_ACTION, REFRESH_ACTION, SURFACES } from "./surfaces.ts";
import { Sweeper } from "./sweep.ts";
import { registerSpiTools } from "./tools.ts";
import { errorText } from "./util.ts";

type Composer = (sweeper: Sweeper, now: Date) => CanvasBoardView;

// Filter files and upstream trees move slowly; one read serves repeat opens of a halt.
const OTHERS_TTL_MS = 10 * 60_000;

const VIEW_KEYS = [INSPECT_KEY] as const;

let inspect: InspectState = {};
let actionLog = new ActionLog(undefined);
let readiness: Readiness | undefined;
const othersCache = new Map<string, { at: number; entries: ForkEntry[] }>();
// Months the Releases tab lists; older months stay readable through spi_release_notes.
const RELEASE_MONTHS = 12;
// Re-run waits by queue item, in memory only: a restart drops them and the item stays queued.
const waits = new Map<string, DeployableWait>();

const COMPOSERS: Record<(typeof VIEW_KEYS)[number], Composer> = {
  [INSPECT_KEY]: (s, now) =>
    inspect.selected === DOCTOR_ID
      ? doctorBoard(s.facts, now, readiness)
      : inspect.selected?.startsWith(RELEASE_PREFIX)
        ? releaseInspector(inspect.selected.slice(RELEASE_PREFIX.length), now)
        : inspectBoard(s.model, inspect, now, actionLog.lastFor(lastKey(inspect.selected)), {
            scopes: s.facts.auth.data?.gh.scopes,
            ops: !!context?.registerOp,
            ...waitingFor(inspect.selected),
          }),
};

// Rollout verbs log under one item, whichever template-set id the inspector shows.
function lastKey(selected: string | undefined): string | undefined {
  return selected === "template-set" ? ROLLOUT_ITEM : selected;
}

function badgeOf(data: unknown): RibSurfaceBadge {
  const count = (data as RibSurfaceBadge | null)?.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new Error(`${BADGE_KEY} expects a whole count`);
  }
  return data as RibSurfaceBadge;
}

let releases: ReleaseReader | undefined;
let releaseMonth: string | undefined;
const lastPdf = new Map<string, { path: string; at: string }>();
const notesUpdates = new Map<string, NotesUpdate>();
const updateAborts = new Set<AbortController>();
const UPDATE_TIMEOUT_MS = 10 * 60_000;

let snapshots: SnapshotManager | undefined;
let context: RibContext | undefined;
let sweeper: Sweeper | undefined;
let exec: RibExec | undefined;
let unregisters: Array<() => void> = [];
let timers: Array<ReturnType<typeof setInterval>> = [];

function recomposeAll(): void {
  for (const key of [...VIEW_KEYS, CONSOLE_KEY, BADGE_KEY, RELEASE_KEY]) {
    snapshots?.recompose(key).catch(() => undefined);
  }
}

let unwatchNotes: (() => void) | undefined;

function watchNotesFolder(): void {
  if (unwatchNotes) return;
  unwatchNotes = watchNotes(notesFolder(), () => {
    for (const key of [CONSOLE_KEY, RELEASE_KEY, INSPECT_KEY]) {
      snapshots?.recompose(key).catch(() => undefined);
    }
  });
}

function notesFolder(): string {
  return notesDir(context?.getDataDir?.());
}

function monthDoc(month: string, now: Date): ReleaseDoc | undefined {
  const r = releases;
  if (!r) return undefined;
  return releaseDoc(monthFacts(r.data, month, now), readNotes(notesFolder(), month), now);
}

function releaseInspector(month: string, now: Date) {
  const doc = monthDoc(month, now);
  if (!doc) {
    return {
      view: "board" as const,
      sections: [
        {
          kind: "rows" as const,
          items: [{ glyph: "neutral" as const, text: "Releases are not read yet." }],
        },
      ],
    };
  }
  const notes = readNotes(notesFolder(), month);
  const data = releases?.data;
  return releaseBoard({
    doc,
    notesPath: notes.path,
    notesExists: notes.state !== "missing",
    ...(lastPdf.get(month) ? { lastPdf: lastPdf.get(month) } : {}),
    ...(data?.at ? { readAt: data.at } : {}),
    errors: Object.entries(data?.errors ?? {}).map(([k, e]) => `${k}: ${e}`),
    pdfReady: !!findBrowser(),
    agentReady: !!context?.runAgentTurn,
    ...(notesUpdates.get(month) ? { update: notesUpdates.get(month) } : {}),
  });
}

function releasesPane(now: Date) {
  const r = releases;
  if (!r) return undefined;
  const lines = releaseMonths(r.data, now)
    .slice(0, RELEASE_MONTHS)
    .map((m) => monthDoc(m, now))
    .filter((d): d is ReleaseDoc => !!d)
    .map(releaseLine);
  return { lines, reading: r.busy };
}

async function exportPdf(month: string, now: Date): Promise<RibActionResult> {
  const run = exec;
  const doc = monthDoc(month, now);
  if (!run || !doc) return { ok: false, error: "releases are not read yet" };
  const dataDir = context?.getDataDir?.();
  const res = await writePdf(run, {
    html: releasePrintHtml(doc),
    name: doc.name,
    approved: doc.notes === "approved",
    workDir: `${notesFolder()}/.print`,
    outDir: pdfDir(dataDir),
  });
  if (!res.ok) return { ok: false, error: res.error };
  lastPdf.set(month, { path: res.path, at: now.toISOString() });
  if (process.platform === "darwin") run.runText("open", ["-R", res.path]).catch(() => undefined);
  snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  return { ok: true, data: { message: `Saved ${res.path}` } };
}

const NOTES_FIELDS = {
  status: '"draft" until a person reviews it, then "approved"',
  headline: "one sentence naming the month's outcome for a consumer",
  keyChanges: "up to three sentences",
  actions:
    '[{ level: "required" | "recommended" | "info", title, body?, owner?, when?, ifSkipped? }]',
  highlights:
    '[{ title, body?, visual?: "coverage" | "library" | "commands" | "steps", items?: [{ text, sub? }] }]; coverage and library draw from the facts, commands and steps from items',
  knownIssues: '[{ state: "open" | "resolved", title, body? }]',
  changelog:
    '[{ area, items: [{ type: "breaking" | "new" | "improved" | "fixed" | "security", text }] }]; omit to show the computed changelog',
};

function releaseNotesTool(asked: string | undefined): unknown {
  const r = releases;
  const s = sweeper;
  if (!r || !s) throw new Error("spi is not bound yet");
  const now = s.now();
  const month = asked ?? now.toISOString().slice(0, 7);
  const facts = monthFacts(r.data, month, now);
  const notes = readNotes(notesFolder(), month);
  return {
    month,
    months: releaseMonths(r.data, now),
    readAt: r.data.at ?? null,
    notes: {
      path: notes.path,
      state: notes.state,
      ...(notes.state === "invalid" ? { error: notes.error } : {}),
      ...(notes.state === "ok" ? { content: notes.notes } : {}),
      fields: NOTES_FIELDS,
    },
    facts: {
      label: facts.label,
      through: facts.through,
      open: facts.open,
      releases: facts.releases,
      repositoriesReleased: facts.released,
      services: facts.services,
      stack: facts.stack ?? null,
      template: facts.template ?? null,
      coreLibAzure: facts.libs,
      dependencyUpdates: facts.deps,
      unread: facts.unread,
      components: facts.components.map((c) => ({
        id: c.id,
        kind: c.kind,
        from: c.from ?? null,
        to: c.to ?? null,
        releases: c.unread ? null : c.count,
        upstream: c.upstream ?? null,
        ...(c.kind === "service"
          ? { coreLibAzure: c.pins?.lib ?? null, java: c.pins?.java ?? null }
          : {}),
      })),
    },
    candidates: facts.changes.map((c) => `${c.type} · ${c.component} ${c.tag} · ${c.text}`),
  };
}

// The agent gets no tools: the rib checks its reply and writes the file itself.
function startNotesUpdate(month: string, now: Date): RibActionResult {
  const ctx = context;
  const run = ctx?.runAgentTurn;
  if (!ctx || !run) return { ok: false, error: "this host runs no agent turns for ribs" };
  if (!releases?.data.at) return { ok: false, error: "releases are not read yet" };
  const name = monthName(month);
  if (notesUpdates.get(month)?.state === "running") {
    return { ok: false, error: `SPI ${name} notes are already updating` };
  }
  const dir = notesFolder();
  let before: string | undefined;
  try {
    before = notesText(dir, month);
  } catch (err) {
    return { ok: false, error: `${notesPath(dir, month)} could not be read: ${errorText(err)}` };
  }
  const read = parseNotes(notesPath(dir, month), before);
  if (read.state === "invalid") {
    return { ok: false, error: `${read.path} does not parse: ${read.error}; fix it first` };
  }
  if (read.state === "ok" && read.notes.status === "approved") {
    return { ok: false, error: "approved notes are not updated; set them back to draft first" };
  }
  const { notes, ...facts } = releaseNotesTool(month) as {
    notes: { fields: unknown };
  } & Record<string, unknown>;
  const prompt = draftPrompt(
    month,
    { ...facts, fields: notes.fields },
    read.state === "ok" ? read.notes : undefined,
  );
  const op = ctx.registerOp?.({
    kind: RELEASE_UPDATE_ACTION,
    title: `Update SPI ${name} release notes`,
  });
  const abort = new AbortController();
  op?.signal.addEventListener("abort", () => abort.abort());
  updateAborts.add(abort);
  const at = now.toISOString();
  notesUpdates.set(month, { state: "running", at });
  snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  draftTurn(run, prompt, abort.signal)
    .then((reply) => {
      if (!updateAborts.has(abort)) return;
      const current = read.state === "ok" ? read.notes : undefined;
      const parsed = abort.signal.aborted
        ? { ok: false as const, error: "the update was cancelled" }
        : reply.ok
          ? parseDraft(reply.text, current)
          : reply;
      const wrote = parsed.ok ? writeDraft(dir, month, parsed.notes, before, at) : parsed;
      notesUpdates.set(
        month,
        wrote.ok
          ? { state: "done", at, ...(wrote.kept ? { kept: wrote.kept } : {}) }
          : { state: "failed", at, error: wrote.error },
      );
      if (wrote.ok) op?.done({ path: wrote.path });
      else op?.error(wrote.error);
      recomposeAll();
    })
    .catch(() => undefined)
    .finally(() => updateAborts.delete(abort));
  return {
    ok: true,
    data: { message: `Updating SPI ${name} release notes${op ? ` as op ${op.id}` : ""}` },
  };
}

async function draftTurn(
  run: (req: RibAgentTurnRequest) => RibAgentTurn,
  prompt: string,
  signal: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const turn = run({
      system: DRAFT_SYSTEM,
      prompt,
      allowedTools: [],
      modelClass: "deep",
      timeoutMs: UPDATE_TIMEOUT_MS,
      abortSignal: signal,
    });
    try {
      for await (const _ of turn.stream) {
      }
    } catch {
      // A stream error surfaces in the result.
    }
    const result = await turn.result;
    return result.status === "ok"
      ? { ok: true, text: result.text }
      : { ok: false, error: result.error ?? `the agent turn ended ${result.status}` };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

function waitingFor(id: string | undefined): { waiting?: { id: string; at: string } } {
  const w = id ? waits.get(id) : undefined;
  return w && !w.settled ? { waiting: { id: w.op.id, at: w.at } } : {};
}

function wakeWaits(s: Sweeper): void {
  for (const [item, w] of waits) {
    w.wake(s.model.stack)
      .then((over) => {
        if (!over || waits.get(item) !== w) return;
        waits.delete(item);
        snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      })
      .catch(() => undefined);
  }
}

function actDeps(s: Sweeper, run: RibExec) {
  return { exec: run, log: actionLog, resweep: () => resweep(s), now: s.now };
}

function bind(ctx: RibContext): Sweeper {
  unbind();
  snapshots = ctx.getSnapshotManager?.();
  context = ctx;
  exec = ctx.getExec();
  actionLog = new ActionLog(ctx.getDataDir?.());
  const s = new Sweeper({
    exec,
    store: new Store(ctx.getDataDir?.()),
    onChange: () => {
      recomposeAll();
      if (sweeper) wakeWaits(sweeper);
    },
  });
  sweeper = s;
  const reader = new ReleaseReader(
    new Gh(exec),
    new Store(ctx.getDataDir?.()),
    () => s.now(),
    () => {
      for (const key of [CONSOLE_KEY, RELEASE_KEY, INSPECT_KEY]) {
        snapshots?.recompose(key).catch(() => undefined);
      }
    },
  );
  releases = reader;
  watchNotesFolder();
  unregisters.push(
    registerVerb(APPROVE_RUNS),
    registerVerb(SYNC_FORKS),
    registerVerb(ROLL_OUT),
    registerVerb(RERUN_LANES),
    registerVerb(DISPATCH_REFRESH),
    registerVerb(DISPATCH_UPGRADE),
  );
  const sm = snapshots;
  if (sm) {
    for (const key of VIEW_KEYS) {
      const compose = COMPOSERS[key];
      unregisters.push(
        sm.register(key, () => compose(s, s.now()), { validate: expectView(key, "board") }),
      );
    }
    unregisters.push(
      sm.register(
        CONSOLE_KEY,
        () => {
          const now = s.now();
          return consoleHtml(
            buildBriefing(s.model, doctorStatus(s.facts, now), now),
            now,
            releasesPane(now),
          );
        },
        { validate: expectHtml },
      ),
    );
    unregisters.push(
      sm.register(
        RELEASE_KEY,
        () => {
          const doc = releaseMonth ? monthDoc(releaseMonth, s.now()) : undefined;
          return doc ? releaseDocHtml(doc) : releaseHtmlEmpty();
        },
        { validate: expectHtml },
      ),
    );
    unregisters.push(sm.register(BADGE_KEY, () => badge(s.model), { validate: badgeOf }));
  }
  recomposeAll();
  s.sweep({ force: true }).catch(() => undefined);
  reader.read().catch(() => undefined);
  refreshReadiness();
  const sweepTimer = setInterval(() => {
    s.sweep().catch(() => undefined);
    reader.read().catch(() => undefined);
    refreshReadiness();
  }, SWEEP_MS);
  const pollTimer = setInterval(() => {
    if (s.hasInflight()) s.pollInflight().catch(() => undefined);
  }, INFLIGHT_POLL_MS);
  sweepTimer.unref?.();
  pollTimer.unref?.();
  timers = [sweepTimer, pollTimer];
  return s;
}

function unbind(): void {
  for (const w of waits.values()) w.drop("the SPI rib was unloaded; the wait is dropped");
  waits.clear();
  for (const un of unregisters) un();
  unregisters = [];
  for (const t of timers) clearInterval(t);
  timers = [];
  unwatchNotes?.();
  unwatchNotes = undefined;
  snapshots = undefined;
  sweeper = undefined;
  context = undefined;
  readiness = undefined;
  releases = undefined;
  releaseMonth = undefined;
  lastPdf.clear();
  for (const a of updateAborts) a.abort();
  updateAborts.clear();
  notesUpdates.clear();
  exec = undefined;
  inspect = {};
  othersCache.clear();
}

function refreshReadiness(): void {
  const ctx = context;
  if (!ctx || !exec) return;
  readReadiness(exec, ctx.getProjects?.())
    .then((r) => {
      if (context !== ctx) return;
      readiness = r;
      snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
    })
    .catch(() => undefined);
}

// A sweep already running may have read before the write landed, so wait it out
// and read again.
function resweep(s: Sweeper): void {
  (async () => {
    if (s.sweeping) await s.sweep().catch(() => undefined);
    await s.sweep({ force: true }).catch(() => undefined);
  })();
}

function othersKey(item: QueueItem): string | undefined {
  if (!checkable(item.halt)) return undefined;
  return `${item.halt.fork}:${item.halt.code}:${item.halt.entries.join(",")}`;
}

function cachedOthers(item: QueueItem, now: number): ForkEntry[] | undefined {
  const key = othersKey(item);
  const hit = key ? othersCache.get(key) : undefined;
  return hit && now - hit.at < OTHERS_TTL_MS ? hit.entries : undefined;
}

// Reads the other forks after the drawer is open, and fills them in only if the
// operator is still looking at the same item.
function readOthers(item: QueueItem): void {
  const key = othersKey(item);
  const run = exec;
  if (!key || !run || !checkable(item.halt)) return;
  entryAcrossForks(new Gh(run), new Glab(run), item.halt)
    .then((entries) => {
      othersCache.set(key, { at: Date.now(), entries });
      if (inspect.selected !== item.id) return;
      inspect = { ...inspect, reading: undefined, others: { id: item.id, entries } };
    })
    .catch(() => {
      if (inspect.selected === item.id) inspect = { ...inspect, reading: undefined };
    })
    .finally(() => {
      if (inspect.selected === item.id) snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
    });
}

// The op holds the binding stamped at click time and acts through act() once deployable.
function startWait(s: Sweeper, payload: unknown): RibActionResult {
  const ctx = context;
  const run = exec;
  if (!ctx || !run) return { ok: false, error: "spi is not bound yet" };
  if (!ctx.registerOp) return { ok: false, error: NO_OPS };
  const binding = parseBinding(payload);
  if (!binding || binding.verb !== RERUN_LANES.id) {
    return { ok: false, error: "the wait needs the Re-run lanes binding the board stamped" };
  }
  if (s.model.stack.deployable.state === "yes") {
    return { ok: false, error: "the stack is deployable now; the board redraws with Re-run lanes" };
  }
  const held = waits.get(binding.item);
  if (held && !held.settled) {
    return { ok: false, error: `a wait already holds this item as op ${held.op.id}` };
  }
  const n = binding.targets.length;
  const op = ctx.registerOp({
    kind: WAIT_ACTION,
    title: `Re-run ${n === 1 ? "1 fork lane" : `${n} fork lanes`} when the stack is deployable`,
  });
  const wait = new DeployableWait(op, binding, s.now().toISOString(), s.model.stack, (b) =>
    act(b, actDeps(s, run)),
  );
  waits.set(binding.item, wait);
  op.signal.addEventListener("abort", () => {
    if (waits.get(binding.item) !== wait) return;
    wait.wake(s.model.stack).catch(() => undefined);
    waits.delete(binding.item);
    snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  });
  snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
  return {
    ok: true,
    data: {
      message: `Waiting for the stack to read deployable as op ${op.id}; run_cancel drops it`,
    },
  };
}

const rib: Rib = {
  id: RIB_ID,
  displayName: "SPI",

  views: [
    { key: CONSOLE_KEY, canvasKind: "html", title: "SPI console" },
    { key: RELEASE_KEY, canvasKind: "html", title: "SPI release notes" },
    ...VIEW_KEYS.map(
      (key): RibViewDescriptor => ({
        key,
        canvasKind: "view",
        title: `SPI: ${key.split(":").pop()}`,
      }),
    ),
  ],

  surfaces: SURFACES,

  // Composers bind here because this is the first hook that receives the context.
  registerTools: (ctx: RibContext) => registerSpiTools(bind(ctx), releaseNotesTool),

  onAction: async (action: RibAction): Promise<RibActionResult> => {
    const s = sweeper;
    if (!s) return { ok: false, error: "spi is not bound yet" };
    // Console markup is untrusted by contract: it may select and open the inspector, never act.
    if (action.origin === "canvas-html" && action.type !== INSPECT_ACTION) {
      return { ok: false, error: "the console only opens the inspector; act from its buttons" };
    }
    if (action.type === REFRESH_ACTION) {
      if (s.sweeping) return { ok: true, data: { message: "A sweep is already running" } };
      s.sweep({ force: true }).catch(() => undefined);
      releases?.read({ force: true }).catch(() => undefined);
      return { ok: true, data: { message: "Sweeping GitHub and GitLab" } };
    }
    if (
      action.type === RELEASE_OPEN_ACTION ||
      action.type === RELEASE_PDF_ACTION ||
      action.type === RELEASE_NOTES_ACTION ||
      action.type === RELEASE_STATUS_ACTION ||
      action.type === RELEASE_UPDATE_ACTION
    ) {
      const payload = action.payload as { month?: unknown; status?: unknown } | undefined;
      const month = payload?.month;
      if (typeof month !== "string" || !isMonth(month)) {
        return { ok: false, error: "release actions need { month: 'YYYY-MM' }" };
      }
      const now = s.now();
      if (action.type === RELEASE_PDF_ACTION) return exportPdf(month, now);
      if (action.type === RELEASE_UPDATE_ACTION) return startNotesUpdate(month, now);
      if (action.type === RELEASE_NOTES_ACTION) {
        const made = createNotes(notesFolder(), month);
        recomposeAll();
        return {
          ok: true,
          data: { message: made.created ? `Created ${made.path}` : `${made.path} already exists` },
        };
      }
      if (action.type === RELEASE_STATUS_ACTION) {
        const status = payload?.status;
        if (status !== "approved" && status !== "draft") {
          return { ok: false, error: "release-notes-status needs status 'approved' or 'draft'" };
        }
        const set = setNotesStatus(notesFolder(), month, status);
        if (!set.ok) return { ok: false, error: set.error };
        recomposeAll();
        const name = monthName(month);
        return {
          ok: true,
          data: {
            message: !set.changed
              ? `SPI ${name} notes are already ${status}`
              : status === "approved"
                ? `Approved SPI ${name} release notes`
                : `SPI ${name} release notes are a draft again`,
          },
        };
      }
      const doc = monthDoc(month, now);
      if (!doc) return { ok: false, error: "releases are not read yet" };
      releaseMonth = month;
      await snapshots?.recompose(RELEASE_KEY).catch(() => undefined);
      return {
        ok: true,
        data: { effect: "open-canvas" as const, key: RELEASE_KEY, title: releaseTitle(doc) },
      };
    }
    if (action.type === ACT_ACTION) {
      if (!exec) return { ok: false, error: "spi is not bound yet" };
      const started = s.now().toISOString();
      const result = await act(action.payload, actDeps(s, exec));
      const entry = actionLog.lastFor(ROLLOUT_ITEM);
      if (entry?.verb === SYNC_FORKS.id && entry.at >= started) {
        const done = new Set(
          entry.results.filter((r) => r.outcome === "done").map((r) => r.target),
        );
        s.expectTemplateRuns(
          FORKS.filter((f) => done.has(f.id)).map((f) => f.repo),
          entry.at,
        );
      }
      snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      return result;
    }
    if (action.type === WAIT_ACTION) {
      return startWait(s, action.payload);
    }
    if (action.type === INSPECT_ACTION) {
      const id = (action.payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) {
        return { ok: false, error: "inspect payload must be { id: string }" };
      }
      if (id === DOCTOR_ID) {
        inspect = { selected: DOCTOR_ID };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        return {
          ok: true,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title: "Doctor",
            placement: "side" as const,
          },
        };
      }
      if (id.startsWith(RELEASE_PREFIX)) {
        const month = id.slice(RELEASE_PREFIX.length);
        const doc = isMonth(month) ? monthDoc(month, s.now()) : undefined;
        if (!doc) return { ok: false, error: `${id} is not a month the rib has read` };
        inspect = { selected: id };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        return {
          ok: true,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title: releaseTitle(doc),
            placement: "side" as const,
          },
        };
      }
      if (id.startsWith(STEP_PREFIX) || id.startsWith(MR_PREFIX) || id.startsWith(REPO_PREFIX)) {
        const title = id.startsWith(MR_PREFIX)
          ? mrTitle(s.model, id)
          : id.startsWith(REPO_PREFIX)
            ? repoTitle(s.model, id)
            : stepTitle(s.model, id);
        if (!title) return { ok: false, error: `${id} has moved; the board redraws` };
        inspect = { selected: id };
        await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
        return {
          ok: true,
          data: {
            effect: "open-canvas" as const,
            key: INSPECT_KEY,
            title,
            placement: "side" as const,
          },
        };
      }
      const item = s.model.queue.items.find((i) => i.id === id);
      if (!item) return { ok: false, error: `${id} has left the queue; the board redraws` };
      const entries = cachedOthers(item, Date.now());
      const read = !entries && !!othersKey(item);
      inspect = {
        selected: id,
        item,
        ...(entries ? { others: { id, entries } } : {}),
        ...(read ? { reading: id } : {}),
      };
      // The drawer opens on this snapshot, so it must hold the item just clicked.
      await snapshots?.recompose(INSPECT_KEY).catch(() => undefined);
      if (read) readOthers(item);
      return {
        ok: true,
        data: {
          effect: "open-canvas" as const,
          key: INSPECT_KEY,
          title: inspectTitle(item),
          placement: "side" as const,
        },
      };
    }
    return { ok: false, error: `spi does not handle '${action.type}'` };
  },

  listAgents: () => AGENTS,
  resolveAgent: (slug) => resolveAgent(slug),

  authStatus: async (ctx) => {
    const status = await new Gh(ctx.getExec()).status();
    return { authenticated: status.ok, statusMessage: status.detail };
  },

  dispose: () => {
    unbind();
  },
};

export default rib;
