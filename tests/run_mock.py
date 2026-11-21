import sys, random, math
from pathlib import Path
from datetime import datetime, timedelta, timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import aurora_fi as A

now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
fmt = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S")
FORMAT = sys.argv[1] if len(sys.argv) > 1 else "dicts"

def mag():
    if FORMAT == "lists":
        return [["time_tag","bx_gsm","by_gsm","bz_gsm","lon_gsm","lat_gsm","bt"]] + \
            [[(now-timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S.000"), "1", "2.0", str(-6+random.random()), "0","0","7.5"] for i in range(60,0,-1)]
    return [{"time_tag": fmt(now-timedelta(minutes=i)), "active": s=="SOLAR-1", "source": s,
             "bz_gsm": -6+random.random(), "by_gsm": 2.0, "bt": 7.5} for i in range(60,0,-1) for s in ("SOLAR-1","DSCOVR")]
def wind():
    if FORMAT == "lists":
        return [["time_tag","density","speed","temperature"]] + \
            [[(now-timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S.000"), "5.1", "560", "1e5"] for i in range(60,0,-1)]
    return [{"time_tag": fmt(now-timedelta(minutes=i)), "active": True, "source": "SOLAR-1",
             "proton_speed": 560, "proton_density": 5.1} for i in range(60,0,-1)]
def kpfc():
    t0 = now.replace(hour=(now.hour//3)*3, minute=0) - timedelta(days=1)
    vals = [(t0+timedelta(hours=3*i)) for i in range(32)]
    if FORMAT == "lists":
        return [["time_tag","kp","observed","noaa_scale"]] + [[t.strftime("%Y-%m-%d %H:%M:%S"), f"{2+math.sin(i):.2f}", "predicted", None] for i,t in enumerate(vals)]
    return [{"time_tag": fmt(t), "kp": 2+math.sin(i), "observed": "predicted"} for i,t in enumerate(vals)]
def kpnow():
    return [{"time_tag": fmt(now-timedelta(minutes=1)), "kp_index": 2, "estimated_kp": 2.67, "kp": "3M"}]
def ova():
    return {"Forecast Time": fmt(now+timedelta(minutes=40)),
            "coordinates": [[lo, la, max(0, 40 - 8*abs(la-68))] for lo in range(360) for la in range(-90,91)]}
def cloud(lat, lon):
    ts = [now.replace(minute=0)-timedelta(hours=now.hour)+timedelta(hours=i) for i in range(72)]
    return {"hourly": {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in ts],
        "cloud_cover": [random.randint(0,100) for _ in ts], "cloud_cover_low": [random.randint(0,100) for _ in ts],
        "cloud_cover_mid": [random.randint(0,60) for _ in ts], "cloud_cover_high": [None if i%7==0 else 30 for i,_ in enumerate(ts)]}}

def fake(urls, timeout=20):
    u = urls[0]
    if "mag" in u: return mag()
    if "wind" in u or "plasma" in u: return wind()
    if "forecast.json" in u and "k-index" in u: return kpfc()
    if "planetary_k_index_1m" in u: return kpnow()
    if "ovation" in u: return ova()
    if "open-meteo" in u: raise RuntimeError("handshake timed out")
    if "met.no" in u:
        ts=[now.replace(minute=0)+timedelta(hours=i) for i in range(60)]
        return {"properties":{"timeseries":[{"time":t.strftime("%Y-%m-%dT%H:%M:%SZ"),"data":{"instant":{"details":{
            "cloud_area_fraction":50,"cloud_area_fraction_low":random.randint(0,100),"cloud_area_fraction_medium":10,"cloud_area_fraction_high":40}}}} for t in ts]}}
    raise RuntimeError(u)
A.fetch = fake
sys.argv = ["aurora_fi.py"] + sys.argv[2:]
A.main()
