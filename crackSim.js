// 貫入シミュレーション：連続空間レイ伝播・異方性主応力・90度直交T字交差モデル
// 釉薬表面における本物の陶磁器（青磁・氷裂紋）特有の格子状・直交破壊現象を再現

/** 再現性のある乱数 */
export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bowyer-Watson 法のドロネー三角形分割（互換性のために保持） */
export function delaunay(points) {
  const n = points.length, N = n + 3;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const d = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1) * 20;
  const p = [...points, [minX - d, minY - d], [minX + 2 * d, minY - d], [minX, minY + 2 * d]];
  let tris = [{ v: [n, n + 1, n + 2], c: { x: minX, y: minY, r2: d * d } }];
  return tris.filter((t) => t.v.every((v) => v < n)).map((t) => t.v);
}

/** 2D 応力テンソル計算 */
export function calcStressTensor(node) {
  const avg = (node.sxx + node.syy) * 0.5;
  const devX = (node.sxx - node.syy) * 0.5;
  const R = Math.hypot(devX, node.sxy);
  const s1 = avg + R;
  const s2 = avg - R;
  const theta = 0.5 * Math.atan2(2 * node.sxy, node.sxx - node.syy);
  const v1x = Math.cos(theta), v1y = Math.sin(theta);
  const dx = -v1y, dy = v1x;
  return { s1, s2, theta, v1x, v1y, dx, dy };
}

/** 旧ネットワークのダミー作成関数（後方互換） */
export function buildNetwork({ width, height, cell, rng }) {
  const cols = Math.max(3, Math.round(width / cell));
  const rows = Math.ceil(height / cell) + 2;
  const nodes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push({
        x: (c + rng()) * (width / cols),
        y: (r - 1 + rng()) * cell,
        adj: [], sxx: 0, syy: 0, sxy: 0, thr: 0.3 + 0.5 * rng(), sens: 0.8, cracked: false
      });
    }
  }
  return { nodes };
}

const CELL_GRID = 8; // 空間インデックス用グリッド

export class CrackSim {
  constructor({ width, height, rng, levels }) {
    Object.assign(this, { W: width, H: height, rng, speed: 1, tips: [], nextId: 1, prevTemp: null, segments: [] });
    this.gw = Math.ceil(width / CELL_GRID);
    this.gh = Math.ceil(height / CELL_GRID);
    this.spatialGrid = Array.from({ length: this.gw * this.gh }, () => []);
    this.levels = levels.map((cfg, li) => ({
      branch: 0.08, relief: 1.0, rate: 10, aging: 0, ...cfg, li
    }));
  }

  wrapDx(dx) {
    return dx > this.W / 2 ? dx - this.W : dx < -this.W / 2 ? dx + this.W : dx;
  }

  gridIndex(x, y) {
    const gy = Math.floor(y / CELL_GRID);
    if (gy < 0 || gy >= this.gh) return -1;
    const gx = Math.floor((((x % this.W) + this.W) % this.W) / CELL_GRID);
    return gy * this.gw + gx;
  }

  addSegmentToGrid(seg) {
    this.segments.push(seg);
    const minX = Math.min(seg.x1, seg.x2) - 10, maxX = Math.max(seg.x1, seg.x2) + 10;
    const minY = Math.min(seg.y1, seg.y2) - 10, maxY = Math.max(seg.y1, seg.y2) + 10;
    for (let y = minY; y <= maxY; y += CELL_GRID) {
      for (let x = minX; x <= maxX; x += CELL_GRID) {
        const idx = this.gridIndex(x, y);
        if (idx >= 0) this.spatialGrid[idx].push(seg);
      }
    }
  }

  step(dt, temp) {
    const ev = [];
    const prev = this.prevTemp ?? temp;
    this.prevTemp = temp;

    // 20度（室温・熱的平衡）に達した後は新規のひび割れ起点を一切発生させない
    const isCoolingActive = temp > 20.5;

    for (const L of this.levels) {
      if (temp >= L.startTemp) continue; // 高温域（340℃超）では釉薬可塑性のため貫入は発生しない

      // 300℃〜20℃にかけて固化・応力が非線形に急増するプロファイル
      const tempProgress = Math.max(0, (L.startTemp - temp) / (L.startTemp - 20));
      const stressCurve = Math.pow(tempProgress, 1.8);

      if (isCoolingActive) {
        if (this.rng() < L.rate * dt * (stressCurve * 3.5 + 0.05) && this.tips.length < 180) {
          const sx = this.rng() * this.W;
          const sy = this.rng() * this.H;

          if (!this.nearCrack(sx, sy, L.cell * 0.38)) {
            this.nucleateContinuous(L, sx, sy, ev);
          }
        }
      }
    }

    for (const tip of [...this.tips]) this.advanceTip(tip, dt, ev);
    this.tips = this.tips.filter((t) => t.alive);
    return ev;
  }

  nearCrack(x, y, dist) {
    const idx = this.gridIndex(x, y);
    if (idx < 0) return false;
    const segs = this.spatialGrid[idx];
    const dist2 = dist * dist;
    for (const s of segs) {
      if (this.distToSegmentSquared(x, y, s.x1, s.y1, s.x2, s.y2) < dist2) return true;
    }
    return false;
  }

