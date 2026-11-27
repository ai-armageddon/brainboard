// The board recorder: video from the same camera that takes screenshots. Frame the screen, an area, the selection
// or a saved view, press record, and work on the board as usual. It films this tab, keeps only what's inside the
// frame (on a gradient backdrop if you picked a look), and offers the finished video to save.
import { session } from './net';
import { icon } from './icons';
import { toast } from './ui';
import { keyLabel } from './keys';
import { bindCaptureSave, clock, dismissCaptureCard, openMedia, saveMedia, type Backdrop, type MediaItem } from './media';
import type { Box } from './types';

export interface RecordOpts {
  /** What to film, in screen pixels. It stays put on screen: pan and zoom the board inside it. */
  rect: Box;
  /** The frame covers the whole window, and follows it if the window is resized. */
  full: boolean;
  look: Backdrop;
  fps: 30 | 60;
  tabAudio: boolean;
  mic: boolean;
  /** Keep the toolbars in the picture; off films only the board. */
  chrome: boolean;
  grid: boolean;
  name: string;
  board: MediaItem['board'];
  keepInMedia: boolean;
  /** Called to open the camera again (from Media's "New" buttons). */
  camera: (kind?: 'photo' | 'video') => void;
}

type Devices = MediaDevices & { setCaptureHandleConfig?: (c: { handle: string; permittedOrigins: string[] }) => void };
type Track = MediaStreamTrack & { getCaptureHandle?: () => { handle?: string } | null };

const devices = navigator.mediaDevices as Devices | undefined;
/**
 * Recording films this tab and crops it, so the browser has to be able to say "that is this tab": Chrome, Edge,
 * Arc and the other Chromium browsers on a computer. Elsewhere the Video button explains instead.
 */
export const canRecord = !!devices?.getDisplayMedia && typeof devices.setCaptureHandleConfig === 'function'
  && typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';

const MAX_SIDE = 3840;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const theme = (): 'light' | 'dark' => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
};

/** The same backdrops screenshots sit on (server/media.ts draws those; this draws them for video). */
const LOOKS: Record<Exclude<Backdrop, 'none'>, { stops: string[]; glows: [string, string]; hair: string }> = {
  aurora: { stops: ['#6aa8ff', '#9d8cf5', '#e98bd0', '#ff9a8b'], glows: ['#c9e2ff', '#ffd1e8'], hair: 'rgba(255,255,255,0.35)' },
  sunset: { stops: ['#ffb36b', '#ff7a7a', '#ff5f9e', '#a970f0'], glows: ['#ffe0b8', '#ffc0e0'], hair: 'rgba(255,255,255,0.35)' },
  ocean: { stops: ['#1fc8db', '#2a9df4', '#4f6bff', '#3b2f9e'], glows: ['#b6f3ff', '#8fa6ff'], hair: 'rgba(255,255,255,0.3)' },
  mist: { stops: ['#f7f7f8', '#ececef', '#e2e3e8', '#f3f1f6'], glows: ['#ffffff', '#e4e8f4'], hair: 'rgba(0,0,0,0.08)' },
  night: { stops: ['#1a1a22', '#121218', '#0c0c10', '#17121f'], glows: ['#3a2f66', '#1f3a5a'], hair: 'rgba(255,255,255,0.1)' },
};

interface Take {
  opts: RecordOpts;
  display: MediaStream;
  voice: MediaStream | null;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  backdrop: HTMLCanvasElement | null;
  /** where the picture sits on the canvas: all of it, or inset on the backdrop */
  inner: { x: number; y: number; w: number; h: number; r: number };
  mixer: AudioContext | null;
  recorder: MediaRecorder;
  chunks: Blob[];
  poster: Blob | null;
  started: number;
  elapsed: number;
  paused: boolean;
  raf: number;
  tick: number;
}

let take: Take | null = null;
/** The frame being counted down to, before there's a take. */
let pending: RecordOpts | null = null;
/** Between pressing record and the first frame: asking for the tab, the microphone, the countdown. */
let starting = false;
let hud: HTMLDivElement | null = null;

export const recordingActive = () => !!take || starting;

// ---------------------------------------------------------------- starting

