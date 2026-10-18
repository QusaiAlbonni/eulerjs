/**
 * `eulerjs/extend`: for plugins that teach the JavaScript backend new collider shapes, such as
 * `@eulerjs/bvh`'s triangle meshes. A new shape is a `Collider` subclass with its own `shape`
 * name, plus either collision tests against the shapes it meets, or, for a shape made of
 * triangles, a description of which triangles lie where, from which the engine derives its
 * collisions with every convex shape, ray casts, shape casts and overlap tests.
 *
 * @packageDocumentation
 * @module eulerjs/extend
 */
export { collide, registerCollisionTest } from './javascript/collision/narrowphase.js';
export type { CollisionTest, ContactPoint } from './javascript/collision/narrowphase.js';
export { registerTriangleShape } from './javascript/collision/triangleShapes.js';
export type { TriangleShape, TriangleVisitor } from './javascript/collision/triangleShapes.js';
export { ALL_EDGES, isActiveEdge, triangleTestFor } from './javascript/collision/triangle.js';
export type { TriangleTest } from './javascript/collision/triangle.js';
export { rayTriangle, registerRayTest } from './javascript/collision/sweep.js';
export type { RayTest, SweepHit } from './javascript/collision/sweep.js';
