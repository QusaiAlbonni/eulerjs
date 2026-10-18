/**
 * Level of detail of the water mesh: a square grid of chunks that get coarser away from the
 * centre. Every chunk's vertex count is a multiple of one unit, so moving the whole mesh by
 * `snapStep` lands every vertex back on a position some vertex had before and the triangles
 * don't crawl while the mesh follows the camera target.
 */
export interface WaterLod {
  /** Grid segments across each chunk, indexed [row][column]. */
  readonly counts: readonly (readonly number[])[];
  /** Vertex spacing of the centre chunks, in metres. */
  readonly baseSpacing: number;
  /**
   * The shader grows the spacing continuously as baseSpacing * growth^(distance / chunkSize),
   * which never undershoots any chunk's real spacing; neighbouring chunks therefore agree on
   * which waves exist along their shared edge.
   */
  readonly growth: number;
  /** Distance the mesh moves in when following, in metres. */
  readonly snapStep: number;
}

export interface WaterLodOptions {
  /** Edge length of one chunk, in metres. */
  chunkSize: number;
  /** Chunks along each side of the grid; must be even so the follow target sits on a chunk corner. */
  chunkCount: number;
  /** How much coarser each ring of chunks is than the ring inside it. */
  chunkDropOff: number;
  /** Wanted vertex spacing of the centre chunks, in metres. */
  centerSpacing: number;
}

/** The coarsest chunk gets this many units across, which fixes the size of one unit. */
const UNITS_ACROSS_COARSEST_CHUNK = 2;

export function computeWaterLod(options: WaterLodOptions): WaterLod {
  const { chunkSize, chunkCount, chunkDropOff, centerSpacing } = options;
  if (!Number.isInteger(chunkCount) || chunkCount < 2 || chunkCount % 2 !== 0) {
    throw new RangeError(`chunkCount must be an even integer of at least 2, got ${chunkCount}`);
  }
  const coarseness = chunkCoarseness(chunkCount, chunkDropOff);
  const allCoarseness = coarseness.flat();
  const finest = Math.min(...allCoarseness);
  const coarsest = Math.max(...allCoarseness);

  const unitsAcrossCenter = Math.max(1, Math.round((UNITS_ACROSS_COARSEST_CHUNK * coarsest) / finest));
  const unit = Math.max(1, Math.round(chunkSize / centerSpacing / unitsAcrossCenter));
  const centerSegments = unit * unitsAcrossCenter;
  // Round down, so no chunk ends up finer than its ring calls for.
  const counts = coarseness.map((row) =>
    row.map((chunkFactor) => Math.max(1, Math.floor((centerSegments * finest) / chunkFactor / unit + 1e-9)) * unit),
  );

  const ringSpacings: number[] = [];
  const middle = (chunkCount - 1) / 2;
  counts.forEach((row, rowIndex) =>
    row.forEach((segments, columnIndex) => {
      const ring = Math.floor(Math.max(Math.abs(rowIndex - middle), Math.abs(columnIndex - middle)));
      ringSpacings[ring] = Math.max(ringSpacings[ring] ?? 0, chunkSize / segments);
    }),
  );
  const baseSpacing = ringSpacings[0]!;
  let growth = 1;
  for (let ring = 1; ring < ringSpacings.length; ring++) {
    growth = Math.max(growth, Math.pow(ringSpacings[ring]! / baseSpacing, 1 / ring));
  }
  return { counts, baseSpacing, growth, snapStep: chunkSize / unit };
}

/**
 * Relative coarseness of each chunk: rings of chunks from the border inward, each `dropOff`
 * times finer than the ring around it. Only the ratios matter.
 */
export function chunkCoarseness(chunkCount: number, dropOff: number): number[][] {
  const coarseness = Array.from({ length: chunkCount }, () => new Array<number>(chunkCount).fill(0));
  let ringCount = Math.floor(chunkCount / dropOff);
  if (chunkCount % dropOff === 0) ringCount--;
  for (let ring = 0; ring <= ringCount; ring++) {
    const value = Math.pow(dropOff, ringCount - ring);
    for (let position = ring; position < chunkCount - ring; position++) {
      coarseness[ring]![position] = value;
      coarseness[chunkCount - ring - 1]![position] = value;
      coarseness[position]![ring] = value;
      coarseness[position]![chunkCount - ring - 1] = value;
    }
  }
  return coarseness;
}
