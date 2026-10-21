import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { CarState } from '../src/multiplayer/protocol.js';
import { decodeState, encodeState, STATE_BYTES } from '../src/multiplayer/stateCodec.js';

// A car's state as it goes over the network: a tenth of the size of its JSON, and back again as
// near as anyone could tell, a car flat out at the far end of the circuit included.

function someState(): CarState {
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, -0.2).normalize(), 2.4);
  return {
    position: [-1734.218, 0.2843, 2219.507],
    quaternion: quaternion.toArray() as CarState['quaternion'],
    velocity: [88.31, -0.42, -27.06],
    angularVelocity: [0.012, -1.37, 0.4],
    steer: -0.61,
    wheels: [
      [0.0312, 0.152, 251.3],
      [0.0287, 0.141, 249.8],
      [0.0401, 0, 255.1],
      [0.0398, 0, 254.6],
    ],
  };
}

describe('a car state over the network', () => {
  it('takes 67 bytes, against near 700 as JSON', () => {
    const state = someState();
    expect(encodeState(3, 1234.5678, state).byteLength).toBe(STATE_BYTES);
    expect(JSON.stringify({ kind: 'state', from: 'abcdefgh', origin: 'abcdefgh', sentAt: 1234.5678, state }).length).toBeGreaterThan(STATE_BYTES * 4);
  });

  it('comes back as near as matters', () => {
    const state = someState();
    const decoded = decodeState(encodeState(7, 1234.5678, state))!;
    expect(decoded.slot).toBe(7);
    expect(decoded.sentAt).toBe(1234.5678);
    // under a millimetre where the car is, a hundredth of a degree in how it points
    expect(new Vector3(...decoded.state.position).distanceTo(new Vector3(...state.position))).toBeLessThan(0.001);
    const turn = new Quaternion(...decoded.state.quaternion).angleTo(new Quaternion(...state.quaternion));
    expect(turn).toBeLessThan((0.01 * Math.PI) / 180);
    expect(new Vector3(...decoded.state.velocity).distanceTo(new Vector3(...state.velocity))).toBeLessThan(0.01);
    expect(new Vector3(...decoded.state.angularVelocity).distanceTo(new Vector3(...state.angularVelocity))).toBeLessThan(0.002);
    expect(Math.abs(decoded.state.steer - state.steer)).toBeLessThan(0.005);
    decoded.state.wheels.forEach(([compression, steerAngle, spinSpeed], index) => {
      const [wantedCompression, wantedSteer, wantedSpin] = state.wheels[index]!;
      expect(Math.abs(compression - wantedCompression)).toBeLessThan(0.0001);
      expect(Math.abs(steerAngle - wantedSteer)).toBeLessThan(0.0001);
      expect(Math.abs(spinSpeed - wantedSpin)).toBeLessThan(0.06);
    });
  });

  it('turns away what is not a state', () => {
    expect(decodeState(new ArrayBuffer(10))).toBeUndefined();
    const notState = encodeState(1, 0, someState());
    new DataView(notState).setUint8(0, 9);
    expect(decodeState(notState)).toBeUndefined();
  });
});
