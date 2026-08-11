import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { chromium } from "playwright";
import { ViewportVerificationRequirementSchema } from "../runtime/approval";

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const SHELL_WRAPPER = "/usr/local/sbin/agent-run-shell";

type Screenshot = { file: string; sha256: string; bytes: number; width: number; height: number; route: string };

async function main(): Promise<void> {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory || !outputDirectory.startsWith("/tmp/agent-viewport-")) throw new Error("VIEWPORT_INVALID_PATH");
  const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (!raw || typeof raw !== "object" || !("remoteRepoPath" in raw) || typeof raw.remoteRepoPath !== "string" || !("requirement" in raw)) throw new Error("VIEWPORT_INVALID_INPUT");
  if (!raw.remoteRepoPath.startsWith("/workspace/tasks/")) throw new Error("VIEWPORT_INVALID_REPOSITORY");
  const requirement = ViewportVerificationRequirementSchema.parse(raw.requirement);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const server = Bun.spawn([
    "sudo", SHELL_WRAPPER, raw.remoteRepoPath, requirement.workingDirectory, "30000", requirement.serverCommand,
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await waitForPort(requirement.port, 30_000);
    browser = await chromium.launch({ headless: true });
    const screenshots: Screenshot[] = [];
    let totalBytes = 0;
    for (const [index, viewportCase] of requirement.cases.entries()) {
      const page = await browser.newPage({ viewport: { width: viewportCase.width, height: viewportCase.height } });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", () => pageErrors.push("pageerror"));
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push("console-error"); });
      const response = await page.goto(`http://127.0.0.1:${requirement.port}${viewportCase.route}`, { waitUntil: "networkidle", timeout: 30_000 });
      if (!response || response.status() < 200 || response.status() >= 400) throw new Error(`VIEWPORT_NAVIGATION_FAILED:${index}`);
      if (pageErrors.length > 0) throw new Error(`VIEWPORT_PAGE_ERROR:${index}`);
      if (consoleErrors.length > 0) throw new Error(`VIEWPORT_CONSOLE_ERROR:${index}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`VIEWPORT_HORIZONTAL_OVERFLOW:${index}`);
      for (const selector of viewportCase.requiredVisibleSelectors) {
        if (!await page.locator(selector).first().isVisible()) throw new Error(`VIEWPORT_SELECTOR_MISSING:${index}`);
      }
      const file = `${outputDirectory}/case-${index}.png`;
      const bytes = await page.screenshot({ path: file, type: "png", fullPage: false });
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`VIEWPORT_SCREENSHOT_TOO_LARGE:${index}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_SCREENSHOT_BYTES) throw new Error("VIEWPORT_SCREENSHOT_BUDGET_EXCEEDED");
      screenshots.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, width: viewportCase.width, height: viewportCase.height, route: viewportCase.route });
      await page.close();
    }
    process.stdout.write(`${JSON.stringify({ success: true, screenshots })}\n`);
  } catch (error) {
    const candidate = error instanceof Error ? error.message.split(":", 1)[0] ?? "VIEWPORT_FAILED" : "VIEWPORT_FAILED";
    const code = /^VIEWPORT_[A-Z0-9_]{1,55}$/.test(candidate) ? candidate : "VIEWPORT_FAILED";
    process.stdout.write(`${JSON.stringify({ success: false, code })}\n`);
  } finally {
    await browser?.close().catch(() => {});
    const cancel = Bun.spawn(["sudo", SHELL_WRAPPER, "--cancel", raw.remoteRepoPath], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await cancel.exited.catch(() => 1);
    await server.exited.catch(() => 1);
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await Bun.sleep(100);
  }
  throw new Error("VIEWPORT_SERVER_TIMEOUT");
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

await main();
