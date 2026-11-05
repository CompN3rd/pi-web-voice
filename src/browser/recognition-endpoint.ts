/** Optional energy-only endpoint, not VAD/intent recognition. No timers, storage or dispatch authority.
 * Require 300 ms of activity, then 1.2 s of quiet. Frame accounting is independent of capture chunk size.
 */
export class PauseEndpoint {
  private samples = 0;
  private power = 0;
  private activeFrames = 0;
  private quietFrames = 0;
  push(pcm: Float32Array): boolean {
    for (const sample of pcm) {
      this.power += Number.isFinite(sample) ? sample * sample : 0;
      if (++this.samples < 320) continue;
      if (this.power / 320 >= 0.0001) { this.activeFrames++; this.quietFrames = 0; }
      else this.quietFrames++;
      this.samples = 0; this.power = 0;
      if (this.activeFrames >= 15 && this.quietFrames >= 60) return true;
    }
    return false;
  }
}