const hex = (a: string, alpha: number) => {
  const n = parseInt(a.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** The gradient, its two glows and the soft shadow the picture floats on: painted once, then reused every frame. */
function paintBackdrop(look: Exclude<Backdrop, 'none'>, W: number, H: number, inner: Take['inner']) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const L = LOOKS[look];
  const lin = g.createLinearGradient(0, 0, W, H);
  L.stops.forEach((s, i) => lin.addColorStop(i / (L.stops.length - 1), s));
  g.fillStyle = lin;
  g.fillRect(0, 0, W, H);
  const glow = (cx: number, cy: number, r: number, color: string, a: number) => {
    const rad = g.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * Math.max(W, H));
    rad.addColorStop(0, hex(color, a));
    rad.addColorStop(1, hex(color, 0));
    g.fillStyle = rad;
    g.fillRect(0, 0, W, H);
  };
  glow(0.18, 0.12, 0.7, L.glows[0], 0.75);
  glow(0.9, 0.95, 0.65, L.glows[1], 0.6);
  g.save();
  g.shadowColor = 'rgba(11,8,32,0.42)';
  g.shadowBlur = inner.x * 0.7;
  g.shadowOffsetY = inner.x * 0.28;
  g.fillStyle = '#000';
  g.beginPath();
  g.roundRect(inner.x, inner.y, inner.w, inner.h, inner.r);
  g.fill();
  g.restore();
  return c;
}

function mimeFor(audio: boolean) {
  // MP4 plays everywhere and uploads anywhere; WebM is the fallback where the browser can't make one.
  const a = audio ? ',mp4a.40.2' : '';
  const o = audio ? ',opus' : '';
  return [
    `video/mp4;codecs=avc1.640033${a}`, `video/mp4;codecs=avc1.64002A${a}`, `video/mp4;codecs=avc1.42E01F${a}`, 'video/mp4',
    `video/webm;codecs=vp9${o}`, `video/webm;codecs=vp8${o}`, 'video/webm',
  ].find((t) => MediaRecorder.isTypeSupported(t));
}

/**
 * Is this capture of our own tab? A tab can put a name tag on itself that any capture of it carries. The tag is
 * written fresh once the capture is running and we wait for it to show up on the track: a tag set beforehand
 * reaches the first capture a tab ever has, but not the ones after it.
 */
function isThisTab(track: Track): Promise<boolean> {
  const tag = `bb-${crypto.randomUUID()}`;
  const mine = () => track.getCaptureHandle?.()?.handle === tag;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); track.removeEventListener('capturehandlechange', check); resolve(mine()); };
    const check = () => { if (mine()) done(); };
    const timer = setTimeout(done, 2000);
    track.addEventListener('capturehandlechange', check);
    devices!.setCaptureHandleConfig!({ handle: tag, permittedOrigins: [location.origin] });
    check();
  });
}

function stopTracks(...streams: (MediaStream | null)[]) {
  for (const s of streams) s?.getTracks().forEach((t) => t.stop());
}

