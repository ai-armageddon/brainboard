// Voice chat: peer-to-peer audio (WebRTC mesh, fine for small groups) with signalling over the board's socket.
// Shows who is talking, and lets the board owner or presenter mute people or open a "stage" where only they talk.
// Mutes are honoured by every listener (they silence that person locally), not just by the muted browser.
import { account, events, isOwner, muteUser, sendRtc, sendVoice, session } from './net';
import type { PeerInfo, RtcSignal } from './protocol';
import { icon } from './icons';
import { toast } from './ui';
import { ensureScreenName } from './account';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Conn {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  meter: Meter | null;
  queued: RTCIceCandidateInit[];
}

let inVoice = false;
let selfMuted = false;
let boardOfCall: string | null = null;
let local: MediaStream | null = null;
let ctx: AudioContext | null = null;
let localMeter: Meter | null = null;
const conns = new Map<string, Conn>();

export const isInVoice = () => inVoice;
/** Owner or presenter: may mute others. */
export const canModerate = () => isOwner() || (!!session.presenter && session.presenter === session.you?.id);
/** May I talk right now? (Stage mode limits it to the owner and presenter.) */
const canSpeak = () => !session.settings.stage || canModerate();

// ---------------------------------------------------------------- who is talking

interface Meter { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer>; loudAt: number; source: MediaStreamAudioSourceNode }
const speaking = new Set<string>(); // peer ids, plus "me"

function meterFor(stream: MediaStream): Meter | null {
  if (!ctx) return null;
  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    return { analyser, source, buf: new Float32Array(analyser.fftSize), loudAt: 0 };
  } catch { return null; }
}

function level(m: Meter) {
  m.analyser.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (const v of m.buf) sum += v * v;
  return Math.sqrt(sum / m.buf.length);
}

let meterTimer = 0;
function measure() {
  const now = performance.now();
  const next = new Set<string>();
  const check = (id: string, m: Meter | null, silent: boolean) => {
    if (!m || silent) return;
    if (level(m) > 0.018) m.loudAt = now;
    if (now - m.loudAt < 350) next.add(id);
  };
  check('me', localMeter, selfMuted || !canSpeak());
  for (const [id, c] of conns) check(id, c.meter, !!session.peers.get(id)?.muted);
  const changed = next.size !== speaking.size || [...next].some((id) => !speaking.has(id));
  if (changed) {
    speaking.clear();
    for (const id of next) speaking.add(id);
    decorate();
  }
}

export const isSpeaking = (id: string) => speaking.has(id === session.you?.id ? 'me' : id);

// ---------------------------------------------------------------- connections

function iceServers(): RTCIceServer[] {
  return account.ice?.length ? account.ice : [{ urls: 'stun:stun.l.google.com:19302' }];
}

