import type {
  ModelToolRequest,
  PreToolUse,
  PreToolUseDecision,
} from "./contracts";

const directNetworkUtility =
  /(?:^|[;&|(\s])(?:curl|wget|nc|ncat|netcat)(?=$|[\s;&|)])/;
const protectedRuntimePath = /(?:^|[\s'"=])\/opt\/agent(?:\/|$)/;
const protectedGitPath =
  /(?:^|[\s'"=])(?:\/workspace\/seed\/)?\.git(?:\/|$)/;
const deviceWrite =
  /(?:>{1,2}\s*|(?:^|[;&|]\s*)tee\s+|(?:^|[;&|]\s*)dd\b[^\n;]*\bof=)\/dev\/(?!null(?:\s|$))/;

function recursiveOutsideDelete(command: string): boolean {
  for (const match of command.matchAll(/(?:^|[;&|]\s*)rm\b([^;\n]*)/g)) {
    const args = match[1] ?? "";
    const recursive =
      /(?:^|\s)--recursive(?:\s|$)/.test(args) ||
      /(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*(?:\s|$)/.test(args);
    const outsideTarget =
      /(?:^|\s)(?:--\s+)?(?:\/|\.\.(?:\/|\s|$))/.test(args);
    if (recursive && outsideTarget) return true;
  }
  return false;
}

export const defaultPreToolUse: PreToolUse = async function (
  request: ModelToolRequest,
): Promise<PreToolUseDecision> {
  if (request.name !== "run_shell") return { outcome: "allow" };

  const { command } = request.input;
  if (command.includes("\0")) {
    return {
      outcome: "deny",
      code: "SHELL_NULL_BYTE",
      reason: "Shell commands containing null bytes are forbidden.",
    };
  }
  if (directNetworkUtility.test(command)) {
    return {
      outcome: "deny",
      code: "SHELL_EGRESS_UTILITY",
      reason: "Direct network utilities are unavailable in offline sandboxes.",
    };
  }
  if (protectedRuntimePath.test(command)) {
    return {
      outcome: "deny",
      code: "SHELL_RUNTIME_MUTATION",
      reason: "Shell access to the immutable agent runtime is forbidden.",
    };
  }
  if (protectedGitPath.test(command)) {
    return {
      outcome: "deny",
      code: "SHELL_GIT_CONTROL_MUTATION",
      reason: "Shell access to protected Git control paths is forbidden.",
    };
  }
  if (deviceWrite.test(command)) {
    return {
      outcome: "deny",
      code: "SHELL_DEVICE_WRITE",
      reason: "Direct writes to device paths are forbidden.",
    };
  }
  if (recursiveOutsideDelete(command)) {
    return {
      outcome: "deny",
      code: "SHELL_DESTRUCTIVE_OUTSIDE_ROOT",
      reason: "Recursive deletion targeting an absolute or parent path is forbidden.",
    };
  }

  return { outcome: "allow" };
};
