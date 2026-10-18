import type { SpectralWaves, Wind } from '@eulerjs/marine';

/** Changing the sea's waves takes about a frame's work, so it follows the wind's turns at most this often. */
const SECONDS_BETWEEN_CHANGES = 0.25;
/** Turns smaller than this, in radians, aren't worth a change. */
const SMALLEST_TURN = 0.02;

/** Turns the sea's waves to the wind's direction when the wind is turned, as the compass does. */
export class SeaFollowsWind {
  private sinceChange = 0;

  constructor(
    private readonly waves: SpectralWaves,
    private readonly wind: Wind,
  ) {}

  update(frameDelta: number): void {
    this.sinceChange += frameDelta;
    if (this.sinceChange < SECONDS_BETWEEN_CHANGES) return;
    const turn = Math.atan2(Math.sin(this.wind.angle - this.waves.sea.windAngle), Math.cos(this.wind.angle - this.waves.sea.windAngle));
    if (Math.abs(turn) < SMALLEST_TURN) return;
    this.waves.setSea({ windAngle: this.wind.angle });
    this.sinceChange = 0;
  }
}
