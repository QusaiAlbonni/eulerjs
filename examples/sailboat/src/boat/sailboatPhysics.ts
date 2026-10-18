import { Vector3 } from 'three';
import type { BufferGeometry, Object3D, Quaternion } from 'three';
import { Body, ConvexCollider, MassProperties, Voxels } from '@eulerjs/core';
import type { World } from '@eulerjs/core';
import { Buoyancy, camberedSailPolar, Foil, symmetricFoilPolar } from '@eulerjs/marine';
import type { Ocean, WaveSurface, Wind } from '@eulerjs/marine';
import { SAILBOAT_LAYOUT } from './sailboatLayout.js';
import type { SailboatLayout } from './sailboatLayout.js';

export interface SailboatFoils {
  readonly mainsail: Foil;
  readonly jib: Foil;
  readonly keel: Foil;
  readonly rudder: Foil;
}

export interface SailboatPhysics {
  readonly body: Body;
  readonly buoyancy: Buoyancy;
  readonly voxels: Voxels;
  readonly foils: SailboatFoils;
}

export interface SailboatPhysicsOptions {
  world: World;
  ocean: Ocean<WaveSurface>;
  wind: Wind;
  /** The hull's surface in the boat's frame; it doesn't need to be closed. */
  hullGeometry: BufferGeometry;
  /** The three.js object the boat's pose is written to. */
  object?: Object3D;
  /** Where to put the boat horizontally; it is dropped onto the water there. Defaults to the origin. */
  position?: Vector3;
  quaternion?: Quaternion;
  layout?: SailboatLayout;
}

/**
 * The boat as eulerjs sees it: one rigid body floated by its voxelized hull, driven by two sails
 * and held on course by a keel and a rudder. Needs no browser, so tests can sail it.
 */
export function createSailboatPhysics(options: SailboatPhysicsOptions): SailboatPhysics {
  const { world, ocean, wind } = options;
  const layout = options.layout ?? SAILBOAT_LAYOUT;

  // The hull mesh is open at the deck, so its mass properties come from its voxels, plus the ballast.
  const voxels = Voxels.fromGeometry(options.hullGeometry, { cellSize: layout.hullCellSize });
  const massProperties = voxels.massProperties(layout.hullMass).combine(MassProperties.point(layout.ballast.mass, layout.ballast.position));

  const position = options.position?.clone() ?? new Vector3();
  position.y = ocean.surfaceHeight(position.x, position.z, world.time) + layout.originAboveWaterline;
  const body = world.addBody(
    new Body({
      massProperties,
      position,
      quaternion: options.quaternion,
      object: options.object,
      voxels,
      colliders: [hullCollider(options.hullGeometry, layout.hullColliderTop)],
    }),
  );

  // A realistic sail polar; the three-sails table (sailPolar) has too much drag to sail upwind.
  const sailPolar = camberedSailPolar();
  const buoyancy = body.addBehavior(new Buoyancy({ ocean, linearDrag: layout.hullDrag.linear, angularDrag: layout.hullDrag.angular }));
  const foils: SailboatFoils = {
    mainsail: body.addBehavior(
      new Foil({
        medium: wind,
        area: layout.mainsail.area,
        center: layout.mainsail.center,
        pivot: layout.mainsail.pivot,
        spanAxis: layout.mainsail.spanAxis,
        polar: sailPolar,
      }),
    ),
    jib: body.addBehavior(
      new Foil({
        medium: wind,
        area: layout.jib.area,
        center: layout.jib.center,
        pivot: layout.jib.pivot,
        spanAxis: layout.jib.spanAxis,
        polar: sailPolar,
      }),
    ),
    keel: body.addBehavior(
      new Foil({ medium: ocean, area: layout.keel.area, center: layout.keel.center, polar: symmetricFoilPolar({ liftSlope: layout.keel.liftSlope }) }),
    ),
    rudder: body.addBehavior(
      new Foil({
        medium: ocean,
        area: layout.rudder.area,
        center: layout.rudder.center,
        pivot: layout.rudder.pivot,
        polar: symmetricFoilPolar({ liftSlope: layout.rudder.liftSlope }),
      }),
    ),
  };
  return { body, buoyancy, voxels, foils };
}

/** The convex hull of the hull mesh's vertices up to `top`, leaving out the mast. */
function hullCollider(hullGeometry: BufferGeometry, top: number): ConvexCollider {
  const positions = hullGeometry.getAttribute('position');
  const points: Vector3[] = [];
  for (let index = 0; index < positions.count; index++) {
    const point = new Vector3().fromBufferAttribute(positions, index);
    if (point.y <= top) points.push(point);
  }
  // friction of a hull rubbing along rock or wood
  return new ConvexCollider({ points, friction: 0.3 });
}
