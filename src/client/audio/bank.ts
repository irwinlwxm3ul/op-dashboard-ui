// Pre-rendered sound bank. Every procedural sound is rendered once (3 variations for gunshots and
// most effects, 4 for footsteps) into AudioBuffers by OfflineAudioContext. Rendering runs through
// a small concurrency-limited queue in priority order so the sounds needed first (UI, hitmarkers,
// local gunshots, footsteps) are available within a few hundred milliseconds of init().

import type { WeaponSoundKind } from '../../shared/types';
import { type OfflineCtor, type SoundSpec, renderSpec } from './synth/dsp';
import { type StepClass, STEP_CLASSES, hurtThudSpec, jumpSpec, landSpec, stepSpec } from './synth/footsteps';
import { WEAPON_SOUND_KINDS, actionSpec, gunFarSpec, gunNearSpec } from './synth/gunshots';
import {
  type ImpactClass, IMPACT_CLASSES, armorBreakSpec, bulletCrackSpec, explosionFarSpec, explosionNearSpec, impactSpec,
  ricochetSpec, tinnitusSpec,
} from './synth/impacts';
import {
  type HealSound, type ReloadPhase, HEAL_SOUNDS, RELOAD_PHASES, dryFireSpec, healSpec, pickupSpec, reloadSpec,
  weaponSwitchSpec,
} from './synth/mechanical';
import { type HitmarkerKind, type UiSoundName, HITMARKER_KINDS, UI_SOUND_NAMES, hitmarkerSpec, uiSpec } from './synth/ui';

/** A set of interchangeable variations; picks randomly without immediate repeats. */
export class VarSet {
  readonly bufs: AudioBuffer[] = [];
  private last = -1;

  get ready(): boolean { return this.bufs.length > 0; }

  pick(): AudioBuffer | null {
    const n = this.bufs.length;
    if (n === 0) return null;
    if (n === 1) return this.bufs[0];
    let i: number;
    if (this.last < 0 || this.last >= n) i = Math.floor(Math.random() * n);
    else {
      i = Math.floor(Math.random() * (n - 1));
      if (i >= this.last) i++;
    }
    this.last = i;
    return this.bufs[i];
  }
}

const kindMap = <K extends string>(keys: readonly K[]): Record<K, VarSet> => {
  const o = {} as Record<K, VarSet>;
  for (const k of keys) o[k] = new VarSet();
  return o;
};

export class SoundBank {
  readonly gunNear = kindMap(WEAPON_SOUND_KINDS);
  readonly gunFar = kindMap(WEAPON_SOUND_KINDS);
  readonly action = kindMap(WEAPON_SOUND_KINDS);
  readonly reload: Record<WeaponSoundKind, Record<ReloadPhase, VarSet>> = (() => {
    const o = {} as Record<WeaponSoundKind, Record<ReloadPhase, VarSet>>;
    for (const k of WEAPON_SOUND_KINDS) o[k] = kindMap(RELOAD_PHASES);
    return o;
  })();
  readonly dryFire = new VarSet();
  readonly weaponSwitch = new VarSet();
  readonly impact = kindMap<ImpactClass>(IMPACT_CLASSES);
  readonly ricochet = new VarSet();
  readonly bulletCrack = new VarSet();
  readonly step = kindMap<StepClass>(STEP_CLASSES);
  readonly jump = new VarSet();
  readonly land = new VarSet();
  readonly hurtThud = new VarSet();
  readonly hitmarker = kindMap<HitmarkerKind>(HITMARKER_KINDS);
  readonly armorBreak = new VarSet();
  readonly explosionNear = new VarSet();
  readonly explosionFar = new VarSet();
  readonly tinnitus = new VarSet();
  readonly heal = kindMap<HealSound>(HEAL_SOUNDS);
  readonly pickup = new VarSet();
  readonly ui = kindMap<UiSoundName>(UI_SOUND_NAMES);

  /** Number of renders completed / scheduled (diagnostics). */
  done = 0;
  total = 0;
  private failures = 0;

  /**
   * Render everything. Resolves when all jobs have finished (failed jobs are skipped: the sound
   * then simply stays silent, the game keeps working).
   */
  async renderAll(Offline: OfflineCtor, sampleRate: number, concurrency = 4): Promise<void> {
    const jobs: { set: VarSet; spec: SoundSpec; seed: number }[] = [];
    let seed = 0x5eed;
    const add = (set: VarSet, spec: SoundSpec, variations: number) => {
      for (let v = 0; v < variations; v++) jobs.push({ set, spec, seed: (seed += 0x9e3779b1) >>> 0 });
    };
    // Priority order: instant feedback first.
    for (const n of UI_SOUND_NAMES) add(this.ui[n], uiSpec(n), 1);
    for (const k of HITMARKER_KINDS) add(this.hitmarker[k], hitmarkerSpec(k), 1);
    for (const k of WEAPON_SOUND_KINDS) { add(this.gunNear[k], gunNearSpec(k), 3); add(this.action[k], actionSpec(k), 1); }
    add(this.dryFire, dryFireSpec(), 2);
    for (const c of STEP_CLASSES) add(this.step[c], stepSpec(c), 4);
    add(this.bulletCrack, bulletCrackSpec(), 3);
    for (const c of IMPACT_CLASSES) add(this.impact[c], impactSpec(c), 3);
    add(this.ricochet, ricochetSpec(), 3);
    for (const k of WEAPON_SOUND_KINDS) add(this.gunFar[k], gunFarSpec(k), 3);
    for (const k of WEAPON_SOUND_KINDS) for (const p of RELOAD_PHASES) add(this.reload[k][p], reloadSpec(k, p), 1);
    add(this.land, landSpec(), 2);
    add(this.jump, jumpSpec(), 2);
    add(this.hurtThud, hurtThudSpec(), 2);
    add(this.armorBreak, armorBreakSpec(), 2);
    add(this.weaponSwitch, weaponSwitchSpec(), 1);
    add(this.pickup, pickupSpec(), 3);
    for (const h of HEAL_SOUNDS) add(this.heal[h], healSpec(h), 1);
    add(this.explosionNear, explosionNearSpec(), 3);
    add(this.explosionFar, explosionFarSpec(), 3);
    add(this.tinnitus, tinnitusSpec(), 1);

    this.total = jobs.length;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          job.set.bufs.push(await renderSpec(job.spec, job.seed, sampleRate, Offline));
        } catch (err) {
          if (this.failures++ === 0) console.warn('[audio] offline render failed', err);
        }
        this.done++;
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
    await Promise.all(workers);
  }
}
