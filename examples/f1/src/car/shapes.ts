import { BufferGeometry, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, LatheGeometry, Mesh, Quaternion, Shape, Vector2, Vector3 } from 'three';
import type { Material } from 'three';

// The shapes the car is made of: bodywork lofted through smooth cross-sections, wings of real
// airfoil sections, the tyres' and rims' profiles turned about their axles, and the suspension's
// arms streamlined. Each in the car's frame: x to its left, y up, z forward.

/** A cross-section of a loft: where its centre is along the car and up from the ground, and its size. */
export interface Section {
  z: number;
  y: number;
  width: number;
  height: number;
  /** Across the car, for a part off its centre line. */
  x?: number;
  /** How square its corners are: 2 a plain ellipse, larger squarer. */
  squareness?: number;
  /** The width at its bottom as a share of its width: below 1 an undercut, as a sidepod's. */
  bottomWidth?: number;
}

export interface LoftOptions {
  /** Points round each section, and steps along between two given sections. */
  around?: number;
  between?: number;
  /** How its texture maps: round it and along it, or seen from the side, as a livery is painted. */
  mapping?: 'around' | 'side';
  /** Close its ends: the front and back caps get the second material. */
  caps?: boolean;
}

/** `sections`, front to back or back to front, smoothly between: Catmull-Rom through each number. */
function smoothSections(sections: readonly Section[], between: number): Required<Section>[] {
  const filled = sections.map((section) => ({ x: 0, squareness: 3, bottomWidth: 1, ...section }));
  const keys = ['x', 'y', 'z', 'width', 'height', 'squareness', 'bottomWidth'] as const;
  const result: Required<Section>[] = [];
  for (let index = 0; index < filled.length - 1; index++) {
    const before = filled[Math.max(index - 1, 0)]!;
    const from = filled[index]!;
    const to = filled[index + 1]!;
    const after = filled[Math.min(index + 2, filled.length - 1)]!;
    for (let step = 0; step < between; step++) {
      const share = step / between;
      const section = {} as Required<Section>;
      for (const key of keys) section[key] = catmullRom(before[key], from[key], to[key], after[key], share);
      result.push(section);
    }
  }
  result.push(filled[filled.length - 1]!);
  return result;
}

function catmullRom(before: number, from: number, to: number, after: number, share: number): number {
  const squared = share * share;
  const cubed = squared * share;
  return 0.5 * (2 * from + (to - before) * share + (2 * before - 5 * from + 4 * to - after) * squared + (3 * from - before - 3 * to + after) * cubed);
}

/**
 * A smooth body through `sections`: round each a superellipse, its seam along the bottom where it
 * isn't seen. Two material groups: the sides, and the end caps.
 */
