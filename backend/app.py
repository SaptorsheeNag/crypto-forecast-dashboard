from flask import Flask, jsonify, request, g, make_response
import requests, time, math, statistics, os, sqlite3, secrets, random
import datetime as dt
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
from itsdangerous import TimestampSigner, BadSignature
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import nltk
from nltk.sentiment import SentimentIntensityAnalyzer
from contextlib import contextmanager

app = Flask(__name__)
load_dotenv()
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

ONE_DAY = 24 * 3600
ONE_YEAR = 365 * ONE_DAY
CRYPTOCOMPARE_API_KEY = os.getenv("CRYPTOCOMPARE_API_KEY", "")

# --- prediction/scenario defaults ---
PREDICTION_MAX_DAYS = 180  # cap ML-ish forecasts to 180 days (responsible scope)
SCENARIO_MAX_YEARS = 20  # long horizon for Monte-Carlo
SCENARIO_STEPSIZE = 7  # simulate weekly steps to keep things fast


FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
app.config["SECRET_KEY"] = os.getenv(
    "APP_SECRET", "dev-secret-change-me"
)  # ⚠️ set in prod

# --- Anonymous uid cookie (signed) ---
signer = TimestampSigner(app.config["SECRET_KEY"])

DB_URL  = os.getenv("DATABASE_URL")
DB_PATH = os.getenv("DB_PATH", "app.db")

def _db():
    """
    Postgres when DATABASE_URL is set, else SQLite.
    Appends sslmode=require to Postgres URL if missing.
    """
    if DB_URL:
        import psycopg
        from psycopg.rows import dict_row

        conninfo = DB_URL
        # Ensure sslmode=require is present (important for Supabase/managed PG)
        if "sslmode=" not in conninfo:
            conninfo += ("&" if "?" in conninfo else "?") + "sslmode=require"

        # A short connect timeout helps boot quickly if DB is unreachable.
        # psycopg accepts connect_timeout in seconds via conninfo.
        if "connect_timeout=" not in conninfo:
            conninfo += ("&" if "?" in conninfo else "?") + "connect_timeout=5"

        return psycopg.connect(conninfo, autocommit=False, row_factory=dict_row)
    else:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.row_factory = sqlite3.Row
        return conn
    
# Small helper to get a cursor that yields dicts on Postgres; no-op for SQLite
@contextmanager
def _cursor(conn):
    cur = conn.cursor()
    try:
        yield cur
    finally:
        try:
            cur.close()
        except Exception:
            pass
def _row_to_dict(row):
    """Works for both sqlite3.Row and psycopg tuple rows with cursor.description."""
    if isinstance(row, sqlite3.Row):
        return {k: row[k] for k in row.keys()}
    # psycopg returns tuples; use cursor.description from the connection
    # We'll attach column names on fetch in the query helpers below when using Postgres.
    # For simple use here: if it's already a dict, just return it.
    if isinstance(row, dict):
        return row
    # generic tuple fallback (shouldn't hit if we fetch with dict cursor below)
    return dict(row)

def _init_db():
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute("""
            CREATE TABLE IF NOT EXISTS holdings (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            coin       TEXT NOT NULL,
            amount     REAL NOT NULL,
            buy_price  REAL NOT NULL,
            created_at INTEGER NOT NULL,
            ccy        TEXT NOT NULL DEFAULT 'USD'
            )""")
            c.execute("""
            CREATE TABLE IF NOT EXISTS alerts (
            id         TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            coin       TEXT NOT NULL,
            op         TEXT NOT NULL,
            value      REAL NOT NULL,
            created_at INTEGER NOT NULL,
            ccy        TEXT NOT NULL DEFAULT 'USD'
            )""")
            c.execute("""
            CREATE TABLE IF NOT EXISTS goals (
            user_id TEXT PRIMARY KEY,
            amount  REAL NOT NULL DEFAULT 0,
            date    TEXT NOT NULL DEFAULT '',
            ccy     TEXT NOT NULL DEFAULT 'USD'
            )""")
            # indexes (same syntax works on Postgres & SQLite)
            c.execute("CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_alerts_user   ON alerts(user_id)")
            c.execute("CREATE INDEX IF NOT EXISTS idx_goals_user    ON goals(user_id)")
            conn.commit()





# Allow cookies from your frontend
CORS(
    app,
    resources={r"/api/*": {"origins": [FRONTEND_ORIGIN, "http://127.0.0.1:3000"]}},
    supports_credentials=True,
)

def _ensure_uid():
    raw = request.cookies.get("uid")
    if raw:
        try:
            uid = signer.unsign(raw, max_age=365 * 24 * 3600).decode()
            g.uid = uid
            g._needs_cookie = False
            return
        except BadSignature:
            pass
    # create a fresh uid for this browser
    uid = "u_" + secrets.token_urlsafe(16)
    g.uid = uid
    g._needs_cookie = True

@app.before_request
def _before_any_request():
    _ensure_uid()


@app.after_request
def _after_any_response(resp):
    if getattr(g, "_needs_cookie", False):
        signed = signer.sign(g.uid.encode()).decode()
        resp.set_cookie(
            "uid",
            signed,
            max_age=365 * 24 * 3600,
            httponly=True,
            samesite=os.getenv("COOKIE_SAMESITE", "Lax"),
            secure=(request.is_secure or os.getenv("FORCE_SECURE_COOKIES") == "1"),
        )

    # light caching for read-only market endpoints
    try:
        path = request.path or ""
        if path.startswith("/api/prices"):
            resp.headers["Cache-Control"] = "public, max-age=30"
        elif path.startswith("/api/history"):
            resp.headers["Cache-Control"] = "public, max-age=300"
    except Exception:
        pass

    return resp

# Run schema creation on the first HTTP request to this worker.
# This prevents the app from crashing during import if the DB is temporarily down.
SCHEMA_INITIALIZED = False

@app.before_request
def _bootstrap_schema_once():
    global SCHEMA_INITIALIZED
    if SCHEMA_INITIALIZED:
        return
    try:
        _init_db()
        SCHEMA_INITIALIZED = True
        app.logger.info("DB schema initialized.")
    except Exception as e:
        # Don't crash on startup if DB is briefly unavailable
        app.logger.exception("Skipping schema init (will retry on next request): %s", e)


@app.route("/api/session/init", methods=["GET"])
def session_init():
    # _ensure_uid() already ran in before_request and will set the cookie in after_request
    return jsonify({"ok": True, "uid": getattr(g, "uid", None)})


