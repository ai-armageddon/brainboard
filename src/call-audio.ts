// Call cues are local output. Microphone tracks are attached to peer connections separately.
const notes = {
  join: [440, 660],
  leave: [660, 440],
  mute: [350, 262],
  unmute: [392, 523],
} as const;
type Cue = keyof typeof notes;

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
      const micCue = cue === 'mute' || cue === 'unmute';
      const spacing = micCue ? 0.075 : 0.13;
      const duration = micCue ? 0.1 : 0.18;
      const peak = micCue ? 0.14 : 0.2;
      const start = ctx.currentTime + 0.01;
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      tone.type = 'sine';
      tone.connect(gain);
      gain.connect(this.output);
      for (const [i, frequency] of notes[cue].entries()) {
        const at = start + spacing * i;
        tone.frequency.setValueAtTime(frequency, at);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(peak, at + 0.012);
        gain.gain.setValueAtTime(peak, at + 0.036);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + (i === 0 ? spacing - 0.004 : duration));
      }
      await new Promise<void>(resolve => {
        tone.onended = () => { tone.disconnect(); gain.disconnect(); resolve(); };
        tone.start(start);
        tone.stop(start + spacing + duration);
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
