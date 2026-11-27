#!/usr/bin/env bun
/** Headless human challenge runner: list/validate library, play a challenge. */
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { createAgent, isProviderKey, PROVIDER_KEYS } from "../agents/registry.ts";
import { runAgentChallenge } from "../agents/runner.ts";
import { Agent } from "../agents/protocol/types.ts";
import { getChallenge, listChallenges, loadLibrary } from "../challenges/library.ts";
import { replay } from "../engine/replay.ts";
import { EngineRun } from "../engine/run.ts";
import { Challenge, ChallengeRun } from "../engine/types.ts";
import { fileURLToPath } from "node:url";

const CHALLENGES_DIR = fileURLToPath(new URL("../../challenges/", import.meta.url));

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun run src/cli/run.ts --list\n" +
      "  bun run src/cli/run.ts --validate\n" +
      "  bun run src/cli/run.ts --challenge <id> [--moves u1,u2,...] [--solver <name>]\n" +
      `  bun run src/cli/run.ts --challenge <id> --agent ${PROVIDER_KEYS.join("|")} [--model <id>]\n` +
      "  bun run src/cli/run.ts --replay <run-report.json>",
  );
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const has = (name: string): boolean => process.argv.includes(name);

async function promptUci(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => rl.question("your move (uci, e.g. e2e4): ", resolve));
}

async function main(): Promise<number> {
  const { challenges, errors } = await loadLibrary(CHALLENGES_DIR);

  if (has("--list")) {
    for (const c of listChallenges(challenges)) {
      console.log(`${c.id}\t${c.title}\t[${c.difficulty}]\t${c.tags.join(",")}`);
    }
    return 0;
  }

  if (has("--validate")) {
    if (errors.length === 0) {
      console.log(`All ${challenges.length} challenge(s) valid.`);
      return 0;
    }
    for (const e of errors) console.error(`ERROR ${e.message}`);
    return 1;
  }

  const replayPath = arg("--replay");
  if (replayPath) {
    return await replayReport(challenges, replayPath);
  }

  const id = arg("--challenge");
  if (!id) usage();
  let challenge;
  try {
    challenge = getChallenge(challenges, id);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const solver = arg("--solver") ?? "human";
  const agentName = arg("--agent");
  if (agentName) {
    return await runWithAgent(challenge, agentName);
  }
  const run = new EngineRun(challenge, solver);
  console.log(`${challenge.title} — ${challenge.sideToMove} to move, mate in ${challenge.mateInN}`);
  console.log(`FEN: ${challenge.fen}`);

  const scripted = arg("--moves")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  let scriptedIndex = 0;
  let rl: ReturnType<typeof createInterface> | null = null;
  if (scripted.length === 0) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  try {
    while (run.snapshot().status === "in_progress") {
      let uci: string;
      if (scriptedIndex < scripted.length) {
        uci = scripted[scriptedIndex++];
        console.log(`> ${uci}`);
      } else if (rl) {
        uci = (await promptUci(rl)).trim();
        if (!uci) continue;
      } else {
        break;
      }
      const res = run.applySolverMove(uci);
      if (res.appliedMove) {
        console.log(`  solver: ${res.appliedMove.san} (${res.appliedMove.uci})`);
      } else {
        const attempt = run.snapshot().moves.at(-1);
        console.log(`  rejected: ${attempt?.rejected?.reason} — ${attempt?.rejected?.detail}`);
      }
      if (res.defenderMove) {
        console.log(`  defender: ${res.defenderMove.san} (${res.defenderMove.uci})`);
      }
      if (res.status !== "in_progress") {
        console.log(`  → ${res.status}${res.failReason ? ` (${res.failReason})` : ""}`);
      }
    }
  } finally {
    rl?.close();
  }

  const record = run.toRunRecord(`cli-${Date.now()}`, undefined);
  console.log(
    JSON.stringify(
      {
        status: record.status,
        failReason: record.failReason,
        solverMoveCount: record.solverMoveCount,
        elapsedMs: record.elapsedMs,
        moves: record.moves.map((m) => `${m.side}:${m.uci}${m.rejected ? `:${m.rejected.reason}` : ""}`),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function runWithAgent(
  challenge: ReturnType<typeof getChallenge>,
  agentName: string,
): Promise<number> {
  if (!isProviderKey(agentName)) {
    console.error(`unknown agent "${agentName}" (expected ${PROVIDER_KEYS.join("|")})`);
    return 1;
  }
  const model = arg("--model");
  const agent: Agent = createAgent(agentName, {
    id: `${agentName}-1`,
    ...(model ? { model } : {}),
  });
  console.error(`${challenge.title} — agent ${agent.id} (${agent.model})`);
  const record = await runAgentChallenge({ challenge, agent, runId: `cli-${Date.now()}` });
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

async function replayReport(
  challenges: Challenge[],
  replayPath: string,
): Promise<number> {
  let record: ChallengeRun;
  try {
    record = JSON.parse(await readFile(replayPath, "utf8")) as ChallengeRun;
  } catch {
    console.error(`cannot read run report "${replayPath}"`);
    return 1;
  }
  let challenge: Challenge;
  try {
    challenge = getChallenge(challenges, record.challengeId);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  const applied = record.moves.filter((m) => !m.rejected);
  const last = applied.at(-1);
  if (!last) {
    console.error(`report "${replayPath}" contains no applied moves`);
    return 1;
  }
  const outcome = replay(
    challenge,
    applied.map((m) => m.uci),
    { fen: last.resultingFen, status: record.status },
  );
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.reproduced ? 0 : 1;
}

process.exit(await main());