/** Ask to film this tab, count down, and start. Resolves once recording has begun (or been called off). */
export async function startRecording(opts: RecordOpts): Promise<boolean> {
  if (take || starting) return false;
  if (!canRecord) { toast('Recording needs Chrome, Edge or another Chromium browser on a computer'); return false; }
  starting = true;
  let display: MediaStream | null = null;
  let voice: MediaStream | null = null;
  let mixer: AudioContext | null = null;
  try {
    const dpr = devicePixelRatio || 1;
    display = await devices!.getDisplayMedia({
      video: {
        frameRate: { ideal: opts.fps, max: opts.fps }, displaySurface: 'browser',
        width: { ideal: Math.round(innerWidth * dpr) }, height: { ideal: Math.round(innerHeight * dpr) },
      },
      audio: opts.tabAudio,
      // Offer this tab first, and nothing that can't be cropped to the board.
      preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);
    const track = display.getVideoTracks()[0] as Track;
    if (!(await isThisTab(track))) {
      stopTracks(display);
      toast('To record the board, choose “This tab” when your browser asks');
      return false;
    }
    if (opts.mic) {
      try {
        voice = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        toast('Microphone unavailable. Recording will continue without it.');
      }
    }
    const tabTrack = opts.tabAudio ? display.getAudioTracks()[0] : undefined;
    const micTrack = voice?.getAudioTracks()[0];
    if (opts.tabAudio && !tabTrack) toast('Tab audio wasn’t shared. Enable tab audio in the browser picker to include it.');
    let audioTrack = tabTrack ?? micTrack;
    if (tabTrack && micTrack) {
      // MediaRecorder needs one audio track. Mix both sources without playing either back into the tab.
      mixer = new AudioContext();
      const destination = mixer.createMediaStreamDestination();
      for (const input of [tabTrack, micTrack]) {
        mixer.createMediaStreamSource(new MediaStream([input])).connect(destination);
      }
      await mixer.resume();
      audioTrack = destination.stream.getAudioTracks()[0];
    }
    document.body.classList.add('recording');
    document.body.classList.toggle('rec-clean', !opts.chrome);
    document.body.classList.toggle('rec-nogrid', !opts.grid);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = display;
    await video.play();
    showHud(!!tabTrack, !!micTrack);
    await countdown(opts);
    if (track.readyState !== 'live') throw new DOMException('Sharing ended', 'AbortError');
    begin(opts, display, voice, video, audioTrack, mixer);
    return true;
  } catch (e) {
    stopTracks(display, voice);
    if (mixer) void mixer.close();
    cleanup();
    const name = (e as Error).name;
    if (name !== 'NotAllowedError' && name !== 'AbortError') toast('Couldn’t start recording. Check your browser’s screen recording permission');
    return false;
  } finally {
    starting = false;
  }
}

function begin(opts: RecordOpts, display: MediaStream, voice: MediaStream | null, video: HTMLVideoElement, audio: MediaStreamTrack | undefined, mixer: AudioContext | null) {
  const src = source(opts, video);
  // The picture is as sharp as the tab is filmed, up to 4K on its long side.
  const fit = Math.min(1, MAX_SIDE / Math.max(src.w, src.h));
  const W = even(src.w * fit), H = even(src.h * fit);
  const short = Math.min(W, H);
  const pad = opts.look === 'none' ? 0 : even(Math.min(Math.max(short * 0.085, 36), 200));
  const inner = { x: pad, y: pad, w: W, h: H, r: pad ? Math.round(Math.min(Math.max(short * 0.013, 8), 24)) : 0 };
  const canvas = document.createElement('canvas');
  canvas.width = W + pad * 2;
  canvas.height = H + pad * 2;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';
  const backdrop = opts.look === 'none' ? null : paintBackdrop(opts.look, canvas.width, canvas.height, inner);

  const out = canvas.captureStream(opts.fps);
  if (audio) out.addTrack(audio);
  const mimeType = mimeFor(!!audio);
  const bits = Math.min(Math.max(canvas.width * canvas.height * opts.fps * 0.1, 6e6), 50e6);
  let t: Take;
  try {
    const recorder = new MediaRecorder(out, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: bits });
    t = {
      opts, display, voice, video, canvas, ctx, backdrop, inner, mixer, recorder, chunks: [], poster: null,
      started: performance.now(), elapsed: 0, paused: false, raf: 0, tick: 0,
    };
    recorder.ondataavailable = (e) => { if (e.data.size) t.chunks.push(e.data); };
    recorder.onstop = () => void finish(t);
    recorder.onerror = () => stopRecording();
    draw(t);
    recorder.start(1000);
  } catch (err) {
    stopTracks(out);
    throw err;
  }
  take = t;
  // "Stop sharing" in the browser's own bar ends the recording too.
  display.getVideoTracks()[0].addEventListener('ended', () => stopRecording(), { once: true });

  // Draw at the recording's frame rate whether or not the tab changed, so the video keeps a steady pace.
  const step = 1000 / opts.fps;
  let last = -Infinity;
  const loop = (now: number) => {
    if (take !== t) return;
    t.raf = requestAnimationFrame(loop);
    if (t.paused || now - last < step - 2) return;
    last = now;
    draw(t);
    if (!t.poster && now - t.started > 600) grabPoster(t);
  };
  t.raf = requestAnimationFrame(loop);
  t.tick = window.setInterval(paintHud, 250);
  paintHud();
  window.addEventListener('beforeunload', warnLeaving);
  window.addEventListener('keydown', stopKey, true);
}

