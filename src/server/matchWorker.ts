// Worker thread entry: owns one match (MatchRunner + bot driver) and ticks it with its own
// fixed-step loop, so world generation and simulation never block the main thread's networking
// and every match can use its own core. See workerRunner.ts for the main-thread side, which
// terminates the worker when the match is disposed.

import { parentPort } from 'node:worker_threads';
import { createBotDriver } from '../shared/bots/index';
import type { ServerMessage } from '../shared/protocol';
import { MatchRunner } from '../shared/sim/index';
import { generateWorld } from '../shared/world/index';
import type { FromWorker, ToWorker } from './matchWorkerProtocol';

/** Loop interval (ms). MatchRunner.update is a fixed-step accumulator; this bounds tick jitter. */
const LOOP_MS = 4;
/** How often tick statistics are reported to the main thread (ms). */
const STATS_MS = 1000;
/** Runner exceptions tolerated before the match is declared failed. */
const MAX_ERRORS = 20;

if (!parentPort) throw new Error('matchWorker must run inside a worker thread');
const port = parentPort;

let runner: MatchRunner | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let errors = 0;
let failed = false;
// Outgoing messages of the current loop iteration (parallel arrays: one postMessage per batch).
let outIds: string[] = [];
let outMsgs: ServerMessage[] = [];
/** Latest RTT per client as applied to the runner (for the stats average). */
const rtts = new Map<string, number>();

const post = (m: FromWorker): void => port.postMessage(m);

function flush(): void {
  if (outIds.length === 0) return;
  const ids = outIds;
  const msgs = outMsgs;
  outIds = [];
  outMsgs = [];
  post({ k: 'out', ids, msgs });
}

const describe = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

function stop(): void {
  if (loop !== null) clearInterval(loop);
  if (statsTimer !== null) clearInterval(statsTimer);
  loop = null;
  statsTimer = null;
  runner = null;
}

function fail(where: string, err: unknown, fatal = false): void {
  if (failed) return;
  errors++;
  const isFatal = fatal || errors >= MAX_ERRORS;
  post({ k: 'error', message: `${where}: ${describe(err)}`, fatal: isFatal });
  if (isFatal) {
    failed = true;
    stop();
  }
}

function tick(): void {
  if (!runner) return;
  try {
    runner.update(performance.now());
  } catch (err) {
    fail('update', err);
  }
  flush();
}

function handle(m: ToWorker): void {
  switch (m.k) {
    case 'prewarm': {
      if (runner) return;
      const t0 = performance.now();
      // generateWorld caches by (seed, kind): the MatchRunner built for this seed reuses it.
      generateWorld(m.seed, 'island');
      post({ k: 'prewarmed', seed: m.seed, genMs: performance.now() - t0 });
      return;
    }
    case 'init': {
      if (runner || failed) return;
      const t0 = performance.now();
      try {
        runner = new MatchRunner({
          config: m.config,
          clients: m.clients.map((c) => ({
            id: c.id,
            name: c.name,
            team: c.team,
            send: (msg: ServerMessage) => {
              outIds.push(c.id);
              outMsgs.push(msg);
            },
          })),
          botDriverFactory: createBotDriver,
          onEnd: (results) => {
            // Final snapshots first, then the results (same order as an in-process runner).
            flush();
            post({ k: 'end', results });
          },
        });
      } catch (err) {
        fail('init', err, true);
        return;
      }
      post({ k: 'inited', genMs: performance.now() - t0 });
      return;
    }
    case 'start': {
      if (!runner || loop !== null) return;
      runner.start(performance.now());
      flush();
      loop = setInterval(tick, LOOP_MS);
      statsTimer = setInterval(() => {
        if (!runner) return;
        let sum = 0;
        for (const v of rtts.values()) sum += v;
        // stats() drains the runner's cheat flags; they travel to the main thread for logging.
        const stats = { ...runner.stats(), rttAvgMs: rtts.size > 0 ? sum / rtts.size : -1 };
        post({ k: 'stats', stats, over: runner.isOver() });
      }, STATS_MS);
      return;
    }
    case 'msg':
      if (!runner) return;
      runner.handleMessage(m.id, m.msg);
      flush(); // pongs go out immediately (clock sync accuracy)
      return;
    case 'remove':
      if (!runner) return;
      runner.removeClient(m.id);
      rtts.delete(m.id);
      flush();
      return;
    case 'rtt':
      if (!runner) return;
      for (let i = 0; i < m.ids.length; i++) {
        const v = m.rtts[i];
        if (!Number.isFinite(v) || v < 0) continue;
        runner.setClientLatency(m.ids[i], v);
        rtts.set(m.ids[i], v);
      }
      return;
  }
}

port.on('message', (m: ToWorker) => {
  try {
    handle(m);
  } catch (err) {
    // A failed prewarm is harmless (init generates the world itself); anything else is fatal
    // once it breaks the runner's lifecycle.
    if (m.k !== 'prewarm') fail(m.k, err, m.k === 'start' || m.k === 'init');
  }
});

post({ k: 'ready' });
