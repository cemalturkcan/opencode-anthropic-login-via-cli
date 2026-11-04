import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandOptions = Pick<ExecFileOptions, "timeout" | "env">;

export function commandOptions(options: CommandOptions = {}): ExecFileOptions {
  return { ...options, windowsHide: true };
}

export async function runCommand(
  file: string,
  args: string[],
  options?: CommandOptions,
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(file, args, {
    ...commandOptions(options),
    encoding: "utf-8",
  });
  return { stdout };
}
