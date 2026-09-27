/**
 * The provider boundary.
 *
 * One interface, four implementations: OpenAI, Gemini, a deterministic
 * heuristic, and a fixture-driven mock. Everything above this line is
 * provider-agnostic, which is what lets the whole AI path be covered by tests
 * that need no API key and no network.
 */

export interface SuggestTask {
  /** Stable human key such as `TF-3`. Models only ever see and return keys. */
  key: string;
  title: string;
  description: string;
  stage: string;
  durationDays: number;
}

export interface SuggestRequest {
  tasks: SuggestTask[];
  existingEdges: Array<[string, string]>;
  rejectedPairs: Array<[string, string]>;
  maxSuggestions: number;
}

/** Exactly what a provider is allowed to return, before any validation. */
export interface RawSuggestion {
  predecessorKey: string;
  successorKey: string;
  confidence: number;
  rationale: string;
  evidence: { predecessor: string; successor: string };
}

export interface ProviderResult {
  provider: string;
  model: string;
  suggestions: RawSuggestion[];
  /** Populated instead of `suggestions` when the provider failed. */
  error?: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Whether this provider is usable right now (for example, has a key). */
  readonly available: boolean;
  suggestDependencies(request: SuggestRequest): Promise<RawSuggestion[]>;
  /** Optional: narrate an already-computed schedule change. */
  explainImpact?(prompt: string): Promise<string>;
}

/** Shared JSON-schema fragment; both vendors enforce it server-side. */
export const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['predecessorKey', 'successorKey', 'confidence', 'rationale', 'evidence'],
        properties: {
          predecessorKey: { type: 'string' },
          successorKey: { type: 'string' },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
          evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['predecessor', 'successor'],
            properties: {
              predecessor: { type: 'string' },
              successor: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

export async function withTimeout<T>(
  promise: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${ms}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
