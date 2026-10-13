// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "40s", "25m", "21h", "4d 12h": the age of a fact, as the boards print it.
export function age(fromIso: string | undefined, now: Date): string | undefined {
  if (!fromIso) return undefined;
  const ms = now.getTime() - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return days < 7 && hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

// "11s", "14m", "1h 3m": how long something took.
export function took(fromIso: string | undefined, toIso: string | undefined): string | undefined {
  if (!fromIso || !toIso) return undefined;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${Math.floor(ms / HOUR)}h${minutes > 0 ? ` ${minutes}m` : ""}`;
}

export function days(fromIso: string | undefined, now: Date): number | undefined {
  if (!fromIso) return undefined;
  const ms = now.getTime() - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.floor(ms / DAY) : undefined;
}

// "4d" past a day, "7h" before it.
export function since(at: string, now: Date): string {
  const d = days(at, now);
  return d ? `${d}d` : (age(at, now) ?? "?");
}

// The tag a release PR cuts, in the style of the repository's last tag.
export function releaseTag(title: string, last: string | undefined): string | undefined {
  const version = /release\s+v?(\S+)/i.exec(title)?.[1];
  if (!version) return undefined;
  return `${last === undefined || last.startsWith("v") ? "v" : ""}${version}`;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

// "16:40" today, "10-11 17:44" on an earlier day, in local time: the zone the
// host draws timelines and clocks in.
export function stamp(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return today ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

// A stamp that names its zone, for the one place a board says when it was read.
export function zoned(iso: string | undefined, now: Date): string | undefined {
  const s = stamp(iso, now);
  if (!s) return undefined;
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(new Date(iso as string))
    .find((p) => p.type === "timeZoneName")?.value;
  return zone ? `${s} ${zone}` : s;
}

export function dayOf(iso: string | undefined): string | undefined {
  return iso ? iso.slice(5, 10) : undefined;
}

export function short(sha: string | undefined, n = 7): string {
  return sha ? sha.slice(0, n) : "?";
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function newest<T>(items: readonly T[], at: (item: T) => string | undefined): T | undefined {
  let best: T | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const t = Date.parse(at(item) ?? "");
    if (Number.isFinite(t) && t > bestAt) {
      best = item;
      bestAt = t;
    }
  }
  return best;
}

// Runs `fn` over `items` with at most `limit` in flight, keeping input order.
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// "34 min", "5 h 12 min", "4 d 17 h": a duration in the two largest units.
export function span(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < 2 * DAY) {
    const m = Math.round((ms % HOUR) / MINUTE);
    return `${Math.floor(ms / HOUR)} h${m > 0 ? ` ${m} min` : ""}`;
  }
  const h = Math.floor((ms % DAY) / HOUR);
  return `${Math.floor(ms / DAY)} d${h > 0 ? ` ${h} h` : ""}`;
}

// "7 min, usually 2": a duration beside its usual, the unit said once when both are minutes.
export function againstUsual(
  ms: number | undefined,
  usual: number | undefined,
  after = "",
): string | undefined {
  const now = span(ms);
  if (!now) return undefined;
  const typical = span(usual);
  if (!typical || typical === now) return `${now}${after}`;
  const minutes = /^\d+ min$/;
  return minutes.test(now) && minutes.test(typical)
    ? `${now}${after}, usually ${typical.replace(/ min$/, "")}`
    : `${now}${after}, usually ${typical}`;
}
