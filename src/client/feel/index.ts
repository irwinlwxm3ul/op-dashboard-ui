// Game-feel module (src/client/feel): camera shake / recoil kick / landing dip / head bob values,
// hit & kill feedback overlays (in the UI's feel layer) and all sound routing from game events to
// the audio engine. Contract: `Feel` / `CreateFeel` in src/client/render/contracts.ts.
import type { CreateFeel, Feel } from '../render/contracts';
import { FeelController } from './feel';

export const createFeel: CreateFeel = (events, overlay): Feel => new FeelController(events, overlay);
