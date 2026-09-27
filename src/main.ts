/**
 * Process entrypoint.
 *
 * Boot order is deliberate: validate config, open the database, apply the
 * schema, seed if empty, then listen. A misconfigured process dies here with a
 * readable message instead of serving 500s. The demo board is created
 * automatically on first boot, so `docker compose up` is genuinely the only
 * command needed to get a working, populated app.
 */

import { loadConfig } from './config.ts';
import { openDatabase } from './db/db.ts';
import { Repository } from './db/repository.ts';
import { buildRoutes } from './http/routes.ts';
import { createApp } from './http/server.ts';
import { seedBoard } from './seed.ts';
import { publicAiInfo } from './config.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, '..', 'web');

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databaseUrl);
  const repo = new Repository(db);

  // First boot, or a database that was wiped: populate the demo scenario.
  let board = repo.getFirstBoard();
  if (!board) {
    const seeded = seedBoard(repo);
    board = seeded.board;
    console.log(
      `Seeded demo board "${board.name}": ${seeded.taskCount} tasks, ${seeded.edgeCount} dependencies.`,
    );
  }

  // Re-read per request rather than closing over the row: the admin reset
  // endpoint replaces the board, and a stale closure would keep serving the
  // deleted one.
  const currentBoard = () => {
    const found = repo.getFirstBoard();
    if (!found) throw new Error('No board exists; run `npm run db:seed`.');
    return found;
  };

  const server = createApp({
    config,
    routes: buildRoutes({ repo, config, board: currentBoard }),
    staticDir: WEB_DIR,
  });

  server.listen(config.port, config.host, () => {
    const ai = publicAiInfo(config);
    console.log(`TaskFlow Pro listening on http://${config.host}:${config.port}`);
    console.log(
      `AI mode: ${ai.mode} (openai=${ai.openaiConfigured ? ai.openaiModel : 'off'}, ` +
        `gemini=${ai.geminiConfigured ? ai.geminiModel : 'off'})`,
    );
    if (ai.mode === 'consensus' && !ai.openaiConfigured && !ai.geminiConfigured) {
      console.log(
        'No API keys configured, so suggestions come from the offline heuristic provider. ' +
          'Set OPENAI_API_KEY and/or GEMINI_API_KEY for model-backed consensus.',
      );
    }
  });

  // Graceful shutdown so an in-flight write is never torn off mid-transaction
  // and the WAL is checkpointed before the container exits.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang a container restart on a stuck keep-alive socket.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
