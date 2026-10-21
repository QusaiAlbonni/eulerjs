import type { Scene } from 'three';
import type { World } from '@eulerjs/core';
import { DetailedCarModel } from '../car/DetailedCarModel.js';
import type { F1Car } from '../car/F1Car.js';
import { LIVERIES } from '../car/livery.js';
import { RemoteCar } from './RemoteCar.js';
import { Session } from './Session.js';
import type { RoomInfo } from '../ui/Menu.js';
import type { Transport } from './transport.js';

/** What the game does when the session says so: this player's slot, and the start of a race, on the world's clock. */
export interface MultiplayerGame {
  world: World;
  scene: Scene;
  car: F1Car;
  /** The detailed car's file, for the other players' cars. */
  modelUrl: string;
  /** This player has slot `slot`: their livery and place on the grid. */
  takeSlot(slot: number): void;
  /** The race starts: the lights come on and go out at these times on the world's clock. */
  start(lightsAt: number, outAt: number): void;
}

/** A race with other players in the room `room`, over `transport`, this player its host or not. */
export class Multiplayer {
  readonly session: Session;
  readonly room: string;
  private readonly game: MultiplayerGame;
  private readonly cars = new Map<string, RemoteCar | 'loading'>();

  constructor(transport: Transport, room: string, isHost: boolean, game: MultiplayerGame) {
    this.room = room;
    this.game = game;
    this.session = new Session(transport, isHost, {
      joined: (id, slot) => this.addCar(id, slot),
      left: (id) => this.removeCar(id),
      state: (id, state, sentAt) => {
        const car = this.cars.get(id);
        if (car instanceof RemoteCar) car.receive(state, sentAt);
      },
      slot: (slot) => game.takeSlot(slot),
      start: (lightsAt, outAt) => {
        // from the host's clock to the world's
        const ahead = game.world.renderTime - this.session.hostNow();
        game.start(lightsAt + ahead, outAt + ahead);
      },
    });
  }

  /** The room as the menu shows it. */
  info(): RoomInfo {
    const slot = this.session.slot;
    return { code: this.room, isHost: this.session.isHost, number: slot === undefined ? undefined : LIVERIES[slot]!.number, players: this.session.players, ping: this.session.ping };
  }

  /** The host only: a race for everyone. */
  startRace(): void {
    this.session.startRace();
  }

  /**
   * Each frame, after the world's step: the other players' cars drawn, this one's state sent.
   * `frameTime`: the frame's own time, in milliseconds as `requestAnimationFrame` gives it, so
   * that the cars are drawn for when the frame is shown rather than for whenever this runs.
   */
  update(frameDelta: number, frameTime: number): void {
    const hostNow = this.session.hostTimeAt(frameTime / 1000);
    for (const car of this.cars.values()) if (car instanceof RemoteCar) car.draw(hostNow, this.game.world, frameDelta);
    this.session.update(this.game.car);
  }

  private addCar(id: string, slot: number): void {
    if (this.cars.has(id)) return;
    this.cars.set(id, 'loading');
    void DetailedCarModel.load(this.game.modelUrl, LIVERIES[slot]!).then((model) => {
      // gone again while it loaded
      if (this.cars.get(id) !== 'loading') return;
      this.game.scene.add(model.root);
      this.cars.set(id, new RemoteCar(this.game.world, model));
    });
  }

  private removeCar(id: string): void {
    const car = this.cars.get(id);
    this.cars.delete(id);
    if (car instanceof RemoteCar) car.remove(this.game.world);
  }
}

