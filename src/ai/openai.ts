/**
 * OpenAI provider.
 *
 * Uses strict `json_schema` structured output so the response shape is enforced
 * by the API rather than hoped for, and `temperature: 0` so an identical board
 * yields an identical suggestion set (which is what makes the evaluation
 * harness meaningful and the tests stable).
 *
 * The key is read from config, used only here, and never logged or returned.
 */

import {
  SUGGESTION_JSON_SCHEMA,
  withTimeout,
  type LlmProvider,
  type RawSuggestion,
  type SuggestRequest,
} from './provider.ts';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.ts';
import { parseProviderPayload } from './gates.ts';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string | null; model: string; timeoutMs: number }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
  }

  get available(): boolean {
    return this.apiKey !== null;
  }

  async suggestDependencies(request: SuggestRequest): Promise<RawSuggestion[]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const body = {
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(request) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'dependency_suggestions',
          strict: true,
          schema: SUGGESTION_JSON_SCHEMA,
        },
      },
    };

    const text = await withTimeout(
      async (signal) => {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          // Deliberately does not include the response body verbatim in case a
          // provider ever echoes request content back in an error.
          throw new Error(`OpenAI returned HTTP ${response.status}`);
        }
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return json.choices?.[0]?.message?.content ?? '';
      },
      this.timeoutMs,
      'OpenAI request',
    );

    return extractSuggestions(text, this.name);
  }

  async explainImpact(prompt: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured');
    return withTimeout(
      async (signal) => {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            temperature: 0,
            max_tokens: 220,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}`);
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return (json.choices?.[0]?.message?.content ?? '').trim();
      },
      this.timeoutMs,
      'OpenAI narrative request',
    );
  }
}

/**
 * Shared JSON extraction.
 *
 * Even with schema-enforced output, a model can return the JSON wrapped in a
 * code fence. Strip that, then validate. Anything still malformed is a hard
 * error the caller degrades from, never a silent empty result.
 */
export function extractSuggestions(text: string, provider: string): RawSuggestion[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`${provider} returned output that is not valid JSON`);
  }
  const result = parseProviderPayload(parsed);
  if (!result.ok) {
    throw new Error(
      `${provider} returned JSON that does not match the schema: ${result.issues
        .slice(0, 3)
        .map((i) => `${i.path} ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.value;
}
