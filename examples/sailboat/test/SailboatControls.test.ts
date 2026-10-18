import { MathUtils, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Foil, sailPolar, Wind } from '@eulerjs/marine';
import { SailboatControls } from '../src/boat/SailboatControls.js';
import type { SailboatFoils } from '../src/boat/sailboatPhysics.js';
import { SAILBOAT_LAYOUT } from '../src/boat/sailboatLayout.js';

function foils(): SailboatFoils {
  const foil = () => new Foil({ medium: new Wind(), area: 1, center: new Vector3(), polar: sailPolar });
  return { mainsail: foil(), jib: foil(), keel: foil(), rudder: foil() };
}

function keyEvent(type: 'keydown' | 'keyup', code: string): Event {
  return Object.assign(new Event(type), { code });
}

describe('SailboatControls', () => {
  it('turns the rudder while a key is held, up to its limit', () => {
    const target = new EventTarget();
    const boatFoils = foils();
    const controls = new SailboatControls(boatFoils, target);
    target.dispatchEvent(keyEvent('keydown', 'KeyD'));
    controls.update(0.25);
    expect(boatFoils.rudder.angle).toBeCloseTo(SAILBOAT_LAYOUT.rudder.turnRate * 0.25, 12);
    controls.update(10);
    expect(boatFoils.rudder.angle).toBeCloseTo(SAILBOAT_LAYOUT.rudder.maxAngle, 12);
  });

  it('recentres the rudder when let go', () => {
    const target = new EventTarget();
    const boatFoils = foils();
    const controls = new SailboatControls(boatFoils, target);
    target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    controls.update(0.5);
    target.dispatchEvent(keyEvent('keyup', 'KeyA'));
    controls.update(0.1);
    expect(boatFoils.rudder.angle).toBeCloseTo(-SAILBOAT_LAYOUT.rudder.turnRate * 0.5 + SAILBOAT_LAYOUT.rudder.returnRate * 0.1, 12);
    controls.update(10);
    expect(boatFoils.rudder.angle).toBe(0);
  });

  it('eases and trims the sails, which stay where they are left', () => {
    const target = new EventTarget();
    const boatFoils = foils();
    const controls = new SailboatControls(boatFoils, target);
    target.dispatchEvent(keyEvent('keydown', 'KeyE'));
    target.dispatchEvent(keyEvent('keydown', 'KeyZ'));
    controls.update(1);
    target.dispatchEvent(keyEvent('keyup', 'KeyE'));
    target.dispatchEvent(keyEvent('keyup', 'KeyZ'));
    controls.update(1);
    expect(boatFoils.mainsail.angle).toBeCloseTo(MathUtils.degToRad(40), 12);
    expect(boatFoils.jib.angle).toBeCloseTo(-MathUtils.degToRad(40), 12);
  });

  it('cancels opposite keys and ignores unbound ones', () => {
    const target = new EventTarget();
    const boatFoils = foils();
    const controls = new SailboatControls(boatFoils, target);
    target.dispatchEvent(keyEvent('keydown', 'KeyQ'));
    target.dispatchEvent(keyEvent('keydown', 'KeyE'));
    target.dispatchEvent(keyEvent('keydown', 'KeyP'));
    controls.update(1);
    expect(boatFoils.mainsail.angle).toBe(0);
  });

  it('releases every key when the window loses focus, and stops listening once disposed', () => {
    const target = new EventTarget();
    const boatFoils = foils();
    const controls = new SailboatControls(boatFoils, target);
    target.dispatchEvent(keyEvent('keydown', 'KeyX'));
    target.dispatchEvent(new Event('blur'));
    controls.update(1);
    expect(boatFoils.jib.angle).toBe(0);
    controls.dispose();
    target.dispatchEvent(keyEvent('keydown', 'KeyX'));
    controls.update(1);
    expect(boatFoils.jib.angle).toBe(0);
  });
});
