import { CanvasTexture, LinearSRGBColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';
import type { Texture } from 'three';

// Textures drawn at load from seeded noise, so that nothing has to be downloaded: each surface's
// colour, its bumps as a normal map, and how rough it is, all tiling seamlessly.

/** A surface's three maps. */
export interface SurfaceMaps {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

/** Mulberry32: the same numbers every load for the same seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth noise tiling every `period` cells over a `size` square, 0 to 1: random values at lattice points, eased between. */
function tilingNoise(size: number, period: number, random: () => number): Float32Array {
  const lattice = Float32Array.from({ length: period * period }, () => random());
  const values = new Float32Array(size * size);
  const ease = (share: number) => share * share * (3 - 2 * share);
  for (let row = 0; row < size; row++) {
    const latticeRow = (row / size) * period;
    const top = Math.floor(latticeRow);
    const down = ease(latticeRow - top);
    for (let column = 0; column < size; column++) {
      const latticeColumn = (column / size) * period;
      const left = Math.floor(latticeColumn);
      const across = ease(latticeColumn - left);
      const at = (latticeX: number, latticeY: number) => lattice[(latticeY % period) * period + (latticeX % period)]!;
      const upper = at(left, top) + (at(left + 1, top) - at(left, top)) * across;
      const lower = at(left, top + 1) + (at(left + 1, top + 1) - at(left, top + 1)) * across;
      values[row * size + column] = upper + (lower - upper) * down;
    }
  }
  return values;
}

/** Fractal noise: octaves of tiling noise, each twice as fine and half as strong, 0 to 1. */
export function fractalNoise(size: number, basePeriod: number, octaves: number, random: () => number): Float32Array {
  const total = new Float32Array(size * size);
  let weight = 1;
  let weights = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const layer = tilingNoise(size, basePeriod << octave, random);
    for (let index = 0; index < total.length; index++) total[index] = total[index]! + layer[index]! * weight;
    weights += weight;
    weight *= 0.5;
  }
  for (let index = 0; index < total.length; index++) total[index] = total[index]! / weights;
  return total;
}

function canvasOf(size: number, width = size): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = size;
  return { canvas, context: canvas.getContext('2d')! };
}

function texture(canvas: HTMLCanvasElement, colour: boolean): CanvasTexture {
  const result = new CanvasTexture(canvas);
  result.wrapS = result.wrapT = RepeatWrapping;
  result.colorSpace = colour ? SRGBColorSpace : LinearSRGBColorSpace;
  result.anisotropy = 8;
  return result;
}

/** A normal map from heights over a tiling square, `strength` how steep its bumps look. */
function normalMapFrom(heights: Float32Array, size: number, strength: number): CanvasTexture {
  const { canvas, context } = canvasOf(size);
  const image = context.createImageData(size, size);
  const at = (column: number, row: number) => heights[((row + size) % size) * size + ((column + size) % size)]!;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const slopeX = (at(column + 1, row) - at(column - 1, row)) * strength;
      const slopeY = (at(column, row + 1) - at(column, row - 1)) * strength;
      const length = Math.hypot(slopeX, slopeY, 1);
      const pixel = (row * size + column) * 4;
      image.data[pixel] = (0.5 - slopeX / length / 2) * 255;
      image.data[pixel + 1] = (0.5 + slopeY / length / 2) * 255;
      image.data[pixel + 2] = (0.5 + 0.5 / length) * 255;
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return texture(canvas, false);
}

/** Paints a square from a function of each pixel giving its colour (0–255 each) and roughness (0–1). */
function paint(size: number, pixelAt: (column: number, row: number, index: number) => [number, number, number, number]): { map: CanvasTexture; roughnessMap: CanvasTexture } {
  const colour = canvasOf(size);
  const rough = canvasOf(size);
  const colourImage = colour.context.createImageData(size, size);
  const roughImage = rough.context.createImageData(size, size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const index = row * size + column;
      const [red, green, blue, roughness] = pixelAt(column, row, index);
      colourImage.data.set([red, green, blue, 255], index * 4);
      const level = Math.round(Math.min(Math.max(roughness, 0), 1) * 255);
      roughImage.data.set([level, level, level, 255], index * 4);
    }
  }
  colour.context.putImageData(colourImage, 0, 0);
  rough.context.putImageData(roughImage, 0, 0);
  return { map: texture(colour.canvas, true), roughnessMap: texture(rough.canvas, false) };
}

