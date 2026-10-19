import type { Vector3 } from 'three';
import type { Circuit } from '../track/Circuit.js';

const SIZE = 220;
const MARGIN = 16;

/**
 * The circuit from above, north up, the car on it as an arrow pointing where it heads: drawn once
 * to an image, the car drawn over it each frame.
 */
export class Minimap {
  private readonly context: CanvasRenderingContext2D;
  private readonly track: HTMLCanvasElement;
  private readonly scale: number;
  private readonly middleX: number;
  private readonly middleZ: number;

  constructor(container: HTMLElement, circuit: Circuit) {
    const canvas = document.createElement('canvas');
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    canvas.width = canvas.height = SIZE * pixelRatio;
    canvas.className = 'minimap';
    container.appendChild(canvas);
    this.context = canvas.getContext('2d')!;
    this.context.scale(pixelRatio, pixelRatio);

    const xs = circuit.samples.map((sample) => sample.position.x);
    const zs = circuit.samples.map((sample) => sample.position.z);
    const width = Math.max(...xs) - Math.min(...xs);
    const depth = Math.max(...zs) - Math.min(...zs);
    this.scale = (SIZE - 2 * MARGIN) / Math.max(width, depth);
    this.middleX = (Math.max(...xs) + Math.min(...xs)) / 2;
    this.middleZ = (Math.max(...zs) + Math.min(...zs)) / 2;

    this.track = document.createElement('canvas');
    this.track.width = this.track.height = SIZE * pixelRatio;
    const drawing = this.track.getContext('2d')!;
    drawing.scale(pixelRatio, pixelRatio);
    const trace = (points: readonly Vector3[], closed: boolean) => {
      drawing.beginPath();
      points.forEach((point, index) => {
        const [mapX, mapY] = this.toMap(point);
        if (index === 0) drawing.moveTo(mapX, mapY);
        else drawing.lineTo(mapX, mapY);
      });
      if (closed) drawing.closePath();
    };
    drawing.lineJoin = drawing.lineCap = 'round';
    // the pit lane faint, the track over it with a dark edge
    trace(circuit.pitLane, false);
    drawing.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    drawing.lineWidth = 2;
    drawing.stroke();
    const lap = circuit.samples.map((sample) => sample.position);
    trace(lap, true);
    drawing.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    drawing.lineWidth = 7;
    drawing.stroke();
    drawing.strokeStyle = '#e8ecf1';
    drawing.lineWidth = 3.5;
    drawing.stroke();
    // the start line, across the track
    const start = circuit.startLine;
    const [startX, startY] = this.toMap(start.position);
    drawing.save();
    drawing.translate(startX, startY);
    drawing.rotate(Math.atan2(start.tangent.z, start.tangent.x));
    drawing.fillStyle = '#3ddc6a';
    drawing.fillRect(-1.5, -6, 3, 12);
    drawing.restore();
  }

  /** A point in the world, on the map: north (−z) up. */
  private toMap(point: Vector3): [number, number] {
    return [SIZE / 2 + (point.x - this.middleX) * this.scale, SIZE / 2 + (point.z - this.middleZ) * this.scale];
  }

  update(position: Vector3, heading: number): void {
    const context = this.context;
    context.clearRect(0, 0, SIZE, SIZE);
    context.drawImage(this.track, 0, 0, SIZE, SIZE);
    const [mapX, mapY] = this.toMap(position);
    context.save();
    context.translate(mapX, mapY);
    // heading about y from +z; on the map +z is down
    context.rotate(-heading + Math.PI);
    context.beginPath();
    context.moveTo(0, -8);
    context.lineTo(5.5, 6);
    context.lineTo(0, 3);
    context.lineTo(-5.5, 6);
    context.closePath();
    context.fillStyle = '#f2a531';
    context.strokeStyle = '#111';
    context.lineWidth = 1.5;
    context.fill();
    context.stroke();
    context.restore();
  }
}