/** ⌥R stops from anywhere, even mid-sentence in a note. */
function stopKey(e: KeyboardEvent) {
  if (!e.altKey || e.code !== 'KeyR' || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stopRecording();
}

/** The part of the filmed tab to keep, in the video's own pixels. */
function source(opts: RecordOpts, video: HTMLVideoElement) {
  const kx = video.videoWidth / innerWidth, ky = video.videoHeight / innerHeight;
  const r = opts.full ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : opts.rect;
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(innerWidth, r.x + r.w) - x, h = Math.min(innerHeight, r.y + r.h) - y;
  return { x: x * kx, y: y * ky, w: Math.max(2, w * kx), h: Math.max(2, h * ky) };
}

function draw(t: Take) {
  const { ctx, inner, video } = t;
  if (!video.videoWidth) return;
  const s = source(t.opts, video);
  if (t.backdrop) ctx.drawImage(t.backdrop, 0, 0);
  ctx.save();
  if (inner.r) {
    ctx.beginPath();
    ctx.roundRect(inner.x, inner.y, inner.w, inner.h, inner.r);
    ctx.clip();
  }
  // If the window was resized mid-recording, the picture keeps its shape inside the frame it started with.
  const k = Math.min(inner.w / s.w, inner.h / s.h);
  const w = s.w * k, h = s.h * k;
  if (w < inner.w - 1 || h < inner.h - 1) {
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000';
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  }
  ctx.drawImage(video, s.x, s.y, s.w, s.h, inner.x + (inner.w - w) / 2, inner.y + (inner.h - h) / 2, w, h);
  ctx.restore();
  if (t.backdrop && t.opts.look !== 'none') {
    ctx.strokeStyle = LOOKS[t.opts.look].hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(inner.x + 0.5, inner.y + 0.5, inner.w - 1, inner.h - 1, inner.r);
    ctx.stroke();
  }
}

/** One frame, small, as the still shown in Media and on the card. */
function grabPoster(t: Take) {
  const k = Math.min(1, 640 / t.canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(t.canvas.width * k);
  c.height = Math.round(t.canvas.height * k);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(t.canvas, 0, 0, c.width, c.height);
  t.poster = new Blob(); // claimed, so only one is made
  c.toBlob((b) => { t.poster = b; }, 'image/png');
}

const boardTitle = () => (session.boardName ? `${session.boardName} · Brainboard` : 'Brainboard');
const seconds = (t: Take) => (t.elapsed + (t.paused ? 0 : performance.now() - t.started)) / 1000;

// ---------------------------------------------------------------- pausing and stopping

export function togglePause() {
  const t = take;
  if (!t || t.recorder.state === 'inactive') return;
  if (t.paused) {
    t.recorder.resume();
    t.started = performance.now();
    t.paused = false;
  } else {
    t.recorder.pause();
    t.elapsed += performance.now() - t.started;
    t.paused = true;
  }
  paintHud();
}

export function stopRecording() {
  const t = take;
  if (!t || t.recorder.state === 'inactive') return;
  if (!t.paused) t.elapsed += performance.now() - t.started;
  t.paused = true;
  if (!t.poster) grabPoster(t);
  t.recorder.stop();
}

function cleanup() {
  document.body.classList.remove('recording', 'rec-clean', 'rec-nogrid');
  window.removeEventListener('beforeunload', warnLeaving);
  window.removeEventListener('keydown', stopKey, true);
  window.removeEventListener('resize', placeHud);
  pending = null;
  hud?.remove();
  hud = null;
}

async function finish(t: Take) {
  cancelAnimationFrame(t.raf);
  clearInterval(t.tick);
  stopTracks(t.recorder.stream, t.display, t.voice);
  if (t.mixer) void t.mixer.close();
  t.video.srcObject = null;
  take = null;
  document.title = boardTitle();
  cleanup();
  const length = t.elapsed / 1000;
  if (!t.chunks.length) return toast('Nothing was recorded');
  const type = t.recorder.mimeType || t.chunks[0].type || 'video/webm';
  const blob = new Blob(t.chunks, { type });
  // The still is made off the main thread: give it a moment if the recording was very short.
  for (let i = 0; i < 20 && t.poster && !t.poster.size; i++) await new Promise((r) => setTimeout(r, 25));
  const poster = t.poster?.size ? t.poster : null;
  const local: MediaItem = {
    id: '', kind: 'recording', ext: type.includes('mp4') ? 'mp4' : 'webm', duration: length, name: t.opts.name,
    board: t.opts.board, w: t.canvas.width, h: t.canvas.height, bytes: blob.size, backdrop: t.opts.look, theme: theme(), created: new Date().toISOString(),
  };
  showCard(local, blob, poster, t.opts);
}

const warnLeaving = (e: BeforeUnloadEvent) => { e.preventDefault(); };

// ---------------------------------------------------------------- on screen while recording

/** Keep controls outside a cropped frame when they fit, and on screen throughout every recording. */
function showHud(tabAudio: boolean, mic: boolean) {
  hud?.remove();
  hud = document.createElement('div');
  hud.id = 'rec';
  hud.className = 'rec';
  hud.innerHTML = `
    <div class="rec-frame" aria-hidden="true"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>
    <div class="rec-count" aria-hidden="true"><b></b><span></span></div>
    <div class="rec-pill panel" role="toolbar" aria-label="Recording">
      <span class="rec-time" role="timer"><i class="rec-dot"></i><b>0:00</b></span>
      ${tabAudio ? `<span class="rec-mic" aria-label="Tab audio on">${icon('sound', 15)}</span>` : ''}
      ${mic ? `<span class="rec-mic" aria-label="Microphone on">${icon('mic', 15)}</span>` : ''}
      <button data-act="pause" aria-label="Pause"><i class="rec-bars"></i></button>
      <button data-act="stop" class="rec-stop" aria-label="${keyLabel('Stop recording (⌥R)')}"><i></i><span>Stop recording</span></button>
    </div>`;
  document.body.append(hud);
  hud.querySelector('.rec-pill')!.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'pause') togglePause();
    else if (act === 'stop') stopRecording();
  });
  window.addEventListener('resize', placeHud);
  placeHud();
}

