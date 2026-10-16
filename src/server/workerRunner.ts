// Worker-backed match runners: every match runs its MatchRunner + bot driver in its own
// worker_thread (src/server/matchWorker.ts). The main thread keeps networking, validation, rate
// limiting, LAG_MS, the snapshot delta codec and lobby logic; it only forwards validated client
// messages and relays the worker's batched outgoing messages to the connections.
//
// Benefits: the ~0.5 s synchronous world generation at match start no longer stalls other matches
// or the WebSocket loop, and concurrent matches use multiple cores.

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { ClientMessage } from '../shared/protocol';
import { createLogger, type Logger } from './log';
import type { FromWorker, ToWorker } from './matchWorkerProtocol';
import type { MatchRunnerLike, RunnerClient, RunnerFactory, RunnerOptions, RunnerStats } from './runner';

export interface WorkerRunnerFactory extends RunnerFactory {
  /** Terminate the warm spare and every match worker still alive. */
  dispose(): Promise<void>;
  /** Number of match workers currently running a match. */
  readonly activeWorkers: number;
}

export interface WorkerRunnerFactoryOptions {
  /** Default: silent. */
  log?: Logger;
  /** Keep one pre-booted worker (modules loaded) ready so matches start faster. Default true. */
  warmSpare?: boolean;
  /** Per-worker V8 limits (a runaway match crashes its worker, not the server). */
  resourceLimits?: ResourceLimits;
}

/** Delay before booting a replacement spare, so it does not compete with a starting match. */
const SPARE_RESPAWN_DELAY_MS = 2000;
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 1024 };

const RUNNING_TS = import.meta.url.endsWith('.ts');

/** file: URL of tsx's ESM register API (works without import.meta.resolve, e.g. under vitest). */
function tsxRegisterUrl(): string {
  const resolve = (import.meta as { resolve?: (s: string) => string }).resolve;
  if (typeof resolve === 'function') {
    try {
      return resolve('tsx/esm/api');
    } catch {
      // fall through to the package.json lookup
    }
  }
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    exports: Record<string, { import?: { default?: string } | string }>;
  };
  const entry = pkg.exports['./esm/api'];
  const rel = typeof entry === 'object' && entry.import && typeof entry.import === 'object' ? entry.import.default : undefined;
  if (!rel) throw new Error('cannot locate tsx/esm/api');
  return pathToFileURL(path.join(path.dirname(pkgPath), rel)).href;
}

/**
 * Spawn a match worker. When running from TypeScript sources (tsx in dev and production, vitest in
 * tests) the worker first registers tsx's loader through its public API: Node does not apply the
 * parent's --import loader hooks to worker threads, so execArgv inheritance is not enough.
 */
function spawnWorker(limits: ResourceLimits): Worker {
  if (!RUNNING_TS) {
    return new Worker(new URL('./matchWorker.js', import.meta.url), { resourceLimits: limits });
  }
  const entry = new URL('./matchWorker.ts', import.meta.url).href;
  const api = tsxRegisterUrl();
  const boot = `import(${JSON.stringify(api)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(entry)}); });`;
  return new Worker(boot, { eval: true, resourceLimits: limits });
}

class WorkerRunner implements MatchRunnerLike {
  readonly selfTicking = true;
  private readonly clients = new Map<string, RunnerClient>();
  private over = false;
  private disposed = false;
  private failed = false;
  private latest: RunnerStats = { tickMsAvg: 0, tickMsMax: 0, players: 0, bots: 0 };
  private maxSinceRead = 0;
  private errorLogs = 0;

  constructor(
    private readonly worker: Worker,
    private readonly opts: RunnerOptions,
    private readonly log: Logger,
    private readonly released: (w: Worker) => void,
  ) {
    for (const c of opts.clients) this.clients.set(c.id, c);
    worker.on('message', this.onMessage);
    worker.on('error', this.onWorkerError);
    worker.on('exit', this.onExit);
    this.post({
      k: 'init',
      config: opts.config,
      clients: opts.clients.map((c) => ({ id: c.id, name: c.name, team: c.team })),
    });
  }

  start(): void {
    this.post({ k: 'start' });
  }

  /** The worker ticks itself. */
  update(): void {}

  handleMessage(clientId: string, msg: ClientMessage): void {
    if (!this.clients.has(clientId)) return;
    this.post({ k: 'msg', id: clientId, msg });
    if (msg.t === 'leaveMatch') this.clients.delete(clientId);
  }

  removeClient(clientId: string): void {
    if (!this.clients.delete(clientId)) return;
    this.post({ k: 'remove', id: clientId });
  }

  isOver(): boolean {
    return this.over;
  }

  stats(): RunnerStats {
    const s = { ...this.latest, tickMsMax: Math.max(this.maxSinceRead, this.latest.tickMsMax) };
    this.maxSinceRead = 0;
    return s;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clients.clear();
    this.worker.terminate().catch(() => undefined);
    this.released(this.worker);
  }

