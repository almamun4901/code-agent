import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TemporaryRepository = {
  root: string;
  seedPath: string;
  worktreePath: string;
  bareRemotePath: string;
  write(relativePath: string, content: string | Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

export async function createTemporaryRepository(): Promise<TemporaryRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-agent-step2-"));
  const seedPath = path.join(root, "seed");
  const worktreePath = path.join(root, "worktree");
  const bareRemotePath = path.join(root, "remote.git");

  try {
    await mkdir(path.join(seedPath, "src"), { recursive: true });
    await writeFile(
      path.join(seedPath, "src", "sample.ts"),
      [
        "export class Greeter {",
        "  greet(name: string): string {",
        '    return `Hello, ${name}`;',
        "  }",
        "}",
        "",
        "export function helper(value: number): number {",
        "  return value + 1;",
        "}",
        "",
        "export const arrow = (value: number) => value * 2;",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(seedPath, "src", "sample.py"),
      [
        "class Worker:",
        "    def run(self):",
        "        return True",
        "",
        "def helper(value):",
        "    return value + 1",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(seedPath, "src", "sample.js"),
      [
        "export class Widget {",
        "  render() { return 'ok'; }",
        "}",
        "export function build() { return new Widget(); }",
        "export const load = () => true;",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(seedPath, "src", "sample.tsx"),
      [
        "export interface Props { name: string }",
        "export function Card(props: Props) {",
        "  return <div>{props.name}</div>;",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(seedPath, "repeat.txt"),
      Array.from(
        { length: 6_000 },
        (_, index) => `needle line ${index.toString().padStart(4, "0")} value`,
      ).join("\n"),
    );
    await writeFile(
      path.join(seedPath, "binary.bin"),
      new Uint8Array([0, 1, 2, 3]),
    );
    await writeFile(
      path.join(seedPath, "invalid-utf8.txt"),
      new Uint8Array([0xc3, 0x28]),
    );
    await writeFile(path.join(seedPath, "empty.txt"), "");

    await git(seedPath, "init", "-b", "main");
    await git(seedPath, "config", "user.email", "step2@example.invalid");
    await git(seedPath, "config", "user.name", "Step 2 Test");
    await git(seedPath, "add", "-A");
    await git(seedPath, "commit", "-m", "seed fixture");
    await git(seedPath, "worktree", "add", "-b", "agent-step2", worktreePath);

    await mkdir(bareRemotePath);
    await git(bareRemotePath, "init", "--bare");

    return {
      root,
      seedPath,
      worktreePath,
      bareRemotePath,
      async write(relativePath, content) {
        const destination = path.join(worktreePath, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content);
      },
      async cleanup() {
        await git(seedPath, "worktree", "remove", "--force", worktreePath).catch(
          () => {},
        );
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
