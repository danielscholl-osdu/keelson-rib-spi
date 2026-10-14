// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { AZURE_REMOVAL_DUE, SYNC_UPSTREAM_CRON } from "../config.ts";
import type { Model } from "../model/index.ts";
import type { LineModel } from "../model/lines.ts";
import { type ItemClass, itemClass, nextText, verbOf } from "../model/next.ts";
import type { QueueItem, Rung } from "../model/queue.ts";
import type { Verdict } from "../model/radar.ts";
import { nextFire, toCrons } from "../model/schedule.ts";
import { age, plural, stamp } from "../util.ts";

export type Tone = "bad" | "warn" | "ok" | "neutral";

export interface Link {
  label: string;
  url: string;
}

// A figure is a version or a count, never a status word; status rides in sub and tone.
export interface BriefFact {
  label: string;
  figure: string;
  sub: string;
  tone: Tone;
}

export interface FocusItem {
  // A queue item id, so inspect resolves it; ids lists every item folded into this row.
  id: string;
  ids: string[];
  rung: Rung;
  cls: ItemClass;
  scope: string;
  title: string;
  sub: string;
  cause: string;
  effect: string;
  next: string;
  verb: string;
  evidence: Link[];
}

export interface ReadyLine {
  id: string;
  text: string;
  count: number;
}

export interface ThemeFork {
  fork: string;
  state: string;
  url?: string;
}

export type ThemeKind = "halt" | "toolchain" | "port" | "rollout" | "deadline";

// One cause across forks. Certain is queued or already landed; possible is an open MR.
export interface Theme {
  id: string;
  kind: ThemeKind;
  title: string;
  sub: string;
  certain: ThemeFork[];
  possible: ThemeFork[];
  // Forks whose filters lack the entry and that nothing open brings it to yet.
  exposed: string[];
  when?: string;
  tone: Tone;
}

export interface DoctorView {
  state: "dark" | "partial" | "clear" | "waiting";
  problems: string[];
}

export interface Briefing {
  sweptAt?: string;
  nextSyncAt?: string;
  doctor: DoctorView;
  headline: string;
  summary: string;
  facts: BriefFact[];
  focus: FocusItem[];
  // Focus rows past the cap, still in the queue and the inspector.
  more: number;
  ready: ReadyLine[];
  themes: Theme[];
}

const FOCUS_MAX = 5;
const HEADLINE_CAUSES = 2;
const DEADLINE_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;
const STOPPED = new Set(["halted", "blocked", "broken"]);
const ENVIRONMENT = new Set(["stack", "maintenance", "lanes"]);

