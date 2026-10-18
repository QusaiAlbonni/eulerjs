import type { FirstPersonPlayer } from './FirstPersonPlayer.js';
import type { Hands } from './Hands.js';

/** Radians the view turns per pixel the mouse moves. */
const LOOK_SPEED = 0.0022;
const MOST_PITCH = 1.45;

/**
 * Keyboard and mouse for the player: click to take the mouse, then move it to look; W A S D or
 * the arrows to walk, Shift to run, Space to jump; click to shove what you look at, or throw what
 * you carry; E to pick something up or put it down; R to go back to the entrance.
 */
export class PlayerControls {
  private readonly pressed = new Set<string>();
  private readonly listeners: [EventTarget, string, (event: Event) => void][] = [];

  constructor(
    private readonly player: FirstPersonPlayer,
    private readonly hands: Hands,
    private readonly canvas: HTMLCanvasElement,
    private readonly onRespawn: () => void,
  ) {
    this.listen(window, 'keydown', (event) => this.keyDown(event as KeyboardEvent));
    this.listen(window, 'keyup', (event) => this.pressed.delete((event as KeyboardEvent).code));
    this.listen(window, 'blur', () => this.pressed.clear());
    this.listen(canvas, 'mousedown', (event) => this.mouseDown(event as MouseEvent));
    this.listen(document, 'mousemove', (event) => this.look(event as MouseEvent));
    this.listen(canvas, 'contextmenu', (event) => event.preventDefault());
  }

  /** Whether the mouse is taken, and the player can look about. */
  get looking(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Turns the keys held down into what the player wants to do, once a frame. */
  update(): void {
    const input = this.player.input;
    input.forward = (this.isPressed('KeyW', 'ArrowUp') ? 1 : 0) - (this.isPressed('KeyS', 'ArrowDown') ? 1 : 0);
    input.right = (this.isPressed('KeyD', 'ArrowRight') ? 1 : 0) - (this.isPressed('KeyA', 'ArrowLeft') ? 1 : 0);
    input.running = this.isPressed('ShiftLeft', 'ShiftRight');
    input.jumping = this.isPressed('Space');
  }

  dispose(): void {
    for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener);
  }

  private keyDown(event: KeyboardEvent): void {
    this.pressed.add(event.code);
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'KeyE') {
      if (this.hands.holding) this.hands.drop();
      else this.hands.pickUp();
    }
    if (event.code === 'KeyR') this.onRespawn();
  }

  private mouseDown(event: MouseEvent): void {
    if (!this.looking) {
      void this.canvas.requestPointerLock();
      return;
    }
    if (event.button !== 0) return;
    if (this.hands.holding) this.hands.throwHeld();
    else this.hands.shove();
  }

  private look(event: MouseEvent): void {
    if (!this.looking) return;
    this.player.yaw -= event.movementX * LOOK_SPEED;
    this.player.pitch = Math.max(-MOST_PITCH, Math.min(MOST_PITCH, this.player.pitch - event.movementY * LOOK_SPEED));
  }

  private listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  private isPressed(...codes: string[]): boolean {
    return codes.some((code) => this.pressed.has(code));
  }
}
