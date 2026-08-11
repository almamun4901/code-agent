const REQUIRED_TEMPLATE_TAG = "completion-evidence-v1";

export function readLiveE2bConfig(
  environment: NodeJS.ProcessEnv = process.env,
): {
  enabled: boolean;
  templateRef: string;
} {
  if (environment.RUN_LIVE_E2B_TEST !== "1") {
    return { enabled: false, templateRef: "" };
  }

  if (!environment.E2B_API_KEY?.trim()) {
    throw new Error(
      "RUN_LIVE_E2B_TEST=1 requires E2B_API_KEY in the local environment.",
    );
  }

  const templateRef = environment.E2B_TEMPLATE_ID?.trim() ?? "";
  if (!templateRef) {
    throw new Error(
      "RUN_LIVE_E2B_TEST=1 requires E2B_TEMPLATE_ID. Use the tagged templateRef/name returned by the current template build.",
    );
  }
  if (!templateRef.endsWith(`:${REQUIRED_TEMPLATE_TAG}`)) {
    throw new Error(
      `E2B_TEMPLATE_ID must be the current tagged reference ending in :${REQUIRED_TEMPLATE_TAG}. The build's bare templateId defaults to the unrelated :default tag; use its templateRef/name value instead.`,
    );
  }

  return { enabled: true, templateRef };
}

export function toolStdout(output: string): string {
  if (!output.startsWith("STDOUT\n")) return "";
  const stderrStart = output.indexOf("\n\nSTDERR\n");
  return output.slice(
    "STDOUT\n".length,
    stderrStart === -1 ? undefined : stderrStart,
  );
}
