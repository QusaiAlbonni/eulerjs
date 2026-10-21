import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { LIVERIES } from '../src/car/livery.js';

// Ten players on the track at once, each told apart from the rest by colour and by number.

describe('the liveries', () => {
  it('give each of ten players a number and a main colour of their own', () => {
    expect(LIVERIES).toHaveLength(10);
    expect(new Set(LIVERIES.map((livery) => livery.number)).size).toBe(10);
    expect(new Set(LIVERIES.map((livery) => new Color(livery.main).getHexString())).size).toBe(10);
    for (const livery of LIVERIES) expect(livery.number).toMatch(/^\d{1,2}$/);
  });

  it('letter the names in a colour that stands out from the second colour they sit on', () => {
    for (const livery of LIVERIES) {
      const lettering = new Color(livery.lettering);
      const second = new Color(livery.second);
      const difference = Math.abs(lettering.r - second.r) + Math.abs(lettering.g - second.g) + Math.abs(lettering.b - second.b);
      expect(difference, `${livery.number}: lettering on its second colour`).toBeGreaterThan(0.6);
    }
  });
});
