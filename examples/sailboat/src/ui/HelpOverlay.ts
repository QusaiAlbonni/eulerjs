const KEY_BINDINGS: ReadonlyArray<readonly [keys: string[], action: string]> = [
  [['A', 'D'], 'rudder'],
  [['Q', 'E'], 'mainsail'],
  [['Z', 'X'], 'jib'],
  [['V'], 'follow / free camera'],
  [['G'], 'camera behind the boat'],
  [['←', '↑', '→', '↓'], 'fly (free camera)'],
  [['N'], 'day / night'],
  [['L'], 'headlight (night)'],
  [['H'], 'hide this help'],
];

/** The list of keyboard controls, in a corner of the screen. */
export class HelpOverlay {
  readonly element: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'help-overlay';
    for (const [keys, action] of KEY_BINDINGS) {
      const line = document.createElement('div');
      for (const key of keys) {
        const keyCap = document.createElement('kbd');
        keyCap.textContent = key;
        line.append(keyCap, ' ');
      }
      line.append(action);
      this.element.append(line);
    }
    container.appendChild(this.element);
  }

  toggle(): void {
    this.element.hidden = !this.element.hidden;
  }

  dispose(): void {
    this.element.remove();
  }
}
