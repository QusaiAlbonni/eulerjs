import { Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { forEachTriangle } from '@eulerjs/core';
import type { ColliderShorthand } from '@eulerjs/core';

/** How far, as a fraction of its size, a geometry may be from the shape its parameters describe. */
const TOLERANCE = 1e-4;
/**
 * How far, as a fraction of its radius, a round geometry's flat faces may fall inside the round
 * shape through its corners for the shape to stand for it: three.js's default sphere, cylinder
 * and cone are within 1.2%. Coarser ones, an 8-sided capsule, an icosahedron, collide as their
 * hull instead, which is exactly what is drawn, where the round shape would stick out past every
 * face, and the object would float.
 */
const ROUNDNESS = 0.02;

const expectedSize = new Vector3();
const size = new Vector3();
const center = new Vector3();
const vertex = new Vector3();
const sample = new Vector3();

/** What three.js keeps of the parameters a geometry was made with. */
type Parameters = Record<string, number | boolean | undefined>;

/** How far a point is inside a shape's surface: negative outside it. */
type DepthInside = (point: Vector3) => number;

/**
 * The primitive collider a geometry is, from three.js's own geometries: a box for `BoxGeometry`,
 * its hull for `RoundedBoxGeometry` (convex, and rounder than a box), a sphere for `SphereGeometry`
 * and `IcosahedronGeometry`, a cylinder, a cone or a capsule for theirs. Only while the geometry
 * is still the shape its parameters say, centred on its origin and standing along y, as three.js
 * made it: one translated, turned or cut since (a half sphere, a slice of a cylinder) isn't, nor
 * is a round one with too few sides to be round (see `ROUNDNESS`), and neither is one that `scale`
 * stretches out of round. Undefined for those and for any other geometry.
 */
export function primitiveShape(geometry: BufferGeometry, scale: Vector3): ColliderShorthand | undefined {
  const parameters = (geometry as BufferGeometry & { parameters?: Parameters }).parameters;
  if (!parameters) return undefined;
  const roundAboutY = near(scale.x, scale.z);
  const roundEveryWay = roundAboutY && near(scale.x, scale.y);
  switch (geometry.type) {
    case 'RoundedBoxGeometry':
      // a box would stick out past its rounded edges and corners; its hull is exactly what is drawn
      return 'convex';
    case 'BoxGeometry':
      return hasSize(geometry, expectedSize.set(number(parameters.width, 1), number(parameters.height, 1), number(parameters.depth, 1))) ? 'box' : undefined;
    case 'SphereGeometry':
    case 'IcosahedronGeometry': {
      const whole = number(parameters.phiLength, 2 * Math.PI) >= 2 * Math.PI - TOLERANCE && number(parameters.thetaStart, 0) <= TOLERANCE && number(parameters.thetaLength, Math.PI) >= Math.PI - TOLERANCE;
      const radius = number(parameters.radius, 1);
      // however it is turned: a sphere is a sphere every way round
      return whole && roundEveryWay && closeTo(geometry, radius, (point) => radius - point.length()) ? 'sphere' : undefined;
    }
    case 'CylinderGeometry': {
      const top = number(parameters.radiusTop, 1);
      const bottom = number(parameters.radiusBottom, 1);
      const height = number(parameters.height, 1);
      if (!roundAboutY || !isWhole(parameters) || !hasSize(geometry, expectedSize.set(2 * bottom, height, 2 * bottom))) return undefined;
      if (top === bottom) return closeTo(geometry, bottom, (point) => Math.min(bottom - Math.hypot(point.x, point.z), height / 2 - Math.abs(point.y))) ? 'cylinder' : undefined;
      return top === 0 && isCone(geometry, bottom, height) ? 'cone' : undefined;
    }
    case 'ConeGeometry': {
      const radius = number(parameters.radius, 1);
      const height = number(parameters.height, 1);
      return roundAboutY && isWhole(parameters) && hasSize(geometry, expectedSize.set(2 * radius, height, 2 * radius)) && isCone(geometry, radius, height) ? 'cone' : undefined;
    }
    case 'CapsuleGeometry': {
      const radius = number(parameters.radius, 1);
      // `height` is the straight part between the caps; three.js called it `length` before r170
      const straight = number(parameters.height ?? parameters.length, 1);
      // stretched along its length, its caps would no longer be half spheres
      if (!roundEveryWay || !hasSize(geometry, expectedSize.set(2 * radius, straight + 2 * radius, 2 * radius))) return undefined;
      return closeTo(geometry, radius, (point) => radius - Math.hypot(point.x, Math.max(0, Math.abs(point.y) - straight / 2), point.z)) ? 'capsule' : undefined;
    }
  }
  return undefined;
}

function number(value: number | boolean | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function near(first: number, second: number): boolean {
  return Math.abs(first - second) <= TOLERANCE * Math.max(Math.abs(first), Math.abs(second));
}

/** Whether a cylinder or cone goes all the way round. */
function isWhole(parameters: Parameters): boolean {
  return number(parameters.thetaLength, 2 * Math.PI) >= 2 * Math.PI - TOLERANCE;
}

/** Whether the geometry's bounds are `expected` across, centred on its origin. */
function hasSize(geometry: BufferGeometry, expected: Vector3): boolean {
  geometry.computeBoundingBox();
  geometry.boundingBox!.getSize(size);
  geometry.boundingBox!.getCenter(center);
  const slack = TOLERANCE * Math.max(expected.x, expected.y, expected.z);
  return Math.abs(size.x - expected.x) <= slack && Math.abs(size.y - expected.y) <= slack && Math.abs(size.z - expected.z) <= slack && center.length() <= slack;
}

/** Whether the geometry is a cone of this radius and height, tip up, round enough: one turned upside down has the same bounds. */
function isCone(geometry: BufferGeometry, radius: number, height: number): boolean {
  const positions = geometry.getAttribute('position');
  const slack = TOLERANCE * height;
  for (let index = 0; index < positions.count; index++) {
    vertex.fromBufferAttribute(positions, index);
    if (vertex.y > height / 2 - slack && Math.hypot(vertex.x, vertex.z) > slack) return false;
  }
  const slantCosine = height / Math.hypot(radius, height);
  return closeTo(geometry, radius, (point) => Math.min(((radius * (height / 2 - point.y)) / height - Math.hypot(point.x, point.z)) * slantCosine, point.y + height / 2));
}

/**
 * Whether the geometry's surface is everywhere within `ROUNDNESS` of `radius` of a shape's: at its
 * vertices, at the middle of its edges and of its triangles, where a flat face falls furthest
 * inside the round shape through its corners.
 */
function closeTo(geometry: BufferGeometry, radius: number, depthInside: DepthInside): boolean {
  const most = ROUNDNESS * radius;
  let close = true;
  let any = false;
  forEachTriangle(geometry, (first, second, third) => {
    any = true;
    if (!close) return;
    for (const corner of [first, second, third]) if (Math.abs(depthInside(corner)) > most) close = false;
    for (const [from, to] of [[first, second], [second, third], [third, first]] as const) {
      if (Math.abs(depthInside(sample.addVectors(from, to).multiplyScalar(0.5))) > most) close = false;
    }
    if (Math.abs(depthInside(sample.addVectors(first, second).add(third).divideScalar(3))) > most) close = false;
  });
  return any && close;
}
