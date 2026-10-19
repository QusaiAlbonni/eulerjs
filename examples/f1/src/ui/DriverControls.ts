import type { DriverInput } from '../car/F1Car.js';

/** What the controls do besides driving, once each press. */
export interface ControlActions {
  camera(): void;
  reset(): void;
  assists(): void;
  gearbox(): void;
  sound(): void;
  help(): void;
}

/** How fast the keys move the pedals and the steering, in full travels a second. */
const PEDAL_RATE = { on: 5, off: 8 };
const STEER_RATE = { on: 2.5, off: 4 };
/**
 * The keyboard's steering lock falls with speed, as 1 / (1 + (speed / this)^1.2), speed in m/s:
 * about what the car's grip can use, a key pressed being all or nothing. Full lock at 300 km/h
 * would spin the car.
 */
const KEYBOARD_LOCK_SPEED = 15;
const STICK_DEAD_ZONE = 0.06;

/** Standard gamepad layout's buttons. */
const PAD = { a: 0, b: 1, x: 2, y: 3, leftBumper: 4, rightBumper: 5, leftTrigger: 6, rightTrigger: 7, back: 8, start: 9 };

/**
 * The keyboard and a gamepad, into the car's input. The keys ramp the pedals and steering in and
 * out, as a foot and hands would, and steer less the faster the car goes; a gamepad's triggers
 * and stick are used as they are, the stick with a small dead zone and a gentle curve.
 */
export class DriverControls {
  private readonly held = new Set<string>();
  private readonly actions: ControlActions;
  private readonly input: DriverInput;
  private readonly padPressed = new Set<number>();

  constructor(input: DriverInput, actions: ControlActions) {
    this.input = input;
    this.actions = actions;
    window.addEventListener('keydown', (event) => {
      this.held.add(event.code);
      if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
      if (event.repeat) return;
      if (event.code === 'KeyE' || event.code === 'ShiftRight') input.shiftUp = true;
      if (event.code === 'KeyQ' || event.code === 'ControlRight') input.shiftDown = true;
      if (event.code === 'KeyC') actions.camera();
      if (event.code === 'KeyR') actions.reset();
      if (event.code === 'KeyT') actions.assists();
      if (event.code === 'KeyM') actions.gearbox();
      if (event.code === 'KeyN') actions.sound();
      if (event.code === 'KeyH') actions.help();
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  /** Reads the controls into the car's input; `speed` in m/s, for the keyboard's steering lock. */
  update(frameDelta: number, speed: number): void {
    const input = this.input;
    const pad = navigator.getGamepads?.().find((gamepad) => gamepad?.connected) ?? undefined;
    if (pad) {
      this.readPad(pad);
      return;
    }
    const keys = this.held;
    const throttle = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
    const brake = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;
    const steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
    input.throttle = approach(input.throttle, throttle, throttle > input.throttle ? PEDAL_RATE.on : PEDAL_RATE.off, frameDelta);
    input.brake = approach(input.brake, brake, brake > input.brake ? PEDAL_RATE.on : PEDAL_RATE.off, frameDelta);
    const target = steer * keyboardSteeringLock(speed);
    input.steer = approach(input.steer, target, Math.abs(target) > Math.abs(input.steer) ? STEER_RATE.on : STEER_RATE.off, frameDelta);
    input.drs = keys.has('Space');
  }

  private readPad(pad: Gamepad): void {
    const input = this.input;
    const stick = pad.axes[0] ?? 0;
    const beyondDeadZone = Math.max(Math.abs(stick) - STICK_DEAD_ZONE, 0) / (1 - STICK_DEAD_ZONE);
    // left on the stick is negative; left on the car's steering positive
    input.steer = -Math.sign(stick) * beyondDeadZone ** 1.4;
    input.throttle = pad.buttons[PAD.rightTrigger]?.value ?? 0;
    input.brake = pad.buttons[PAD.leftTrigger]?.value ?? 0;
    const pressedNow = (button: number) => {
      const down = pad.buttons[button]?.pressed ?? false;
      const fresh = down && !this.padPressed.has(button);
      if (down) this.padPressed.add(button);
      else this.padPressed.delete(button);
      return fresh;
    };
    if (pressedNow(PAD.rightBumper)) input.shiftUp = true;
    if (pressedNow(PAD.leftBumper)) input.shiftDown = true;
    if (pressedNow(PAD.y)) this.actions.camera();
    if (pressedNow(PAD.start)) this.actions.reset();
    if (pressedNow(PAD.back)) this.actions.assists();
    if (pressedNow(PAD.b)) this.actions.gearbox();
    if (pressedNow(PAD.x)) this.actions.sound();
    input.drs = pad.buttons[PAD.a]?.pressed ?? false;
  }
}

/** The share of full lock a steering key gives at `speed`, in m/s. */
export function keyboardSteeringLock(speed: number): number {
  return 1 / (1 + (Math.abs(speed) / KEYBOARD_LOCK_SPEED) ** 1.2);
}

/** `value` moved toward `target` at `rate` a second. */
function approach(value: number, target: number, rate: number, frameDelta: number): number {
  const step = rate * frameDelta;
  return Math.abs(target - value) <= step ? target : value + Math.sign(target - value) * step;
}
