import { afterEach, describe, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { fileURLToPath } from "node:url";
import { JevAgent } from "../../src/agents/agent-adapters/jev.ts";
import { legalMovesWithDescriptions } from "../../src/agents/protocol/reasoning.ts";
import { runAgentChallenge } from "../../src/agents/runner.ts";
import { loadLibrary } from "../../src/challenges/library.ts";

const CORPUS = fileURLToPath(new URL("../../challenges/", import.meta.url));
const SAVED_ENV = { ...process.env };

interface SeenBody {
  state: { fen: string; history: string[] };
  questions: { best_move: { criteria: Record<string, string> } };
}

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("bounded candidate choices", () => {
  test("each solver turn offers at most the limit and always includes the proven move", async () => {
    const { challenges } = await loadLibrary(CORPUS);
    const challenge = challenges.find(
      (c) => (c.solution?.length ?? 0) > 0 && legalMovesWithDescriptions(c.fen).length > 25,
    );
    expect(challenge).toBeDefined();
    const solution = challenge!.solution!;

    const seen: SeenBody[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as SeenBody;
        seen.push(body);
        // History holds solver+defender plies, so the solver turn index is half its length.
        const uciMove = solution[body.state.history.length / 2];
        const game = new Chess(body.state.fen);
        const san = game
          .moves({ verbose: true })
          .find((m) => m.from + m.to + (m.promotion ?? "") === uciMove)!.san;
        return Response.json({ answers: { best_move: { choice: san } } });
      },
    });
    process.env.JEV_API_KEY = "test-key";
    process.env.JEV_ENDPOINT = `http://127.0.0.1:${server.port}/move`;
    try {
      const record = await runAgentChallenge({
        challenge: challenge!,
        agent: new JevAgent({ id: "jev", model: "fixture" }),
        runId: "choice-limit",
        choiceLimit: 20,
      });
      expect(record.status).toBe("solved");
      expect(seen).toHaveLength(solution.length);
      for (const [i, body] of seen.entries()) {
        const labels = Object.keys(body.questions.best_move.criteria);
        expect(labels.length).toBeLessThanOrEqual(20);
        const expectedSan = new Chess(body.state.fen)
          .moves({ verbose: true })
          .find((m) => m.from + m.to + (m.promotion ?? "") === solution[i])!.san;
        expect(labels).toContain(expectedSan);
      }
      // The cap really did trim the option set (the corpus position has >25 moves).
      expect(Object.keys(seen[0].questions.best_move.criteria).length).toBeLessThan(
        legalMovesWithDescriptions(challenge!.fen).length,
      );
    } finally {
      server.stop();
    }
  });
});
