/**
 * Hardware Detection and Profiling
 *
 * Detects Apple Silicon chip model, GPU cores, and unified memory
 * to provide intelligent concurrency recommendations.
 */

import { execSync } from 'child_process';
import * as os from 'os';

export type ChipModel =
  | 'M1'
  | 'M1-Pro'
  | 'M1-Max'
  | 'M1-Ultra'
  | 'M2'
  | 'M2-Pro'
  | 'M2-Max'
  | 'M2-Ultra'
  | 'M3'
  | 'M3-Pro'
  | 'M3-Max'
  | 'M3-Ultra'
  | 'M4'
  | 'M4-Pro'
  | 'M4-Max'
  | 'M5'
  | 'M5-Pro'
  | 'M5-Max'
  | 'Unknown';

export interface HardwareProfile {
  chipModel: ChipModel;
  chipGeneration: number; // 1=M1, 2=M2, 3=M3, 4=M4, 5=M5
  variant: 'Base' | 'Pro' | 'Max' | 'Ultra';
  gpuCores: number;
  cpuCores: number;
  performanceCores: number;
  efficiencyCores: number;
  unifiedMemoryGB: number;
  metalVersion: string;
  osVersion: string;
  detectedAt: number;
}

export interface ConcurrencyRecommendation {
  '30B+': { maxConcurrent: number; queueDepth: number };
  '13-27B': { maxConcurrent: number; queueDepth: number };
  '7-13B': { maxConcurrent: number; queueDepth: number };
  '3-7B': { maxConcurrent: number; queueDepth: number };
  '<3B': { maxConcurrent: number; queueDepth: number };
  confidence: 'low' | 'medium' | 'high';
  source: 'default' | 'detected' | 'benchmarked';
}

/**
 * Detect Apple Silicon hardware profile
 */
export function detectHardware(): HardwareProfile {
  try {
    // Get chip brand (Apple M1/M2/M3/M4/M5)
    const brandName = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();

    // Parse chip model from brand name
    const chipModel = parseChipModel(brandName);

    // Get GPU core count
    const gpuCores = getGpuCoreCount();

    // Get CPU core counts
    const cpuCores = os.cpus().length;
    const perfCores = getPerformanceCoreCount();
    const effCores = cpuCores - perfCores;

    // Get unified memory (total system RAM for Apple Silicon)
    const unifiedMemoryGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));

    // Get Metal version
    const metalVersion = getMetalVersion();

    // Get macOS version
    const osVersion = os.release();

    return {
      chipModel,
      chipGeneration: getChipGeneration(chipModel),
      variant: getChipVariant(chipModel),
      gpuCores,
      cpuCores,
      performanceCores: perfCores,
      efficiencyCores: effCores,
      unifiedMemoryGB,
      metalVersion,
      osVersion,
      detectedAt: Date.now(),
    };
  } catch (error) {
    // Fallback to conservative profile
    return {
      chipModel: 'Unknown',
      chipGeneration: 1,
      variant: 'Base',
      gpuCores: 8,
      cpuCores: os.cpus().length,
      performanceCores: 4,
      efficiencyCores: 4,
      unifiedMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      metalVersion: 'Unknown',
      osVersion: os.release(),
      detectedAt: Date.now(),
    };
  }
}

/**
 * Parse chip model from brand string
 */
function parseChipModel(brandName: string): ChipModel {
  const lower = brandName.toLowerCase();

  // M5 detection (future-proof)
  if (lower.includes('m5')) {
    if (lower.includes('max')) return 'M5-Max';
    if (lower.includes('pro')) return 'M5-Pro';
    return 'M5';
  }

  // M4 detection
  if (lower.includes('m4')) {
    if (lower.includes('max')) return 'M4-Max';
    if (lower.includes('pro')) return 'M4-Pro';
    return 'M4';
  }

  // M3 detection
  if (lower.includes('m3')) {
    if (lower.includes('ultra')) return 'M3-Ultra';
    if (lower.includes('max')) return 'M3-Max';
    if (lower.includes('pro')) return 'M3-Pro';
    return 'M3';
  }

  // M2 detection
  if (lower.includes('m2')) {
    if (lower.includes('ultra')) return 'M2-Ultra';
    if (lower.includes('max')) return 'M2-Max';
    if (lower.includes('pro')) return 'M2-Pro';
    return 'M2';
  }

  // M1 detection
  if (lower.includes('m1')) {
    if (lower.includes('ultra')) return 'M1-Ultra';
    if (lower.includes('max')) return 'M1-Max';
    if (lower.includes('pro')) return 'M1-Pro';
    return 'M1';
  }

  return 'Unknown';
}

