/**
 * AudioWorkletProcessor — timegrapher tick detector.
 *
 * Filter chain: input → gain → HPF(600 Hz) → LPF(4000 Hz) → rectify → envelope → threshold
 *
 * 2nd order Butterworth coefficients, fs = 44100 Hz:
 *
 *   HPF @ 600 Hz:
 *     k = tan(π×600/44100) = 0.042757
 *     denom = k² + √2·k + 1 = 1.062315
 *     b = [0.94133, -1.88267, 0.94133]
 *     a = [1.0,    -1.87984,  0.88612]
 *
 *   LPF @ 4000 Hz:
 *     k = tan(π×4000/44100) = 0.29262
 *     denom = k² + √2·k + 1 = 1.49953
 *     b = [0.05711, 0.11421, 0.05711]
 *     a = [1.0,    -1.22006, 0.44796]
 *
 * Messages IN:
 *   { type:'setBPH',       bph }
 *   { type:'setGain',      value }   1–50
 *   { type:'setThreshold', value }   1.2–10
 *
 * Messages OUT:
 *   { type:'tick',  sampleTime, snr }
 *   { type:'level', rms, noiseFloor, threshold }
 *   { type:'scope', data: Float32Array(512), threshold, noiseFloor }  — transferable
 */

const SCOPE_CHUNK = 512;

class TimegrapherProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // HPF @ 600 Hz
    this._hpB = [0.94133, -1.88267, 0.94133];
    this._hpA = [1.0, -1.87984, 0.88612];
    this._hpZ = [0, 0];

    // LPF @ 4000 Hz
    this._lpB = [0.05711, 0.11421, 0.05711];
    this._lpA = [1.0, -1.22006, 0.44796];
    this._lpZ = [0, 0];

    this._gain = 5.0;

    // Envelope: asymmetric attack/release via 1-pole IIR
    this._envelope  = 0;
    this._envAttack  = 1 - Math.exp(-1 / (0.0005 * sampleRate)); // ~0.5 ms
    this._envRelease = 1 - Math.exp(-1 / (0.020  * sampleRate)); // ~20 ms

    // Noise floor: slow downward tracker — tick peaks (>3× floor) never inflate it
    this._noiseFloor  = 0.001;
    this._noiseDecay  = 1 - Math.exp(-1 / (2.0 * sampleRate)); // 2 s time constant

    this._thresholdMult = 2.5;

    // Counts how many consecutive samples the envelope has been above threshold.
    // If it stays above for > 2× debounce without a falling edge, the noise floor is
    // too low for this watch (loud lever escapements like BB58). We raise it.
    this._samplesAbove = 0;

    // Debounce: 70% of the full inter-tick period.
    // At 28800 BPH: 3600/28800 × 44100 × 0.70 = 3858 samples = 87.5 ms
    this._debounceMin       = 3858;
    this._samplesSinceTick  = 99999;

    // Crossing state
    this._aboveThreshold = false;
    this._peakVal        = 0;
    this._peakSample     = 0;

    // Global sample counter
    this._sampleCount = 0;

    // Level meter (every 50 ms)
    this._rmsAccum    = 0;
    this._rmsCount    = 0;
    this._rmsInterval = Math.round(0.050 * sampleRate);

    // Scope ring buffer — sent in transferable chunks
    this._scopeBuf = new Float32Array(SCOPE_CHUNK);
    this._scopeIdx = 0;
    this._currentThreshold = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'setBPH') {
        // Debounce = 70% of the full inter-tick period (not half-period)
        this._debounceMin = Math.floor(3600 / data.bph * sampleRate * 0.70);
      }
      if (data.type === 'setGain') {
        this._gain = Math.max(1, Math.min(50, data.value));
      }
      if (data.type === 'setThreshold') {
        this._thresholdMult = Math.max(1.2, Math.min(10, data.value));
      }
      if (data.type === 'reset') {
        this._sampleCount = 0;
        this._envelope = 0;
        this._noiseFloor = 0.001;
        this._aboveThreshold = false;
        this._samplesAbove = 0;
        this._peakVal = 0;
        this._samplesSinceTick = 99999;
        this._hpZ = [0, 0];
        this._lpZ = [0, 0];
        this._rmsAccum = 0;
        this._rmsCount = 0;
        this._scopeIdx = 0;
      }
    };
  }

  _iir2(x, b, a, z) {
    const y = b[0] * x + z[0];
    z[0] = b[1] * x - a[1] * y + z[1];
    z[1] = b[2] * x - a[2] * y;
    return y;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      // 1. Gain
      let s = ch[i] * this._gain;

      // 2. Band-pass: HPF then LPF
      s = this._iir2(s, this._hpB, this._hpA, this._hpZ);
      s = this._iir2(s, this._lpB, this._lpA, this._lpZ);

      // 3. Rectify
      const rect = Math.abs(s);

      // 4. Envelope follower
      const alpha = rect > this._envelope ? this._envAttack : this._envRelease;
      this._envelope += alpha * (rect - this._envelope);

      // 5. Noise floor — only track when envelope is near ambient level
      //    Ticks are typically >> 3× noise floor; we don't let them bias the estimate.
      if (this._envelope < this._noiseFloor * 3.0) {
        const rate = this._envelope < this._noiseFloor
          ? this._noiseDecay * 2   // pull down faster
          : this._noiseDecay * 0.1; // creep up slowly
        this._noiseFloor += rate * (this._envelope - this._noiseFloor);
      }
      const minFloor = 0.00002 / this._gain;
      if (this._noiseFloor < minFloor) this._noiseFloor = minFloor;

      const threshold = this._noiseFloor * this._thresholdMult;
      this._currentThreshold = threshold;

      // 6. Threshold crossing with debounce
      const above = this._envelope > threshold;
      if (above && !this._aboveThreshold) {
        this._aboveThreshold = true;
        this._samplesAbove = 0;
        this._peakVal    = this._envelope;
        this._peakSample = this._sampleCount + i;
      } else if (above) {
        this._samplesAbove++;
        if (this._envelope > this._peakVal) {
          this._peakVal    = this._envelope;
          this._peakSample = this._sampleCount + i;
        }
        // Recovery: envelope stuck above threshold for 2× debounce — noise floor is too low.
        // Raise it so the inter-tick pedestal (loud watches) falls below the new threshold.
        if (this._samplesAbove > this._debounceMin * 2 && this._samplesSinceTick >= this._debounceMin) {
          this._noiseFloor = this._envelope / this._thresholdMult * 1.2;
          this._aboveThreshold = false;
          this._samplesAbove   = 0;
          this._peakVal        = 0;
        }
      } else if (!above && this._aboveThreshold) {
        this._aboveThreshold = false;
        this._samplesAbove   = 0;
        if (this._samplesSinceTick >= this._debounceMin) {
          this._samplesSinceTick = 0;
          this.port.postMessage({
            type: 'tick',
            sampleTime: this._peakSample,
            snr: this._peakVal / Math.max(this._noiseFloor, 1e-9),
          });
        }
        this._peakVal = 0;
      }
      this._samplesSinceTick++;

      // 7. Level meter
      this._rmsAccum += this._envelope * this._envelope;
      this._rmsCount++;

      // 8. Scope chunk
      this._scopeBuf[this._scopeIdx++] = this._envelope;
      if (this._scopeIdx >= SCOPE_CHUNK) {
        this.port.postMessage(
          { type: 'scope', data: this._scopeBuf, threshold, noiseFloor: this._noiseFloor },
          [this._scopeBuf.buffer]
        );
        this._scopeBuf = new Float32Array(SCOPE_CHUNK);
        this._scopeIdx = 0;
      }
    }

    this._sampleCount += ch.length;

    if (this._rmsCount >= this._rmsInterval) {
      const rms = Math.sqrt(this._rmsAccum / this._rmsCount);
      this.port.postMessage({
        type: 'level',
        rms,
        noiseFloor: this._noiseFloor,
        threshold: this._currentThreshold,
      });
      this._rmsAccum = 0;
      this._rmsCount = 0;
    }

    return true;
  }
}

registerProcessor('timegrapher-processor', TimegrapherProcessor);
