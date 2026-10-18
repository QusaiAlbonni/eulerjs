import { BoxGeometry, Group, Mesh, Object3D, PlaneGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, DEFAULT_DENSITY, InvalidMassError, InvalidMeshError, MassProperties, Voxels, World } from 'eulerjs';
import type { BodyOptions } from 'eulerjs';
import { expectMatrixClose, expectVectorClose } from './helpers.js';

const boxMesh = (width: number, height: number, depth: number) => new Mesh(new BoxGeometry(width, height, depth));

describe('world.addBody(object)', () => {
  it('defaults to the density of water', () => {
    const body = new World().addBody(boxMesh(1, 2, 3));
    expect(DEFAULT_DENSITY).toBe(1000);
    expect(body.mass).toBeCloseTo(6000, 6);
  });

  it('takes a mass or a density, with the inertia of the mesh either way', () => {
    const world = new World();
    const byMass = world.addBody(boxMesh(2, 4, 6), { mass: 48 });
    const byDensity = world.addBody(boxMesh(2, 4, 6), { density: 1 });
    expectMatrixClose(byMass.massProperties!.inertia, MassProperties.box(new Vector3(2, 4, 6), 48).inertia);
    expect(byDensity.mass).toBeCloseTo(48, 9);
  });

  it('starts where the object is, and takes the other body options', () => {
    const parent = new Group();
    parent.position.set(10, 0, 0);
    const mesh = boxMesh(1, 1, 1);
    mesh.position.set(0, 3, 0);
    parent.add(mesh);
    const body = new World().addBody(mesh, { velocity: new Vector3(1, 0, 0), linearDamping: 0.5 });
    expectVectorClose(body.position, new Vector3(10, 3, 0), 1e-12);
    expectVectorClose(body.velocity, new Vector3(1, 0, 0));
    expect(body.linearDamping).toBe(0.5);
    expect(body.object).toBe(mesh);
  });

  it('bakes the object scale into the shape, since bodies have no scale', () => {
    const mesh = boxMesh(1, 1, 1);
    mesh.scale.set(2, 2, 2);
    const body = new World().addBody(mesh);
    expect(body.mass).toBeCloseTo(8000, 6);
    expectMatrixClose(body.massProperties!.inertia, MassProperties.box(new Vector3(2, 2, 2), 8000).inertia, 1e-9);
  });

  it('combines every mesh under a group, in the group frame', () => {
    const group = new Group();
    const left = boxMesh(1, 1, 1);
    left.position.set(-1, 0, 0);
    const right = boxMesh(1, 1, 1);
    right.position.set(1, 0, 0);
    group.add(left, right);
    const body = new World().addBody(group, { mass: 2 });
    expectVectorClose(body.massProperties!.centerOfMass, new Vector3(), 1e-9);
    const expected = MassProperties.box(new Vector3(1, 1, 1), 1, new Vector3(-1, 0, 0)).combine(
      MassProperties.box(new Vector3(1, 1, 1), 1, new Vector3(1, 0, 0)),
    );
    expectMatrixClose(body.massProperties!.inertia, expected.inertia, 1e-6);
  });

  it("points open meshes at shape: 'voxels', which handles them and keeps the cells", () => {
    const openBox = boxMesh(1, 1, 1);
    openBox.geometry.setIndex(Array.from(openBox.geometry.getIndex()!.array).slice(0, 30));
    expect(() => new World().addBody(openBox)).toThrow(InvalidMeshError);
    expect(() => new World().addBody(openBox)).toThrow(/shape: 'voxels'/);

    const body = new World().addBody(openBox, { shape: 'voxels', cellSize: 0.1, density: 500 });
    expect(body.voxels).toBeInstanceOf(Voxels);
    expect(body.voxels!.cellSize).toBe(0.1);
    expect(body.mass).toBeCloseTo(500, 6);
  });

  it('picks a cell size from the shape when none is given', () => {
    const body = new World().addBody(boxMesh(4, 1, 1), { shape: 'voxels' });
    expect(body.voxels!.cellSize).toBeCloseTo(4 / 16, 12);
  });

  it('needs meshes to compute a dynamic body from, but not a static one', () => {
    expect(() => new World().addBody(new Object3D())).toThrow(InvalidMassError);
    const ground = new World().addBody(new Mesh(new PlaneGeometry(10, 10)), { type: 'static' });
    expect(ground.type).toBe('static');
  });

  it('refuses a second body for the same object', () => {
    const world = new World();
    const mesh = boxMesh(1, 1, 1);
    world.addBody(mesh);
    expect(() => world.addBody(mesh)).toThrow(/already has a body/);
  });

  it('accepts explicitly undefined options, for callers with exactOptionalPropertyTypes', () => {
    const options: BodyOptions = { type: 'kinematic', position: undefined, quaternion: undefined, object: undefined };
    expect(() => new Body(options)).not.toThrow();
  });
});

describe('world.bodyOf', () => {
  it('finds the body of an object or of anything inside it', () => {
    const world = new World();
    const group = new Group();
    const child = boxMesh(1, 1, 1);
    group.add(child);
    const body = world.addBody(group);
    expect(world.bodyOf(group)).toBe(body);
    expect(world.bodyOf(child)).toBe(body);
    expect(world.bodyOf(new Object3D())).toBeUndefined();
    world.removeBody(body);
    expect(world.bodyOf(child)).toBeUndefined();
  });
});

describe('world.update and world.renderTime', () => {
  it('steps and syncs objects in one call', () => {
    const world = new World({ gravity: new Vector3(), timestep: 0.5 });
    const mesh = boxMesh(1, 1, 1);
    world.addBody(mesh, { velocity: new Vector3(2, 0, 0) });
    const alpha = world.update(1); // two steps: the body is at x = 2
    expect(alpha).toBeCloseTo(0, 12);
    // drawn alpha = 0 of the way through the last step, i.e. where it began, at world.renderTime
    expectVectorClose(mesh.position, new Vector3(1, 0, 0), 1e-12);
    expect(world.renderTime).toBeCloseTo(0.5, 12);
  });

  it('is the time the synced objects are drawn at', () => {
    const world = new World({ timestep: 0.5 });
    expect(world.renderTime).toBe(0);
    world.step(0.75);
    // one step done (time 0.5), half the next one accumulated: drawn halfway through the first
    expect(world.renderTime).toBeCloseTo(0.25, 12);
  });
});

describe('local-point helpers', () => {
  it('applies a force at a point given in the body frame', () => {
    const turned = () => new Body({ massProperties: MassProperties.box(new Vector3(1, 1, 1), 1), position: new Vector3(5, 0, 0) });
    const local = turned();
    const global = turned();
    local.applyForceAtLocalPoint(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
    global.applyForce(new Vector3(0, 1, 0), new Vector3(6, 0, 0));
    expectVectorClose(local.torque, global.torque, 1e-12);
    expectVectorClose(local.pointToWorld(new Vector3(1, 0, 0)), new Vector3(6, 0, 0), 1e-12);
  });

  it('accepts a density wherever it accepts a mass', () => {
    const voxels = Voxels.fromGeometry(new BoxGeometry(1, 2, 3), { cellSize: 0.5 });
    expect(voxels.massProperties({ density: 10 }).mass).toBeCloseTo(60, 9);
    expect(voxels.massProperties({ mass: 7 }).mass).toBe(7);
    expect(MassProperties.fromCells(voxels.cells, 0.5, { density: 2 }).mass).toBeCloseTo(12, 9);
  });
});
