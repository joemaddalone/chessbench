#!/usr/bin/env bun
import { Chess } from "chess.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { solutionMoves, verifyMate } from "../challenges/mate-verifier.ts";
import { LexicographicDefender } from "../engine/defender.ts";
import { validateChallenge } from "../engine/validation.ts";

export interface PuzzleRow {
  PuzzleId: string; GameId: string; FEN: string; Moves: string;
  Rating: number; RatingDeviation: number; Popularity: number; NbPlays: number; Themes: string[];
}
export const QUOTAS = [[12, 11, 11], [11, 12, 10], [11, 10, 12]];
export const difficultyFor = (rating: number) => rating < 1200 ? "easy" : rating < 1800 ? "medium" : "hard";
const difficulties = ["easy", "medium", "hard"] as const;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  const sourceIndex = process.argv.indexOf("--source");
  const archive = sourceIndex >= 0 ? await Bun.file(process.argv[sourceIndex + 1]).json() as { rows: PuzzleRow[]; importedAt: string; scanned: number; verificationSkipped: number } : null;
  const accepted: Array<{ challenge: ReturnType<typeof validateChallenge>; row: PuzzleRow; verification: NonNullable<ReturnType<typeof verifyMate>> }> = [];
  const counts = QUOTAS.map(() => [0, 0, 0]);
  const positions = new Set<string>();
  let scanned = 0;
  let verificationSkipped = 0;
  const full = () => counts.every((row, depth) => row.every((count, difficulty) => count === QUOTAS[depth][difficulty]));
  const consider = (row: PuzzleRow) => {
    scanned++;
    if (full() || row.Popularity < 80 || row.NbPlays < 100 || row.RatingDeviation > 100) return;
    const depth = [1, 2, 3].find((n) => row.Themes.includes(`mateIn${n}`));
    if (!depth) return;
    const difficulty = difficultyFor(row.Rating);
    const column = difficulties.indexOf(difficulty);
    if (counts[depth - 1][column] >= QUOTAS[depth - 1][column]) return;
    try {
      const game = new Chess(row.FEN);
      const moves = row.Moves.split(" ");
      const setup = moves.shift()!;
      game.move({ from: setup.slice(0, 2), to: setup.slice(2, 4), promotion: setup[4] });
      const fen = game.fen();
      const position = fen.split(" ").slice(0, 4).join(" ");
      if (positions.has(position)) return;
      const sideToMove = game.turn() === "w" ? "white" : "black";
      for (const move of moves) game.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
      if (!game.isCheckmate() || moves.length !== 2 * depth - 1) return;
      // Bounded exhaustive search, including non-checking solver moves and ALL defensive replies.
      const verification = verifyMate(fen, depth, 3000);
      if (!verification || verification.depth !== depth) return;
      // Solver moves along our fixed, deterministic defender — the same line the
      // runtime validates, so a benchmark can keep the winning move among a
      // limited candidate set.
      const defender = new LexicographicDefender();
      const solution = solutionMoves(fen, verification.proof, (position) => defender.chooseMove(position));
      const themes = row.Themes.filter((theme) => !["mate", `mateIn${depth}`, "oneMove", "short", "long", "veryLong"].includes(theme));
      const theme = themes.find((theme) => !["middlegame", "endgame", "opening", "master", "masterVsMaster"].includes(theme)) ?? "Checkmate";
      const label = theme.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
      const challenge = validateChallenge({
        id: `lichess-${row.PuzzleId}`, title: `${label} · ${row.PuzzleId}`,
        description: `${sideToMove === "white" ? "White" : "Black"} to move and force mate in ${depth}. Lichess puzzle rating ${row.Rating}.`,
        fen, sideToMove, mateInN: depth, difficulty, tags: row.Themes, solution,
        source: { provider: "lichess", puzzleId: row.PuzzleId, url: `https://lichess.org/training/${row.PuzzleId}`,
          gameUrl: `https://lichess.org/${row.GameId}`, rating: row.Rating, license: "CC0-1.0" },
      }, row.PuzzleId);
      accepted.push({ challenge, row, verification });
      positions.add(position);
      counts[depth - 1][column]++;
      console.error(`accepted ${accepted.length}/100: ${row.PuzzleId} mate ${depth} ${difficulty} (${verification.nodes} nodes)`);
    } catch (error) {
      verificationSkipped++;
      if (!(error instanceof Error) || !error.message.includes("node limit")) console.error(`skipping ${row.PuzzleId}: ${String(error)}`);
    }
  };
  if (archive) {
    archive.rows.forEach(consider);
  } else {
    // Rows API avoids a multi-GB download. Scan a deterministic prefix, never random daily puzzles.
    const cache = join(ROOT, ".cache", "lichess-rows");
    await mkdir(cache, { recursive: true });
    for (let offset = 0; offset < 100000 && !full(); offset += 100) {
      const url = `https://datasets-server.huggingface.co/rows?dataset=Lichess/chess-puzzles&config=default&split=train&offset=${offset}&length=100`;
      const cacheFile = Bun.file(join(cache, `${offset}.json`));
      let rows: Array<{ row: PuzzleRow }> | undefined = await cacheFile.exists() ? await cacheFile.json() : undefined;
      for (let attempt = 0; !rows && attempt < 8; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
          if (response.ok) {
            rows = (await response.json() as { rows: Array<{ row: PuzzleRow }> }).rows;
            await Bun.write(cacheFile, JSON.stringify(rows));
          } else console.error(`fetch ${offset}: HTTP ${response.status}`);
        } catch (error) { console.error(`fetch ${offset}: ${String(error)}`); }
        if (!rows) await Bun.sleep(5000 * (attempt + 1));
      }
      if (!rows) throw new Error(`Could not fetch sample at offset ${offset}; no challenge files written.`);
      rows.forEach(({ row }) => consider(row));
      if (offset % 1000 === 0) console.error(`scanned ${scanned}, quotas ${JSON.stringify(counts)}`);
    }
  }
  if (!full()) throw new Error(`Insufficient verified puzzles: ${JSON.stringify(counts)}; no challenge files written.`);
  const directory = join(ROOT, "challenges");
  await mkdir(join(directory, "provenance"), { recursive: true });
  const rows = accepted.map((entry) => entry.row);
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex");
  await Bun.write(join(directory, "provenance", "lichess-source.json"), JSON.stringify({
    dataset: "https://huggingface.co/datasets/Lichess/chess-puzzles", upstream: "https://database.lichess.org/#puzzles",
    license: "CC0-1.0", importedAt: archive?.importedAt ?? new Date().toISOString(), sourceSha256: hash,
    scanned: archive?.scanned ?? scanned, verificationSkipped: archive?.verificationSkipped ?? verificationSkipped, rows,
  }, null, 2) + "\n");
  await Bun.write(join(directory, "provenance", "mate-proofs.json"), JSON.stringify(
    Object.fromEntries(accepted.map(({ challenge, verification }) => [challenge.id, verification])), null, 2) + "\n");
  for (const { challenge } of accepted) {
    await Bun.write(join(directory, `${challenge.id}.json`), JSON.stringify(challenge, null, 2) + "\n");
  }
  console.error(`Imported ${accepted.length} unique verified puzzles. Counts: ${JSON.stringify(counts)}. SHA256: ${hash}`);
}
if (import.meta.main) await main();
