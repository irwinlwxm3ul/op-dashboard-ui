// Audio engine public API (temporary no-op shell while the synthesis engine lands).
import type { SurfaceMaterial, Vec3, WeaponSoundKind } from '../../shared/types';

export interface AudioSettings { master: number; sfx: number; ui: number; }
export type ReloadPhase = 'out' | 'in' | 'bolt' | 'shell';
export type HitmarkerKind = 'body' | 'head' | 'armor' | 'knock' | 'kill';
export type UiSoundName = 'click' | 'hover' | 'ready' | 'start' | 'countdown' | 'error' | 'zone' | 'win' | 'lose';
export interface EngineSoundHandle {
  update(pos: Vec3, rpm: number, throttle: number, local: boolean): void;
  stop(): void;
}

const noopEngine: EngineSoundHandle = { update() {}, stop() {} };

export const audio = {
  init(): Promise<void> { return Promise.resolve(); },
  setSettings(_s: AudioSettings): void {},
  setListener(_pos: Vec3, _yaw: number, _pitch: number): void {},
  gunshot(_kind: WeaponSoundKind, _pos: Vec3, _local: boolean): void {},
  dryFire(): void {},
  reload(_kind: WeaponSoundKind, _phase: ReloadPhase): void {},
  weaponSwitch(): void {},
  impact(_material: string, _pos: Vec3): void {},
  bulletCrack(_pos: Vec3): void {},
  footstep(_material: SurfaceMaterial, _pos: Vec3, _local: boolean, _intensity: number): void {},
  jump(_local: boolean, _pos: Vec3): void {},
  land(_intensity: number, _pos: Vec3, _local: boolean): void {},
  hitmarker(_kind: HitmarkerKind): void {},
  hurt(_amount: number): void {},
  armorBreak(): void {},
  explosion(_pos: Vec3): void {},
  heal(_item: string): void {},
  pickup(): void {},
  ui(_name: UiSoundName): void {},
  setWind(_intensity: number): void {},
  setZoneProximity(_insideBlue: boolean, _intensity: number): void {},
  engine(_id: number): EngineSoundHandle { return noopEngine; },
  update(_dt: number): void {},
};
