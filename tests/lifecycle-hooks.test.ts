import { describe, expect, test } from "bun:test";
import {
  LifecycleHookError,
  LifecycleHooks,
  MAX_HOOKS_PER_NAME,
} from "../src/runtime/lifecycle";

const prompt = { runIdentity: "a".repeat(64), task: "task" };

describe("lifecycle hooks", () => {
  test("runs gating hooks in registration order and appends bounded context", async () => {
    const order: number[] = [];
    const hooks = new LifecycleHooks()
      .register("UserPromptSubmit", () => {
        order.push(1);
        return { outcome: "allow", appendContext: "first" };
      })
      .register("UserPromptSubmit", () => {
        order.push(2);
        return { outcome: "allow", appendContext: "second" };
      });
    await expect(hooks.runGating("UserPromptSubmit", prompt)).resolves.toEqual({
      results: [
        { outcome: "allow", appendContext: "first" },
        { outcome: "allow", appendContext: "second" },
      ],
      appendedContext: "first\nsecond",
    });
    expect(order).toEqual([1, 2]);
  });

  test("fails closed on denial, exception, invalid result, and timeout", async () => {
    const denied = new LifecycleHooks().register("UserPromptSubmit", () => ({ outcome: "deny", code: "NO", reason: "not allowed" }));
    await expect(denied.runGating("UserPromptSubmit", prompt)).rejects.toMatchObject({ code: "NO" });

    const failed = new LifecycleHooks().register("Stop", () => { throw new Error("boom"); });
    await expect(failed.runGating("Stop", { runIdentity: prompt.runIdentity, proposedPlan: [], budget: budget() })).rejects.toMatchObject({ code: "HOOK_FAILED" });

    const invalid = new LifecycleHooks().register("Stop", () => ({ outcome: "maybe" } as never));
    await expect(invalid.runGating("Stop", { runIdentity: prompt.runIdentity, proposedPlan: [], budget: budget() })).rejects.toMatchObject({ code: "HOOK_RESULT_INVALID" });

    const timed = new LifecycleHooks({ timeoutMs: 5 }).register("SessionStart", () => new Promise(() => {}));
    await expect(timed.runGating("SessionStart", { mode: "fresh", runIdentity: prompt.runIdentity, lifecycle: "running", plan: [], budget: budget() })).rejects.toMatchObject({ code: "HOOK_TIMEOUT" });
  });

  test("isolates observers and enforces the registration cap", async () => {
    let called = 0;
    const hooks = new LifecycleHooks()
      .register("Notification", () => { throw new Error("observer failed"); })
      .register("Notification", () => { called += 1; });
    await expect(hooks.runObservers("Notification", { kind: "warning", code: "TEST", title: "Test", message: "message" })).resolves.toHaveLength(1);
    expect(called).toBe(1);

    const capped = new LifecycleHooks();
    for (let index = 0; index < MAX_HOOKS_PER_NAME; index += 1) capped.register("PostToolUse", () => {});
    expect(() => capped.register("PostToolUse", () => {})).toThrow(LifecycleHookError);
  });

  test("passes recursively frozen snapshots", async () => {
    const hooks = new LifecycleHooks().register("SessionStart", (context) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.plan)).toBe(true);
    });
    await hooks.runGating("SessionStart", { mode: "fresh", runIdentity: prompt.runIdentity, lifecycle: "running", plan: [], budget: budget() });
  });
});

function budget() {
  return { modelCalls: 0, maxModelCalls: 50, contextTokens: 0, maxContextTokens: 200_000, projectedCostMicroUsd: 0, maxProjectedCostMicroUsd: 5_000_000, compactions: 0 };
}
