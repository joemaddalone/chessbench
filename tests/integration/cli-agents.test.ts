import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function runCli(file: string, args: string[]) {
  const env = { ...process.env };
  // Explicit empties prevent Bun's .env loader from restoring local credentials.
  env.JEV_API_KEY = "";
  env.JEV_ENDPOINT = "";
  env.LAYA_API_KEY = "";
  env.LAYA_ENDPOINT = "";
  env.NIMBLE_API_KEY = "";
  env.NIMBLE_ENDPOINT = "";
  env.TEV_API_KEY = "";
  env.TEV_ENDPOINT = "";
  const child = Bun.spawn([process.execPath, file, ...args], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI provider selection", () => {
  test("challenge runner rejects offline agents", async () => {
    for (const agent of ["mock", "first-legal"]) {
      const result = await runCli("src/cli/run.ts", [
        "--challenge", "lichess-000rZ", "--agent", agent,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("expected jev|laya|nimble|tev");
    }
  });

  test("benchmark rejects scripted mock agents", async () => {
    const result = await runCli("src/cli/bench.ts", ["--agents", "mock"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected jev|laya|nimble|tev");
  });

  test("benchmark defaults to real providers without a mock fallback", async () => {
    const result = await runCli("src/cli/bench.ts", ["--challenges", "lichess-000rZ"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.runs.map((run: { agentId: string }) => run.agentId)).toEqual(["jev", "laya-2", "nimble-3", "tev-4"]);
    expect(report.runs.every((run: { failReason: string }) => run.failReason === "agent_unavailable")).toBe(true);
  });
});
