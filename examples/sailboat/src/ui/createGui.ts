import GUI from 'lil-gui';
import type { Ocean, Wind } from '@eulerjs/marine';
import type { Sailboat } from '../boat/createSailboat.js';

export interface GuiTargets {
  sailboat: Sailboat;
  ocean: Ocean;
  wind: Wind;
}

/** Sliders for the boat, water and wind parameters. */
export function createGui({ sailboat, ocean, wind }: GuiTargets): GUI {
  const gui = new GUI({ title: 'Sailboat' });

  const boat = gui.addFolder('Boat');
  const massSetting = { mass: sailboat.body.mass };
  boat
    .add(massSetting, 'mass', 100, 50000, 1)
    .name('Mass (kg)')
    .onChange((mass: number) => sailboat.body.setMass(mass));
  boat.add(sailboat.foils.mainsail, 'area', 1, 100, 0.5).name('Mainsail area (m²)');
  boat.add(sailboat.foils.jib, 'area', 1, 100, 0.5).name('Jib area (m²)');

  const buoyancy = gui.addFolder('Buoyancy');
  buoyancy.add(sailboat.buoyancy, 'minimumLinearDrag', 0.001, 10, 0.01).name('Minimum drag');
  buoyancy.add(sailboat.buoyancy, 'minimumAngularDrag', 0.001, 10, 0.01).name('Minimum angular drag');
  buoyancy.add(sailboat.buoyancy, 'heaveDamping', 0, 20000, 10).name('Heave damping');
  buoyancy.add(sailboat.buoyancy, 'slamCoefficient', 0, 5, 0.05).name('Slam coefficient');
  buoyancy.add(ocean, 'density', 1, 10000, 0.5).name('Water density (kg/m³)');

  // the sea's own wind raises its waves; its direction follows the wind's
  const waves = ocean.waves;
  const sea = gui.addFolder('Sea');
  const seaSettings = { ...waves.sea, waveHeight: waves.significantWaveHeight };
  const changeSea = () => {
    waves.setSea({ windSpeed: seaSettings.windSpeed, heightScale: seaSettings.heightScale, choppiness: seaSettings.choppiness });
    seaSettings.waveHeight = waves.significantWaveHeight;
  };
  sea.add(seaSettings, 'windSpeed', 2, 30, 0.5).name('Wind over the sea (m/s)').onChange(changeSea);
  sea.add(seaSettings, 'heightScale', 0.1, 5, 0.05).name('Wave height ×').onChange(changeSea);
  sea.add(seaSettings, 'choppiness', 0, 2, 0.05).name('Choppiness').onChange(changeSea);
  sea.add(seaSettings, 'waveHeight').name('Significant height (m)').decimals(2).disable().listen();

  const air = gui.addFolder('Wind');
  air.add(wind, 'speed', 0, 200, 0.5).name('Wind speed (m/s)').listen();
  air.add(wind, 'density', 0.1, 100, 0.01).name('Air density (kg/m³)');

  return gui;
}
