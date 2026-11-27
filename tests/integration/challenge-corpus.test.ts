import { describe, expect, test } from "bun:test";
import { Chess } from "chess.js";
import { fileURLToPath } from "node:url";
import { loadLibrary } from "../../src/challenges/library.ts";
import { MateVerification, validateMateProof, verifyMate } from "../../src/challenges/mate-verifier.ts";
import { PuzzleRow, QUOTAS, difficultyFor } from "../../src/cli/import-challenges.ts";
import { EngineRun } from "../../src/engine/run.ts";

const directory = fileURLToPath(new URL("../../challenges/", import.meta.url));
const { challenges, errors } = await loadLibrary(directory);
const archive = await Bun.file(`${directory}/provenance/lichess-source.json`).json() as { rows: PuzzleRow[]; sourceSha256: string };
const proofs = await Bun.file(`${directory}/provenance/mate-proofs.json`).json() as Record<string, MateVerification>;

describe("sourced challenge corpus", () => {
  test("exactly 100 unique challenges cover every agreed depth/rating bucket", () => {
    expect(errors).toEqual([]);
    expect(challenges).toHaveLength(100);
    expect(new Set(challenges.map((c) => c.id)).size).toBe(100);
    expect(new Set(challenges.map((c) => c.fen.split(" ").slice(0, 4).join(" "))).size).toBe(100);
    const counts = [1, 2, 3].map((depth) => ["easy", "medium", "hard"].map((difficulty) =>
      challenges.filter((c) => c.mateInN === depth && c.difficulty === difficulty).length));
    expect(counts).toEqual(QUOTAS);
    expect(new Set(challenges.map((c) => c.sideToMove)).size).toBe(2);
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(archive.rows)).digest("hex")).toBe(archive.sourceSha256);
  });

  for (const challenge of challenges) {
    test(`${challenge.id}: source provenance and exact forced mate in ${challenge.mateInN}`, () => {
      const source = challenge.source!;
      expect(source.provider).toBe("lichess");
      expect(source.license).toBe("CC0-1.0");
      expect(challenge.difficulty).toBe(difficultyFor(source.rating));
      const row = archive.rows.find((r) => r.PuzzleId === source.puzzleId)!;
      expect(row.Rating).toBe(source.rating);
      const game = new Chess(row.FEN);
      const moves = row.Moves.split(" ");
      const apply = (uci: string) => game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      apply(moves.shift()!);
      expect(game.fen()).toBe(challenge.fen);
      for (const move of moves) apply(move);
      expect(game.isCheckmate()).toBe(true);
      expect(moves).toHaveLength(challenge.mateInN * 2 - 1);
      const verification = proofs[challenge.id];
      expect(verification.depth).toBe(challenge.mateInN);
      expect(validateMateProof(challenge.fen, verification.proof, challenge.mateInN)).toBe(true);
      if (challenge.mateInN > 1) expect(verifyMate(challenge.fen, challenge.mateInN - 1)).toBeNull();

      // The published solution line (solver moves vs. our fixed defender) solves.
      expect(challenge.solution?.length ?? 0).toBeGreaterThan(0);
      expect(challenge.solution!.length).toBeLessThanOrEqual(challenge.mateInN);
      const solutionRun = new EngineRun(challenge, "solution");
      for (const move of challenge.solution!) solutionRun.applySolverMove(move);
      expect(solutionRun.snapshot().status).toBe("solved");

      // A branching proof, not the source PV, must also solve against our runtime defender.
      const run = new EngineRun(challenge, "verification");
      let proof = verification.proof;
      while (run.snapshot().status === "in_progress") {
        const result = run.applySolverMove(proof.move);
        if (result.defenderMove) proof = proof.replies[result.defenderMove.uci];
        if (result.status === "in_progress") expect(proof).toBeDefined();
      }
      expect(run.snapshot().status).toBe("solved");
    });
  }
});
