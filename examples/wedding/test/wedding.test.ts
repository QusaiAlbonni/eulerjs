import { Scene, Vector3 } from 'three';
import { World } from 'eulerjs';
import type { Body } from 'eulerjs';
import { describe, expect, it } from 'vitest';
import { FirstPersonPlayer } from '../src/player/FirstPersonPlayer.js';
import { Hands } from '../src/player/Hands.js';
import { createVenue } from '../src/venue/createVenue.js';
import type { WeddingVenue } from '../src/venue/createVenue.js';

/** The wedding venue and a guest walking about it, shoving and carrying things. */

function runFor(world: World, seconds: number, eachStep?: () => void): void {
  for (let step = 0; step < Math.round(seconds / world.timestep); step++) {
    eachStep?.();
    world.fixedStep();
  }
}

const up = (body: Body) => body.directionToWorld(new Vector3(0, 1, 0)).y;

/** The venue settled, and a guest standing in it at `position`. */
function guestAt(position: Vector3): { world: World; venue: WeddingVenue; player: FirstPersonPlayer; hands: Hands } {
  const world = new World();
  const venue = createVenue(world, new Scene());
  runFor(world, 2);
  const player = new FirstPersonPlayer(world, position);
  const hands = world.use(new Hands(world, player));
  runFor(world, 0.5);
  return { world, venue, player, hands };
}

/** Turns the player's head to look at `point`. */
function lookAt(player: FirstPersonPlayer, point: Vector3): void {
  const toward = point.clone().sub(player.eyePositionNow(new Vector3()));
  player.yaw = Math.atan2(-toward.x, -toward.z);
  player.pitch = Math.atan2(toward.y, Math.hypot(toward.x, toward.z));
}

describe('the wedding venue', () => {
  it('stands everything where it was set, the champagne tower and the cake too, and puts it all to sleep', () => {
    // awake, to show it really does stand: it starts asleep in the example
    const world = new World();
    const venue = createVenue(world, new Scene(), { startAsleep: false });
    const start = new Map(venue.props.map((body) => [body, body.position.clone()]));
    const balloons = new Set(venue.balloons.balloons.map(({ balloon }) => balloon));
    runFor(world, 10);
    expect(venue.props.filter((body) => !body.isSleeping)).toHaveLength(0);
    // the balloons rise to the ends of their strings; nothing else moves more than settling into place
    const furthest = Math.max(...venue.props.filter((body) => !balloons.has(body)).map((body) => body.position.distanceTo(start.get(body)!)));
    expect(furthest).toBeLessThan(0.01);
    for (const glass of venue.champagneTower) expect(glass.position.distanceTo(start.get(glass)!)).toBeLessThan(0.002);
    for (const tier of venue.cake) expect(tier.position.distanceTo(start.get(tier)!)).toBeLessThan(0.003);
  });

  it('flies the balloons at the ends of their strings, above their weights', () => {
    const world = new World();
    const venue = createVenue(world, new Scene());
    runFor(world, 6);
    for (const { balloon, weight, string } of venue.balloons.balloons) {
      expect(string.currentAnchors().distance).toBeCloseTo(string.length, 2);
      expect(Math.hypot(balloon.position.x - weight.position.x, balloon.position.z - weight.position.z)).toBeLessThan(0.1);
      expect(weight.position.y).toBeLessThan(0.4);
    }
  });
});

describe('a guest at the wedding', () => {
  it('stands upright on the lawn and walks at walking pace', () => {
    const { world, player } = guestAt(new Vector3(-4, 0, 6));
    expect(player.onGround).toBe(true);
    // the soles of the feet on the grass
    expect(player.body.position.y).toBeCloseTo(0.875, 2);
    player.input.forward = 1;
    runFor(world, 1);
    const from = player.body.position.clone();
    runFor(world, 1);
    expect(player.body.position.distanceTo(from)).toBeCloseTo(3, 1);
    player.input.forward = 0;
    runFor(world, 1);
    expect(player.body.velocity.length()).toBeLessThan(0.01);
    expect(up(player.body)).toBeGreaterThan(0.9999);
  });

  it('pushes a chair they walk into, and slides a table they lean on, staying upright', () => {
    const { world, venue, player } = guestAt(new Vector3(1.5, 0, 6.5));
    const chair = venue.chairs.find((candidate) => Math.abs(candidate.position.x - 1.5) < 0.1 && candidate.position.z < 11)!;
    const chairStart = chair.position.clone();
    // facing the arch, along +z, into the back row
    player.yaw = Math.PI;
    player.input.forward = 1;
    runFor(world, 2.5);
    expect(chair.position.distanceTo(chairStart)).toBeGreaterThan(1);
    expect(up(player.body)).toBeGreaterThan(0.999);

    const table = venue.tables[0]!;
    const tableStart = table.position.clone();
    player.respawn(table.position.clone().add(new Vector3(0, 0, 2.2)));
    player.yaw = 0;
    runFor(world, 3);
    expect(table.position.distanceTo(tableStart)).toBeGreaterThan(0.5);
    expect(up(player.body)).toBeGreaterThan(0.999);
  });

  it('shoves what they look at', () => {
    const { world, venue, player, hands } = guestAt(new Vector3(-5, 0, 7));
    const chair = venue.chairs.find((candidate) => candidate.position.x < -3 && candidate.position.z < 11)!;
    player.respawn(chair.position.clone().add(new Vector3(0, 0, -1.4)));
    runFor(world, 0.3);
    lookAt(player, chair.position.clone().setY(0.45));
    expect(hands.aimedAt()?.body).toBe(chair);
    const before = chair.position.clone();
    expect(hands.shove()).toBe(true);
    runFor(world, 1);
    expect(chair.position.distanceTo(before)).toBeGreaterThan(0.1);
  });

  it('carries what they pick up in front of them, throws it, and is too weak to lift a table', () => {
    // on the clear grass between the gift table and the nearest round table
    const { world, venue, player, hands } = guestAt(new Vector3(-4.8, 0, -17));
    // the topmost present on the stack by the gift table
    const gift = venue.props.filter((body) => body.colliders[0]!.shape === 'box' && body.position.x > -7 && body.position.z < -15).sort((first, second) => second.position.y - first.position.y)[0]!;
    lookAt(player, gift.position);
    runFor(world, 0.2);
    expect(hands.pickUp()).toBe(true);
    expect(hands.holding).toBe(gift);
    player.input.forward = -1;
    runFor(world, 2);
    player.input.forward = 0;
    runFor(world, 1);
    // held at about chest height, in front of the eyes
    const eyes = player.eyePositionNow(new Vector3());
    expect(gift.position.distanceTo(eyes)).toBeLessThan(1.8);
    expect(gift.position.y).toBeGreaterThan(0.5);
    player.pitch = 0.2;
    const thrownFrom = gift.position.clone();
    hands.throwHeld();
    expect(hands.holding).toBeUndefined();
    runFor(world, 2);
    expect(gift.position.distanceTo(thrownFrom)).toBeGreaterThan(2);

    const table = venue.tables[3]!;
    player.respawn(table.position.clone().add(new Vector3(0, 0, 1.6)));
    runFor(world, 0.3);
    lookAt(player, table.position.clone().setY(0.6));
    expect(hands.aimedAt()?.body).toBe(table);
    expect(hands.pickUp()).toBe(false);
  });
});
