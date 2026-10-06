import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CrackSim, mulberry32 } from './crackSim.js';
import { setSoundEnabled, pishi, chirin } from './audio.js';

const W = 2048, H = 1024; // 貫入テクスチャ解像度（器の UV 展開面）
const LEVELS = [
  { cell: 110, startTemp: 340, speed: 600, width: 0.85, branch: 0.05, rate: 45 }, // 大貫入（340℃以下で開始）
  { cell: 18, startTemp: 250, speed: 480, width: 0.55, branch: 0.15, rate: 280 }, // 小貫入（250℃以下で爆発的に一気に増加）
];
const GLAZES = {
  seiji: { base: '#86a897', mottle: ['#adc9b8', '#668a7a'], fresh: 'rgba(236,246,238,0.4)', ink: '#3b2a1c', blend: 'multiply', roughness: 0.4 },
  kuroraku: { base: '#17140f', mottle: ['#2c261e', '#080706'], fresh: 'rgba(150,138,120,0.3)', ink: '#a07d4e', blend: 'screen', roughness: 0.5 },
};
const COOL_TAU = 11; // 冷却の時定数(秒): 温度 = 20 + 1210·e^(-t/τ)

const el = (id) => document.getElementById(id);
const wrapDx = (d) => ((d % W) + W * 1.5) % W - W / 2;

// ---------- オフスクリーン Canvas（テクスチャの元） ----------
function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return [c, c.getContext('2d')];
}
const [colorCanvas, colorCtx] = makeCanvas(); // map: 釉色 + 走りたてのひび + 墨染め
const [normalCanvas, normalCtx] = makeCanvas(); // clearcoatNormalMap: ひびの段差
const [inkCanvas, inkCtx] = makeCanvas(); // 墨の「源」= 走りきったひびの線
el('unwrap-slot').append(colorCanvas);

