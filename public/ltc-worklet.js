import { LtcDecoder } from './tc-core.js';

class LtcProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channel = options?.processorOptions?.channel ?? 0;
    this.dec = new LtcDecoder(sampleRate);
    this.peak = 0;
    this.count = 0;
    this.levelEvery = Math.round(sampleRate / 15);
    this.port.onmessage = (e) => {
      if (Number.isInteger(e.data?.channel)) this.channel = e.data.channel;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && (input[this.channel] || input[0]);
    if (!ch) return true;
    const blockStart = this.dec.n;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > this.peak) this.peak = a;
    }
    this.count += ch.length;
    for (const f of this.dec.process(ch)) {
      this.port.postMessage({ type: 'frame', tc: f.tc, dir: f.dir, rate: f.rate, fps: f.fps, time: currentTime + (f.sample - blockStart) / sampleRate });
    }
    if (this.count >= this.levelEvery) {
      this.port.postMessage({ type: 'level', peak: this.peak, locked: this.dec.locked });
      this.peak = 0;
      this.count = 0;
    }
    return true;
  }
}

registerProcessor('objitter-ltc', LtcProcessor);
