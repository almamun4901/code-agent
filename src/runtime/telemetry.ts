import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

const SERVICE_NAME = "terminal-native-coding-agent";
const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;
const MAX_ATTRIBUTE_TEXT_BYTES = 256;

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue | undefined>;
export type TelemetryOutcome = "ok" | "error" | "cancelled";

export type TelemetrySpan = {
  setAttributes(attributes: TelemetryAttributes): void;
  setOutcome(outcome: TelemetryOutcome): void;
};

export type CompletedSpan = {
  name: string;
  attributes: TelemetryAttributes;
  durationMs: number;
  outcome: TelemetryOutcome;
  kind?: "internal" | "client";
};

export interface RunTelemetry {
  startRun(attributes: TelemetryAttributes): void;
  withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T>,
    options?: { kind?: "internal" | "client" },
  ): Promise<T>;
  recordCompletedSpan(span: CompletedSpan): void;
  finishRun(outcome: TelemetryOutcome, attributes?: TelemetryAttributes): Promise<void>;
}

export const noOpTelemetry: RunTelemetry = {
  startRun() {},
  async withSpan(_name, _attributes, operation) {
    return operation({ setAttributes() {}, setOutcome() {} });
  },
  recordCompletedSpan() {},
  async finishRun() {},
};

export class OpenTelemetryRunTelemetry implements RunTelemetry {
  readonly #provider: BasicTracerProvider;
  readonly #tracer: Tracer;
  readonly #flushTimeoutMs: number;
  readonly #activeContexts = new AsyncLocalStorage<Context>();
  #rootSpan: Span | undefined;
  #rootContext = ROOT_CONTEXT;
  #finished = false;

  constructor(options: {
    exporter: SpanExporter;
    processor?: "batch" | "simple";
    flushTimeoutMs?: number;
  }) {
    const processor = options.processor === "simple"
      ? new SimpleSpanProcessor(options.exporter)
      : new BatchSpanProcessor(options.exporter, {
          maxQueueSize: 2_048,
          maxExportBatchSize: 256,
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: TELEMETRY_FLUSH_TIMEOUT_MS,
        });
    this.#provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
      spanProcessors: [processor],
      forceFlushTimeoutMillis: options.flushTimeoutMs ?? TELEMETRY_FLUSH_TIMEOUT_MS,
      spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: MAX_ATTRIBUTE_TEXT_BYTES },
    });
    this.#tracer = this.#provider.getTracer(SERVICE_NAME);
    this.#flushTimeoutMs = options.flushTimeoutMs ?? TELEMETRY_FLUSH_TIMEOUT_MS;
  }

  startRun(attributes: TelemetryAttributes): void {
    if (this.#finished) return;
    if (this.#rootSpan) {
      this.#rootSpan.setAttributes(safeAttributes(attributes));
      return;
    }
    this.#rootSpan = this.#tracer.startSpan("invoke_agent", {
      kind: SpanKind.INTERNAL,
      attributes: safeAttributes({
        "gen_ai.operation.name": "invoke_agent",
        ...attributes,
      }),
    });
    this.#rootContext = trace.setSpan(ROOT_CONTEXT, this.#rootSpan);
  }

  async withSpan<T>(
    name: string,
    attributes: TelemetryAttributes,
    operation: (span: TelemetrySpan) => Promise<T>,
    options: { kind?: "internal" | "client" } = {},
  ): Promise<T> {
    const parent = this.#activeContexts.getStore() ?? this.#rootContext;
    const span = this.#tracer.startSpan(
      name,
      {
        kind: options.kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL,
        attributes: safeAttributes(attributes),
      },
      parent,
    );
    const spanContext = trace.setSpan(parent, span);
    return this.#activeContexts.run(spanContext, async () => {
      let explicitOutcome: TelemetryOutcome | undefined;
      try {
        const result = await operation({
          setAttributes(next) {
            span.setAttributes(safeAttributes(next));
          },
          setOutcome(outcome) {
            explicitOutcome = outcome;
            setSpanOutcome(span, outcome);
          },
        });
        if (!explicitOutcome) setSpanOutcome(span, "ok");
        return result;
      } catch (error) {
        setSpanOutcome(span, "error");
        throw error;
      } finally {
        span.end();
      }
    });
  }

  recordCompletedSpan(completed: CompletedSpan): void {
    const durationMs = Number.isFinite(completed.durationMs)
      ? Math.max(0, completed.durationMs)
      : 0;
    const endedAt = Date.now();
    const parent = this.#activeContexts.getStore() ?? this.#rootContext;
    const span = this.#tracer.startSpan(completed.name, {
      kind: completed.kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL,
      startTime: endedAt - durationMs,
      attributes: safeAttributes(completed.attributes),
    }, parent);
    setSpanOutcome(span, completed.outcome);
    span.end(endedAt);
  }

  async finishRun(outcome: TelemetryOutcome, attributes: TelemetryAttributes = {}): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#rootSpan) {
      this.#rootSpan.setAttributes(safeAttributes({
        "agent.run.outcome": outcome,
        ...attributes,
      }));
      setSpanOutcome(this.#rootSpan, outcome);
      this.#rootSpan.end();
    }
    await ignoreTelemetryFailure(withTimeout(this.#provider.shutdown(), this.#flushTimeoutMs));
    this.#activeContexts.disable();
  }
}

