import { Matrix3, Matrix4, Vector3 } from 'three';
import type { Quaternion } from 'three';
import type { BufferGeometry } from 'three';
import { InvalidMassError, InvalidMeshError } from './errors.js';
import { analyzeTopology, forEachTriangle } from './geometry.js';

/** How much a mesh weighs: either its total mass or the density of its material. */
export type MassSpecification = { mass: number } | { density: number };

export interface MeshMassOptions {
  /** Vertices closer than this (in mesh units) count as one point when checking that the mesh is closed. */
  weldTolerance?: number;
  /**
   * Skip the closed-mesh check. For an open mesh the result depends on where the mesh's origin
   * is, so only use this when the holes are tiny compared with the mesh.
   */
  allowOpenMesh?: boolean;
}

/**
 * Mass, centre of mass and inertia tensor of a rigid body, all in the body's own frame. The
 * inertia tensor is taken about the centre of mass.
 */
export class MassProperties {
  readonly mass: number;
  readonly centerOfMass: Vector3;
  readonly inertia: Matrix3;

  constructor(mass: number, centerOfMass: Vector3, inertia: Matrix3) {
    if (!Number.isFinite(mass) || mass <= 0) {
      throw new InvalidMassError(`Mass must be a positive finite number, got ${mass}`);
    }
    if (!centerOfMass.toArray().every(Number.isFinite)) {
      throw new InvalidMassError('Centre of mass is not finite');
    }
    assertValidInertia(inertia);
    this.mass = mass;
    this.centerOfMass = centerOfMass.clone();
    this.inertia = inertia.clone();
  }

  /** A solid box with the given edge lengths. */
  static box(size: Vector3, mass: number, center = new Vector3()): MassProperties {
    const factor = mass / 12;
    const inertia = diagonalMatrix(
      factor * (size.y ** 2 + size.z ** 2),
      factor * (size.x ** 2 + size.z ** 2),
      factor * (size.x ** 2 + size.y ** 2),
    );
    return new MassProperties(mass, center, inertia);
  }

  /** A solid sphere. */
  static sphere(radius: number, mass: number, center = new Vector3()): MassProperties {
    const moment = 0.4 * mass * radius ** 2;
    return new MassProperties(mass, center, diagonalMatrix(moment, moment, moment));
  }

  /**
   * A solid capsule along the y axis: a cylinder `length` long between the centres of the two
   * hemispheres that cap it, both of `radius`.
   */
  static capsule(radius: number, length: number, mass: number, center = new Vector3()): MassProperties {
    const cylinderVolume = Math.PI * radius ** 2 * length;
    const capsVolume = (4 / 3) * Math.PI * radius ** 3;
    const cylinderMass = (mass * cylinderVolume) / (cylinderVolume + capsVolume);
    const capMass = (mass - cylinderMass) / 2;
    const alongAxis = 0.5 * cylinderMass * radius ** 2 + 2 * 0.4 * capMass * radius ** 2;
    // each cap: its own moment about its centre of mass, 3r/8 from its flat face, moved out to the capsule's centre
    const capCenterDistance = length / 2 + (3 * radius) / 8;
    const capAcross = (83 / 320) * capMass * radius ** 2 + capMass * capCenterDistance ** 2;
    const across = (cylinderMass * (3 * radius ** 2 + length ** 2)) / 12 + 2 * capAcross;
    return new MassProperties(mass, center, diagonalMatrix(across, alongAxis, across));
  }

  /** A solid cylinder along the y axis, `height` long, centred on `center`. */
  static cylinder(radius: number, height: number, mass: number, center = new Vector3()): MassProperties {
    const alongAxis = 0.5 * mass * radius ** 2;
    const across = (mass * (3 * radius ** 2 + height ** 2)) / 12;
    return new MassProperties(mass, center, diagonalMatrix(across, alongAxis, across));
  }

  /**
   * A solid cone along the y axis, `height` tall with its tip up, placed as three.js's
   * ConeGeometry is: centred halfway up, so its centre of mass is a quarter of the height below
   * `center`.
   */
  static cone(radius: number, height: number, mass: number, center = new Vector3()): MassProperties {
    const alongAxis = 0.3 * mass * radius ** 2;
    const across = (3 / 20) * mass * radius ** 2 + (3 / 80) * mass * height ** 2;
    return new MassProperties(mass, center.clone().add(new Vector3(0, -height / 4, 0)), diagonalMatrix(across, alongAxis, across));
  }

