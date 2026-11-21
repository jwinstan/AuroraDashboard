"""Load config/places.json and expose it as flat mappings."""
import json
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_PATH = _ROOT / "config" / "places.json"


def load():
    with open(_PATH, encoding="utf-8") as f:
        return json.load(f)


def flat_places(config=None):
    """{key: (name, lat, lon, country_code, tz)} flattened across all countries.

    Each place inherits its country's tz unless it overrides it (Svalbard, Faroe,
    Scoresbysund, Thule all sit in a parent country but have their own IANA zone).
    """
    cfg = config or load()
    out = {}
    for cc, c in cfg["countries"].items():
        ctz = c["tz"]
        for k, p in c["places"].items():
            out[k] = (p["name"], p["lat"], p["lon"], cc, p.get("tz", ctz))
    return out


def raw_path():
    return _PATH
