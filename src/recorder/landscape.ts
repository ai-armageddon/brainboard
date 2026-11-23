// A static engraved landscape for the monitor while there is no video feed.
export function drawLandscape(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#101f2a');
  sky.addColorStop(.58, '#344450');
  sky.addColorStop(1, '#76675f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  let seed = 117;
  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i < 370; i++) {
    ctx.fillStyle = `rgba(245,225,198,${random() * .45})`;
    ctx.fillRect(random() * w, random() * h * .64, 1.8, 1.8);
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(w * .66, h * .37, h * .20, 0, 2 * Math.PI);
  ctx.clip();
  const sun = ctx.createLinearGradient(0, h * .18, 0, h * .56);
  sun.addColorStop(0, '#ffdcab');
  sun.addColorStop(.58, '#ffa17b');
  sun.addColorStop(1, '#db7865');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  for (let y = h * .20; y < h * .58; y += 7) {
    ctx.fillStyle = 'rgba(33,42,46,.5)';
    ctx.fillRect(0, y, w, Math.max(.65, (y / h - .20) * 10));
  }
  ctx.restore();
  const ridges = [
    { base: .55, amp: .10, phase: 2, fill: '#3e4d51', line: '#d0aa8e' },
    { base: .66, amp: .17, phase: .5, fill: '#293d42', line: '#b19e86' },
    { base: .77, amp: .14, phase: 4.3, fill: '#203338', line: '#83988d' },
    { base: .95, amp: .15, phase: 1.25, fill: '#14282e', line: '#739186' },
  ];
  for (const ridge of ridges) {
    function elevation(x: number, depth: number) {
      const t = x / w;
      const a = t * 8.6 + ridge.phase + .002 * depth;
      const wave = .74 * Math.sin(a) + .28 * Math.sin(a * 2.15 + 1.7) + .16 * Math.sin(a * 4.1) + .035 * Math.sin(a * 13);
      return h * (ridge.base - ridge.amp * wave) + depth;
    }
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) ctx.lineTo(x, elevation(x, 0));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = ridge.fill;
    ctx.fill();
    ctx.strokeStyle = ridge.line;
    ctx.lineWidth = 1.25;
    for (let depth = 0; depth < h * .58; depth += 6.5) {
      ctx.globalAlpha = .68 * Math.exp(-depth / 145);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) ctx.lineTo(x, elevation(x, depth));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
