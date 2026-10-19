import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';
import type { Material, Scene } from 'three';
import { asphaltMaps, boardTexture, concreteMaps, fenceTexture, fractalNoise, grassMaps, gravelMaps, kerbMaps, seeded } from '../scene/textures.js';
import type { SurfaceMaps } from '../scene/textures.js';
import { KERB_HEIGHTS, KERB_WIDTH, sampleRuns as runs, samplesFrom as stretch, WALL_HEIGHT } from './Circuit.js';
import type { Circuit, TrackSample } from './Circuit.js';

// The circuit drawn: the track's asphalt, rubbered in down the racing line, its kerbs, the gravel
// and the grass, walls with catch fencing and tyres, the pit lane and garages, the grid and the
// start gantry, grandstands full of people, and the trees of the park round it. The walls are
// bodies too, for the car to hit.

const FENCE_HEIGHT = 3.2;
/** The boards along the walls: the engine's name, and the library it is for. */
const SPONSORS: readonly [string, string, string?][] = [
  ['EULERJS', '#1f6fb8'],
  ['THREE.JS', '#111111'],
];

/** Lights out: the start gantry's five lights, to light as the start counts down. */
export interface StartLights {
  /** How many are lit, 0 to 5. */
  set(lit: number): void;
}

/** The size of the tiles instances are grouped into, in metres, so that each tile is left out when out of view. */
const TILE = 250;

/**
 * Many copies of one mesh, each at its matrix and in its colour, as instanced meshes a tile of
 * the map each: one instanced mesh over the whole circuit would be drawn whole wherever the
 * camera looks, and in every shadow pass.
 */
