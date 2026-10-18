import { Quaternion, Scene, Vector3 } from 'three';
import { Body, PlaneCollider, World } from '@eulerjs/core';
import type { CapsuleCollider } from '@eulerjs/core';
import { describe, expect, it } from 'vitest';
import { createCarPhysics } from '../src/car/createCarPhysics.js';
import { BLOCK_PITCH, createCity } from '../src/city/createCity.js';
import { Crowd } from '../src/people/Crowd.js';
import { Pedestrian } from '../src/people/Pedestrian.js';
import { RAGDOLL_PARTS } from '../src/people/ragdollLayout.js';
import { standingPose, STRIDE_LENGTH, walkPose } from '../src/people/walkCycle.js';

/** People walking round the city as ragdolls, and what happens when the car hits one. */

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    world.fixedStep();
    eachStep?.();
  }
}

/** How far apart the middle segments of two capsule parts come, sampled finely along the first. */
function segmentGap(first: Body, second: Body): number {
  const ends = (body: Body) => {
    const capsule = body.colliders[0] as CapsuleCollider;
    return [body.localToWorld(new Vector3(0, -capsule.length / 2, 0)), body.localToWorld(new Vector3(0, capsule.length / 2, 0))] as const;
  };
  const [startA, endA] = ends(first);
  const [startB, endB] = ends(second);
  const alongB = endB.clone().sub(startB);
  let nearest = Infinity;
  for (let sample = 0; sample <= 20; sample++) {
    const point = startA.clone().lerp(endA, sample / 20);
    const fraction = Math.min(1, Math.max(0, point.clone().sub(startB).dot(alongB) / Math.max(alongB.lengthSq(), 1e-12)));
    nearest = Math.min(nearest, point.distanceTo(startB.clone().addScaledVector(alongB, fraction)));
  }
  return nearest;
}

/** How deep the deepest overlap is between any two parts of these people that are meant to collide. */
function deepestOverlap(people: readonly Pedestrian[]): number {
  // only parts joined where they overlap don't collide with each other
  const tied = new Map<Body, Set<Body>>();
  const exempt = (one: Body, other: Body) => {
    for (const [first, second] of [[one, other], [other, one]] as const) {
      if (!tied.has(first)) tied.set(first, new Set());
      tied.get(first)!.add(second);
    }
  };
  for (const person of people) {
    for (const joint of person.joints) if (!joint.collideConnected) exempt(joint.bodyA, joint.bodyB!);
  }
  const parts = people.flatMap((person) => [...person.parts.values()]);
  let deepest = 0;
  for (let first = 0; first < parts.length; first++) {
    for (let second = first + 1; second < parts.length; second++) {
      const partA = parts[first]!;
      const partB = parts[second]!;
      if (tied.get(partA)?.has(partB)) continue;
      const radii = (partA.colliders[0] as CapsuleCollider).radius + (partB.colliders[0] as CapsuleCollider).radius;
      deepest = Math.max(deepest, radii - segmentGap(partA, partB));
    }
  }
  return deepest;
}

const standingStill = (position: Vector3) => ({ position, heading: 0, velocity: new Vector3() });

/** Height of the bottom of a shin: the sole of that foot. */
function soleHeight(shin: Body): number {
  const layout = RAGDOLL_PARTS.find((part) => part.name === 'shinLeft')!;
  return shin.localToWorld(new Vector3(0, -(layout.length / 2 + layout.radius), 0)).y;
}

describe('the walk cycle', () => {
  it('keeps one foot on the ground and swings the other through', () => {
    const pose = standingPose();
    for (let phase = 0; phase < 2 * Math.PI; phase += 0.1) {
      walkPose(phase, pose);
      const soles = (['shinLeft', 'shinRight'] as const).map((shin) => pose[shin].position.y - new Vector3(0, 0.24, 0).applyQuaternion(pose[shin].quaternion).y);
      expect(Math.min(...soles)).toBeCloseTo(0, 6);
    }
    // a stride is about how far a person of this height walks with each pair of steps
    expect(STRIDE_LENGTH).toBeGreaterThan(1);
    expect(STRIDE_LENGTH).toBeLessThan(1.6);
  });
});

