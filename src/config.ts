/**
 * Configuration, validated at boot.
 *
 * The process refuses to start on a malformed value rather than failing later
 * on the first request. Secrets are read here and nowhere else, they are never
 * logged, and they are never sent to the browser: the client only learns
 * whether an AI provider is *configured*, never its credentials.
 */

import { int, oneOf, parse, str } from './validate.ts';

export const AI_MODES = ['consensus', 'openai', 'gemini', 'heuristic', 'mock'] as const;
export type AiMode = (typeof AI_MODES)[number];

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  nodeEnv: 'development' | 'production' | 'test';
  aiMode: AiMode;
  openaiApiKey: string | null;
  openaiModel: string;
  geminiApiKey: string | null;
  geminiModel: string;
  aiTimeoutMs: number;
  adminToken: string | null;
  maxBodyBytes: number;
  logLevel: 'debug' | 'info' | 'silent';
}

/**
 * Reads an optional secret from the supplied environment.
 *
 * Takes `env` explicitly rather than reaching for `process.env`, so a test can
 * construct a fully isolated config. An unreplaced placeholder from
 * `.env.example` counts as absent, which is what makes a half-filled `.env`
 * degrade to the offline provider instead of sending `your-key-here` to OpenAI.
 */
function optionalSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (!raw || raw.trim() === '' || raw.trim().startsWith('your-')) return null;
  return raw.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = parse(
    // Note: no secret is validated for *shape*, only presence. Validating a
    // key's format would risk logging it in an error message.
    (value) => {
      const src = value as Record<string, unknown>;
      // 0 is legal and meaningful: it asks the OS for a free port, which is
      // how the integration tests bind without racing each other.
      const port = int({ min: 0, max: 65535 })(src.PORT ?? 8080, 'PORT');
      const host = str({ min: 1 })(src.HOST ?? '0.0.0.0', 'HOST');
      const db = str({ min: 1 })(src.DATABASE_PATH ?? './data/taskflow.db', 'DATABASE_PATH');
      const nodeEnv = oneOf(['development', 'production', 'test'] as const)(
        src.NODE_ENV ?? 'development',
        'NODE_ENV',
      );
      const aiMode = oneOf(AI_MODES)(src.AI_MODE ?? 'consensus', 'AI_MODE');
      const timeout = int({ min: 1000, max: 120_000 })(
        src.AI_TIMEOUT_MS ?? 15_000,
        'AI_TIMEOUT_MS',
      );
      const logLevel = oneOf(['debug', 'info', 'silent'] as const)(
        src.LOG_LEVEL ?? 'info',
        'LOG_LEVEL',
      );
      const maxBody = int({ min: 1024, max: 5_000_000 })(
        src.MAX_BODY_BYTES ?? 262_144,
        'MAX_BODY_BYTES',
      );
      return {
        value: {
          port: port.value,
          host: host.value,
          databaseUrl: db.value,
          nodeEnv: nodeEnv.value,
          aiMode: aiMode.value,
          aiTimeoutMs: timeout.value,
          logLevel: logLevel.value,
          maxBodyBytes: maxBody.value,
        },
        issues: [
          ...port.issues,
          ...host.issues,
          ...db.issues,
          ...nodeEnv.issues,
          ...aiMode.issues,
          ...timeout.issues,
          ...logLevel.issues,
          ...maxBody.issues,
        ],
      };
    },
    env,
  );

  if (!parsed.ok) {
    const detail = parsed.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }

  return {
    ...parsed.value,
    openaiApiKey: optionalSecret(env, 'OPENAI_API_KEY'),
    openaiModel: (env.OPENAI_MODEL ?? 'gpt-4o-mini').trim(),
    geminiApiKey: optionalSecret(env, 'GEMINI_API_KEY'),
    geminiModel: (env.GEMINI_MODEL ?? 'gemini-2.0-flash').trim(),
    adminToken: optionalSecret(env, 'ADMIN_TOKEN'),
  };
}

/** What the browser is allowed to know about the AI setup. */
export function publicAiInfo(cfg: Config) {
  return {
    mode: cfg.aiMode,
    openaiConfigured: cfg.openaiApiKey !== null,
    geminiConfigured: cfg.geminiApiKey !== null,
    openaiModel: cfg.openaiModel,
    geminiModel: cfg.geminiModel,
  };
}
