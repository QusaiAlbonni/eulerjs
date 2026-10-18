import { BoxGeometry, Group, IcosahedronGeometry, Quaternion, SphereGeometry, Vector3 } from 'three';
import { BoxCollider, CylinderCollider } from 'eulerjs';
import type { Body } from 'eulerjs';
import { materials, pastel } from './materials.js';
import { addInstancedProps, addProp, cylinderAt, merged, mergedInGroups, shaded } from './props.js';
import type { Venue } from './props.js';

/** What stands on the tables: small, light and easily knocked flying. */

const UP = new Vector3(0, 1, 0);

export const PLATE = { radius: 0.13, height: 0.02 };
const plateGeometry = cylinderAt(PLATE.radius, PLATE.height, new Vector3(), 28, PLATE.radius * 1.05);

const unturned = new Quaternion();

/** Plates set down on the tables at `spots`, drawn as one InstancedMesh. */
export function addPlates(venue: Venue, spots: readonly Vector3[]): Body[] {
  return addInstancedProps(venue, {
    geometry: plateGeometry,
    material: materials.porcelain,
    placements: spots.map((spot) => ({ position: spot.clone().setY(spot.y + PLATE.height / 2), quaternion: unturned })),
    colliders: () => [new CylinderCollider({ radius: PLATE.radius, height: PLATE.height, friction: 0.4, rollingResistance: 0.02 })],
    mass: 0.5,
  });
}

/**
 * A champagne flute 20 cm tall, its middle at its origin: a bowl widening up from the middle, on
 * a stem standing on a round foot. It collides as the cylinder round it.
 */
export const GLASS = { radius: 0.035, height: 0.2 };
const glassGeometry = merged(
  cylinderAt(GLASS.radius * 0.6, 0.1, new Vector3(0, 0.05, 0), 14, GLASS.radius),
  cylinderAt(0.004, 0.09, new Vector3(0, -0.045, 0), 6),
  cylinderAt(GLASS.radius * 0.9, 0.01, new Vector3(0, -GLASS.height / 2 + 0.005, 0), 14),
);
const champagneGeometry = cylinderAt(GLASS.radius * 0.62, 0.06, new Vector3(0, 0.04, 0), 12, GLASS.radius * 0.85);

const glassColliders = () => [new CylinderCollider({ radius: GLASS.radius, height: GLASS.height, friction: 0.5, rollingResistance: 0.02 })];

/** Empty flutes set down at `spots`, drawn as one InstancedMesh. */
export function addGlasses(venue: Venue, spots: readonly Vector3[]): Body[] {
  return addInstancedProps(venue, {
    geometry: glassGeometry,
    material: materials.glass,
    placements: spots.map((spot) => ({ position: spot.clone().setY(spot.y + GLASS.height / 2), quaternion: unturned })),
    colliders: glassColliders,
    mass: 0.18,
  });
}

/** A flute of champagne: the glass and the wine in it, one geometry in two groups, a material each. */
const fullGlassGeometry = mergedInGroups(glassGeometry, champagneGeometry);
const fullGlassMaterials = [materials.glass, materials.champagne];

export const BOTTLE = { radius: 0.04, height: 0.32 };
const bottleGeometry = merged(cylinderAt(BOTTLE.radius, 0.22, new Vector3(0, -0.05, 0), 14), cylinderAt(0.014, 0.1, new Vector3(0, 0.11, 0), 10, 0.012));
const bottleFoil = cylinderAt(0.015, 0.04, new Vector3(0, 0.145, 0), 10);

export function addBottle(venue: Venue, position: Vector3): Body {
  const object = new Group();
  object.add(shaded(bottleGeometry, materials.bottle), shaded(bottleFoil, materials.gold));
  return addProp(venue, {
    object,
    colliders: [new CylinderCollider({ radius: BOTTLE.radius, height: BOTTLE.height, friction: 0.5, rollingResistance: 0.02 })],
    mass: 1.4,
    position: position.clone().setY(position.y + BOTTLE.height / 2),
  });
}

/** A vase of flowers: the vase collides, the flowers above it only show. */
const VASE = { radius: 0.09, height: 0.26 };
const vaseGeometry = cylinderAt(VASE.radius, VASE.height, new Vector3(), 20, VASE.radius * 0.8);
const bloom = new IcosahedronGeometry(0.06, 1);
const stems = cylinderAt(0.006, 0.18, new Vector3(0, VASE.height / 2 + 0.05, 0), 5);

