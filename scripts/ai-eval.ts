/**
 * AI evaluation harness.
 *
 * "The AI suggests dependencies" is a claim, not a result. This script turns it
 * into a number.
 *
 * Method: take the seeded board, hide a set of edges that are known-true, ask
 * each provider to suggest dependencies on the reduced graph, and score what it
 * recovers. Precision, recall and F1 are reported per provider plus for the
 * consensus of both, alongside the deterministic heuristic as a floor — because
 * "our LLM gets 0.8 precision" means nothing until you know keyword matching
 * gets 0.5 on the same fixture.
 *
 * Every suggestion is scored *after* the gates, so what is measured is what a
 * user would actually be shown.
 *
 *   npm run ai:eval                 # heuristic only, no key required
 *   OPENAI_API_KEY=… npm run ai:eval
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsensus, runProvider, mergeSuggestions } from '../src/ai/consensus.ts';
import { applyGates } from '../src/ai/gates.ts';
import { GeminiProvider } from '../src/ai/gemini.ts';
import { HeuristicProvider } from '../src/ai/heuristic.ts';
import { OpenAiProvider } from '../src/ai/openai.ts';
import type { LlmProvider, ProviderResult } from '../src/ai/provider.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/db.ts';
import { Repository } from '../src/db/repository.ts';
import { toGraph } from '../src/services/board.ts';
import { buildSuggestRequest } from '../src/services/suggestions.ts';
import { HELD_BACK_EDGES, SEED_EDGES, seedBoard } from '../src/seed.ts';

/**
 * The evaluation set.
 *
 * `HELD_BACK_EDGES` are true dependencies the seed never inserts, so nothing
 * needs to be removed to test them. The rest are removed from the board before
 * the model is asked, which is the harder and more honest test: the model must
 * find them without the surrounding structure hinting at them.
 */
const REMOVED_FOR_EVAL: Array<[string, string]> = [
  ['TF-3', 'TF-6'],
  ['TF-5', 'TF-7'],
  ['TF-9', 'TF-10'],
];

interface Score {
  provider: string;
  proposed: number;
  gated: number;
  truePositives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  f1: number;
  latencyMs: number;
  note: string;
}

const pct = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '—');

