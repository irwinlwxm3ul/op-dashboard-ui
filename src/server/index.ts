// DROPZONE game server entry point.
//
//   tsx src/server/index.ts   PORT (default 8787), LAG_MS, LAG_JITTER_MS, HOST, NODE_ENV,
//                             MATCH_WORKERS=0 (run matches on the main thread instead of workers)
//
// When imported (tests) nothing starts; use startServer().

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '../shared/constants';
import { createLogger } from './log';
import { startServer } from './server';

export { startServer } from './server';
export type { ServerHandle, StartServerOptions } from './server';
export type { MatchRunnerLike, RunnerClient, RunnerFactory, RunnerOptions, RunnerStats } from './runner';
export { loadInProcessRunnerFactory } from './runner';
export { createWorkerRunnerFactory, type WorkerRunnerFactory, type WorkerRunnerFactoryOptions } from './workerRunner';
export { DEFAULT_LIMITS, type ServerLimits } from './limits';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const resolved = path.resolve(entry);
  return resolved === self || resolved === self.replace(/\.ts$/, '') || resolved + '.ts' === self;
}

async function main(): Promise<void> {
  const log = createLogger(true);
  const handle = await startServer({
    port: envInt('PORT', DEFAULT_SERVER_PORT, 0, 65535),
    host: process.env.HOST || undefined,
    lagMs: envInt('LAG_MS', 0, 0, 5000),
    jitterMs: envInt('LAG_JITTER_MS', 0, 0, 5000),
    matchWorkers: process.env.MATCH_WORKERS !== '0',
    log: true,
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => {
      log.warn('forced exit after shutdown timeout');
      process.exit(1);
    }, 5000);
    force.unref();
    handle.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', { err });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    createLogger(true).error('server failed to start', { err });
    process.exit(1);
  });
}
