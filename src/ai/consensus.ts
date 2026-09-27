/**
 * Multi-provider consensus.
 *
 * Two independent models are asked the same question. An edge that both models
 * propose without seeing each other's answer is much more likely to be a real
 * dependency than one proposed by a single model, so agreement is surfaced to
 * the reviewer as a first-class signal instead of being hidden inside an
 * averaged score.
 *
 * Failover is explicit and ordered: live models first, then the offline
 * heuristic. The heuristic needs no key and no network, so a missing key, a
 * vendor outage or an air-gapped demo degrades the feature to "less insightful
 * suggestions" rather than "500 Internal Server Error".
 */

import type { Config } from '../config.ts';
import { GeminiProvider } from './gemini.ts';
import { HeuristicProvider } from './heuristic.ts';
import { MockProvider, type MockScenario } from './mock.ts';
import { OpenAiProvider } from './openai.ts';
import type { LlmProvider, ProviderResult, RawSuggestion, SuggestRequest } from './provider.ts';

/** Agreement is worth a bounded bump, never enough to clear a gate by itself. */
export const AGREEMENT_BONUS = 0.1;

export interface ProviderReport {
  provider: string;
  model: string;
  ok: boolean;
  count: number;
  latencyMs: number;
  error: string | null;
  /** True when this provider only ran because the live ones failed. */
  fallback: boolean;
}

export interface ConsensusSuggestion extends RawSuggestion {
  /** Providers that independently produced this exact ordered pair. */
  providers: string[];
  /** How many of the models that answered agreed, e.g. 2. */
  agreement: number;
  /** Confidence after the agreement bonus, clamped to [0, 1]. */
  confidence: number;
}

export interface ConsensusResult {
  suggestions: ConsensusSuggestion[];
  reports: ProviderReport[];
  /** How many providers actually returned a usable answer. */
  respondedCount: number;
  degraded: boolean;
  latencyMs: number;
}

const pairOf = (s: RawSuggestion): string => `${s.predecessorKey}>${s.successorKey}`;

/**
 * Builds the provider chain for a mode. Every entry except the last is queried
 * concurrently; the last is the fallback and only runs if none of them answered.
 */
export function providersFor(cfg: Config): { live: LlmProvider[]; fallback: LlmProvider | null } {
  const openai = new OpenAiProvider({
    apiKey: cfg.openaiApiKey,
    model: cfg.openaiModel,
    timeoutMs: cfg.aiTimeoutMs,
  });
  const gemini = new GeminiProvider({
    apiKey: cfg.geminiApiKey,
    model: cfg.geminiModel,
    timeoutMs: cfg.aiTimeoutMs,
  });
  const heuristic = new HeuristicProvider();

  switch (cfg.aiMode) {
    case 'mock':
      return {
        live: [new MockProvider((process.env.AI_MOCK_SCENARIO as MockScenario) ?? 'clean')],
        fallback: null,
      };
    case 'heuristic':
      return { live: [heuristic], fallback: null };
    case 'openai':
      return openai.available
        ? { live: [openai], fallback: heuristic }
        : { live: [heuristic], fallback: null };
    case 'gemini':
      return gemini.available
        ? { live: [gemini], fallback: heuristic }
        : { live: [heuristic], fallback: null };
    case 'consensus':
    default: {
      const live = [openai, gemini].filter((p) => p.available);
      return live.length > 0
        ? { live, fallback: heuristic }
        : { live: [heuristic], fallback: null };
    }
  }
}

/** Runs one provider, converting a thrown error into a reported failure. */
export async function runProvider(
  provider: LlmProvider,
  request: SuggestRequest,
): Promise<ProviderResult> {
  const started = Date.now();
  try {
    const suggestions = await provider.suggestDependencies(request);
    return {
      provider: provider.name,
      model: provider.model,
      suggestions,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      provider: provider.name,
      model: provider.model,
      suggestions: [],
      error: (error as Error).message,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Merges results from several providers, deduplicating by ordered pair.
 *
 * When two providers propose the same edge the higher-confidence rationale wins,
 * both names are recorded, and the score gets a bounded agreement bonus. Output
 * order is fully deterministic — agreement desc, confidence desc, then pair key
 * — so identical inputs always render an identical list.
 */
export function mergeSuggestions(results: ProviderResult[]): ConsensusSuggestion[] {
  const responded = results.filter((r) => r.error === undefined);
  const merged = new Map<string, { best: RawSuggestion; providers: string[] }>();

  for (const result of responded) {
    for (const suggestion of result.suggestions) {
      const pair = pairOf(suggestion);
      const entry = merged.get(pair);
      if (!entry) {
        merged.set(pair, { best: suggestion, providers: [result.provider] });
        continue;
      }
      if (!entry.providers.includes(result.provider)) entry.providers.push(result.provider);
      if (suggestion.confidence > entry.best.confidence) entry.best = suggestion;
    }
  }

  const out: ConsensusSuggestion[] = [];
  for (const entry of merged.values()) {
    const agreement = entry.providers.length;
    const bonus = agreement > 1 ? AGREEMENT_BONUS : 0;
    out.push({
      ...entry.best,
      providers: [...entry.providers].sort(),
      agreement,
      confidence: Math.min(1, Number((entry.best.confidence + bonus).toFixed(4))),
    });
  }

  out.sort((a, b) => {
    if (a.agreement !== b.agreement) return b.agreement - a.agreement;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return pairOf(a).localeCompare(pairOf(b));
  });
  return out;
}

function toReport(result: ProviderResult, fallback: boolean): ProviderReport {
  return {
    provider: result.provider,
    model: result.model,
    ok: result.error === undefined,
    count: result.suggestions.length,
    latencyMs: result.latencyMs,
    error: result.error ?? null,
    fallback,
  };
}

/**
 * Queries the configured providers and merges their output.
 *
 * Live providers run concurrently: asking two models in series would double the
 * user-visible latency for no benefit.
 */
export async function runConsensus(cfg: Config, request: SuggestRequest): Promise<ConsensusResult> {
  const started = Date.now();
  const { live, fallback } = providersFor(cfg);

  let results = await Promise.all(live.map((p) => runProvider(p, request)));
  const reports = results.map((r) => toReport(r, false));
  const answered = results.filter((r) => r.error === undefined);
  let degraded = results.some((r) => r.error !== undefined);

  // Only reach for the offline baseline when nothing usable came back.
  if (answered.length === 0 && fallback) {
    const fb = await runProvider(fallback, request);
    reports.push(toReport(fb, true));
    results = [...results, fb];
    degraded = true;
  }

  return {
    suggestions: mergeSuggestions(results),
    reports,
    respondedCount: results.filter((r) => r.error === undefined).length,
    degraded,
    latencyMs: Date.now() - started,
  };
}
