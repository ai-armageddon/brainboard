import './studio.css';
import { paintLogos } from '../brand';
import { icon } from '../icons';
import { drawLandscape } from './landscape';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = byId<HTMLVideoElement>('preview');
const record = byId<HTMLButtonElement>('record');
const pause = byId<HTMLButtonElement>('pause');
const mic = byId<HTMLInputElement>('mic');
const sound = byId<HTMLInputElement>('sound');
const message = byId('message');
const clock = byId('clock');
const source = byId('source');
const status = byId('status');
const inputs = document.querySelectorAll<HTMLInputElement>('.settings input');
const supported = !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';
type Mode = 'standby' | 'selecting' | 'recording' | 'paused' | 'finishing' | 'review';
type Take = { name: string; url: string; duration: number; downloaded: boolean };
const takes: Take[] = [];
let mode: Mode = 'standby';
let encoder: MediaRecorder | null = null;
let streams: MediaStream[] = [];
let mixer: AudioContext | null = null;
let started = 0;
let elapsed = 0;
let timer = 0;
let selection = 0;
let reviewed: Take | undefined;

paintLogos();
drawLandscape(byId<HTMLCanvasElement>('landscape'));
document.querySelectorAll<HTMLElement>('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon!); });

function timecode(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function setMode(next: Mode) {
  mode = next;
  document.body.dataset.mode = next;
  const active = next === 'recording' || next === 'paused';
  const busy = next === 'selecting' || next === 'finishing';
  inputs.forEach(input => { input.disabled = active || busy || !supported; });
  record.disabled = !supported || busy;
  record.querySelector('span')!.textContent = active ? 'Stop recording' : 'Start recording';
  pause.hidden = !active;
  pause.textContent = next === 'paused' ? 'Resume' : 'Pause';
  status.textContent = { standby: 'Standby', selecting: 'Preparing', recording: 'Recording', paused: 'Paused', finishing: 'Finishing', review: 'Playback' }[next];
  document.querySelectorAll<HTMLButtonElement>('.clip button').forEach(b => { b.disabled = active || busy; });
}

function releaseInputs() {
  for (const stream of streams) stream.getTracks().forEach(track => track.stop());
  streams = [];
  if (mixer && mixer.state !== 'closed') void mixer.close().catch(() => {});
  mixer = null;
}

function showTake(take?: Take) {
  reviewed = take;
  preview.pause();
  preview.srcObject = null;
  preview.hidden = !take;
  preview.controls = !!take;
  preview.muted = !take;
  if (take) preview.src = take.url;
  else preview.removeAttribute('src');
  preview.load();
  clock.textContent = timecode(take?.duration ?? 0);
  source.textContent = take?.name ?? 'Awaiting capture';
  setMode(take ? 'review' : 'standby');
}

function addTake(blob: Blob) {
  const name = 'Take ' + String(takes.length + 1).padStart(2, '0');
  const take = { name, url: URL.createObjectURL(blob), duration: elapsed, downloaded: false };
  takes.push(take);
  const item = document.createElement('li');
  item.className = 'clip';
  const play = document.createElement('button');
  play.textContent = name;
  play.setAttribute('aria-label', 'Preview ' + name);
  play.onclick = () => { showTake(take); void preview.play().catch(() => {}); };
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const details = document.createElement('span');
  details.className = 'clip-details';
  details.textContent = `${timecode(elapsed)} · ${ext.toUpperCase()}`;
  const download = document.createElement('a');
  download.href = take.url;
  download.download = `brainboard-${new Date().toISOString().replace(/[:.]/g, '-')}-${takes.length}.${ext}`;
  download.textContent = 'Download';
  download.setAttribute('aria-label', 'Download ' + name);
  download.onclick = () => { take.downloaded = true; };
  item.append(play, details, download);
  byId('clips').prepend(item);
  byId('empty').hidden = true;
  showTake(take);
}

function updateClock() {
  clock.textContent = timecode(elapsed + (mode === 'recording' ? performance.now() - started : 0));
}

function stop() {
  if (!encoder || mode === 'finishing') return;
  if (mode === 'recording') elapsed += performance.now() - started;
  clearInterval(timer);
  setMode('finishing');
  updateClock();
  if (encoder.state !== 'inactive') encoder.stop();
  releaseInputs();
}

async function start() {
  const attempt = ++selection;
  setMode('selecting');
  preview.pause();
  message.textContent = 'Choose a screen, window, or tab to share.';
  let requestingMic = false;
  try {
    const fps = Number(document.querySelector<HTMLInputElement>('input[name=fps]:checked')!.value);
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: sound.checked });
    if (attempt !== selection) { display.getTracks().forEach(t => t.stop()); return; }
    streams.push(display);
    const screen = display.getVideoTracks()[0];
    screen.addEventListener('ended', () => {
      if (attempt !== selection) return;
      if (encoder) stop();
      else {
        selection++;
        releaseInputs();
        showTake(reviewed);
        message.textContent = 'Screen sharing ended. Start again to choose a source.';
      }
    }, { once: true });
    const audio = [...display.getAudioTracks()];
    if (mic.checked) {
      requestingMic = true;
      message.textContent = 'Allow microphone access to record your voice.';
      const voice = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== selection) { voice.getTracks().forEach(t => t.stop()); return; }
      streams.push(voice);
      audio.push(...voice.getAudioTracks());
      requestingMic = false;
    }
    let outputAudio = audio;
    if (audio.length > 1) {
      mixer = new AudioContext();
      const destination = mixer.createMediaStreamDestination();
      audio.forEach(track => mixer!.createMediaStreamSource(new MediaStream([track])).connect(destination));
      streams.push(destination.stream);
      await mixer.resume();
      if (attempt !== selection) return;
      outputAudio = destination.stream.getAudioTracks();
    }
    if (screen.readyState !== 'live') throw new Error('Screen sharing ended.');
    const stream = new MediaStream([screen, ...outputAudio]);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    let interrupted = false;
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => { interrupted = true; stop(); };
    recorder.onstop = () => {
      if (attempt !== selection) return;
      stop();
      encoder = null;
      if (chunks.length) {
        addTake(new Blob(chunks, { type: recorder.mimeType || chunks[0].type }));
        message.textContent = interrupted ? 'Recording was interrupted. Review the available footage.' : 'Your recording is ready to review and download.';
      } else {
        showTake(reviewed);
        message.textContent = 'No footage was captured. Start a new recording to try again.';
      }
    };
    recorder.start(1000);
    encoder = recorder;
    elapsed = 0;
    started = performance.now();
    preview.removeAttribute('src');
    preview.controls = false;
    preview.muted = true;
    preview.srcObject = display;
    preview.hidden = false;
    void preview.play().catch(() => {});
    source.textContent = screen.label || 'Shared screen';
    setMode('recording');
    updateClock();
    timer = window.setInterval(updateClock, 200);
    message.textContent = sound.checked && !display.getAudioTracks().length
      ? 'This source is sharing video only.' + (mic.checked ? ' Your microphone is active.' : '')
      : 'Recording in this tab.';
  } catch (error) {
    if (attempt !== selection) return;
    releaseInputs();
    showTake(reviewed);
    message.textContent = requestingMic
      ? 'Microphone unavailable. Allow access or turn the microphone off and try again.'
      : error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Screen sharing wasn’t allowed. Start again to choose a source.'
        : 'Capture could not start. Check screen recording permissions and try again.';
  }
}

record.onclick = () => { if (mode === 'recording' || mode === 'paused') stop(); else void start(); };
pause.onclick = () => {
  if (!encoder) return;
  if (mode === 'recording') {
    encoder.pause();
    elapsed += performance.now() - started;
    setMode('paused');
    message.textContent = 'Capture is paused. Resume when you’re ready.';
  } else if (mode === 'paused') {
    encoder.resume();
    started = performance.now();
    setMode('recording');
    message.textContent = 'Recording in this tab.';
  }
  updateClock();
};

window.addEventListener('beforeunload', event => {
  if (encoder || takes.some(take => !take.downloaded)) event.preventDefault();
});
window.addEventListener('pagehide', () => {
  selection++;
  if (encoder && encoder.state !== 'inactive') encoder.stop();
  encoder = null;
  clearInterval(timer);
  releaseInputs();
  showTake(reviewed);
});
setMode('standby');
if (!supported) {
  status.textContent = 'Unavailable';
  message.textContent = window.isSecureContext ? 'Open this studio in a desktop browser with screen capture support.' : 'Open this studio over HTTPS or localhost to record.';
}