// 周方向の継ぎ目(x=0/W)をまたぐ図形は W ずらした位置にも描いて、器を一周しても縫い目が出ないようにする
function wrapped(ctx, minX, maxX, draw) {
  const pad = 24;
  for (let k = Math.floor((minX - pad) / W); k <= Math.floor((maxX + pad) / W); k++) {
    ctx.save();
    ctx.translate(-k * W, 0);
    draw();
    ctx.restore();
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// ---------- Three.js シーン ----------
const renderer = new THREE.WebGLRenderer({ canvas: el('stage'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35; // 映り込みは控えめに。主役は斜光

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
camera.position.set(0.9, 2.7, 5.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.2, 0.45, 0); // 右の操作盤に被らないよう器を少し左に置く
Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: 2.2, maxDistance: 7, maxPolarAngle: 1.48 });

// スマホ操作時に3D視界を広げるため、茶碗を触ったら自動で操作盤をたたむ
controls.addEventListener('start', () => {
  if (innerWidth <= 760 && panel && panel.classList.contains('is-open')) {
    panel.classList.remove('is-open');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
      const txt = toggleBtn.querySelector('.toggle-text');
      if (txt) txt.textContent = '操作盤';
    }
  }
});

// 茶碗: 高台 → 胴 → 口縁 → 見込み を1本の断面線にして回転体に。UV の v = 断面に沿った距離
function makeBowlGeometry() {
  const profile = [[0, 0.07], [0.28, 0.07], [0.31, 0], [0.38, 0], [0.4, 0.1], [0.47, 0.15], [0.78, 0.36], [0.97, 0.68],
    [1.04, 1.0], [1.05, 1.1], [1.02, 1.14], [0.98, 1.1], [0.93, 0.82], [0.74, 0.45], [0.45, 0.25], [0, 0.2]];
  const curve = new THREE.SplineCurve(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const pts = curve.getSpacedPoints(240).map((p) => p.setX(Math.max(0.001, p.x)));
  return new THREE.LatheGeometry(pts, 200);
}

const colorTex = new THREE.CanvasTexture(colorCanvas);
colorTex.colorSpace = THREE.SRGBColorSpace;
const normalTex = new THREE.CanvasTexture(normalCanvas);
for (const t of [colorTex, normalTex]) {
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
}

const material = new THREE.MeshPhysicalMaterial({
  map: colorTex,
  roughness: 0.4,
  normalMap: normalTex, // 素地側にもうっすら段差
  normalScale: new THREE.Vector2(0.2, 0.2),
  clearcoat: 1, // 表層のガラス質（釉）
  clearcoatRoughness: 0.08,
  clearcoatNormalMap: normalTex, // ひびの溝で法線を落ち込ませ、光が当たると繊細にハイライト
  clearcoatNormalScale: new THREE.Vector2(1.0, 1.0),
  emissive: new THREE.Color('#ff5a1e'), // 窯出し直後の赤熱
});

const bowl = new THREE.Mesh(makeBowlGeometry(), material);
bowl.castShadow = bowl.receiveShadow = true;
scene.add(bowl);

const ground = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.ShadowMaterial({ opacity: 0.55 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 斜光の Key Light: 低い角度から柔らかく当て、曲面とひびの段差に陰影をつくる
const key = new THREE.SpotLight('#ffe2bf', 90, 0, 0.42, 0.85, 2);
key.position.set(3.6, 1.6, 2.2);
key.target.position.set(0, 0.5, 0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
scene.add(key, key.target);

const rim = new THREE.DirectionalLight('#bcd2ff', 0.5); // 背後からの冷たい輪郭光
rim.position.set(-3, 2.5, -3);
scene.add(rim);

// ---------- 貫入の描画 ----------
let glaze = GLAZES.seiji;
let sim, seed, elapsed, crackCount, hasInk, inkTimer = 0, speed = 1;
let colorDirty = true, normalDirty = true;

function fillBase() {
  colorCtx.fillStyle = glaze.base;
  colorCtx.fillRect(0, 0, W, H);
  // 釉ムラ: 柔らかい斑点を薄く重ねる（釉の微小な不均一性の見た目）
  const rng = mulberry32(seed + 1);
  colorCtx.globalAlpha = 0.12;
  for (let i = 0; i < 260; i++) {
    const x = rng() * W, y = rng() * H, r = 30 + rng() * 160;
    const g = colorCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, glaze.mottle[i % 2]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    colorCtx.fillStyle = g;
    wrapped(colorCtx, x - r, x + r, () => colorCtx.fillRect(x - r, y - r, r * 2, r * 2));
  }
  colorCtx.globalAlpha = 1;
  normalCtx.fillStyle = 'rgb(128,128,255)'; // 法線 (0,0,1) = 平らな面
  normalCtx.fillRect(0, 0, W, H);
  inkCtx.clearRect(0, 0, W, H);
}

// 伸びた区間を描く: 垂直な割れ目の断層面（一方向へ傾いたステップ法線）
function drawSegment(e) {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.hypot(dx, dy);
  if (len < 1e-3) return;
  const px = -dy / len, py = dx / len, tilt = 0.65, nz = Math.sqrt(1 - tilt * tilt);
  // Canvas は y 下向き、接空間の法線は v 上向きなので y を反転してエンコード
  // 垂直な亀裂の断層壁面: 中心線に片側傾斜の法線を乗せ、受光側は白く反射・背光側は自重影を作る
  const enc = (nx, ny) => `rgb(${(128 + 127 * nx) | 0},${(128 + 127 * ny) | 0},${(128 + 127 * nz) | 0})`;
  const minX = Math.min(e.x1, e.x2), maxX = Math.max(e.x1, e.x2);

  wrapped(normalCtx, minX, maxX, () => {
    normalCtx.lineWidth = Math.max(0.6, e.width * 0.4);
    normalCtx.lineCap = 'round';
    normalCtx.strokeStyle = enc(px * tilt, -py * tilt);
    line(normalCtx, e.x1, e.y1, e.x2, e.y2);
  });
  wrapped(colorCtx, minX, maxX, () => {
    colorCtx.strokeStyle = glaze.fresh;
    colorCtx.lineWidth = Math.max(0.4, e.width * 0.25);
    colorCtx.lineCap = 'butt';
    line(colorCtx, e.x1, e.y1, e.x2, e.y2);
  });
  colorDirty = normalDirty = true;
}

// 走りきったひびを墨の源に登録（継ぎ目またぎは座標を連続化してから描く）
function inkPath(path, width) {
  if (path.length < 2) return;
  const pts = [path[0]];
  for (let i = 1; i < path.length; i++) pts.push([pts[i - 1][0] + wrapDx(path[i][0] - pts[i - 1][0]), path[i][1]]);
  const xs = pts.map((p) => p[0]);
  wrapped(inkCtx, Math.min(...xs), Math.max(...xs), () => {
    inkCtx.strokeStyle = glaze.ink;
    inkCtx.lineWidth = width * 0.5;
    inkCtx.lineJoin = 'round';
    inkCtx.beginPath();
    pts.forEach(([x, y], i) => (i ? inkCtx.lineTo(x, y) : inkCtx.moveTo(x, y)));
    inkCtx.stroke();
  });
  hasInk = true;
}

// 墨の滲み: 源をランダム半径でぼかして薄く重ね続ける → 古いひびほど濃く、広く染みる（ガウシアンの積み重ね）
function seepInk() {
  const r = 0.6 + Math.random() * 3, pad = 24;
  colorCtx.save();
  colorCtx.globalCompositeOperation = glaze.blend;
  colorCtx.globalAlpha = 0.03;
  colorCtx.filter = `blur(${r.toFixed(1)}px)`;
  colorCtx.drawImage(inkCanvas, 0, 0);
  colorCtx.drawImage(inkCanvas, W - pad, 0, pad, H, -pad, 0, pad, H); // 継ぎ目の両側もぼかしを回り込ませる
  colorCtx.drawImage(inkCanvas, 0, 0, pad, H, W, 0, pad, H);
  colorCtx.restore();
  colorDirty = true;
}

function handle(e) {
  if (e.type === 'segment') drawSegment(e);
  else if (e.type === 'nucleate') { crackCount++; pishi(e.level ? 0.45 : 1); }
  else if (e.type === 'branch') chirin(e.level ? 0.5 : 1);
  else if (e.type === 'hit' && Math.random() < 0.3) pishi(0.2);
  else if (e.type === 'finish') inkPath(e.path, LEVELS[e.level].width);
}

function fire() {
  seed = Math.floor(Math.random() * 1e9);
  sim = new CrackSim({ width: W, height: H, rng: mulberry32(seed), levels: LEVELS });
  elapsed = 10.0; // 420℃付近からスタート。500℃以上ではひびが入らず、300℃以下から一気に急増する現象を観察できる
  crackCount = 0;
  hasInk = false;
  material.roughness = glaze.roughness;
  fillBase();
  colorDirty = normalDirty = true;
}

// ---------- HUD ----------
const hud = { temp: el('temp'), phase: el('phase'), count: el('count'), elapsed: el('elapsed') };
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function updateHud(temp) {
  const isRoomTemp = temp <= 21;
  setText(hud.temp, String(Math.max(20, Math.round(temp))));
  setText(hud.phase, temp > LEVELS[0].startTemp ? '徐冷中 — 釉薬層固化 (貫入前)'
    : temp > LEVELS[1].startTemp ? '大貫入 — 300℃台の破壊開始'
      : isRoomTemp ? '室温安定 — ひび割れ完了' : '小貫入 — 一気に急増中');
  setText(hud.count, String(crackCount));
  const s = Math.floor(elapsed);
  setText(hud.elapsed, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

// ---------- 操作 ----------
for (const [id, name] of [['glaze-seiji', 'seiji'], ['glaze-kuroraku', 'kuroraku']]) {
  el(id).addEventListener('click', () => {
    glaze = GLAZES[name];
    for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-pressed', String(b.id === id));
    fire();
  });
}
el('speed').addEventListener('input', (ev) => {
  speed = Number(ev.target.value);
  el('speed-out').textContent = `×${speed.toFixed(2).replace(/0$/, '')}`;
});
el('sound').addEventListener('click', (ev) => {
  const on = ev.currentTarget.getAttribute('aria-pressed') !== 'true';
  ev.currentTarget.setAttribute('aria-pressed', String(on));
  ev.currentTarget.textContent = on ? '貫入音を止める' : '貫入音を聴く';
  setSoundEnabled(on);
});
el('refire').addEventListener('click', fire);

const panel = el('panel');
const toggleBtn = el('panel-toggle');
if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('is-open');
    toggleBtn.setAttribute('aria-expanded', String(isOpen));
    const txt = toggleBtn.querySelector('.toggle-text');
    if (txt) txt.textContent = isOpen ? '操作盤を閉じる' : '操作盤';
  });
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();

  // スマホ時は器を画面中央に配置、PC時は右の操作盤を考慮してやや左寄りに配置
  if (innerWidth <= 760) {
    controls.target.set(0, 0.45, 0);
  } else {
    controls.target.set(0.2, 0.45, 0);
  }
}
addEventListener('resize', resize);
resize();
fire();

// ---------- ループ ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const sdt = dt * speed;
  elapsed += sdt;
  const temp = 20 + 1210 * Math.exp(-elapsed / COOL_TAU);

  for (const e of sim.step(sdt, temp)) handle(e);
  inkTimer += sdt;
  if (hasInk && inkTimer > 0.2) { inkTimer = 0; seepInk(); }

  if (colorDirty) { colorTex.needsUpdate = true; colorDirty = false; }
  if (normalDirty) { normalTex.needsUpdate = true; normalDirty = false; }

  material.emissiveIntensity = Math.max(0, (temp - 480) / 750) ** 2 * 1.6; // 赤熱 → 冷めると消える
  bowl.rotation.y += dt * 0.08; // 器を回してハイライトがひびを撫でるように
  controls.update();
  renderer.render(scene, camera);
  updateHud(temp);
});
