import { BoxGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Raycaster, Scene, SphereGeometry, TorusKnotGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import { BoxCollider, ConvexCollider, CylinderCollider, EulerError, InvalidMeshError, SphereCollider, World } from '@eulerjs/core';
import type { Body } from '@eulerjs/core';
import { MeshCollider } from '@eulerjs/bvh';
import { ScenePhysics } from '@eulerjs/scene';
import type { PhysicsData } from '@eulerjs/scene';

const material = new MeshBasicMaterial();

function mesh(geometry: ConstructorParameters<typeof Mesh>[0], physics?: PhysicsData): Mesh {
  const made = new Mesh(geometry, material);
  if (physics) made.userData.physics = physics;
  return made;
}

function setUp() {
  const world = new World();
  const physics = world.use(new ScenePhysics());
  const scene = new Scene();
  return { world, physics, scene };
}

function run(world: World, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) world.fixedStep();
  world.syncObjects(1);
}

/** A static 20 m box floor whose top is at y = 0, as three.js's examples make theirs. */
function floor(): Mesh {
  const made = mesh(new BoxGeometry(20, 0.5, 20), { mass: 0 });
  made.position.y = -0.25;
  return made;
}

describe('ScenePhysics', () => {
  it("makes a body for every object whose userData.physics is set, and only those, noting it there", () => {
    const { world, physics, scene } = setUp();
    const ground = floor();
    const crate = mesh(new BoxGeometry(1, 1, 1), { mass: 3, restitution: 0.2, friction: 0.7 });
    crate.position.set(0, 2, 0);
    const scenery = mesh(new BoxGeometry(1, 1, 1));
    scene.add(ground, crate, scenery);
    const made = physics.addScene(scene);
    expect(made).toHaveLength(2);
    expect(world.bodyOf(scenery)).toBeUndefined();
    const groundBody = ground.userData.physics.body as Body;
    const crateBody = crate.userData.physics.body as Body;
    expect(groundBody.type).toBe('static');
    expect(crateBody.type).toBe('dynamic');
    expect(crateBody.massProperties!.mass).toBeCloseTo(3, 12);
    // a 1 m cube of 3 kg: m(a² + a²)/12 about each axis
    expect(crateBody.massProperties!.inertia.elements[0]).toBeCloseTo(0.5, 9);
    const collider = crateBody.colliders[0]!;
    expect(collider).toBeInstanceOf(BoxCollider);
    expect(collider.restitution).toBe(0.2);
    expect(collider.friction).toBe(0.7);
    expect(crateBody.position.y).toBe(2);
  });

  it('leaves an object that already has a body alone', () => {
    const { world, physics, scene } = setUp();
    const crate = mesh(new BoxGeometry(1, 1, 1), { mass: 1 });
    scene.add(crate);
    const byHand = world.addBody(crate, { mass: 5, collider: 'box' });
    expect(physics.addScene(scene)).toHaveLength(0);
    expect(world.bodyOf(crate)).toBe(byHand);
  });

  it('collides as the shape a geometry is, else as its hull if it moves and its triangles if it does not', () => {
    const { physics, scene } = setUp();
    const ball = mesh(new SphereGeometry(0.5), { mass: 1 });
    const knot = mesh(new TorusKnotGeometry(1, 0.3), { mass: 1 });
    const sculpture = mesh(new TorusKnotGeometry(1, 0.3), { mass: 0 });
    const forcedBox = mesh(new SphereGeometry(0.5), { mass: 1, collider: 'box' });
    scene.add(ball, knot, sculpture, forcedBox);
    physics.addScene(scene);
    expect((ball.userData.physics.body as Body).colliders[0]).toBeInstanceOf(SphereCollider);
    expect((knot.userData.physics.body as Body).colliders[0]).toBeInstanceOf(ConvexCollider);
    expect((sculpture.userData.physics.body as Body).colliders[0]).toBeInstanceOf(MeshCollider);
    expect((forcedBox.userData.physics.body as Body).colliders[0]).toBeInstanceOf(BoxCollider);
  });

  it('collides as a rounded box where it is drawn, not where a box would stick out past its rounded edges', () => {
    const { world, physics } = setUp();
    const rounded = mesh(new RoundedBoxGeometry(1, 1, 1, 2, 0.25), { mass: 1 });
    physics.addObject(rounded);
    expect((rounded.userData.physics.body as Body).colliders[0]).toBeInstanceOf(ConvexCollider);
    // at an edge, along its diagonal, and at a corner
    for (const from of [new Vector3(2, 2, 0), new Vector3(2, 2, 2), new Vector3(0, 3, 0)]) {
      const direction = from.clone().negate().normalize();
      const drawn = new Raycaster(from, direction).intersectObject(rounded)[0]!;
      expect(world.castRay(from, direction)!.distance).toBeCloseTo(drawn.distance, 3);
    }
  });

  it('fits a scaled mesh at the size it is drawn', () => {
    const { physics, scene } = setUp();
    const ball = mesh(new SphereGeometry(0.5), { mass: 1 });
    ball.scale.setScalar(3);
    const plank = mesh(new BoxGeometry(1, 1, 1), { mass: 1 });
    plank.scale.set(4, 0.2, 1);
    scene.add(ball, plank);
    physics.addScene(scene);
    expect(((ball.userData.physics.body as Body).colliders[0] as SphereCollider).radius).toBeCloseTo(1.5, 6);
    expect(((plank.userData.physics.body as Body).colliders[0] as BoxCollider).halfExtents.toArray()).toEqual([2, 0.1, 0.5].map((side) => expect.closeTo(side, 6)));
  });

  it('starts a mesh nested in moved, turned groups where it is drawn, and keeps drawing it where its body is', () => {
    const { world, physics, scene } = setUp();
    const outer = new Group();
    outer.position.set(5, 3, 0);
    outer.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const inner = new Group();
    inner.position.set(1, 0, 0);
    const crate = mesh(new BoxGeometry(1, 1, 1), { mass: 1 });
    crate.position.set(0, 2, 0);
    scene.add(outer);
    outer.add(inner);
    inner.add(crate);
    scene.add(floor());
    physics.addScene(scene);
    const body = crate.userData.physics.body as Body;
    // (1, 2, 0) in the outer group, turned a quarter about y: (0, 2, -1), then moved by (5, 3, 0)
    expect(body.position.x).toBeCloseTo(5, 9);
    expect(body.position.y).toBeCloseTo(5, 9);
    expect(body.position.z).toBeCloseTo(-1, 9);
    run(world, 3);
    expect(body.position.y).toBeCloseTo(0.5, 2);
    crate.updateWorldMatrix(true, false);
    expect(new Vector3().setFromMatrixPosition(crate.matrixWorld).distanceTo(body.position)).toBeLessThan(1e-9);
  });

  it('makes a group with physics one body over its meshes, but not over a mesh under it with physics of its own', () => {
    const { physics, scene } = setUp();
    const cart = new Group();
    cart.userData.physics = { mass: 10 };
    const bed = mesh(new BoxGeometry(2, 0.2, 1));
    const post = mesh(new BoxGeometry(0.2, 1, 0.2));
    post.position.set(0.9, 0.6, 0);
    const parcel = mesh(new BoxGeometry(0.5, 0.5, 0.5), { mass: 1 });
    parcel.position.set(-0.5, 0.35, 0);
    cart.add(bed, post, parcel);
    scene.add(cart);
    const made = physics.addScene(scene);
    expect(made).toHaveLength(2);
    const cartBody = cart.userData.physics.body as Body;
    expect(cartBody.massProperties!.mass).toBeCloseTo(10, 12);
    const hull = cartBody.colliders[0] as ConvexCollider;
    expect(hull).toBeInstanceOf(ConvexCollider);
    // the hull reaches the post's top, 1.1 m up, but not round the parcel at the far end
    const highest = Math.max(...hull.vertices.map((point) => point.y));
    const leftmost = Math.min(...hull.vertices.map((point) => point.x));
    expect(highest).toBeCloseTo(1.1, 6);
    expect(leftmost).toBeCloseTo(-1, 6);
    expect(parcel.userData.physics.body).not.toBe(cartBody);
  });

  it('makes a body for each instance of an InstancedMesh, where each is drawn and at its scale', () => {
    const { world, physics, scene } = setUp();
    const balls = new InstancedMesh(new SphereGeometry(0.5), material, 3);
    for (let index = 0; index < 3; index++) {
      balls.setMatrixAt(index, new Matrix4().compose(new Vector3(index * 2, 1 + index, 0), new Quaternion(), new Vector3().setScalar(index + 1)));
    }
    balls.userData.physics = { mass: 2 };
    scene.add(balls);
    physics.addScene(scene);
    const bodies = balls.userData.physics.body as Body[];
    expect(bodies).toHaveLength(3);
    bodies.forEach((body, index) => {
      expect(world.bodyOf(balls, index)).toBe(body);
      expect(body.position.x).toBeCloseTo(index * 2, 9);
      expect((body.colliders[0] as SphereCollider).radius).toBeCloseTo((index + 1) / 2, 6);
      expect(body.massProperties!.mass).toBeCloseTo(2, 9);
    });
  });

  it('rests a ball on a floor made of its triangles, and bounces one as bouncy as it is told', () => {
    const { world, physics, scene } = setUp();
    const ground = mesh(new PlaneGeometry(20, 20).rotateX(-Math.PI / 2), { mass: 0 });
    const resting = mesh(new SphereGeometry(0.5), { mass: 1 });
    resting.position.set(-3, 1, 0);
    const bouncy = mesh(new SphereGeometry(0.5), { mass: 1, restitution: 0.8 });
    bouncy.position.set(3, 3.5, 0);
    scene.add(ground, resting, bouncy);
    physics.addScene(scene);
    expect((ground.userData.physics.body as Body).colliders[0]).toBeInstanceOf(MeshCollider);
    const bouncyBody = bouncy.userData.physics.body as Body;
    let highestAfterBounce = 0;
    let bounced = false;
    for (let step = 0; step < 120; step++) {
      world.fixedStep();
      if (bouncyBody.velocity.y > 0) bounced = true;
      if (bounced) highestAfterBounce = Math.max(highestAfterBounce, bouncyBody.position.y);
    }
    run(world, 2);
    expect((resting.userData.physics.body as Body).position.y).toBeCloseTo(0.5, 2);
    // dropped 3 m onto the ground, it comes back up 0.8² as far
    expect((highestAfterBounce - 0.5) / 3).toBeCloseTo(0.64, 1);
  });

  it('weighs a moving mesh that is not closed by its collider, and says when a flat one has no volume to weigh', () => {
    const { physics } = setUp();
    // a tube, open at both ends: no volume of its own, but a cylinder around it
    const tube = physics.addObject(mesh(new CylinderGeometry(0.5, 0.5, 2, 32, 1, true)), { mass: 4 }) as Body;
    expect(tube.colliders[0]).toBeInstanceOf(CylinderCollider);
    // a solid cylinder of 4 kg: m r² / 2 about its axis
    expect(tube.massProperties!.inertia.elements[4]).toBeCloseTo(0.5, 6);
    expect(() => physics.addObject(mesh(new PlaneGeometry(1, 1)), { mass: 1 })).toThrow(InvalidMeshError);
  });

  it('takes an object out of the world and forgets its body', () => {
    const { world, physics, scene } = setUp();
    const crate = mesh(new BoxGeometry(1, 1, 1), { mass: 1 });
    const balls = new InstancedMesh(new SphereGeometry(0.5), material, 2);
    balls.userData.physics = { mass: 1 };
    scene.add(crate, balls);
    physics.addScene(scene);
    expect(world.bodies).toHaveLength(3);
    physics.removeObject(crate);
    physics.removeObject(balls);
    expect(world.bodies).toHaveLength(0);
    expect(crate.userData.physics.body).toBeUndefined();
    expect(balls.userData.physics.body).toBeUndefined();
  });

  it('adds one object as told, keeping what its userData.physics already says', () => {
    const { physics } = setUp();
    const crate = mesh(new BoxGeometry(1, 1, 1), { mass: 1, friction: 0.9 });
    const body = physics.addObject(crate, { mass: 4 }) as Body;
    expect(body.massProperties!.mass).toBeCloseTo(4, 12);
    expect(body.colliders[0]!.friction).toBe(0.9);
    expect(crate.userData.physics).toMatchObject({ mass: 4, friction: 0.9, body });
    const kinematic = physics.addObject(mesh(new TorusKnotGeometry()), { type: 'kinematic' }) as Body;
    expect(kinematic.type).toBe('kinematic');
    expect(kinematic.colliders[0]).toBeInstanceOf(MeshCollider);
  });

  it('says what is wrong: no world yet, nothing to collide as, or triangles for a moving body', () => {
    expect(() => new ScenePhysics().addScene(new Scene())).toThrow(EulerError);
    const { physics } = setUp();
    expect(() => physics.addObject(new Group(), { mass: 1 })).toThrow(InvalidMeshError);
    expect(() => physics.addObject(mesh(new BoxGeometry()), { mass: 1, collider: 'mesh' })).toThrow(InvalidMeshError);
  });
});
