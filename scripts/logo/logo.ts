// The eulerjs logo, drawn in three.js: Euler's e, in the math italic TeX sets it in, standing on
// the three.js logo laid flat as its bed.
//
//   npx vite scripts/logo         orbit it in the browser
//   ?size=512                     a still, square, on a transparent background, for exporting:
//                                 window.exportLogo() gives it as a PNG data URL
import {
  BufferAttribute,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  Shape,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// U+1D452 MATHEMATICAL ITALIC SMALL E from Latin Modern Math, in font units (1000 to the em, y up).
// Latin Modern Math: B. Jackowski, P. Strzelczyk and P. Pianowski, GUST Font License.
const GLYPH =
  'M430 107C430 113 424 120 418 120C413 120 411 118 405 110C326 11 217 11 205 11C127 11 118 95 118 127' +
  'C118 139 119 170 134 231H187C216 231 290 233 340 254C410 284 415 343 415 357C415 401 377 442 308 442' +
  'C197 442 46 345 46 170C46 68 105 -11 203 -11C346 -11 430 95 430 107Z' +
  'M382 357C382 253 222 253 181 253H140C179 405 282 420 308 420C355 420 382 391 382 357Z';
const GLYPH_BOTTOM = -11;
const GLYPH_TOP = 442;

// the brand's sea, deep to shallow, as on the site
const DEEP_SEA = new Color('#1f6582');
const SEA = new Color('#2f7fd8');
const SHALLOW_SEA = new Color('#33b3aa');

const BED_SIDE = 2.7;
const BED_THICKNESS = 0.07;
const LINE_WIDTH = 0.045;
const LINE_HEIGHT = 0.014;
const LETTER_HEIGHT = 1.25;
const LETTER_DEPTH = 0.2;

const parameters = new URLSearchParams(location.search);
const exportSize = Number(parameters.get('size') ?? 0);
const exporting = exportSize > 0;
if (exporting) document.body.classList.add('export');

const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
// exports render at twice their size and are scaled down, for edges finer than the multisampling's
const renderSize = exporting ? exportSize * 2 : Math.min(innerWidth, innerHeight);
renderer.setPixelRatio(exporting ? 1 : devicePixelRatio);
renderer.setSize(renderSize, renderSize);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const environmentMaps = new PMREMGenerator(renderer);
scene.environment = environmentMaps.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.65;

const sun = new DirectionalLight(0xffffff, 2.6);
sun.position.set(-3, 6, 1.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -2.5;
sun.shadow.camera.right = 2.5;
sun.shadow.camera.top = 2.5;
sun.shadow.camera.bottom = -2.5;
sun.shadow.radius = 6;
sun.shadow.bias = -0.0005;
scene.add(sun);

type Triangle = [Vector2, Vector2, Vector2];

/** The corners of an equilateral triangle of the given side, about the origin of the x/y plane, one corner up. */
function equilateral(side: number): Triangle {
  const circumradius = side / Math.sqrt(3);
  const corner = (index: number) => {
    const angle = Math.PI / 2 + (index * 2 * Math.PI) / 3;
    return new Vector2(circumradius * Math.cos(angle), circumradius * Math.sin(angle));
  };
  return [corner(0), corner(1), corner(2)];
}

function centroid(corners: Vector2[]): Vector2 {
  return corners.reduce((sum, corner) => sum.add(corner), new Vector2()).divideScalar(corners.length);
}

/** An equilateral triangle's outline, stroked to the given width, with mitred corners. */
function strokedTriangle(corners: Triangle, width: number): Shape {
  const middle = centroid(corners);
  const inradius = corners[0].distanceTo(middle) / 2;
  const scaled = (factor: number) => corners.map((corner) => corner.clone().sub(middle).multiplyScalar(factor).add(middle));
  const outer = scaled((inradius + width / 2) / inradius);
  const inner = scaled((inradius - width / 2) / inradius).reverse();
  const shape = new Shape(outer);
  shape.holes.push(new Shape(inner));
  return shape;
}

/** A straight stroke of the given width from one point to another, square at its ends. */
function stroke(from: Vector2, to: Vector2, width: number): Shape {
  const across = to.clone().sub(from).normalize().rotateAround(new Vector2(), Math.PI / 2).multiplyScalar(width / 2);
  return new Shape([from.clone().add(across), to.clone().add(across), to.clone().sub(across), from.clone().sub(across)]);
}

/**
 * The three.js logo, flat: a triangle cut into sixteen, as mrdoob's drawing has it, its middle
 * triangle and the middle triangles of the four that makes. Lies in the x/z plane, its top at y = 0.
 */
function createBed(): Group {
  const bed = new Group();
  const outline = equilateral(BED_SIDE);
  // the grid's lines run parallel to each side, a quarter, a half and three quarters of the way across;
  // their square ends lie under the outline's stroke
  const strokes = [strokedTriangle(outline, LINE_WIDTH)];
  const [first, second, third] = outline;
  const sides: Triangle[] = [
    [first, second, third],
    [second, third, first],
    [third, first, second],
  ];
  for (const [start, end, opposite] of sides) {
    for (const fraction of [0.25, 0.5, 0.75]) {
      strokes.push(stroke(start.clone().lerp(opposite, fraction), end.clone().lerp(opposite, fraction), LINE_WIDTH));
    }
  }

  const slabMaterial = new MeshStandardMaterial({ color: 0xe4e8ec, roughness: 0.6 });
  const slabBevel = 0.03;
  const slab = new Mesh(
    new ExtrudeGeometry(new Shape(equilateral(BED_SIDE + 3 * LINE_WIDTH - 2 * slabBevel)), {
      depth: BED_THICKNESS - 2 * slabBevel,
      bevelThickness: slabBevel,
      bevelSize: slabBevel,
      bevelSegments: 4,
    }),
    slabMaterial,
  );
  slab.position.z = -BED_THICKNESS + slabBevel;
  slab.receiveShadow = true;

  const lineMaterial = new MeshStandardMaterial({ color: 0x15181c, roughness: 0.45 });
  const lines = new Mesh(
    new ExtrudeGeometry(strokes, { depth: LINE_HEIGHT, bevelEnabled: false }),
    lineMaterial,
  );
  lines.receiveShadow = true;

  // drawn in x/y with z up out of the top; turned so the top faces +y
  const flat = new Group();
  flat.add(slab, lines);
  flat.rotation.x = -Math.PI / 2;
  bed.add(flat);
  return bed;
}

/** Euler's e, extruded, its baseline at y = 0, centred on x and z, coloured deep to shallow sea. */
function createLetter(): Mesh {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${GLYPH}"/></svg>`;
  const shapes = new SVGLoader().parse(svg).paths.flatMap((path) => SVGLoader.createShapes(path));
  const fontUnitsPerWorld = (GLYPH_TOP - GLYPH_BOTTOM) / LETTER_HEIGHT;
  const bevel = 14;
  const geometry = new ExtrudeGeometry(shapes, {
    depth: LETTER_DEPTH * fontUnitsPerWorld - 2 * bevel,
    bevelThickness: bevel,
    bevelSize: bevel * 0.7,
    bevelSegments: 5,
    curveSegments: 32,
  });
  geometry.scale(1 / fontUnitsPerWorld, 1 / fontUnitsPerWorld, 1 / fontUnitsPerWorld);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  geometry.translate(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
  geometry.computeVertexNormals();

  // the gradient runs from the bottom left to the top right, as the site's does
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const direction = new Vector3(1, 1.2, 0).normalize();
  const point = new Vector3();
  const span = LETTER_HEIGHT * 0.95;
  const color = new Color();
  for (let index = 0; index < positions.count; index++) {
    point.fromBufferAttribute(positions, index);
    const along = Math.min(Math.max(point.dot(direction) / span, 0), 1);
    if (along < 0.55) color.copy(DEEP_SEA).lerp(SEA, along / 0.55);
    else color.copy(SEA).lerp(SHALLOW_SEA, (along - 0.55) / 0.45);
    color.toArray(colors, index * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const material = new MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.28,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const letter = new Mesh(geometry, material);
  letter.castShadow = true;
  letter.receiveShadow = true;
  return letter;
}

const bed = createBed();
// a corner toward the viewer and a little round, as the three.js drawing has it
bed.rotation.y = Math.PI - 0.32;
scene.add(bed);

const letter = createLetter();
letter.rotation.y = 0.12;
scene.add(letter);

const camera = new PerspectiveCamera(20, 1, 0.1, 50);
const target = new Vector3(0, 0.42, 0);
camera.position.set(-0.4, 3.1, 5.6);
fitCamera(worldVertices(scene), 0.06);

/** Every vertex of every mesh in the scene, where it is in the world. */
function worldVertices(root: Scene): Vector3[] {
  root.updateMatrixWorld(true);
  const vertices: Vector3[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      vertices.push(new Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld));
    }
  });
  return vertices;
}

/** Moves the camera along its line of sight, and across it, until the points just fill the view. */
function fitCamera(corners: Vector3[], margin: number): void {
  const projected = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  for (let iteration = 0; iteration < 30; iteration++) {
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let left = Infinity;
    let rightmost = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    for (const corner of corners) {
      projected.copy(corner).project(camera);
      left = Math.min(left, projected.x);
      rightmost = Math.max(rightmost, projected.x);
      bottom = Math.min(bottom, projected.y);
      top = Math.max(top, projected.y);
    }
    const distance = camera.position.distanceTo(target);
    const halfHeight = distance * Math.tan((camera.fov * Math.PI) / 360);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    const shift = right
      .multiplyScalar(((left + rightmost) / 2) * halfHeight)
      .add(up.multiplyScalar(((bottom + top) / 2) * halfHeight));
    target.add(shift);
    camera.position.add(shift);
    const extent = Math.max(rightmost - left, top - bottom) / 2;
    const offset = camera.position.clone().sub(target);
    camera.position.copy(target).add(offset.multiplyScalar(extent / (1 - margin)));
  }
  camera.lookAt(target);
}

const controls = exporting ? undefined : new OrbitControls(camera, renderer.domElement);
if (controls) {
  controls.target.copy(target);
  controls.enableDamping = true;
}

function render(): void {
  controls?.update();
  renderer.render(scene, camera);
}

if (exporting) {
  render();
  const exportLogo = (): string => {
    const canvas = document.createElement('canvas');
    canvas.width = exportSize;
    canvas.height = exportSize;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(renderer.domElement, 0, 0, exportSize, exportSize);
    return canvas.toDataURL('image/png');
  };
  Object.assign(window, { exportLogo });
} else {
  renderer.setAnimationLoop(render);
}
