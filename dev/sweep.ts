#!/usr/bin/env bun
// One live sweep with the operator's gh and glab, outside Keelson: prints the
// verdict, the queue and each line, and validates every board the way the host
// would. Usage: bun dev/sweep.ts [data-dir] [--json]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView } from "@keelson/shared";
import { runJSON, runText } from "@keelson/shared/exec";
import { attentionBoard, badge } from "../src/boards/attention.ts";
import { engineeringBoard } from "../src/boards/engineering.ts";
import { inspectBoard } from "../src/boards/inspect.ts";
import { linesBoard } from "../src/boards/lines.ts";
import { radarBoard } from "../src/boards/radar.ts";
import { stackBoard } from "../src/boards/stack.ts";
import { checkable, entryAcrossForks } from "../src/collect/filters.ts";
import { Gh, Glab } from "../src/forge.ts";
import {
  ATTENTION_KEY,
  ENGINEERING_KEY,
  INSPECT_KEY,
  LINES_KEY,
  RADAR_KEY,
  STACK_KEY,
} from "../src/keys.ts";
import { attemptText, overdue, usualText } from "../src/model/stack.ts";
import { Store } from "../src/store.ts";
import { Sweeper } from "../src/sweep.ts";
import { age } from "../src/util.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) ?? mkdtempSync(join(tmpdir(), "rib-spi-"));
const RADAR_READ =
  /merge_requests|mergeRequests|port_o0|pom0|git\/blobs|groups\/osdu|repository\/files\/pom|repository\/tags|\/commits\/[0-9a-f]+\/diff|upstream-filter\.yml/;
let radarCalls = 0;
const counted = <F extends (cmd: string, args: string[], ...rest: never[]) => unknown>(f: F): F =>
  ((cmd: string, a: string[], ...rest: never[]) => {
    if (a.some((x) => RADAR_READ.test(x))) radarCalls++;
    return f(cmd, a, ...rest);
  }) as F;
const sweeper = new Sweeper({
  exec: { runJSON: counted(runJSON), runText: counted(runText) },
  store: new Store(dir),
  onChange: () => {},
});
const t0 = Date.now();
await sweeper.sweep({ force: true });
const m = sweeper.model;
const now = new Date();
console.log(
  `data dir ${dir} · ${((Date.now() - t0) / 1000).toFixed(1)} s · ${sweeper.facts.sweep?.calls} calls`,
);
for (const [area, v] of Object.entries(sweeper.facts)) {
  if (area === "sweep") continue;
  const mv = v as { at?: string; error?: string };
  console.log(`  ${area.padEnd(10)} ${mv.at ? "ok" : "--"} ${mv.error ? `ERROR ${mv.error}` : ""}`);
}
const radar = sweeper.facts.radar.data;
console.log(
  `\nRADAR · ${radarCalls} calls · ${Object.keys(radar?.filters ?? {}).length} filters · port match read ${radar?.portRead?.prs ?? "?"} fork PRs, ${radar?.portRead?.commits ?? "?"} commit messages`,
);
for (const [svc, r] of Object.entries(radar?.services ?? {})) {
  const read = (xs: { paths?: string[] }[]) => xs.filter((x) => x.paths).length;
  console.log(
    `  ${svc.padEnd(15)} MRs ${r.mrs.length} (${read(r.mrs)} read) · queued ${r.queued.length} (${read(r.queued)} read) · merged ${r.merged ? `${r.merged.length} (${read(r.merged)} read)` : "?"} · fork PRs ${r.forkPrs?.length ?? "?"}`,
  );
}
console.log(
  `\n${m.queue.verdict} · ${m.queue.incidents} incidents · P0 ${m.queue.counts.p0} P1 ${m.queue.counts.p1} P2 ${m.queue.counts.p2} · badge ${badge(m).count}`,
);
for (const i of m.queue.items) {
  console.log(
    `  P${i.rung} ${i.scope} · ${i.text}  [${[i.note, age(i.since, now)].filter(Boolean).join(" · ")}]`,
  );
  for (const e of i.effects) console.log(`       - ${e.text}`);
}
const s = m.stack;
console.log(
  `\nSTACK declared ${s.declared} running ${s.running?.version} (${s.running?.source}) latest ${s.latest} maint ${s.maintenance.state} deployable ${s.deployable.state} (${s.deployable.reason})`,
);
if (s.inflight)
  console.log(
    `  inflight env-${s.inflight.run.kind} ${s.inflight.run.target} ${s.inflight.stages.map((x) => `${x.label}:${x.state}`).join(" ")}`,
  );