/**
 * Get GPU core count (approximate based on chip model)
 */
function getGpuCoreCount(): number {
  try {
    // Try to get actual GPU info via system_profiler (slower but accurate)
    const gpuInfo = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    // Parse GPU core count from Metal info
    const coreMatch = gpuInfo.match(/Total Number of Cores:\s*(\d+)/i);
    if (coreMatch) {
      return parseInt(coreMatch[1], 10);
    }
  } catch {
    // Fallback to estimation based on CPU brand
  }

  // Estimate based on chip model (fallback)
  try {
    const brandName = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
    const lower = brandName.toLowerCase();

    // M5 estimates (future-proof)
    if (lower.includes('m5 max')) return 40;
    if (lower.includes('m5 pro')) return 20;
    if (lower.includes('m5')) return 12;

    // M4 estimates
    if (lower.includes('m4 max')) return 40;
    if (lower.includes('m4 pro')) return 20;
    if (lower.includes('m4')) return 10;

    // M3 estimates
    if (lower.includes('m3 ultra')) return 80;
    if (lower.includes('m3 max')) return 40;
    if (lower.includes('m3 pro')) return 18;
    if (lower.includes('m3')) return 10;

    // M2 estimates
    if (lower.includes('m2 ultra')) return 76;
    if (lower.includes('m2 max')) return 38;
    if (lower.includes('m2 pro')) return 19;
    if (lower.includes('m2')) return 10;

    // M1 estimates
    if (lower.includes('m1 ultra')) return 64;
    if (lower.includes('m1 max')) return 32;
    if (lower.includes('m1 pro')) return 16;
    if (lower.includes('m1')) return 8;
  } catch {
    // Ignore
  }

  return 8; // Conservative fallback
}

/**
 * Get performance core count
 */
function getPerformanceCoreCount(): number {
  try {
    const perfCores = execSync('sysctl -n hw.perflevel0.logicalcpu 2>/dev/null', {
      encoding: 'utf8',
    }).trim();
    return parseInt(perfCores, 10) || 4;
  } catch {
    return 4; // Fallback
  }
}

/**
 * Get Metal version
 */
function getMetalVersion(): string {
  try {
    const metalInfo = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    const versionMatch = metalInfo.match(/Metal[^:]*:\s*([^\n]+)/i);
    if (versionMatch) {
      return versionMatch[1].trim();
    }
  } catch {
    // Ignore
  }

  return 'Unknown';
}

/**
 * Extract chip generation number
 */
function getChipGeneration(chipModel: ChipModel): number {
  if (chipModel.startsWith('M5')) return 5;
  if (chipModel.startsWith('M4')) return 4;
  if (chipModel.startsWith('M3')) return 3;
  if (chipModel.startsWith('M2')) return 2;
  if (chipModel.startsWith('M1')) return 1;
  return 1; // Conservative fallback
}

/**
 * Extract chip variant
 */
function getChipVariant(chipModel: ChipModel): 'Base' | 'Pro' | 'Max' | 'Ultra' {
  if (chipModel.includes('Ultra')) return 'Ultra';
  if (chipModel.includes('Max')) return 'Max';
  if (chipModel.includes('Pro')) return 'Pro';
  return 'Base';
}

/**
 * Generate concurrency recommendations based on hardware profile
 */
