import { Vector3 } from 'three';

/**
 * Where everything stands, in metres, on a lawn with y up. The ceremony faces the arch to the
 * north (+z); the reception is under a marquee to the south (-z); a fountain stands between them.
 */

/** The arch the couple stand under, and the low stage it stands on. */
export const ARCH = new Vector3(0, 0, 22);
export const STAGE = { center: new Vector3(0, 0.15, 22), size: new Vector3(7, 0.3, 4) };

/** Rows of guests' chairs either side of the aisle, all facing the arch. */
export const CEREMONY_ROWS = { firstRow: 18, rowSpacing: -1.1, rows: 8, aisleHalfWidth: 1.2, seatSpacing: 0.6, seatsPerSide: 4 };

export const FOUNTAIN = new Vector3(0, 0, 4);

/** The marquee's floor: from x -10 to 10 and z -2 to -18. */
export const MARQUEE = { center: new Vector3(0, 0, -10), halfWidth: 10, halfDepth: 8, poleHeight: 3.2, ridgeHeight: 5.5 };

/** The round tables, each laid for six. */
export const TABLE_CENTERS = [-6, 0, 6].flatMap((across) => [-5.5, -14.5].map((along) => new Vector3(across, 0, along)));
export const SEATS_PER_TABLE = 6;

/** The dance floor in the middle of the marquee, between the tables. */
export const DANCE_FLOOR = { center: new Vector3(0, 0.02, -10), size: new Vector3(7, 0.04, 4) };

/** Side tables: the cake, the champagne tower and the presents. */
export const CAKE_TABLE = new Vector3(8, 0, -10);
export const CHAMPAGNE_TABLE = new Vector3(-8, 0, -10);
export const GIFT_TABLE = new Vector3(-8, 0, -16.5);

/** Where the guests' path is lit, either side of it, from the fountain to the marquee. */
export const LAMP_POSTS = [-1, 1].flatMap((side) => [6, 1, -1.5].map((along) => new Vector3(side * 3.2, 0, along)));

export const TREES = [new Vector3(-11, 0, 9), new Vector3(11, 0, 9), new Vector3(-12, 0, 20), new Vector3(12, 0, 20), new Vector3(-14, 0, 2), new Vector3(14, 0, 2)];

/** Hedges round the ceremony lawn: centre and size of each. */
export const HEDGES = [
  { center: new Vector3(-8, 0.6, 15), size: new Vector3(0.8, 1.2, 14) },
  { center: new Vector3(8, 0.6, 15), size: new Vector3(0.8, 1.2, 14) },
  { center: new Vector3(-5, 0.6, 25), size: new Vector3(5.2, 1.2, 0.8) },
  { center: new Vector3(5, 0.6, 25), size: new Vector3(5.2, 1.2, 0.8) },
];

/** Where the player comes in: on the aisle behind the last row, looking down it to the arch. */
export const ENTRANCE = new Vector3(0, 0, 7.5);
