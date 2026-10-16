// Optional loading of the render / feel modules. Each module is resolved via import.meta.glob so
// the app keeps building and running while a module is missing or broken: we fall back to the
// minimal implementations in fallbacks.ts and log a warning. This keeps every increment playable.

import type {
  CreateEntityRenderer, CreateFeel, CreateFxRenderer, CreateRenderCore, CreateViewRig, CreateWorldRenderer,
} from '../render/contracts';
import {
  fallbackEntityRenderer, fallbackRenderCore, fallbackViewRig, fallbackWorldRenderer, noopFeel, noopFx,
} from './fallbacks';

export interface RenderModules {
  createRenderCore: CreateRenderCore;
  createWorldRenderer: CreateWorldRenderer;
  createEntityRenderer: CreateEntityRenderer;
  createViewRig: CreateViewRig;
  createFxRenderer: CreateFxRenderer;
  createFeel: CreateFeel;
  /** Names of modules that fell back to the minimal implementation */
  fallbacks: string[];
}

const loaders = import.meta.glob([
  '../render/core/index.ts',
  '../render/world/index.ts',
  '../render/entities/index.ts',
  '../render/view/index.ts',
  '../render/fx/index.ts',
  '../feel/index.ts',
]) as Record<string, () => Promise<Record<string, unknown>>>;

async function load<T>(path: string, exportName: string, fallback: T, fallbacks: string[]): Promise<T> {
  const loader = loaders[path];
  if (!loader) {
    fallbacks.push(path);
    return fallback;
  }
  try {
    const mod = await loader();
    const fn = mod[exportName];
    if (typeof fn === 'function') return fn as T;
    console.warn(`[app] ${path} does not export ${exportName}; using fallback`);
  } catch (err) {
    console.warn(`[app] failed to load ${path}; using fallback`, err);
  }
  fallbacks.push(path);
  return fallback;
}

let cached: Promise<RenderModules> | null = null;

export function loadRenderModules(): Promise<RenderModules> {
  if (cached) return cached;
  cached = (async () => {
    const fallbacks: string[] = [];
    const [core, world, entities, view, fx, feel] = await Promise.all([
      load<CreateRenderCore>('../render/core/index.ts', 'createRenderCore', fallbackRenderCore, fallbacks),
      load<CreateWorldRenderer>('../render/world/index.ts', 'createWorldRenderer', fallbackWorldRenderer, fallbacks),
      load<CreateEntityRenderer>('../render/entities/index.ts', 'createEntityRenderer', (c) => fallbackEntityRenderer(c), fallbacks),
      load<CreateViewRig>('../render/view/index.ts', 'createViewRig', (c) => fallbackViewRig(c), fallbacks),
      load<CreateFxRenderer>('../render/fx/index.ts', 'createFxRenderer', () => noopFx, fallbacks),
      load<CreateFeel>('../feel/index.ts', 'createFeel', () => noopFeel(), fallbacks),
    ]);
    if (fallbacks.length) console.warn('[app] using fallback modules for:', fallbacks.join(', '));
    return {
      createRenderCore: core,
      createWorldRenderer: world,
      createEntityRenderer: entities,
      createViewRig: view,
      createFxRenderer: fx,
      createFeel: feel,
      fallbacks,
    };
  })();
  return cached;
}

/** Construct with a fallback if the real factory throws. */
export function safeCreate<T>(name: string, make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch (err) {
    console.error(`[app] ${name} failed to initialise; using fallback`, err);
    return fallback();
  }
}