function scoreOne(
  provider: string,
  accepted: Array<{ predecessorKey: string; successorKey: string }>,
  proposed: number,
  truth: Set<string>,
  latencyMs: number,
  note = '',
): Score {
  const found = new Set(accepted.map((s) => `${s.predecessorKey}>${s.successorKey}`));
  const truePositives = [...found].filter((p) => truth.has(p)).length;
  const falsePositives = found.size - truePositives;
  const precision = found.size === 0 ? 0 : truePositives / found.size;
  const recall = truth.size === 0 ? 0 : truePositives / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    provider,
    proposed,
    gated: found.size,
    truePositives,
    falsePositives,
    precision,
    recall,
    f1,
    latencyMs,
    note,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-eval-'));
  const cfg = loadConfig({
    ...process.env,
    DATABASE_PATH: join(dir, 'eval.db'),
    LOG_LEVEL: 'silent',
  });

  const db = openDatabase(cfg.databaseUrl);
  const repo = new Repository(db);
  const { board } = seedBoard(repo, { reset: true });

  // Remove the evaluation edges so the model has to rediscover them.
  const keyToId = new Map(repo.listTasks(board.id).map((t) => [t.key, t.id] as const));
  for (const [from, to] of REMOVED_FOR_EVAL) {
    const edge = repo
      .listDependencies(board.id)
      .find((d) => d.predecessor_id === keyToId.get(from) && d.successor_id === keyToId.get(to));
    if (edge) repo.deleteDependency(edge.id);
  }

  const truth = new Set([...HELD_BACK_EDGES, ...REMOVED_FOR_EVAL].map(([a, b]) => `${a}>${b}`));
  const request = buildSuggestRequest(repo, board);
  const tasks = repo.listTasks(board.id);
  const graph = toGraph(tasks, repo.listDependencies(board.id));

  const gateFor = (results: ProviderResult[]) =>
    applyGates({
      raw: mergeSuggestions(results),
      graph,
      textByKey: new Map(tasks.map((t) => [t.key, `${t.title}\n${t.description}`])),
      idByKey: new Map(tasks.map((t) => [t.key, t.id])),
      rejectedPairs: new Set(),
      // Deliberately generous: capping at 6 would cap recall at 6/4 and make
      // the numbers look better than the model deserves.
      maxSuggestions: 32,
    });

  const candidates: LlmProvider[] = [new HeuristicProvider()];
  if (cfg.openaiApiKey) {
    candidates.push(
      new OpenAiProvider({
        apiKey: cfg.openaiApiKey,
        model: cfg.openaiModel,
        timeoutMs: cfg.aiTimeoutMs,
      }),
    );
  }
  if (cfg.geminiApiKey) {
    candidates.push(
      new GeminiProvider({
        apiKey: cfg.geminiApiKey,
        model: cfg.geminiModel,
        timeoutMs: cfg.aiTimeoutMs,
      }),
    );
  }

  const scores: Score[] = [];
  const liveResults: ProviderResult[] = [];

  for (const provider of candidates) {
    const result = await runProvider(provider, request);
    if (result.error) {
      scores.push(
        scoreOne(provider.name, [], 0, truth, result.latencyMs, `failed: ${result.error}`),
      );
      continue;
    }
    if (provider.name !== 'heuristic') liveResults.push(result);
    const gated = gateFor([result]);
    scores.push(
      scoreOne(provider.name, gated.accepted, result.suggestions.length, truth, result.latencyMs),
    );
  }

  if (liveResults.length >= 2) {
    const consensus = await runConsensus(cfg, request);
    const agreedOnly = consensus.suggestions.filter((s) => s.agreement >= 2);
    const gated = gateFor([
      { provider: 'consensus', model: 'agreed-only', suggestions: agreedOnly, latencyMs: 0 },
    ]);
    scores.push(
      scoreOne(
        'consensus (agreed by both)',
        gated.accepted,
        agreedOnly.length,
        truth,
        consensus.latencyMs,
        'only edges both models proposed independently',
      ),
    );
  }

  // ---- report ------------------------------------------------------------
  const lines: string[] = [];
  lines.push('');
  lines.push('TaskFlow Pro — AI dependency suggestion evaluation');
  lines.push('='.repeat(78));
  lines.push(`Board: ${request.tasks.length} tasks, ${request.existingEdges.length} visible edges`);
  lines.push(`Ground truth: ${truth.size} hidden dependencies — ${[...truth].join(', ')}`);
  lines.push('');
  lines.push(
    ['provider', 'raw', 'gated', 'TP', 'FP', 'prec', 'recall', 'F1', 'ms']
      .map((h, i) => (i === 0 ? h.padEnd(26) : h.padStart(7)))
      .join(''),
  );
  lines.push('-'.repeat(78));
  for (const s of scores) {
    lines.push(
      [
        s.provider.padEnd(26),
        String(s.proposed).padStart(7),
        String(s.gated).padStart(7),
        String(s.truePositives).padStart(7),
        String(s.falsePositives).padStart(7),
        pct(s.precision).padStart(7),
        pct(s.recall).padStart(7),
        pct(s.f1).padStart(7),
        String(s.latencyMs).padStart(7),
      ].join(''),
    );
    if (s.note) lines.push(`${''.padEnd(26)}${s.note}`);
  }
  lines.push('-'.repeat(78));
  lines.push('');
  lines.push('Reading this table:');
  lines.push('  raw    = suggestions the provider returned');
  lines.push('  gated  = suggestions that survived the dependency engine and reached a user');
  lines.push('  prec   = of what a user was shown, the fraction that was a real hidden edge');
  lines.push('  recall = of the hidden edges, the fraction recovered');
  lines.push('');
  lines.push('A false positive here is not necessarily a bad suggestion: the board has many');
  lines.push('defensible orderings and only these were removed. Precision is therefore a');
  lines.push('lower bound. Recall is the honest metric, and consensus should beat either');
  lines.push('model alone on precision while losing some recall — which is the trade an');
  lines.push('approval queue should make.');
  lines.push('');
  if (candidates.length === 1) {
    lines.push('No API keys were configured, so only the offline baseline ran.');
    lines.push('Set OPENAI_API_KEY and/or GEMINI_API_KEY to evaluate the models.');
    lines.push('');
  }

  console.log(lines.join('\n'));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

await main();
