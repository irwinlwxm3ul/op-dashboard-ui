/// <reference lib="webworker" />
// Module Web Worker hosting an offline match: one MatchRunner with a single human client (the
// local player) plus bots. Speaks the network protocol with the main thread via postMessage.
// Inbound messages are validated exactly like the network server does (defence in depth).

import { MAX_MESSAGE_BYTES } from '../../shared/constants';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { createBotDriver } from '../../shared/bots';
import { MatchRunner } from '../../shared/sim';
import type { MatchConfig, MatchResults } from '../../shared/types';
import { validateClientMessage } from '../../shared/validate';

const CLIENT_ID = 'local';
/** Runner update cadence; the runner's fixed-step accumulator turns this into 30 Hz ticks. */
const LOOP_INTERVAL_MS = 4;
/** Keep ticking this long after the match ended so the final snapshots / banners flow. */
const POST_MATCH_MS = 10_000;

const scope = self as unknown as DedicatedWorkerGlobalScope;

let runner: MatchRunner | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let endedAt = -1;
let lastErrorLog = -Infinity;

function post(msg: ServerMessage): void {
  scope.postMessage(msg);
}

function stop(): void {
  if (loop !== null) clearInterval(loop);
  loop = null;
  runner = null;
  endedAt = -1;
}

function tick(): void {
  const r = runner;
  if (!r) return;
  const now = performance.now();
  try {
    r.update(now);
  } catch (err) {
    // A sim bug must not silently freeze the match; log (rate limited) and keep going.
    if (now - lastErrorLog > 1000) {
      lastErrorLog = now;
      console.error('[local] match update failed', err);
    }
  }
  if (endedAt < 0 && r.isOver()) endedAt = now;
  if (endedAt >= 0 && now - endedAt > POST_MATCH_MS) stop();
}

function start(config: MatchConfig, name: string): void {
  stop();
  const r = new MatchRunner({
    config,
    clients: [{ id: CLIENT_ID, name, team: null, send: post }],
    botDriverFactory: createBotDriver,
    onEnd: (results: MatchResults) => post({ t: 'matchOver', results }),
  });
  runner = r;
  r.start(performance.now());
  loop = setInterval(tick, LOOP_INTERVAL_MS);
}

function handle(msg: ClientMessage): void {
  switch (msg.t) {
    case 'startLocal':
      try {
        start(msg.config, msg.name);
      } catch (err) {
        console.error('[local] failed to start match', err);
        stop();
        scope.close();
      }
      return;
    case 'input':
    case 'ping':
      runner?.handleMessage(CLIENT_ID, msg);
      return;
    case 'leaveMatch':
      runner?.handleMessage(CLIENT_ID, msg);
      stop();
      post({ t: 'backToLobby' });
      return;
    default:
      // Lobby traffic has no meaning offline.
      return;
  }
}

scope.onmessage = (ev: MessageEvent) => {
  // Mirror the server's size guard so the worker never trusts more than the network would.
  const data: unknown = ev.data;
  if (typeof data === 'string' && data.length > MAX_MESSAGE_BYTES) return;
  const msg = validateClientMessage(data);
  if (msg) handle(msg);
};
