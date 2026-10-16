export { createRenderCore, configureDynamicResolution } from './renderCore';
export type { RenderStatsEx, DynamicResolutionSettings } from './renderCore';
export { recommendQuality, classifyGpu, readGpuInfo, benchmarkMediumFrame, tierFromFrameMs, combineTiers, QUALITY_ORDER } from './benchmark';
export type { GpuInfo } from './benchmark';
export { DynamicResolution, DEFAULT_DRS_OPTIONS } from './dynamicResolution';
export type { DynamicResolutionOptions, TimingSignal } from './dynamicResolution';
export { QUALITY_PROFILES, qualityProfile, computePixelRatio, MAX_PIXEL_RATIO } from './quality';
export type { QualityProfile, VegetationProfile, GrassProfile } from './quality';
export { ENV, computeSunDirection, SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG } from './environment';
