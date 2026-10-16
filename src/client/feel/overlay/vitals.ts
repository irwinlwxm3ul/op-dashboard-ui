// Low-health presentation: a red vignette pulsing with a heartbeat rhythm and a desaturation
// layer (backdrop-filter, we do not own the canvas host) that intensify as health drops; when
// downed, a grey tint with a slower, darker heartbeat.

import type { LifeState } from '../../../shared/types';
import { heartbeatPulse } from '../math';
import { div, setOpacity } from './dom';

export class Vitals {
  private readonly vignette: HTMLDivElement;
  private readonly desat: HTMLDivElement;
  private readonly downed: HTMLDivElement;
  private vignetteOpacity = 0;
  private desatShown = false;
  private desatLevel = -1;
  private downedShown = false;
  private beat = 0;

  constructor(parent: HTMLElement) {
    this.desat = div(parent, 'dzf-full dzf-desat');
    this.downed = div(parent, 'dzf-full dzf-downed');
    this.vignette = div(parent, 'dzf-full dzf-lowhp');
  }

  /**
   * `low`: smoothed low-health intensity 0..1 (FeelState.lowHealth). `life`: local life state
   * (null when there is no local player). `bleed`: 0..1 how far a downed player has bled out.
   */
  update(low: number, life: LifeState | null, bleed: number, dt: number): void {
    const downed = life === 'downed';
    const alive = life === 'alive';

    // Heart rate rises as health falls; downed starts slow and quickens as you bleed out.
    const bps = downed ? 0.85 + 0.75 * bleed : 1.1 + 0.95 * low;
    this.beat = (this.beat + dt * bps) % 1;
    const pulse = heartbeatPulse(this.beat);

    let vig = 0;
    if (downed) vig = 0.5 + 0.38 * pulse;
    else if (alive && low > 0) vig = low * (0.6 + 0.4 * pulse);
    this.vignetteOpacity = setOpacity(this.vignette, vig, this.vignetteOpacity);

    if (downed !== this.downedShown) {
      this.downed.style.display = downed ? 'block' : 'none';
      this.downedShown = downed;
    }

    // Desaturation in 5 % steps so the (GPU) backdrop filter is only rebuilt when it visibly changes.
    const want = alive && low > 0.02;
    if (want) {
      const level = Math.round((1 - 0.78 * low) * 20) / 20;
      if (level !== this.desatLevel) {
        const filter = `saturate(${level})`;
        this.desat.style.setProperty('backdrop-filter', filter);
        this.desat.style.setProperty('-webkit-backdrop-filter', filter);
        this.desatLevel = level;
      }
    }
    if (want !== this.desatShown) {
      this.desat.style.display = want ? 'block' : 'none';
      this.desat.style.opacity = '1';
      this.desatShown = want;
    }
  }

  clear(): void {
    this.update(0, null, 0, 0);
  }
}