export function recommendConcurrency(profile: HardwareProfile): ConcurrencyRecommendation {
  // Calculate performance score based on multiple factors
  const generationBonus = profile.chipGeneration * 1.2; // M4/M5 are ~20% better per gen
  const gpuScore = profile.gpuCores * generationBonus;
  const memoryScore = profile.unifiedMemoryGB / 16; // Normalize to 16GB baseline

  // Combined score
  const performanceScore = gpuScore * memoryScore;

  // Determine base multiplier based on chip variant
  let variantMultiplier = 1.0;
  switch (profile.variant) {
    case 'Ultra':
      variantMultiplier = 4.0;
      break;
    case 'Max':
      variantMultiplier = 2.5;
      break;
    case 'Pro':
      variantMultiplier = 1.5;
      break;
    case 'Base':
      variantMultiplier = 1.0;
      break;
  }

  // Calculate tier-specific limits with hardware-aware scaling
  const recommendations: ConcurrencyRecommendation = {
    '30B+': {
      maxConcurrent: Math.max(1, Math.min(20, Math.round(1 * variantMultiplier))),
      queueDepth: Math.max(5, Math.min(50, Math.round(10 * variantMultiplier))),
    },
    '13-27B': {
      maxConcurrent: Math.max(2, Math.min(30, Math.round(3 * variantMultiplier))),
      queueDepth: Math.max(10, Math.min(60, Math.round(20 * variantMultiplier))),
    },
    '7-13B': {
      maxConcurrent: Math.max(4, Math.min(40, Math.round(6 * variantMultiplier))),
      queueDepth: Math.max(15, Math.min(80, Math.round(30 * variantMultiplier))),
    },
    '3-7B': {
      maxConcurrent: Math.max(6, Math.min(50, Math.round(8 * variantMultiplier))),
      queueDepth: Math.max(20, Math.min(100, Math.round(40 * variantMultiplier))),
    },
    '<3B': {
      maxConcurrent: Math.max(8, Math.min(60, Math.round(10 * variantMultiplier))),
      queueDepth: Math.max(30, Math.min(120, Math.round(50 * variantMultiplier))),
    },
    confidence: performanceScore > 100 ? 'high' : performanceScore > 50 ? 'medium' : 'low',
    source: 'detected',
  };

  return recommendations;
}

/**
 * Print hardware profile summary
 */
export function printHardwareProfile(profile: HardwareProfile, recommendations?: ConcurrencyRecommendation): string {
  const lines = [
    '╔══════════════════════════════════════════════════════════╗',
    '║           Hardware Profile Detection                    ║',
    '╚══════════════════════════════════════════════════════════╝',
    '',
    `Chip Model:         ${profile.chipModel}`,
    `Generation:         M${profile.chipGeneration} (${profile.variant})`,
    `GPU Cores:          ${profile.gpuCores}`,
    `CPU Cores:          ${profile.cpuCores} (${profile.performanceCores}P + ${profile.efficiencyCores}E)`,
    `Unified Memory:     ${profile.unifiedMemoryGB} GB`,
    `Metal Version:      ${profile.metalVersion}`,
    `macOS Version:      ${profile.osVersion}`,
    '',
  ];

  if (recommendations) {
    lines.push('Recommended Concurrency Limits:');
    lines.push('─'.repeat(60));
    lines.push(
      `  30B+ models:      ${recommendations['30B+'].maxConcurrent} concurrent (queue: ${recommendations['30B+'].queueDepth})`,
    );
    lines.push(
      `  13-27B models:    ${recommendations['13-27B'].maxConcurrent} concurrent (queue: ${recommendations['13-27B'].queueDepth})`,
    );
    lines.push(
      `  7-13B models:     ${recommendations['7-13B'].maxConcurrent} concurrent (queue: ${recommendations['7-13B'].queueDepth})`,
    );
    lines.push(
      `  3-7B models:      ${recommendations['3-7B'].maxConcurrent} concurrent (queue: ${recommendations['3-7B'].queueDepth})`,
    );
    lines.push(
      `  <3B models:       ${recommendations['<3B'].maxConcurrent} concurrent (queue: ${recommendations['<3B'].queueDepth})`,
    );
    lines.push('');
    lines.push(`Confidence:         ${recommendations.confidence.toUpperCase()}`);
    lines.push(`Source:             ${recommendations.source}`);
  }

  return lines.join('\n');
}
