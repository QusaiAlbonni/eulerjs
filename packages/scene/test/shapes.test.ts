import { BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry, PlaneGeometry, SphereGeometry, TorusKnotGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import { primitiveShape } from '@eulerjs/scene';

const unscaled = new Vector3(1, 1, 1);

describe('primitiveShape', () => {
  it("knows three.js's own geometries as the shapes they are", () => {
    expect(primitiveShape(new BoxGeometry(1, 2, 3), unscaled)).toBe('box');
    expect(primitiveShape(new RoundedBoxGeometry(1, 2, 3, 2, 0.2), unscaled)).toBe('convex');
    expect(primitiveShape(new SphereGeometry(0.5), unscaled)).toBe('sphere');
    expect(primitiveShape(new IcosahedronGeometry(0.5, 4), unscaled)).toBe('sphere');
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2), unscaled)).toBe('cylinder');
    expect(primitiveShape(new ConeGeometry(0.5, 2), unscaled)).toBe('cone');
    expect(primitiveShape(new CylinderGeometry(0, 0.5, 2), unscaled)).toBe('cone');
    expect(primitiveShape(new CapsuleGeometry(0.3, 1, 8, 32), unscaled)).toBe('capsule');
  });

  it('knows a sphere turned as a sphere still', () => {
    expect(primitiveShape(new SphereGeometry(0.5).rotateX(0.7), unscaled)).toBe('sphere');
  });

  it('has no round shape for a round geometry of too few sides, whose faces the shape would stick out past', () => {
    expect(primitiveShape(new SphereGeometry(0.5, 16, 8), unscaled)).toBeUndefined();
    expect(primitiveShape(new IcosahedronGeometry(0.5), unscaled)).toBeUndefined();
    expect(primitiveShape(new CylinderGeometry(0.5, 0.5, 1, 8), unscaled)).toBeUndefined();
    expect(primitiveShape(new ConeGeometry(0.5, 1, 8), unscaled)).toBeUndefined();
    // three.js's default capsule has 8 sides
    expect(primitiveShape(new CapsuleGeometry(0.3, 1), unscaled)).toBeUndefined();
  });

  it('gives up on one moved, turned or cut since three.js made it, or too few-sided to be round', () => {
    expect(primitiveShape(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), unscaled)).toBeUndefined();
    expect(primitiveShape(new BoxGeometry(1, 2, 3).rotateY(0.3), unscaled)).toBeUndefined();
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2).rotateX(Math.PI / 2), unscaled)).toBeUndefined();
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2, 5), unscaled)).toBeUndefined();
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2, 32, 1, false, 0, Math.PI), unscaled)).toBeUndefined();
    expect(primitiveShape(new SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), unscaled)).toBeUndefined();
    expect(primitiveShape(new SphereGeometry(0.5).translate(1, 0, 0), unscaled)).toBeUndefined();
    // the same bounds as one standing on its base, but its tip down
    expect(primitiveShape(new ConeGeometry(0.5, 2).rotateX(Math.PI), unscaled)).toBeUndefined();
    expect(primitiveShape(new CylinderGeometry(0, 0.5, 2).rotateX(Math.PI), unscaled)).toBeUndefined();
  });

  it('keeps a box a box however it is scaled, but not a round shape stretched out of round', () => {
    expect(primitiveShape(new BoxGeometry(), new Vector3(1, 2, 3))).toBe('box');
    expect(primitiveShape(new SphereGeometry(0.5), new Vector3(2, 1, 1))).toBeUndefined();
    expect(primitiveShape(new SphereGeometry(0.5), new Vector3(2, 2, 2))).toBe('sphere');
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2), new Vector3(1, 3, 1))).toBe('cylinder');
    expect(primitiveShape(new CylinderGeometry(0.4, 0.4, 2), new Vector3(1, 1, 2))).toBeUndefined();
    // stretched along its length, its caps are no longer half spheres
    expect(primitiveShape(new CapsuleGeometry(0.3, 1, 8, 32), new Vector3(1, 2, 1))).toBeUndefined();
  });

  it('has no shape for a tapered cylinder or anything else', () => {
    expect(primitiveShape(new CylinderGeometry(0.2, 0.5, 2), unscaled)).toBeUndefined();
    expect(primitiveShape(new PlaneGeometry(1, 1), unscaled)).toBeUndefined();
    expect(primitiveShape(new TorusKnotGeometry(), unscaled)).toBeUndefined();
  });
});
