// Bandwidth budget (PLAN.md: <= 15 KB/s per client average) and delta codec round-trip correctness,
// measured on a full 64-player match driven by the real MatchRunner and bot AI.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TICK_MS } from '../../src/shared/constants';
import { createBotDriver } from '../../src/shared/bots';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/shared/netcodec';
import type { ServerMessage, Snapshot } from '../../src/shared/protocol';
import { MatchRunner } from '../../src/shared/sim';

function stripUndefined<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe('snapshot bandwidth', () => {
  it('delta codec round-trips exactly and keeps a 64-player match within budget', () => {
    const snaps: Snapshot[] = [];
    let initBytes = 0;
    const runner = new MatchRunner({
      config: {
        mode: 'br', seed: 1234, maxPlayers: 64, teamSize: 4, botFill: true,
        botDifficulty: 'normal', zoneSpeed: 0.25, infiniteAmmo: false,
      },
      clients: [{
        id: 'c1', name: 'Watcher', team: null,
        send: (m: ServerMessage) => {
          if (m.t === 'snap') snaps.push(stripUndefined(m.s));
          else if (m.t === 'matchInit') initBytes = JSON.stringify(m).length;
        },
      }],
      botDriverFactory: createBotDriver,
    });
    let now = 0;
    runner.start(now);
    // Let our own player be driven by the bot AI too, so the viewpoint moves through the match
    // like a real player's would (bot takes over on removeClient... keep connected: emulate by
    // marking as bot is not exposed; the passive player still spectates after death).
    const encoder = new SnapshotEncoder();
    const decoder = new SnapshotDecoder();
    let raw = 0, delta = 0, deflated = 0;
    const perSecond: number[] = [];
    let secondBytes = 0, secondStart = 0;
    const simSeconds = 8 * 60;
    let checked = 0;
    let si = 0;
    for (let t = 0; t < simSeconds * 1000 && !runner.isOver(); t += TICK_MS) {
      now += TICK_MS;
      runner.update(now);
      for (; si < snaps.length; si++) {
        const s = snaps[si];
        const rawStr = JSON.stringify({ t: 'snap', s });
        const d = encoder.encode(s);
        const dStr = JSON.stringify({ t: 'snapd', d });
        raw += rawStr.length;
        delta += dStr.length;
        const z = rawStr.length > 256 ? deflateRawSync(dStr, { level: 3 }).length : dStr.length;
        deflated += z;
        secondBytes += z;
        // Round trip must reproduce the snapshot exactly (after JSON normalisation).
        const back = decoder.decode(JSON.parse(dStr));
        if (si % 7 === 0 || si < 40) {
          expect(stripUndefined(back)).toEqual(s);
          checked++;
        }
      }
      if (now - secondStart >= 1000) {
        perSecond.push(secondBytes);
        secondBytes = 0;
        secondStart = now;
      }
    }
    const seconds = now / 1000;
    const kb = (b: number) => (b / 1024 / seconds).toFixed(1);
    perSecond.sort((a, b) => a - b);
    const p95 = perSecond[Math.floor(perSecond.length * 0.95)] / 1024;
    console.log(`[bandwidth] ${seconds.toFixed(0)} s, ${snaps.length} snapshots, matchInit ${(initBytes / 1024).toFixed(0)} KB`);
    console.log(`[bandwidth] raw JSON ${kb(raw)} KB/s | delta ${kb(delta)} KB/s | delta+deflate ${kb(deflated)} KB/s | p95 ${p95.toFixed(1)} KB/s`);
    expect(checked).toBeGreaterThan(50);
    expect(deflated / 1024 / seconds).toBeLessThanOrEqual(15);
  }, 300_000);
});
