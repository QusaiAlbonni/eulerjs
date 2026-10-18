import { ConeGeometry, Group, IcosahedronGeometry, Mesh, PlaneGeometry, PointLight, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import { BoxCollider, CylinderCollider, PlaneCollider } from 'eulerjs';
import type { Body } from 'eulerjs';
import { ARCH, DANCE_FLOOR, FOUNTAIN, HEDGES, LAMP_POSTS, MARQUEE, STAGE, TREES } from './layout.js';
import { materials, pastel } from './materials.js';
import { addFixture, boxAt, cylinderAt, merged, shaded } from './props.js';
import type { Venue } from './props.js';

/** Everything fixed in the venue: the ground, the stage, the arch, hedges, trees, the fountain, lamps and the marquee. */

export interface Decor {
  readonly ground: Body;
  readonly fixtures: readonly Body[];
  /** Pedestals by the stage, each topped with a vase: their tops, to stand things on. */
  readonly pedestalTops: readonly Vector3[];
}

export function addDecor(venue: Venue): Decor {
  const fixtures: Body[] = [];
  const fixture = (...parameters: Parameters<typeof addFixture>) => {
    const body = addFixture(...parameters);
    fixtures.push(body);
    return body;
  };

  const lawn = new Mesh(new PlaneGeometry(120, 120).rotateX(-Math.PI / 2), materials.lawn);
  lawn.receiveShadow = true;
  const ground = addFixture(venue, lawn, [new PlaneCollider({ friction: 0.8 })], new Vector3());

  addStage(venue, fixture);
  const pedestalTops = addArch(venue, fixture);
  // the aisle's carpet, only drawn
  const carpet = new Mesh(new PlaneGeometry(1.6, 11).rotateX(-Math.PI / 2), materials.carpet);
  carpet.position.set(0, 0.005, 14.5);
  carpet.receiveShadow = true;
  venue.scene.add(carpet);

  for (const hedge of HEDGES) fixture(venue, shaded(boxAt(hedge.size.x, hedge.size.y, hedge.size.z, new Vector3()), materials.hedge), [new BoxCollider({ size: hedge.size, friction: 0.9 })], hedge.center);
  for (const tree of TREES) addTree(venue, fixture, tree);
  addFountain(venue, fixture);
  for (const post of LAMP_POSTS) addLampPost(venue, fixture, post);
  addMarquee(venue, fixture);
  const floor = DANCE_FLOOR;
  fixture(venue, shaded(boxAt(floor.size.x, floor.size.y, floor.size.z, new Vector3()), materials.danceFloor), [new BoxCollider({ size: floor.size, friction: 0.5 })], floor.center);
  return { ground, fixtures, pedestalTops };
}

type AddFixture = typeof addFixture;

/** The low stage under the arch, with two steps up to it at the front. */
function addStage(venue: Venue, fixture: AddFixture): void {
  const { center, size } = STAGE;
  fixture(venue, shaded(boxAt(size.x, size.y, size.z, new Vector3()), materials.stone), [new BoxCollider({ size, friction: 0.8 })], center);
  const stepHeight = size.y / 2;
  for (const step of [0, 1]) {
    const stepSize = new Vector3(2.4, stepHeight * (step + 1), 0.35);
    const stepCenter = new Vector3(0, stepSize.y / 2, center.z - size.z / 2 - 0.35 * (1.5 - step));
    fixture(venue, shaded(boxAt(stepSize.x, stepSize.y, stepSize.z, new Vector3()), materials.stone), [new BoxCollider({ size: stepSize, friction: 0.8 })], stepCenter);
  }
}

/** The arch on the stage: two columns and a garlanded bow between them, with flower pedestals either side. */
function addArch(venue: Venue, fixture: AddFixture): Vector3[] {
  const floorHeight = STAGE.center.y + STAGE.size.y / 2;
  const columnHeight = 2.6;
  const halfSpan = 1.3;
  for (const side of [-1, 1]) {
    const base = new Vector3(ARCH.x + side * halfSpan, floorHeight + columnHeight / 2, ARCH.z);
    fixture(venue, shaded(cylinderAt(0.12, columnHeight, new Vector3(), 20), materials.white), [new CylinderCollider({ radius: 0.12, height: columnHeight })], base);
  }
  // the bow over the top, a half ring, decked with flowers: drawn, and held up by a beam to collide with
  const bow = new Group();
  const ring = shaded(new TorusGeometry(halfSpan, 0.09, 12, 40, Math.PI), materials.white);
  bow.add(ring);
  for (let flower = 0; flower <= 16; flower++) {
    const turn = (flower / 16) * Math.PI;
    const blossom = shaded(new IcosahedronGeometry(0.12, 1), pastel(flower));
    blossom.position.set(Math.cos(turn) * halfSpan, Math.sin(turn) * halfSpan, 0.05);
    bow.add(blossom);
  }
  const bowCenter = new Vector3(ARCH.x, floorHeight + columnHeight, ARCH.z);
  fixture(venue, bow, [new BoxCollider({ size: new Vector3(2 * halfSpan + 0.24, 0.2, 0.24), offset: new Vector3(0, halfSpan * 0.7, 0) })], bowCenter);

  const pedestalHeight = 1.1;
  return [-1, 1].map((side) => {
    const base = new Vector3(ARCH.x + side * 2.8, floorHeight + pedestalHeight / 2, ARCH.z - 0.8);
    fixture(venue, shaded(merged(cylinderAt(0.16, pedestalHeight, new Vector3(), 16), cylinderAt(0.24, 0.06, new Vector3(0, pedestalHeight / 2 - 0.03, 0), 16)), materials.stone), [new CylinderCollider({ radius: 0.24, height: pedestalHeight })], base);
    return new Vector3(base.x, floorHeight + pedestalHeight, base.z);
  });
}

const crown = new IcosahedronGeometry(1.8, 1);

/** A tree: a trunk to bump into, and a crown overhead. */
function addTree(venue: Venue, fixture: AddFixture, base: Vector3): void {
  const height = 3.2;
  const object = new Group();
  object.add(shaded(cylinderAt(0.22, height, new Vector3(), 10, 0.16), materials.bark));
  const leaves = shaded(crown, materials.leaves);
  leaves.position.y = height / 2 + 1.2;
  object.add(leaves);
  fixture(venue, object, [new CylinderCollider({ radius: 0.22, height, friction: 0.9 })], base.clone().setY(height / 2));
}

/** The fountain between the lawn and the marquee: a wide basin with a bowl on a column in it. */
function addFountain(venue: Venue, fixture: AddFixture): void {
  const basin = { radius: 1.7, height: 0.5 };
  const object = new Group();
  object.add(shaded(cylinderAt(basin.radius, basin.height, new Vector3(), 40), materials.stone));
  const water = shaded(cylinderAt(basin.radius - 0.12, 0.02, new Vector3(0, basin.height / 2 + 0.01, 0), 40), materials.water);
  object.add(water);
  fixture(venue, object, [new CylinderCollider({ radius: basin.radius, height: basin.height, friction: 0.8 })], FOUNTAIN.clone().setY(basin.height / 2));
  const column = { radius: 0.18, height: 1.4 };
  const bowl = new Group();
  bowl.add(shaded(cylinderAt(column.radius, column.height, new Vector3(), 16), materials.stone), shaded(cylinderAt(0.35, 0.18, new Vector3(0, column.height / 2, 0), 24, 0.6), materials.stone));
  fixture(venue, bowl, [new CylinderCollider({ radius: column.radius, height: column.height }), new CylinderCollider({ radius: 0.6, height: 0.18, offset: new Vector3(0, column.height / 2, 0) })], FOUNTAIN.clone().setY(basin.height + column.height / 2));
}

const lampGlobe = new SphereGeometry(0.16, 16, 12);

function addLampPost(venue: Venue, fixture: AddFixture, base: Vector3): void {
  const height = 2.6;
  const object = new Group();
  object.add(shaded(cylinderAt(0.05, height, new Vector3(), 8), materials.darkWood));
  const globe = new Mesh(lampGlobe, materials.bulb);
  globe.position.y = height / 2 + 0.12;
  object.add(globe);
  fixture(venue, object, [new CylinderCollider({ radius: 0.05, height })], base.clone().setY(height / 2));
}

/** The marquee over the reception: poles round its edge, a canvas roof, and lights strung under the eaves. */
function addMarquee(venue: Venue, fixture: AddFixture): void {
  const { center, halfWidth, halfDepth, poleHeight, ridgeHeight } = MARQUEE;
  const poles: Vector3[] = [];
  for (let across = -halfWidth; across <= halfWidth; across += 4) poles.push(new Vector3(center.x + across, 0, center.z - halfDepth), new Vector3(center.x + across, 0, center.z + halfDepth));
  for (let along = -halfDepth + 4; along < halfDepth; along += 4) poles.push(new Vector3(center.x - halfWidth, 0, center.z + along), new Vector3(center.x + halfWidth, 0, center.z + along));
  for (const pole of poles) fixture(venue, shaded(cylinderAt(0.07, poleHeight, new Vector3(), 10), materials.white), [new CylinderCollider({ radius: 0.07, height: poleHeight })], pole.clone().setY(poleHeight / 2));
  // the roof, only drawn: a low pyramid of canvas on the poles, its corners turned onto the
  // diagonals of a unit square and stretched out to the marquee's corners
  const roof = new Mesh(new ConeGeometry(Math.SQRT1_2 * 2, ridgeHeight - poleHeight, 4, 1, true).rotateY(Math.PI / 4), materials.canvas);
  roof.scale.set(halfWidth, 1, halfDepth);
  roof.position.set(center.x, poleHeight + (ridgeHeight - poleHeight) / 2, center.z);
  roof.castShadow = true;
  venue.scene.add(roof);
  // festoon lights along the eaves, and a few lamps that light the tables
  const bulbs: Vector3[] = [];
  for (let across = -halfWidth; across <= halfWidth; across += 0.8) bulbs.push(new Vector3(center.x + across, poleHeight - 0.25, center.z - halfDepth), new Vector3(center.x + across, poleHeight - 0.25, center.z + halfDepth));
  const bulb = new SphereGeometry(0.05, 8, 6);
  for (const spot of bulbs) {
    const light = new Mesh(bulb, materials.bulb);
    light.position.copy(spot);
    venue.scene.add(light);
  }
  for (const across of [-6, 0, 6]) {
    const lamp = new PointLight(0xffd9a0, 6, 12, 1.6);
    lamp.position.set(center.x + across, poleHeight - 0.4, center.z);
    venue.scene.add(lamp);
  }
}
