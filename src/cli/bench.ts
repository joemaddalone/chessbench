#!/usr/bin/env bun
/** Suite benchmark: same challenges against multiple agents, one JSON report. */
import { createAgent, defaultModel, isProviderKey, PROVIDER_KEYS } from "../agents/registry.ts";
import { Agent } from "../agents/protocol/types.ts";
import { getChallenge, loadLibrary } from "../challenges/library.ts";
import { runSuite } from "../benchmark/runner.ts";
import { fileURLToPath } from "node:url";

const CHALLENGES_DIR = fileURLToPath(new URL("../../challenges/", import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function buildAgent(spec: string, index: number): Agent {
  if (!isProviderKey(spec)) {
    throw new Error(`unknown agent "${spec}" (expected ${PROVIDER_KEYS.join("|")})`);
  }
  const id = index === 0 ? spec : `${spec}-${index + 1}`;
  const model = arg("--model") ?? defaultModel(spec);
  return createAgent(spec, { id, model });
}

async function main(): Promise<number> {
  const suiteDir = arg("--suite") ?? CHALLENGES_DIR;
  const { challenges, errors } = await loadLibrary(suiteDir);
  for (const e of errors) console.error(`library: ${e.message}`);
  const challengeIds =
    arg("--challenges")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ??
    challenges
      .map((c) => c.id)
      .sort()
      .slice(0, 5);
  // Validate ids up front so a typo fails fast instead of mid-suite.
  for (const cid of challengeIds) getChallenge(challenges, cid);

  const specs =
    arg("--agents")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? PROVIDER_KEYS.slice();
  const agents = specs.map((spec, i) => buildAgent(spec, i));

  const suiteId = arg("--suite-id") ?? `suite-${Date.now()}`;
  const choiceLimitArg = arg("--choice-limit");
  const selected = challengeIds.map((cid) => getChallenge(challenges, cid));
  const report = await runSuite({
    suiteId,
    challenges: selected,
    agents,
    ...(choiceLimitArg ? { choiceLimit: Number(choiceLimitArg) } : {}),
    // Progress goes to stderr so a long run visibly advances instead of looking hung.
    onProgress: (completed, total) => process.stderr.write(`\r${completed}/${total} runs complete…`),
  });
  process.stderr.write("\n");

  const json = JSON.stringify(report, null, 2);
  const out = arg("--out");
  if (out) {
    await Bun.write(out, json);
    console.error(`report written to ${out}`);
  } else {
    console.log(json);
  }
  return 0;
}

process.exit(await main());