describe('people walking round the city', () => {
  it('walk their routes upright at walking pace, and nobody falls over by themselves', () => {
    const world = new World();
    const city = createCity(world, new Scene());
    const crowd = world.use(new Crowd(world, { count: 12, blocks: city.blocks, random: seededRandom(5) }));
    runFor(world, 1);
    let lowestHead = Infinity;
    let worstPelvisHeight = 0;
    let lowestSole = Infinity;
    let speed = 0;
    let samples = 0;
    runFor(world, 15, () => {
      for (const person of crowd.people) {
        const pelvis = person.parts.get('pelvis')!;
        lowestHead = Math.min(lowestHead, person.parts.get('head')!.position.y);
        worstPelvisHeight = Math.max(worstPelvisHeight, Math.abs(pelvis.position.y - 0.95));
        lowestSole = Math.min(lowestSole, soleHeight(person.parts.get('shinLeft')!), soleHeight(person.parts.get('shinRight')!));
        speed += Math.hypot(pelvis.velocity.x, pelvis.velocity.z);
        samples++;
      }
    });
    expect(crowd.counts).toEqual({ walking: 12, down: 0 });
    expect(lowestHead).toBeGreaterThan(1.5);
    expect(worstPelvisHeight).toBeLessThan(0.1);
    // feet on the ground, not through it
    expect(lowestSole).toBeGreaterThan(-0.02);
    expect(speed / samples).toBeGreaterThan(1.1);
    expect(speed / samples).toBeLessThan(1.6);
    // eleven awake parts each
    expect(world.bodies.filter((body) => body.type === 'dynamic' && !body.isSleeping).length).toBe(12 * 11);
  }, 90_000);

  it('knocks down someone the car hits, who comes to rest, then gets up again', () => {
    const world = new World();
    createCity(world, new Scene());
    const plaza = new Vector3(BLOCK_PITCH / 2, 0, BLOCK_PITCH / 2);
    const crowd = world.use(new Crowd(world, { count: 1, blocks: [plaza], random: seededRandom(2) }));
    const person = crowd.people[0]!;
    const pelvis = person.parts.get('pelvis')!;
    runFor(world, 0.5);
    // the car comes off the street, square to the walkway, toward where the walker will be in a moment
    const meetingPoint = pelvis.position.clone().addScaledVector(pelvis.velocity, 1.3).setY(0);
    const fromCenter = meetingPoint.clone().sub(plaza);
    const outward = Math.abs(fromCenter.x) > Math.abs(fromCenter.z) ? new Vector3(Math.sign(fromCenter.x), 0, 0) : new Vector3(0, 0, Math.sign(fromCenter.z));
    const heading = outward.clone().negate();
    const { body: car, vehicle } = createCarPhysics({
      world,
      position: meetingPoint.clone().addScaledVector(outward, 12),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(heading.x, heading.z)),
    });
    car.velocity.copy(heading.multiplyScalar(9));
    vehicle.throttle = 0.3;
    let knockedDownAt: number | undefined;
    let restingAt: number | undefined;
    let upAt: number | undefined;
    let widestJointInTheHit = 0;
    let widestJointAtRest = 0;
    let deepestUnderground = 0;
    runFor(world, 14, () => {
      if (world.time > 2.5) {
        vehicle.throttle = 0;
        vehicle.brake = 1;
      }
      knockedDownAt ??= person.walking ? undefined : world.time;
      if (knockedDownAt !== undefined && upAt === undefined) {
        // how soon a heap of limbs falls asleep varies a lot from fall to fall; see the test of that below
        restingAt ??= world.time > knockedDownAt + 1 && [...person.parts.values()].every((part) => part.velocity.length() < 0.05) ? world.time : undefined;
        if (person.walking) upAt = world.time;
        const widest = Math.max(...person.joints.map((joint) => joint.measure().linear.length()));
        if (restingAt === undefined) widestJointInTheHit = Math.max(widestJointInTheHit, widest);
        else widestJointAtRest = Math.max(widestJointAtRest, widest);
        for (const part of person.parts.values()) deepestUnderground = Math.max(deepestUnderground, -part.worldCenterOfMass.y);
      }
    });
    expect(knockedDownAt).toBeDefined();
    expect(restingAt).toBeDefined();
    expect(upAt! - knockedDownAt!).toBeCloseTo(8, 1);
    expect(restingAt!).toBeLessThan(upAt!);
    // a 1.2 t car against a 1.6 kg forearm opens the joints for a moment, by a few centimetres
    // depending on how it strikes; they close again
    expect(widestJointInTheHit).toBeLessThan(0.1);
    // lying in a heap, the pins keep some give: a couple of millimetres at 8 substeps a step, under a centimetre at the default 4
    expect(widestJointAtRest).toBeLessThan(0.01);
    expect(deepestUnderground).toBeLessThan(0.01);
    expect(person.parts.get('head')!.position.y).toBeGreaterThan(1.4);
  });

  it('collapses in a heap when limp and shoved, without its limbs passing through its body, and falls asleep', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
    const person = new Pedestrian(world, standingStill(new Vector3()), standingPose());
    person.walking = false;
    // balanced straight up on straight legs, a limp body would stay standing: a shove at the chest
    person.parts.get('chest')!.velocity.set(0.8, 0, 0.3);
    let deepest = 0;
    // it lies still within a few seconds, though a forearm resting on the chest can tremble for longer
    runFor(world, 12, () => {
      deepest = Math.max(deepest, deepestOverlap([person]));
    });
    expect(deepest).toBeLessThan(0.015);
    expect([...person.parts.values()].every((part) => part.isSleeping)).toBe(true);
    expect(person.parts.get('head')!.position.y).toBeLessThan(0.5);
  });

  it('piles one person on another without them passing through each other', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
    const people = [new Pedestrian(world, standingStill(new Vector3()), standingPose()), new Pedestrian(world, standingStill(new Vector3(0.3, 1.9, 0.2)), standingPose())];
    for (const person of people) person.walking = false;
    let deepest = 0;
    runFor(world, 10, () => {
      deepest = Math.max(deepest, deepestOverlap(people));
    });
    expect(deepest).toBeLessThan(0.015);
  });

  it('falls asleep within a few seconds in most falls', () => {
    // how a heap of limbs comes to rest varies a lot from one fall to the next, so this takes a sample
    const random = seededRandom(9);
    const sleepTimes: number[] = [];
    for (let fall = 0; fall < 8; fall++) {
      const world = new World();
      world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
      const person = new Pedestrian(world, { position: new Vector3(), heading: random() * 6, velocity: new Vector3() }, standingPose());
      person.walking = false;
      const fling = new Vector3((random() - 0.5) * 16, random() * 5, (random() - 0.5) * 16);
      const spin = new Vector3((random() - 0.5) * 20, (random() - 0.5) * 20, (random() - 0.5) * 20);
      for (const part of person.parts.values()) {
        part.velocity.copy(fling);
        part.angularVelocity.copy(spin);
      }
      let asleepAt = Infinity;
      for (let step = 0; step < 600 && asleepAt === Infinity; step++) {
        world.fixedStep();
        if ([...person.parts.values()].every((part) => part.isSleeping)) asleepAt = world.time;
      }
      sleepTimes.push(asleepAt);
    }
    sleepTimes.sort((first, second) => first - second);
    expect(sleepTimes.filter((time) => time <= 8).length).toBeGreaterThanOrEqual(5);
    expect(sleepTimes[4]).toBeLessThan(6);
  }, 60_000);

  it('bumps two people walking into each other instead of letting them walk through each other', () => {
    const world = new World();
    world.addBody(new Body({ type: 'static', colliders: [new PlaneCollider({ friction: 0.8 })] }));
    const pose = walkPose(0, standingPose());
    const toward = { position: new Vector3(0, 0, -3), heading: 0, velocity: new Vector3(0, 0, 1.3) };
    const back = { position: new Vector3(0.2, 0, 3), heading: Math.PI, velocity: new Vector3(0, 0, -1.3) };
    const people = [new Pedestrian(world, toward, pose), new Pedestrian(world, back, pose)];
    let deepest = 0;
    let phase = 0;
    runFor(world, 5, () => {
      phase += 0.12;
      walkPose(phase, pose);
      for (const placement of [toward, back]) placement.position.addScaledVector(placement.velocity, world.timestep);
      people[0]!.followPose(toward, pose);
      people[1]!.followPose(back, pose);
      deepest = Math.max(deepest, deepestOverlap(people));
    });
    // their walks keep driving them into each other the whole time, which presses in a few
    // centimetres at most; without collisions between people they passed right through, 15 cm deep
    expect(deepest).toBeLessThan(0.05);
  });
});