  /** These mass properties turned by `rotation` and moved by `offset`, as for a collider placed in its body. */
  placed(offset: Vector3, rotation: Quaternion): MassProperties {
    const turn = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(rotation));
    const inertia = turn.clone().multiply(this.inertia).multiply(turn.clone().transpose());
    return new MassProperties(this.mass, this.centerOfMass.clone().applyQuaternion(rotation).add(offset), inertia);
  }

  /** A point mass. On its own it can't rotate a body, so combine it with something that has extent. */
  static point(mass: number, position: Vector3): MassProperties {
    return new MassProperties(mass, position, new Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0));
  }

  /**
   * Exact mass properties of the solid enclosed by a closed triangle mesh, with uniform density.
   * The mesh must be closed and its faces must wind counter-clockwise when seen from outside, as
   * three.js geometry does; otherwise an InvalidMeshError explains what is wrong.
   */
  static fromMesh(geometry: BufferGeometry, specification: MassSpecification, options: MeshMassOptions = {}): MassProperties {
    if (!options.allowOpenMesh) {
      const topology = analyzeTopology(geometry, options.weldTolerance);
      if (!topology.isClosed) {
        throw new InvalidMeshError(
          `Mesh is not closed (${topology.boundaryEdgeCount} boundary edges, ${topology.nonManifoldEdgeCount} non-manifold edges), ` +
            "so its volume and inertia are undefined. Close the holes, or fill it with voxels instead (shape: 'voxels' in world.addBody, or Voxels.fromGeometry).",
        );
      }
    }
    const integrals = integrateVolume(geometry);
    if (integrals.volume <= 0) {
      throw new InvalidMeshError(
        integrals.volume < 0
          ? `Mesh encloses a negative volume (${integrals.volume}): its faces point inward. Reverse the triangle winding.`
          : 'Mesh encloses no volume',
      );
    }
    const density = massFrom(specification, integrals.volume) / integrals.volume;
    return integrals.toMassProperties(density);
  }

  /**
   * Mass properties of a set of equal cubes (e.g. the voxels of a hull), each with edge `cellSize`
   * centred on one of `cellCenters`, from a total mass or a density. Works for meshes that aren't closed.
   */
  static fromCells(cellCenters: readonly Vector3[], cellSize: number, specification: number | MassSpecification): MassProperties {
    if (cellCenters.length === 0) {
      throw new InvalidMassError('Cannot compute mass properties of zero cells');
    }
    const mass = massFrom(specification, cellCenters.length * cellSize ** 3);
    const cellMass = mass / cellCenters.length;
    const centerOfMass = new Vector3();
    for (const center of cellCenters) centerOfMass.add(center);
    centerOfMass.divideScalar(cellCenters.length);

    const ownMomentOfEachCell = (cellMass * cellSize ** 2) / 6;
    const inertia = diagonalMatrix(0, 0, 0);
    const offset = new Vector3();
    for (const center of cellCenters) {
      offset.subVectors(center, centerOfMass);
      addPointMassInertia(inertia, cellMass, offset);
    }
    addToDiagonal(inertia, ownMomentOfEachCell * cellCenters.length);
    return new MassProperties(mass, centerOfMass, inertia);
  }

  /** The same shape with a different total mass; inertia scales in proportion. */
  withMass(mass: number): MassProperties {
    const scaledInertia = this.inertia.clone().multiplyScalar(mass / this.mass);
    return new MassProperties(mass, this.centerOfMass, scaledInertia);
  }

  /** Two rigidly joined parts as one body, e.g. a hull plus its ballast. */
  combine(other: MassProperties): MassProperties {
    const totalMass = this.mass + other.mass;
    const centerOfMass = new Vector3()
      .addScaledVector(this.centerOfMass, this.mass)
      .addScaledVector(other.centerOfMass, other.mass)
      .divideScalar(totalMass);

    const inertia = this.inertia.clone();
    addMatrix(inertia, other.inertia);
    const offset = new Vector3();
    addPointMassInertia(inertia, this.mass, offset.subVectors(this.centerOfMass, centerOfMass));
    addPointMassInertia(inertia, other.mass, offset.subVectors(other.centerOfMass, centerOfMass));
    return new MassProperties(totalMass, centerOfMass, inertia);
  }
}

/** The mass a specification gives a solid of the given volume. */
function massFrom(specification: number | MassSpecification, volume: number): number {
  if (typeof specification === 'number') return specification;
  return 'mass' in specification ? specification.mass : specification.density * volume;
}

/**
 * Volume integrals of the solid a closed mesh encloses, with density 1. Each triangle forms a
 * tetrahedron with the origin, and the signed tetrahedra add up to the solid (divergence
 * theorem); see Tonon, "Explicit exact formulas for the 3-D tetrahedron inertia tensor" (2004).
 */
class VolumeIntegrals {
  volume = 0;
  /** Integral of the position over the volume. */
  readonly firstMoment = new Vector3();
  /** Integrals of x², y², z² over the volume. */
  readonly squares = new Vector3();
  /** Integrals of xy, yz, zx over the volume. */
  productXY = 0;
  productYZ = 0;
  productZX = 0;

