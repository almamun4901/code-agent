import { describe, expect, test } from "bun:test";
import { checkManualDependencies } from "../src/dev/manual-preflight";

describe("manual terminal preflight", () => {
  test("accepts a terminal with every external tool", () => {
    expect(
      checkManualDependencies((command) => `/usr/local/bin/${command}`),
    ).toEqual([]);
  });

  test("reports every missing external tool with an actionable message", () => {
    expect(checkManualDependencies(() => null)).toEqual([
      "git is required and was not found on PATH.",
      "ripgrep (rg) is required and was not found on PATH. On macOS with Homebrew: brew install ripgrep",
    ]);
  });
});
