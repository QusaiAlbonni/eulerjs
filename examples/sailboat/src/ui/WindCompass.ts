import { MathUtils } from 'three';
import type { Wind } from '@eulerjs/marine';

const SIZE = 100;
const RING_RADIUS = SIZE / 2 - 10;
const HANDLE_RADIUS = 5;
const COLOR = '#ff8800';

/**
 * A dial that sets where the wind blows. Drag the handle around the ring; the label shows the
 * wind's angle in degrees, the same angle `Wind.angle` holds in radians.
 */
export class WindCompass {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly label: HTMLDivElement;
  private dragging = false;

  constructor(
    private readonly wind: Wind,
    container: HTMLElement,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'wind-compass';
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.label = document.createElement('div');
    this.label.className = 'wind-compass-label';
    this.element.append(this.canvas, this.label);
    container.appendChild(this.element);

    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('WindCompass needs a 2D canvas context');
    this.context = context;

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.draw();
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.element.remove();
  }

  /** The canvas's y axis points down, so the handle's on-screen angle is the wind angle negated. */
  private draw(): void {
    const center = SIZE / 2;
    const handleAngle = -this.wind.angle;
    const context = this.context;
    context.clearRect(0, 0, SIZE, SIZE);
    context.beginPath();
    context.arc(center, center, RING_RADIUS, 0, 2 * Math.PI);
    context.strokeStyle = COLOR;
    context.lineWidth = 3;
    context.stroke();

    context.beginPath();
    context.arc(center + RING_RADIUS * Math.cos(handleAngle), center + RING_RADIUS * Math.sin(handleAngle), HANDLE_RADIUS, 0, 2 * Math.PI);
    context.fillStyle = COLOR;
    context.fill();

    const degrees = MathUtils.euclideanModulo(MathUtils.radToDeg(this.wind.angle), 360);
    this.label.textContent = `${degrees.toFixed(2)}°`;
  }

  private pointTo(event: PointerEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    const handleAngle = Math.atan2(event.clientY - bounds.top - SIZE / 2, event.clientX - bounds.left - SIZE / 2);
    const screenDegrees = MathUtils.euclideanModulo(MathUtils.radToDeg(handleAngle), 360);
    this.wind.angle = MathUtils.degToRad(360 - screenDegrees);
    this.draw();
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragging = true;
    this.pointTo(event);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.dragging) this.pointTo(event);
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };
}