for (const v of s.attempts) console.log(`  attempt ${attemptText(v, s.maintenance.run?.id)}`);
if (s.usual) console.log(`  usual ${usualText(s.usual)}${overdue(s, now) ? " · overdue" : ""}`);
for (const [k, st] of Object.entries(s.lifecycle))
  console.log(
    `  ${k} ${st.green}/${st.total} streak ${st.streak?.n} ${st.streak?.green ? "green" : "red"}`,
  );
console.log("\nLINES");
for (const l of m.lines) {
  console.log(
    `  ${l.fork.id.padEnd(13)} ${l.pill.label.padEnd(16)} ${l.stations.map((x) => `${x.id}:${x.state}`).join(" ")}`,
  );
  console.log(
    `  ${"".padEnd(13)} lag ${l.upstream?.lag} · release ${l.release?.tag} · template ${l.template.label} -${l.template.behind}${l.template.target ? ` → ${l.template.target}` : ""} · lane ${l.lane.ok}/${l.lane.failed}${l.why ? ` · why ${l.why}` : ""}`,
  );
}
console.log(
  `\nTEMPLATE ${m.template.latestTag} main +${m.template.mainAhead} · current ${m.template.current} waiting ${m.template.waiting}`,
);
for (const st of m.template.steps) {
  const reach = [...st.consequences, st.templateOnly ? `${st.templateOnly} template only` : ""];
  console.log(
    `  ${st.label.padEnd(10)} adopted ${st.adopted.length}/${m.lines.length} · waiting ${st.waiting.length} failing ${st.failing.length} no PR ${st.noPr.length} · ${reach.filter(Boolean).join(", ") || "-"}`,
  );
  for (const c of st.changes) console.log(`      ${c.title}${c.pr ? ` (#${c.pr})` : ""}`);
}

console.log("\nOPEN WORK  people(outside) bots pipeline · bug enh other auto · oldest");
for (const w of [m.work.template, m.work.stack, ...m.work.forks]) {
  const i = w.issues;
  console.log(
    `  ${w.name.padEnd(14)} ${w.read ? `${w.prs.people.length}(${w.contributors.length}) ${w.prs.bots.length} ${w.prs.pipeline.length} · ${i.bug.length} ${i.enhancement.length} ${i.other.length} ${i.automation.length} · ${w.oldest ? `#${w.oldest.number} ${age(w.oldest.createdAt, now)}` : "-"}${w.unreadPrs || w.unreadIssues ? ` · unread ${w.unreadPrs}/${w.unreadIssues}` : ""}` : "unread"}`,
  );
}

const boards = {
  [ATTENTION_KEY]: attentionBoard(m, sweeper.facts, now),
  [STACK_KEY]: stackBoard(m, now),
  [ENGINEERING_KEY]: engineeringBoard(m, now),
  [RADAR_KEY]: radarBoard(m, now, { readAt: sweeper.facts.radar.at }),
  [LINES_KEY]: linesBoard(m, now),
};
let bad = 0;
for (const [key, board] of Object.entries(boards)) {
  try {
    expectView(key, "board")(board);
  } catch (err) {
    bad++;
    console.error(`\nINVALID ${key}: ${err instanceof Error ? err.message.slice(0, 2000) : err}`);
  }
}

// Every queue item opens an inspector; a halt also reads the other forks live.
const exec = { runJSON, runText };
console.log("\ninspectors");
for (const item of m.queue.items) {
  const others = checkable(item.halt)
    ? { id: item.id, entries: await entryAcrossForks(new Gh(exec), new Glab(exec), item.halt) }
    : undefined;
  const board = inspectBoard(m, { selected: item.id, item, ...(others ? { others } : {}) }, now);
  try {
    expectView(INSPECT_KEY, "board")(board);
    console.log(
      `  ok  ${item.id} · ${board.header?.status?.label} · ${item.cause.length} cause, ${item.effects.length} effects`,
    );
  } catch (err) {
    bad++;
    console.error(
      `  INVALID ${item.id}: ${err instanceof Error ? err.message.slice(0, 1000) : err}`,
    );
  }
  for (const e of others?.entries ?? []) {
    console.log(
      `        ${e.fork.padEnd(13)} ${e.entry} · ${e.state}${e.verdict ? ` · ${e.verdict}` : ""}`,
    );
  }
}
console.log(bad === 0 ? "\nall boards valid" : `\n${bad} invalid boards`);
if (args.includes("--json")) console.log(JSON.stringify(boards, null, 1));
process.exit(bad === 0 ? 0 : 1);
