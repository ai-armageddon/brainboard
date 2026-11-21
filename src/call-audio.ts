// Call cues are local output. Microphone tracks are attached to peer connections separately.
type Cue = 'join' | 'leave' | 'mute' | 'unmute';
interface Strike {
  at: number;
  hz: number;
  length: number;
  level: number;
  // Initial pitch relative to the settled note. Larger bends give the mic switch its tactile snap.
  bend: number;
}

// Join opens into a D-major voicing. Leave resolves downward with a lower, softer resonance.
const score: Record<Cue, Strike[]> = {
  join: [
    { at: 0, hz: 587.33, length: 0.18, level: 0.19, bend: 1.014 },
    { at: 0.082, hz: 880, length: 0.29, level: 0.21, bend: 1.009 },
    { at: 0.091, hz: 739.99, length: 0.21, level: 0.069, bend: 1 },
  ],
  leave: [
    { at: 0, hz: 739.99, length: 0.15, level: 0.16, bend: 1.01 },
    { at: 0.096, hz: 493.88, length: 0.24, level: 0.20, bend: 1.025 },
    { at: 0.099, hz: 369.99, length: 0.17, level: 0.065, bend: 1 },
  ],
  mute: [
    { at: 0, hz: 330, length: 0.105, level: 0.18, bend: 1.57 },
    { at: 0.003, hz: 220, length: 0.069, level: 0.075, bend: 1.06 },
  ],
  unmute: [
    { at: 0, hz: 440, length: 0.071, level: 0.135, bend: 0.88 },
    { at: 0.042, hz: 659.25, length: 0.125, level: 0.16, bend: 0.90 },
  ],
};

// Render once per cue. A rounded body sustains after the brighter struck overtones die away.
// The same mono mix plays on a phone speaker, a headset, or either earbud.
const buffers = new Map<Cue, AudioBuffer>();
function cueBuffer(ctx: AudioContext, cue: Cue) {
  const cached = buffers.get(cue);
  if (cached) return cached;
  const strikes = score[cue];
  const rate = 32000;
  const end = Math.max(...strikes.map(s => s.at + s.length));
  const buffer = ctx.createBuffer(1, Math.ceil(end * rate) + 1, rate);
  const pcm = buffer.getChannelData(0);
  for (const { at, hz, length, level, bend } of strikes) {
    const offset = Math.round(at * rate);
    const frames = Math.round(length * rate);
    for (let i = 0; i < frames; i++) {
      const t = i / rate;
      // Integral of a pitch bend settling exponentially over the first few milliseconds.
      const phase = 2 * Math.PI * hz * (t + (bend - 1) * 0.018 * -Math.expm1(-t / 0.018));
      const attack = Math.min(1, t / 0.004);
      const release = Math.min(1, (frames - 1 - i) / (rate * 0.012));
      const body = Math.sin(phase) * Math.exp(-4.2 * t / length);
      const overtone = 0.30 * Math.sin(2.007 * phase) * Math.exp(-9 * t / length);
      const strike = 0.16 * Math.sin(3.93 * phase) * Math.exp(-t / 0.014);
      pcm[offset + i] += level * attack * release * (body + overtone + strike);
    }
  }
  buffers.set(cue, buffer);
  return buffer;
}

export class CallAudio {
  readonly context = new AudioContext();
  readonly device: HTMLAudioElement | AudioContext;
  private readonly output: AudioNode;
  private closing = false;

  constructor() {
    const ctx = this.context;
    // Request playback during the Join click, before the board, name and mic permission prompts.
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    if ('setSinkId' in HTMLMediaElement.prototype && !('setSinkId' in ctx)) {
      // Some browsers can route a media element to the selected headset, but not an AudioContext.
      const stream = ctx.createMediaStreamDestination();
      const player = new Audio();
      player.srcObject = stream.stream;
      void player.play().catch(() => {});
      this.device = player;
      this.output = stream;
    } else {
      this.device = ctx;
      this.output = ctx.destination;
    }
  }

  async play(cue: Cue) {
    const ctx = this.context;
    try {
      if (ctx.state !== 'running') await ctx.resume();
      if (this.device instanceof HTMLMediaElement && this.device.paused) await this.device.play();
      if (ctx.state !== 'running' || (this.closing && cue !== 'leave')) return;
      const source = ctx.createBufferSource();
      source.buffer = cueBuffer(ctx, cue);
      source.connect(this.output);
      await new Promise<void>(resolve => {
        source.onended = () => { source.disconnect(); resolve(); };
        source.start();
      });
    } catch { /* An interrupted or closing audio device must not interrupt the call. */ }
  }

  close(playLeave = false) {
    if (this.closing) return;
    this.closing = true;
    const finish = () => {
      if (this.device instanceof HTMLMediaElement) {
        this.device.pause();
        const stream = this.device.srcObject;
        if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
        this.device.srcObject = null;
      }
      if (this.context.state !== 'closed') void this.context.close().catch(() => {});
    };
    if (!playLeave) return finish();
    // Release even if the browser suspends output before the final note ends.
    const timeout = window.setTimeout(finish, 1000);
    void this.play('leave').finally(() => { clearTimeout(timeout); finish(); });
  }
}
