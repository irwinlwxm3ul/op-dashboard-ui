// Drop movement (interim version; replaced by the full implementation).
import type { CharacterBody, World } from '../types';
import type { MoveEvents, MoveIntent } from './types';
import { createMoveEvents, resetMoveEvents } from './types';

export function stepDrop(body: CharacterBody, intent: MoveIntent, dt: number, world: World, chuteOpen: boolean, out: MoveEvents = createMoveEvents()): MoveEvents {
  resetMoveEvents(out);
  void intent; void dt; void world; void body; void chuteOpen;
  return out;
}