  private post(m: ToWorker): void {
    if (this.disposed || this.failed) return;
    try {
      this.worker.postMessage(m);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private readonly onMessage = (m: FromWorker): void => {
    if (this.disposed) return;
    switch (m.k) {
      case 'out':
        for (let i = 0; i < m.ids.length; i++) this.clients.get(m.ids[i])?.send(m.msgs[i]);
        break;
      case 'end':
        this.over = true;
        this.opts.onEnd(m.results);
        break;
      case 'stats':
        this.latest = m.stats;
        if (m.stats.tickMsMax > this.maxSinceRead) this.maxSinceRead = m.stats.tickMsMax;
        if (m.over) this.over = true;
        break;
      case 'inited':
        this.log.info('match runner ready in worker', {
          threadId: this.worker.threadId,
          seed: this.opts.config.seed,
          initMs: Math.round(m.genMs),
        });
        break;
      case 'error':
        if (m.fatal) {
          this.fail(new Error(m.message));
        } else if (this.errorLogs++ < 5) {
          this.log.error('match worker error', { threadId: this.worker.threadId, err: m.message });
        }
        break;
      case 'ready':
      case 'prewarmed':
        break;
    }
  };

  private readonly onWorkerError = (err: Error): void => {
    this.fail(err);
  };

  private readonly onExit = (code: number): void => {
    if (!this.disposed) this.fail(new Error(`match worker exited unexpectedly (code ${code})`));
  };

  private fail(err: Error): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.log.error('match worker failed', { threadId: this.worker.threadId, err });
    this.worker.terminate().catch(() => undefined);
    this.released(this.worker);
    this.opts.onError?.(err);
  }
}

/** Runner factory that runs every match in its own worker thread. */
export function createWorkerRunnerFactory(options: WorkerRunnerFactoryOptions = {}): WorkerRunnerFactory {
  const log = options.log ?? createLogger(false);
  const limits = options.resourceLimits ?? DEFAULT_LIMITS;
  const useSpare = options.warmSpare ?? true;
  const active = new Set<Worker>();
  let spare: Worker | null = null;
  /** Seed whose island world the spare has (pre)generated. */
  let spareSeed = 0;
  let spareTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Listeners for an idle spare: a crash just drops it (a new one boots on demand).
  const onSpareError = (err: Error): void => {
    log.warn('spare match worker failed', { err });
    dropSpare();
  };
  const onSpareExit = (): void => dropSpare();

  function dropSpare(): void {
    if (!spare) return;
    const w = spare;
    spare = null;
    w.off('error', onSpareError);
    w.off('exit', onSpareExit);
    w.terminate().catch(() => undefined);
  }

  function bootSpare(): void {
    if (disposed || spare || !useSpare) return;
    let w: Worker;
    try {
      w = spawnWorker(limits);
    } catch (err) {
      log.warn('cannot boot spare match worker', { err });
      return;
    }
    w.unref();
    w.on('error', onSpareError);
    w.on('exit', onSpareExit);
    spareSeed = randomInt(0, 0x1_0000_0000);
    w.postMessage({ k: 'prewarm', seed: spareSeed } satisfies ToWorker);
    spare = w;
  }

  function scheduleSpare(): void {
    if (disposed || !useSpare || spare || spareTimer) return;
    spareTimer = setTimeout(() => {
      spareTimer = null;
      bootSpare();
    }, SPARE_RESPAWN_DELAY_MS);
    spareTimer.unref();
  }

  /** A worker for the next match plus the island seed it has pre-generated (if any). */
  function takeWorker(): { w: Worker; seed: number | null } {
    const w = spare;
    if (w) {
      spare = null;
      w.off('error', onSpareError);
      w.off('exit', onSpareExit);
      scheduleSpare();
      return { w, seed: spareSeed };
    }
    const fresh = spawnWorker(limits);
    fresh.unref();
    scheduleSpare();
    return { w: fresh, seed: null };
  }

  const release = (w: Worker): void => {
    active.delete(w);
  };

  const factory = ((opts: RunnerOptions): MatchRunnerLike => {
    if (disposed) throw new Error('worker runner factory disposed');
    const { w, seed } = takeWorker();
    active.add(w);
    // The lobby picked a random seed; the spare's pre-generated random seed is just as random and
    // lets the match skip world generation (clients learn the seed from matchInit as always).
    const config = seed !== null && opts.config.mode === 'br' ? { ...opts.config, seed } : opts.config;
    return new WorkerRunner(w, { ...opts, config }, log, release);
  }) as WorkerRunnerFactory;

  Object.defineProperty(factory, 'activeWorkers', { get: () => active.size });
  factory.dispose = async (): Promise<void> => {
    disposed = true;
    if (spareTimer) clearTimeout(spareTimer);
    spareTimer = null;
    const all = [...active];
    active.clear();
    if (spare) all.push(spare);
    dropSpare();
    await Promise.all(all.map((w) => w.terminate().catch(() => undefined)));
  };

  bootSpare();
  return factory;
}
