import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Body, MassProperties } from '@eulerjs/core';
import { BodyTable } from '../../src/javascript/soft/BodyTable.js';
import { SolverBody } from '../../src/javascript/SolverBody.js';

describe('the soft-step body table', () => {
  it('gives the effective inverse mass of a point as the velocity change an impulse there makes', () => {
    const body = new Body({
      massProperties: MassProperties.box(new Vector3(1, 0.4, 2), 3),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7),
      canSleep: false,
    });
    const table = new BodyTable();
    table.load([new SolverBody(body)]);
    const arm = new Vector3(0.3, -0.5, 0.8);
    const tensor = new Float64Array(6);
    table.addPointInverseMass(0, arm.x, arm.y, arm.z, tensor);
    const pointVelocity = new Float64Array(3);
    const columns = [0, 1, 2].map((axis) => {
      // a unit impulse along each axis, from rest
      table.velocities.fill(0);
      table.spins.fill(0);
      const impulse = new Vector3().setComponent(axis, 1);
      table.applyImpulse(0, impulse.x, impulse.y, impulse.z, arm.x, arm.y, arm.z);
      table.pointVelocity(0, arm.x, arm.y, arm.z, pointVelocity);
      return [...pointVelocity];
    });
    const full = [
      [tensor[0], tensor[1], tensor[2]],
      [tensor[1], tensor[3], tensor[4]],
      [tensor[2], tensor[4], tensor[5]],
    ];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) expect(full[row]![column]).toBeCloseTo(columns[column]![row]!, 12);
  });
});
