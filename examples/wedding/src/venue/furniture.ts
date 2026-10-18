import { Group, Quaternion, Vector3 } from 'three';
import { BoxCollider, CylinderCollider } from 'eulerjs';
import type { Body } from 'eulerjs';
import { materials } from './materials.js';
import { addInstancedProps, addProp, boxAt, cylinderAt, merged, shaded } from './props.js';
import type { Placement, Venue } from './props.js';

/** Chairs and tables: the loose furniture, light enough to push, each its colliders' shape. */

const UP = new Vector3(0, 1, 0);

/** A folding wooden chair, seat 45 cm up, its back toward -z in its own frame. */
const SEAT_HEIGHT = 0.45;
const SEAT = new Vector3(0.44, 0.04, 0.42);
const LEG = 0.035;
const BACK = new Vector3(0.44, 0.42, 0.035);

/** The legs reach from the floor to the underside of the seat. */
const legHeight = SEAT_HEIGHT - SEAT.y;
const legCenters = [-1, 1].flatMap((across) => [-1, 1].map((along) => new Vector3(across * (SEAT.x / 2 - LEG / 2), legHeight / 2, along * (SEAT.z / 2 - LEG / 2))));
const seatCenter = new Vector3(0, SEAT_HEIGHT - SEAT.y / 2, 0);
const backCenter = new Vector3(0, SEAT_HEIGHT + BACK.y / 2, -SEAT.z / 2 + BACK.z / 2);

const chairGeometry = merged(
  boxAt(SEAT.x, SEAT.y, SEAT.z, seatCenter),
  boxAt(BACK.x, BACK.y, BACK.z, backCenter),
  ...legCenters.map((center) => boxAt(LEG, legHeight, LEG, center)),
  // the back's posts, up from the back legs
  ...[-1, 1].map((across) => boxAt(LEG, BACK.y, LEG, new Vector3(across * (SEAT.x / 2 - LEG / 2), SEAT_HEIGHT + BACK.y / 2, -SEAT.z / 2 + LEG / 2))),
);

/** Where a chair stands, facing `facing` radians round from +z. */
export function chairPlacement(position: Vector3, facing: number): Placement {
  return { position, quaternion: new Quaternion().setFromAxisAngle(UP, facing) };
}

const chairColliders = () => [
  new BoxCollider({ size: SEAT, offset: seatCenter, friction: 0.5 }),
  new BoxCollider({ size: BACK, offset: backCenter, friction: 0.5 }),
  ...legCenters.map((center) => new BoxCollider({ size: new Vector3(LEG, legHeight, LEG), offset: center, friction: 0.6 })),
];

/** All the chairs, drawn as one InstancedMesh. */
export function addChairs(venue: Venue, placements: readonly Placement[]): Body[] {
  return addInstancedProps(venue, { geometry: chairGeometry, material: materials.white, placements, colliders: chairColliders, mass: 4 });
}

/** A round table for six, 75 cm high, under a white cloth that falls a little way over its edge. */
export const ROUND_TABLE = { radius: 0.85, height: 0.75 };
const TOP_THICKNESS = 0.04;
const topCenter = new Vector3(0, ROUND_TABLE.height - TOP_THICKNESS / 2, 0);
const stemCenter = new Vector3(0, ROUND_TABLE.height / 2, 0);
const footCenter = new Vector3(0, 0.02, 0);

const tableCloth = merged(cylinderAt(ROUND_TABLE.radius + 0.02, TOP_THICKNESS + 0.002, topCenter, 40), cylinderAt(ROUND_TABLE.radius + 0.03, 0.14, topCenter.clone().setY(topCenter.y - 0.08), 40, ROUND_TABLE.radius + 0.02));
const tableFrame = merged(cylinderAt(0.05, ROUND_TABLE.height - TOP_THICKNESS, stemCenter, 12), cylinderAt(0.38, 0.04, footCenter, 24));

export function addRoundTable(venue: Venue, position: Vector3): Body {
  const object = new Group();
  object.add(shaded(tableCloth, materials.cloth), shaded(tableFrame, materials.darkWood));
  const colliders = [
    new CylinderCollider({ radius: ROUND_TABLE.radius, height: TOP_THICKNESS, offset: topCenter, friction: 0.6 }),
    new CylinderCollider({ radius: 0.05, height: ROUND_TABLE.height - TOP_THICKNESS, offset: stemCenter }),
    new CylinderCollider({ radius: 0.38, height: 0.04, offset: footCenter, friction: 0.7 }),
  ];
  return addProp(venue, { object, colliders, mass: 30, position });
}

/** A long side table, 75 cm high: the cake, the champagne and the presents stand on these. */
export const SIDE_TABLE = { size: new Vector3(2.2, 0.75, 0.9) };
const sideTop = new Vector3(0, SIDE_TABLE.size.y - TOP_THICKNESS / 2, 0);
const sideLegCenters = [-1, 1].flatMap((across) => [-1, 1].map((along) => new Vector3(across * (SIDE_TABLE.size.x / 2 - 0.08), (SIDE_TABLE.size.y - TOP_THICKNESS) / 2, along * (SIDE_TABLE.size.z / 2 - 0.08))));
const sideLegHeight = SIDE_TABLE.size.y - TOP_THICKNESS;
const sideCloth = merged(boxAt(SIDE_TABLE.size.x + 0.04, TOP_THICKNESS + 0.002, SIDE_TABLE.size.z + 0.04, sideTop), boxAt(SIDE_TABLE.size.x + 0.06, 0.2, SIDE_TABLE.size.z + 0.06, sideTop.clone().setY(sideTop.y - 0.11)));
const sideLegs = merged(...sideLegCenters.map((center) => boxAt(0.06, sideLegHeight, 0.06, center)));

export function addSideTable(venue: Venue, position: Vector3, facing = 0): Body {
  const object = new Group();
  object.add(shaded(sideCloth, materials.cloth), shaded(sideLegs, materials.darkWood));
  const colliders = [
    new BoxCollider({ size: new Vector3(SIDE_TABLE.size.x, TOP_THICKNESS, SIDE_TABLE.size.z), offset: sideTop, friction: 0.6 }),
    ...sideLegCenters.map((center) => new BoxCollider({ size: new Vector3(0.06, sideLegHeight, 0.06), offset: center, friction: 0.7 })),
  ];
  return addProp(venue, { object, colliders, mass: 25, position, quaternion: new Quaternion().setFromAxisAngle(UP, facing) });
}
