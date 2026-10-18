import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';

/** Every material in the venue, made once and shared. */

const standard = (color: number, roughness = 0.7, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness });

export const materials = {
  lawn: standard(0x6f9a4e, 0.95),
  stone: standard(0xe8e2d6, 0.8),
  wood: standard(0xa9805a, 0.6),
  darkWood: standard(0x5e4130, 0.6),
  white: standard(0xf6f3ec, 0.5),
  cloth: standard(0xfdfbf7, 0.9),
  gold: standard(0xd4af37, 0.35, 0.8),
  silver: standard(0xc9ccd1, 0.3, 0.9),
  hedge: standard(0x3f6b34, 0.95),
  leaves: standard(0x4c7d3a, 0.9),
  bark: standard(0x5a4332, 0.95),
  // lit through, as canvas is from underneath with the sun on it
  canvas: new MeshStandardMaterial({ color: 0xfaf7f0, roughness: 0.9, side: DoubleSide, emissive: new Color(0xe8dcc6), emissiveIntensity: 0.55 }),
  carpet: standard(0xb8434e, 0.9),
  danceFloor: standard(0x9b7653, 0.35),
  water: new MeshPhysicalMaterial({ color: 0x8fc4dc, roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.85 }),
  glass: new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transmission: 0.9, thickness: 0.01, transparent: true, opacity: 0.45 }),
  // opaque: glass that transmits light shows only opaque things through it, and would hide see-through wine
  champagne: new MeshStandardMaterial({ color: 0xf0d77a, roughness: 0.15, emissive: new Color(0x6b5410), emissiveIntensity: 0.4 }),
  bottle: standard(0x204a2c, 0.2, 0.1),
  porcelain: standard(0xffffff, 0.25),
  icing: standard(0xfff7ee, 0.6),
  ribbon: standard(0xd8a0a8, 0.5),
  bulb: new MeshStandardMaterial({ color: 0xfff1c8, emissive: new Color(0xffd98a), emissiveIntensity: 2 }),
};

/** Pastel colours for flowers, wrapping paper and balloons. */
export const PASTELS = [0xf2b8c6, 0xf7d9a8, 0xbfd8f2, 0xd8c2ef, 0xc7e8c2, 0xfafafa];

const pastelMaterials = PASTELS.map((color) => standard(color, 0.6));

/** One of the pastel materials, going round them by `index`. */
export const pastel = (index: number): MeshStandardMaterial => pastelMaterials[index % pastelMaterials.length]!;
