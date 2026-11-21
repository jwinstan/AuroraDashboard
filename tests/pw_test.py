import json, math, os, random, subprocess, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

# Rebuild the single-file dashboard so this test reflects the current web/ sources.
subprocess.run([sys.executable, str(ROOT / "tools" / "build_single.py")], check=True)

now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S")
random.seed(1)
def mag():
    out=[]
    for i in range(400,0,-1):
        t=now-timedelta(minutes=i)
        bz = -5*math.sin(i/60) + random.gauss(0,1.2)
        for s in ("SOLAR1","DSCOVR"):
            out.append({"time_tag":iso(t),"active":s=="SOLAR1","source":s,"bz_gsm":bz,"by_gsm":2.0,"bt":8.5+random.gauss(0,.3)})
    return out
def wind():
    out=[{"time_tag":iso(now-timedelta(minutes=i)),"active":True,"source":"SOLAR1","proton_speed":420+random.gauss(0,8),"proton_density":2.5} for i in range(400,0,-1)]
    out[-200]["proton_speed"]=2300
    return out
def kpfc():
    t0 = now.replace(hour=(now.hour//3)*3, minute=0)-timedelta(days=3)
    return [["time_tag","kp","observed","noaa_scale"]]+[[ (t0+timedelta(hours=3*i)).strftime("%Y-%m-%d %H:%M:%S"), f"{2+1.6*math.sin(i/2):.2f}", "observed" if i<24 else ("estimated" if i<27 else "predicted"), None] for i in range(48)]
def kpnow(): return [{"time_tag":iso(now-timedelta(minutes=1)),"kp_index":2,"estimated_kp":2.33}]
def ova(): return {"Forecast Time":iso(now+timedelta(minutes=40))+"Z","coordinates":[[lo,la,max(0,30-6*abs(la-68))] for lo in range(360) for la in range(-90,91)]}
def om(q):
    lats=q["latitude"][0].split(","); res=[]
    ts=[now.replace(minute=0)-timedelta(hours=now.hour)+timedelta(hours=i) for i in range(72)]
    for j,_ in enumerate(lats):
        res.append({"hourly":{"time":[t.strftime("%Y-%m-%dT%H:%M") for t in ts],
            "cloud_cover":[90]*72,"cloud_cover_low":[max(0,min(100,int(50+50*math.sin(i/5+j)))) for i in range(72)],
            "cloud_cover_mid":[20]*72,"cloud_cover_high":[40]*72}})
    return res if len(lats)>1 else res[0]

def handle(route):
    u=urlparse(route.request.url); p=u.path
    if "rtsw_mag" in p: body=mag()
    elif "rtsw_wind" in p: body=wind()
    elif "k-index-forecast" in p: body=kpfc()
    elif "planetary_k_index_1m" in p: body=kpnow()
    elif "ovation" in p: body=ova()
    elif "open-meteo" in u.hostname: body=om(parse_qs(u.query))
    else: return route.fulfill(status=404, body="nf")
    route.fulfill(status=200, body=json.dumps(body), headers={"Content-Type":"application/json","Access-Control-Allow-Origin":"*"})

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=os.environ.get("CHROME") or None, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width":1240,"height":900})
    errs=[]
    pg.on("console", lambda m: errs.append(m.text) if m.type in ("error","warning") else None)
    pg.on("pageerror", lambda e: errs.append("PAGEERROR "+str(e)))
    for h in ["services.swpc.noaa.gov","api.open-meteo.com","api.met.no"]:
        pg.route(f"https://{h}/**", handle)
    pg.goto((ROOT / "aurora_dashboard.html").as_uri())
    pg.wait_for_timeout(2500)
    pg.mouse.move(500, 520)
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(ROOT / "tests" / "shot.png"), full_page=True)
    print("errors:", errs)
    print(pg.inner_text("#where")); print(pg.inner_text("#errors")); print(pg.inner_text("#t-verdict"), pg.inner_text("#t-window"))
    b.close()
