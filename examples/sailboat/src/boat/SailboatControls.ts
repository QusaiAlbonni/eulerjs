import { MathUtils } from 'three';
import type { SailboatFoils } from './sailboatPhysics.js';
import { SAILBOAT_LAYOUT } from './sailboatLayout.js';
import type { SailboatLayout } from './sailboatLayout.js';

/** Which key moves which control, and in which direction. */
const KEY_BINDINGS = {
  KeyA: { control: 'rudder', direction: -1 },
  KeyD: { control: 'rudder', direction: 1 },
  KeyQ: { control: 'mainsail', direction: -1 },
  KeyE: { control: 'mainsail', direction: 1 },
  KeyZ: { control: 'jib', direction: -1 },
  KeyX: { control: 'jib', direction: 1 },
} as const;

type BoundKey = keyof typeof KEY_BINDINGS;
type Control = (typeof KEY_BINDINGS)[BoundKey]['control'];

function isBoundKey(code: string): code is BoundKey {
  return code in KEY_BINDINGS;
}

/**
 * Keyboard helm: A/D turn the rudder (it recentres when let go), Q/E ease and trim the main
 * sail, Z/X the jib. The angles are written straight into the foils.
 */
export class SailboatControls {
  private readonly foils: SailboatFoils;
  private readonly layout: SailboatLayout;
  private readonly eventTarget: EventTarget;
  private readonly heldKeys = new Set<BoundKey>();

  constructor(foils: SailboatFoils, eventTarget: EventTarget, layout: SailboatLayout = SAILBOAT_LAYOUT) {
    this.foils = foils;
    this.layout = layout;
    this.eventTarget = eventTarget;
    eventTarget.addEventListener('keydown', this.onKeyDown);
    eventTarget.addEventListener('keyup', this.onKeyUp);
    eventTarget.addEventListener('blur', this.onBlur);
  }

  update(frameDelta: number): void {
    const rudder = this.layout.rudder;
    const steering = this.heldDirection('rudder');
    if (steering === 0) {
      this.foils.rudder.angle = moveToward(this.foils.rudder.angle, 0, rudder.returnRate * frameDelta);
    } else {
      this.foils.rudder.angle = MathUtils.clamp(this.foils.rudder.angle + steering * rudder.turnRate * frameDelta, -rudder.maxAngle, rudder.maxAngle);
    }
    for (const sail of ['mainsail', 'jib'] as const) {
      const limits = this.layout[sail];
      this.foils[sail].angle = MathUtils.clamp(
        this.foils[sail].angle + this.heldDirection(sail) * limits.trimRate * frameDelta,
        -limits.maxAngle,
        limits.maxAngle,
      );
    }
  }

  dispose(): void {
    this.eventTarget.removeEventListener('keydown', this.onKeyDown);
    this.eventTarget.removeEventListener('keyup', this.onKeyUp);
    this.eventTarget.removeEventListener('blur', this.onBlur);
    this.heldKeys.clear();
  }

  /** -1, 0 or 1: which way the held keys push a control (opposite keys cancel). */
  private heldDirection(control: Control): number {
    let direction = 0;
    for (const key of this.heldKeys) {
      if (KEY_BINDINGS[key].control === control) direction += KEY_BINDINGS[key].direction;
    }
    return direction;
  }

  private readonly onKeyDown = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    if (isBoundKey(code)) this.heldKeys.add(code);
  };

  private readonly onKeyUp = (event: Event): void => {
    const code = (event as KeyboardEvent).code;
    if (isBoundKey(code)) this.heldKeys.delete(code);
  };

  /** Keys released while the window is not focused never send keyup. */
  private readonly onBlur = (): void => {
    this.heldKeys.clear();
  };
}

function moveToward(value: number, target: number, maximumStep: number): number {
  if (Math.abs(target - value) <= maximumStep) return target;
  return value + Math.sign(target - value) * maximumStep;
}
