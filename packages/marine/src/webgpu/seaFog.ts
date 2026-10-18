import { Color, Vector3 } from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import { cameraPosition, clamp, dot, exp, float, fog, max, normalize, pmremTexture, positionWorld, pow, uniform, vec3 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface SeaFogOptions {
  /** How thick the haze is: things this many metres off are a third hidden, twice as far all but gone. Defaults to 12 km. */
  visibility?: number | undefined;
  /** How high the haze reaches, in metres: it thins from the sea up to here, and is gone above. Defaults to 500. */
  height?: number | undefined;
  /** Toward the sun, for its glow through the haze. Defaults to straight up. */
  sunDirection?: Vector3 | undefined;
  /** The sun's glow through the haze. Defaults to a warm white, 1.5. */
  sunGlow?: Color | undefined;
}

/** The fog's settings that can change as it runs: set their `value`. */
export interface SeaFogUniforms {
  visibility: { value: number };
  height: { value: number };
  sunDirection: { value: Vector3 };
  sunGlow: { value: Color };
}

/**
 * A haze over the sea for `scene.fogNode`, as Acerola's atmosphere makes it
 * (github.com/GarrettGunnell/Water): thicker the farther off, as e^-(distance / visibility)², and
 * thinner the higher up; coloured as the sky is the way one looks, brought down to the horizon,
 * so that the sea fades into the sky with no line between them, and glowing toward the sun. It
 * hides the sea's farthest reaches, where its patches' repeats show most.
 *
 *     scene.fogNode = seaFog(scene.environment, { sunDirection });
 */
export function seaFog(environment: Texture, options: SeaFogOptions = {}): Node & { uniforms: SeaFogUniforms } {
  const visibility = uniform(options.visibility ?? 12_000);
  const height = uniform(options.height ?? 500);
  const sunDirection = uniform(options.sunDirection?.clone().normalize() ?? new Vector3(0, 1, 0));
  const sunGlow = uniform(options.sunGlow ?? new Color(1, 0.95, 0.85).multiplyScalar(1.5));

  const fromEye = positionWorld.sub(cameraPosition);
  const distance = fromEye.length();
  const looking = normalize(fromEye);
  const clear = exp(distance.div(visibility).pow(2).negate());
  const above = pow(clamp(positionWorld.y.div(height), 0, 1), float(1 / 1.2));
  const amount = float(1).sub(clamp(clear.add(above), 0, 1));
  // the sky the way one looks, no lower than just over the horizon
  const toward = normalize(vec3(looking.x, max(looking.y, float(0)).add(0.03), looking.z));
  const sky = pmremTexture(environment, toward, float(0.25)) as Node;
  const glow = (sunGlow as Node).mul(pow(max(dot(looking, sunDirection), float(0)), 6));
  const node = fog(sky.add(glow), amount) as Node & { uniforms: SeaFogUniforms };
  node.uniforms = { visibility, height, sunDirection, sunGlow };
  return node;
}
