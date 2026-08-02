import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type {
  CallModel,
  ModelIdentity,
  ModelRequest,
  ModelRuntime,
  ModelTurn,
  TokenEstimate,
} from "./contracts";

export const PRICING_CATALOG_VERSION = 1;
export const INPUT_RATE_MICRO_USD_PER_MILLION = 1_000_000;
export const OUTPUT_RATE_MICRO_USD_PER_MILLION = 5_000_000;

const supported = new Set([
  "anthropic:claude-haiku-4-5",
  "openrouter:anthropic/claude-haiku-4.5",
  "injected:claude-haiku-4-5",
]);

export type PricingSnapshot = {
  catalogVersion: number;
  identity: ModelIdentity;
  inputRateMicroUsdPerMillion: number;
  outputRateMicroUsdPerMillion: number;
};

export function pricingFor(identity: ModelIdentity): PricingSnapshot {
  if (!supported.has(`${identity.provider}:${identity.model}`)) {
    throw new Error(
      `No checked-in pricing exists for ${identity.provider}:${identity.model}.`,
    );
  }
  return {
    catalogVersion: PRICING_CATALOG_VERSION,
    identity,
    inputRateMicroUsdPerMillion: INPUT_RATE_MICRO_USD_PER_MILLION,
    outputRateMicroUsdPerMillion: OUTPUT_RATE_MICRO_USD_PER_MILLION,
  };
}

export function catalogCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: PricingSnapshot,
): number {
  return Math.ceil(
    inputTokens * pricing.inputRateMicroUsdPerMillion / 1_000_000,
  ) + Math.ceil(
    outputTokens * pricing.outputRateMicroUsdPerMillion / 1_000_000,
  );
}

export function conservativeRequestEstimate(request: ModelRequest): TokenEstimate {
  return {
    tokens: encode(canonicalRequestJson(request)).length * 2 + 2_048,
    source: "conservative_local",
    fingerprint: requestFingerprint(request),
  };
}

export function createInjectedModelRuntime(
  call: CallModel,
  options: {
    countRequestTokens?: ModelRuntime["countRequestTokens"];
    identity?: ModelIdentity;
  } = {},
): ModelRuntime {
  const identity = options.identity ?? {
    provider: "injected" as const,
    model: "claude-haiku-4-5",
  };
  const pricing = pricingFor(identity);
  return {
    identity,
    countRequestTokens: options.countRequestTokens ?? (async (request) => conservativeRequestEstimate(request)),
    async call(request, callOptions) {
      const turn = await call(request, callOptions);
      return normalizeTurn(turn, identity, pricing);
    },
  };
}

export function normalizeTurn(
  turn: ModelTurn,
  requested: ModelIdentity,
  pricing = pricingFor(requested),
): ModelTurn {
  return {
    ...turn,
    actualIdentity: turn.actualIdentity ?? requested,
    providerCostMicroUsd: turn.providerCostMicroUsd ?? catalogCostMicroUsd(
      turn.usage.inputTokens,
      turn.usage.outputTokens,
      pricing,
    ),
  };
}

export function canonicalRequestJson(request: ModelRequest): string {
  return JSON.stringify({
    mode: request.mode ?? "agent",
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    maxTokens: request.maxTokens,
  });
}

export function requestFingerprint(request: ModelRequest): string {
  const value = canonicalRequestJson({ ...request, messages: [] });
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