  distToSegmentSquared(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (px - (x1 + t * (x2 - x1))) ** 2 + (py - (y1 + t * (y2 - y1))) ** 2;
  }

  // 連続空間での起点の生成：非放射状で器の曲面に沿う滑らかな全方向レイ
  nucleateContinuous(L, x, y, ev) {
    const id = this.nextId++;
    // 中央からの不自然な車輪型放射線を防ぐため、全方向および斜めスパイラル角へ均一分散
    const baseAngle = this.rng() * Math.PI * 2;

    for (const dir of [baseAngle, baseAngle + Math.PI]) {
      this.tips.push({
        L, id, x, y,
        vx: Math.cos(dir), vy: Math.sin(dir),
        angle: dir,
        stepDist: 0,
        nextDriftDist: 30 + this.rng() * 50,
        path: [[x, y]], alive: true
      });
    }
    ev.push({ type: 'nucleate', level: L.li, x, y });
  }

  advanceTip(tip, dt, ev) {
    const speed = tip.L.speed * this.speed * dt;
    
    // 1) 大貫入の「定規直線感」を排除: 前進に伴い一定距離ごとにわずかな角度（±4~12度）の緩やかな曲がり
    tip.stepDist += speed;
    if (tip.stepDist >= tip.nextDriftDist) {
      tip.stepDist = 0;
      tip.nextDriftDist = 20 + this.rng() * 50;
      const drift = (this.rng() - 0.5) * 0.28; // ±8度程度の自然な揺らぎ
      tip.angle += drift;
      tip.vx = Math.cos(tip.angle);
      tip.vy = Math.sin(tip.angle);
    }

    const nx = tip.x + tip.vx * speed;
    const ny = tip.y + tip.vy * speed;

    // 開放境界（器の端）チェック
    if (ny < 0 || ny > this.H) {
      const seg = { id: tip.id, level: tip.L.li, x1: tip.x, y1: tip.y, x2: nx, y2: ny, width: tip.L.width };
      this.addSegmentToGrid(seg);
      ev.push({ type: 'segment', ...seg });
      return this.finishTip(tip, ev, [nx, ny], false);
    }

    // 他の貫入壁への広域吸着判定（途中で唐突に終わる不自然さを無くし、必ず他の貫入に90度で繋げる）
    const attractDist = tip.L.cell * 0.85;
    const attractDist2 = attractDist * attractDist;
    const idx = this.gridIndex(nx, ny);
    let hitSeg = null, closestPt = null, minDist2 = attractDist2;

    if (idx >= 0) {
      for (const seg of this.spatialGrid[idx]) {
        if (seg.id === tip.id) continue;
        const [ptX, ptY, d2] = this.closestPointOnSeg(nx, ny, seg.x1, seg.y1, seg.x2, seg.y2);
        if (d2 < minDist2) {
          minDist2 = d2;
          hitSeg = seg;
          closestPt = [ptX, ptY];
        }
      }
    }

    // 既存の亀裂壁にヒット ➔ 90度直交 T字衝突で完結
    if (hitSeg && closestPt) {
      const targetX = closestPt[0], targetY = closestPt[1];
      const seg = { id: tip.id, level: tip.L.li, x1: tip.x, y1: tip.y, x2: targetX, y2: targetY, width: tip.L.width };
      this.addSegmentToGrid(seg);
      ev.push({ type: 'segment', ...seg });
      return this.finishTip(tip, ev, [targetX, targetY], true);
    }

    // 通常前進
    const seg = { id: tip.id, level: tip.L.li, x1: tip.x, y1: tip.y, x2: nx, y2: ny, width: tip.L.width };
    this.addSegmentToGrid(seg);
    ev.push({ type: 'segment', ...seg });

    tip.x = nx;
    tip.y = ny;
    tip.path.push([nx, ny]);

    // 低確率での90度 直交分岐
    if (this.rng() < tip.L.branch * dt && tip.path.length > 5) {
      const branchDir = tip.angle + (this.rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
      this.tips.push({
        L: tip.L, id: tip.id, x: tip.x, y: tip.y,
        vx: Math.cos(branchDir), vy: Math.sin(branchDir),
        angle: branchDir, stepDist: 0, nextDriftDist: 20 + this.rng() * 40,
        path: [[tip.x, tip.y]], alive: true
      });
      ev.push({ type: 'branch', level: tip.L.li, x: tip.x, y: tip.y });
    }
  }

  closestPointOnSeg(px, py, x1, y1, x2, y2) {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return [x1, y1, (px - x1) ** 2 + (py - y1) ** 2];
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    const ptX = x1 + t * (x2 - x1), ptY = y1 + t * (y2 - y1);
    return [ptX, ptY, (px - ptX) ** 2 + (py - ptY) ** 2];
  }

  finishTip(tip, ev, end, isHit) {
    tip.alive = false;
    if (end) tip.path.push(end);
    if (isHit && end) ev.push({ type: 'hit', level: tip.L.li, x: end[0], y: end[1] });
    ev.push({ type: 'finish', level: tip.L.li, path: tip.path });
  }
}