/**
 * Asphalt across the track's width (u) and along it (v): fine grain and pale flecks of stone,
 * and the racing line rubbered in down its middle, darker and smoother where the tyres run.
 */
export function asphaltMaps(): SurfaceMaps {
  const size = 512;
  const random = seeded(11);
  const grain = fractalNoise(size, 64, 4, random);
  const patches = fractalNoise(size, 4, 2, random);
  const heights = new Float32Array(size * size);
  const flecks = new Uint8Array(size * size);
  for (let index = 0; index < flecks.length; index++) flecks[index] = random() < 0.006 ? 1 : 0;
  const maps = paint(size, (column, _row, index) => {
    const across = column / size;
    // rubber laid down where the cars run, fading out toward the edges
    const rubber = Math.max(0, 1 - Math.abs(across - 0.5) / 0.22) ** 1.5 * (0.6 + 0.4 * patches[index]!);
    const fleck = flecks[index]! * (0.4 + random() * 0.4);
    const shade = 40 + (grain[index]! - 0.5) * 18 + fleck * 24 - rubber * 12 + (patches[index]! - 0.5) * 8;
    heights[index] = grain[index]! * 0.6 + fleck * 0.25;
    return [shade, shade + 1, shade + 3, 0.95 - rubber * 0.18];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 0.7) };
}

/** Grass blades, light and dark, at a finer scale than the mown stripes the ground's own colour gives. */
export function grassMaps(): SurfaceMaps {
  const size = 512;
  const random = seeded(23);
  const blades = fractalNoise(size, 64, 3, random);
  const clumps = fractalNoise(size, 8, 3, random);
  const heights = new Float32Array(size * size);
  const maps = paint(size, (_column, _row, index) => {
    const light = blades[index]! * 0.6 + clumps[index]! * 0.4;
    heights[index] = blades[index]!;
    return [52 + light * 38, 92 + light * 52, 38 + light * 24, 0.95];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 4) };
}

/** Gravel: pebbles of sandy stone, each a rounded bump. */
export function gravelMaps(): SurfaceMaps {
  const size = 512;
  const random = seeded(37);
  const heights = new Float32Array(size * size);
  const tone = new Float32Array(size * size);
  for (let pebble = 0; pebble < 5200; pebble++) {
    const centreX = random() * size;
    const centreY = random() * size;
    const radius = 2 + random() * 4.5;
    const shade = random();
    for (let row = Math.floor(centreY - radius); row <= centreY + radius; row++) {
      for (let column = Math.floor(centreX - radius); column <= centreX + radius; column++) {
        const reach = 1 - Math.hypot(column - centreX, row - centreY) / radius;
        if (reach <= 0) continue;
        const index = ((row + size) % size) * size + ((column + size) % size);
        const height = Math.sqrt(reach);
        if (height > heights[index]!) {
          heights[index] = height;
          tone[index] = shade;
        }
      }
    }
  }
  const maps = paint(size, (_column, _row, index) => {
    const lit = 0.55 + heights[index]! * 0.45;
    const base = 150 + tone[index]! * 60;
    return [base * lit, (base - 14) * lit, (base - 40) * lit, 0.97];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 5) };
}

/** A kerb: red and white blocks along it (v), each ridged across, a little grubby from tyres. */
export function kerbMaps(): SurfaceMaps {
  const size = 256;
  const random = seeded(41);
  const grime = fractalNoise(size, 8, 3, random);
  const heights = new Float32Array(size * size);
  const maps = paint(size, (column, row, index) => {
    const red = row < size / 2;
    // ridges across the kerb, a few to each block
    heights[index] = 0.5 + 0.5 * Math.sin((row / size) * Math.PI * 12);
    const dirt = grime[index]! * 30 + (column / size) * 12;
    return red ? [196 - dirt, 34 - dirt / 3, 38 - dirt / 3, 0.6] : [236 - dirt, 236 - dirt, 232 - dirt, 0.6];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 2) };
}

