// End-to-end simulation soak: a full battle royale played only by bots through the real
// GameSim + bot driver must finish with exactly one winning team, within the tick budget.
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../../src/shared/constants';
import { createBotDriver } from '../../src/shared/bots';
import { GameSim } from '../../src/shared/sim';
import type { MatchConfig } from '../../src/shared/types';

function runMatch(config: MatchConfig, maxSimSeconds: number) {
  const sim = new GameSim(config);
  sim.fillBots();
  const driver = createBotDriver(sim);
  sim.start();
  const maxTicks = Math.ceil(maxSimSeconds / TICK_DT);
  let worst = 0;
  let total = 0;
  let ticks = 0;
  const phasesSeen = new Set<string>();
  let landed = 0;
  for (; ticks < maxTicks && !sim.isOver(); ticks++) {
    const t0 = performance.now();
    driver.update(TICK_DT);
    sim.step();
    const ms = performance.now() - t0;
    total += ms;
    if (ticks > 30) worst = Math.max(worst, ms);
    phasesSeen.add(sim.phase);
    for (const s of sim.drainEvents()) if (s.ev.type === 'land') landed++;
    sim.drainLootDelta();
  }
  return { sim, ticks, avgMs: total / Math.max(1, ticks), worstMs: worst, phasesSeen, landed };
}

describe('full match soak (bots only)', () => {
  it('solo: 24 bots play to a single winner', () => {
    const r = runMatch({
      mode: 'br', seed: 4242, maxPlayers: 24, teamSize: 1, botFill: true,
      botDifficulty: 'normal', zoneSpeed: 0.25, infiniteAmmo: false,
    }, 20 * 60);
    expect(r.sim.isOver()).toBe(true);
    const res = r.sim.results();
    expect(res.winnerTeam).not.toBeNull();
    const winners = res.players.filter((p) => p.placement === 1);
    expect(winners.length).toBe(1);
    expect(r.phasesSeen.has('plane')).toBe(true);
    expect(r.phasesSeen.has('playing')).toBe(true);
    expect(r.landed).toBeGreaterThanOrEqual(20);
    const kills = res.players.reduce((a, p) => a + p.kills, 0);
    expect(kills).toBeGreaterThan(0);
    console.log(`[soak solo] ticks=${r.ticks} avg=${r.avgMs.toFixed(2)}ms worst=${r.worstMs.toFixed(1)}ms kills=${kills}`);
    expect(r.avgMs).toBeLessThan(12);
  });

  it('squads: 32 bots in teams of 4 finish with one winning team and use downed/revive', () => {
    const r = runMatch({
      mode: 'br', seed: 777, maxPlayers: 32, teamSize: 4, botFill: true,
      botDifficulty: 'hard', zoneSpeed: 0.25, infiniteAmmo: false,
    }, 20 * 60);
    expect(r.sim.isOver()).toBe(true);
    const res = r.sim.results();
    expect(res.winnerTeam).not.toBeNull();
    const placements = new Set(res.players.filter((p) => p.team === res.winnerTeam).map((p) => p.placement));
    expect([...placements]).toEqual([1]);
    const knocks = res.players.reduce((a, p) => a + p.knocks, 0);
    expect(knocks).toBeGreaterThan(0);
    console.log(`[soak squads] ticks=${r.ticks} avg=${r.avgMs.toFixed(2)}ms worst=${r.worstMs.toFixed(1)}ms knocks=${knocks}`);
  });

  it('64-player match stays within the server tick budget while everyone is alive', () => {
    const sim = new GameSim({
      mode: 'br', seed: 99, maxPlayers: 64, teamSize: 2, botFill: true,
      botDifficulty: 'normal', zoneSpeed: 1, infiniteAmmo: false,
    });
    sim.fillBots();
    const driver = createBotDriver(sim);
    sim.start();
    let total = 0;
    const N = 60 * 30; // 60 s of sim time covering plane, drop and first fights
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      driver.update(TICK_DT);
      sim.step();
      total += performance.now() - t0;
      sim.drainEvents();
      sim.drainLootDelta();
    }
    const avg = total / N;
    console.log(`[budget 64p] avg tick ${avg.toFixed(2)} ms`);
    expect(avg).toBeLessThan(16);
  });
});
