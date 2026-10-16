// Public API of the simulation module (see ARCHITECTURE.md "src/shared/sim").

export { GameSim } from './GameSim';
export type { CheatFlag } from './GameSim';
export { LOAD_HOLD_MAX_MS, MatchRunner } from './MatchRunner';
export type { MatchRunnerOptions, RunnerClient } from './MatchRunner';
export { trainingTargetPosition, TRAINING_TARGET_CENTER_HEIGHT } from './training';
export { ZONE_PHASES, ZONE_PRE_TIME, ADS_MOVE_MUL, SPRAY_RESET_INTERVALS } from './tuning';
export type { ZonePhaseDef } from './tuning';
export type { BotDriver, NoiseEvent, SimEvent, SimView } from './view';
