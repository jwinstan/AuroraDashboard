# Model

## Physical chain and forecast horizons
1. **Sun.** Coronal holes produce high-speed streams (500–800 km/s, recurring every ~27 days). Active regions produce CMEs.
2. **Transport (1–4 days).** The IMF's direction (Bz) can't be measured remotely. This is the dominant unknown for any forecast longer than about an hour.
3. **Coupling.** Dayside reconnection when Bz < 0. Rate ∝ Newell dΦ/dt = v^{4/3} B_T^{2/3} sin^{8/3}(θ_c/2), with θ_c = atan2(By, Bz) in GSM.
4. **Loading and release.** Substorms, typically 30–90 min after sustained southward Bz, start near magnetic midnight. Their timing is partly random.
5. **Precipitation.** 1–10 keV electrons; 557.7 nm (O, ~100–150 km) and 630 nm (O, >200 km).
   The oval moves equatorward with activity and is most equatorward around 23 MLT.
6. **Observer.** Oval overhead or within ~500 km poleward, dark sky, no low or mid cloud, little moonlight.

| Horizon | Source | Limit |
|---|---|---|
| ~27 d | Recurrence, NOAA 27-day outlook | Coronal holes evolve |
| 1–4 d | SDO AIA/HMI, coronagraphs, WSA–Enlil, NOAA 3-day Kp | Bz unknown; arrival time ±~10 h |
| 30–60 min | L1 RTSW, OVATION | Short warning; L1 is sometimes not representative |
| 0 | Magnetometers (FMI/IMAGE), all-sky cameras | No lead time |
| 0–3 d local | Weather models | Low cloud in an Arctic winter |

## Scoring (identical in `aurora_fi.py` and the dashboard)
- Dipole pole (80.8°N, 72.6°W). Geomagnetic latitude is from the dipole frame. MLT = 12 + (mlon − mlon_subsolar)/15.
  This is within ~1° of AACGM and ~30 min in MLT for Fennoscandia, and **poor near the pole (Greenland)**.
- Oval equatorward edge: `edge = 66.5 − 2·Kp + 3.5·(1 − cos(2π(MLT − 23)/24))`.
- `P_geo = 0.8 · max(0.6·σ((mlat − edge + 2.5)/1.5), σ((mlat − edge)/1.5))`.
  For hours within ~1.5 h, OVATION, max(overhead, ½·within 500 km north), can raise it. For hours within ~2 h, Kp = max(forecast slot, current estimate).
- **No poleward boundary yet.** Correct for Finland, wrong for northern Greenland and Svalbard (see PLAN.md).
- `P_clear = 1 − max(low, mid, ½·high)/100` (falls back to total cloud).
- Darkness: 0 for sun above −6°, 1 below −12°, linear in between.
- Moon: low-precision lunar ephemeris (checked against astropy: <0.15° altitude, <0.001 illuminated fraction).
  `factor = 1 − 0.5·illum·min(1, sin(alt)/sin 30°)` when the moon is up.
- Coupling labels (Newell, in (km/s)^{4/3} nT^{2/3}): <4k weak, 4–12k moderate, 12–25k strong, >25k very strong.
  Alert: Bz mean < −8 nT or Newell > 20k → strong; Bz < −3 nT with >60% southward → favourable.

## Confidence
Physical chain 0.9. Code matches the description 0.85. Calibration of the constants ~0.6: rules of thumb, not fitted.
