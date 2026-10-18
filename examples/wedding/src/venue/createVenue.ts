import { Vector3 } from 'three';
import type { Scene } from 'three';
import type { Body, World } from 'eulerjs';
import { addBalloons } from './balloons.js';
import type { Balloons } from './balloons.js';
import { addDecor } from './decor.js';
import { addChairs, addRoundTable, addSideTable, chairPlacement, ROUND_TABLE, SIDE_TABLE } from './furniture.js';
import { CAKE_TABLE, CEREMONY_ROWS, CHAMPAGNE_TABLE, GIFT_TABLE, MARQUEE, SEATS_PER_TABLE, STAGE, TABLE_CENTERS } from './layout.js';
import { addBottle, addCake, addChampagneTower, addGift, addGlasses, addPlates, addVase } from './tableware.js';
import type { Placement } from './props.js';

export interface WeddingVenue {
  /** Everything loose, which can be pushed, knocked over and picked up. */
  readonly props: readonly Body[];
  /** Everything fixed, the ground among it. */
  readonly fixtures: readonly Body[];
  readonly ground: Body;
  readonly chairs: readonly Body[];
  readonly tables: readonly Body[];
  readonly champagneTower: readonly Body[];
  readonly cake: readonly Body[];
  readonly balloons: Balloons;
}

export interface VenueOptions {
  /**
   * Whether everything set down starts asleep, as it would be by the time anyone came in: it all
   * stands exactly where it is put, so there is nothing to wait for, and the first moments
   * needn't simulate a few hundred bodies settling. Defaults to true; the balloons rise to the
   * ends of their strings first either way.
   */
  startAsleep?: boolean | undefined;
}