export function loft(sections: readonly Section[], options: LoftOptions = {}): BufferGeometry {
  const around = options.around ?? 48;
  const smooth = smoothSections(sections, options.between ?? 8);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const zs = smooth.map((section) => section.z);
  const zMin = Math.min(...zs);
  const zLength = Math.max(...zs) - zMin || 1;
  const yMin = Math.min(...smooth.map((section) => section.y - section.height / 2));
  const yHeight = Math.max(...smooth.map((section) => section.y + section.height / 2)) - yMin || 1;
  const pointOf = (section: Required<Section>, step: number) => {
    // from the bottom, round by the left
    const angle = -Math.PI / 2 + (2 * Math.PI * step) / around;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const exponent = 2 / section.squareness;
    const undercut = sine < 0 ? 1 + (section.bottomWidth - 1) * -sine : 1;
    const across = section.x + (section.width / 2) * undercut * Math.sign(cosine) * Math.abs(cosine) ** exponent;
    const up = section.y + (section.height / 2) * Math.sign(sine) * Math.abs(sine) ** exponent;
    return [across, up, section.z] as const;
  };
  smooth.forEach((section, row) => {
    for (let step = 0; step <= around; step++) {
      const [across, up, along] = pointOf(section, step);
      positions.push(across, up, along);
      if (options.mapping === 'side') {
        // painted on from either side, reading forward on both
        const share = (along - zMin) / zLength;
        uvs.push(across - section.x >= 0 ? 1 - share : share, (up - yMin) / yHeight);
      } else uvs.push(row / (smooth.length - 1), step / around);
    }
  });
  const ring = around + 1;
  for (let row = 0; row < smooth.length - 1; row++) {
    for (let step = 0; step < around; step++) {
      const first = row * ring + step;
      const next = first + ring;
      indices.push(first, next, first + 1, first + 1, next, next + 1);
    }
  }
  const geometry = new BufferGeometry();
  const sideCount = indices.length;
  if (options.caps ?? true) {
    for (const row of [0, smooth.length - 1]) {
      const section = smooth[row]!;
      const centre = positions.length / 3;
      positions.push(section.x, section.y, section.z);
      uvs.push(0.5, 0.5);
      const start = positions.length / 3;
      for (let step = 0; step <= around; step++) {
        positions.push(...pointOf(section, step));
        uvs.push(0.5, 0.5);
      }
      // facing out of each end
      const forward = row === 0 ? smooth[0]!.z > smooth[smooth.length - 1]!.z : smooth[row]!.z > smooth[0]!.z;
      for (let step = 0; step < around; step++) {
        if (forward) indices.push(centre, start + step, start + step + 1);
        else indices.push(centre, start + step + 1, start + step);
      }
    }
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.addGroup(0, sideCount, 0);
  if (indices.length > sideCount) geometry.addGroup(sideCount, indices.length - sideCount, 1);
  // the sides wound the right way round whichever way the sections run
  if (smooth[0]!.z < smooth[smooth.length - 1]!.z) flipSides(geometry, sideCount);
  geometry.computeVertexNormals();
  return geometry;
}

function flipSides(geometry: BufferGeometry, count: number): void {
  const index = geometry.getIndex()!;
  for (let triangle = 0; triangle < count; triangle += 3) {
    const second = index.getX(triangle + 1);
    index.setX(triangle + 1, index.getX(triangle + 2));
    index.setX(triangle + 2, second);
  }
}

/** A NACA four-digit airfoil's outline, its chord along −z from its leading edge at 0: `camber` and `thickness` as shares of the chord. */
function airfoilShape(chord: number, thickness: number, camber: number, points = 40): Shape {
  const camberAt = 0.4;
  const upper: Vector2[] = [];
  const lower: Vector2[] = [];
  for (let step = 0; step <= points; step++) {
    // bunched toward the leading edge, where it curves most
    const along = (1 - Math.cos((Math.PI * step) / points)) / 2;
    const half = 5 * thickness * (0.2969 * Math.sqrt(along) - 0.126 * along - 0.3516 * along ** 2 + 0.2843 * along ** 3 - 0.1036 * along ** 4);
    const meanLine = along < camberAt ? (camber / camberAt ** 2) * (2 * camberAt * along - along ** 2) : (camber / (1 - camberAt) ** 2) * (1 - 2 * camberAt + 2 * camberAt * along - along ** 2);
    upper.push(new Vector2(-along * chord, (meanLine + half) * chord));
    lower.push(new Vector2(-along * chord, (meanLine - half) * chord));
  }
  return new Shape([...upper, ...lower.reverse().slice(1, -1)]);
}

/**
 * A wing element spanning `span` across the car, of an airfoil `chord` long, its leading edge at
 * the origin, pitched nose-down by `pitch` radians. Cambered for downforce: upside down.
 */
export function wing(span: number, chord: number, thickness = 0.12, camber = 0.06, pitch = 0): BufferGeometry {
  const geometry = new ExtrudeGeometry(airfoilShape(chord, thickness, -camber), { depth: span, bevelEnabled: false, curveSegments: 1 });
  // drawn with its chord along −x and extruded along z: turned so that its chord runs back along
  // −z and its span across x, centred, then its trailing edge pitched up by `pitch`
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(span / 2, 0, 0);
  geometry.rotateX(pitch);
  geometry.computeVertexNormals();
  return geometry;
}

/** A plate in the y–z plane, `thickness` across, its outline `points` given as (z, y), the edges rounded off. */
export function plate(points: readonly (readonly [number, number])[], thickness: number): BufferGeometry {
  const shape = new Shape(points.map(([along, up]) => new Vector2(along, up)));
  const bevel = thickness * 0.4;
  const geometry = new ExtrudeGeometry(shape, { depth: thickness - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 12 });
  geometry.translate(0, 0, -(thickness - 2 * bevel) / 2);
  geometry.rotateY(-Math.PI / 2);
  return geometry;
}

/** A tyre's tread, its shoulders rounded by `shoulder`, turned about the x axis: `width` across, `radius` out. */
export function treadGeometry(radius: number, width: number, shoulder: number, segments = 96): BufferGeometry {
  const profile: Vector2[] = [];
  const half = width / 2;
  // radius out against position along the axle: round the near shoulder from the sidewall to the
  // tread, across the tread, and round the far shoulder back down
  for (let step = 0; step <= 8; step++) {
    const angle = -Math.PI / 2 + (step / 8) * (Math.PI / 2);
    profile.push(new Vector2(radius - shoulder + shoulder * Math.cos(angle), -half + shoulder + shoulder * Math.sin(angle)));
  }
  for (let step = 0; step <= 8; step++) {
    const angle = (step / 8) * (Math.PI / 2);
    profile.push(new Vector2(radius - shoulder + shoulder * Math.cos(angle), half - shoulder + shoulder * Math.sin(angle)));
  }
  const geometry = new LatheGeometry(profile, segments);
  // turned about y: lay its axis along x
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

/** A rim's barrel and lip, turned about the x axis. */
export function rimGeometry(radius: number, width: number, segments = 64): BufferGeometry {
  const half = width / 2;
  const profile = [
    new Vector2(radius * 0.92, -half),
    new Vector2(radius, -half * 0.96),
    new Vector2(radius * 0.97, -half * 0.8),
    new Vector2(radius * 0.86, -half * 0.6),
    new Vector2(radius * 0.86, half * 0.6),
    new Vector2(radius * 0.97, half * 0.8),
    new Vector2(radius, half * 0.96),
    new Vector2(radius * 0.92, half),
  ];
  const geometry = new LatheGeometry(profile, segments);
  geometry.rotateZ(Math.PI / 2);
  return geometry;
}

const UP = new Vector3(0, 1, 0);

/** A streamlined arm from `from` to `to`, its section an ellipse `thickness` deep and `chord` wide, the chord lying along the car. */
export function arm(from: Vector3, to: Vector3, chord: number, thickness: number, material: Material): Mesh {
  const length = from.distanceTo(to);
  const geometry = new CylinderGeometry(0.5, 0.5, length, 12, 1);
  geometry.scale(thickness, 1, chord);
  const mesh = new Mesh(geometry, material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.copy(new Quaternion().setFromUnitVectors(UP, to.clone().sub(from).normalize()));
  mesh.castShadow = true;
  return mesh;
}
