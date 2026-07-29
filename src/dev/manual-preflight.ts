export type CommandFinder = (command: string) => string | null;

export function checkManualDependencies(
  findCommand: CommandFinder = (command) => Bun.which(command),
): string[] {
  const errors: string[] = [];

  if (!findCommand("git")) {
    errors.push("git is required and was not found on PATH.");
  }
  if (!findCommand("rg")) {
    errors.push(
      "ripgrep (rg) is required and was not found on PATH. " +
        "On macOS with Homebrew: brew install ripgrep",
    );
  }

  return errors;
}

if (import.meta.main) {
  const errors = checkManualDependencies();
  if (errors.length > 0) {
    process.stderr.write(
      `Manual test prerequisites are missing:\n${errors
        .map((error) => `- ${error}`)
        .join("\n")}\n`,
    );
    process.exit(1);
  }

  process.stdout.write("Manual test prerequisites found: git, rg.\n");
}
