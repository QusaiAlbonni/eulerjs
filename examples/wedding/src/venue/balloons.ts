import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { BoxCollider, DistanceJoint, SphereCollider } from '@eulerjs/core';
import type { Body } from '@eulerjs/core';
import { materials, pastel } from './materials.js';
import { addProp, shaded } from './props.js';
import type { Venue } from './props.js';

/** Helium balloons, each on a string tied to a little weight on the ground. */

const BALLOON_RADIUS = 0.16;
const BALLOON_MASS = 0.008;
/** How much more than its own weight the helium lifts, in kg: a tug of about 0.15 N on the string. */
const SPARE_LIFT = 0.015;
const STRING_LENGTH = 1.8;
const WEIGHT_SIZE = new Vector3(0.12, 0.1, 0.12);

const balloonShape = new SphereGeometry(BALLOON_RADIUS, 18, 14).scale(1, 1.18, 1);
const weightShape = new SphereGeometry(1, 12, 8).scale(WEIGHT_SIZE.x / 2, WEIGHT_SIZE.y / 2, WEIGHT_SIZE.z / 2);

/**
 * The helium's lift less the balloon's weight, as gravity turned round: the air pushes up with
 * the weight of the air the balloon displaces, more than the balloon and its gas weigh. As a
 * gravity scale rather than a force, a balloon hanging still on its string can fall asleep.
 */
const BUOYANT_GRAVITY_SCALE = -SPARE_LIFT / BALLOON_MASS;

export interface Balloon {
  readonly balloon: Body;
  readonly weight: Body;
  readonly string: DistanceJoint;
}

export interface Balloons {
  readonly balloons: readonly Balloon[];
  /** Redraws the strings between the balloons and their weights, once a frame. */
  update(): void;
}

export function addBalloons(venue: Venue, anchors: readonly Vector3[]): Balloons {
  const stringMaterial = new LineBasicMaterial({ color: 0xffffff });
  const strings: { line: Line; positions: BufferAttribute; balloon: Balloon }[] = [];
  const balloons = anchors.map((anchor, index): Balloon => {
    const weight = addProp(venue, {
      object: shaded(weightShape, materials.gold),
      colliders: [new BoxCollider({ size: WEIGHT_SIZE, friction: 0.8 })],
      mass: 0.4,
      position: anchor.clone().setY(anchor.y + WEIGHT_SIZE.y / 2),
    });
    // a little apart, so a bunch tied close together doesn't start inside itself
    const above = anchor.clone().add(new Vector3(Math.sin(index * 2.1) * 0.3, WEIGHT_SIZE.y + STRING_LENGTH * 0.95, Math.cos(index * 2.1) * 0.3));
    const balloon = addProp(venue, { object: shaded(balloonShape, pastel(index)), colliders: [new SphereCollider({ radius: BALLOON_RADIUS, friction: 0.3, restitution: 0.4 })], mass: BALLOON_MASS, position: above });
    balloon.gravityScale = BUOYANT_GRAVITY_SCALE;
    // the air's drag
    balloon.linearDamping = 1.2;
    balloon.angularDamping = 1.5;
    const string = venue.world.addJoint(
      new DistanceJoint({ bodyA: balloon, anchorA: new Vector3(0, -BALLOON_RADIUS * 1.18, 0), bodyB: weight, anchorB: new Vector3(0, WEIGHT_SIZE.y / 2, 0), length: STRING_LENGTH, slack: true }),
    );
    const entry = { balloon, weight, string };
    const positions = new BufferAttribute(new Float32Array(6), 3);
    const line = new Line(new BufferGeometry().setAttribute('position', positions), stringMaterial);
    line.frustumCulled = false;
    venue.scene.add(line);
    strings.push({ line, positions, balloon: entry });
    return entry;
  });
  const end = new Vector3();
  return {
    balloons,
    update(): void {
      for (const { positions, balloon } of strings) {
        const objectA = balloon.balloon.object!;
        const objectB = balloon.weight.object!;
        end.set(0, -BALLOON_RADIUS * 1.18, 0).applyQuaternion(objectA.quaternion).add(objectA.position);
        positions.setXYZ(0, end.x, end.y, end.z);
        end.set(0, WEIGHT_SIZE.y / 2, 0).applyQuaternion(objectB.quaternion).add(objectB.position);
        positions.setXYZ(1, end.x, end.y, end.z);
        positions.needsUpdate = true;
      }
    },
  };
}
