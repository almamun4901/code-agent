import {
  createInitialApprovalState,
  type ApprovalState,
} from "../../src/runtime/approval";

/** Test-only fixture for exercising the execution loop independently of discovery. */
export function createLegacyExecutionApprovalState(): ApprovalState {
  return {
    ...createInitialApprovalState(),
    phase: "executing",
    legacyTerminal: true,
  };
}
