import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "no-comments-rule-"));
const pluginEntry = resolve(import.meta.dir, "../index.ts");
const oxlintBin = resolve(import.meta.dir, "../../../../node_modules/oxlint/bin/oxlint");

writeFileSync(
  join(workspace, ".oxlintrc.json"),
  JSON.stringify({
    jsPlugins: [{ name: "anti-slop", specifier: pluginEntry }],
    categories: { correctness: "off" },
    rules: { "anti-slop/no-comments": "error" },
  }),
);

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

async function commentFindings(source: string): Promise<number> {
  const file = join(workspace, `case-${Bun.hash(source)}.ts`);
  writeFileSync(file, source);
  const lint = Bun.spawn([oxlintBin, "--format", "json", "-c", ".oxlintrc.json", file], {
    cwd: workspace,
    env: { ...process.env, PATH: process.env.TEST_HOST_PATH },
    stdout: "pipe",
    stderr: "pipe",
  });
  const report = JSON.parse(await new Response(lint.stdout).text());
  await lint.exited;
  return report.diagnostics.filter((diagnostic: { code: string }) =>
    diagnostic.code.includes("no-comments"),
  ).length;
}

describe("anti-slop/no-comments", () => {
  it.each([
    "const value = 1;\n",
    "// oxlint-disable-next-line no-console\nconsole.log(1);\n",
    "/* eslint-disable no-console */\nconsole.log(1);\n",
    'const url = "https://example.com/path";\n',
  ])("allows %p", async (source) => {
    expect(await commentFindings(source)).toBe(0);
  });

  it.each([
    "// explains the next line\nconst value = 1;\n",
    "/** Documents a function. */\nexport function run() {}\n",
    "const value = 1; /* trailing */\n",
    "// SAFETY: checked above\nconst value = 1 as number;\n",
  ])("reports %p", async (source) => {
    expect(await commentFindings(source)).toBe(1);
  });
});
