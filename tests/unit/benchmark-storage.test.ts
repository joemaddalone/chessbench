import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getChallenge, loadLibrary } from "../../src/challenges/library.ts";
import { runSuite } from "../../src/benchmark/runner.ts";
import {
  BENCHMARK_STORAGE_KEY, BenchmarkHistory, completeBenchmark, deleteBenchmark,
  loadBenchmarkHistory, saveBenchmarkHistory,
} from "../../src/ui/benchmark-storage.ts";
import { MockAgent } from "../fixtures/mock-agent.ts";
import { SOLUTIONS } from "../fixtures/solutions.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

const { challenges } = await loadLibrary(fileURLToPath(new URL("../fixtures/challenges/", import.meta.url)));
const challenge = getChallenge(challenges, "mate-in-1-001");
const report = await runSuite({
  suiteId: "saved-1",
  challenges: [challenge],
  agents: [new MockAgent({ id: "test", script: SOLUTIONS[challenge.id], structured: true })],
});
const saved = { report, challenges: [challenge] };

describe("local benchmark history", () => {
  test("new browsers start with empty history", () => {
    expect(loadBenchmarkHistory(memoryStorage())).toEqual({ results: [], pending: null });
  });

  test("reports and complete replay snapshots survive reload", () => {
    const storage = memoryStorage();
    saveBenchmarkHistory(storage, { results: [saved], pending: null });
    const restored = loadBenchmarkHistory(storage);
    expect(restored.results[0]).toEqual(saved);
    expect(restored.results[0].challenges[0].fen).toBe(challenge.fen);
    expect(restored.results[0].challenges[0].sideToMove).toBe("white");
    expect(restored.results[0].report.runs[0].moves[0].reasoning).toBeDefined();
  });

  test("pending jobs survive navigation and completion preserves older reports", () => {
    const storage = memoryStorage();
    const pending = { id: "pending-2", challenges: [challenge], totalRuns: 1 };
    saveBenchmarkHistory(storage, { results: [saved], pending });
    const restored = loadBenchmarkHistory(storage);
    expect(restored.pending).toEqual(pending);
    const next = completeBenchmark(restored, { ...saved, report: { ...report, suiteId: "saved-2" } });
    expect(next.pending).toBeNull();
    expect(next.results.map((entry) => entry.report.suiteId)).toEqual(["saved-2", "saved-1"]);
    expect(completeBenchmark(next, next.results[0]).results).toHaveLength(2);
  });

  test("deletion persists without touching other results or the pending job", () => {
    const storage = memoryStorage();
    const history: BenchmarkHistory = {
      results: [saved, { ...saved, report: { ...report, suiteId: "keep" } }],
      pending: { id: "pending", challenges: [challenge], totalRuns: 1 },
    };
    saveBenchmarkHistory(storage, deleteBenchmark(history, report.suiteId));
    const restored = loadBenchmarkHistory(storage);
    expect(restored.results.map((entry) => entry.report.suiteId)).toEqual(["keep"]);
    expect(restored.pending).toEqual(history.pending);
    saveBenchmarkHistory(storage, deleteBenchmark(restored, "keep"));
    expect(loadBenchmarkHistory(storage).results).toEqual([]);
  });

  test("invalid JSON, versions, report shapes and missing positions are rejected", () => {
    const storage = memoryStorage();
    for (const raw of [
      "not json",
      JSON.stringify({ version: 2, results: [], pending: null }),
      JSON.stringify({ version: 1, results: [{ report: {} }], pending: null }),
      JSON.stringify({ version: 1, results: [{ ...saved, challenges: [] }], pending: null }),
    ]) {
      storage.setItem(BENCHMARK_STORAGE_KEY, raw);
      expect(() => loadBenchmarkHistory(storage)).toThrow();
      expect(storage.getItem(BENCHMARK_STORAGE_KEY)).toBe(raw);
    }
  });

  test("storage access and quota failures surface to the UI", () => {
    expect(() => loadBenchmarkHistory({
      getItem: () => { throw new Error("denied"); }, setItem: () => {},
    })).toThrow("denied");
    expect(() => saveBenchmarkHistory({
      getItem: () => null, setItem: () => { throw new Error("quota exceeded"); },
    }, { results: [saved], pending: null })).toThrow("quota exceeded");
  });
});