function connFor(id: string): Conn {
  let c = conns.get(id);
  if (c) return c;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const audio = new Audio();
  audio.autoplay = true;
  c = { pc, audio, meter: null, queued: [] };
  conns.set(id, c);
  for (const t of local?.getTracks() ?? []) pc.addTrack(t, local!);
  pc.onicecandidate = (e) => { if (e.candidate) sendRtc(id, { kind: 'ice', candidate: e.candidate.toJSON() as never }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    audio.srcObject = stream;
    audio.muted = !!session.peers.get(id)?.muted;
    void audio.play().catch(() => {});
    c!.meter = meterFor(stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      close(id);
      // whoever has the smaller id tries again
      if (inVoice && session.you && session.you.id < id && session.peers.get(id)?.voice) void call(id);
    }
  };
  return c;
}

function close(id: string) {
  const c = conns.get(id);
  if (!c) return;
  conns.delete(id);
  try { c.meter?.source.disconnect(); } catch { /* ignore */ }
  c.pc.close();
  c.audio.srcObject = null;
  speaking.delete(id);
}

async function call(id: string) {
  const c = connFor(id);
  const offer = await c.pc.createOffer();
  await c.pc.setLocalDescription(offer);
  sendRtc(id, { kind: 'offer', sdp: offer.sdp ?? '' });
}

async function onSignal(from: string, data: RtcSignal) {
  if (!inVoice) return;
  try {
    if (data.kind === 'offer') {
      const c = connFor(from);
      if (c.pc.signalingState === 'have-local-offer') {
        // Both called at once: the one with the smaller id keeps its own offer.
        if (session.you && session.you.id < from) return;
        await c.pc.setLocalDescription({ type: 'rollback' });
      }
      await c.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      for (const q of c.queued.splice(0)) await c.pc.addIceCandidate(q);
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      sendRtc(from, { kind: 'answer', sdp: answer.sdp ?? '' });
    } else if (data.kind === 'answer') {
      const c = conns.get(from);
      if (!c || c.pc.signalingState !== 'have-local-offer') return;
      await c.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      for (const q of c.queued.splice(0)) await c.pc.addIceCandidate(q);
    } else if (data.kind === 'ice') {
      const c = connFor(from);
      if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.candidate);
      else c.queued.push(data.candidate);
    }
  } catch (err) {
    console.warn('[brainboard voice]', err);
  }
}

// ---------------------------------------------------------------- join / leave / mute

export async function joinVoice() {
  if (inVoice || !session.boardId) return;
  if (!(await ensureScreenName('talk'))) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast('Voice needs a secure (https) connection');
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    return toast('Microphone blocked. Allow it in your browser’s site settings to talk');
  }
  ctx = new AudioContext();
  localMeter = meterFor(local);
  inVoice = true;
  boardOfCall = session.boardId;
  selfMuted = !canSpeak();
  applyLocalMute();
  sendVoice(true, selfMuted);
  // The newcomer calls everyone already in the chat.
  for (const p of session.peers.values()) if (p.voice) void call(p.id);
  meterTimer = window.setInterval(measure, 100);
  toast(selfMuted ? 'Joined voice. Only the presenter can talk right now' : 'Joined voice. You’re live');
  render();
}

export function leaveVoice(silent = false) {
  if (!inVoice) return;
  inVoice = false;
  boardOfCall = null;
  for (const id of [...conns.keys()]) close(id);
  for (const t of local?.getTracks() ?? []) t.stop();
  local = null;
  try { localMeter?.source.disconnect(); } catch { /* ignore */ }
  localMeter = null;
  void ctx?.close();
  ctx = null;
  clearInterval(meterTimer);
  speaking.clear();
  sendVoice(false, true);
  if (!silent) toast('Left voice');
  render();
}

function applyLocalMute() {
  for (const t of local?.getAudioTracks() ?? []) t.enabled = !selfMuted && canSpeak();
}

export function toggleMute() {
  if (!inVoice) return;
  if (!canSpeak()) return toast('Stage mode: only the owner and presenter can talk');
  selfMuted = !selfMuted;
  applyLocalMute();
  sendVoice(true, selfMuted);
  render();
}

// ---------------------------------------------------------------- UI

function render() {
  const box = $('voice');
  const others = [...session.peers.values()].filter((p) => p.voice);
  box.classList.toggle('live', inVoice);
  if (!inVoice) {
    box.innerHTML = `<button class="cbtn voice-join" data-voice="join" data-tip="${others.length ? `Join voice · ${others.length} in the call` : 'Join voice chat'}" aria-label="Join voice">${icon('headphones', 18)}${others.length ? `<b class="voice-count">${others.length}</b>` : ''}</button>`;
  } else {
    const blocked = !canSpeak();
    const off = selfMuted || blocked;
    box.innerHTML =
      `<button class="cbtn voice-mic ${off ? 'off' : ''} ${speaking.has('me') ? 'talking' : ''}" data-voice="mic" ${blocked ? 'aria-disabled="true"' : ''} data-tip="${blocked ? 'Stage mode: only the owner and presenter can talk' : off ? 'Unmute' : 'Mute'}" aria-label="${off ? 'Unmute' : 'Mute'}">${icon(off ? 'micOff' : 'mic', 18)}</button>` +
      `<button class="cbtn voice-leave" data-voice="leave" data-tip="Leave voice" aria-label="Leave voice">${icon('phoneOff', 18)}</button>`;
  }
  decorate();
}