function tiledInstances(scene: Scene, geometry: BufferGeometry, material: Material, copies: readonly { matrix: Matrix4; colour?: Color }[], shadows: { cast: boolean; receive: boolean }): void {
  const tiles = new Map<string, { matrix: Matrix4; colour?: Color }[]>();
  const position = new Vector3();
  for (const copy of copies) {
    position.setFromMatrixPosition(copy.matrix);
    const key = `${Math.floor(position.x / TILE)},${Math.floor(position.z / TILE)}`;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = []));
    tile.push(copy);
  }
  for (const tile of tiles.values()) {
    const mesh = new InstancedMesh(geometry, material, tile.length);
    tile.forEach((copy, index) => {
      mesh.setMatrixAt(index, copy.matrix);
      if (copy.colour) mesh.setColorAt(index, copy.colour);
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows.cast;
    mesh.receiveShadow = shadows.receive;
    scene.add(mesh);
  }
}

/**
 * A strip along `points` between two distances out from the centre line (positive to the left),
 * each given for each sample, at a height for each edge; u runs across from the first edge to
 * the second (or, given `uLength`, a unit every that many metres out), v along at a unit every
 * `vLength` metres. Wound to face up.
 */
function strip(
  points: readonly { sample: TrackSample; distance: number }[],
  from: (sample: TrackSample) => number,
  to: (sample: TrackSample) => number,
  heights: [number, number],
  vLength: number,
  uLength?: number,
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const { sample, distance } of points) {
    for (const [edge, offset] of [[0, from(sample)], [1, to(sample)]] as const) {
      positions.push(sample.position.x + sample.left.x * offset, heights[edge], sample.position.z + sample.left.z * offset);
      uvs.push(uLength === undefined ? edge : offset / uLength, distance / vLength);
    }
  }
  const indices: number[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const corner = index * 2;
    indices.push(corner, corner + 2, corner + 1, corner + 1, corner + 2, corner + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  if (geometry.getAttribute('normal').getY(0) < 0) {
    geometry.setIndex(indices.map((_index, position) => indices[position - (position % 3) + 2 - (position % 3)]!));
    geometry.computeVertexNormals();
  }
  return geometry;
}

/** A wall standing along `points`, `offset` from the centre line, `height` high, u along at a unit every `uLength` metres. */
function wall(points: readonly { sample: TrackSample; distance: number }[], offset: (sample: TrackSample) => number, bottom: number, top: number, uLength: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const { sample, distance } of points) {
    const across = offset(sample);
    const east = sample.position.x + sample.left.x * across;
    const south = sample.position.z + sample.left.z * across;
    positions.push(east, bottom, south, east, top, south);
    uvs.push(distance / uLength, 1, distance / uLength, 0);
  }
  const indices: number[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const corner = index * 2;
    indices.push(corner, corner + 1, corner + 2, corner + 1, corner + 3, corner + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function standard(maps: SurfaceMaps, options: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({ ...maps, ...options });
}

/** The ground: grass, mown in stripes, its colour drifting over the park as real grass's does. */
function buildGround(scene: Scene): void {
  const maps = grassMaps();
  for (const map of [maps.map, maps.normalMap, maps.roughnessMap]) map.repeat.set(1500, 1500);
  const material = standard(maps, { roughness: 1 });
  // a second, much larger noise drifting the colour, and stripes where it was mown
  const drift = new CanvasTexture(noiseCanvas(256, 4, 71));
  material.onBeforeCompile = (shader) => {
    shader.uniforms['groundDrift'] = { value: drift };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 groundPosition;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\ngroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 groundPosition;\nuniform sampler2D groundDrift;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float drift = texture2D(groundDrift, groundPosition.xz / 1800.0).r;
        float mown = step(0.0, sin(groundPosition.x / 9.0)) * 0.07;
        diffuseColor.rgb *= vec3(0.86 + drift * 0.32 + mown, 0.9 + drift * 0.2 + mown, 0.82 + drift * 0.18 + mown * 0.6);`,
      );
  };
  const ground = new Mesh(new PlaneGeometry(9000, 9000), material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function noiseCanvas(size: number, period: number, seed: number): HTMLCanvasElement {
  const values = fractalNoise(size, period, 4, seeded(seed));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  values.forEach((value, index) => image.data.set([value * 255, value * 255, value * 255, 255], index * 4));
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The track, its white edges, the kerbs, and the gravel traps with their asphalt strips. */
function buildSurface(scene: Scene, circuit: Circuit): void {
  const samples = circuit.samples;
  const lap = stretch(samples, 0, samples.length);
  const asphalt = asphaltMaps();
  const track = new Mesh(strip(lap, (sample) => sample.halfWidth, (sample) => -sample.halfWidth, [0.012, 0.012], 18), standard(asphalt));
  track.receiveShadow = true;
  scene.add(track);

  const white = new MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.65 });
  for (const side of [1, -1]) {
    const line = new Mesh(strip(lap, (sample) => side * (sample.halfWidth - 0.15), (sample) => side * (sample.halfWidth - 0.35), [0.016, 0.016], 4), white);
    line.receiveShadow = true;
    scene.add(line);
  }

  // kerbs, raised at their outer edge, and the plain asphalt run-off beyond them
  const kerb = kerbMaps();
  const kerbMaterial = standard(kerb);
  for (const [first, last] of runs(samples, (sample) => sample.kerbs)) {
    const points = stretch(samples, first, last);
    for (const side of [1, -1]) {
      const mesh = new Mesh(strip(points, (sample) => side * sample.halfWidth, (sample) => side * (sample.halfWidth + KERB_WIDTH), [...KERB_HEIGHTS], 4), kerbMaterial);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }
  const runOffMaps = asphaltMaps();
  const runOffMaterial = standard(runOffMaps, { color: 0xc8c8c8 });
  const gravelMaterial = standard(gravelMaps());
  for (const sideIndex of [0, 1] as const) {
    const side = sideIndex === 0 ? 1 : -1;
    for (const [first, last] of runs(samples, (sample) => sample.sides[sideIndex].runOff === 'gravel')) {
      const points = stretch(samples, first, last);
      const edge = (sample: TrackSample) => sample.halfWidth + (sample.kerbs ? KERB_WIDTH : 0);
      // tiled in metres: a run-off strip's asphalt every 6, the gravel's pebbles a tile every 2.5
      const runOff = new Mesh(strip(points, (sample) => side * edge(sample), (sample) => side * (edge(sample) + 3), [0.011, 0.011], 6, 6), runOffMaterial);
      const gravel = new Mesh(strip(points, (sample) => side * (edge(sample) + 3), (sample) => side * Math.max(edge(sample) + 3, sample.sides[sideIndex].barrier - 0.8), [0.01, 0.01], 2.5, 2.5), gravelMaterial);
      runOff.receiveShadow = gravel.receiveShadow = true;
      scene.add(runOff, gravel);
    }
  }
}

/** Dark streaks down the middle of the track into each big braking zone, where tyres have locked. */
function buildSkidMarks(scene: Scene, circuit: Circuit): void {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const fade = context.createLinearGradient(0, 0, 0, 256);
  fade.addColorStop(0, 'rgba(10, 10, 10, 0)');
  fade.addColorStop(0.7, 'rgba(10, 10, 10, 0.55)');
  fade.addColorStop(1, 'rgba(10, 10, 10, 0.1)');
  context.fillStyle = fade;
  context.fillRect(0, 0, 16, 256);
  const material = new MeshBasicMaterial({ map: new CanvasTexture(canvas), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const random = seeded(97);
  const samples = circuit.samples;
  for (const sample of brakingZones(circuit)) {
    const index = samples.indexOf(sample);
    for (let pair = 0; pair < 5; pair++) {
      const across = (random() - 0.5) * 3;
      const along = stretch(samples, index - 70 + samples.length + Math.floor(random() * 10), index + samples.length - 2);
      // measured from where the mark begins, so that its fade runs over its whole length
      const markStart = along[0]!.distance;
      const markLength = along[along.length - 1]!.distance - markStart;
      const points = along.map((point) => ({ sample: point.sample, distance: point.distance - markStart }));
      for (const wheel of [-0.8, 0.8]) {
        scene.add(new Mesh(strip(points, () => across + wheel - 0.15, () => across + wheel + 0.15, [0.02, 0.02], markLength), material));
      }
    }
  }
}

/** The samples where the car brakes hardest: the first sharp bend after a long run of gentle ones. */
function brakingZones(circuit: Circuit): TrackSample[] {
  const samples = circuit.samples;
  const zones: TrackSample[] = [];
  let gentle = 0;
  for (let step = 0; step < samples.length * 2; step++) {
    const sample = samples[step % samples.length]!;
    if (Math.abs(sample.curvature) < 1 / 400) gentle++;
    else {
      if (gentle > 150 && Math.abs(sample.curvature) > 1 / 120 && step >= samples.length && !zones.includes(sample)) zones.push(sample);
      gentle = 0;
    }
  }
  return zones;
}

/** The walls along both sides, with catch fencing, tyres in front behind the gravel, and boards on them. */
function buildBarriers(scene: Scene, circuit: Circuit): void {
  const samples = circuit.samples;
  const concrete = standard(concreteMaps(), { side: DoubleSide });
  // alphaToCoverage smooths the wire's cut-out edges, which would otherwise shimmer far off
  const fence = new MeshStandardMaterial({ map: fenceTexture(), alphaTest: 0.5, alphaToCoverage: true, side: DoubleSide, metalness: 0.6, roughness: 0.4 });
  // a diamond every 1.4 metres along and up
  fence.map!.repeat.set(1, FENCE_HEIGHT / 1.4);
  const tyreMaterial = new MeshStandardMaterial({ roughness: 0.85 });
  const tyreGeometry = new CylinderGeometry(0.33, 0.33, 0.28, 9);
  const tyreColours = [new Color(0x111111), new Color(0xc8262a), new Color(0xf4f4f4), new Color(0x1f6fb8)];
  const tyres: { matrix: Matrix4; colour: Color }[] = [];

  for (const sideIndex of [0, 1] as const) {
    const side = sideIndex === 0 ? 1 : -1;
    const offset = (sample: TrackSample) => side * sample.sides[sideIndex].barrier;
    // the wall in stretches, broken where the pit lane runs through it
    for (const [first, last] of circuit.wallRuns(sideIndex)) {
      const points = stretch(samples, first, last);
      const concreteWall = new Mesh(wall(points, offset, 0, WALL_HEIGHT, 4), concrete);
      concreteWall.castShadow = concreteWall.receiveShadow = true;
      const fencing = new Mesh(wall(points, offset, WALL_HEIGHT, WALL_HEIGHT + FENCE_HEIGHT, 1.4), fence);
      scene.add(concreteWall, fencing);
    }

    // tyres stacked in front of the wall behind each gravel trap
    for (const [first, last] of runs(samples, (sample) => sample.sides[sideIndex].runOff === 'gravel')) {
      for (let index = first; index <= last; index += 1) {
        const sample = samples[index % samples.length]!;
        const reach = sample.sides[sideIndex].barrier - 0.4;
        for (const along of [0, 0.66, 1.32]) {
          const base = sample.position.clone().addScaledVector(sample.left, side * reach).addScaledVector(sample.tangent, along - 0.66);
          for (let level = 0; level < 3; level++) {
            tyres.push({ matrix: new Matrix4().makeTranslation(base.x, 0.14 + level * 0.28, base.z), colour: tyreColours[(index + level) % tyreColours.length]! });
          }
        }
      }
    }
  }
  tiledInstances(scene, tyreGeometry, tyreMaterial, tyres, { cast: true, receive: true });

  // boards along the walls of the start straight and into the braking zones
  const boardMaterials = SPONSORS.map(([text, background, foreground]) => new MeshStandardMaterial({ map: boardTexture(text, background, foreground), roughness: 0.6 }));
  const boardGeometry = new PlaneGeometry(8, 1);
  let boardCount = 0;
  const boardAt = (sample: TrackSample, sideIndex: 0 | 1) => {
    const side = sideIndex === 0 ? 1 : -1;
    if (circuit.nearPitLane(sample.position.clone().addScaledVector(sample.left, side * sample.sides[sideIndex].barrier), 9)) return;
    const board = new Mesh(boardGeometry, boardMaterials[boardCount++ % boardMaterials.length]!);
    board.position.copy(sample.position).addScaledVector(sample.left, side * (sample.sides[sideIndex].barrier - 0.02));
    board.position.y = 0.6;
    // facing the track
    board.lookAt(board.position.clone().addScaledVector(sample.left, -side));
    board.receiveShadow = true;
    scene.add(board);
  };
  for (let index = 0; index < 200; index += 5) {
    boardAt(samples[index]!, 0);
    boardAt(samples[index]!, 1);
  }
  for (const zone of brakingZones(circuit)) {
    const at = samples.indexOf(zone);
    for (let back = 10; back < 120; back += 5) {
      const sample = samples[(at - back + samples.length) % samples.length]!;
      boardAt(sample, 0);
      boardAt(sample, 1);
    }
  }
}

/** The pit lane, its wall on the track side, and the garages along it. */
function buildPits(scene: Scene, circuit: Circuit): void {
  const lane = circuit.pitLane;
  if (lane.length < 2) return;
  const asphalt = asphaltMaps();
  const material = standard(asphalt, { color: 0xb8b8b8 });
  const positions: number[] = [];
  const uvs: number[] = [];
  let distance = 0;
  lane.forEach((point, index) => {
    const next = lane[Math.min(index + 1, lane.length - 1)]!;
    const previous = lane[Math.max(index - 1, 0)]!;
    const along = new Vector2(next.x - previous.x, next.z - previous.z).normalize();
    if (index > 0) distance += point.distanceTo(lane[index - 1]!);
    for (const [edge, offset] of [[0, -6], [1, 6]] as const) {
      positions.push(point.x - along.y * offset, 0.013, point.z + along.x * offset);
      uvs.push(edge, distance / 18);
    }
  });
  const indices: number[] = [];
  for (let index = 0; index < lane.length - 1; index++) indices.push(index * 2, index * 2 + 1, index * 2 + 2, index * 2 + 1, index * 2 + 3, index * 2 + 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  if (geometry.getAttribute('normal').getY(0) < 0) {
    geometry.setIndex(indices.map((_index, position) => indices[position - (position % 3) + 2 - (position % 3)]!));
    geometry.computeVertexNormals();
  }
  const surface = new Mesh(geometry, material);
  surface.receiveShadow = true;
  scene.add(surface);

  // the garages: a long building on the far side of the lane from the track, its doors in team colours
  const start = circuit.startLine;
  const middle = lane[Math.floor(lane.length / 2)]!;
  const away = Math.sign(middle.clone().sub(start.position).dot(start.left)) || 1;
  const building = new MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.7 });
  const teamColours = [0xc8262a, 0x1f6fb8, 0xf2a531, 0x1fa39a, 0x15171b, 0xe86a2c, 0x2a6e3f, 0x8a2be2, 0xeeeeee, 0x0b2a5b];
  const garageCount = 20;
  for (let garage = 0; garage < garageCount; garage++) {
    const along = (garage - garageCount / 2) * 16;
    const base = start.position.clone().addScaledVector(start.tangent, along + 40).addScaledVector(start.left, away * 34);
    const block = new Mesh(new BoxGeometry(16, 8, 18), building);
    block.position.set(base.x, 4, base.z);
    block.rotation.y = Math.atan2(start.tangent.x, start.tangent.z);
    block.castShadow = block.receiveShadow = true;
    const door = new Mesh(new PlaneGeometry(11, 5.5), new MeshStandardMaterial({ color: teamColours[garage % teamColours.length]!, roughness: 0.5 }));
    door.position.copy(base).addScaledVector(start.left, -away * 9.02);
    door.position.y = 2.75;
    door.lookAt(door.position.clone().addScaledVector(start.left, -away));
    scene.add(block, door);
  }
}

/** The grid's boxes, the chequered line, and the gantry over it with its five lights. */
function buildStart(scene: Scene, circuit: Circuit): StartLights {
  const start = circuit.startLine;
  const heading = Math.atan2(start.tangent.x, start.tangent.z);
  const group = new Group();
  group.position.copy(start.position);
  group.rotation.y = heading;
  scene.add(group);

  const chequerCanvas = document.createElement('canvas');
  chequerCanvas.width = 160;
  chequerCanvas.height = 16;
  const context = chequerCanvas.getContext('2d')!;
  for (let column = 0; column < 40; column++) {
    for (let row = 0; row < 4; row++) {
      context.fillStyle = (column + row) % 2 === 0 ? '#f4f4f4' : '#111111';
      context.fillRect(column * 4, row * 4, 4, 4);
    }
  }
  const line = new Mesh(new PlaneGeometry(start.halfWidth * 2, 1.6), new MeshStandardMaterial({ map: new CanvasTexture(chequerCanvas), roughness: 0.6 }));
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.02;
  group.add(line);
  const paint = new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
  for (let slot = 0; slot < 10; slot++) {
    const box = new Mesh(new PlaneGeometry(2.4, 0.25), paint);
    box.rotation.x = -Math.PI / 2;
    box.position.set(slot % 2 === 0 ? 2.6 : -2.6, 0.021, -12 - slot * 8);
    group.add(box);
  }

  // the gantry: posts either side, a beam over the track, and a row of five lights on it
  const steel = new MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.7, roughness: 0.4 });
  for (const side of [1, -1]) {
    const post = new Mesh(new BoxGeometry(0.5, 7.5, 0.5), steel);
    post.position.set(side * (start.halfWidth + 1.5), 3.75, 6);
    post.castShadow = true;
    group.add(post);
  }
  const beam = new Mesh(new BoxGeometry(start.halfWidth * 2 + 3.5, 1.2, 0.6), steel);
  beam.position.set(0, 7, 6);
  beam.castShadow = true;
  group.add(beam);
  const off = new MeshStandardMaterial({ color: 0x220808, emissive: 0x000000, roughness: 0.3 });
  const on = new MeshStandardMaterial({ color: 0x400808, emissive: 0xff1a1a, emissiveIntensity: 4, roughness: 0.3 });
  const lights: Mesh[] = [];
  for (let light = 0; light < 5; light++) {
    const pod = new Mesh(new BoxGeometry(0.9, 0.9, 0.3), steel);
    pod.position.set((light - 2) * 1.3, 7, 5.6);
    const lens = new Mesh(new CylinderGeometry(0.3, 0.3, 0.05, 20), off);
    lens.rotation.x = Math.PI / 2;
    lens.position.set((light - 2) * 1.3, 7, 5.43);
    lights.push(lens);
    group.add(pod, lens);
  }
  return {
    set(lit) {
      lights.forEach((lens, index) => (lens.material = index < lit ? on : off));
    },
  };
}

/** Grandstands: tiered seating packed with people, roofed, along the straight and at the big corners. */
function buildGrandstands(scene: Scene, circuit: Circuit): void {
  const samples = circuit.samples;
  const start = circuit.startLine;
  const pitSide = Math.sign(circuit.pitLane[Math.floor(circuit.pitLane.length / 2)]!.clone().sub(start.position).dot(start.left)) || 1;
  const concrete = new MeshStandardMaterial({ color: 0x8d949c, roughness: 0.85 });
  const roof = new MeshStandardMaterial({ color: 0xe8eaed, roughness: 0.5, metalness: 0.2, side: DoubleSide });
  const personGeometry = new BoxGeometry(0.45, 0.8, 0.4);
  const personMaterial = new MeshStandardMaterial({ roughness: 0.9 });
  const people: { matrix: Matrix4; colour: Color }[] = [];
  const random = seeded(131);
  const shirt = [0xc8262a, 0xc8262a, 0xf4d03f, 0x1f6fb8, 0xf4f4f4, 0x2a2d33, 0xe86a2c, 0x1fa39a];

  const stand = (sample: TrackSample, sideIndex: 0 | 1, length: number) => {
    const side = sideIndex === 0 ? 1 : -1;
    const back = sample.sides[sideIndex].barrier + 6;
    const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading);
    for (let tier = 0; tier < 8; tier++) {
      const step = new Mesh(new BoxGeometry(1.6, 1 + tier * 0.75, length), concrete);
      step.position.copy(sample.position).addScaledVector(sample.left, side * (back + tier * 1.6));
      step.position.y = (1 + tier * 0.75) / 2;
      step.quaternion.copy(rotation);
      step.castShadow = step.receiveShadow = true;
      scene.add(step);
      for (let seat = 0; seat < length / 0.7; seat++) {
        if (random() < 0.12) continue;
        const along = -length / 2 + seat * 0.7 + (random() - 0.5) * 0.2;
        const spot = sample.position.clone().addScaledVector(sample.left, side * (back + tier * 1.6)).addScaledVector(sample.tangent, along);
        spot.y = 1 + tier * 0.75 + 0.4;
        people.push({ matrix: new Matrix4().compose(spot, rotation, new Vector3(1, 0.8 + random() * 0.4, 1)), colour: new Color(shirt[Math.floor(random() * shirt.length)]!) });
      }
    }
    const cover = new Mesh(new PlaneGeometry(length, 15), roof);
    cover.position.copy(sample.position).addScaledVector(sample.left, side * (back + 6));
    cover.position.y = 1 + 8 * 0.75 + 3;
    cover.quaternion.copy(rotation).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2 + side * 0.12));
    cover.castShadow = true;
    scene.add(cover);
  };
  // across the straight from the pits, and outside the big braking zones
  const facing = pitSide > 0 ? 1 : 0;
  for (let index = 20; index < 260; index += 30) stand(samples[index]!, facing, 58);
  for (const zone of brakingZones(circuit)) {
    const at = samples.indexOf(zone);
    const outside = zone.curvature > 0 ? 1 : 0;
    for (let back = -10; back <= 30; back += 30) stand(samples[(at + back + samples.length) % samples.length]!, outside, 58);
  }
  tiledInstances(scene, personGeometry, personMaterial, people, { cast: false, receive: true });
}

/** The park round the circuit: trees everywhere the track, run-off and pits aren't. */
function buildTrees(scene: Scene, circuit: Circuit): void {
  const random = seeded(173);
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const sample of circuit.samples) {
    bounds.minX = Math.min(bounds.minX, sample.position.x);
    bounds.maxX = Math.max(bounds.maxX, sample.position.x);
    bounds.minZ = Math.min(bounds.minZ, sample.position.z);
    bounds.maxZ = Math.max(bounds.maxZ, sample.position.z);
  }
  const margin = 450;
  const spots: { position: Vector3; height: number; tint: number }[] = [];
  const point = new Vector3();
  for (let attempt = 0; attempt < 26_000 && spots.length < 7000; attempt++) {
    point.set(bounds.minX - margin + random() * (bounds.maxX - bounds.minX + 2 * margin), 0, bounds.minZ - margin + random() * (bounds.maxZ - bounds.minZ + 2 * margin));
    // anywhere more than a couple of cells from the track is clear of it
    const where = circuit.locateWithin(point, 2);
    if (where && Math.abs(where.across) < where.sample.sides[where.across > 0 ? 0 : 1].barrier + 9) continue;
    if (circuit.nearPitLane(point, 60)) continue;
    // in clumps, as a park's trees stand
    if (Math.sin(point.x / 37) * Math.cos(point.z / 53) > 0.35 && random() < 0.7) continue;
    spots.push({ position: point.clone(), height: 9 + random() * 10, tint: random() });
  }
  const greens = [new Color(0x2f5a2a), new Color(0x3b6b2e), new Color(0x46783a), new Color(0x2a4f2f)];
  const rotation = new Quaternion();
  const trunks = spots.map((spot) => {
    const trunkHeight = spot.height * 0.4;
    return { matrix: new Matrix4().compose(new Vector3(spot.position.x, trunkHeight / 2, spot.position.z), rotation.identity(), new Vector3(1, trunkHeight, 1)) };
  });
  const crowns = spots.map((spot) => {
    const trunkHeight = spot.height * 0.4;
    const crownSize = spot.height * 0.32;
    rotation.setFromAxisAngle(new Vector3(0, 1, 0), spot.tint * Math.PI * 2);
    return {
      matrix: new Matrix4().compose(new Vector3(spot.position.x, trunkHeight + crownSize * 0.8, spot.position.z), rotation, new Vector3(crownSize, crownSize * 1.25, crownSize)),
      colour: greens[Math.floor(spot.tint * greens.length)]!.clone().multiplyScalar(0.85 + spot.tint * 0.3),
    };
  });
  // low-poly crowns, faceted, and trunks open at the ends, which no one sees
  tiledInstances(scene, new CylinderGeometry(0.25, 0.4, 1, 5, 1, true), new MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 }), trunks, { cast: true, receive: false });
  tiledInstances(scene, new IcosahedronGeometry(1, 0), new MeshStandardMaterial({ roughness: 0.9, flatShading: true }), crowns, { cast: true, receive: true });
}

/** Boards counting down to each big braking zone: 300, 200 and 100 metres out. */
function buildDistanceBoards(scene: Scene, circuit: Circuit, material: (text: string) => Material): void {
  const samples = circuit.samples;
  for (const zone of brakingZones(circuit)) {
    const at = samples.indexOf(zone);
    const outside = zone.curvature > 0 ? 1 : 0;
    const side = outside === 0 ? 1 : -1;
    for (const metres of [100, 200, 300]) {
      const sample = samples[(at - metres / 2 + samples.length) % samples.length]!;
      const board = new Mesh(new BoxGeometry(1.8, 1.3, 0.12), material(String(metres)));
      board.position.copy(sample.position).addScaledVector(sample.left, side * (sample.halfWidth + 2.6));
      board.position.y = 1.2;
      board.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z) + Math.PI;
      board.castShadow = true;
      scene.add(board);
    }
  }
}

function numberBoardMaterial(text: string): Material {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 128, 96);
  context.fillStyle = '#111111';
  context.font = 'bold 56px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 64, 50);
  return new MeshStandardMaterial({ map: new CanvasTexture(canvas), roughness: 0.6 });
}

/** Draws the whole circuit into the scene (its bodies are `addCircuitBodies`'); returns the start lights. */
export function buildCircuit(scene: Scene, circuit: Circuit): StartLights {
  buildGround(scene);
  buildSurface(scene, circuit);
  buildSkidMarks(scene, circuit);
  buildBarriers(scene, circuit);
  buildPits(scene, circuit);
  buildGrandstands(scene, circuit);
  buildTrees(scene, circuit);
  buildDistanceBoards(scene, circuit, numberBoardMaterial);
  return buildStart(scene, circuit);
}
