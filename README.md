# Timegrapher

Browser-based mechanical watch timegrapher. Uses your microphone to measure:

- **Rate** — seconds gained or lost per day
- **Beat error** — tick/tock asymmetry in milliseconds
- **BPH** — auto-detected beat rate

**[Open the app →](https://j-sokol.github.io/timegrapher/)**

Works in Chrome and Edge. Place the watch directly on your laptop (touching the chassis) or use a contact mic for best results.

## How it works

Audio pipeline runs in an AudioWorklet (dedicated thread):

```
mic → gain → HPF 600 Hz → LPF 4000 Hz → rectify → envelope follower
  → adaptive noise floor → threshold crossing → tick event
```

Rate is computed using pairwise-slope median estimation: all pairs of detected ticks
≥2 s apart give an independent rate estimate; the median of those is robust to missed
ticks and occasional false triggers.

BPH auto-detection uses phasor coherence scoring: tick timestamps are projected onto
the unit circle at each candidate BPH frequency; the candidate with the tightest
phase clustering wins.

## Mic placement

- MacBook: place the watch face-down on the keyboard or directly on the aluminum base plate
- The watch must be physically touching the surface — air coupling is usually insufficient
- Co-axial escapements (Omega) need 15–25× gain; lever escapements (most watches) work at 5–10×

## Local dev

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.
