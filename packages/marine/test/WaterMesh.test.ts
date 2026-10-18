import { DataTexture, Object3D, ShaderLib, UniformsUtils } from 'three';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { SumOfSines } from '@eulerjs/marine';
import { WaterMesh } from '../src/three/WaterMesh.js';
import { chunkCoarseness, computeWaterLod } from '../src/three/waterLod.js';

const defaultLodOptions = { chunkSize: 150, chunkCount: 8, chunkDropOff: 1.25, centerSpacing: 150 / 292 };

describe('computeWaterLod', () => {
  it('reproduces the three-sails water mesh level of detail', () => {
    // values the old Water class computed from planeVerts = 550
    const lod = computeWaterLod(defaultLodOptions);
    expect(lod.counts[3]![3]).toBe(292);
    expect(lod.baseSpacing).toBeCloseTo(0.5136986301369864, 12);
    expect(lod.growth).toBeCloseTo(Math.SQRT2, 12);
    expect(lod.snapStep).toBeCloseTo(2.0547945205479454, 12);
    expect(lod.counts[0]).toEqual([146, 146, 146, 146, 146, 146, 146, 146]);
    expect(lod.counts[2]).toEqual([146, 146, 219, 219, 219, 219, 146, 146]);
  });

  it.each([0.3, 150 / 292, 0.8, 1.7])('makes the centre chunks as fine as the physics, for sample spacing %s', (centerSpacing) => {
    const lod = computeWaterLod({ ...defaultLodOptions, centerSpacing });
    expect(Math.abs(lod.baseSpacing / centerSpacing - 1)).toBeLessThan(0.01);
  });

  it('makes every chunk a whole number of snap units, so following never makes the triangles crawl', () => {
    const lod = computeWaterLod(defaultLodOptions);
    const unitSegments = 150 / lod.snapStep;
    expect(unitSegments).toBeCloseTo(Math.round(unitSegments), 9);
    for (const segments of lod.counts.flat()) {
      expect(segments % Math.round(unitSegments)).toBe(0);
    }
  });

  it('grows the shader spacing fast enough never to ask a chunk for finer detail than it has', () => {
    const lod = computeWaterLod(defaultLodOptions);
    const middle = (lod.counts.length - 1) / 2;
    lod.counts.forEach((row, rowIndex) =>
      row.forEach((segments, columnIndex) => {
        const ring = Math.floor(Math.max(Math.abs(rowIndex - middle), Math.abs(columnIndex - middle)));
        // the spacing the shader assumes at the chunk's edge nearest the centre
        const assumedSpacing = lod.baseSpacing * Math.pow(lod.growth, ring);
        expect(assumedSpacing).toBeGreaterThanOrEqual(150 / segments - 1e-12);
      }),
    );
  });

  it('rejects an odd or too small chunk count', () => {
    expect(() => computeWaterLod({ ...defaultLodOptions, chunkCount: 7 })).toThrow(RangeError);
    expect(() => computeWaterLod({ ...defaultLodOptions, chunkCount: 0 })).toThrow(RangeError);
  });

  it('makes the outer rings coarser than the inner ones', () => {
    const coarseness = chunkCoarseness(8, 1.25);
    expect(coarseness[0]![0]).toBeGreaterThan(coarseness[1]![1]!);
    expect(coarseness[1]![1]).toBeGreaterThan(coarseness[3]![3]!);
    expect(coarseness[3]![3]).toBe(coarseness[4]![4]);
  });
});

describe('WaterMesh', () => {
  const waves = new SumOfSines({ sampleSpacing: 1 });
  const smallMesh = (follow?: Object3D) =>
    new WaterMesh(waves, { chunkSize: 20, chunkCount: 2, normalMap: new DataTexture(), ...(follow ? { follow } : {}) });

  it('builds one instance per chunk and hands its level of detail to the shader', () => {
    const water = smallMesh();
    // an instance for each of the 2 × 2 chunks, and room for no more
    for (const instance of [0, 1, 2, 3]) expect(water.getVisibleAt(instance)).toBe(true);
    expect(() => water.addInstance(0)).toThrow();
    expect(water.uniforms.waterBaseSpacing.value).toBe(water.lod.baseSpacing);
    expect(water.uniforms.waterSpacingGrowth.value).toBe(water.lod.growth);
    expect(water.material.defines?.['WAVE_COUNT']).toBe(String(waves.waves.length));
  });

  it('follows its target in snap steps', () => {
    const target = new Object3D();
    target.position.set(10.3, 4, -7.9);
    const water = smallMesh(target);
    water.update(0);
    const step = water.lod.snapStep;
    expect(water.position.x / step).toBeCloseTo(Math.round(water.position.x / step), 9);
    expect(water.position.z / step).toBeCloseTo(Math.round(water.position.z / step), 9);
    expect(Math.abs(water.position.x - 10.3)).toBeLessThanOrEqual(step / 2);
    expect(Math.abs(water.position.z + 7.9)).toBeLessThanOrEqual(step / 2);
    expect(water.position.y).toBe(0);
  });

  it('advances the shader waves to the simulation time it is given', () => {
    const water = smallMesh();
    water.update(12.5);
    expect(water.uniforms.waveTime.value).toBe(waves.phaseTime(12.5));
    expect(water.material.bumpMap!.offset.x).toBeCloseTo(0.125, 12);
  });

  it('splices the wave code into the physical material shader and shares its uniforms', () => {
    const water = smallMesh();
    const shader = {
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
      uniforms: UniformsUtils.clone(ShaderLib.physical.uniforms),
    } as WebGLProgramParametersWithUniforms;
    water.material.onBeforeCompile(shader, {} as WebGLRenderer);
    expect(shader.vertexShader).toContain('sumOfSinesSurface(waterWorldPosition.xz, waterSpacing)');
    expect(shader.vertexShader).not.toContain('#include <begin_vertex>');
    expect(shader.fragmentShader).toContain('waterNormal(vWaveCoord, waterLostSlopeVariance)');
    expect(shader.fragmentShader).toContain('nonPerturbedNormal = normal;');
    expect(shader.uniforms['waveTime']).toBe(water.uniforms.waveTime);
  });
});
