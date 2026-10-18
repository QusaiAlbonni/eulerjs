import { Vector3 } from 'three';
import { it } from 'vitest';
import { Body, BoxCollider, HeightfieldCollider, MassProperties, World } from 'eulerjs';
import { RaycastVehicle } from '@eulerjs/vehicle';
import { benchmarkBackend, runSeconds, timeStep } from '../../eulerjs/bench/scenes.js';

// Not pass/fail: prints what ray-cast vehicles cost. Run with `npm run bench`.

const report = (line: string) => process.stdout.write(`${line}\n`);

it('reports ray-cast vehicle cost', () => {
  const world = new World({ backend: benchmarkBackend() });
  const heights = Array.from({ length: 129 }, (_unused, row) => Array.from({ length: 129 }, (_unused2, column) => 0.3 * Math.sin(row / 5) * Math.cos(column / 7)));
  world.addBody(new Body({ type: 'static', colliders: [new HeightfieldCollider({ heights, cellSize: 1 })] }));
  const size = new Vector3(1.8, 0.6, 4);
  const mounts = [new Vector3(0.8, -0.2, 1.3), new Vector3(-0.8, -0.2, 1.3), new Vector3(0.8, -0.2, -1.3), new Vector3(-0.8, -0.2, -1.3)];
  const vehicles: RaycastVehicle[] = [];
  for (let index = 0; index < 100; index++) {
    const body = world.addBody(
      new Body({ massProperties: MassProperties.box(size, 1000), position: new Vector3(((index % 10) - 5) * 8, 1.5, (Math.floor(index / 10) - 5) * 10), canSleep: false, colliders: [new BoxCollider({ size })] }),
    );
    const vehicle = body.addBehavior(new RaycastVehicle({ wheels: mounts.map((mount) => ({ mount, radius: 0.3, suspensionLength: 0.3, springStiffness: 25_000, springDamping: 3000 })) }));
    for (const wheel of vehicle.wheels) wheel.driveForce = 300;
    vehicle.wheels[0]!.steerAngle = vehicle.wheels[1]!.steerAngle = 0.2;
    vehicles.push(vehicle);
  }
  runSeconds(world, 2);
  const stepTime = timeStep(() => world.fixedStep());
  report(`VEHICLE 100 cars driving round on a heightfield: ${stepTime.toFixed(2)} ms per step, ${(stepTime / world.timestep).toFixed(0)} ms per simulated second`);
}, 600_000);
