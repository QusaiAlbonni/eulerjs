import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, Matrix3, Matrix4, Mesh, Quaternion, TetrahedronGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, BoxCollider, ConvexCollider, InvalidMeshError, MassProperties, PlaneCollider, SphereCollider, World } from 'eulerjs';
import type { ColliderPose } from 'eulerjs';
import { collide } from '../../src/javascript/collision/narrowphase.js';
import type { ContactPoint } from '../../src/javascript/collision/narrowphase.js';

const pose = (position: Vector3, quaternion = new Quaternion()): ColliderPose => ({
  position,
  quaternion,
  rotation: new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion)),
});

const cubeHull = (size = 1) => ConvexCollider.fromGeometry(new BoxGeometry(size, size, size));

function runFor(world: World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
}

describe('ConvexCollider hulls', () => {
  it('merges coplanar triangles: a cube has 8 corners, 6 square faces and 12 edges in 3 directions', () => {
    const hull = cubeHull();
    expect(hull.vertices).toHaveLength(8);
    expect(hull.faces).toHaveLength(6);
    for (const face of hull.faces) expect(face.vertexIndices).toHaveLength(4);
    expect(hull.edges).toHaveLength(12);
    expect(hull.edgeDirections).toHaveLength(3);
  });

  it('keeps only the outside points and points every face outward', () => {
    const points = [...new BoxGeometry(2, 2, 2).toNonIndexed().getAttribute('position').array].reduce<Vector3[]>((list, value, index, all) => {
      if (index % 3 === 0) list.push(new Vector3(value, all[index + 1], all[index + 2]));
      return list;
    }, []);
    points.push(new Vector3(0.1, 0.2, 0.3)); // inside
    const hull = new ConvexCollider({ points });
    expect(hull.vertices).toHaveLength(8);
    for (const face of hull.faces) {
      const faceCenter = face.vertexIndices.reduce((sum, index) => sum.add(hull.vertices[index]!), new Vector3()).divideScalar(face.vertexIndices.length);
      expect(face.normal.dot(faceCenter)).toBeGreaterThan(0);
      expect(face.normal.dot(hull.vertices[face.vertexIndices[0]!]!)).toBeCloseTo(face.offset, 9);
    }
  });

  it('wraps a tetrahedron in 4 triangles', () => {
    const hull = ConvexCollider.fromGeometry(new TetrahedronGeometry(1));
    expect(hull.faces).toHaveLength(4);
    expect(hull.edges).toHaveLength(6);
  });

  it('refuses points that do not span a volume', () => {
    expect(() => new ConvexCollider({ points: [new Vector3(), new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(1, 1, 0)] })).toThrow(InvalidMeshError);
  });

  it('gives exact mass properties, including its offset and rotation in the body', () => {
    const hull = ConvexCollider.fromGeometry(new BoxGeometry(1, 2, 3), {
      offset: new Vector3(0, 1, 0),
      rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
    });
    const properties = hull.massProperties({ mass: 6 });
    expect(properties.centerOfMass.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
    // turned a quarter about y, the 1 m side now lies along z and the 3 m side along x
    const expected = MassProperties.box(new Vector3(3, 2, 1), 6).inertia.elements;
    properties.inertia.elements.forEach((element, index) => expect(element).toBeCloseTo(expected[index]!, 5));
  });

  it("is what collider: 'convex' fits around a mesh", () => {
    const body = new World().addBody(new Mesh(new IcosahedronGeometry(1, 1)), { collider: 'convex' });
    expect(body.colliders[0]).toBeInstanceOf(ConvexCollider);
  });
});

describe('ConvexCollider contacts', () => {
  it('rests a hull face on a plane with one contact per corner', () => {
    const contacts: ContactPoint[] = [];
    collide(cubeHull(), pose(new Vector3(0, 0.45, 0)), new PlaneCollider(), pose(new Vector3()), contacts);
    expect(contacts).toHaveLength(4);
    for (const contact of contacts) expect(contact.depth).toBeCloseTo(0.05, 9);
  });

  it('gives the same face patch as two boxes do', () => {
    const hullContacts: ContactPoint[] = [];
    const boxContacts: ContactPoint[] = [];
    const box = new BoxCollider({ size: new Vector3(1, 1, 1) });
    collide(cubeHull(), pose(new Vector3(0.2, 0.95, 0.1)), cubeHull(), pose(new Vector3()), hullContacts);
    collide(box, pose(new Vector3(0.2, 0.95, 0.1)), box, pose(new Vector3()), boxContacts);
    expect(hullContacts).toHaveLength(4);
    const describe = (contacts: ContactPoint[]) =>
      contacts
        .map((contact) => [...contact.pointA.toArray(), ...contact.pointB.toArray(), ...contact.normal.toArray(), contact.depth].map((value) => value.toFixed(9)).join(','))
        .sort();
    expect(describe(hullContacts)).toEqual(describe(boxContacts));
  });

  it('keeps only the corners of a tilted hull that reach the other, unless the margin lets nearby ones in', () => {
    // the upper cube is tipped about z, so its bottom face touches with one edge and lifts at the other
    const tipped = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.1);
    const lowestCornerHeight = 0.5 * Math.cos(0.1) + 0.5 * Math.sin(0.1);
    const position = new Vector3(0, 0.5 + lowestCornerHeight - 0.02, 0);
    const touching: ContactPoint[] = [];
    collide(cubeHull(), pose(position, tipped), cubeHull(), pose(new Vector3()), touching);
    expect(touching).toHaveLength(2);
    for (const contact of touching) expect(contact.depth).toBeCloseTo(0.02, 6);
    const withMargin: ContactPoint[] = [];
    collide(cubeHull(), pose(position, tipped), cubeHull(), pose(new Vector3()), withMargin, 0.2);
    expect(withMargin).toHaveLength(4);
  });

  it('lets a box stand on a hull and a hull stand on a box', () => {
    const box = new BoxCollider({ size: new Vector3(1, 1, 1) });
    const onHull: ContactPoint[] = [];
    collide(box, pose(new Vector3(0, 0.95, 0)), cubeHull(), pose(new Vector3()), onHull);
    expect(onHull).toHaveLength(4);
    expect(onHull[0]!.normal.y).toBeCloseTo(1, 9);
    const onBox: ContactPoint[] = [];
    collide(cubeHull(), pose(new Vector3(0, 0.95, 0)), box, pose(new Vector3()), onBox);
    expect(onBox).toHaveLength(4);
    expect(onBox[0]!.normal.y).toBeCloseTo(1, 9);
  });

  it('finds the single point where two crossed edges touch', () => {
    const contacts: ContactPoint[] = [];
    const turnedAboutX = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4);
    const turnedAboutZ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    const height = Math.SQRT2 - 0.05;
    collide(cubeHull(), pose(new Vector3(0, height, 0), turnedAboutZ), cubeHull(), pose(new Vector3(), turnedAboutX), contacts);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.depth).toBeCloseTo(0.05, 6);
    // the upper hull must move up to separate
    expect(contacts[0]!.normal.y).toBeCloseTo(1, 6);
    expect(contacts[0]!.pointA.y).toBeLessThan(contacts[0]!.pointB.y);
  });

  it('pushes a sphere out of a hull face, edge or corner, and out from inside', () => {
    const hull = cubeHull(2);
    const nearFace: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(0, 1.3, 0)), hull, pose(new Vector3()), nearFace);
    expect(nearFace[0]!.depth).toBeCloseTo(0.2, 9);
    expect(nearFace[0]!.normal.y).toBeCloseTo(1, 9);
    const nearCorner: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(1.2, 1.2, 1.2)), hull, pose(new Vector3()), nearCorner);
    expect(nearCorner[0]!.depth).toBeCloseTo(0.5 - Math.sqrt(3 * 0.04), 9);
    expect(nearCorner[0]!.pointB.distanceTo(new Vector3(1, 1, 1))).toBeLessThan(1e-9);
    const inside: ContactPoint[] = [];
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(0.9, 0, 0)), hull, pose(new Vector3()), inside);
    expect(inside[0]!.normal.x).toBeCloseTo(1, 9);
    expect(inside[0]!.depth).toBeCloseTo(0.6, 9);
  });

  it('reports nothing for hulls that are apart', () => {
    const contacts: ContactPoint[] = [];
    collide(cubeHull(), pose(new Vector3(3, 0, 0)), cubeHull(), pose(new Vector3()), contacts);
    collide(new SphereCollider({ radius: 0.5 }), pose(new Vector3(0, 3, 0)), cubeHull(), pose(new Vector3()), contacts);
    collide(cubeHull(), pose(new Vector3(0, 3, 0)), new PlaneCollider(), pose(new Vector3()), contacts);
    expect(contacts).toHaveLength(0);
  });
});