export function addVase(venue: Venue, position: Vector3, colorIndex: number): Body {
  const object = new Group();
  object.add(shaded(vaseGeometry, materials.white), shaded(stems, materials.leaves));
  for (let flower = 0; flower < 7; flower++) {
    const turn = (flower / 7) * Math.PI * 2;
    const blossom = shaded(bloom, pastel(colorIndex + flower));
    blossom.position.set(Math.cos(turn) * 0.07 * (flower % 2), VASE.height / 2 + 0.16 + (flower % 3) * 0.03, Math.sin(turn) * 0.07 * (flower % 2));
    object.add(blossom);
  }
  return addProp(venue, {
    object,
    colliders: [new CylinderCollider({ radius: VASE.radius, height: VASE.height, friction: 0.5, rollingResistance: 0.02 })],
    mass: 1.8,
    position: position.clone().setY(position.y + VASE.height / 2),
  });
}

/** Three tiers of cake, each its own body, stacked on the table: knock it and they come apart. */
const TIERS = [
  { radius: 0.28, height: 0.16, mass: 4 },
  { radius: 0.2, height: 0.14, mass: 2.5 },
  { radius: 0.13, height: 0.12, mass: 1.2 },
];

export function addCake(venue: Venue, position: Vector3): Body[] {
  let base = position.y;
  return TIERS.map((tier, index) => {
    const object = new Group();
    object.add(shaded(cylinderAt(tier.radius, tier.height, new Vector3(), 32), materials.icing));
    // a ribbon round the bottom of the tier, and roses round the top
    object.add(shaded(cylinderAt(tier.radius + 0.004, 0.025, new Vector3(0, -tier.height / 2 + 0.02, 0), 32), materials.ribbon));
    for (let rose = 0; rose < 8; rose++) {
      const turn = (rose / 8) * Math.PI * 2;
      const flower = shaded(new SphereGeometry(0.02, 8, 6), pastel(rose + index));
      flower.position.set(Math.cos(turn) * (tier.radius - 0.02), tier.height / 2, Math.sin(turn) * (tier.radius - 0.02));
      object.add(flower);
    }
    const center = new Vector3(position.x, base + tier.height / 2, position.z);
    base += tier.height;
    return addProp(venue, { object, colliders: [new CylinderCollider({ radius: tier.radius, height: tier.height, friction: 0.8 })], mass: tier.mass, position: center });
  });
}

/**
 * A champagne tower: square tiers of flutes, each tier standing on the rims of the one below,
 * from `levels` by `levels` at the bottom to one at the top.
 */
export function addChampagneTower(venue: Venue, position: Vector3, levels = 4): Body[] {
  const spacing = GLASS.radius * 2 + 0.004;
  const spots: Vector3[] = [];
  for (let level = 0; level < levels; level++) {
    const side = levels - level;
    const first = (-(side - 1) / 2) * spacing;
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        spots.push(new Vector3(position.x + first + column * spacing, position.y + level * GLASS.height + GLASS.height / 2, position.z + first + row * spacing));
      }
    }
  }
  // all alike, so drawn as one InstancedMesh, the champagne in them too
  return addInstancedProps(venue, {
    geometry: fullGlassGeometry,
    material: fullGlassMaterials,
    placements: spots.map((spot) => ({ position: spot, quaternion: unturned })),
    colliders: glassColliders,
    mass: 0.18,
  });
}

/** A present in pastel paper with a ribbon round it. */
export function addGift(venue: Venue, position: Vector3, size: Vector3, colorIndex: number, turn: number): Body {
  const object = new Group();
  object.add(shaded(new BoxGeometry(size.x, size.y, size.z), pastel(colorIndex)));
  object.add(shaded(new BoxGeometry(size.x + 0.004, size.y + 0.004, 0.03), materials.gold), shaded(new BoxGeometry(0.03, size.y + 0.004, size.z + 0.004), materials.gold));
  return addProp(venue, {
    object,
    colliders: [new BoxCollider({ size, friction: 0.6 })],
    mass: Math.max(0.3, size.x * size.y * size.z * 120),
    position: position.clone().setY(position.y + size.y / 2),
    quaternion: new Quaternion().setFromAxisAngle(UP, turn),
  });
}
