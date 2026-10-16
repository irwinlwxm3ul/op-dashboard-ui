import { describe, expect, it } from 'vitest';
import { GRAVITY, MAX_HEALTH } from '../src/shared/constants';
import { dirFromAngles } from '../src/shared/math';
import { Rng, hash32 } from '../src/shared/rng';
import type { ArmorState, ItemId, PlayerState, Vec3, WeaponDef, WeaponId } from '../src/shared/types';
import {
  ALL_ITEM_IDS, AMMO, AMMO_IDS, BASE_CAPACITY, BOOST_DECAY_PER_SEC, CONSUMABLES, GEAR, ITEMS, RECOIL_JITTER_FRAC,
  THROWABLES, WEAPONS, WEAPON_IDS, applyArmorDamage, applyConsumable, boostSpeedMul, canUseConsumable, capacity,
  computeDamage, emptyInventory, falloffMul, fireInterval, fragDamage, isAmmoId, isConsumableId, isGearId, isItemId,
  isThrowableId, isWeaponId, itemCategory, launchVelocity, pickupItem, recoilForShot, recoilMul, recoilPattern,
  recoverRecoil, removeItem, rollLoot, roomFor, shotDirections, sightDrop, simulateTrajectory, spreadCone,
  stepBallistic, tickBoost, usedCapacity, zeroAngle,
} from '../src/shared/items';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlayer(over: Partial<PlayerState> = {}): PlayerState {
  const inv = emptyInventory();
  return {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, airTime: 0, jumpBuffer: 0,
    stance: 'stand', mode: 'ground', fallSpeed: 0,
    id: 1, name: 'Tester', team: 0, isBot: false, connected: true,
    yaw: 0, pitch: 0, recoilPitch: 0, recoilYaw: 0, lean: 0,
    life: 'alive', health: 100, boost: 0, downedHp: 0, knockCount: 0,
    armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 },
    weapons: [null, null, null], activeSlot: -1,
    ammo: inv.ammo, items: inv.items,
    fireCooldown: 0, reloadTimer: 0, reloadTotal: 0, drawTimer: 0, ads: 0, sprayCount: 0, bloom: 0, shotCounter: 0,
    use: null, revive: null, revivedBy: null, vehicleId: null, seat: 0, parachuteOpen: false, jumpY: 0,
    lastSeq: 0, lastButtons: 0, throwCooldown: 0,
    stats: {
      kills: 0, knocks: 0, damage: 0, headshots: 0, revives: 0, longestKill: 0, shotsFired: 0, shotsHit: 0,
      spawnTime: 0, deathTime: 0,
    },
    placement: 0, killerId: null, spectating: null, lastAttacker: null, lastAttackerWeapon: null,
    ...over,
  };
}

const noArmor = (): ArmorState => ({ vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 0 });
/** Angle between two vectors (atan2 form: accurate for tiny angles). */
const angleBetween = (a: Vec3, b: Vec3): number => {
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z);
};

