import type { ColorRepresentation } from 'three';

/** A car's paint: its main colour, its second colour, the lettering on them, and its number, in its own colour. */
export interface Livery {
  main: ColorRepresentation;
  second: ColorRepresentation;
  /** The names on the sidepods, the airbox and the halo: on the second colour, mostly. */
  lettering: ColorRepresentation;
  /** One or two characters. */
  number: string;
  numberColor: ColorRepresentation;
}

/** A livery for each of ten players, every one told apart from the others at a glance. */
export const LIVERIES: readonly Livery[] = [
  { main: '#0f3f78', second: '#1fa39a', lettering: '#ffffff', number: '7', numberColor: '#ffffff' },
  { main: '#b3121f', second: '#f4f4f4', lettering: '#b3121f', number: '3', numberColor: '#ffffff' },
  { main: '#0b6b3a', second: '#e8c547', lettering: '#0b6b3a', number: '11', numberColor: '#ffffff' },
  { main: '#111317', second: '#d4a640', lettering: '#111317', number: '22', numberColor: '#d4a640' },
  { main: '#f2f2f2', second: '#1f4fd1', lettering: '#ffffff', number: '5', numberColor: '#1f4fd1' },
  { main: '#ff5a1f', second: '#14161a', lettering: '#ffffff', number: '9', numberColor: '#14161a' },
  { main: '#5b2a86', second: '#2ec4b6', lettering: '#ffffff', number: '14', numberColor: '#ffffff' },
  { main: '#9aa3ad', second: '#d7263d', lettering: '#ffffff', number: '27', numberColor: '#d7263d' },
  { main: '#f5d000', second: '#1b3a8a', lettering: '#ffffff', number: '8', numberColor: '#1b3a8a' },
  { main: '#e83f8c', second: '#1a2440', lettering: '#ffffff', number: '31', numberColor: '#ffffff' },
];
