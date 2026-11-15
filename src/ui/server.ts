import index from "./index.html";
import { createAgent, isProviderKey, PROVIDER_KEYS } from "../agents/registry.ts";
import { Agent } from "../agents/protocol/types.ts";
import { runSuite } from "../benchmark/runner.ts";
import { getChallenge, listChallenges, loadLibrary } from "../challenges/library.ts";
import { BenchmarkJobStore } from "./benchmark-jobs.ts";
import { fileURLToPath } from "node:url";

const CHALLENGES_DIR = fileURLToPath(new URL("../../challenges/", import.meta.url));
const serverJobs = new BenchmarkJobStore();

const AGENT_KINDS = PROVIDER_KEYS;
type AgentKind = (typeof AGENT_KINDS)[number];

function isAgentKind(value: unknown): value is AgentKind {
  return isProviderKey(value);
}

function buildAgent(kind: AgentKind, model?: string): Agent {
  return createAgent(kind, { id: kind, ...(model ? { model } : {}) });
}

interface AgentOffer {
  id: string;
  provider: string;
  model: string;
  available: boolean;
  reason: string | null;
}

async function agentOffers(): Promise<AgentOffer[]> {
  const probes = PROVIDER_KEYS.map((key) => ({
    id: key,
    agent: createAgent(key, { id: key }),
  }));
  return await Promise.all(
    probes.map(async ({ id, agent }) => {
      const availability = await agent.checkAvailability();
      return {
        id,
        provider: agent.provider,
        model: agent.model,
        available: availability.ok,
        reason: availability.ok ? null : availability.reason,
      };
    }),
  );
}

interface BenchmarkSelection {
  challengeIds?: unknown;
  agents?: unknown;
  choiceLimit?: unknown;
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

async function handlePostBenchmarks(req: Request, challengesDir: string): Promise<Response> {
  let selection: BenchmarkSelection;
  try {
    selection = (await req.json()) as BenchmarkSelection;
  } catch {
    return badRequest("request body must be valid JSON");
  }
  const { challenges, errors } = await loadLibrary(challengesDir);
  for (const e of errors) console.error(`library: ${e.message}`);
  if (!Array.isArray(selection.challengeIds) || selection.challengeIds.length === 0) {
    return badRequest("challengeIds must be a non-empty array");
  }
  if (!Array.isArray(selection.agents) || selection.agents.length === 0) {
    return badRequest("agents must be a non-empty array");
  }
  const challengeIds: string[] = [];
  for (const id of selection.challengeIds) {
    if (typeof id !== "string") return badRequest("challengeIds must be strings");
    try {
      getChallenge(challenges, id);
    } catch {
      return badRequest(`unknown challenge "${id}"`);
    }
    challengeIds.push(id);
  }
  const kinds: AgentKind[] = [];
  const models = new Map<string, string>();
  for (const entry of selection.agents) {
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as {
      kind?: unknown;
      model?: unknown;
    };
    const kind = typeof entry === "string" ? entry : record.kind;
    if (!isAgentKind(kind)) {
      return badRequest(
        `unknown agent kind "${String(kind)}" (expected ${PROVIDER_KEYS.join("|")})`,
      );
    }
    if (record.model !== undefined && typeof record.model !== "string") {
      return badRequest("agent model must be a string");
    }
    kinds.push(kind);
    if (typeof record.model === "string") models.set(kind, record.model);
  }
  let choiceLimit: number | undefined;
  if (selection.choiceLimit !== undefined) {
    if (!Number.isInteger(selection.choiceLimit) || (selection.choiceLimit as number) < 1) {
      return badRequest("choiceLimit must be a positive integer when present");
    }
    choiceLimit = selection.choiceLimit as number;
  }
  const job = serverJobs.create(challengeIds, kinds);
  serverJobs.markRunning(job.id);
  const selected = challengeIds.map((cid) => getChallenge(challenges, cid));
  const agents = kinds.map((kind) => buildAgent(kind, models.get(kind)));
  runSuite({
    suiteId: job.id,
    challenges: selected,
    agents,
    ...(choiceLimit !== undefined ? { choiceLimit } : {}),
    onProgress: (completed) => serverJobs.markProgress(job.id, completed),
    onRunUpdate: (run) => serverJobs.updateRun(job.id, run),
  }).then(
    (report) => serverJobs.complete(job.id, report),
    (err) => serverJobs.fail(job.id, err instanceof Error ? err.message : String(err)),
  );
  return Response.json(
    { id: job.id, status: job.status, totalRuns: job.totalRuns },
    { status: 201 },
  );
}

/** Start the ChessBench server (exported for tests; ephemerally on port 0). */
export function startServer(port: number, challengesDir: string = CHALLENGES_DIR) {
  return Bun.serve({
    port,
    routes: {
      "/": index,
      "/api/challenges": async () => {
        const { challenges, errors } = await loadLibrary(challengesDir);
        if (errors.length > 0) console.error(errors.map((e) => e.message).join("\n"));
        return Response.json(listChallenges(challenges));
      },
      "/api/challenges/:id": async (req) => {
        const { challenges } = await loadLibrary(challengesDir);
        const found = challenges.find((c) => c.id === req.params.id);
        if (!found) {
          return Response.json({ error: `unknown challenge "${req.params.id}"` }, { status: 404 });
        }
        return Response.json(found);
      },
      "/api/agents": async () => Response.json(await agentOffers()),
      "/api/benchmarks": {
        POST: (req) => handlePostBenchmarks(req, challengesDir),
      },
      "/api/benchmarks/:id": async (req) => {
        const job = serverJobs.get(req.params.id);
        if (!job) {
          return Response.json({ error: `unknown job "${req.params.id}"` }, { status: 404 });
        }
        return Response.json({
          id: job.id,
          status: job.status,
          completedRuns: job.completedRuns,
          totalRuns: job.totalRuns,
          runs: job.runs,
          report: job.report,
          error: job.error,
        });
      },
    },
  });
}

if (import.meta.main) {
  const server = startServer(Number(process.env.PORT ?? 3210));
  console.log(`ChessBench UI at http://localhost:${server.port}`);
}