describe('ConvexCollider in a world', () => {
  function groundWorld(): World {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider()] }));
    return world;
  }

  it('drops a tetrahedron that comes to rest on a face', () => {
    const world = groundWorld();
    const hull = ConvexCollider.fromGeometry(new TetrahedronGeometry(0.8));
    const body = world.addBody(new Body({ massProperties: hull.massProperties({ density: 500 }), position: new Vector3(0, 2, 0), quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0.3, 0).normalize(), 0.9), colliders: [hull] }));
    runFor(world, 6);
    expect(body.isSleeping).toBe(true);
    // resting on a face: three corners touch the ground
    const lowest = hull.vertices.map((vertex) => body.pointToWorld(vertex).y).sort((first, second) => first - second);
    expect(lowest[2]! - lowest[0]!).toBeLessThan(2e-3);
  });

  it('rolls a many-sided prism down a slope where a box would slide or stick', () => {
    const world = new World();
    const tilt = 0.3;
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.9, rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), tilt) })] }));
    // a 24-sided prism lying with its axis across the slope
    const wheel = ConvexCollider.fromGeometry(new CylinderGeometry(0.5, 0.5, 0.4, 24).rotateX(Math.PI / 2), { friction: 0.9 });
    const up = new Vector3(-Math.sin(tilt), Math.cos(tilt), 0);
    const body = world.addBody(new Body({ massProperties: wheel.massProperties({ density: 500 }), position: up.clone().multiplyScalar(0.52), colliders: [wheel] }));
    runFor(world, 1.5);
    expect(Math.abs(body.angularVelocity.z)).toBeGreaterThan(1);
    expect(body.velocity.x).toBeLessThan(-0.5);
  });

  it('stacks a hull crate on a box crate', () => {
    const world = groundWorld();
    world.addBody(new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 10), position: new Vector3(0, 0.5, 0), colliders: [new BoxCollider({ size: new Vector3(1, 1, 1) })] }));
    const hull = cubeHull();
    const top = world.addBody(new Body({ massProperties: hull.massProperties({ mass: 10 }), position: new Vector3(0, 1.501, 0), colliders: [hull] }));
    runFor(world, 5);
    expect(top.position.y).toBeCloseTo(1.5, 2);
    expect(Math.hypot(top.position.x, top.position.z)).toBeLessThan(1e-3);
  });
});
