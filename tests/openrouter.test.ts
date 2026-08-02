import { describe, expect, test } from "bun:test";
import {
  ModelConfigurationError,
  ModelProviderError,
  ModelRequestCancelledError,
  type ModelRequest,
} from "../src/model/contracts";
import { createOpenRouterModel } from "../src/model/openrouter";

describe("OpenRouter model adapter", () => {
  test("validates configuration before making a request", () => {
    expect(() => createOpenRouterModel({ apiKey: "" })).toThrow(
      ModelConfigurationError,
    );
    expect(() =>
      createOpenRouterModel({ apiKey: "test-key", timeoutMs: 0 }),
    ).toThrow("positive integer");
    expect(() =>
      createOpenRouterModel({
        apiKey: "test-key",
        dataCollection: "invalid" as "deny",
      }),
    ).toThrow('must be "allow" or "deny"');
  });

  test("allows an explicit data-collection route override", async () => {
    let requestedBody: Record<string, unknown> | undefined;
    const callModel = createOpenRouterModel({
      apiKey: "test-key",
      dataCollection: "allow",
      fetchImpl: async (_input, init) => {
        requestedBody = JSON.parse(String(init?.body));
        return jsonResponse(
          completion({
            finish_reason: "stop",
            content: "done",
          }),
        );
      },
    });

    await expect(callModel(makeRequest())).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(requestedBody).toMatchObject({
      provider: {
        require_parameters: true,
        data_collection: "allow",
      },
    });
  });

  test("normalizes messages, tools, tool calls, and actual usage", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const callModel = createOpenRouterModel({
      apiKey: "test-key",
      model: "test/tool-model",
      dataCollection: "deny",
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return jsonResponse({
          id: "generation-id",
          model: "test/routed-model",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "Working",
                tool_calls: [
                  {
                    id: "call-plan",
                    type: "function",
                    function: {
                      name: "rewrite_plan",
                      arguments: '{"plan":[]}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 17,
            completion_tokens: 9,
            total_tokens: 26,
            cost: 0.0001234,
          },
        });
      },
    });

    expect(await callModel(makeRequest())).toEqual({
      actualIdentity: {
        provider: "openrouter",
        model: "test/routed-model",
      },
      providerCostMicroUsd: 124,
      content: [
        { type: "text", text: "Working" },
        {
          type: "tool_use",
          id: "call-plan",
          name: "rewrite_plan",
          input: { plan: [] },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 17, outputTokens: 9 },
    });
    expect(requestedUrl).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(String(requestedInit?.body));
    expect(body).toMatchObject({
      model: "test/tool-model",
      tool_choice: "auto",
      max_tokens: 512,
      provider: {
        require_parameters: true,
        data_collection: "deny",
      },
      stream: false,
    });
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "rewrite_plan",
          description: "Replace the plan.",
          parameters: {
            type: "object",
            properties: {
              plan: { type: "array" },
            },
            required: ["plan"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "Use tools." },
      { role: "user", content: "Start." },
      {
        role: "assistant",
        content: "Planning",
        tool_calls: [
          {
            id: "prior-plan",
            type: "function",
            function: {
              name: "rewrite_plan",
              arguments: '{"plan":[]}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "prior-plan",
        content: '{"accepted":true}',
      },
    ]);
  });

  test.each([
    {
      name: "missing usage",
      response: {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
      },
      message: "invalid completion response",
    },
    {
      name: "invalid tool arguments",
      response: completion({
        finish_reason: "tool_calls",
        content: null,
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "rewrite_plan", arguments: "not-json" },
          },
        ],
      }),
      message: "invalid JSON arguments",
    },
    {
      name: "inconsistent finish reason",
      response: completion({
        finish_reason: "stop",
        content: null,
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "rewrite_plan", arguments: "{}" },
          },
        ],
      }),
      message: "inconsistent tool calls",
    },
    {
      name: "unsupported finish reason",
      response: completion({
        finish_reason: "unknown_reason",
        content: "done",
      }),
      message: "unsupported finish reason",
    },
    {
      name: "in-band generation error",
      response: completion({
        finish_reason: "error",
        content: "partial output",
        error: {
          code: 429,
          message: "raw provider detail must not leak",
          metadata: { error_type: "rate_limit_exceeded" },
        },
      }),
      message:
        "OpenRouter generation failed (429): rate_limit_exceeded",
    },
  ])("fails closed for $name", async ({ response, message }) => {
    const callModel = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () => jsonResponse(response),
    });

    await expect(callModel(makeRequest())).rejects.toThrow(message);
  });

  test("keeps safe client errors without leaking server envelopes", async () => {
    const clientFailure = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              message: " tools.0.function.parameters is invalid\n",
              metadata: { secret: "must-not-leak" },
            },
          },
          400,
        ),
    });
    await expect(clientFailure(makeRequest())).rejects.toEqual(
      new ModelProviderError(
        "OpenRouter request failed (400): tools.0.function.parameters is invalid",
        400,
      ),
    );

    const serverFailure = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () =>
        jsonResponse(
          {
            error: {
              message: "secret upstream response",
            },
          },
          503,
        ),
    });
    await expect(serverFailure(makeRequest())).rejects.toEqual(
      new ModelProviderError("OpenRouter request failed (503).", 503),
    );

    const nonJsonFailure = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () => new Response("<html>upstream failed</html>", {
        status: 502,
      }),
    });
    await expect(nonJsonFailure(makeRequest())).rejects.toEqual(
      new ModelProviderError("OpenRouter request failed (502).", 502),
    );
  });

  test("rejects declared and streamed oversized responses", async () => {
    const declaredOversize = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response("{}", {
          headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
        }),
    });
    await expect(declaredOversize(makeRequest())).rejects.toThrow(
      "exceeded the maximum allowed size",
    );

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        throw new Error("provider stream cancellation failed");
      },
    });
    const streamedOversize = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async () => new Response(oversizedBody),
    });
    await expect(streamedOversize(makeRequest())).rejects.toThrow(
      "exceeded the maximum allowed size",
    );
  });

  test("propagates caller cancellation to fetch", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const callModel = createOpenRouterModel({
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = callModel(makeRequest(), {
      signal: controller.signal,
    });

    await Bun.sleep(1);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(
      ModelRequestCancelledError,
    );
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("bounds provider latency independently of caller cancellation", async () => {
    const callModel = createOpenRouterModel({
      apiKey: "test-key",
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    await expect(callModel(makeRequest())).rejects.toThrow(
      "timed out after 5ms",
    );
  });
});

function makeRequest(): ModelRequest {
  return {
    system: "Use tools.",
    messages: [
      { role: "user", content: "Start." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Planning" },
          {
            type: "tool_use",
            id: "prior-plan",
            name: "rewrite_plan",
            input: { plan: [] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "prior-plan",
            content: '{"accepted":true}',
          },
        ],
      },
    ],
    tools: [
      {
        name: "rewrite_plan",
        description: "Replace the plan.",
        inputSchema: {
          type: "object",
          properties: {
            plan: { type: "array" },
          },
          required: ["plan"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    maxTokens: 512,
  };
}

function completion(
  choice: {
    finish_reason: string | null;
    content: string | null;
    tool_calls?: unknown[];
    error?: unknown;
  },
) {
  return {
    choices: [
      {
        index: 0,
        finish_reason: choice.finish_reason,
        message: {
          role: "assistant",
          content: choice.content,
          ...(choice.tool_calls
            ? { tool_calls: choice.tool_calls }
            : {}),
        },
        ...(choice.error ? { error: choice.error } : {}),
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
