import { cleanCode, PeerTransport, roomCode, RoomError } from '../multiplayer/PeerTransport.js';
import type { Transport } from '../multiplayer/transport.js';

/** What the player chose: to drive alone, or a room they made or joined, connected. */
export type MenuChoice = { mode: 'alone' } | { mode: 'room'; transport: Transport; code: string; isHost: boolean };

/** The room this player is in, as the menu shows it. */
export interface RoomInfo {
  code: string;
  isHost: boolean;
  /** This player's car's number; undefined till the host has given them a place. */
  number: string | undefined;
  players: number;
  /** The round trip to the host, in milliseconds; 0 for the host. */
  ping: number;
}

/** What the menu's buttons do in the game. */
export interface MenuActions {
  /** Alone: back to the grid, the lights again. */
  restart(): void;
  /** The host: a race for everyone. Another player: back to their place on the grid. */
  startRace(): void;
  /** A room made or joined from the menu, once the game is under way. */
  enterRoom(choice: Extract<MenuChoice, { mode: 'room' }>): void;
  /** What the room is like now; undefined alone. */
  room(): RoomInfo | undefined;
}

/** The keys, and what they do. */
const CONTROLS: [string[], string][] = [
  [['W', 'S'], 'throttle, brake'],
  [['A', 'D'], 'steer'],
  [['E', 'Q'], 'shift up, down'],
  [['M'], 'manual gearbox'],
  [['Space'], 'DRS'],
  [['T'], 'traction control and ABS'],
  [['C'], 'camera'],
  [['I'], 'inspect the car'],
  [['R'], 'back to the grid'],
  [['N'], 'sound on, off'],
  [['Esc'], 'this menu'],
];
const GAMEPAD = 'Inspecting the car, drag to look round it and use the wheel to zoom. In a room, the host’s R starts a race for everyone. On a gamepad: the triggers to drive, the stick to steer, the bumpers to shift, A for DRS, Y the camera, X the sound, B the gearbox, Back the assists, Start this menu.';

/** How many codes to try for a new room before giving up, should one be someone else's room already. */
const CODE_TRIES = 3;

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, parent: HTMLElement, className?: string, text?: string): HTMLElementTagNameMap[Tag] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  parent.appendChild(made);
  return made;
}

/**
 * Everything that isn't the race, in one place, opened and closed with Esc: driving alone or in a
 * room, made or joined by its code, the room's goings-on, the keys, and who made what. It opens
 * first, for the choice; after that, on Esc.
 */
export class Menu {
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly roomRow: HTMLElement;
  private readonly note: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly game: MenuActions;
  /** Before the first choice the menu stays open: there is nothing behind it to go back to. */
  private chosen = false;
  private busy = false;
  private choose: ((choice: MenuChoice) => void) | undefined;
  private shownRoom = '';

