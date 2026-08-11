import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionAgentState } from "./schema";

export class EvidenceArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "EvidenceArtifactError";
  }
}

export async function revalidateViewportEvidenceFiles(state: ProductionAgentState): Promise<void> {
  const evidenceRoot = path.resolve(state.canonicalRepoPath, ".agent/evidence");
  for (const evidence of state.verificationEvidence.filter((item) => item.status === "satisfied")) {
    for (const screenshot of evidence.screenshots) {
      const target = path.resolve(state.canonicalRepoPath, screenshot.path);
      if (!target.startsWith(`${evidenceRoot}${path.sep}`)) throw new EvidenceArtifactError("VIEWPORT_SCREENSHOT_PATH_MISMATCH", "Screenshot escaped the evidence directory.");
      let stats;
      try { stats = await lstat(target); } catch { throw new EvidenceArtifactError("VIEWPORT_SCREENSHOT_MISSING", screenshot.path); }
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== screenshot.bytes) throw new EvidenceArtifactError("VIEWPORT_SCREENSHOT_INTEGRITY_FAILED", screenshot.path);
      const bytes = new Uint8Array(await readFile(target));
      if (await sha256(bytes) !== screenshot.sha256 || !validPngStructure(bytes, screenshot.width, screenshot.height)) {
        throw new EvidenceArtifactError("VIEWPORT_SCREENSHOT_INTEGRITY_FAILED", screenshot.path);
      }
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validPngStructure(bytes: Uint8Array, width: number, height: number): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 33 || !signature.every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR" || view.getUint32(16) !== width || view.getUint32(20) !== height) return false;
  let offset = 8;
  let sawIdat = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) return false;
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") return sawIdat && length === 0 && offset + 12 === bytes.byteLength;
    offset += length + 12;
  }
  return false;
}
