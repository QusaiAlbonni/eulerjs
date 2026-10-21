import type { CarState } from './protocol.js';

// A car's state in as few bytes as will do, for the network: sent thirty times a second by every
// player and passed on by the host to each of the others, it is most of what a room sends. As
// JSON it is near 700 bytes; this is 67. Each quantity is kept as finely as it needs and no more:
// the position to a quarter of a millimetre anywhere round a 6 km circuit, the rest to well below what
// shows or what a collision would feel.

/** The bytes a state takes. */
export const STATE_BYTES = 67;
const KIND_STATE = 1;

/** How finely each quantity is kept, as the size of one step of the integer it is kept in. */
const QUATERNION_STEP = 1 / 32_767;
const VELOCITY_STEP = 0.01; // m/s, to ±327 m/s
const ANGULAR_STEP = 0.001; // rad/s, to ±32 rad/s
const STEER_STEP = 1 / 127;
const COMPRESSION_STEP = 0.0001; // m
const STEER_ANGLE_STEP = 0.0001; // rad
const SPIN_STEP = 0.1; // rad/s, to ±3276 rad/s: 590 km/h on these wheels

function toInteger(value: number, step: number, most: number): number {
  return Math.max(-most, Math.min(most, Math.round(value / step)));
}

/** A state, the slot of the car it is for and when it was sent (on the host's clock, in seconds), as bytes. */
export function encodeState(slot: number, sentAt: number, state: CarState): ArrayBuffer {
  const buffer = new ArrayBuffer(STATE_BYTES);
  const view = new DataView(buffer);
  let at = 0;
  const int16 = (value: number, step: number) => {
    view.setInt16(at, toInteger(value, step, 32_767));
    at += 2;
  };
  view.setUint8(at++, KIND_STATE);
  view.setUint8(at++, slot);
  view.setFloat64(at, sentAt);
  at += 8;
  for (const coordinate of state.position) {
    view.setFloat32(at, coordinate);
    at += 4;
  }
  for (const component of state.quaternion) int16(component, QUATERNION_STEP);
  for (const component of state.velocity) int16(component, VELOCITY_STEP);
  for (const component of state.angularVelocity) int16(component, ANGULAR_STEP);
  view.setInt8(at++, toInteger(state.steer, STEER_STEP, 127));
  for (const [compression, steerAngle, spinSpeed] of state.wheels) {
    int16(compression, COMPRESSION_STEP);
    int16(steerAngle, STEER_ANGLE_STEP);
    int16(spinSpeed, SPIN_STEP);
  }
  return buffer;
}

/** A state back from its bytes; undefined if they aren't one. */
export function decodeState(buffer: ArrayBuffer): { slot: number; sentAt: number; state: CarState } | undefined {
  if (buffer.byteLength !== STATE_BYTES) return undefined;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== KIND_STATE) return undefined;
  let at = 2;
  const int16 = (step: number) => {
    const value = view.getInt16(at) * step;
    at += 2;
    return value;
  };
  const slot = view.getUint8(1);
  const sentAt = view.getFloat64(at);
  at += 8;
  const position = [0, 1, 2].map(() => {
    const value = view.getFloat32(at);
    at += 4;
    return value;
  }) as CarState['position'];
  const quaternion = [0, 1, 2, 3].map(() => int16(QUATERNION_STEP)) as CarState['quaternion'];
  // put back to unit length, which rounding each component leaves it a hair off
  const length = Math.hypot(...quaternion);
  for (let index = 0; index < 4; index++) quaternion[index]! /= length;
  const velocity = [0, 1, 2].map(() => int16(VELOCITY_STEP)) as CarState['velocity'];
  const angularVelocity = [0, 1, 2].map(() => int16(ANGULAR_STEP)) as CarState['angularVelocity'];
  const steer = view.getInt8(at++) * STEER_STEP;
  const wheels = [0, 1, 2, 3].map(() => [int16(COMPRESSION_STEP), int16(STEER_ANGLE_STEP), int16(SPIN_STEP)] as [number, number, number]);
  return { slot, sentAt, state: { position, quaternion, velocity, angularVelocity, steer, wheels } };
}