  /** `credits`: who made what, as HTML. */
  constructor(container: HTMLElement, game: MenuActions, credits: string) {
    this.game = game;
    this.panel = element('div', container, 'menu');
    const title = element('div', this.panel, 'menu-title');
    const home = element('a', title, undefined, 'eulerjs');
    home.href = 'https://qusaialbonni.github.io/eulerjs/';
    title.append(' · Formula car at Monza');
    this.status = element('div', this.panel, 'menu-status');
    this.actions = element('div', this.panel, 'menu-row');
    this.roomRow = element('div', this.panel, 'menu-row');
    this.note = element('div', this.panel, 'menu-note');

    element('div', this.panel, 'menu-heading', 'Controls');
    const keys = element('div', this.panel, 'menu-keys');
    for (const [names, what] of CONTROLS) {
      const cell = element('div', keys);
      for (const name of names) element('kbd', cell, undefined, name);
      element('div', keys, undefined, what);
    }
    element('div', this.panel, 'menu-small', GAMEPAD);

    element('div', this.panel, 'menu-heading', 'Credits');
    element('div', this.panel, 'menu-small').innerHTML = credits;

    this.hint = element('div', container, 'menu-hint', 'Esc · menu');
    this.hint.hidden = true;
    this.render();
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Opens the menu for the first choice, a room to join at once if `joinCode`; resolves once made and, for a room, connected. */
  firstChoice(joinCode?: string): Promise<MenuChoice> {
    return new Promise((resolve) => {
      this.choose = (choice) => {
        this.chosen = true;
        this.choose = undefined;
        this.close();
        resolve(choice);
      };
      this.open();
      if (joinCode) void this.join(joinCode);
    });
  }

  /** The game under way without the menu's first choice: from part-way round, or a room of tabs. */
  skip(): void {
    this.chosen = true;
    this.close();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.panel.hidden = false;
    this.hint.hidden = true;
    this.render();
  }

  close(): void {
    if (!this.chosen || this.busy) return;
    this.panel.hidden = true;
    this.hint.hidden = false;
  }

  /** Each frame: the room's goings-on kept up to date while the menu is open. */
  update(): void {
    if (!this.isOpen) return;
    const room = this.game.room();
    const shown = room ? `${room.code}${room.isHost}${room.number}${room.players}${Math.round(room.ping / 5)}` : 'alone';
    if (shown !== this.shownRoom) this.render();
  }

  /** The buttons and the status line, for where the player is now. */
  private render(): void {
    const room = this.game.room();
    this.shownRoom = room ? `${room.code}${room.isHost}${room.number}${room.players}${Math.round(room.ping / 5)}` : 'alone';
    this.actions.replaceChildren();
    this.roomRow.replaceChildren();
    if (!this.chosen) {
      this.status.textContent = 'Wait for the five lights to go out, then go.';
      this.button(this.actions, 'Drive alone', () => this.choose?.({ mode: 'alone' }), true);
    } else if (room) {
      const car = room.number === undefined ? 'joining…' : `you're car ${room.number}`;
      const ping = room.isHost ? 'you host it' : `ping ${Math.round(room.ping)} ms`;
      this.status.textContent = `Room ${room.code} · ${car} · ${room.players} ${room.players === 1 ? 'player' : 'players'} · ${ping}`;
      this.button(this.actions, 'Resume', () => this.close(), true);
      this.button(this.actions, room.isHost ? 'Start a race for everyone' : 'Back to my place', () => {
        this.game.startRace();
        this.close();
      });
      this.button(this.roomRow, 'Copy invite link', () => {
        void navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?join=${room.code}`).then(() => this.say('The invite link is copied.'));
      });
      this.button(this.roomRow, 'Leave the room', () => window.location.assign(window.location.pathname));
      return;
    } else {
      this.status.textContent = 'Driving alone.';
      this.button(this.actions, 'Resume', () => this.close(), true);
      this.button(this.actions, 'Restart', () => {
        this.game.restart();
        this.close();
      });
    }
    // not in a room: make one, or join one by its code
    this.button(this.roomRow, 'Create a room', () => void this.create());
    const code = element('input', this.roomRow, 'menu-code');
    code.placeholder = 'room code';
    code.maxLength = 12;
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.join(code.value);
    });
    this.button(this.roomRow, 'Join', () => void this.join(code.value));
  }

  private button(row: HTMLElement, label: string, onClick: () => void, first = false): void {
    const made = element('button', row, first ? 'first' : undefined, label);
    made.disabled = this.busy;
    made.addEventListener('click', onClick);
    if (first) queueMicrotask(() => made.focus());
  }

  private say(message: string, isError = false): void {
    this.note.textContent = message;
    this.note.className = isError ? 'menu-note error' : 'menu-note';
  }

  /** Waiting on the network: the buttons out of reach, a word on what it's doing. */
  private wait(message: string): void {
    this.busy = true;
    this.say(message);
    this.render();
  }

  private failed(error: unknown): void {
    this.busy = false;
    this.render();
    this.say(error instanceof RoomError ? error.message : `Something went wrong: ${String(error)}`, true);
  }

  /** In a room, connected: the first choice, or one made in the game. */
  private entered(choice: Extract<MenuChoice, { mode: 'room' }>): void {
    this.busy = false;
    this.say('');
    if (this.choose) this.choose(choice);
    else {
      this.game.enterRoom(choice);
      this.render();
      this.close();
    }
  }

  private async create(): Promise<void> {
    this.wait('Making a room…');
    for (let attempt = 1; attempt <= CODE_TRIES; attempt++) {
      const code = roomCode();
      try {
        this.entered({ mode: 'room', transport: await PeerTransport.host(code), code, isHost: true });
        return;
      } catch (error) {
        // a code someone else's room has: another one; anything else is for the player to see
        const taken = error instanceof RoomError && error.message.startsWith('There is a room');
        if (!taken || attempt === CODE_TRIES) {
          this.failed(error);
          return;
        }
      }
    }
  }

  private async join(typed: string): Promise<void> {
    const code = cleanCode(typed);
    if (code.length < 4) {
      this.say('Type the room’s code: the five letters its host has.', true);
      return;
    }
    this.wait(`Joining room ${code}…`);
    try {
      this.entered({ mode: 'room', transport: await PeerTransport.join(code), code, isHost: false });
    } catch (error) {
      this.failed(error);
    }
  }
}