function placeHud() {
  if (!hud) { window.removeEventListener('resize', placeHud); return; }
  const o = take?.opts ?? pending;
  if (!o) return;
  const r = o.full ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : o.rect;
  const fr = hud.querySelector<HTMLElement>('.rec-frame')!;
  fr.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  const count = hud.querySelector<HTMLElement>('.rec-count')!;
  count.style.left = `${r.x + r.w / 2}px`;
  count.style.top = `${r.y + r.h / 2}px`;
  // The pill goes wherever there's room outside the frame: under it, over it, or beside it.
  const pill = hud.querySelector<HTMLElement>('.rec-pill')!;
  const pw = pill.offsetWidth || 210, ph = pill.offsetHeight || 40, gap = 18;
  const cx = Math.min(Math.max(r.x + r.w / 2 - pw / 2, 10), innerWidth - pw - 10);
  const cy = Math.min(Math.max(r.y + r.h / 2 - ph / 2, 10), innerHeight - ph - 10);
  let at: [number, number] | null = null;
  if (innerHeight - (r.y + r.h) >= ph + gap + 10) at = [cx, r.y + r.h + gap];
  else if (r.y >= ph + gap + 10) at = [cx, r.y - gap - ph];
  else if (innerWidth - (r.x + r.w) >= pw + gap + 10) at = [r.x + r.w + gap, cy];
  else if (r.x >= pw + gap + 10) at = [r.x - gap - pw, cy];
  hud.classList.toggle('in-shot', !at);
  pill.style.left = at ? `${Math.round(Math.max(10, Math.min(at[0], innerWidth - pw - 10)))}px` : '50%';
  pill.style.top = at ? `${Math.round(Math.max(10, Math.min(at[1], innerHeight - ph - 10)))}px` : 'calc(12px + var(--sa-t))';
}

function paintHud() {
  const t = take;
  if (!t || !hud) return;
  const time = clock(seconds(t));
  hud.classList.toggle('paused', t.paused);
  hud.classList.add('live');
  hud.querySelector('.rec-time b')!.textContent = time;
  const pause = hud.querySelector<HTMLElement>('[data-act="pause"]')!;
  pause.setAttribute('aria-label', t.paused ? 'Resume' : 'Pause');
  document.title = `${t.paused ? '❚❚' : '●'} ${time} · ${boardTitle()}`;
}

