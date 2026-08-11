import type { TodoItem } from "../plan/schema";
import type { ModelToolRequest } from "../tools/contracts";
import type { ToolOutcome } from "./events";

export const HOOK_TIMEOUT_MS = 5_000;
export const MAX_HOOKS_PER_NAME = 16;
export const MAX_HOOK_TEXT_BYTES = 2 * 1024;
export const MAX_HOOK_CONTEXT_BYTES = 8 * 1024;
export const MAX_HOOK_CONTEXT_TOTAL_BYTES = 16 * 1024;

export type HookName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Notification"
  | "Stop"
  | "PreCompact";

export type HostHookName = Exclude<HookName, "PreToolUse">;
export type HookFailure = { code: string; message: string };
export type HookDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; code: string; reason: string };
export type ContextHookDecision = HookDecision & { appendContext?: string };

export type LifecycleBudgetSnapshot = {
  modelCalls: number;
  maxModelCalls: number;
  contextTokens: number;
  maxContextTokens: number;
  projectedCostMicroUsd: number;
  maxProjectedCostMicroUsd: number;
  compactions: number;
};

export type SessionStartContext = {
  mode: "fresh" | "resumed";
  runIdentity: string;
  lifecycle: "running" | "finalizing" | "completed" | "cancelled" | "failed";
  plan: TodoItem[];
  budget: LifecycleBudgetSnapshot;
};
export type UserPromptSubmitContext = {
  runIdentity: string;
  task: string;
};
export type PostToolUseContext = {
  operationId: string;
  toolName: ModelToolRequest["name"];
  summary: string;
  durationMs: number;
  outcome: ToolOutcome;
};
export type NotificationContext = {
  kind: "budget" | "compaction" | "lifecycle" | "warning";
  code: string;
  title: string;
  message: string;
};
export type StopContext = {
  runIdentity: string;
  proposedPlan: TodoItem[];
  budget: LifecycleBudgetSnapshot;
};
export type PreCompactContext = {
  runIdentity: string;
  contextTokens: number;
  checkpointBytes: number;
  compactionNumber: number;
};
export type SessionEndHookContext = {
  reason: "completed" | "cancelled" | "failed";
  cleanup: "succeeded" | "failed";
  error?: HookFailure;
};

export type HostHookContextMap = {
  SessionStart: SessionStartContext;
  SessionEnd: SessionEndHookContext;
  UserPromptSubmit: UserPromptSubmitContext;
  PostToolUse: PostToolUseContext;
  Notification: NotificationContext;
  Stop: StopContext;
  PreCompact: PreCompactContext;
};

export type HostHookResultMap = {
  SessionStart: void;
  SessionEnd: void;
  UserPromptSubmit: ContextHookDecision;
  PostToolUse: void;
  Notification: void;
  Stop: HookDecision;
  PreCompact: { appendContext?: string } | void;
};

export type HostHook<K extends HostHookName> = (
  context: Readonly<HostHookContextMap[K]>,
  signal: AbortSignal,
) => HostHookResultMap[K] | Promise<HostHookResultMap[K]>;

export type HookWarning = HookFailure & { hook: HostHookName };

export class LifecycleHookError extends Error {
  readonly code: string;
  readonly hook: HostHookName;

  constructor(hook: HostHookName, code: string, message: string) {
    super(message);
    this.name = "LifecycleHookError";
    this.hook = hook;
    this.code = code;
  }
}

