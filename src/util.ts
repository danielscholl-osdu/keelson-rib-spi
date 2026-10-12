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

export function days(fromIso: string | undefined, now: Date): number | undefined {
  if (!fromIso) return undefined;
  const ms = now.getTime() - Date.parse(fromIso);
  return Number.isFinite(ms) ? Math.floor(ms / DAY) : undefined;
}

// "21:40Z" today, "10-11 22:44Z" on an earlier day.
export function stamp(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  const day = d.toISOString().slice(0, 10);
  return day === now.toISOString().slice(0, 10) ? hm : `${day.slice(5)} ${hm}`;
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
