// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// With this many forks that need nothing, a fork table folds them into one row.
export const FOLD_AT = 4;

// An open list shows this many rows, then one row that counts and links the rest.
export const LIST_AT = 6;

export function names(list: readonly string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// One GitHub search across several repositories.
export function fleetSearch(repos: readonly string[], q: string): string {
  const query = [q, ...repos.map((r) => `repo:${r}`)].join(" ");
  return `https://github.com/search?type=pullrequests&q=${encodeURIComponent(query)}`;
}