/** 3, 2, 1 in the middle of the frame, with how to stop. It's over before the first frame is filmed. */
async function countdown(opts: RecordOpts) {
  pending = opts;
  placeHud();
  const el = hud!.querySelector<HTMLElement>('.rec-count')!;
  const num = el.querySelector('b')!;
  el.querySelector('span')!.innerHTML = keyLabel('Stop recording or <kbd>⌥R</kbd> to finish');
  el.classList.add('in');
  const beat = reducedMotion() ? 450 : 650;
  for (const n of [3, 2, 1]) {
    num.textContent = String(n);
    num.classList.remove('pop');
    void num.offsetWidth;
    num.classList.add('pop');
    await new Promise((r) => setTimeout(r, beat));
  }
  el.classList.remove('in');
  // Let it fade right out, so not a trace of it is in the first frames.
  await new Promise((r) => setTimeout(r, 180));
  el.hidden = true;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  pending = null;
}

// ---------------------------------------------------------------- the card in the corner

/**
 * The finished take, in the corner where screenshots land. Save works at once (the video is still in this tab);
 * Media opens it once it's been kept there. If keeping it fails the card stays until you've saved or dismissed it.
 */
function showCard(local: MediaItem, blob: Blob, poster: Blob | null, opts: RecordOpts) {
  dismissCaptureCard();
  const el = document.createElement('div');
  el.className = 'shot-card rec-card panel landed';
  el.setAttribute('role', 'status');
  const size = blob.size > 1048576 ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
  const facts = `${clock(local.duration ?? 0)} · ${local.w.toLocaleString()} × ${local.h.toLocaleString()} · ${size}`;
  el.innerHTML = `
    <button class="shot-card-thumb" data-act="open" aria-label="Open in Media" disabled><span class="shot-slot"></span><i class="mtile-play"></i></button>
    <div class="shot-card-body">
      <b>Recording ready</b>
      <span class="shot-card-meta">${facts}</span>
      <div class="shot-card-acts">
        <button data-act="save">${icon('download', 15)}<span>Save locally</span></button>
        <button data-act="library">${icon('media', 15)}<span>Save to Media</span></button>
      </div>
    </div>
    <button class="shot-card-x" data-act="dismiss" aria-label="Dismiss">${icon('close', 14)}</button>`;
  const tw = 132, th = Math.round(Math.min(Math.max(tw * local.h / local.w, 60), 132));
  el.style.setProperty('--tw', `${tw}px`);
  el.style.setProperty('--th', `${th}px`);
  const posterUrl = poster ? URL.createObjectURL(poster) : '';
  if (posterUrl) {
    const img = new Image();
    img.alt = '';
    img.className = 'shot-real in';
    img.src = posterUrl;
    el.querySelector('.shot-slot')!.append(img);
  }
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));

  let item: MediaItem | null = null;
  let savedLocally = false;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 260);
    if (posterUrl) setTimeout(() => URL.revokeObjectURL(posterUrl), 1000);
    window.removeEventListener('beforeunload', guard);
  };
  // A take that isn't in Media and hasn't been saved exists only in this tab.
  const guard = (e: BeforeUnloadEvent) => { if (!item && !savedLocally) e.preventDefault(); };
  window.addEventListener('beforeunload', guard);
  const arm = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(dismiss, ms); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { if (item) arm(5000); });
  el.addEventListener('click', async (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'dismiss') return dismiss();
    if (act === 'save') { if (await saveMedia(item ?? local, blob)) savedLocally = true; return; }
    if (act === 'open' && item) { dismiss(); openMedia(item.id, opts.camera); }
  });

  const keep = bindCaptureSave(el, local, blob, poster, opts.camera, saved => {
    item = saved;
    el.querySelector<HTMLButtonElement>('.shot-card-thumb')!.disabled = false;
    el.classList.add('done');
    arm(9000);
  });
  if (opts.keepInMedia) void keep();
}

/** What a new recording is called until you rename it. */
export function recordingName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${session.boardName || 'Brainboard'} recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}
