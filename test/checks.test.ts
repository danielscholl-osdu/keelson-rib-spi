import { describe, expect, test } from "bun:test";
import type { CheckFact, PrFact } from "../src/facts";
import { failedChecks, latestChecks, pendingChecks, prVerdict } from "../src/model/checks";

function check(over: Partial<CheckFact> & { id: number; name: string }): CheckFact {
  return { status: "COMPLETED", conclusion: "SUCCESS", workflow: "Validation", ...over };
}

function pr(checks: CheckFact[]): PrFact {
  return {
    repo: "Azure/osdu-spi-file",
    number: 51,
    title: "chore(template-sync): sync template updates",
    url: "https://github.com/Azure/osdu-spi-file/pull/51",
    createdAt: "2026-10-08T08:21:12Z",
    updatedAt: "2026-10-12T08:50:00Z",
    draft: false,
    head: "template-sync/20261008-082109",
    base: "main",
    headSha: "abc",
    labels: ["template-sync"],
    checks,
  };
}

describe("newest check wins", () => {
  test("a real result beats a skipped lane of the same name, whatever the order", () => {
    const picked = latestChecks([
      check({ id: 20, name: "Deploy and Test", conclusion: "SKIPPED" }),
      check({ id: 10, name: "Deploy and Test", conclusion: "FAILURE" }),
    ]);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.conclusion).toBe("FAILURE");
  });

  test("a re-run that passed clears the older failure", () => {
    const picked = latestChecks([
      check({ id: 10, name: "Java Build", conclusion: "FAILURE" }),
      check({ id: 30, name: "Java Build", conclusion: "SUCCESS" }),
    ]);
    expect(picked[0]?.conclusion).toBe("SUCCESS");
  });

  test("the summary check is reported only when nothing else failed", () => {
    const withCause = pr([
      check({ id: 1, name: "Deploy and Test", conclusion: "FAILURE" }),
      check({ id: 2, name: "Validation Summary", conclusion: "FAILURE" }),
    ]);
    expect(failedChecks(withCause).map((c) => c.name)).toEqual(["Deploy and Test"]);
    const alone = pr([check({ id: 2, name: "Validation Summary", conclusion: "FAILURE" })]);
    expect(failedChecks(alone).map((c) => c.name)).toEqual(["Validation Summary"]);
  });

  test("an external app stuck in the queue does not hold a PR pending", () => {
    const p = pr([
      check({ id: 1, name: "Java Build" }),
      check({
        id: 2,
        name: "license/cla",
        workflow: undefined,
        status: "QUEUED",
        conclusion: undefined,
      }),
    ]);
    expect(pendingChecks(p)).toHaveLength(0);
    expect(prVerdict(p)).toBe("green");
  });

  test("verdicts", () => {
    expect(prVerdict(pr([check({ id: 1, name: "Java Build", conclusion: "FAILURE" })]))).toBe(
      "red",
    );
    expect(
      prVerdict(
        pr([check({ id: 1, name: "Java Build", status: "IN_PROGRESS", conclusion: undefined })]),
      ),
    ).toBe("pending");
    expect(prVerdict(pr([]))).toBe("none");
  });
});