/** Speaking rings and mic badges on avatars and cursors. */
export const decorateVoice = () => decorate();
function decorate() {
  document.querySelectorAll<HTMLElement>('#avatars .avatar[data-peer]').forEach((a) => {
    const id = a.dataset.peer!;
    const me = id === session.you?.id;
    const p = me ? session.you : session.peers.get(id);
    const inCall = me ? inVoice : !!p?.voice;
    const muted = me ? selfMuted || !canSpeak() : !!p?.muted;
    a.classList.toggle('in-voice', inCall);
    a.classList.toggle('voice-muted', inCall && muted);
    a.classList.toggle('speaking', inCall && !muted && isSpeaking(id));
  });
  document.querySelectorAll<HTMLElement>('#cursors .cursor[data-peer]').forEach((c) => {
    c.classList.toggle('speaking', isSpeaking(c.dataset.peer!));
  });
  $('voice').querySelector('.voice-mic')?.classList.toggle('talking', speaking.has('me'));
}

/** Keep connections and local mutes in step with who's in the call. */
function syncPeers() {
  if (inVoice) {
    for (const id of [...conns.keys()]) {
      const p = session.peers.get(id);
      if (!p || !p.voice) close(id);
    }
    for (const p of session.peers.values()) {
      const c = conns.get(p.id);
      if (c) c.audio.muted = !!p.muted;
      // Someone joined at the same moment as us and nobody called: the smaller id calls.
      if (p.voice && !c && session.you && session.you.id < p.id) {
        const id = p.id;
        setTimeout(() => { if (inVoice && !conns.has(id) && session.peers.get(id)?.voice) void call(id); }, 600);
      }
    }
    // Stage mode or a presenter change can take my mic away. Stay muted afterwards until I unmute myself,
    // so nobody goes back on air without knowing it.
    if (!canSpeak() && !selfMuted) {
      selfMuted = true;
      sendVoice(true, true);
    }
    applyLocalMute();
  }
  render();
}

export function initVoice() {
  $('voice').addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-voice]')?.dataset.voice;
    if (act === 'join') void joinVoice();
    else if (act === 'mic') toggleMute();
    else if (act === 'leave') leaveVoice();
  });
  events.addEventListener('rtc', (e) => {
    const { from, data } = (e as CustomEvent<{ from: string; data: RtcSignal }>).detail;
    void onSignal(from, data);
  });
  events.addEventListener('muted', (e) => {
    const by = String((e as CustomEvent).detail);
    if (!inVoice) return;
    if (by !== 'stage') {
      selfMuted = true;
      applyLocalMute();
      toast(`${by} muted you`);
    }
    render();
  });
  for (const ev of ['peers', 'presenter', 'settings', 'role']) events.addEventListener(ev, syncPeers);
  // Reconnected, or switched boards: start the call over (or leave it).
  events.addEventListener('welcome', () => {
    if (!inVoice) return render();
    if (session.boardId !== boardOfCall) return leaveVoice(true);
    for (const id of [...conns.keys()]) close(id);
    sendVoice(true, selfMuted);
    for (const p of session.peers.values()) if (p.voice) void call(p.id);
    render();
  });
  window.addEventListener('beforeunload', () => { if (inVoice) leaveVoice(true); });
  render();
}

/** Owner / presenter: mute one person (or everyone with '*'). */
export function mute(p: PeerInfo | '*') {
  muteUser(p === '*' ? '*' : p.id);
}