const HALT_PLACE: Record<string, string> = {
  UNKNOWN_TOP_LEVEL: "a top-level entry",
  UNKNOWN_TESTING_ENTRY: "a testing entry",
  UNKNOWN_PROFILE: "a Maven profile",
  UNKNOWN_FOSSA_MODULE: "a FOSSA module",
};

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(text: string): string {
  const t = cap(text.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function fact(item: QueueItem, label: string): string | undefined {
  return item.cause.find((f) => f.label === label)?.value;
}

function javaOf(item: QueueItem): string | undefined {
  return (
    /allowed range \[(\d+)/.exec(fact(item, "reason") ?? "")?.[1] ??
    /^Java (\d+)$/.exec(fact(item, "value") ?? "")?.[1] ??
    /requires Java (\d+)/.exec(item.text)?.[1]
  );
}

function syncAt(now: Date): string | undefined {
  const at = nextFire(toCrons([SYNC_UPSTREAM_CRON]), now);
  return at === undefined ? undefined : new Date(at).toISOString();
}

// The daily sync is always less than a day away, so its local clock time names it.
function clock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stoppedLines(model: Model): LineModel[] {
  return model.lines.filter((l) => STOPPED.has(l.pill.kind));
}

// The imperative that clears an incident, as the headline says it.
function clause(item: QueueItem): string {
  if (ENVIRONMENT.has(item.kind)) return "Restore the environment";
  switch (item.kind) {
    case "halt":
      return `Unhalt ${item.scope}`;
    case "main":
      return `Fix ${item.scope} main`;
    case "conflict":
      return `Resolve the ${item.scope} conflict`;
    case "cascade":
      return `Restart the ${item.scope} cascade`;
    case "sync-run":
      return `Restart the ${item.scope} sync`;
    case "template-run":
      return `Restart Sync Template on ${item.scope}`;
    case "access":
      return `Restore ${item.scope}'s image pulls`;
    case "radar": {
      if (item.cls === "TOOLCHAIN") {
        const java = javaOf(item);
        return java
          ? `Move ${item.scope} to Java ${java}`
          : `Absorb the toolchain move on ${item.scope}`;
      }
      return `Classify ${list(item.halt?.entries ?? ["the entry"])} on ${item.scope}`;
    }
  }
  if (item.cls === "TOOLCHAIN") {
    const java = javaOf(item);
    return java
      ? `Move ${item.scope} to Java ${java}`
      : `Absorb the toolchain move on ${item.scope}`;
  }
  return `Unblock ${item.scope}`;
}

// Queued radar items that will repeat an incident at the next sync.
function followers(lead: QueueItem, radar: readonly QueueItem[]): QueueItem[] {
  if (lead.cls === "TOOLCHAIN") {
    const java = javaOf(lead);
    return java ? radar.filter((r) => r.cls === "TOOLCHAIN" && javaOf(r) === java) : [];
  }
  if (lead.kind === "halt") {
    const entries = new Set(lead.halt?.entries ?? []);
    return radar.filter(
      (r) => r.cls !== "TOOLCHAIN" && (r.halt?.entries ?? []).some((e) => entries.has(e)),
    );
  }
  return [];
}

function headlineOf(
  model: Model,
  focusable: readonly QueueItem[],
  ready: number,
  next: string | undefined,
): string {
  const incidents = focusable.filter((i) => i.incident);
  const radar = focusable.filter((i) => i.kind === "radar");
  const used = new Set<string>();
  const sentences: string[] = [];
  const seen = new Set<string>();
  for (const lead of [...incidents, ...radar]) {
    if (used.has(lead.id)) continue;
    used.add(lead.id);
    let text = clause(lead);
    if (lead.kind === "radar") {
      text += next ? ` before the ${next} sync` : " before the next sync";
    } else {
      const follow = followers(lead, radar).filter((r) => !used.has(r.id));
      for (const f of follow) used.add(f.id);
      if (follow.length > 0) {
        const scopes = follow.map((f) => f.scope);
        const verb = lead.kind === "halt" ? "halts" : "follows";
        text += ` before ${list(scopes)} ${scopes.length === 1 ? verb : verb.slice(0, -1)}${next ? ` at ${next}` : ""}`;
      }
    }
    if (seen.has(text)) continue;
    seen.add(text);
    sentences.push(sentence(text));
  }
  if (sentences.length > HEADLINE_CAUSES) {
    const more = sentences.length - HEADLINE_CAUSES;
    return [...sentences.slice(0, HEADLINE_CAUSES), `${plural(more, "more cause")} below.`].join(
      " ",
    );
  }
  if (sentences.length > 0) return sentences.join(" ");
  const p1 = model.queue.counts.p1;
  if (p1 > 0) return `${plural(p1, "decision")} ${p1 === 1 ? "waits" : "wait"} on you.`;
  if (ready > 0) {
    return `Nothing is broken. ${plural(ready, "PR")} ${ready === 1 ? "is" : "are"} ready for review.`;
  }
  return next ? `Nothing needs you. Next sync at ${next}.` : "Nothing needs you.";
}

function stoppedFor(model: Model, lines: readonly LineModel[], now: Date): string | undefined {
  const scopes = new Set(lines.map((l) => l.fork.id));
  const since = model.queue.items
    .filter((i) => i.incident && scopes.has(i.scope) && i.since)
    .map((i) => Date.parse(i.since as string))
    .filter(Number.isFinite);
  if (since.length === 0) return undefined;
  const oldest = new Date(Math.min(...since)).toISOString();
  const ms = now.getTime() - Date.parse(oldest);
  return ms >= DAY_MS ? plural(Math.floor(ms / DAY_MS), "day") : age(oldest, now);
}

function environmentSentence(model: Model, now: Date): string | undefined {
  const { deployable, inflight, recent } = model.stack;
  if (inflight) {
    const kind = inflight.run.kind;
    return `${/^[aeiou]/.test(kind) ? "An" : "A"} ${kind} is running on the environment.`;
  }
  if (deployable.state === "no") return sentence(`The environment is held: ${deployable.reason}`);
  if (deployable.state !== "yes") return undefined;
  const failedToday = recent.some(
    (v) => v.failedAt && now.getTime() - Date.parse(v.run.createdAt) < DAY_MS,
  );
  return `The environment is deployable${failedToday ? " again" : ""}.`;
}

function summaryOf(
  model: Model,
  focusable: readonly QueueItem[],
  ready: number,
  doctor: DoctorView,
  now: Date,
): string {
  const parts: string[] = [];
  if (doctor.state === "partial" && doctor.problems[0]) parts.push(sentence(problemText(doctor)));
  const stopped = stoppedLines(model);
  if (stopped.length > 0) {
    const span = stoppedFor(model, stopped, now);
    const who =
      stopped.length === 1
        ? `${stopped[0]?.fork.id} has`
        : `${plural(stopped.length, "fork")} have`;
    parts.push(`${cap(who)} been stopped${span ? ` for ${span}` : ""}.`);
  }
  if (!focusable.some((i) => ENVIRONMENT.has(i.kind))) {
    const env = environmentSentence(model, now);
    if (env) parts.push(env);
  }
  if (ready > 0 && focusable.length > 0) {
    parts.push(`${plural(ready, "PR")} ${ready === 1 ? "is" : "are"} ready for review.`);
  }
  return parts.join(" ");
}

function problemText(doctor: DoctorView): string {
  return (doctor.problems[0] ?? "").replace(/^⚠\s*/, "");
}

function factsOf(model: Model, now: Date): BriefFact[] {
  const { stack, template } = model;
  const env: BriefFact = {
    label: "Environment",
    figure: stack.running?.version ?? stack.declared ?? "?",
    sub: "deployability unread",
    tone: "neutral",
  };
  if (stack.inflight) {
    env.sub = `${stack.inflight.run.kind} running${stack.inflight.current ? ` · at ${stack.inflight.current}` : ""}`;
    env.tone = "warn";
  } else if (stack.deployable.state === "yes") {
    const at = stamp(stack.running?.at, now);
    env.sub = `deployable${at ? ` · green at ${at}` : ""}`;
    env.tone = "ok";
  } else if (stack.deployable.state === "no") {
    env.sub = `held · ${stack.deployable.reason}`;
    env.tone = "bad";
  }
  if (stack.declared && stack.running && stack.declared !== stack.running.version) {
    env.sub += ` · declares ${stack.declared}`;
  }

  const stopped = stoppedLines(model);
  const sync: BriefFact = {
    label: "Upstream sync",
    figure: `${stopped.length} of ${model.lines.length}`,
    sub:
      stopped.length > 0
        ? `forks stopped · ${list(stopped.map((l) => l.fork.id))}`
        : "forks stopped · every sync flowing",
    tone: stopped.length > 0 ? "bad" : "ok",
  };

  const tag = template.latestTag;
  const prs = template.rows.filter((r) => r.pr && (!tag || r.target === tag));
  const green = prs.filter((r) => r.verdict === "green").length;
  const approved = prs.filter((r) => r.ready).length;
  const all = template.read > 0 && template.onRelease === template.read;
  const tmpl: BriefFact = {
    label: `Template ${tag ?? template.headLabel}`,
    figure: `${template.onRelease} of ${template.read}`,
    sub:
      prs.length > 0
        ? `adopted · ${plural(prs.length, "PR")}${green === prs.length ? " green" : ""}, ${approved > 0 ? `${approved} approved` : "review required"}`
        : "adopted",
    tone: all ? "ok" : "neutral",
  };
  return [env, sync, tmpl];
}

function rank(item: QueueItem): number {
  const within = item.incident ? 0 : item.kind === "radar" ? 1 : item.cls === "PORT" ? 3 : 2;
  return item.rung * 10 + within;
}

function evidenceOf(items: readonly QueueItem[]): Link[] {
  const out: Link[] = [];
  const urls = new Set<string>();
  const add = (label: string, url: string) => {
    if (urls.has(url)) return;
    urls.add(url);
    out.push({ label, url });
  };
  for (const item of items) {
    if (item.kind === "port" || item.kind === "approvals") {
      for (const e of item.effects) if (e.url) add(e.text.split(" ")[0] ?? e.text, e.url);
      continue;
    }
    for (const f of item.cause) {
      if (!f.url || f.label === "match" || f.label === "filter" || f.label === "repository")
        continue;
      add(`${f.label} ${f.value.split(" · ")[0]}`, f.url);
    }
    for (const e of item.effects) if (e.url) add("run", e.url);
  }
  return out.slice(0, 4);
}

function exposure(model: Model, item: QueueItem): string[] {
  const entries = new Set(item.halt?.entries ?? []);
  const verdicts = model.radar.services[item.scope]?.certain ?? [];
  const out = new Set<string>();
  for (const v of verdicts) {
    if (v.bucket === "Halt" && v.entry && entries.has(v.entry)) {
      for (const f of v.elsewhere ?? []) out.add(f);
    }
  }
  return [...out];
}

function causeOf(item: QueueItem): string {
  if (item.kind === "halt") {
    const entries = list(item.halt?.entries ?? ["an entry"]);
    const code = item.halt?.code ?? fact(item, "halt") ?? "";
    return `Upstream adds ${entries}, ${HALT_PLACE[code] ?? "an entry"} the fork's filter has no rule for, so Sync Upstream stops with ${code || "a halt"}.`;
  }
  if (item.kind === "radar") {
    const values = item.effects.map((e) => e.text.replace(/ in the root pom\.xml$/, ""));
    return item.cls === "TOOLCHAIN"
      ? `Queued upstream commits move the root pom to ${list(values.length > 0 ? values : ["a new toolchain"])}.`
      : `Queued upstream commits add ${list(item.halt?.entries ?? ["an entry"])}, which the fork's filter has no rule for.`;
  }
  if (item.cls === "TOOLCHAIN") {
    const java = javaOf(item);
    const have = /JDK (\d+)/.exec(fact(item, "reason") ?? "")?.[1];
    if (java) return `Upstream requires Java ${java}${have ? `; the fork builds on ${have}` : ""}.`;
  }
  if (item.cls === "PORT") {
    return `Upstream changed ${fact(item, "tree") ?? "fork-owned code"} since the seed, and no fork PR cites the MR.`;
  }
  const reason = fact(item, "reason") ?? fact(item, "why");
  return sentence(reason ?? item.text);
}

function effectOf(item: QueueItem, stuck: readonly QueueItem[], next: string | undefined): string {
  if (item.kind === "approvals") {
    const prs = item.effects.map((e) => e.text.split(" ")[0] ?? e.text);
    return `${list(prs)} cannot run their checks until a maintainer approves them.`;
  }
  if (item.kind === "radar") {
    const queued = /(\d+) commits? queued/.exec(item.text)?.[1];
    const java = javaOf(item);
    const like =
      item.cls === "TOOLCHAIN"
        ? stuck.find((s) => s.cls === "TOOLCHAIN" && javaOf(s) === java)
        : undefined;
    return [
      `${queued ? plural(Number(queued), "commit") : "Queued commits"} reach the fork at the ${next ?? "next"} sync.`,
      like ? `${cap(like.scope)}'s sync PR failed on the same move.` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const texts = item.effects.map((e) => e.text);
  if (texts.length === 0) {
    const held = fact(item, "held");
    if (held) texts.push(held);
  }
  return texts.length > 0 ? texts.slice(0, 3).map(sentence).join(" ") : "Nothing else waits on it.";
}

function describe(
  model: Model,
  item: QueueItem,
  stuck: readonly QueueItem[],
  next: string | undefined,
  now: Date,
): { title: string; sub: string } {
  const ago = age(item.since, now);
  if (item.kind === "halt") {
    const lacking = exposure(model, item).length;
    return {
      title: `Sync halted on ${list(item.halt?.entries ?? ["an entry"])}`,
      sub: [
        item.note?.replace(" behind", " held"),
        ago,
        lacking > 0 ? `the same entry is missing from ${lacking} other filters` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (item.kind === "radar") {
    const java = javaOf(item);
    const like =
      item.cls === "TOOLCHAIN"
        ? stuck.find((s) => s.cls === "TOOLCHAIN" && javaOf(s) === java)
        : undefined;
    const queued = /(\d+) commits? queued/.exec(item.text)?.[1];
    return {
      title:
        item.cls === "TOOLCHAIN"
          ? `Next sync carries ${fact(item, "value") ?? "a toolchain move"}`
          : `Next sync halts on ${list(item.halt?.entries ?? ["an entry"])}`,
      sub: [
        queued ? `${plural(Number(queued), "commit")} queued` : undefined,
        next ? `syncs at ${next}` : undefined,
        like ? `expected to fail the way ${like.scope}'s did` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const cut = /: |; /.exec(item.text);
  const head = cut ? item.text.slice(0, cut.index) : item.text;
  const tail = cut ? item.text.slice(cut.index + 2) : undefined;
  return {
    title: cap(head),
    sub: [tail, item.note?.replace(" behind", " held"), ago].filter(Boolean).join(" · "),
  };
}

function focusOf(
  model: Model,
  focusable: readonly QueueItem[],
  next: string | undefined,
  now: Date,
): FocusItem[] {
  const ordered = [...focusable].sort((a, b) => rank(a) - rank(b));
  const stuck = ordered.filter((i) => i.incident);
  const ports = ordered.filter((i) => i.cls === "PORT");
  const out: FocusItem[] = [];
  for (const item of ordered) {
    if (item.cls === "PORT" && ports.length > 1) {
      if (item !== ports[0]) continue;
      const owed = ports.reduce((n, p) => n + p.effects.length, 0);
      out.push({
        id: item.id,
        ids: ports.map((p) => p.id),
        rung: item.rung,
        cls: "PORT",
        scope: plural(ports.length, "fork"),
        title: `${plural(owed, "upstream provider change")} not ported`,
        sub: ports.map((p) => `${p.scope} ${p.effects.length}`).join(" · "),
        cause:
          "Upstream merged changes to fork-owned provider and test trees since each fork's seed, and no fork PR cites them.",
        effect: `Until each MR is ported, ${list(ports.map((p) => p.scope))} drift from upstream.`,
        next: sentence(nextText(item)),
        verb: verbOf(item),
        evidence: evidenceOf(ports),
      });
      continue;
    }
    const { title, sub } = describe(model, item, stuck, next, now);
    out.push({
      id: item.id,
      ids: [item.id],
      rung: item.rung,
      cls: itemClass(item),
      scope: item.scope,
      title,
      sub,
      cause: causeOf(item),
      effect: effectOf(item, stuck, next),
      next: sentence(nextText(item)),
      verb: verbOf(item),
      evidence: evidenceOf([item]),
    });
  }
  return out;
}

function readyOf(model: Model): ReadyLine[] {
  const out: ReadyLine[] = [];
  const onTemplate = model.queue.items.filter((i) => i.rung === 2 && i.kind === "template-pr");
  for (const item of model.queue.items) {
    if (item.rung !== 2 || item.kind === "template-pr") continue;
    const count =
      item.kind === "releases" || item.kind === "template-set" ? item.effects.length : 1;
    out.push({ id: item.id, text: item.text.split(/ · |: |; /)[0] ?? item.text, count });
  }
  const first = onTemplate[0];
  if (first) {
    out.push({
      id: first.id,
      text: `${plural(onTemplate.length, "PR")} on osdu-spi`,
      count: onTemplate.length,
    });
  }
  return out;
}

function addFork(list: ThemeFork[], fork: ThemeFork): void {
  if (!list.some((f) => f.fork === fork.fork)) list.push(fork);
}

function mrState(v: Verdict): ThemeFork["state"] {
  return v.mr ? `open MR !${v.mr.iid}${v.mr.draft ? " (draft)" : ""}` : "open MR";
}

function haltThemes(model: Model, now: Date, next: string | undefined): Theme[] {
  const byKey = new Map<string, Theme & { haltedAt?: string }>();
  const theme = (map: string, entry: string) => {
    const key = `halt:${map}:${entry}`;
    let t = byKey.get(key);
    if (!t) {
      t = {
        id: key,
        kind: "halt",
        title: entry,
        sub: "",
        certain: [],
        possible: [],
        exposed: [],
        tone: "warn",
      };
      byKey.set(key, t);
    }
    return t;
  };
  for (const [fork, svc] of Object.entries(model.radar.services)) {
    const line = model.lines.find((l) => l.fork.id === fork);
    for (const v of svc.certain) {
      if (v.bucket !== "Halt" || !v.map || !v.entry) continue;
      const t = theme(v.map, v.entry);
      const halted = line?.halt;
      if (halted) {
        t.tone = "bad";
        if (!t.haltedAt || halted.issue.createdAt < t.haltedAt) t.haltedAt = halted.issue.createdAt;
      }
      addFork(t.certain, {
        fork,
        state: halted
          ? `halted ${age(halted.issue.createdAt, now) ?? ""}`.trim()
          : "next sync halts",
        url: halted?.issue.url ?? v.commit?.url,
      });
      for (const f of v.elsewhere ?? []) if (!t.exposed.includes(f)) t.exposed.push(f);
    }
    for (const v of svc.possible) {
      if (v.bucket !== "Halt" || !v.map || !v.entry) continue;
      addFork(theme(v.map, v.entry).possible, { fork, state: mrState(v), url: v.mr?.url });
    }
  }
  const out: Theme[] = [];
  for (const t of byKey.values()) {
    if (t.certain.length === 0 && t.possible.length < 2) continue;
    const named = new Set([...t.certain, ...t.possible].map((f) => f.fork));
    const lacking = t.exposed.length;
    t.exposed = t.exposed.filter((f) => !named.has(f));
    const halted = t.certain.filter((f) => f.state.startsWith("halted")).map((f) => f.fork);
    const queued = t.certain.filter((f) => !f.state.startsWith("halted")).map((f) => f.fork);
    t.sub = [
      halted.length > 0 ? `halted: ${list(halted)}` : undefined,
      queued.length > 0 ? `halts at the next sync: ${list(queued)}` : undefined,
      lacking > 0
        ? `${plural(lacking, "other filter")} ${lacking === 1 ? "lacks" : "lack"} it`
        : undefined,
      t.possible.length > 0
        ? `open MRs bring it to ${list(t.possible.map((f) => f.fork))}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    t.when = t.haltedAt
      ? age(t.haltedAt, now)
      : queued.length > 0 && next
        ? `at ${next}`
        : undefined;
    const { haltedAt: _, ...theme } = t;
    out.push(theme);
  }
  return out;
}

function javaThemes(model: Model, now: Date, next: string | undefined): Theme[] {
  const byValue = new Map<string, Theme & { blockedAt?: string }>();
  const theme = (value: string) => {
    let t = byValue.get(value);
    if (!t) {
      t = {
        id: `toolchain:${value}`,
        kind: "toolchain",
        title: value,
        sub: "",
        certain: [],
        possible: [],
        exposed: [],
        tone: "warn",
      };
      byValue.set(value, t);
    }
    return t;
  };
  for (const [fork, svc] of Object.entries(model.radar.services)) {
    const line = model.lines.find((l) => l.fork.id === fork);
    for (const v of svc.certain) {
      if (v.bucket !== "Toolchain" || !v.value?.startsWith("Java ")) continue;
      const t = theme(v.value);
      const red = line?.pill.kind === "blocked" ? line.syncPr : undefined;
      if (red) {
        t.tone = "bad";
        if (!t.blockedAt || red.pr.createdAt < t.blockedAt) t.blockedAt = red.pr.createdAt;
      }
      addFork(t.certain, {
        fork,
        state: red
          ? `blocked · PR #${red.pr.number}`
          : `queued${next ? ` · syncs at ${next}` : ""}`,
        url: red?.pr.url ?? v.commit?.url,
      });
    }
    for (const v of svc.possible) {
      if (v.bucket !== "Toolchain" || !v.value?.startsWith("Java ")) continue;
      addFork(theme(v.value).possible, { fork, state: mrState(v), url: v.mr?.url });
    }
  }
  const out: Theme[] = [];
  for (const t of byValue.values()) {
    t.possible = t.possible.filter((p) => !t.certain.some((c) => c.fork === p.fork));
    if (t.certain.length === 0 && t.possible.length < 2) continue;
    const blocked = t.certain.filter((f) => f.state.startsWith("blocked")).map((f) => f.fork);
    const queued = t.certain.filter((f) => f.state.startsWith("queued")).map((f) => f.fork);
    t.sub = [
      blocked.length > 0 ? `blocked: ${list(blocked)}` : undefined,
      queued.length > 0 ? `queued: ${list(queued)}` : undefined,
      t.possible.length > 0 ? `open MRs: ${list(t.possible.map((f) => f.fork))}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    t.when =
      queued.length > 0 && next ? `at ${next}` : t.blockedAt ? age(t.blockedAt, now) : undefined;
    const { blockedAt: _, ...theme } = t;
    out.push(theme);
  }
  return out;
}

function portTheme(model: Model, now: Date): Theme | undefined {
  const certain: ThemeFork[] = [];
  let oldest: string | undefined;
  let owed = 0;
  for (const [fork, svc] of Object.entries(model.radar.services)) {
    const list = svc.ports?.owed ?? [];
    const head = list[0];
    if (!head) continue;
    owed += list.length;
    certain.push({ fork, state: `${list.length} owed`, url: head.url });
    for (const mr of list) if (!oldest || mr.mergedAt < oldest) oldest = mr.mergedAt;
  }
  if (certain.length === 0) return undefined;
  return {
    id: "port",
    kind: "port",
    title: "Provider changes to port",
    sub: `${plural(owed, "merged MR")} · ${certain.map((c) => `${c.fork} ${c.state.split(" ")[0]}`).join(", ")}`,
    certain,
    possible: [],
    exposed: [],
    when: age(oldest, now),
    tone: "neutral",
  };
}

function rolloutTheme(model: Model, now: Date): Theme | undefined {
  const { template } = model;
  const tag = template.latestTag;
  const rows = template.rows.filter((r) => r.pr && (!tag || r.target === tag));
  if (rows.length === 0) return undefined;
  const green = rows.filter((r) => r.verdict === "green").length;
  const approved = rows.filter((r) => r.ready).length;
  const set = model.queue.items.find((i) => i.kind === "template-set");
  return {
    id: "rollout",
    kind: "rollout",
    title: `Template ${tag ?? template.headLabel}`,
    sub: `${plural(rows.length, "sync PR")}${green === rows.length ? " green" : ""}, ${approved > 0 ? `${approved} approved` : "review required"} · ${template.onRelease} of ${template.read} adopted`,
    certain: rows.map((r) => ({
      fork: r.service,
      state: `PR #${r.pr?.number} ${r.verdict ?? ""}${r.ready ? " · approved" : ""}`.trim(),
      url: r.pr?.url,
    })),
    possible: [],
    exposed: [],
    when: age(set?.since, now),
    tone: "neutral",
  };
}

function deadlineTheme(model: Model, now: Date): Theme | undefined {
  const due = model.radar.removalDue ? `${model.radar.removalDue}T00:00:00Z` : AZURE_REMOVAL_DUE;
  const left = Math.ceil((Date.parse(due) - now.getTime()) / DAY_MS);
  if (!Number.isFinite(left) || left > DEADLINE_WINDOW_DAYS) return undefined;
  const stages = { pending: 0, established: 0, "fork-only": 0 };
  const certain: ThemeFork[] = [];
  for (const [fork, svc] of Object.entries(model.radar.services)) {
    if (!svc.removal) continue;
    stages[svc.removal] += 1;
    certain.push({ fork, state: svc.removal });
  }
  return {
    id: "deadline:azure-removal",
    kind: "deadline",
    title: "Azure removal upstream",
    sub: `${stages.pending} pending · ${stages.established} established · ${stages["fork-only"]} fork-only`,
    certain,
    possible: [],
    exposed: [],
    when: left >= 0 ? `${plural(left, "day")} left` : "due",
    tone: left <= 14 ? "warn" : "neutral",
  };
}

function themesOf(model: Model, now: Date, next: string | undefined): Theme[] {
  const halts = haltThemes(model, now, next);
  const javas = javaThemes(model, now, next);
  const landed = (t: Theme) => t.certain.length > 0;
  return [
    ...javas.filter(landed),
    ...halts.filter(landed),
    portTheme(model, now),
    ...javas.filter((t) => !landed(t)),
    ...halts.filter((t) => !landed(t)),
    rolloutTheme(model, now),
    deadlineTheme(model, now),
  ].filter((t): t is Theme => !!t);
}

// Pure: the same model, doctor and clock always write the same briefing.
export function buildBriefing(model: Model, doctor: DoctorView, now: Date): Briefing {
  const nextIso = syncAt(now);
  const next = clock(nextIso);
  const base = { sweptAt: model.sweptAt, nextSyncAt: nextIso, doctor };
  if (!model.measured) {
    return {
      ...base,
      headline:
        doctor.state === "dark"
          ? sentence(problemText(doctor) || "GitHub cannot be read")
          : "The first sweep has not finished.",
      summary: "",
      facts: [],
      focus: [],
      more: 0,
      ready: [],
      themes: [],
    };
  }
  const focusable = model.queue.items.filter((i) => i.rung <= 1);
  const ready = readyOf(model);
  const readyCount = ready.reduce((n, r) => n + r.count, 0);
  const focus = focusOf(model, focusable, next, now);
  const headline =
    doctor.state === "dark"
      ? `${sentence(problemText(doctor) || "GitHub cannot be read")} Figures are from the last good read.`
      : headlineOf(model, focusable, readyCount, next);
  return {
    ...base,
    headline,
    summary: summaryOf(model, focusable, readyCount, doctor, now),
    facts: factsOf(model, now),
    focus: focus.slice(0, FOCUS_MAX),
    more: Math.max(0, focus.length - FOCUS_MAX),
    ready,
    themes: themesOf(model, now, next),
  };
}