/** Concrete wall panels, along u, height up v: joints every panel, grime splashed up from the ground. */
export function concreteMaps(): SurfaceMaps {
  const size = 256;
  const random = seeded(53);
  const grain = fractalNoise(size, 16, 4, random);
  const heights = new Float32Array(size * size);
  const maps = paint(size, (column, row, index) => {
    const joint = column < 3 ? 1 : 0;
    const grime = Math.max(0, (row / size - 0.55) / 0.45) * 50;
    const shade = 172 + (grain[index]! - 0.5) * 30 - grime - joint * 60;
    heights[index] = grain[index]! - joint;
    return [shade, shade, shade - 4, 0.9];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 2) };
}

/** Catch fencing: a diamond mesh of wire, clear between, for alphaTest. */
export function fenceTexture(): CanvasTexture {
  const { canvas, context } = canvasOf(64);
  context.strokeStyle = '#c9ced4';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, 32);
  context.lineTo(32, 0);
  context.lineTo(64, 32);
  context.lineTo(32, 64);
  context.closePath();
  context.stroke();
  return texture(canvas, true);
}

/** Carbon fibre's twill weave, for the car's floor, wings and halo. */
export function carbonMaps(): SurfaceMaps {
  const size = 128;
  const heights = new Float32Array(size * size);
  const maps = paint(size, (column, row, index) => {
    const cell = 8;
    const weave = (Math.floor(column / cell) + Math.floor(row / cell)) % 2 === 0;
    const within = weave ? (column % cell) / cell : (row % cell) / cell;
    heights[index] = Math.sin(within * Math.PI);
    const shade = 22 + heights[index]! * 18;
    return [shade, shade + 1, shade + 3, 0.35 + (1 - heights[index]!) * 0.25];
  });
  return { ...maps, normalMap: normalMapFrom(heights, size, 1.5) };
}

/** A tyre's sidewall, for the face of its cylinder: the compound's coloured band and the maker's lettering round it. */
export function sidewallTexture(band: string): CanvasTexture {
  const size = 512;
  const { canvas, context } = canvasOf(size);
  const middle = size / 2;
  context.fillStyle = '#121214';
  context.fillRect(0, 0, size, size);
  context.strokeStyle = band;
  context.lineWidth = 14;
  context.beginPath();
  context.arc(middle, middle, size * 0.4, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = '#e6e6e6';
  context.font = 'bold 30px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const [text, from] of [['EULERJS', -Math.PI / 2], ['SLICK', Math.PI / 2]] as const) {
    const letters = [...text];
    letters.forEach((letter, index) => {
      const angle = from + (index - (letters.length - 1) / 2) * 0.13;
      context.save();
      context.translate(middle + Math.cos(angle) * size * 0.455, middle + Math.sin(angle) * size * 0.455);
      context.rotate(angle + Math.PI / 2);
      context.fillText(letter, 0, 0);
      context.restore();
    });
  }
  const result = texture(canvas, true);
  result.wrapS = result.wrapT = RepeatWrapping;
  return result;
}

/** The livery for the engine cover's sides: a sweep of the accent colour and the car's number. */
export function liveryTexture(base: string, accent: string, number: string): CanvasTexture {
  const { canvas, context } = canvasOf(256, 512);
  context.fillStyle = base;
  context.fillRect(0, 0, 512, 256);
  context.fillStyle = accent;
  context.beginPath();
  context.moveTo(0, 200);
  context.bezierCurveTo(180, 120, 320, 210, 512, 60);
  context.lineTo(512, 110);
  context.bezierCurveTo(330, 250, 190, 170, 0, 256);
  context.closePath();
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = 'italic 800 120px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(number, 300, 118);
  context.font = '700 34px system-ui, sans-serif';
  context.fillText('eulerjs', 120, 64);
  return texture(canvas, true);
}

/** An advertising board's face: white text on a colour, as a made-up sponsor's. */
export function boardTexture(text: string, background: string, foreground = '#ffffff'): CanvasTexture {
  const { canvas, context } = canvasOf(64, 512);
  context.fillStyle = background;
  context.fillRect(0, 0, 512, 64);
  context.fillStyle = foreground;
  context.font = '800 40px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 256, 34);
  return texture(canvas, true);
}
