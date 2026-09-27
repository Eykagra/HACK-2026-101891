/**
 * Gemini provider.
 *
 * Gemini enforces the same schema through `responseSchema` plus a JSON response
 * MIME type, so both vendors are held to an identical contract and their
 * outputs are directly comparable. That comparability is the point: it is what
 * makes cross-model consensus a real signal rather than a marketing line.
 */

import {
  SUGGESTION_JSON_SCHEMA,
  withTimeout,
  type LlmProvider,
  type RawSuggestion,
  type SuggestRequest,
} from './provider.ts';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.ts';
import { extractSuggestions } from './openai.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
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

  private async generate(prompt: string, system: string, maxTokens: number): Promise<string> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not configured');
    const structured = maxTokens > 400;
    return withTimeout(
      async (signal) => {
        const response = await fetch(`${BASE}/${encodeURIComponent(this.model)}:generateContent`, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            // Header rather than a query parameter, so the key never appears
            // in a URL that might be logged by a proxy.
            'x-goog-api-key': this.apiKey!,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: maxTokens,
              ...(structured
                ? {
                    responseMimeType: 'application/json',
                    responseSchema: SUGGESTION_JSON_SCHEMA,
                  }
                : {}),
            },
          }),
        });
        if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
        const json = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        return (
          json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
        ).trim();
      },
      this.timeoutMs,
      'Gemini request',
    );
  }

  async suggestDependencies(request: SuggestRequest): Promise<RawSuggestion[]> {
    const text = await this.generate(buildUserPrompt(request), SYSTEM_PROMPT, 2048);
    return extractSuggestions(text, this.name);
  }

  async explainImpact(prompt: string): Promise<string> {
    return this.generate(prompt, 'You explain project schedule changes.', 320);
  }
}
