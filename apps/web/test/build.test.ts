import { describe, expect, it } from "vitest";

import { getWebBuildInfo } from "../src/build.js";

describe("web build marker", () => {
  it("uses the exact supplied commit SHA", () => {
    expect(getWebBuildInfo("abc123")).toEqual({
      service: "openarc-web",
      version: "0.0.0",
      commitSha: "abc123",
    });
  });

  it("fails closed to an explicit local marker", () => {
    expect(getWebBuildInfo(undefined).commitSha).toBe("local");
    expect(getWebBuildInfo("bad marker").commitSha).toBe("local");
    expect(getWebBuildInfo("  abc123  ").commitSha).toBe("abc123");
  });
});