export class LifecycleHooks {
  readonly #hooks = new Map<HostHookName, HostHook<HostHookName>[]>();
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new LifecycleHookError(
        "SessionStart",
        "HOOK_CONFIGURATION_INVALID",
        "Hook timeout must be a positive integer.",
      );
    }
  }

  register<K extends HostHookName>(name: K, hook: HostHook<K>): this {
    const hooks = this.#hooks.get(name) ?? [];
    if (hooks.length >= MAX_HOOKS_PER_NAME) {
      throw new LifecycleHookError(
        name,
        "HOOK_LIMIT_EXCEEDED",
        `At most ${MAX_HOOKS_PER_NAME} ${name} hooks may be registered.`,
      );
    }
    hooks.push(hook as HostHook<HostHookName>);
    this.#hooks.set(name, hooks);
    return this;
  }

  async runGating<K extends "SessionStart" | "UserPromptSubmit" | "Stop" | "PreCompact">(
    name: K,
    context: HostHookContextMap[K],
  ): Promise<{ results: HostHookResultMap[K][]; appendedContext: string }> {
    const results: HostHookResultMap[K][] = [];
    const additions: string[] = [];
    await this.#runPhase(name, context, async (hook, signal, snapshot) => {
      const result = await hook(snapshot as never, signal) as HostHookResultMap[K];
      validateGatingResult(name, result);
      if (result && typeof result === "object" && "outcome" in result && result.outcome === "deny") {
        throw new LifecycleHookError(name, boundedCode(result.code), boundedText(result.reason));
      }
      if (result && typeof result === "object" && "appendContext" in result && result.appendContext !== undefined) {
        additions.push(boundedContext(result.appendContext));
        if (utf8Bytes(additions.join("\n")) > MAX_HOOK_CONTEXT_TOTAL_BYTES) {
          throw new LifecycleHookError(name, "HOOK_CONTEXT_LIMIT", "Combined hook context exceeds 16 KiB.");
        }
      }
      results.push(result);
    });
    return { results, appendedContext: additions.join("\n") };
  }

  async runObservers<K extends "PostToolUse" | "Notification">(
    name: K,
    context: HostHookContextMap[K],
  ): Promise<HookWarning[]> {
    const warnings: HookWarning[] = [];
    const hooks = this.#hooks.get(name) ?? [];
    const snapshot = deepFreeze(structuredClone(context));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("HOOK_TIMEOUT"), this.#timeoutMs);
    try {
      for (const hook of hooks) {
        if (warnings.length >= MAX_HOOKS_PER_NAME) break;
        try {
          await Promise.race([
            hook(snapshot as never, controller.signal),
            abortPromise(controller.signal),
          ]);
        } catch (error) {
          warnings.push(controller.signal.aborted
            ? { hook: name, code: "HOOK_TIMEOUT", message: `${name} hook phase timed out.` }
            : toWarning(name, error));
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    return warnings;
  }

  async runSessionEnd(context: SessionEndHookContext): Promise<void> {
    await this.#runPhase("SessionEnd", context, async (hook, signal, snapshot) => {
      await hook(snapshot, signal);
    });
  }

  async #runPhase<K extends HostHookName>(
    name: K,
    context: HostHookContextMap[K],
    invoke: (hook: HostHook<HostHookName>, signal: AbortSignal, snapshot: Readonly<HostHookContextMap[K]>) => Promise<void>,
  ): Promise<void> {
    const hooks = this.#hooks.get(name) ?? [];
    if (hooks.length === 0) return;
    const snapshot = deepFreeze(structuredClone(context));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("HOOK_TIMEOUT"), this.#timeoutMs);
    try {
      for (const hook of hooks) {
        try {
          await Promise.race([
            invoke(hook, controller.signal, snapshot),
            abortPromise(controller.signal),
          ]);
        } catch (error) {
          if (controller.signal.aborted) {
            throw new LifecycleHookError(name, "HOOK_TIMEOUT", `${name} hook phase timed out.`);
          }
          if (error instanceof LifecycleHookError) throw error;
          throw new LifecycleHookError(name, "HOOK_FAILED", boundedText(error instanceof Error ? error.message : "Hook failed."));
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateGatingResult(name: HostHookName, result: unknown): void {
  if (name === "SessionStart") {
    if (result !== undefined) invalid(name);
    return;
  }
  if (name === "PreCompact") {
    if (result === undefined) return;
    if (!isRecord(result) || Object.keys(result).some((key) => key !== "appendContext") || (result.appendContext !== undefined && typeof result.appendContext !== "string")) invalid(name);
    return;
  }
  if (!isRecord(result) || (result.outcome !== "allow" && result.outcome !== "deny")) invalid(name);
  const allowedKeys = name === "UserPromptSubmit" ? ["outcome", "code", "reason", "appendContext"] : ["outcome", "code", "reason"];
  if (Object.keys(result).some((key) => !allowedKeys.includes(key))) invalid(name);
  if (result.outcome === "deny" && (typeof result.code !== "string" || typeof result.reason !== "string")) invalid(name);
  if ("appendContext" in result && result.appendContext !== undefined && typeof result.appendContext !== "string") invalid(name);
}

function invalid(name: HostHookName): never {
  throw new LifecycleHookError(name, "HOOK_RESULT_INVALID", `${name} returned an invalid result.`);
}

function boundedCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : "HOOK_DENIED";
}

export function boundedText(value: string, maxBytes = MAX_HOOK_TEXT_BYTES): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  if (utf8Bytes(normalized) <= maxBytes) return normalized || "Hook failed.";
  let output = "";
  for (const character of normalized) {
    if (utf8Bytes(`${output}${character}…`) > maxBytes) break;
    output += character;
  }
  return `${output}…`;
}

function boundedContext(value: string): string {
  if (utf8Bytes(value) > MAX_HOOK_CONTEXT_BYTES) {
    throw new Error("Individual hook context exceeds 8 KiB.");
  }
  return value;
}

function toWarning(hook: HostHookName, error: unknown): HookWarning {
  return {
    hook,
    code: error instanceof LifecycleHookError ? error.code : "HOOK_FAILED",
    message: boundedText(error instanceof Error ? error.message : "Hook failed."),
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new DOMException("Hook phase timed out.", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Hook phase timed out.", "AbortError")), { once: true });
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