export function createRunTelemetryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RunTelemetry {
  if (environment.AGENT_TELEMETRY_ENABLED !== "1") return noOpTelemetry;
  const baseUrl = safeLangfuseBaseUrl(environment.LANGFUSE_BASE_URL);
  const publicKey = boundedCredential(environment.LANGFUSE_PUBLIC_KEY);
  const secretKey = boundedCredential(environment.LANGFUSE_SECRET_KEY);
  if (!baseUrl || !publicKey || !secretKey) return noOpTelemetry;
  try {
    return new OpenTelemetryRunTelemetry({
      exporter: new OTLPTraceExporter({
        url: `${baseUrl}/api/public/otel/v1/traces`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
          "x-langfuse-ingestion-version": "4",
        },
        timeoutMillis: TELEMETRY_FLUSH_TIMEOUT_MS,
        concurrencyLimit: 2,
      }),
    });
  } catch {
    return noOpTelemetry;
  }
}

const allowedAttributeNames = new Set([
  "agent.hook.duration_ms",
  "agent.hook.index",
  "agent.hook.name",
  "agent.hook.outcome",
  "agent.model.call.kind",
  "agent.run.approval_mode",
  "agent.run.id",
  "agent.run.outcome",
  "agent.tool.outcome",
  "agent.tool.success",
  "error.type",
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.tool.call.id",
  "gen_ai.tool.name",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
]);

function safeAttributes(attributes: TelemetryAttributes): Attributes {
  const safe: Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!allowedAttributeNames.has(name) || value === undefined) continue;
    if (typeof value === "string" && isSafeStringAttribute(name, value)) {
      safe[name] = new TextEncoder().encode(value).byteLength <= MAX_ATTRIBUTE_TEXT_BYTES
        ? value
        : "REDACTED_OVERSIZE";
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[name] = value;
    } else if (typeof value === "boolean") {
      safe[name] = value;
    }
  }
  return safe;
}

function safeLangfuseBaseUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && !isLiteralLoopbackHttp(parsed)) return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function isLiteralLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  return url.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
}

const safeStringValues: Readonly<Record<string, ReadonlySet<string>>> = {
  "agent.hook.name": new Set(["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "UserPromptSubmit", "Notification", "Stop", "PreCompact"]),
  "agent.hook.outcome": new Set(["allow", "deny", "failed", "cancelled", "ok", "error"]),
  "agent.model.call.kind": new Set(["agent", "compaction"]),
  "agent.run.approval_mode": new Set(["auto", "interactive"]),
  "agent.run.outcome": new Set(["ok", "error", "cancelled"]),
  "agent.tool.outcome": new Set(["succeeded", "failed", "denied", "cancelled"]),
  "error.type": new Set(["TOOL_ERROR", "TOOL_DENIED", "TOOL_CANCELLED"]),
  "gen_ai.operation.name": new Set(["invoke_agent", "chat", "execute_tool", "execute_hook"]),
  "gen_ai.provider.name": new Set(["anthropic", "openrouter", "injected"]),
  "gen_ai.request.model": new Set(["claude-haiku-4-5", "anthropic/claude-haiku-4.5"]),
  "gen_ai.response.model": new Set(["claude-haiku-4-5", "anthropic/claude-haiku-4.5"]),
  "gen_ai.tool.name": new Set(["read_file", "edit_file", "ripgrep", "tree_sitter_symbols", "run_shell", "verify_viewport", "git"]),
};

function isSafeStringAttribute(name: string, value: string): boolean {
  const values = safeStringValues[name];
  if (values) return values.has(value);
  switch (name) {
    case "agent.run.id":
      return /^[a-f0-9]{64}$/u.test(value);
    case "gen_ai.tool.call.id":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    default:
      return false;
  }
}

function setSpanOutcome(span: Span, outcome: TelemetryOutcome): void {
  span.setStatus({
    code: outcome === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
  });
}

function boundedCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 1_024 ? trimmed : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("TELEMETRY_FLUSH_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ignoreTelemetryFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Telemetry is an asynchronous projection and never changes run truth.
  }
}