# ---- HOLDINGS ----
@app.route("/api/holdings", methods=["GET"])
def list_holdings():
    sql = (
    "SELECT id, coin, amount, buy_price as \"buyPrice\", ccy, created_at "
    "FROM holdings WHERE user_id=%s ORDER BY created_at DESC"
    if DB_URL else
    "SELECT id, coin, amount, buy_price as buyPrice, ccy, created_at "
    "FROM holdings WHERE user_id=? ORDER BY created_at DESC"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            rows = c.fetchall()
    return jsonify([_row_to_dict(r) for r in rows])



# --- Normal (to-date) portfolio history: sum daily value across holdings ---
@app.route("/api/portfolio_history")
def api_portfolio_history():
    """
    Optional query: days (default 365)
    Returns: { "series": [[ts_ms, total_value_usd], ...] }
    """
    try:
        days = int(request.args.get("days", "365"))
        days = max(1, min(days, 3650))  # up to 10y if you want
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    # load user holdings
    sql = (
        "SELECT coin, amount FROM holdings WHERE user_id=%s"
        if DB_URL else
        "SELECT coin, amount FROM holdings WHERE user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            rows = c.fetchall()

    if not rows:
        return jsonify({"series": []})

    # build per-day USD value for each coin and sum
    agg = {}  # ts_ms -> total value
    for r in rows:
        coin = r["coin"]
        qty  = float(r["amount"] or 0)
        if qty <= 0:
            continue

        daily = get_daily_closes(coin, days)  # [[ts_ms, price], ...] one per day
        for ts, px in daily:
            agg[ts] = agg.get(ts, 0.0) + qty * float(px)

    series = sorted([[ts, v] for ts, v in agg.items()], key=lambda x: x[0])
    return jsonify({"series": series})


@app.route("/api/holdings", methods=["POST"])
def upsert_holding():
    data = request.get_json(force=True) or {}
    hid = data.get("id") or ("h_" + secrets.token_urlsafe(12))
    coin = str(data.get("coin", "")).lower()
    ccy = str(data.get("ccy", "USD")).upper()
    try:
        amount = float(data.get("amount", 0) or 0)
        buy = float(data.get("buyPrice", 0) or 0)
    except Exception:
        return jsonify({"error": "Invalid numeric fields."}), 400
    if not coin or amount <= 0 or buy <= 0:
        return jsonify({"error": "Invalid holding."}), 400
    now = int(time.time())
    sql = (
    """
    INSERT INTO holdings (id, user_id, coin, amount, buy_price, created_at, ccy)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (id) DO UPDATE
      SET coin=excluded.coin,
          amount=excluded.amount,
          buy_price=excluded.buy_price,
          ccy=excluded.ccy
    """
    if DB_URL else
    """
    INSERT INTO holdings (id, user_id, coin, amount, buy_price, created_at, ccy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE
      SET coin=excluded.coin,
          amount=excluded.amount,
          buy_price=excluded.buy_price,
          ccy=excluded.ccy
    """
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (hid, g.uid, coin, amount, buy, now, ccy))
        conn.commit()



@app.route("/api/holdings/<hid>", methods=["DELETE"])
def delete_holding(hid):
    sql = (
    "DELETE FROM holdings WHERE id=%s AND user_id=%s"
    if DB_URL else
    "DELETE FROM holdings WHERE id=? AND user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (hid, g.uid))
        conn.commit()
    return jsonify({"ok": True})


# ---- ALERTS ----
@app.route("/api/alerts", methods=["GET"])
def list_alerts():
    sql = (
    "SELECT id, coin, op, value, ccy, created_at FROM alerts WHERE user_id=%s ORDER BY created_at DESC"
    if DB_URL else
    "SELECT id, coin, op, value, ccy, created_at FROM alerts WHERE user_id=? ORDER BY created_at DESC"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            rows = c.fetchall()
    return jsonify([_row_to_dict(r) for r in rows])


@app.route("/api/alerts", methods=["POST"])
def upsert_alert():
    data = request.get_json(force=True) or {}
    aid = data.get("id") or ("a_" + secrets.token_urlsafe(12))
    coin = str(data.get("coin", "")).lower()
    op = data.get("op")
    ccy = str(data.get("ccy", "USD")).upper()
    try:
        val = float(data.get("value", 0) or 0)
    except Exception:
        return jsonify({"error": "Invalid value."}), 400
    if not coin or op not in ("gte", "lte") or val <= 0:
        return jsonify({"error": "Invalid alert."}), 400
    now = int(time.time())
    sql = (
    """
    INSERT INTO alerts (id, user_id, coin, op, value, created_at, ccy)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (id) DO UPDATE
      SET coin=excluded.coin,
          op=excluded.op,
          value=excluded.value,
          ccy=excluded.ccy
    """
    if DB_URL else
    """
    INSERT INTO alerts (id, user_id, coin, op, value, created_at, ccy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE
      SET coin=excluded.coin,
          op=excluded.op,
          value=excluded.value,
          ccy=excluded.ccy
    """
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (aid, g.uid, coin, op, val, now, ccy))
        conn.commit()
    return jsonify({"id": aid, "coin": coin, "op": op, "value": val, "ccy": ccy})


@app.route("/api/alerts/<aid>", methods=["DELETE"])
def delete_alert(aid):
    sql = (
    "DELETE FROM alerts WHERE id=%s AND user_id=%s"
    if DB_URL else
    "DELETE FROM alerts WHERE id=? AND user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (aid, g.uid))
        conn.commit()
    return jsonify({"ok": True})


# ---- GOAL ----
@app.route("/api/goal", methods=["GET"])
def get_goal():
    sql = (
    "SELECT amount, date, ccy FROM goals WHERE user_id=%s"
    if DB_URL else
    "SELECT amount, date, ccy FROM goals WHERE user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            row = c.fetchone()
    if row:
        return jsonify(
            {"amount": row["amount"], "date": row["date"], "ccy": row["ccy"] or "USD"}
        )
    return jsonify({"amount": 0, "date": "", "ccy": "USD"})


@app.route("/api/goal", methods=["PUT"])
def put_goal():
    data = request.get_json(force=True) or {}
    try:
        amount = float(data.get("amount", 0) or 0)
    except Exception:
        return jsonify({"error": "Invalid amount."}), 400
    date = str(data.get("date", "") or "")
    ccy = str(data.get("ccy", "USD")).upper()
    sql = (
    """
    INSERT INTO goals (user_id, amount, date, ccy)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT (user_id) DO UPDATE
      SET amount=excluded.amount,
          date=excluded.date,
          ccy=excluded.ccy
    """
    if DB_URL else
    """
    INSERT INTO goals (user_id, amount, date, ccy)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE
      SET amount=excluded.amount,
          date=excluded.date,
          ccy=excluded.ccy
    """
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid, amount, date, ccy))
        conn.commit()
    return jsonify({"amount": amount, "date": date, "ccy": ccy})


@app.route("/api/me")
def me():
    return jsonify({"uid": getattr(g, "uid", None)})


# Ensure VADER exists
try:
    nltk.data.find("sentiment/vader_lexicon")
except LookupError:
    nltk.download("vader_lexicon", quiet=True)

UA = {"User-Agent": "crypto-dashboard/1.0 (learning project)"}
CG_KEY = os.getenv("CG_KEY")  # optional: demo/pro key


# ---------- single session + gentle retry ----------
def _build_session():
    s = requests.Session()
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        status=2,
        backoff_factor=0.35,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)

    s.headers.update(UA)

    # 👉 Free/demo API uses ONLY this header. Do NOT send any "pro" headers.
    if CG_KEY:
        s.headers["x-cg-demo-api-key"] = CG_KEY

    return s


SESSION = _build_session()

# ---------- tiny in-memory caches ----------
PRICES_CACHE = {"t": 0.0, "data": None}  # 60s TTL
PRICES_TTL = 60

HIST_CACHE = {}  # key: (coin, days) -> {"t": ts, "data": {...}}
HIST_TTL = 600  # 10 minutes

# big series cache: /market_chart?days=max per coin (24h TTL)
FULL_SERIES_CACHE = {}  # coin_id -> {"t": ts, "data": [[ts_ms, price], ...]}
FULL_SERIES_TTL = 24 * 3600

# cache for big "days" fetches (optional but nice)
_SERIES_DAYS_CACHE = {}
_SERIES_DAYS_TTL = 24 * 3600  # 24h


def _valid_history(j):
    return isinstance(j, dict) and isinstance(j.get("prices"), list)


# ---------- cached simple/price ----------
def cached_get_json(url: str, ttl: int):
    now = time.time()
    # 1) serve recent cache
    if PRICES_CACHE["data"] is not None and (now - PRICES_CACHE["t"] < ttl):
        return PRICES_CACHE["data"]

    # 2) fetch fresh (fall back to stale if 429 or error)
    try:
        r = SESSION.get(url, timeout=10)
        if r.status_code == 429 and PRICES_CACHE["data"] is not None:
            return PRICES_CACHE["data"]
        data = r.json()
        # JSON-wrapped 429 from CG
        if (
            isinstance(data, dict)
            and data.get("status", {}).get("error_code") == 429
            and PRICES_CACHE["data"] is not None
        ):
            return PRICES_CACHE["data"]
        PRICES_CACHE["t"] = now
        PRICES_CACHE["data"] = data
        return data
    except Exception:
        # last resort: stale (or empty)
        return PRICES_CACHE["data"] or {}


# ---------- cached market_chart ----------
INTERVAL_FOR = {"1": "hourly", "7": "hourly", "30": "daily"}


def fetch_history_cached(coin_id: str, days: str):
    key = (coin_id, str(days))
    now = time.time()

    # 1) serve recent cache
    if key in HIST_CACHE and (now - HIST_CACHE[key]["t"] < HIST_TTL):
        return HIST_CACHE[key]["data"]

    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
    params = {
        "vs_currency": "usd",
        "days": days,
        "interval": INTERVAL_FOR.get(str(days), "daily"),
    }

    def hit(p):
        try:
            r = SESSION.get(url, params=p, timeout=12)
            try:
                j = r.json()
            except Exception:
                j = {}
            # debug when empty
            if not isinstance(j, dict) or not j.get("prices"):
                print(
                    f"[history debug] coin={coin_id} days={days} status={r.status_code} len={len(r.text)} params={p}"
                )
            return r.status_code, j
        except Exception as e:
            print(f"[history debug] exception coin={coin_id} days={days}: {e}")
            return None, {}

    # 2) try with interval, then relax if limited/empty
    status, j = hit(params)
    limited = (status == 429) or (
        isinstance(j, dict) and j.get("status", {}).get("error_code") == 429
    )
    empty = not _valid_history(j) or not j.get("prices")

    if not limited and not empty:
        HIST_CACHE[key] = {"t": time.time(), "data": j}
        return j

    # 3) retry once without interval (some CG modes prefer default)
    status, j = hit({"vs_currency": "usd", "days": days})
    if _valid_history(j) and j.get("prices"):
        HIST_CACHE[key] = {"t": time.time(), "data": j}
        return j

    # 4) last resort: serve stale if we have anything
    if key in HIST_CACHE:
        return HIST_CACHE[key]["data"]

    return {"prices": []}


# ================== endpoints ==================

# ---- FX (USD base) ----
FX_CACHE = {"t": 0.0, "data": {"USD": 1.0}}
FX_TTL = 3600  # 1 hour

_WANTED = ("EUR", "GBP", "INR", "JPY")


def _num(x):
    try:
        return float(x)
    except Exception:
        return None


def _normalize_rates(d):
    out = {"USD": 1.0}
    for k, v in (d or {}).items():
        k2 = str(k).upper()
        nv = _num(v)
        if nv is not None and nv > 0:
            out[k2] = nv
    return out


@app.route("/api/fx")
def fx_rates():
    now = time.time()
    if now - FX_CACHE["t"] < FX_TTL and FX_CACHE["data"]:
        return jsonify(FX_CACHE["data"])

    # 1) exchangerate.host
    try:
        r = SESSION.get(
            "https://api.exchangerate.host/latest",
            params={"base": "USD", "symbols": ",".join(_WANTED)},
            timeout=8,
        )
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        rates = _normalize_rates(j.get("rates"))
        if len(rates) > 1:  # we have more than USD
            FX_CACHE["t"] = now
            FX_CACHE["data"] = rates
            return jsonify(rates)
    except Exception:
        pass

    # 2) open.er-api.com
    try:
        r = SESSION.get("https://open.er-api.com/v6/latest/USD", timeout=8)
        if r.status_code == 404:  # in case a mirror without hyphen is in use
            r = SESSION.get("https://open.erapi.com/v6/latest/USD", timeout=8)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        rates = _normalize_rates(j.get("rates"))
        # keep only wanted + USD
        rates = {"USD": 1.0, **{k: rates[k] for k in _WANTED if k in rates}}
        if len(rates) > 1:
            FX_CACHE["t"] = now
            FX_CACHE["data"] = rates
            return jsonify(rates)
    except Exception:
        pass


    # 3) Frankfurter
    try:
        r = SESSION.get(
            "https://api.frankfurter.app/latest", params={"from": "USD"}, timeout=8
        )
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        rates = _normalize_rates(j.get("rates"))
        rates = {"USD": 1.0, **{k: rates[k] for k in _WANTED if k in rates}}
        if len(rates) > 1:
            FX_CACHE["t"] = now
            FX_CACHE["data"] = rates
            return jsonify(rates)
    except Exception:
        pass

    # last resort: whatever we had (likely {"USD":1.0})
    return jsonify(FX_CACHE["data"])


@app.route("/api/prices")
def get_prices():
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,dogecoin&vs_currencies=usd"
    data = cached_get_json(url, ttl=PRICES_TTL)
    return jsonify(data if isinstance(data, dict) else {})


@app.route("/api/history/<coin_id>/<days>")
def get_history(coin_id, days):
    data = fetch_history_cached(coin_id, days)
    if not isinstance(data, dict) or "prices" not in data:
        data = {"prices": []}
    return jsonify(data)


@app.route("/api/forecast/<coin_id>")
def api_forecast(coin_id):
    """
    Query: h (<=180), season_len (default 7)
    Returns: {history:[...], forecast:[...], ci_low:[...], ci_high:[...]}
    """
    try:
        h = int(request.args.get("h", "90"))
        h = max(1, min(h, PREDICTION_MAX_DAYS))
        season_len = int(request.args.get("season_len", "7"))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    # get 365d daily closes (free, via your fallback)
    daily = get_daily_closes(coin_id, 365)
    history = daily[-120:]  # send a slimmer tail for charting

    f, lo, hi = holt_winters_additive(daily, h=h, season_len=season_len)
    if not f:
        return jsonify({"error": "Not enough data for forecast"}), 422

    return jsonify(
        {
            "coin": coin_id,
            "h": h,
            "history": history,
            "forecast": f,
            "ci_low": lo,
            "ci_high": hi,
            "method": "holt_winters_additive",
        }
    )


@app.route("/api/scenario/<coin_id>")
def api_scenario(coin_id):
    """
    Query: years (<=20), step_days (default=7), n (paths, default=300)
    Returns: percentile bands {'p10','p50','p90'} over future timestamps.
    """
    try:
        years = float(request.args.get("years", "10"))
        years = max(0.1, min(years, SCENARIO_MAX_YEARS))
        step_days = int(request.args.get("step_days", str(SCENARIO_STEPSIZE)))
        n_paths = int(request.args.get("n", "300"))
        n_paths = max(50, min(n_paths, 1000))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    daily = get_daily_closes(coin_id, 365)  # calibrate from last year
    bands = gbm_scenarios(
        daily, horizon_days=int(years * 365), step_days=step_days, n_paths=n_paths
    )
    if not bands["p50"]:
        return jsonify({"error": "Not enough data for scenarios"}), 422

    return jsonify({"coin": coin_id, "years": years, "step_days": step_days, **bands})


@app.route("/api/whatif_predict")
def api_whatif_predict():
    """
    Query: coin_id, amount (USD), h (<=180)
    Interprets as: invest 'amount' today at current price, forecast value forward.
    """
    coin_id = request.args.get("coin_id", "bitcoin").lower()
    try:
        amount = float(request.args.get("amount", "500"))
        if amount <= 0:
            raise ValueError()
        h = int(request.args.get("h", "90"))
        h = max(1, min(h, PREDICTION_MAX_DAYS))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    daily = get_daily_closes(coin_id, 365)
    if not daily:
        return jsonify({"error": "No history"}), 422

    current_price = float(daily[-1][1])
    shares = amount / current_price if current_price > 0 else 0.0

    f, lo, hi = holt_winters_additive(daily, h=h, season_len=7)
    if not f:
        return jsonify({"error": "Forecast failed"}), 422

    # value series (base + forecast)
    hist_val = [[ts, px * shares] for ts, px in daily[-60:]]  # small tail
    fut_val = [[ts, px * shares] for ts, px in f]
    fut_lo = [[ts, max(0.0, px * shares)] for ts, px in lo]
    fut_hi = [[ts, max(0.0, px * shares)] for ts, px in hi]

    return jsonify(
        {
            "coin": coin_id,
            "amount": amount,
            "current_price": current_price,
            "shares": shares,
            "series": hist_val + fut_val,
            "bands": {"low": fut_lo, "high": fut_hi},
        }
    )


@app.route("/api/dca_predict")
def api_dca_predict():
    """
    Query: coin_id, amount (USD per step), freq ('weekly'|'monthly'), months (<=6)
    Builds a future contribution schedule and values it using forecast.
    """
    coin_id = request.args.get("coin_id", "bitcoin").lower()
    freq = request.args.get("freq", "weekly")
    try:
        amt_per = float(request.args.get("amount", "50"))
        if amt_per <= 0:
            raise ValueError()
        months = int(request.args.get("months", "3"))
        months = max(1, min(months, 6))  # ~<=180 days
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    horizon_days = min(PREDICTION_MAX_DAYS, months * 30)
    step_days = 7 if freq == "weekly" else 30

    # get daily history and forecast future closes
    daily = get_daily_closes(coin_id, 365)
    if not daily:
        return jsonify({"error": "No history"}), 422
    f, lo, hi = holt_winters_additive(daily, h=horizon_days, season_len=7)
    if not f:
        return jsonify({"error": "Forecast failed"}), 422

    # index future closes by day timestamp for quick lookup
    fut_map = {_to_midnight_utc(int(ts / 1000)) * 1000: px for ts, px in f}
    low_map = {_to_midnight_utc(int(ts / 1000)) * 1000: px for ts, px in lo}
    high_map = {_to_midnight_utc(int(ts / 1000)) * 1000: px for ts, px in hi}

    # schedule future contributions starting tomorrow (aligned to step boundary)
    today_ms = int(daily[-1][0])
    first_ms = today_ms + step_days * ONE_DAY * 1000

    shares = 0.0
    invested = 0.0

    value_series = []
    low_series = []  # portfolio low path (CI)
    high_series = []  # portfolio high path (CI)

    cursor = first_ms
    end_ms = today_ms + horizon_days * ONE_DAY * 1000

    while cursor <= end_ms:
        key = _to_midnight_utc(int(cursor / 1000)) * 1000
        px = fut_map.get(key)

        # buy at central forecast price
        if px and px > 0:
            shares += amt_per / px
            invested += amt_per

        # central value on this day
        central_px = px if px else (fut_map.get(min(fut_map.keys())) if fut_map else 0)
        value_series.append([cursor, central_px * shares])

        # CI values (same shares * low/high forecast)
        if key in low_map:
            low_series.append([cursor, max(0.0, low_map[key] * shares)])
        if key in high_map:
            high_series.append([cursor, max(0.0, high_map[key] * shares)])

        cursor += step_days * ONE_DAY * 1000

    # horizon snapshot
    final_px = f[-1][1]
    current_value = shares * final_px if final_px > 0 else 0.0
    roi_pct = ((current_value - invested) / invested * 100.0) if invested > 0 else 0.0

    return jsonify(
        {
            "coin": coin_id,
            "freq": freq,
            "amount_per": amt_per,
            "months": months,
            "invested_total": invested,
            "shares": shares,
            "current_value": current_value,
            "roi_pct": roi_pct,
            "series": value_series,
            "bands": {
                "low": low_series,  # ⬅ time series
                "high": high_series,  # ⬅ time series
            },
        }
    )

# app.py (near other scenario endpoints)
@app.route("/api/whatif_scenario")
def api_whatif_scenario():
    coin_id = request.args.get("coin_id", "bitcoin").lower()
    try:
        amount = float(request.args.get("amount", "500"))
        if amount <= 0: raise ValueError()
        years = float(request.args.get("years", "10"))
        years = max(0.1, min(years, SCENARIO_MAX_YEARS))
        step_days = int(request.args.get("step_days", str(SCENARIO_STEPSIZE)))
        n_paths = int(request.args.get("n", "300"))
        n_paths = max(50, min(n_paths, 1000))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    daily = get_daily_closes(coin_id, 365)
    if not daily or len(daily) < 30:
        return jsonify({"error": "Not enough history"}), 422

    closes = [float(p[1]) for p in daily][-365:]
    rets = []
    for i in range(1, len(closes)):
        p0, p1 = closes[i-1], closes[i]
        if p0 > 0 and p1 > 0:
            rets.append(math.log(p1/p0))
    if len(rets) < 10:
        return jsonify({"error": "Not enough returns"}), 422

    mu = sum(rets)/len(rets)
    var = sum((r - mu)**2 for r in rets) / max(len(rets)-1, 1)
    sigma = math.sqrt(max(var, 1e-12))

    last_px = closes[-1]
    last_ts = int(daily[-1][0])
    if last_px <= 0:
        return jsonify({"error": "Bad current price"}), 422

    shares = amount / last_px
    horizon_days = int(years * 365)
    steps = max(1, int(horizon_days / step_days))

    all_values = [[] for _ in range(steps)]
    for _ in range(n_paths):
        px = last_px
        for s in range(steps):
            z = random.gauss(0.0, 1.0)
            drift = (mu - 0.5 * sigma * sigma) * step_days
            shock = sigma * math.sqrt(step_days) * z
            px = max(px * math.exp(drift + shock), 0.0)
            all_values[s].append(shares * px)

    p10, p50, p90 = [], [], []
    ts = last_ts
    for s in range(steps):
        ts += step_days * ONE_DAY * 1000
        vec = sorted(all_values[s])
        i10 = int(0.10 * (len(vec) - 1))
        i50 = int(0.50 * (len(vec) - 1))
        i90 = int(0.90 * (len(vec) - 1))
        p10.append([ts, float(vec[i10])])
        p50.append([ts, float(vec[i50])])
        p90.append([ts, float(vec[i90])])

    return jsonify({
        "coin": coin_id, "amount": amount, "years": years,
        "step_days": step_days, "n": n_paths,
        "current_price": last_px, "shares": shares,
        "p10": p10, "p50": p50, "p90": p90
    })


@app.route("/api/dca_scenario")
def api_dca_scenario():
    """
    Monte-Carlo DCA value projection.
    Query:
      coin_id:  'bitcoin' | 'ethereum' | ...
      amount:   USD per contribution (float)
      freq:     'weekly' | 'monthly'
      years:    <= 20 (float)
      n:        number of paths (50..1000, default 300)
    Returns:
      invested_total, steps, step_days and percentile bands for VALUE:
        { "p10":[[ts,v]...], "p50":[[ts,v]...], "p90":[[ts,v]...] }
      (p10=worst-case, p50=median/most-likely, p90=best-case)
    """
    coin_id = request.args.get("coin_id", "bitcoin").lower()
    freq = request.args.get("freq", "weekly")
    try:
        amt_per = float(request.args.get("amount", "50"))
        if amt_per <= 0:
            raise ValueError()
        years = float(request.args.get("years", "10"))
        years = max(0.1, min(years, SCENARIO_MAX_YEARS))
        n_paths = int(request.args.get("n", "300"))
        n_paths = max(50, min(n_paths, 1000))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    step_days = 7 if freq == "weekly" else 30
    horizon_days = int(years * 365)
    steps = max(1, int(horizon_days / step_days))

    # calibrate GBM from last ~year of daily closes
    daily = get_daily_closes(coin_id, 365)
    if not daily or len(daily) < 30:
        return jsonify({"error": "Not enough history"}), 422

    closes = [float(p[1]) for p in daily][-365:]
    rets = []
    for i in range(1, len(closes)):
        p0, p1 = closes[i - 1], closes[i]
        if p0 > 0 and p1 > 0:
            rets.append(math.log(p1 / p0))
    if len(rets) < 10:
        return jsonify({"error": "Not enough returns"}), 422

    mu = sum(rets) / len(rets)                         # daily drift
    var = sum((r - mu) ** 2 for r in rets) / max(len(rets) - 1, 1)
    sigma = math.sqrt(max(var, 1e-12))                 # daily vol

    last_px = closes[-1]
    last_ts = int(daily[-1][0])

    # simulate VALUE paths (prices + scheduled buys accumulate shares)
    all_values = [[] for _ in range(steps)]            # collect values at each step across paths

    for _ in range(n_paths):
        px = last_px
        ts = last_ts
        shares = 0.0
        invested = 0.0

        for s in range(steps):
            # GBM step aggregated to step_days
            z = random.gauss(0.0, 1.0)
            drift = (mu - 0.5 * sigma * sigma) * step_days
            shock = sigma * math.sqrt(step_days) * z
            px = max(px * math.exp(drift + shock), 0.0)
            ts += step_days * ONE_DAY * 1000

            # buy at the step price
            if px > 0:
                shares += amt_per / px
                invested += amt_per

            value = shares * px
            all_values[s].append(value)

    # percentile bands per step
    p10, p50, p90 = [], [], []
    ts = last_ts
    for s in range(steps):
        ts += step_days * ONE_DAY * 1000
        vec = sorted(all_values[s])
        if not vec:
            continue
        i10 = int(0.10 * (len(vec) - 1))
        i50 = int(0.50 * (len(vec) - 1))
        i90 = int(0.90 * (len(vec) - 1))
        p10.append([ts, float(vec[i10])])
        p50.append([ts, float(vec[i50])])
        p90.append([ts, float(vec[i90])])

    invested_total = amt_per * steps  # schedule is deterministic per path (one buy each step)

    return jsonify({
        "coin": coin_id,
        "freq": freq,
        "amount_per": amt_per,
        "years": years,
        "step_days": step_days,
        "steps": steps,
        "invested_total": invested_total,
        "p10": p10,      # worst-case
        "p50": p50,      # most likely (median)
        "p90": p90       # best-case
    })



# ---------- helpers (unchanged logic) ----------
def realized_volatility(prices):
    if not prices or len(prices) < 2:
        return {"annualized_vol": None, "returns": []}
    prices = sorted(prices, key=lambda x: x[0])
    rets = []
    for i in range(1, len(prices)):
        p0 = float(prices[i - 1][1])
        p1 = float(prices[i][1])
        if p0 <= 0 or p1 <= 0:
            continue
        rets.append(math.log(p1 / p0))
    if len(rets) < 2:
        return {"annualized_vol": None, "returns": rets}
    stdev = statistics.pstdev(rets)
    total_hours = (prices[-1][0] - prices[0][0]) / (1000 * 60 * 60)
    n_obs = len(rets)
    obs_per_day = n_obs / max(total_hours / 24.0, 1e-9)
    daily_vol = stdev * math.sqrt(max(obs_per_day, 1))
    annualized = daily_vol * math.sqrt(365.0)
    return {"annualized_vol": annualized * 100.0, "returns": rets}


def fetch_reddit_titles(coin):
    url = f"https://www.reddit.com/search.json?q={coin}%20price&sort=new&limit=15"
    try:
        r = SESSION.get(url, timeout=8)  # reuse session for UA
        j = r.json()
        posts = j.get("data", {}).get("children", [])
        return [
            p["data"]["title"] for p in posts if "data" in p and "title" in p["data"]
        ]
    except Exception:
        return []


def fetch_hn_titles(coin):
    url = "https://hn.algolia.com/api/v1/search"
    try:
        r = SESSION.get(
            url, params={"query": coin, "tags": "story", "hitsPerPage": 15}, timeout=8
        )
        j = r.json()
        hits = j.get("hits", [])
        return [h.get("title") for h in hits if h.get("title")]
    except Exception:
        return []


def _nearest_price(prices, target_ms: int):
    """
    prices: [[ts_ms, price], ...] (asc)
    returns price closest (by time) to target_ms
    """
    if not prices:
        return None
    best = prices[0][1]
    best_diff = abs(prices[0][0] - target_ms)
    for ts, p in prices:
        d = abs(ts - target_ms)
        if d < best_diff:
            best, best_diff = p, d
    return float(best)


def _first_at_or_after(prices, target_ms: int):
    """Return the price at the first timestamp >= target_ms; fallback to nearest."""
    if not prices:
        return None
    for ts, px in prices:
        if ts >= target_ms:
            try:
                return float(px)
            except Exception:
                return None
    # all points are earlier; use nearest as a last resort
    return _nearest_price(prices, target_ms)


def _to_midnight_utc(ts: int):
    """Clamp a unix seconds timestamp to midnight UTC (int seconds)."""
    d = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)
    d = d.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(d.timestamp())


def _resample_to_daily(prices):
    """
    Input prices: [[ts_ms, px]...] (any spacing)
    Output: list of [midnight_utc_ms, last_px_of_day] sorted by day.
    """
    if not prices:
        return []
    by_day = {}
    for ts_ms, px in prices:
        day_s = _to_midnight_utc(int(ts_ms / 1000))
        by_day[day_s] = float(px)  # last one of the day wins (close)
    out = [[d * 1000, by_day[d]] for d in sorted(by_day.keys())]
    return out


def get_daily_closes(coin_id: str, lookback_days: int = 365):
    """
    Returns last <=lookback_days daily closes [[ts_ms, px]...] ending today.
    Uses your existing CG/CC fallback stack.
    """
    now_s = int(time.time())
    from_ts = now_s - max(lookback_days, 1) * ONE_DAY
    series, _ = get_series_any(coin_id, from_ts, now_s)
    daily = _resample_to_daily(series)
    # keep most recent lookback_days (safe if we got more)
    return daily[-lookback_days:]


def holt_winters_additive(
    daily_series, h=30, season_len=7, alpha=0.2, beta=0.1, gamma=0.1
):
    """
    Very small additive Holt-Winters with fixed season_len (weekly seasonality).
    Input:  daily_series = [[ts_ms, px], ...] (sorted, 1/day)
    Returns: (forecast_points, ci_low, ci_high) — lists of [future_ts_ms, px]
    """
    if not daily_series or len(daily_series) < season_len * 2:
        return [], [], []

    y = [float(p[1]) for p in daily_series]
    n = len(y)

    # init level, trend, seasonal (additive)
    L = y[0]
    T = (y[season_len] - y[0]) / season_len
    S = [0.0] * season_len
    # simple seasonal init: first season deviations
    first_season_avg = sum(y[:season_len]) / season_len
    for i in range(season_len):
        S[i] = y[i] - first_season_avg

    level, trend = L, T
    season = S[:]

    fitted = []
    for t in range(n):
        s = season[t % season_len]
        yhat = level + trend + s
        fitted.append(yhat)
        err = y[t] - yhat
        # update
        new_level = alpha * (y[t] - s) + (1 - alpha) * (level + trend)
        new_trend = beta * (new_level - level) + (1 - beta) * trend
        new_s = gamma * (y[t] - new_level) + (1 - gamma) * s
        level, trend = new_level, new_trend
        season[t % season_len] = new_s

    # residual std for naive CI
    residuals = [y[i] - fitted[i] for i in range(len(fitted))]
    if len(residuals) >= 5:
        mean_err = sum(residuals) / len(residuals)
        var = sum((e - mean_err) ** 2 for e in residuals) / max(len(residuals) - 1, 1)
        sigma = math.sqrt(max(var, 1e-12))
    else:
        sigma = 0.0

    # forecast h steps
    last_ts_ms = int(daily_series[-1][0])
    out, low, high = [], [], []
    for k in range(1, h + 1):
        s = season[(n + (k - 1)) % season_len]
        f = level + k * trend + s
        ts_ms = last_ts_ms + k * ONE_DAY * 1000
        out.append([ts_ms, float(f)])
        # ±1.96σ naive CI (not accounting for forecast variance accumulation)
        low.append([ts_ms, float(max(f - 1.96 * sigma, 0))])
        high.append([ts_ms, float(max(f + 1.96 * sigma, 0))])

    return out, low, high


def gbm_scenarios(
    daily_series, horizon_days=365 * 10, step_days=SCENARIO_STEPSIZE, n_paths=300
):
    """
    Calibrate from last ~1y log-returns. Simulate weekly GBM for horizon.
    Returns: dict with 'p10','p50','p90' series of [ts_ms, px]
    """
    if not daily_series or len(daily_series) < 30:
        return {"p10": [], "p50": [], "p90": []}

    closes = [float(p[1]) for p in daily_series[-365:]]  # last year if possible
    # log returns
    rets = []
    for i in range(1, len(closes)):
        p0, p1 = closes[i - 1], closes[i]
        if p0 > 0 and p1 > 0:
            rets.append(math.log(p1 / p0))
    if len(rets) < 10:
        return {"p10": [], "p50": [], "p90": []}

    mu = sum(rets) / len(rets)  # daily drift
    # unbiased sample std
    mean_r = mu
    var = sum((r - mean_r) ** 2 for r in rets) / max(len(rets) - 1, 1)
    sigma = math.sqrt(max(var, 1e-12))  # daily vol

    last_px = closes[-1]
    last_ts = int(daily_series[-1][0])
    steps = max(1, int(horizon_days / step_days))

    # pre-allocate paths at each step
    all_paths = [[] for _ in range(steps)]
    for _ in range(n_paths):
        px = last_px
        t_ts = last_ts
        for s in range(steps):
            # compound step_days of daily GBM in one normal draw:
            # drift ~ mu*step_days, vol ~ sigma*sqrt(step_days)
            z = random.gauss(0.0, 1.0)
            drift = (mu - 0.5 * sigma * sigma) * step_days
            shock = sigma * math.sqrt(step_days) * z
            px = max(px * math.exp(drift + shock), 0.0)
            t_ts += step_days * ONE_DAY * 1000
            all_paths[s].append(px)

    # percentiles per step
    p10, p50, p90 = [], [], []
    t_ts = last_ts
    for s in range(steps):
        t_ts += step_days * ONE_DAY * 1000
        vec = sorted(all_paths[s])
        idx10 = int(0.10 * (len(vec) - 1))
        idx50 = int(0.50 * (len(vec) - 1))
        idx90 = int(0.90 * (len(vec) - 1))
        p10.append([t_ts, float(vec[idx10])])
        p50.append([t_ts, float(vec[idx50])])
        p90.append([t_ts, float(vec[idx90])])
    return {"p10": p10, "p50": p50, "p90": p90}


def _parse_date(date_str: str):
    if not date_str:
        return None
    s = date_str.strip()
    # normalize separators / remove spaces like "13 - 01 - 2021"
    s = s.replace(" ", "").replace(".", "-").replace("/", "-")
    # try common formats
    for fmt in ("%Y-%m-%d", "%d-%m-%Y"):
        try:
            d = dt.datetime.strptime(s, fmt)
            return d.replace(
                hour=0, minute=0, second=0, microsecond=0, tzinfo=dt.timezone.utc
            )
        except ValueError:
            pass
    # last-chance: ISO parser
    try:
        d = dt.datetime.fromisoformat(date_str)
        return d.replace(
            hour=0, minute=0, second=0, microsecond=0, tzinfo=dt.timezone.utc
        )
    except Exception:
        return None


def get_series_days(coin_id: str, days: int):
    days = max(1, int(days))
    cache_key = (coin_id, days)
    now = time.time()

    hit = _SERIES_DAYS_CACHE.get(cache_key)
    if hit and (now - hit["t"] < _SERIES_DAYS_TTL):
        return hit["data"]

    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
    params = {"vs_currency": "usd", "days": str(days)}
    # Optional: interval="daily" is allowed on free, but keep it simple:
    if days >= 90:
        params["interval"] = "daily"

    try:
        r = SESSION.get(url, params=params, timeout=12)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        prices = j.get("prices", []) if isinstance(j, dict) else []
        if not prices:
            print(
                f"[series_days] coin={coin_id} days={days} "
                f"status={getattr(r,'status_code',None)} "
                f"text={getattr(r,'text','')[:300]}"
            )
            return hit["data"] if hit else []
        _SERIES_DAYS_CACHE[cache_key] = {"t": now, "data": prices}
        return prices
    except Exception as e:
        print(f"[series_days] exception coin={coin_id} days={days}: {e}")
        return hit["data"] if hit else []


def get_full_series_days_max(coin_id: str):
    now = time.time()
    hit = FULL_SERIES_CACHE.get(coin_id)
    if hit and (now - hit["t"] < FULL_SERIES_TTL):
        return hit["data"]

    url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"
    params = {"vs_currency": "usd", "days": "max"}  # keep simple on free tier
    try:
        r = SESSION.get(url, params=params, timeout=12)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        prices = j.get("prices", []) if isinstance(j, dict) else []
        if not prices:
            print(
                f"[days_max] coin={coin_id} status={getattr(r,'status_code',None)} "
                f"text={getattr(r,'text','')[:300]}"
            )
            return hit["data"] if hit else []
        FULL_SERIES_CACHE[coin_id] = {"t": now, "data": prices}
        return prices
    except Exception as e:
        print(f"[days_max] exception coin={coin_id}: {e}")
        return hit["data"] if hit else []


@app.route("/api/volatility/<coin_id>/<days>")
def volatility_coin(coin_id, days):
    data = fetch_history_cached(coin_id, days)
    prices = data.get("prices", [])
    return jsonify(realized_volatility(prices))


@app.route("/api/sentiment/<coin_id>")
def sentiment_coin(coin_id):
    try:
        titles = fetch_reddit_titles(coin_id) + fetch_hn_titles(coin_id)
        titles = [t for t in titles if isinstance(t, str)][:25]
        if not titles:
            return jsonify({"score": None, "items": []})
        sia = SentimentIntensityAnalyzer()
        scored, total = [], 0.0
        for t in titles:
            s = sia.polarity_scores(t)["compound"]
            total += s
            scored.append({"title": t, "score": s})
        avg = total / len(scored)
        return jsonify({"score": avg, "items": scored})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _cc_symbol(coin_id: str):
    # map your internal coin_id to CryptoCompare's symbol
    m = {"bitcoin": "BTC", "ethereum": "ETH", "dogecoin": "DOGE"}
    return m.get(str(coin_id).lower())


def fetch_history_cc(coin_id: str, from_ts: int, to_ts: int):
    """
    Fallback deep history using CryptoCompare histoday.
    Returns [[ts_ms, close], ...] ascending, clipped to [from_ts, to_ts].
    """
    sym = _cc_symbol(coin_id)
    if not sym:
        return []

    headers = {}
    if CRYPTOCOMPARE_API_KEY:
        headers = {"authorization": f"Apikey {CRYPTOCOMPARE_API_KEY}"}

    out = []
    remaining_days = max(1, int((to_ts - from_ts + ONE_DAY - 1) // ONE_DAY))
    to_cursor = to_ts

    while remaining_days > 0:
        chunk = min(remaining_days, 2000)
        try:
            r = SESSION.get(
                "https://min-api.cryptocompare.com/data/v2/histoday",
                params={"fsym": sym, "tsym": "USD", "toTs": to_cursor, "limit": chunk},
                headers=headers,
                timeout=12,
            )
            j = r.json()
            if j.get("Response") != "Success":
                break
            data = j.get("Data", {}).get("Data", [])
            if not data:
                break

            for row in data:
                ts = int(row.get("time", 0)) * 1000
                px = float(row.get("close", 0))
                if from_ts * 1000 <= ts <= to_ts * 1000 and px > 0:
                    out.append([ts, px])

            earliest = int(data[0].get("time", to_cursor)) - 1
            to_cursor = earliest
            remaining_days = max(0, int((to_cursor - from_ts) // ONE_DAY))
            if to_cursor < from_ts:
                break
        except Exception:
            break

    out.sort(key=lambda x: x[0])
    return out


def get_series_any(coin_id: str, from_ts: int, to_ts: int):
    """
    Try CG range -> CG days/max -> CryptoCompare -> clamp last-365d.
    Returns (series, limited_365_flag)
    """
    # 1) Try CoinGecko range/days
    s = fetch_prices_range_or_days(coin_id, from_ts, to_ts)
    if s:
        return s, False

    # 2) Try days_max
    full = get_full_series_days_max(coin_id)
    if full:
        from_ms, to_ms = from_ts * 1000, to_ts * 1000
        return [p for p in full if from_ms <= p[0] <= to_ms], False

    # 3) Try CryptoCompare
    cc = fetch_history_cc(coin_id, from_ts, to_ts)
    if cc:
        return cc, False

    # 4) Last resort: clamp to last 365 days
    oldest_allowed = int(time.time()) - ONE_YEAR
    limited = False
    if from_ts < oldest_allowed:
        from_ts = oldest_allowed
        limited = True
    s2 = fetch_prices_range_or_days(coin_id, from_ts, to_ts)
    return s2, limited


def fetch_prices_range_or_days(coin_id: str, from_ts: int, to_ts: int):
    """
    Try market_chart/range; if empty or 429/limited, fall back to market_chart?days=
    and clip to [from_ts, to_ts].
    Returns list[[ts_ms, price], ...] (possibly empty).
    """
    # --- prefer range ---
    url_range = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart/range"
    try:
        r = SESSION.get(
            url_range,
            params={"vs_currency": "usd", "from": from_ts, "to": to_ts},
            timeout=12,
        )
        j = r.json()
        if isinstance(j, dict) and isinstance(j.get("prices"), list) and j["prices"]:
            return j["prices"]
    except Exception:
        pass  # fall through

    # --- fallback to days= ---
    # number of whole days to fetch, cap to "max" once > 365
    days = max(1, int((to_ts - from_ts + 86399) // 86400))
    url_days = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart"

    # use 'max' for long spans (free tier supports this)
    params = {"vs_currency": "usd", "days": "max" if days > 365 else str(days)}
    try:
        r2 = SESSION.get(url_days, params=params, timeout=12)
        j2 = r2.json()
        prices = j2.get("prices", []) if isinstance(j2, dict) else []
        if not prices:
            return []
        # clip to [from_ts, to_ts]
        from_ms, to_ms = from_ts * 1000, to_ts * 1000
        return [p for p in prices if from_ms <= p[0] <= to_ms]
    except Exception:
        return []


def _start_price_fallback(coin_id: str, start_dt: dt.datetime):
    """
    Try /coins/{id}/history (date=DD-MM-YYYY). If empty, nudge +/- 3 days.
    Returns a float start price or None.
    """

    def hit(day):
        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/history"
        # IMPORTANT: date is DD-MM-YYYY for this endpoint
        params = {"date": day.strftime("%d-%m-%Y"), "localization": "false"}
        try:
            r = SESSION.get(url, params=params, timeout=10)
            j = r.json()
            return float(j.get("market_data", {}).get("current_price", {}).get("usd"))
        except Exception:
            return None

    # exact day
    p = hit(start_dt)
    if p and p > 0:
        return p

    # small window +/- 3 days
    for delta in range(1, 4):
        for sign in (+1, -1):
            day = start_dt + dt.timedelta(days=sign * delta)
            p = hit(day)
            if p and p > 0:
                return p
    return None

# app.py (add near other endpoints)
@app.route("/api/portfolio_forecast")
def api_portfolio_forecast():
    try:
        h = int(request.args.get("h", "120"))
        h = max(1, min(h, PREDICTION_MAX_DAYS))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    # load user holdings
    sql = (
        "SELECT coin, amount FROM holdings WHERE user_id=%s"
        if DB_URL else
        "SELECT coin, amount FROM holdings WHERE user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            rows = c.fetchall()

    if not rows:
        return jsonify({"series": [], "bands": {"low": [], "high": []}})

    # aggregate per-day value across coins
    agg_central, agg_low, agg_high = {}, {}, {}
    now_daily = get_daily_closes("bitcoin", 1)  # just to get today's midnight
    today_ms = now_daily[-1][0] if now_daily else _to_midnight_utc(int(time.time()))*1000

    for r in rows:
        coin, qty = r["coin"], float(r["amount"])
        daily = get_daily_closes(coin, 365)
        if not daily or qty <= 0:
            continue
        f, lo, hi = holt_winters_additive(daily, h=h, season_len=7)
        if not f:
            continue

        # include a small 60-day tail of history so the chart has context
        tail = daily[-60:]
        for ts, px in tail:
            agg_central[ts] = agg_central.get(ts, 0.0) + qty * float(px)

        for ts, px in f:
            agg_central[ts] = agg_central.get(ts, 0.0) + qty * float(px)
        for ts, px in lo:
            agg_low[ts] = agg_low.get(ts, 0.0) + max(0.0, qty * float(px))
        for ts, px in hi:
            agg_high[ts] = agg_high.get(ts, 0.0) + max(0.0, qty * float(px))

    series = sorted([[ts, v] for ts, v in agg_central.items()], key=lambda x: x[0])
    low    = sorted([[ts, agg_low.get(ts, None)] for ts, _ in series if ts in agg_low])
    high   = sorted([[ts, agg_high.get(ts, None)] for ts, _ in series if ts in agg_high])

    return jsonify({"series": series, "bands": {"low": low, "high": high}})

@app.route("/api/portfolio_scenario")
def api_portfolio_scenario():
    try:
        years = float(request.args.get("years", "10"))
        years = max(0.1, min(years, SCENARIO_MAX_YEARS))
        step_days = int(request.args.get("step_days", str(SCENARIO_STEPSIZE)))
        n = int(request.args.get("n", "300"))
        n = max(50, min(n, 1000))
    except Exception:
        return jsonify({"error": "Bad params"}), 400

    sql = (
        "SELECT coin, amount FROM holdings WHERE user_id=%s"
        if DB_URL else
        "SELECT coin, amount FROM holdings WHERE user_id=?"
    )
    with _db() as conn:
        with _cursor(conn) as c:
            c.execute(sql, (g.uid,))
            rows = c.fetchall()
    if not rows:
        return jsonify({"p10": [], "p50": [], "p90": []})

    agg_p10, agg_p50, agg_p90 = {}, {}, {}
    for r in rows:
        coin, qty = r["coin"], float(r["amount"])
        if qty <= 0: 
            continue
        daily = get_daily_closes(coin, 365)
        bands = gbm_scenarios(daily, horizon_days=int(years*365), step_days=step_days, n_paths=n)
        for ts, px in bands["p10"]:
            agg_p10[ts] = agg_p10.get(ts, 0.0) + qty * float(px)
        for ts, px in bands["p50"]:
            agg_p50[ts] = agg_p50.get(ts, 0.0) + qty * float(px)
        for ts, px in bands["p90"]:
            agg_p90[ts] = agg_p90.get(ts, 0.0) + qty * float(px)

    def _sorted(d): 
        return sorted([[ts, v] for ts, v in d.items()], key=lambda x: x[0])
    return jsonify({"p10": _sorted(agg_p10), "p50": _sorted(agg_p50), "p90": _sorted(agg_p90)})

@app.route("/", methods=["GET"])
def health():
    return jsonify({"ok": True})

@app.route("/api/whatif")
def whatif():
    """
    Query params:
      coin_id:  'bitcoin' | 'ethereum' | ...
      amount:   float USD invested
      date:     'YYYY-MM-DD' (UTC)
    Returns metrics + a value-over-time series for charting.
    """
    coin_id = request.args.get("coin_id", "bitcoin").lower()

    try:
        amount = float(request.args.get("amount", "500"))
    except Exception:
        amount = 500.0
    if amount <= 0:
        return jsonify({"error": "Amount must be > 0"}), 400

    date_str = request.args.get("date", "2021-01-01")
    start_dt = _parse_date(date_str)
    if not start_dt:
        return jsonify({"error": "Invalid date. Use YYYY-MM-DD or DD-MM-YYYY."}), 400

    from_ts = int(start_dt.timestamp())
    to_ts = int(time.time())
    if from_ts >= to_ts:  # safety
        return jsonify({"error": "Date must be in the past."}), 400

    # --- NEW: span helpers ---
    older_than_365 = (to_ts - from_ts) > 365 * 24 * 3600

    try:
        # 1) Try to get a series for [from,to]
        prices = fetch_prices_range_or_days(coin_id, from_ts, to_ts)
        print(
            f"[whatif] window-series len={len(prices)} coin={coin_id} from={from_ts} to={to_ts}"
        )

        target_ms = from_ts * 1000
        from_ms = from_ts * 1000
        to_ms_ms = to_ts * 1000

        # what we'll actually plot; start with the window series
        chart_series = list(prices)

        # 2) Start price from the window series
        start_price = _first_at_or_after(prices, target_ms) if prices else None
        print(f"[whatif] start from window-series: {start_price}")

        # 2a) If missing, try /history for the exact DD-MM-YYYY (±3d)
        if not start_price or start_price <= 0:
            h = _start_price_fallback(coin_id, start_dt)
            print(f"[whatif] start from /history: {h}")
            if h and h > 0:
                start_price = h

        # 2b-prime) If request spans > 365d, try lifetime series first (days=max)
        if (not start_price or start_price <= 0) and older_than_365:
            full_max = get_full_series_days_max(coin_id)
            print(f"[whatif] days=max len={len(full_max)} (pre-loop because >365d)")
            if full_max:
                s = _first_at_or_after(full_max, target_ms)
                print(f"[whatif] start from pre-loop days=max: {s}")
                if s and s > 0:
                    start_price = s
                    # clip for plotting
                    chart_series = [p for p in full_max if from_ms <= p[0] <= to_ms_ms]

        # 2b) If still missing, pull a days-series and pick first ≥ target
        if not start_price or start_price <= 0:
            days_needed = max(1, int((to_ts - from_ts + 86399) // 86400))  # whole days
            # First try a modest window to reduce rate-limits, then escalate
            for d in (days_needed, 365, 1200):  # ~1y then ~3.3y
                full = get_series_days(coin_id, d)
                time.sleep(0.35)
                print(f"[whatif] series_days({d}) len={len(full)}")
                if full:
                    s = _first_at_or_after(full, target_ms)
                    print(f"[whatif] start from series_days({d}): {s}")
                    if s and s > 0:
                        start_price = s
                        # use this series for the chart (clipped to the requested window)
                        chart_series = [p for p in full if from_ms <= p[0] <= to_ms_ms]
                        break

        # 2b continued — one more narrow retry for finicky coins like dogecoin
        if (not start_price or start_price <= 0) and coin_id == "dogecoin":
            # Try a smaller slice around the target date: 550 days (±~9 months around start)
            # This is often accepted when larger windows 365/1200 fail.
            around = 550
            full = get_series_days(coin_id, around)
            print(f"[whatif] dogecoin narrow window len={len(full)}")
            if full:
                s = _first_at_or_after(full, target_ms)
                print(f"[whatif] dogecoin narrow start: {s}")
                if s and s > 0:
                    start_price = s

        # 2c) As a final resort, get full lifetime (days=max) and pick first ≥ target
        if not start_price or start_price <= 0:
            full_max = get_full_series_days_max(coin_id)
            print(f"[whatif] days=max len={len(full_max)}")
            if full_max:
                s = _first_at_or_after(full_max, target_ms)
                print(f"[whatif] start from days=max: {s}")
                if s and s > 0:
                    start_price = s
                    # clip the lifetime series to the requested window for plotting
                    chart_series = [p for p in full_max if from_ms <= p[0] <= to_ms_ms]

        if not start_price or start_price <= 0:
            print(
                f"[whatif] start_price failed: coin={coin_id} date={start_dt.isoformat()} prices_len={len(prices)}"
            )
            return (
                jsonify({"error": "Could not determine start price for that coin/date."}),
                422,
            )

        # 3) Current price
        if prices:
            current_price = float(prices[-1][1])
        elif chart_series:
            current_price = float(chart_series[-1][1])
        else:
            # if no series at all, take current from simple/price
            sp = SESSION.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": coin_id, "vs_currencies": "usd"},
                timeout=8,
            ).json()
            current_price = float(sp.get(coin_id, {}).get("usd") or 0)

        if current_price <= 0:
            return jsonify({"error": "Could not determine current price."}), 422

        shares = amount / start_price
        current_value = shares * current_price
        roi_pct = (current_value - amount) / amount * 100.0

        years = max((to_ts - from_ts) / (365.0 * 24 * 3600), 1e-9)
        try:
            cagr_pct = (((current_value / amount) ** (1.0 / years)) - 1.0) * 100.0
        except Exception:
            cagr_pct = None

        # Portfolio value series for the chart (use whichever series we ended up with)
        value_series = [[ts, float(px) * shares] for ts, px in chart_series]

        # Max drawdown (safe on empty)
        max_dd_pct = 0.0
        if value_series:
            peak = value_series[0][1]
            for _, v in value_series:
                peak = max(peak, v)
                if peak > 0:
                    dd = (peak - v) / peak * 100.0
                    if dd > max_dd_pct:
                        max_dd_pct = dd

        return jsonify(
            {
                "coin": coin_id,
                "amount": amount,
                "start_date": date_str,
                "years": years,
                "start_price": start_price,
                "current_price": current_price,
                "shares": shares,
                "current_value": current_value,
                "roi_pct": roi_pct,
                "cagr_pct": cagr_pct,
                "max_drawdown_pct": max_dd_pct,
                "series": value_series,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dca")
def dca():
    """
    Query params:
      coin_id:  'bitcoin' | 'ethereum' | ...
      amount:   float USD invested per contribution (e.g., 50)
      start:    'YYYY-MM-DD' or 'DD-MM-YYYY'
      freq:     'weekly' | 'monthly' (default: weekly)
    Returns: invested_total, contributions, shares, current_value, roi_pct, cagr_pct,
             series (value-over-time), lump_sum comparison.
    """
    coin_id = request.args.get("coin_id", "bitcoin").lower()

    try:
        amt_per = float(request.args.get("amount", "50"))
    except Exception:
        return jsonify({"error": "Invalid amount"}), 400
    if amt_per <= 0:
        return jsonify({"error": "Amount must be > 0"}), 400

    freq = request.args.get("freq", "weekly")
    start_dt = _parse_date(request.args.get("start", "2021-01-01"))
    if not start_dt:
        return jsonify({"error": "Invalid start date"}), 400

    from_ts = int(start_dt.timestamp())
    to_ts = int(time.time())
    if from_ts >= to_ts:
        return jsonify({"error": "Start must be in the past"}), 400

    # Use new unified fetch
    series, limited_365 = get_series_any(coin_id, from_ts, to_ts)
    if not series:
        return jsonify({"error": "No price data"}), 422

    from_ms, to_ms = from_ts * 1000, to_ts * 1000
    chart_series = [p for p in series if from_ms <= p[0] <= to_ms] or list(series)

    step_days = 7 if freq == "weekly" else 30
    step = dt.timedelta(days=step_days)
    d = start_dt

    shares = 0.0
    invested = 0.0

    while int(d.timestamp()) <= to_ts:
        price = _first_at_or_after(series, int(d.timestamp()) * 1000)
        if price and price > 0:
            shares += amt_per / price
            invested += amt_per
        d += step

    if invested <= 0 or shares <= 0:
        return jsonify({"error": "No valid contribution points"}), 422

    cur_price = float(chart_series[-1][1]) if chart_series else float(series[-1][1])
    current_value = shares * cur_price

    dca_value_series = [[ts, float(px) * shares] for ts, px in chart_series]

    roi_pct = (current_value - invested) / invested * 100.0
    years = max((to_ts - from_ts) / (365.0 * 24 * 3600), 1e-9)
    try:
        cagr_pct = (((current_value / invested) ** (1.0 / years)) - 1.0) * 100.0
    except Exception:
        cagr_pct = None

    start_price = _first_at_or_after(series, from_ms) or 0.0
    lump = {}
    if start_price > 0:
        ls_shares = invested / start_price
        ls_value = ls_shares * cur_price
        lump = {
            "invested": invested,
            "shares": ls_shares,
            "current_value": ls_value,
            "roi_pct": (ls_value - invested) / invested * 100.0,
        }

    return jsonify(
        {
            "coin": coin_id,
            "freq": freq,
            "amount_per": amt_per,
            "invested_total": invested,
            "contributions": int((to_ts - from_ts) // (step_days * 24 * 3600) + 1),
            "shares": shares,
            "current_price": cur_price,
            "current_value": current_value,
            "roi_pct": roi_pct,
            "cagr_pct": cagr_pct,
            "series": dca_value_series,
            "lump_sum": lump,
            "limited_365": bool(limited_365),
        }
    )

# ================== run ==================
if __name__ == "__main__":
    app.run(debug=True)