/** The wedding: a ceremony lawn with an arch and rows of chairs, and a marquee laid for the reception. Needs no browser. */
export function createVenue(world: World, scene: Scene, options: VenueOptions = {}): WeddingVenue {
  const venue = { world, scene };
  const decor = addDecor(venue);
  const props: Body[] = [];
  const keep = <Loose extends Body | Body[]>(loose: Loose): Loose => {
    if (Array.isArray(loose)) props.push(...loose);
    else props.push(loose);
    return loose;
  };

  // the guests' chairs, in rows either side of the aisle facing the arch, and round the tables:
  // all alike, so drawn as one InstancedMesh, as are the plates and the glasses set out
  const chairPlacements: Placement[] = [];
  const { firstRow, rowSpacing, rows, aisleHalfWidth, seatSpacing, seatsPerSide } = CEREMONY_ROWS;
  for (let row = 0; row < rows; row++) {
    for (const side of [-1, 1]) {
      for (let seat = 0; seat < seatsPerSide; seat++) chairPlacements.push(chairPlacement(new Vector3(side * (aisleHalfWidth + 0.3 + seat * seatSpacing), 0, firstRow + row * rowSpacing), 0));
    }
  }
  const plateSpots: Vector3[] = [];
  const glassSpots: Vector3[] = [];
  const tableTop = ROUND_TABLE.height;
  const tables = TABLE_CENTERS.map((center, tableIndex) => {
    const table = keep(addRoundTable(venue, center));
    for (let seat = 0; seat < SEATS_PER_TABLE; seat++) {
      const turn = (seat / SEATS_PER_TABLE) * Math.PI * 2 + tableIndex * 0.3;
      const outward = new Vector3(Math.sin(turn), 0, Math.cos(turn));
      chairPlacements.push(chairPlacement(center.clone().addScaledVector(outward, ROUND_TABLE.radius + 0.35), turn + Math.PI));
      plateSpots.push(center.clone().addScaledVector(outward, 0.62).setY(tableTop));
      const glassTurn = turn + 0.32;
      glassSpots.push(center.clone().add(new Vector3(Math.sin(glassTurn), 0, Math.cos(glassTurn)).multiplyScalar(0.7)).setY(tableTop));
    }
    keep(addVase(venue, center.clone().setY(tableTop), tableIndex));
    keep(addBottle(venue, center.clone().add(new Vector3(0.28, 0, 0.1)).setY(tableTop)));
    return table;
  });
  const chairs = keep(addChairs(venue, chairPlacements));
  keep(addPlates(venue, plateSpots));
  keep(addGlasses(venue, glassSpots));

  // the side tables: the cake, the champagne tower, the presents
  const sideTop = SIDE_TABLE.size.y;
  keep(addSideTable(venue, CAKE_TABLE, Math.PI / 2));
  const cake = keep(addCake(venue, CAKE_TABLE.clone().setY(sideTop)));
  keep(addSideTable(venue, CHAMPAGNE_TABLE, Math.PI / 2));
  const champagneTower = keep(addChampagneTower(venue, CHAMPAGNE_TABLE.clone().setY(sideTop)));
  for (const along of [-0.7, 0.7]) keep(addBottle(venue, CHAMPAGNE_TABLE.clone().add(new Vector3(0.15, 0, along)).setY(sideTop)));
  keep(addSideTable(venue, GIFT_TABLE));
  addPresents(venue, keep);

  // vases of flowers on the pedestals by the arch
  decor.pedestalTops.forEach((top, index) => keep(addVase(venue, top, index + 3)));

  // bunches of balloons by the marquee's door and either side of the stage
  const bunch = (center: Vector3) => [new Vector3(-0.15, 0, 0), new Vector3(0.15, 0, 0), new Vector3(0, 0, 0.16)].map((spread) => center.clone().add(spread));
  const stageFloor = STAGE.center.y + STAGE.size.y / 2;
  const doorway = MARQUEE.center.z + MARQUEE.halfDepth + 0.4;
  const anchors = [
    ...bunch(new Vector3(-2.2, 0, doorway)),
    ...bunch(new Vector3(2.2, 0, doorway)),
    ...bunch(new Vector3(-3, stageFloor, STAGE.center.z - 1.4)),
    ...bunch(new Vector3(3, stageFloor, STAGE.center.z - 1.4)),
  ];
  if (options.startAsleep ?? true) for (const prop of props) prop.sleep();
  const balloons = addBalloons(venue, anchors);
  for (const { balloon, weight } of balloons.balloons) props.push(balloon, weight);

  return { props, fixtures: decor.fixtures, ground: decor.ground, chairs, tables, champagneTower, cake, balloons };
}

/** Presents piled on their table and stacked against it on the grass. */
function addPresents(venue: { world: World; scene: Scene }, keep: (body: Body) => Body): void {
  const sizes = [new Vector3(0.4, 0.3, 0.4), new Vector3(0.3, 0.2, 0.3), new Vector3(0.5, 0.25, 0.35), new Vector3(0.25, 0.25, 0.25), new Vector3(0.35, 0.15, 0.5)];
  const top = SIDE_TABLE.size.y;
  // a row on the table, and smaller ones on top of the first and third of them
  const row = [-0.8, -0.3, 0.2, 0.7];
  row.forEach((across, index) => keep(addGift(venue, GIFT_TABLE.clone().add(new Vector3(across, 0, 0)).setY(top), sizes[index % sizes.length]!, index, index * 0.4)));
  [0, 2].forEach((below, index) => keep(addGift(venue, GIFT_TABLE.clone().add(new Vector3(row[below]!, 0, 0)).setY(top + sizes[below]!.y), sizes[3]!, index + 4, index + 0.3)));
  // and a stack on the grass beside it, the biggest at the bottom
  let height = 0;
  [sizes[2]!, sizes[0]!, sizes[3]!].forEach((size, level) => {
    keep(addGift(venue, GIFT_TABLE.clone().add(new Vector3(1.6, 0, 0.2)).setY(height), size, level + 2, level * 0.3));
    height += size.y;
  });
}
