/**
 * Load Generator - Generates synthetic load for performance testing
 *
 * Supports different load patterns:
 * - Constant load (steady RPS)
 * - Ramp load (gradual increase)
 * - Spike load (sudden bursts)
 */

export type LoadPattern = 'constant' | 'ramp' | 'spike';

export interface LoadConfig {
  pattern: LoadPattern;
  targetRps: number;
  duration: number;
  // Ramp-specific
  startRps?: number;
  endRps?: number;
  // Spike-specific
  baseRps?: number;
  spikeRps?: number;
  spikeDuration?: number;
}

export class LoadGenerator {
  private active: boolean = false;

  /**
   * Generate constant load at target RPS
   */
  async generateConstantLoad(
    targetRps: number,
    duration: number,
    requestFn: () => Promise<void>
  ): Promise<void> {
    this.active = true;
    const intervalMs = 1000 / targetRps;
    const endTime = Date.now() + duration;

    while (Date.now() < endTime && this.active) {
      const requestStart = Date.now();

      // Fire request (don't await - we want concurrent requests)
      requestFn().catch(() => {});

      // Wait for next request interval
      const elapsed = Date.now() - requestStart;
      const wait = Math.max(0, intervalMs - elapsed);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }

    this.active = false;
  }

  /**
   * Generate ramping load from start to end RPS
   */
  async generateRampLoad(
    startRps: number,
    endRps: number,
    duration: number,
    requestFn: () => Promise<void>
  ): Promise<void> {
    this.active = true;
    const startTime = Date.now();
    const endTime = startTime + duration;

    while (Date.now() < endTime && this.active) {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;

      // Linear ramp from start to end RPS
      const currentRps = startRps + (endRps - startRps) * progress;
      const intervalMs = 1000 / currentRps;

      const requestStart = Date.now();
      requestFn().catch(() => {});

      const requestElapsed = Date.now() - requestStart;
      const wait = Math.max(0, intervalMs - requestElapsed);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }

    this.active = false;
  }

  /**
   * Generate spike load (baseline with periodic spikes)
   */
  async generateSpikeLoad(
    baseRps: number,
    spikeRps: number,
    duration: number,
    spikeDuration: number,
    requestFn: () => Promise<void>
  ): Promise<void> {
    this.active = true;
    const endTime = Date.now() + duration;
    let inSpike = false;
    let spikeEndTime = 0;

    while (Date.now() < endTime && this.active) {
      // Trigger spike every 30 seconds
      if (!inSpike && Date.now() % 30000 < 1000) {
        inSpike = true;
        spikeEndTime = Date.now() + spikeDuration;
      }

      // End spike
      if (inSpike && Date.now() >= spikeEndTime) {
        inSpike = false;
      }

      const currentRps = inSpike ? spikeRps : baseRps;
      const intervalMs = 1000 / currentRps;

      const requestStart = Date.now();
      requestFn().catch(() => {});

      const elapsed = Date.now() - requestStart;
      const wait = Math.max(0, intervalMs - elapsed);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }

    this.active = false;
  }

  /**
   * Stop load generation
   */
  stop(): void {
    this.active = false;
  }
}
