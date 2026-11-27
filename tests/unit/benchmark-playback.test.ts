import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { benchmarkFrames } from "../../src/ui/benchmark-playback.ts";
import { BenchmarkJobStore } from "../../src/ui/benchmark-jobs.ts";
import { runSuite } from "../../src/benchmark/runner.ts";
import { loadLibrary, getChallenge } from "../../src/challenges/library.ts";
import { ChallengeRun } from "../../src/engine/types.ts";
import { MockAgent } from "../fixtures/mock-agent.ts";
import { SOLUTIONS } from "../fixtures/solutions.ts";

const { challenges } = await loadLibrary(fileURLToPath(new URL("../fixtures/challenges/", import.meta.url)));

describe("live benchmark playback", () => {
  test("snapshots begin before moves and advance across challenges without losing plies", async () => {
    const updates: ChallengeRun[] = [];
    const store = new BenchmarkJobStore();
    const selected = [getChallenge(challenges, "mate-in-2-001"), getChallenge(challenges, "mate-in-1-001")];
    const job = store.create(selected.map((c) => c.id), ["test"]);
    store.markRunning(job.id);
    const report = await runSuite({
      suiteId: job.id, challenges: selected,
      agents: [new MockAgent({ id: "test", script: [], scripts: SOLUTIONS, delayMs: 5 })],
      onRunUpdate: (run) => { updates.push(run); store.updateRun(job.id, run); },
    });
    expect(updates[0].status).toBe("in_progress");
    expect(updates[0].moves).toEqual([]);
    expect(updates[0].moves).toHaveLength(0); // Older snapshots stay immutable.
    expect(updates.map((r) => r.moves.length)).toEqual([0, 1, 0, 2, 3]);
    store.complete(job.id, report);
    expect(store.get(job.id)?.runs).toEqual(report.runs);
    const frames = benchmarkFrames(report.runs, selected);
    expect(frames.map((f) => [f.runIndex, f.ply, f.outcome])).toEqual([
      [0, 0, false], [0, 1, false], [0, 1, true],
      [1, 0, false], [1, 1, false], [1, 2, false], [1, 3, false], [1, 3, true],
    ]);
    expect(frames[0].fen).toBe(getChallenge(challenges, "mate-in-1-001").fen);
    expect(frames[5].fen).toBe(report.runs[1].moves[1].resultingFen);
  });

  test("unavailable agents still publish a starting position and failure outcome", async () => {
    const updates: ChallengeRun[] = [];
    const challenge = challenges[0];
    const agent = new MockAgent({ id: "unavailable", script: [] });
    agent.checkAvailability = async () => ({ ok: false, reason: "missing test endpoint" });
    const report = await runSuite({ suiteId: "failed", challenges: [challenge], agents: [agent], onRunUpdate: (run) => updates.push(run) });
    expect(updates.map((run) => run.status)).toEqual(["in_progress", "failed"]);
    const frames = benchmarkFrames(report.runs, [challenge]);
    expect(frames).toHaveLength(2);
    expect(frames[1].outcome).toBe(true);
    expect(frames[1].fen).toBe(challenge.fen);
  });

  test("running snapshots never invent outcome frames", () => {
    const run: ChallengeRun = { id: "r", challengeId: challenges[0].id, agentId: "a", startedAt: "", status: "in_progress", failReason: null, moves: [], solverMoveCount: 0 };
    expect(benchmarkFrames([run], challenges).map((frame) => frame.outcome)).toEqual([false]);
    expect(benchmarkFrames([run], [])).toEqual([]);
  });
});
