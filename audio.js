// 貫入音: Web Audio で「ピシッ」(ノイズの一瞬) と「チリン」(磁器っぽい非整数倍音) を合成する
let ctx = null;
let noise = null;
let enabled = false;
let last = 0;

/** ブラウザの自動再生制限があるので、必ずユーザー操作(クリック)から呼ぶこと */
export function setSoundEnabled(on) {
  enabled = on;
  if (on && !ctx) {
    ctx = new AudioContext();
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  }
  if (ctx) on ? ctx.resume() : ctx.suspend();
}

function ready() {
  if (!enabled || !ctx) return false;
  if (ctx.currentTime - last < 0.045) return false; // 鳴りすぎると静けさが消えるので間引く
  last = ctx.currentTime;
  return true;
}

export function pishi(volume = 1) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.7 + Math.random() * 0.8;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2500 + Math.random() * 5000;
  bp.Q.value = 6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.25 * volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
  src.stop(t + 0.1);
}

export function chirin(volume = 1) {
  if (!ready()) return;
  const t = ctx.currentTime, f = 2400 + Math.random() * 3200, dur = 0.6 + Math.random() * 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05 * volume, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(ctx.destination);
  for (const [ratio, amp] of [[1, 1], [2.76, 0.45], [5.4, 0.2]]) {
    if (f * ratio > 16000) continue; // 可聴域外 & エイリアス回避
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.value = f * ratio;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur);
  }
}
