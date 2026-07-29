import { describe, expect, test } from "bun:test";
import { parseSandboxAdminArgs } from "../src/sandbox/sandbox-admin";

describe("E2B sandbox administration CLI", () => {
  test("accepts the read-only list command", () => {
    expect(parseSandboxAdminArgs(["list"])).toEqual({ command: "list" });
  });

  test("requires an exact sandbox ID and explicit confirmation to kill", () => {
    expect(
      parseSandboxAdminArgs(["kill", "ivbssbv1yqahvcpbwj7e8", "--yes"]),
    ).toEqual({
      command: "kill",
      sandboxId: "ivbssbv1yqahvcpbwj7e8",
    });

    expect(() =>
      parseSandboxAdminArgs(["kill", "ivbssbv1yqahvcpbwj7e8"]),
    ).toThrow("Usage");
    expect(() =>
      parseSandboxAdminArgs(["kill", "../unsafe", "--yes"]),
    ).toThrow("Usage");
  });
});