  toMassProperties(density: number): MassProperties {
    const mass = density * this.volume;
    const centerOfMass = this.firstMoment.clone().divideScalar(this.volume);
    const { squares } = this;

    const inertia = new Matrix3().set(
      density * (squares.y + squares.z), -density * this.productXY, -density * this.productZX,
      -density * this.productXY, density * (squares.x + squares.z), -density * this.productYZ,
      -density * this.productZX, -density * this.productYZ, density * (squares.x + squares.y),
    );
    // That is the inertia about the origin; the parallel axis theorem moves it to the centre of mass.
    addPointMassInertia(inertia, -mass, centerOfMass);
    return new MassProperties(mass, centerOfMass, inertia);
  }
}

function integrateVolume(geometry: BufferGeometry): VolumeIntegrals {
  const integrals = new VolumeIntegrals();
  const crossProduct = new Vector3();

  forEachTriangle(geometry, (first, second, third) => {
    const tripleProduct = first.dot(crossProduct.crossVectors(second, third));
    integrals.volume += tripleProduct / 6;
    integrals.firstMoment.x += (tripleProduct / 24) * (first.x + second.x + third.x);
    integrals.firstMoment.y += (tripleProduct / 24) * (first.y + second.y + third.y);
    integrals.firstMoment.z += (tripleProduct / 24) * (first.z + second.z + third.z);
    integrals.squares.x += (tripleProduct / 60) * squareSum(first.x, second.x, third.x);
    integrals.squares.y += (tripleProduct / 60) * squareSum(first.y, second.y, third.y);
    integrals.squares.z += (tripleProduct / 60) * squareSum(first.z, second.z, third.z);
    integrals.productXY += (tripleProduct / 120) * productSum(first.x, second.x, third.x, first.y, second.y, third.y);
    integrals.productYZ += (tripleProduct / 120) * productSum(first.y, second.y, third.y, first.z, second.z, third.z);
    integrals.productZX += (tripleProduct / 120) * productSum(first.z, second.z, third.z, first.x, second.x, third.x);
  });
  return integrals;
}

/** a² + b² + c² + ab + bc + ca, for one coordinate of a tetrahedron's three non-origin corners. */
function squareSum(first: number, second: number, third: number): number {
  return first * first + second * second + third * third + first * second + second * third + third * first;
}

/** The mixed-coordinate counterpart of squareSum, for two coordinates u and v of the same corners. */
function productSum(firstU: number, secondU: number, thirdU: number, firstV: number, secondV: number, thirdV: number): number {
  return (
    2 * (firstU * firstV + secondU * secondV + thirdU * thirdV) +
    firstU * secondV + secondU * firstV +
    firstU * thirdV + thirdU * firstV +
    secondU * thirdV + thirdU * secondV
  );
}

/** Adds the inertia of a point mass at `offset` from the reference point: m (|r|² I - r rᵀ). */
function addPointMassInertia(inertia: Matrix3, mass: number, offset: Vector3): void {
  const lengthSquared = offset.lengthSq();
  const elements = inertia.elements; // column-major, symmetric here
  elements[0] += mass * (lengthSquared - offset.x * offset.x);
  elements[4] += mass * (lengthSquared - offset.y * offset.y);
  elements[8] += mass * (lengthSquared - offset.z * offset.z);
  const productXY = -mass * offset.x * offset.y;
  const productYZ = -mass * offset.y * offset.z;
  const productZX = -mass * offset.z * offset.x;
  elements[1] += productXY;
  elements[3] += productXY;
  elements[5] += productYZ;
  elements[7] += productYZ;
  elements[2] += productZX;
  elements[6] += productZX;
}

function diagonalMatrix(xx: number, yy: number, zz: number): Matrix3 {
  return new Matrix3().set(xx, 0, 0, 0, yy, 0, 0, 0, zz);
}

function addToDiagonal(matrix: Matrix3, amount: number): void {
  matrix.elements[0] += amount;
  matrix.elements[4] += amount;
  matrix.elements[8] += amount;
}

function addMatrix(target: Matrix3, addend: Matrix3): void {
  for (let element = 0; element < 9; element++) {
    target.elements[element]! += addend.elements[element]!;
  }
}

function assertValidInertia(inertia: Matrix3): void {
  const elements = inertia.elements;
  if (!elements.every(Number.isFinite)) {
    throw new InvalidMassError('Inertia tensor is not finite');
  }
  const scale = Math.max(...elements.map(Math.abs), Number.MIN_VALUE);
  const asymmetry = Math.max(
    Math.abs(elements[1]! - elements[3]!),
    Math.abs(elements[2]! - elements[6]!),
    Math.abs(elements[5]! - elements[7]!),
  );
  if (asymmetry > 1e-9 * scale) {
    throw new InvalidMassError('Inertia tensor must be symmetric');
  }
  if (elements[0]! < 0 || elements[4]! < 0 || elements[8]! < 0) {
    throw new InvalidMassError('Inertia tensor has a negative moment of inertia');
  }
}
