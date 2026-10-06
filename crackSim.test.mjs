// 実行: node kannyu/crackSim.test.mjs  — 貫入ロジックの最小セルフチェック
import assert from 'node:assert/strict';
import { mulberry32, delaunay, buildNetwork, calcStressTensor, CrackSim } from './crackSim.js';

// 1) ドロネー (互換)
assert.ok(Array.isArray(delaunay([[0, 0], [1, 0], [1, 1], [0, 1]])));

// 2) ネットワーク & 応力テンソル計算
const isoNode = { sxx: 2.0, syy: 2.0, sxy: 0 };
const isoRes = calcStressTensor(isoNode);
assert.equal(isoRes.s1, 2.0);

const net = buildNetwork({ width: 800, height: 400, cell: 40, rng: mulberry32(1) });
assert.ok(net.nodes.length > 50, 'ノード数');

// 3) シミュレーション: 連続空間レイ伝播・90度直交T字交差
const sim = new CrackSim({ width: 800, height: 400, rng: mulberry32(7), levels: [
  { cell: 60, startTemp: 800, speed: 400, width: 2 },
  { cell: 25, startTemp: 400, speed: 300, width: 1 },
] });
const counts = { segment: 0, nucleate: 0, hit: 0, finish: 0 };
for (let i = 0; i < 3000; i++) {
  const temp = Math.max(20, 1230 - i * 2.0);
  for (const e of sim.step(1 / 60, temp)) counts[e.type] = (counts[e.type] || 0) + 1;
}
assert.ok(counts.nucleate > 10, '亀裂が起点化していない');
assert.ok(counts.hit > 5, '直交T字停止が発生していない');
assert.equal(sim.tips.length, 0, '冷却後も伸び続ける先端がある');
console.log('✅ Continuous Orthogonal T-Stop CrackSim ok', counts);
