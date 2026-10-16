// Bot AI public API (see ARCHITECTURE.md "src/shared/bots").
//
// createBotDriver(sim) returns a BotDriver that, once per tick before GameSim.step(), queues one
// PlayerInput per bot through sim.queueInput (no other access path: bots are validated exactly
// like humans). botName(rng) produces original gamer tags.

export { createBotDriver } from './driver';
export type { BotDriverEx, BotDebugInfo, BotDriverStats } from './driver';
export { botName } from './names';
export { BOT_SKILLS, skillFor } from './skill';
export type { BotSkill } from './skill';
