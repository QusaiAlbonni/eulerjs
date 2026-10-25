/**
 * Physics for a three.js scene, read from it: `ScenePhysics` makes the bodies its objects'
 * `userData.physics` asks for, and `EulerPhysics()` is a drop-in for three.js's RapierPhysics,
 * JoltPhysics and AmmoPhysics addons.
 *
 * @packageDocumentation
 * @module @eulerjs/scene
 */
export { ScenePhysics } from './ScenePhysics.js';
export type { PhysicsData } from './ScenePhysics.js';
export { EulerPhysics } from './EulerPhysics.js';
export type { EulerPhysicsAPI, EulerPhysicsOptions } from './EulerPhysics.js';
export { primitiveShape } from './shapes.js';
