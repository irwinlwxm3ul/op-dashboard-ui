// Bot AI public API (provisional build while the full driver is being integrated).
import type { BotDriver, SimView } from '../sim/view';
import type { EntityId, PlayerInput } from '../types';

export { botName } from './names';

export function createBotDriver(sim: SimView): BotDriver {
  const seqs = new Map<EntityId, number>();
  return {
    update(): void {
      if (sim.phase === 'waiting' || sim.phase === 'ended') return;
      for (const p of sim.players.values()) {
        if (!p.isBot || p.life === 'dead') continue;
        const seq = Math.max(seqs.get(p.id) ?? 0, p.lastSeq) + 1;
        seqs.set(p.id, seq);
        const input: PlayerInput = {
          seq, mx: 0, mz: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0, stance: 0, slot: p.activeSlot, rt: sim.time * 1000,
        };
        sim.queueInput(p.id, input);
      }
    },
    onPlayerRemoved(id: EntityId): void {
      seqs.delete(id);
    },
  };
}