/** Fly a projectile with the sim's tick size and return its height when it crosses horizontal range r. */
function heightAtRange(w: WeaponDef, vel: Vec3, r: number, dt: number): { y: number; t: number } {
  const pos = { x: 0, y: 0, z: 0 };
  const v = { ...vel };
  let t = 0;
  for (let i = 0; i < 10_000; i++) {
    const px = Math.hypot(pos.x, pos.z), py = pos.y;
    stepBallistic(pos, v, w, dt);
    t += dt;
    const x = Math.hypot(pos.x, pos.z);
    if (x >= r) {
      const f = (r - px) / (x - px);
      return { y: py + (pos.y - py) * f, t: t - dt + dt * f };
    }
  }
  throw new Error('range not reached');
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('item definitions', () => {
  it('every ItemId has a def with matching id and category', () => {
    const expected: ItemId[] = [
      'pistol', 'smg', 'ar', 'shotgun', 'dmr', 'sniper',
      'ammo_9mm', 'ammo_556', 'ammo_762', 'ammo_12g', 'ammo_300',
      'bandage', 'firstaid', 'medkit', 'energy', 'fuel', 'frag',
      'vest1', 'vest2', 'vest3', 'helmet1', 'helmet2', 'helmet3', 'pack1', 'pack2', 'pack3',
    ];
    expect([...ALL_ITEM_IDS].sort()).toEqual([...expected].sort());
    expect(new Set(ALL_ITEM_IDS).size).toBe(ALL_ITEM_IDS.length);
    for (const id of ALL_ITEM_IDS) {
      const d = ITEMS[id];
      expect(d, id).toBeDefined();
      expect(d.id).toBe(id);
      expect(itemCategory(id)).toBe(d.category);
      expect(isItemId(id)).toBe(true);
    }
    expect(isItemId('nope')).toBe(false);
    expect(isItemId('toString')).toBe(false);
    expect(isWeaponId('ar')).toBe(true);
    expect(isWeaponId('ammo_556')).toBe(false);
    expect(isAmmoId('ammo_556')).toBe(true);
    expect(isConsumableId('fuel')).toBe(true);
    expect(isThrowableId('frag')).toBe(true);
    expect(isGearId('pack3')).toBe(true);
    expect(isGearId('vest4')).toBe(false);
  });

  it('weapon defs are sane and distinct', () => {
    const loud: Record<WeaponId, number> = { pistol: 250, smg: 300, ar: 450, shotgun: 350, dmr: 600, sniper: 800 };
    const zoom = { iron: [0.75, 0.9], reddot: [0.75, 0.9], x4: [0.25, 0.25], x8: [0.125, 0.125] } as const;
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      expect(w.id).toBe(id);
      expect(AMMO[w.ammo]).toBeDefined();
      expect(Number.isInteger(w.magSize) && w.magSize > 0).toBe(true);
      expect(w.rpm).toBeGreaterThan(0);
      expect(fireInterval(w)).toBeCloseTo(60 / w.rpm, 10);
      expect(w.damage).toBeGreaterThan(0);
      expect(w.pellets).toBeGreaterThanOrEqual(1);
      expect(w.headMul).toBeGreaterThanOrEqual(2);
      expect(w.headMul).toBeLessThanOrEqual(2.5);
      expect(w.limbMul).toBeCloseTo(0.9, 5);
      expect(w.falloffStart).toBeLessThan(w.falloffEnd);
      expect(w.falloffMinMul).toBeGreaterThan(0);
      expect(w.falloffMinMul).toBeLessThanOrEqual(1);
      expect(w.muzzleVelocity).toBeGreaterThan(300);
      expect(w.spreadAds).toBeLessThan(w.spreadHip);
      expect(w.bloomMax).toBeGreaterThan(0);
      expect(w.reloadEmptyTime).toBeGreaterThan(w.reloadTime);
      expect(w.adsTime).toBeGreaterThanOrEqual(0.15);
      expect(w.adsTime).toBeLessThanOrEqual(0.35);
      expect(w.drawTime).toBeGreaterThanOrEqual(0.4);
      expect(w.drawTime).toBeLessThanOrEqual(0.9);
      expect(w.moveSpeedMul).toBeGreaterThanOrEqual(0.85);
      expect(w.moveSpeedMul).toBeLessThanOrEqual(1);
      expect(w.loudness).toBe(loud[id]);
      expect(w.adsZoom).toBeGreaterThanOrEqual(zoom[w.scope][0]);
      expect(w.adsZoom).toBeLessThanOrEqual(zoom[w.scope][1]);
      expect(w.recoil.vertical).toBeGreaterThan(0);
      expect(w.recoil.recovery).toBeGreaterThan(0);
      expect(w.kick.camPitch).toBeGreaterThan(0);
      if (w.hitscan) {
        expect(w.gravityScale).toBe(0);
        expect(w.drag).toBe(0);
      } else {
        expect(w.gravityScale).toBeGreaterThan(0);
      }
    }
    expect(WEAPONS.pistol.slot).toBe('pistol');
    expect(WEAPON_IDS.filter((id) => WEAPONS[id].slot === 'primary')).toHaveLength(5);
    expect(WEAPONS.dmr.hitscan).toBe(false);
    expect(WEAPONS.sniper.hitscan).toBe(false);
    expect(WEAPONS.shotgun.pellets).toBe(9);
    expect(WEAPONS.shotgun.reloadPerShell).toBeGreaterThan(0);
    expect(WEAPONS.sniper.fireMode).toBe('bolt');
    expect(WEAPONS.shotgun.fireMode).toBe('pump');
    expect(WEAPONS.smg.spreadHip).toBeLessThan(WEAPONS.ar.spreadHip); // great hip fire
    expect(WEAPONS.ar.scope).toBe('reddot');
    expect(WEAPONS.dmr.scope).toBe('x4');
    expect(WEAPONS.sniper.scope).toBe('x8');
    expect(WEAPONS.sniper.kick.camPitch).toBeGreaterThan(WEAPONS.smg.kick.camPitch * 5);
    for (const rare of ['dmr', 'sniper'] as const) {
      for (const common of ['pistol', 'smg', 'ar', 'shotgun'] as const) {
        expect(WEAPONS[rare].lootWeight).toBeLessThan(WEAPONS[common].lootWeight);
      }
    }
  });

  it('consumables, throwables and gear match the design', () => {
    expect(CONSUMABLES.bandage).toMatchObject({ useTime: 4, heal: 10, healCap: 75, moveMul: 0.8, weight: 2 });
    expect(CONSUMABLES.firstaid).toMatchObject({ useTime: 6, healCap: 75, moveMul: 0.6, weight: 10 });
    expect(CONSUMABLES.medkit).toMatchObject({ useTime: 8, healCap: 100, moveMul: 0.4, weight: 20 });
    expect(CONSUMABLES.energy).toMatchObject({ useTime: 4, boost: 40, weight: 4 });
    expect(CONSUMABLES.fuel).toMatchObject({ useTime: 5, heal: 0, boost: 0, weight: 20 });
    expect(THROWABLES.frag).toMatchObject({ fuse: 4, damage: 120, radius: 7, weight: 12 });
    expect(THROWABLES.frag.throwSpeed).toBeCloseTo(18, 0);
    expect([GEAR.vest1, GEAR.vest2, GEAR.vest3].map((g) => [g.reduction, g.durability, g.capacity]))
      .toEqual([[0.3, 200, 50], [0.4, 220, 50], [0.55, 250, 50]]);
    expect([GEAR.helmet1, GEAR.helmet2, GEAR.helmet3].map((g) => [g.reduction, g.durability]))
      .toEqual([[0.3, 80], [0.4, 150], [0.55, 230]]);
    expect([GEAR.pack1, GEAR.pack2, GEAR.pack3].map((g) => g.capacity)).toEqual([100, 150, 200]);
    for (const a of AMMO_IDS) expect(AMMO[a].weight).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Damage & armor
// ---------------------------------------------------------------------------

describe('damage', () => {
  it('AR body shots with and without a vest', () => {
    const bare = computeDamage('ar', 'body', 10, noArmor());
    expect(bare.health).toBeCloseTo(41, 5);
    expect(bare.armorHit).toBe(false);
    const armor: ArmorState = { vest: 2, vestHp: 220, helmet: 0, helmetHp: 0, pack: 0 };
    const vested = computeDamage('ar', 'body', 10, armor);
    expect(vested.health).toBeCloseTo(24.6, 5);
    expect(vested.vestDmg).toBeCloseTo(41, 5);
    expect(vested.helmetDmg).toBe(0);
    expect(vested.armorHit).toBe(true);
    expect(vested.armorBroke).toBe(false);
    expect(armor.vestHp).toBe(220); // computeDamage does not mutate
  });

  it('heads use the helmet, limbs are never reduced', () => {
    const armor: ArmorState = { vest: 3, vestHp: 250, helmet: 2, helmetHp: 150, pack: 0 };
    const head = computeDamage('sniper', 'head', 100, armor);
    expect(head.health).toBeGreaterThanOrEqual(100); // one-shot through a level 2 helmet
    expect(head.health).toBeCloseTo(80 * 2.5 * 0.6, 5);
    expect(head.helmetDmg).toBeCloseTo(200, 5);
    expect(head.vestDmg).toBe(0);
    const limb = computeDamage('ar', 'limb', 10, armor);
    expect(limb.health).toBeCloseTo(41 * 0.9, 5);
    expect(limb.armorHit).toBe(false);
    // Level 3 helmet saves from a sniper headshot.
    expect(computeDamage('sniper', 'head', 100, { ...armor, helmet: 3, helmetHp: 230 }).health).toBeLessThan(100);
    // A helmet with no durability left does not protect.
    expect(computeDamage('ar', 'head', 10, { ...armor, helmetHp: 0 }).health).toBeCloseTo(41 * 2.2, 5);
  });

  it('falloff is flat, then linear, then clamped', () => {
    const w = WEAPONS.ar;
    expect(falloffMul(w, 0)).toBe(1);
    expect(falloffMul(w, w.falloffStart)).toBe(1);
    expect(falloffMul(w, (w.falloffStart + w.falloffEnd) / 2)).toBeCloseTo((1 + w.falloffMinMul) / 2, 6);
    expect(falloffMul(w, w.falloffEnd)).toBeCloseTo(w.falloffMinMul, 6);
    expect(falloffMul(w, 5000)).toBeCloseTo(w.falloffMinMul, 6);
    expect(computeDamage('ar', 'body', 1000, noArmor()).health).toBeCloseTo(41 * w.falloffMinMul, 5);
    // SMG falls off much earlier than the AR.
    expect(computeDamage('smg', 'body', 80, noArmor()).health / 33).toBeLessThan(falloffMul(w, 80));
    // Shotgun damage is per pellet and drops hard with range.
    expect(computeDamage('shotgun', 'body', 5, noArmor()).health).toBeCloseTo(24, 5);
    expect(computeDamage('shotgun', 'body', 40, noArmor()).health).toBeCloseTo(24 * 0.3, 5);
  });

  it('frag damage falls off linearly over its radius', () => {
    expect(fragDamage(0)).toBe(120);
    expect(fragDamage(3.5)).toBeCloseTo(60, 9);
    expect(fragDamage(7)).toBe(0);
    expect(fragDamage(50)).toBe(0);
    expect(fragDamage(-1)).toBe(120);
  });

  it('armor breaks and is removed', () => {
    const armor: ArmorState = { vest: 1, vestHp: 30, helmet: 1, helmetHp: 80, pack: 2 };
    const r = computeDamage('ar', 'body', 10, armor);
    expect(r.armorBroke).toBe(true);
    expect(r.health).toBeCloseTo(41 * 0.7, 5);
    applyArmorDamage(armor, r);
    expect(armor.vest).toBe(0);
    expect(armor.vestHp).toBe(0);
    expect(armor.helmet).toBe(1);
    // Next body hit is unprotected.
    expect(computeDamage('ar', 'body', 10, armor).health).toBeCloseTo(41, 5);
    // Helmet wears down over several hits then breaks.
    let broke = false;
    let hits = 0;
    while (!broke && hits < 10) {
      const h = computeDamage('pistol', 'head', 5, armor);
      applyArmorDamage(armor, h);
      broke = h.armorBroke;
      hits++;
    }
    expect(broke).toBe(true);
    expect(hits).toBe(2); // 80 durability vs 70 pre-reduction damage per pistol headshot
    expect(armor.helmet).toBe(0);
    expect(armor.pack).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

describe('spread', () => {
  const still = { ads: 0, speed: 0, airborne: false, stance: 'stand' as const, bloom: 0 };

  it('cone responds to ADS, movement, air, stance and bloom', () => {
    const w = WEAPONS.ar;
    const hip = spreadCone(w, still);
    expect(hip).toBeCloseTo(w.spreadHip, 10);
    expect(spreadCone(w, { ...still, ads: 1 })).toBeCloseTo(w.spreadAds, 10);
    expect(spreadCone(w, { ...still, ads: 0.5 })).toBeCloseTo((w.spreadHip + w.spreadAds) / 2, 10);
    expect(spreadCone(w, { ...still, speed: 6.3 })).toBeGreaterThan(hip);
    expect(spreadCone(w, { ...still, speed: 6.3 })).toBeGreaterThan(spreadCone(w, { ...still, speed: 3 }));
    expect(spreadCone(w, { ...still, airborne: true })).toBeCloseTo(hip + w.spreadAir, 10);
    expect(spreadCone(w, { ...still, stance: 'crouch' })).toBeCloseTo(hip * 0.8, 10);
    expect(spreadCone(w, { ...still, stance: 'prone' })).toBeCloseTo(hip * 0.6, 10);
    expect(spreadCone(w, { ...still, bloom: 1 })).toBeCloseTo(hip + w.bloomMax, 10); // clamped
    expect(spreadCone(w, { ...still, bloom: -1 })).toBeCloseTo(hip, 10);
  });

  it('shot directions are deterministic, unit length and inside the cone', () => {
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      const cone = 0.05;
      const yaw = 0.7, pitch = -0.2;
      const aim = dirFromAngles(yaw, pitch);
      const limit = cone + w.pelletSpread + 1e-9;
      for (let shot = 0; shot < 200; shot++) {
        const seed = hash32(7, shot);
        const a = shotDirections(w, yaw, pitch, cone, seed);
        const b = shotDirections(w, yaw, pitch, cone, seed);
        expect(a).toEqual(b);
        expect(a).toHaveLength(w.pellets);
        for (const d of a) {
          expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
          expect(angleBetween(d, aim)).toBeLessThanOrEqual(limit);
        }
      }
      expect(shotDirections(w, yaw, pitch, cone, 1)).not.toEqual(shotDirections(w, yaw, pitch, cone, 2));
    }
  });

  it('zero cone fires exactly along the aim; samples cover the disk uniformly', () => {
    const w = WEAPONS.ar;
    const aim = dirFromAngles(-1.1, 0.3);
    const [d] = shotDirections(w, -1.1, 0.3, 0, 99);
    expect(angleBetween(d, aim)).toBeLessThan(1e-7);
    // Uniform over the disk: ~25% of samples fall inside half the cone radius.
    const cone = 0.04;
    let inner = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const [s] = shotDirections(w, 0, 0, cone, hash32(3, i));
      if (angleBetween(s, dirFromAngles(0, 0)) < cone / 2) inner++;
    }
    expect(inner / n).toBeGreaterThan(0.22);
    expect(inner / n).toBeLessThan(0.28);
  });

  it('reuses the output array and its vectors', () => {
    const out: Vec3[] = [];
    const r1 = shotDirections(WEAPONS.shotgun, 0, 0, 0.02, 5, out);
    const first = r1[0];
    const r2 = shotDirections(WEAPONS.shotgun, 0, 0, 0.02, 6, out);
    expect(r2).toBe(out);
    expect(r2[0]).toBe(first);
    expect(shotDirections(WEAPONS.ar, 0, 0, 0.02, 6, out)).toHaveLength(1);
  });

  it('shotgun pellets form a spread pattern around the shot', () => {
    const w = WEAPONS.shotgun;
    const dirs = shotDirections(w, 0, 0, 0, 1234);
    const aim = dirFromAngles(0, 0);
    let maxA = 0;
    for (const d of dirs) maxA = Math.max(maxA, angleBetween(d, aim));
    expect(maxA).toBeGreaterThan(w.pelletSpread * 0.4);
    expect(maxA).toBeLessThanOrEqual(w.pelletSpread + 1e-9);
    // Pellets are distinct.
    for (let i = 1; i < dirs.length; i++) expect(angleBetween(dirs[i], dirs[0])).toBeGreaterThan(1e-4);
  });
});

// ---------------------------------------------------------------------------
// Recoil
// ---------------------------------------------------------------------------

describe('recoil', () => {
  it('is deterministic and climbs then plateaus', () => {
    const w = WEAPONS.ar;
    expect(recoilForShot(w, 5, 42, 'stand', 0)).toEqual(recoilForShot(w, 5, 42, 'stand', 0));
    const p = Array.from({ length: 30 }, (_, i) => recoilForShot(w, i, 1000 + i, 'stand', 0).pitch);
    expect(p[0]).toBeCloseTo(w.recoil.vertical * w.recoil.firstShotMul, 12);
    for (let i = 2; i < 30; i++) expect(p[i]).toBeGreaterThanOrEqual(p[i - 1] - 1e-12);
    expect(p[29]).toBeCloseTo(w.recoil.vertical * w.recoil.verticalMaxMul, 12);
    expect(p[10]).toBeGreaterThan(p[1]);
  });

  it('ADS and stance reduce recoil', () => {
    const w = WEAPONS.ar;
    const base = recoilForShot(w, 8, 1, 'stand', 0);
    const ads = recoilForShot(w, 8, 1, 'stand', 1);
    const crouch = recoilForShot(w, 8, 1, 'crouch', 0);
    const prone = recoilForShot(w, 8, 1, 'prone', 0);
    expect(ads.pitch).toBeCloseTo(base.pitch * w.recoil.adsMul, 12);
    expect(crouch.pitch).toBeCloseTo(base.pitch * w.recoil.crouchMul, 12);
    expect(prone.pitch).toBeCloseTo(base.pitch * w.recoil.proneMul, 12);
    expect(Math.abs(prone.yaw)).toBeLessThan(Math.abs(base.yaw) + 1e-12);
    expect(recoilMul(w, 'crouch', 1)).toBeCloseTo(w.recoil.adsMul * w.recoil.crouchMul, 12);
  });

  it('horizontal pattern is learnable: identical across seeds except bounded jitter', () => {
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      const bound = 2 * RECOIL_JITTER_FRAC * w.recoil.horizontal + 1e-12;
      let differs = false;
      for (let i = 0; i < 30; i++) {
        const a = recoilForShot(w, i, hash32(1, i), 'stand', 0);
        const b = recoilForShot(w, i, hash32(987654, i), 'stand', 0);
        expect(a.pitch).toBe(b.pitch);
        expect(Math.abs(a.yaw - b.yaw)).toBeLessThanOrEqual(bound);
        const pattern = w.recoil.horizontal * recoilPattern(id, i);
        expect(Math.abs(a.yaw - pattern)).toBeLessThanOrEqual(RECOIL_JITTER_FRAC * w.recoil.horizontal + 1e-12);
        if (a.yaw !== b.yaw) differs = true;
      }
      expect(differs).toBe(true);
    }
    // The pattern is smooth (no wild flips between consecutive shots) and weapon specific.
    for (let i = 1; i < 30; i++) {
      expect(Math.abs(recoilPattern('ar', i) - recoilPattern('ar', i - 1))).toBeLessThan(0.6);
    }
    const ar = Array.from({ length: 20 }, (_, i) => recoilPattern('ar', i));
    const smg = Array.from({ length: 20 }, (_, i) => recoilPattern('smg', i));
    expect(ar).not.toEqual(smg);
  });

  it('recovers to ~0 when not firing, not while firing', () => {
    const w = WEAPONS.ar;
    const held = recoverRecoil(w, 0.2, 0.03, 0.5, true);
    expect(held).toEqual({ pitch: 0.2, yaw: 0.03 });
    let rp = 0.2, ry = 0.03;
    for (let t = 0; t < 3; t += 1 / 30) {
      const r = recoverRecoil(w, rp, ry, 1 / 30, false);
      expect(Math.abs(r.pitch)).toBeLessThanOrEqual(Math.abs(rp));
      expect(Math.sign(r.pitch) * Math.sign(rp)).toBeGreaterThanOrEqual(0); // never overshoots
      rp = r.pitch;
      ry = r.yaw;
    }
    expect(Math.abs(rp)).toBeLessThan(1e-4);
    expect(Math.abs(ry)).toBeLessThan(1e-4);
    // Unarmed recovers quickly even if the trigger is "held".
    const u = recoverRecoil(null, 0.2, 0.05, 0.2, true);
    expect(Math.hypot(u.pitch, u.yaw)).toBeLessThan(0.2 * 0.1);
  });

  it('recovery is independent of the step size (client frames match server ticks)', () => {
    const w = WEAPONS.smg;
    let a = { pitch: 0.15, yaw: -0.02 };
    for (let i = 0; i < 12; i++) a = recoverRecoil(w, a.pitch, a.yaw, 1 / 30, false);
    let b = { pitch: 0.15, yaw: -0.02 };
    for (let i = 0; i < 58; i++) b = recoverRecoil(w, b.pitch, b.yaw, 1 / 145, false);
    expect(a.pitch).toBeCloseTo(b.pitch, 3);
    expect(a.yaw).toBeCloseTo(b.yaw, 4);
    const c = recoverRecoil(w, 0.15, -0.02, 0.4, false);
    expect(c.pitch).toBeCloseTo(a.pitch, 9);
  });
});

// ---------------------------------------------------------------------------
// Ballistics
// ---------------------------------------------------------------------------

describe('ballistics', () => {
  it('sniper time of flight and drop at 300 m', () => {
    const r = simulateTrajectory(WEAPONS.sniper, 300);
    expect(r.time).toBeGreaterThan(0.39);
    expect(r.time).toBeLessThan(0.45);
    expect(r.drop).toBeGreaterThan(0.5);
    expect(r.drop).toBeLessThan(1.2);
    const d = simulateTrajectory(WEAPONS.dmr, 300);
    expect(d.drop).toBeLessThan(r.drop); // DMR is flatter
    expect(d.time).toBeLessThan(r.time);
    expect(simulateTrajectory(WEAPONS.sniper, 600).drop).toBeGreaterThan(r.drop * 3);
  });

  it('matches the analytic solution for gravity + linear drag', () => {
    for (const id of ['dmr', 'sniper'] as const) {
      const w = WEAPONS[id];
      const k = w.drag, g = GRAVITY * w.gravityScale, v = w.muzzleVelocity;
      for (const range of [50, 150, 300, 500, 800]) {
        const t = -Math.log(1 - (k * range) / v) / k;
        const drop = (g / k) * (t - (1 - Math.exp(-k * t)) / k);
        const s = simulateTrajectory(w, range);
        expect(s.time).toBeCloseTo(t, 5);
        expect(s.drop).toBeCloseTo(drop, 4);
      }
    }
    // Hitscan weapons fly straight.
    const ar = simulateTrajectory(WEAPONS.ar, 300);
    expect(ar.drop).toBeCloseTo(0, 10);
    expect(ar.time).toBeCloseTo(300 / WEAPONS.ar.muzzleVelocity, 6);
  });

  it('stepBallistic is stable and step-size independent', () => {
    const w = WEAPONS.sniper;
    const a = { x: 0, y: 0, z: 0 }, va = { x: 0, y: 5, z: -760 };
    const b = { x: 0, y: 0, z: 0 }, vb = { x: 0, y: 5, z: -760 };
    for (let i = 0; i < 90; i++) stepBallistic(a, va, w, 1 / 30); // 3 s at sim tick
    for (let i = 0; i < 1800; i++) stepBallistic(b, vb, w, 1 / 600);
    expect(a.z).toBeCloseTo(b.z, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(va.z).toBeCloseTo(vb.z, 6);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(Math.abs(va.z)).toBeLessThan(760); // drag slows it down
    expect(a.y).toBeLessThan(0); // gravity wins
    const big = { x: 0, y: 0, z: 0 }, vbig = { x: 0, y: 0, z: -760 };
    stepBallistic(big, vbig, w, 1 / 30);
    expect(big.z).toBeCloseTo(-760 * (1 - Math.exp(-w.drag / 30)) / w.drag, 6);
  });

  it('zeroAngle makes the trajectory cross the sight line at 100 m', () => {
    for (const id of ['dmr', 'sniper'] as const) {
      const w = WEAPONS[id];
      const theta = zeroAngle(w, 100);
      expect(theta).toBeGreaterThan(0);
      expect(theta).toBeLessThan(0.01);
      // Launch along a level sight line with the launchVelocity used by the sim, advanced at tick rate.
      const dir = dirFromAngles(0.4, 0);
      const vel = launchVelocity(w, dir);
      expect(Math.hypot(vel.x, vel.y, vel.z)).toBeCloseTo(w.muzzleVelocity, 6);
      expect(angleBetween(vel, dir)).toBeCloseTo(theta, 9);
      const at100 = heightAtRange(w, vel, 100, 1 / 30);
      expect(Math.abs(at100.y)).toBeLessThan(0.02);
      // Bullet is above the line before the zero and below after it.
      expect(heightAtRange(w, vel, 50, 1 / 120).y).toBeGreaterThan(0);
      expect(heightAtRange(w, vel, 300, 1 / 120).y).toBeLessThan(-0.2);
      expect(sightDrop(w, 100)).toBeCloseTo(0, 3);
      expect(sightDrop(w, 300)).toBeCloseTo(-heightAtRange(w, vel, 300, 1 / 120).y, 2);
    }
    // Zeroing for longer ranges needs more elevation.
    expect(zeroAngle(WEAPONS.sniper, 300)).toBeGreaterThan(zeroAngle(WEAPONS.sniper, 100));
    expect(zeroAngle(WEAPONS.ar, 100)).toBe(0);
  });

  it('launchVelocity keeps hitscan tracers on the aim line and rotates within the vertical plane', () => {
    const dir = dirFromAngles(1.2, 0.3);
    const v = launchVelocity(WEAPONS.ar, dir);
    expect(angleBetween(v, dir)).toBeLessThan(1e-9);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(WEAPONS.ar.muzzleVelocity, 6);
    const s = launchVelocity(WEAPONS.sniper, dir, { x: 0, y: 0, z: 0 });
    // Same heading, slightly higher pitch.
    expect(Math.atan2(-s.x, -s.z)).toBeCloseTo(1.2, 9);
    const pitch = Math.atan2(s.y, Math.hypot(s.x, s.z));
    expect(pitch - 0.3).toBeCloseTo(zeroAngle(WEAPONS.sniper, 100), 9);
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('inventory', () => {
  it('capacity from base, vest and backpack', () => {
    const p = makePlayer();
    expect(capacity(p)).toBe(BASE_CAPACITY);
    expect(BASE_CAPACITY).toBe(50);
    p.armor.vest = 1;
    expect(capacity(p)).toBe(100);
    p.armor.pack = 3;
    expect(capacity(p)).toBe(300);
    expect(usedCapacity(p)).toBe(0);
  });

  it('primaries fill slot A then B, then replace the active primary', () => {
    const p = makePlayer();
    let r = pickupItem(p, 'ar', 1, 20);
    expect(r).toEqual({ taken: 1, dropped: [] });
    expect(p.weapons[0]).toEqual({ id: 'ar', mag: 20 });
    r = pickupItem(p, 'smg', 1, 99); // mag clamped to magSize
    expect(p.weapons[1]).toEqual({ id: 'smg', mag: 30 });
    r = pickupItem(p, 'pistol', 1);
    expect(p.weapons[2]).toEqual({ id: 'pistol', mag: 0 });
    // Active slot B -> replaces B and returns the old SMG with its magazine.
    p.activeSlot = 1;
    p.reloadTimer = 1;
    r = pickupItem(p, 'sniper', 1, 3);
    expect(r.taken).toBe(1);
    expect(r.dropped).toEqual([{ item: 'smg', count: 1, mag: 30 }]);
    expect(p.weapons[1]).toEqual({ id: 'sniper', mag: 3 });
    expect(p.weapons[0]?.id).toBe('ar');
    expect(p.reloadTimer).toBe(0); // reload of the dropped gun cancelled
    expect(p.drawTimer).toBeCloseTo(WEAPONS.sniper.drawTime, 10);
    // Active slot is the pistol -> replace slot A.
    p.activeSlot = 2;
    r = pickupItem(p, 'shotgun', 1, 5);
    expect(r.dropped).toEqual([{ item: 'ar', count: 1, mag: 20 }]);
    expect(p.weapons[0]).toEqual({ id: 'shotgun', mag: 5 });
    // A second pistol replaces the pistol slot.
    r = pickupItem(p, 'pistol', 1, 15);
    expect(r.dropped).toEqual([{ item: 'pistol', count: 1, mag: 0 }]);
    expect(p.weapons[2]).toEqual({ id: 'pistol', mag: 15 });
    expect(roomFor(p, 'ar')).toBe(1);
    // Weapons do not use capacity.
    expect(usedCapacity(p)).toBe(0);
  });

  it('gear equips, swaps different levels and keeps durability in mag', () => {
    const p = makePlayer();
    expect(pickupItem(p, 'vest1', 1)).toEqual({ taken: 1, dropped: [] });
    expect(p.armor).toMatchObject({ vest: 1, vestHp: 200 });
    expect(pickupItem(p, 'vest1', 1).taken).toBe(0);
    expect(roomFor(p, 'vest1')).toBe(0);
    p.armor.vestHp = 120;
    const r = pickupItem(p, 'vest3', 1);
    expect(r.dropped).toEqual([{ item: 'vest1', count: 1, mag: 120 }]);
    expect(p.armor).toMatchObject({ vest: 3, vestHp: 250 });
    // Picking the damaged vest back up restores its durability, not a fresh one.
    const back = pickupItem(p, 'vest1', 1, 120);
    expect(back.dropped).toEqual([{ item: 'vest3', count: 1, mag: 250 }]);
    expect(p.armor).toMatchObject({ vest: 1, vestHp: 120 });
    expect(pickupItem(p, 'helmet2', 1).taken).toBe(1);
    expect(p.armor).toMatchObject({ helmet: 2, helmetHp: 150 });
    expect(pickupItem(p, 'pack2', 1).taken).toBe(1);
    expect(capacity(p)).toBe(50 + 50 + 150);
    const swap = pickupItem(p, 'pack3', 1);
    expect(swap.dropped).toEqual([{ item: 'pack2', count: 1 }]);
    expect(capacity(p)).toBe(300);
  });

  it('a smaller backpack is refused when the load would not fit', () => {
    const p = makePlayer({ armor: { vest: 0, vestHp: 0, helmet: 0, helmetHp: 0, pack: 3 } });
    p.items.medkit = 10; // 200 capacity
    expect(roomFor(p, 'pack1')).toBe(0);
    expect(pickupItem(p, 'pack1', 1)).toEqual({ taken: 0, dropped: [] });
    expect(removeItem(p, 'pack3', 1)).toBe(0);
    p.items.medkit = 2;
    expect(roomFor(p, 'pack1')).toBe(1);
    expect(pickupItem(p, 'pack1', 1).dropped).toEqual([{ item: 'pack3', count: 1 }]);
    expect(removeItem(p, 'pack1', 1)).toBe(1);
    expect(p.armor.pack).toBe(0);
  });

  it('stackables are limited by remaining capacity', () => {
    const p = makePlayer();
    const w556 = AMMO.ammo_556.weight;
    const fit = Math.floor(50 / w556);
    expect(roomFor(p, 'ammo_556')).toBe(fit);
    const r = pickupItem(p, 'ammo_556', fit + 40);
    expect(r.taken).toBe(fit);
    expect(p.ammo.ammo_556).toBe(fit);
    expect(roomFor(p, 'bandage')).toBe(0);
    expect(pickupItem(p, 'bandage', 5).taken).toBe(0);
    pickupItem(p, 'vest2', 1);
    expect(roomFor(p, 'bandage')).toBe(25);
    expect(pickupItem(p, 'bandage', 5).taken).toBe(5);
    expect(pickupItem(p, 'frag', 2).taken).toBe(2);
    expect(usedCapacity(p)).toBeCloseTo(fit * w556 + 5 * 2 + 2 * 12, 9);
    // Floating point weights still allow filling to the exact capacity.
    const q = makePlayer();
    q.armor.pack = 1; // 150
    expect(pickupItem(q, 'ammo_556', 1000).taken).toBe(Math.round(150 / w556));
    expect(pickupItem(q, 'ammo_762', 0).taken).toBe(0);
    expect(pickupItem(q, 'ammo_762', -3).taken).toBe(0);
  });

  it('removeItem removes stacks, weapons and gear', () => {
    const p = makePlayer();
    pickupItem(p, 'ammo_9mm', 30);
    expect(removeItem(p, 'ammo_9mm', 12)).toBe(12);
    expect(p.ammo.ammo_9mm).toBe(18);
    expect(removeItem(p, 'ammo_9mm', 100)).toBe(18);
    expect(removeItem(p, 'ammo_9mm', 1)).toBe(0);
    pickupItem(p, 'energy', 1);
    expect(removeItem(p, 'energy', 1)).toBe(1);
    pickupItem(p, 'ar', 1, 30);
    pickupItem(p, 'ar', 1, 10);
    p.activeSlot = 1;
    expect(removeItem(p, 'ar', 1)).toBe(1);
    expect(p.weapons[1]).toBeNull(); // the one in hand
    expect(p.weapons[0]).toEqual({ id: 'ar', mag: 30 });
    expect(p.activeSlot).toBe(-1);
    expect(removeItem(p, 'dmr', 1)).toBe(0);
    pickupItem(p, 'helmet3', 1);
    expect(removeItem(p, 'helmet2', 1)).toBe(0);
    expect(removeItem(p, 'helmet3', 1)).toBe(1);
    expect(p.armor.helmet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Consumables & boost
// ---------------------------------------------------------------------------

describe('consumables and boost', () => {
  it('heals respect their caps', () => {
    const p = makePlayer({ health: 40 });
    applyConsumable(p, 'bandage');
    expect(p.health).toBe(50);
    p.health = 70;
    applyConsumable(p, 'bandage');
    expect(p.health).toBe(75);
    applyConsumable(p, 'bandage');
    expect(p.health).toBe(75);
    p.health = 12;
    applyConsumable(p, 'firstaid');
    expect(p.health).toBe(75);
    p.health = 80;
    applyConsumable(p, 'firstaid');
    expect(p.health).toBe(80); // never lowers health
    applyConsumable(p, 'medkit');
    expect(p.health).toBe(100);
    p.health = 30;
    applyConsumable(p, 'energy');
    expect(p.boost).toBe(40);
    expect(p.health).toBe(30);
    applyConsumable(p, 'energy');
    applyConsumable(p, 'energy');
    expect(p.boost).toBe(100);
    applyConsumable(p, 'fuel');
    expect(p.health).toBe(30);
    expect(p.boost).toBe(100);
    const downed = makePlayer({ life: 'downed', health: 0 });
    applyConsumable(downed, 'medkit');
    expect(downed.health).toBe(0);
  });

  it('canUseConsumable reflects caps and stock', () => {
    const p = makePlayer({ health: 80 });
    p.items.bandage = 2;
    p.items.medkit = 1;
    p.items.energy = 1;
    p.items.fuel = 1;
    expect(canUseConsumable(p, 'bandage')).toBe(false);
    expect(canUseConsumable(p, 'medkit')).toBe(true);
    expect(canUseConsumable(p, 'firstaid')).toBe(false); // none carried
    expect(canUseConsumable(p, 'energy')).toBe(true);
    expect(canUseConsumable(p, 'fuel')).toBe(true);
    p.boost = 100;
    expect(canUseConsumable(p, 'energy')).toBe(false);
  });

  it('boost heals over time by tier and decays', () => {
    const p = makePlayer({ health: 50, boost: 80 });
    tickBoost(p, 1);
    expect(p.health).toBeCloseTo(51, 9);
    expect(p.boost).toBeCloseTo(80 - BOOST_DECAY_PER_SEC, 9);
    expect(BOOST_DECAY_PER_SEC).toBeCloseTo(1 / 2.5, 9);
    p.boost = 40;
    tickBoost(p, 1);
    expect(p.health).toBeCloseTo(51.6, 9);
    p.boost = 10;
    tickBoost(p, 1);
    expect(p.health).toBeCloseTo(51.9, 9);
    // Full boost over time: heals but never above max health; boost runs out after 250 s.
    const q = makePlayer({ health: 95, boost: 100 });
    for (let i = 0; i < 30 * 260; i++) tickBoost(q, 1 / 30);
    expect(q.health).toBe(MAX_HEALTH);
    expect(q.boost).toBe(0);
    // No healing while downed, but boost still decays.
    const d = makePlayer({ life: 'downed', health: 0, boost: 50 });
    tickBoost(d, 2);
    expect(d.health).toBe(0);
    expect(d.boost).toBeCloseTo(50 - 2 * BOOST_DECAY_PER_SEC, 9);
    expect(boostSpeedMul(60)).toBe(1.04);
    expect(boostSpeedMul(59.9)).toBe(1);
    expect(boostSpeedMul(0)).toBe(1);
  });

  it('emptyInventory has every counter at zero and fresh objects', () => {
    const a = emptyInventory();
    const b = emptyInventory();
    expect(Object.keys(a.ammo).sort()).toEqual([...AMMO_IDS].sort());
    expect(Object.keys(a.items).sort()).toEqual(['bandage', 'energy', 'firstaid', 'frag', 'fuel', 'medkit']);
    for (const v of [...Object.values(a.ammo), ...Object.values(a.items)]) expect(v).toBe(0);
    a.ammo.ammo_9mm = 5;
    expect(b.ammo.ammo_9mm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

describe('loot tables', () => {
  it('produces valid, sensible stacks for each tier deterministically', () => {
    for (const tier of [0, 1, 2] as const) {
      const r1 = new Rng(1234 + tier);
      const r2 = new Rng(1234 + tier);
      for (let i = 0; i < 2000; i++) {
        const a = rollLoot(r1, tier);
        expect(rollLoot(r2, tier)).toEqual(a);
        expect(a.length).toBeGreaterThanOrEqual(1);
        expect(a.length).toBeLessThanOrEqual(3);
        for (const s of a) {
          expect(isItemId(s.item)).toBe(true);
          expect(Number.isInteger(s.count) && s.count > 0).toBe(true);
          const cat = itemCategory(s.item);
          if (cat === 'weapon') {
            const w = WEAPONS[s.item as WeaponId];
            expect(s.count).toBe(1);
            expect(Number.isInteger(s.mag)).toBe(true);
            expect(s.mag!).toBeGreaterThanOrEqual(0);
            expect(s.mag!).toBeLessThanOrEqual(w.magSize);
            const ammo = a.find((x) => x.item === w.ammo);
            expect(ammo, `ammo for ${s.item}`).toBeDefined();
            expect(ammo!.count).toBeGreaterThanOrEqual(w.magSize);
          } else {
            expect(s.mag).toBeUndefined();
          }
          if (cat === 'gear') expect(s.count).toBe(1);
          if (cat === 'ammo') expect(s.count).toBeLessThanOrEqual(200);
          if (cat === 'consumable' || cat === 'throwable') expect(s.count).toBeLessThanOrEqual(10);
        }
        // No duplicate entries.
        expect(new Set(a.map((s) => s.item)).size).toBe(a.length);
      }
    }
  });

  it('higher tiers hold better gear and more marksman rifles', () => {
    const stats = [0, 1, 2].map((tier) => {
      const rng = new Rng(99);
      let marksman = 0, weapons = 0, lvl3 = 0, gear = 0;
      for (let i = 0; i < 6000; i++) {
        for (const s of rollLoot(rng, tier as 0 | 1 | 2)) {
          if (s.item === 'dmr' || s.item === 'sniper') marksman++;
          if (isWeaponId(s.item)) weapons++;
          if (isGearId(s.item)) {
            gear++;
            if (GEAR[s.item].level === 3) lvl3++;
          }
        }
      }
      return { marksmanFrac: marksman / weapons, lvl3Frac: lvl3 / gear };
    });
    expect(stats[2].marksmanFrac).toBeGreaterThan(stats[1].marksmanFrac);
    expect(stats[1].marksmanFrac).toBeGreaterThan(stats[0].marksmanFrac);
    expect(stats[0].marksmanFrac).toBeLessThan(0.08);
    expect(stats[2].marksmanFrac).toBeGreaterThan(0.2);
    expect(stats[2].lvl3Frac).toBeGreaterThan(stats[0].lvl3Frac * 3);
  });

  it('every loot item category appears somewhere', () => {
    const seen = new Set<ItemId>();
    const rng = new Rng(5);
    for (let i = 0; i < 20000; i++) for (const tier of [0, 1, 2] as const) for (const s of rollLoot(rng, tier)) seen.add(s.item);
    for (const id of ALL_ITEM_IDS) expect(seen.has(id), id).toBe(true);
  });
});
