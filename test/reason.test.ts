import { describe, expect, test } from "bun:test";
import { clause, reasonFromAnnotations, reasonFromLog, summarizeReason } from "../src/model/reason";

describe("reasons from annotations", () => {
  test("skips the runner's exit-code line and keeps the real failure", () => {
    expect(
      reasonFromAnnotations([
        { level: "failure", message: "Process completed with exit code 1." },
        {
          level: "failure",
          message:
            "environment is not deployable after 10 minutes: spi-redis: Reconciliation in progress",
        },
        {
          level: "notice",
          message: "waiting for the environment: The environment is in maintenance.",
        },
      ]),
    ).toBe("environment is not deployable after 10 minutes: spi-redis: Reconciliation in progress");
  });

  test("falls back to the environment wait notice", () => {
    expect(
      reasonFromAnnotations([
        { level: "failure", message: "Process completed with exit code 1." },
        {
          level: "notice",
          message: "waiting for the environment: The environment is in maintenance.",
        },
      ]),
    ).toBe("waiting for the environment: The environment is in maintenance.");
  });

  test("nothing but the exit code is no reason", () => {
    expect(
      reasonFromAnnotations([{ level: "failure", message: "Process completed with exit code 1." }]),
    ).toBe(undefined);
  });
});

describe("reasons from logs", () => {
  test("the Maven enforcer line names the JDK range", () => {
    const log = [
      "2026-10-08T00:09:49.4500083Z [ERROR] legal-service ...................................... FAILURE [ 13.176 s]",
      "2026-10-08T00:09:49.4502137Z [ERROR] BUILD FAILURE",
      "2026-10-08T00:09:49.4545401Z [ERROR] Rule 1: org.apache.maven.enforcer.rules.version.RequireJavaVersion failed with message:",
      "2026-10-08T00:09:49.4546970Z [ERROR] Detected JDK /usr/lib/jvm/temurin-17-jdk-amd64 is version 17.0.20-1 which is not in the allowed range [25,).",
    ].join("\n");
    expect(reasonFromLog(log)).toBe(
      "RequireJavaVersion: JDK 17.0.20-1 is outside the allowed range [25,)",
    );
  });

  test("a wrapped Deployment failed paragraph is joined and its repeats dropped", () => {
    const log = [
      "2026-10-11T22:50:54.3038305Z Deployment failed: GitLab API unreachable after 3 attempts: <urlopen error ",
      "2026-10-11T22:50:54.3038876Z [Errno 111] Connection refused>; GitLab API unreachable after 3 attempts: ",
      "2026-10-11T22:50:54.3039815Z <urlopen error [Errno 111] Connection refused>",
      "2026-10-11T22:50:54.3363928Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const reason = reasonFromLog(log);
    expect(reason).toStartWith("Deployment failed: GitLab API unreachable after 3 attempts");
    expect(reason?.match(/GitLab API unreachable/g)).toHaveLength(1);
    expect(summarizeReason(reason)).toBe("GitLab API unreachable while resolving images");
  });

  test("ANSI escapes and Maven noise are ignored", () => {
    const log =
      "\u001b[1;31m[ERROR] BUILD FAILURE\u001b[0m\n[ERROR] Failed to execute goal on project x: compile error\n";
    expect(reasonFromLog(log)).toBe("Failed to execute goal on project x: compile error");
  });
});

describe("summaries", () => {
  test("drift, deployability and sign-in failures read short", () => {
    expect(
      summarizeReason("deployed ref (v0.28.0) drifted from declared stackVersion (v0.28.1)"),
    ).toBe("deployed v0.28.0 drifted from declared v0.28.1");
    expect(
      summarizeReason(
        "environment is not deployable after 10 minutes: The environment is in maintenance.",
      ),
    ).toBe("not deployable: The environment is in maintenance.");
    expect(
      summarizeReason(
        "failed to get token: AzureCLICredential: ERROR: AADSTS700024: Client assertion is not within its valid time range. Current time: x",
      ),
    ).toBe(
      "Azure sign-in failed: AADSTS700024 Client assertion is not within its valid time range",
    );
  });
});

describe("row clauses", () => {
  test("a surefire summary names its non-zero counts and the simple class", () => {
    expect(
      summarizeReason(
        "Tests run: 24, Failures: 0, Errors: 24, Skipped: 0, Time elapsed: 0.793 s <<< FAILURE! -- in org.opengroup.osdu.crs.converter.CompoundWGS84TransformTests",
      ),
    ).toBe("24 errors in CompoundWGS84TransformTests");
    expect(
      summarizeReason(
        "Tests run: 9, Failures: 1, Errors: 2, Skipped: 0 <<< FAILURE! - in a.b.CTest",
      ),
    ).toBe("1 failure, 2 errors in CTest");
  });

  test("a halt code reads as a sentence", () => {
    expect(
      summarizeReason("UNKNOWN_TOP_LEVEL: unclassified top-level entries: schemathesis-tests"),
    ).toBe("sync halted on schemathesis-tests, an unclassified top-level entry");
    expect(summarizeReason("UNKNOWN_TOP_LEVEL: unclassified top-level entries: a, b")).toBe(
      "sync halted on a and b, unclassified top-level entries",
    );
  });

  test("failed suites name the suite", () => {
    expect(summarizeReason("failed suites: acceptance")).toBe("the acceptance suite");
    expect(summarizeReason("failed suites: acceptance, smoke")).toBe(
      "the acceptance and smoke suites",
    );
  });

  test("a long reason is cut at the last clause boundary under 90, never mid-token", () => {
    const long =
      "Could not resolve dependencies for project org.opengroup.osdu:os-storage: the following artifacts could not be resolved: x";
    const cut = clause(long);
    expect(cut).toBe("Could not resolve dependencies for project org.opengroup.osdu:os-storage");
    expect(cut.length).toBeLessThanOrEqual(90);
    const words = "word ".repeat(30).trim();
    const clipped = clause(words);
    expect(clipped.length).toBeLessThanOrEqual(90);
    expect(clipped).toEndWith("word…");
    expect(clause("short reason")).toBe("short reason");
  });
});
