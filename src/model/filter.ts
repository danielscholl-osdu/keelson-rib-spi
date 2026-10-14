// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export type FilterMap = "top_level" | "testing" | "profiles" | "fossa_modules";

// The parts of .github/upstream-filter.yml the upstream filter engine decides with.
export interface UpstreamFilter {
  service?: string;
  top_level: Record<string, string>;
  testing: Record<string, string>;
  profiles: Record<string, string>;
  fossa_modules: Record<string, string>;
  fork_owned?: string[];
}

function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;
}

function bare(value: string): string {
  return value.replace(/\s+#.*$/, "");
}

export function filterSection(text: string, section: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      inside = line.trim() === `${section}:`;
      continue;
    }
    if (!inside) continue;
    const m = /^\s+([^:\s][^:]*):\s*(\S+)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1].trim(), m[2]);
  }
  return out;
}

// The engine's fixed-schema subset: top-level keys holding a scalar, a block
// scalar, a one-level map or a one-level list. Anything else is skipped.
export function parseFilter(text: string): UpstreamFilter {
  const maps: Record<string, Record<string, string>> = {};
  const lists: Record<string, string[]> = {};
  const scalars: Record<string, string> = {};
  let key: string | undefined;
  let block = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(raw);
      key = m?.[1];
      const rest = bare(m?.[2] ?? "").trim();
      block = rest === "|";
      if (key && rest && !block) scalars[key] = unquote(rest);
      continue;
    }
    if (!key || block || !raw.startsWith("  ")) continue;
    const body = bare(raw.slice(2));
    if (body.startsWith("- ")) {
      lists[key] = [...(lists[key] ?? []), unquote(body.slice(2))];
      continue;
    }
    const m = /^(.+?):\s*(.*)$/.exec(body);
    if (m?.[1]) maps[key] = { ...(maps[key] ?? {}), [unquote(m[1])]: unquote(m[2] ?? "") };
  }
  return {
    ...(scalars.service ? { service: scalars.service } : {}),
    top_level: maps.top_level ?? {},
    testing: maps.testing ?? {},
    profiles: maps.profiles ?? {},
    fossa_modules: maps.fossa_modules ?? {},
    ...(lists.fork_owned ? { fork_owned: lists.fork_owned } : {}),
  };
}
