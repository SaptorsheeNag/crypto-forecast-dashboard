import { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LineElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LogarithmicScale,
  Tooltip,
  Filler,
  Decimation,
  Legend,
} from 'chart.js';
import './App.css';
import { Toaster, toast } from 'react-hot-toast';
import { TimeScale } from 'chart.js';
import 'chartjs-adapter-date-fns';
import annotationPlugin from 'chartjs-plugin-annotation';

// ONE source of truth for the API base
const API_BASE =
  process.env.REACT_APP_API_URL ||   // old name (keep!)
  process.env.REACT_APP_API_BASE ||  // new name
  'http://localhost:5000';

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true, // needed for the signed uid cookie
});

// hex -> rgba helper for translucent fills
function rgba(hex, a = 0.15) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ==== Currency helpers ====
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY'];
const CCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };

// USD -> currency conversion (amountUsd * fx[ccy])
function toCcy(amountUsd, ccy, fxMap) {
  const r = fxMap?.[ccy] ?? 1;
  return (amountUsd ?? 0) * r;
}

// convert amount from -> to using USD-based fx map (fx.USD === 1)
function convert(amount, from, to, fx) {
  const fxFrom = fx?.[from] ?? 1; // units of "from" per USD? (map is USD base: 1 USD = fx[to])
  const fxTo = fx?.[to] ?? 1; // 1 USD -> fx[to] target units
  // amount[from] -> USD -> to
  return (amount ?? 0) / fxFrom * fxTo;
}

// Format numbers nicely per currency (JPY often has 0 decimals)
function fmt(n, ccy) {
  const zeroDec = ccy === 'JPY';
  return (n ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: zeroDec ? 0 : 2,
    maximumFractionDigits: zeroDec ? 0 : 2,
  });
}

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, LogarithmicScale, TimeScale, Decimation, Filler, Tooltip, Legend, annotationPlugin);

// --- Compare presets ---
const COMPARE_PRESETS = {
  off: [],
  'DOGE vs BTC': ['dogecoin', 'bitcoin'],
  'ETH vs DOGE': ['ethereum', 'dogecoin'],
  'ETH vs BTC': ['ethereum', 'bitcoin'],
  'BTC vs ETH vs DOGE': ['bitcoin', 'ethereum', 'dogecoin'],
};

function App() {
  // -----------------------------
  // 1) Existing state
  // -----------------------------
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [selectedCoin, setSelectedCoin] = useState('bitcoin');
  const [days, setDays] = useState('1'); // Default: 1 day
  const [historyData, setHistoryData] = useState([]);

  // --- Currency state ---
  const [ccy, setCcy] = useState('USD');
  const [fx, setFx] = useState({ USD: 1 }); // USD → currency rate

  // --- Prediction toggles ---
  const [whatIfMode, setWhatIfMode] = useState(null);    // null | 'short' | 'long'
  const [whatIfYears, setWhatIfYears] = useState(10);

  // smooth-scroll to a section by CSS selector
  const scrollTo = (sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // which hero button is “active” (to paint it blue)
  const [heroActive, setHeroActive] = useState(null);

  // Scroll-spy: highlight the button for the section in view
  useEffect(() => {
    // Wait until content is rendered
    if (loading) return;

    const sections = [
      { id: 'market-overview', key: 'start' },
      { id: 'alerts',          key: 'alerts' },
      { id: 'whatif',          key: 'whatif' },
      { id: 'dca',             key: 'dca' },
      { id: 'portfolio',       key: 'portfolio' },
    ];

    const io = new IntersectionObserver(
      (entries) => {
        // pick the currently most visible section
        const vis = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (vis?.target?.id) {
          const hit = sections.find(s => s.id === vis.target.id);
          if (hit && hit.key !== heroActive) setHeroActive(hit.key);
        }
      },
      {
        // tighter vertical window so the active section feels “snappy”
        root: null,
        rootMargin: '-40% 0px -55% 0px',
        threshold: [0.25, 0.5, 0.75, 0.95],
      }
    );

    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    });

    return () => io.disconnect();
  }, [loading]); // re-attach once content exists

  // What-If state
  const [whatIf, setWhatIf] = useState({
    coin: 'bitcoin',
    amount: 500,
    date: '2021-01-01',
  });
  const [whatIfRes, setWhatIfRes] = useState(null);
  const [whatIfLoading, setWhatIfLoading] = useState(false);

  // --- DCA state ---
  const [dca, setDca] = useState({ coin: 'bitcoin', amount: 50, start: '2021-01-01', freq: 'weekly' });
  const [dcaMode, setDcaMode] = useState(null);    // null | 'short' | 'long'
  const [dcaYears, setDcaYears] = useState(10);
  const [dcaRes, setDcaRes] = useState(null);
  const [dcaLoading, setDcaLoading] = useState(false);


  // --- Sentiment & Volatility ---
  const [sentiment, setSentiment] = useState({ score: null, items: [] });
  const [volatility, setVolatility] = useState({ annualized_vol: null });

  // --- Portfolio (persisted) ---
  const [holdings, setHoldings] = useState([]);

  // --- Goal tracker (persisted) ---
  const [goal, setGoal] = useState({ amount: "", date: "" });

  // --- Portfolio projection (new) ---
  const [pfMode, setPfMode] = useState(null);    // null | 'short' | 'long'
  const [pfH, setPfH] = useState(120);
  const [pfYears, setPfYears] = useState(10);
  const [pfProj, setPfProj] = useState(null);
  const [pfLoading, setPfLoading] = useState(false);


  // -----------------------------
  // 2) NEW: Alerts state & helpers
  // -----------------------------
  const [alerts, setAlerts] = useState([]);

  // keep last prices if you later add % change alerts
  const lastPricesRef = useRef(null);

  // remember when each alert last fired (cooldown)
  const [fired, setFired] = useState({});

  const [compareMode, setCompareMode] = useState('off');   // which preset is active
  const [histories, setHistories] = useState({});          // coin -> [[ts, price]...]

  // keep alert cooldown timestamps only in memory
  function saveFired(next) {
    setFired(next);
  }

  // current USD price for a coin or null
  function px(coin) {
    const v = prices?.[coin]?.usd;
    return typeof v === 'number' ? v : null;
  }

  function computePortfolioSummary(list) {
    let invested = 0, value = 0;
    list.forEach(h => {
      const curUsd = px(h.coin);
      const curSel = curUsd != null ? convert(curUsd, 'USD', ccy, fx) : null;
      const buySel = convert(h.buyPrice, h.ccy || 'USD', ccy, fx);
      invested += (h.amount * buySel);
      if (curSel != null) value += (h.amount * curSel);
    });
    const pnl = value - invested;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
    return { invested, value, pnl, pnlPct };
  }

  function sentimentLabel(score) {
    if (score == null) return { text: 'No data', color: '#9aa0a6' };
    if (score > 0.2) return { text: 'Bullish', color: '#29d07e' };
    if (score < -0.2) return { text: 'Bearish', color: '#ff6b6b' };
    return { text: 'Neutral', color: '#e0a800' };
  }

  // goal progress (based on total value vs goal.amount)
  function goalProgress(totalValue, goalAmount) {
    if (!goalAmount) return 0;
    return Math.max(0, Math.min(100, (totalValue / Number(goalAmount)) * 100));
  }

  // -----------------------------
  // 3) Existing effect: live prices (poll)
  // -----------------------------
  useEffect(() => {
    const fetchData = () => {
      api
        .get('/api/prices')
        .then(res => {
          setPrices(res.data);
          setLoading(false);
        })
        .catch(err => {
          console.error('Error fetching data:', err);
          setLoading(false);
        });
    };

    fetchData(); // initial call
    const interval = setInterval(fetchData, 600000); // every 10 min

    return () => clearInterval(interval); // cleanup
  }, []);

  // -----------------------------
  // 4) Historical chart (on coin/time change)
  // -----------------------------
  useEffect(() => {
    if (!selectedCoin) return;

    api
      .get(`/api/history/${selectedCoin}/${days}`)
      .then(res => {
        setHistoryData(res.data.prices); // response = [timestamp, price]
      })
      .catch(err => {
        console.error('Historical fetch failed', err);
      });
  }, [selectedCoin, days]);

  // Fetch histories for the active compare preset
  useEffect(() => {
    const coins = COMPARE_PRESETS[compareMode] || [];
    if (!coins.length) return;

    let cancelled = false;

    (async () => {
      try {
        const entries = await Promise.all(
          coins.map(c =>
            api
              .get(`/api/history/${c}/${days}`)
              .then(res => [c, res.data?.prices || []])
              .catch(() => [c, []])
          )
        );
        if (cancelled) return;
        setHistories(prev => {
          const next = { ...prev };
          entries.forEach(([c, arr]) => { next[c] = arr; });
          return next;
        });
      } catch {
        // ignore
      }
    })();

    return () => { cancelled = true; };
  }, [compareMode, days]);

  // Sentiment (refresh on coin change)
  useEffect(() => {
    if (!selectedCoin) return;
    api.get(`/api/sentiment/${selectedCoin}`)
      .then(res => setSentiment(res.data || { score: null, items: [] }))
      .catch(() => setSentiment({ score: null, items: [] }));
  }, [selectedCoin]);

  // Volatility (refresh on coin OR days change)
  useEffect(() => {
    if (!selectedCoin) return;
    api.get(`/api/volatility/${selectedCoin}/${days}`)
      .then(res => setVolatility(res.data || { annualized_vol: null }))
      .catch(() => setVolatility({ annualized_vol: null }));
  }, [selectedCoin, days]);

  // -----------------------------
  // What-If: keep coin synced with selection (optional)
  // -----------------------------
  useEffect(() => {
    setWhatIf(w => ({ ...w, coin: selectedCoin || 'bitcoin' }));
  }, [selectedCoin]);

  useEffect(() => {
    setDca(s => ({ ...s, coin: selectedCoin || 'bitcoin' }));
  }, [selectedCoin]);


  // -----------------------------
  // 5) Ask for browser notification permission once
  // -----------------------------
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // -----------------------------
  // 6) Evaluate alerts whenever fresh prices arrive
  // -----------------------------
  useEffect(() => {
    if (!prices || !Object.keys(prices).length) return;

    lastPricesRef.current = prices;

    const now = Date.now();
    const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
    const nextFired = { ...fired };

    alerts.forEach(rule => {
      const { id, coin, op, value, ccy: ruleCcy = 'USD' } = rule;
      const pUsd = prices?.[coin]?.usd;
      if (typeof pUsd !== 'number') return;

      const pLocal = convert(pUsd, 'USD', ruleCcy, fx);

      let hit = false;
      if (op === 'gte') hit = pLocal >= value;
      if (op === 'lte') hit = pLocal <= value;

      const last = fired[id] || 0;
      if (hit && (now - last) > COOLDOWN_MS) {
        notify(
          `${coin.toUpperCase()} hit ${op === 'gte' ? '≥' : '≤'} ${(CCY_SYMBOL[ruleCcy] || '')}${fmt(value, ruleCcy)} ${ruleCcy}`,
          `Current: ${(CCY_SYMBOL[ruleCcy] || '')}${fmt(pLocal, ruleCcy)} ${ruleCcy}`
        );
        nextFired[id] = now;
      }
    });

    if (JSON.stringify(nextFired) !== JSON.stringify(fired)) {
      saveFired(nextFired);
    }
  }, [prices, alerts, fx]);

  // Initialize anonymous session (sets HttpOnly uid cookie)
  useEffect(() => {
    api.get('/api/session/init').catch(() => { });
  }, []);

  // Fetch USD-based FX rates from our backend (hourly cache)
  useEffect(() => {
    let stop = false;
    async function fetchFx() {
      try {
        const { data } = await api.get('/api/fx');
        if (!stop && data) setFx(data);   // e.g. {USD:1, EUR:0.91, GBP:0.78, INR:83.2, JPY:157.5}
      } catch (e) {
        console.warn('FX fetch failed; staying in USD', e);
        // keep previous fx (default is {USD:1})
      }
    }
    fetchFx();
    const id = setInterval(fetchFx, 60 * 60 * 1000); // hourly refresh
    return () => { stop = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (ccy !== 'USD' && !fx[ccy]) toast('FX rate not available yet. Showing USD values.');
  }, [ccy, fx]);

  useEffect(() => {
    async function loadAll() {
      try {
        const [h, a, g] = await Promise.all([
          api.get('/api/holdings'),
          api.get('/api/alerts'),
          api.get('/api/goal'),
        ]);
        setHoldings(h.data || []);
        setAlerts(a.data || []);
        setGoal(g.data || { amount: "", date: "" });
      } catch (e) {
        console.error('Failed to load user data', e);
        toast.error('Could not load your saved data.');
      }
    }
    loadAll();
  }, []);

  // small helper
  function notify(title, body) {
    // Try system notification first (if allowed)
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch { /* ignore */ }

    // Always show an in-page toast as well
    toast((t) => (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 18 }}>🔔</span>
        <div>
          <div style={{ fontWeight: 700 }}>{title}</div>
          {body && <div style={{ opacity: 0.8, fontSize: 13 }}>{body}</div>}
        </div>
      </div>
    ), { duration: 4000 });
  }

  // -----------------------------
  // What-If: runner
  // -----------------------------
  async function runWhatIf(e) {
    e.preventDefault();
    setWhatIfLoading(true);
    setWhatIfRes(null);

    const isoDate = (() => {
      try {
        const d = new Date(whatIf.date);
        if (!Number.isNaN(d.valueOf())) return d.toISOString().slice(0, 10);
      } catch {}
      return String(whatIf.date).replace(/\s+/g, '');
    })();

    try {
      const coin_id = String(whatIf.coin || 'bitcoin').toLowerCase();
      const amtUsd = Number(convert(Number(whatIf.amount || 0), ccy, 'USD', fx));

      // === NORMAL BACKTEST (no radio selected) ===
      if (!whatIfMode) {
        const { data: r } = await api.get('/api/whatif', {
          params: { coin_id, amount: amtUsd, date: isoDate }
        });

        // Shape it to reuse the same (kind:'short') charting/metrics UI (no CI bands)
        setWhatIfRes({
          kind: 'short',
          coin: r.coin,
          amount: r.amount,
          start_price: r.start_price,
          current_price: r.current_price,
          shares: r.shares,
          current_value: r.current_value,
          roi_pct: r.roi_pct,
          cagr_pct: r.cagr_pct,
          max_drawdown_pct: r.max_drawdown_pct ?? 0,
          series: r.series || [],
          bands: null
        });
        return;
      }

      // === SHORT-TERM PREDICTION (≤180d) ===
      if (whatIfMode === 'short') {
        const res = await api.get('/api/whatif_predict', {
          params: { coin_id, amount: amtUsd, h: 120 }
        });
        const r = res.data;
        setWhatIfRes({
          kind: 'short',
          coin: r.coin,
          amount: r.amount,
          start_price: r.current_price,
          current_price: r.series.length
            ? (r.series[r.series.length - 1][1] / (r.amount / r.current_price))
            : r.current_price,
          shares: r.shares,
          current_value: r.series.length ? r.series[r.series.length - 1][1] : r.amount,
          roi_pct: r.series.length ? ((r.series[r.series.length - 1][1] - r.amount) / r.amount * 100.0) : 0,
          cagr_pct: null,
          max_drawdown_pct: 0,
          series: r.series,
          bands: r.bands
        });
        return;
      }

      // === LONG-TERM MONTE-CARLO ===
      const res = await api.get('/api/whatif_scenario', {
        params: { coin_id, amount: amtUsd, years: whatIfYears, n: 300 }
      });
      const r = res.data;
      setWhatIfRes({
        kind: 'long',
        coin: r.coin,
        amount: r.amount,
        shares: r.shares,
        current_price: r.current_price,
        years: r.years,
        p10: r.p10,
        p50: r.p50,
        p90: r.p90
      });
    } catch (err) {
      console.error('what-if failed', err);
      toast.error(err?.response?.data?.error || 'What-If query failed. Try another date/amount.');
    } finally {
      setWhatIfLoading(false);
    }
  }

  // -----------------------------
  // DCA: runner
  // -----------------------------
  async function runDCA(e) {
    e.preventDefault();
    setDcaLoading(true);
    setDcaRes(null);

    const iso = (() => {
      try { const d = new Date(dca.start); if (!Number.isNaN(d.valueOf())) return d.toISOString().slice(0,10); }
      catch {}
      return String(dca.start).replace(/\s+/g,'');
    })();

    try {
      const coin_id = String(dca.coin || 'bitcoin').toLowerCase();
      const perUsd  = Number(convert(Number(dca.amount || 0), ccy, 'USD', fx));

      // === NORMAL BACKTEST (no radio selected) ===
      if (!dcaMode) {
        const res = await api.get('/api/dca', {
          params: { coin_id, amount: perUsd, freq: dca.freq, start: iso }
        });
        // Reuse the "short" UI (no CI bands)
        setDcaRes({ kind: 'short', ...res.data, bands: null });
        return;
      }

      // === SHORT-TERM PREDICTION (≤ ~6 months) ===
      if (dcaMode === 'short') {
        const res = await api.get('/api/dca_predict', {
          params: { coin_id, amount: perUsd, freq: dca.freq, months: 4 }
        });
        setDcaRes({ kind: 'short', ...res.data });
        return;
      }

      // === LONG-TERM MONTE-CARLO ===
      const res = await api.get('/api/dca_scenario', {
        params: { coin_id, amount: perUsd, freq: dca.freq, years: dcaYears, n: 300 }
      });
      setDcaRes({ kind: 'long', ...res.data });
    } catch (err) {
      console.error('dca failed', err);
      toast.error(err?.response?.data?.error || 'DCA query failed.');
    } finally {
      setDcaLoading(false);
    }
  }

  // helper
  async function buildPortfolioHistoryClient(days = 365) {
    const uniqueCoins = [...new Set(holdings.map(h => h.coin))];
    if (!uniqueCoins.length) return [];

    const results = await Promise.all(uniqueCoins.map(c =>
      api.get(`/api/history/${c}/${days}`).then(r => [c, r.data?.prices || []])
    ));

    const map = Object.fromEntries(results);
    const spine = map[uniqueCoins[0]] || [];
    if (!spine.length) return [];

    return spine.map(([ts, _], idx) => {
      let totalUsd = 0;
      for (const h of holdings) {
        const arr = map[h.coin] || [];
        const px = (arr[idx]) ? arr[idx][1] : null;
        if (px != null) totalUsd += h.amount * px;
      }
      return [ts, totalUsd];
    });
  }
  
  // ---- Portfolio projection runner ----
  async function runPortfolioProjection(e) {
    e.preventDefault();
    setPfLoading(true);
    setPfProj(null);

    try {
      // === NORMAL (no radio selected): show value history to "now" ===
      if (!pfMode) {
        // Try backend first (recommended)
        try {
          const { data } = await api.get('/api/portfolio_history'); // -> { series:[[ts,value],...]}
          setPfProj({ kind: 'short', series: data.series || [], bands: null });
          return;
        } catch (err) {
          // Optional client-side fallback (no backend route)
          const data = await buildPortfolioHistoryClient(365); // last 365d
          setPfProj({ kind: 'short', series: data, bands: null });
          return;
        }
      }

      // === SHORT-TERM prediction (≤180d) ===
      if (pfMode === 'short') {
        const res = await api.get('/api/portfolio_forecast', { params: { h: pfH } });
        setPfProj({ kind: 'short', ...res.data });
        return;
      }

      // === LONG-TERM (Monte-Carlo) ===
      const res = await api.get('/api/portfolio_scenario', { params: { years: pfYears } });
      setPfProj({ kind: 'long', ...res.data });
    } catch (err) {
      console.error('portfolio projection failed', err);
      toast.error('Portfolio projection failed');
    } finally {
      setPfLoading(false);
    }
  }


  // -------- HOLDINGS API --------
  async function addHoldingServer(h) {
    // h: { coin, amount, buyPrice }
    try {
      const res = await api.post('/api/holdings', h);
      setHoldings(prev => [res.data, ...prev]); // res.data should include id
      toast.success('Holding added');
    } catch (e) {
      console.error(e);
      toast.error('Failed to add holding');
    }
  }

  async function removeHoldingServer(id) {
    try {
      await api.delete(`/api/holdings/${id}`);
      setHoldings(prev => prev.filter(x => x.id !== id));
      toast('Removed holding');
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove holding');
    }
  }

  // -------- GOAL API --------
  async function saveGoalServer(next) {
    try {
      const res = await api.put('/api/goal', next);
      setGoal(res.data);
      toast.success('Goal saved');
    } catch (e) {
      console.error(e);
      toast.error('Failed to save goal');
    }
  }

  // -------- ALERTS API --------
  async function addAlertServer(rule) {
    // rule: { coin, op, value }
    try {
      const res = await api.post('/api/alerts', rule);
      setAlerts(prev => [res.data, ...prev]); // includes id
      toast.success('Alert added');
    } catch (e) {
      console.error(e);
      toast.error('Failed to add alert');
    }
  }

  async function removeAlertServer(id) {
    try {
      await api.delete(`/api/alerts/${id}`);
      setAlerts(prev => prev.filter(x => x.id !== id));
      toast('Removed alert');
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove alert');
    }
  }

  // Slightly thicker lines in dark mode for readability
  const seriesBorder = darkMode ? 2.2 : 2;

  // -----------------------------
  // 7) Chart config (existing)
  // -----------------------------
  const chartData = {
    datasets: [
      {
        label: `${selectedCoin.toUpperCase()} Price (${ccy})`,
        data: (historyData || []).map(([ts, px]) => ({
          x: ts,                                            // <— timestamp
          y: toCcy(px, ccy, fx),                            // <— value
        })),
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        borderColor: '#4bc0c0',
        borderWidth: seriesBorder,
        pointBackgroundColor: 'white',
        pointBorderColor: '#4bc0c0',
        tension: 0.4,
        fill: true,
      },
    ],
  };

  const is24h = days === '1';

  // ===== Grid helpers for light/dark =====
  function gridStyle(dark) {
    const base = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
    const axis = dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';

    // Thicker, brighter zero line
    const color = (ctx) => {
      const isZero = Number(ctx.tick?.value) === 0;
      return isZero ? (dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)') : base;
    };
    const lineWidth = (ctx) => (Number(ctx.tick?.value) === 0 ? 1.4 : 0.6);

    return {
      grid: { color, lineWidth, tickColor: axis, drawBorder: true, borderColor: axis },
      ticksColor: dark ? '#fff' : '#000',
    };
  }

  const gx = gridStyle(darkMode);
  const chartOptions = {
    responsive: true,
    layout: { padding: { left: 10, right: 8, top: 4, bottom: 4 } },
    interaction: { mode: 'index', intersect: false },
    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
    plugins: {
      legend: { labels: { color: darkMode ? '#fff' : '#000' } },
      tooltip: { callbacks: { label: (c) => `${CCY_SYMBOL[ccy] || ''}${fmt(c.parsed.y, ccy)}` } },
      decimation: { enabled: true, algorithm: 'lttb', samples: is24h ? 120 : 300 },
    },
    scales: {
      x: {
        type: 'time',
        bounds: 'data',
        time: is24h
          ? { unit: 'hour', stepSize: 2, tooltipFormat: 'MMM d, HH:mm', displayFormats: { hour: 'HH:mm' } }
          : { tooltipFormat: 'MMM d, yyyy', displayFormats: { day: 'MMM d, yyyy', month: 'MMM yyyy', year: 'yyyy' } },
        ticks: { color: gx.ticksColor, autoSkip: true, maxTicksLimit: is24h ? 8 : 10, maxRotation: 0, major: { enabled: is24h } },
        ...gx.grid,
      },
      y: {
        ticks: { color: gx.ticksColor, callback: (v) => `${CCY_SYMBOL[ccy] || ''}${fmt(v, ccy)}` },
        ...gx.grid,
      },
    },
  };

  // Compare chart (only when a preset is active) — % change view
  const activeCoins = COMPARE_PRESETS[compareMode] || [];
  const compareChartData = activeCoins.length ? (() => {
    const datasets = activeCoins.map((c) => {
      const series = histories[c] || [];
      if (!series.length) return { label: `${c.toUpperCase()} (% change)`, data: [] };

      const base = series[0][1];
      const data = series.map(([ts, px]) => ({
        x: ts,
        y: ((px - base) / base) * 100,
      }));

      let borderColor, backgroundColor;
      if (c === 'bitcoin') {
        borderColor = 'rgb(0, 200, 83)';
        backgroundColor = 'rgba(0, 200, 83, 0.2)';
      } else if (c === 'ethereum') {
        borderColor = 'rgb(33, 150, 243)';
        backgroundColor = 'rgba(33, 150, 243, 0.2)';
      } else if (c === 'dogecoin') {
        borderColor = 'rgb(255, 193, 7)';
        backgroundColor = 'rgba(255, 193, 7, 0.2)';
      } else {
        borderColor = '#888';
        backgroundColor = 'rgba(136,136,136,0.2)';
      }

      return {
        label: `${c.toUpperCase()} (% change)`,
        data,
        borderColor,
        backgroundColor,
        borderWidth: seriesBorder,
        tension: 0.25,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 10,
        spanGaps: true,
        order: 2
      };
    });

    return { datasets };
  })() : null;

  const gc = gridStyle(darkMode);
  const compareChartOptions = {
    responsive: true,
    layout: { padding: { left: 10, right: 8, top: 4, bottom: 4 } },
    interaction: { mode: 'index', intersect: false },
    elements: { point: { radius: 0 } },
    plugins: {
      legend: { labels: { color: darkMode ? '#fff' : '#000' } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` } },
      decimation: { enabled: true, algorithm: 'lttb', samples: 150 },
    },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'MMM d, yyyy', displayFormats: { day: 'MMM d, yyyy', month: 'MMM yyyy', year: 'yyyy' } },
        ticks: { color: gc.ticksColor, maxTicksLimit: 10, maxRotation: 0 },
        ...gc.grid,
      },
      y: {
        type: 'linear',
        ticks: { color: gc.ticksColor, callback: (v) => `${v}%` },
        title: { display: true, text: '% change', color: gc.ticksColor },
        suggestedMin: -10,
        suggestedMax: 10,
        ...gc.grid,
      },
    },
  };


  // -----------------------------
  // What-If: chart data (supports CI band in prediction mode)
  // -----------------------------
  const whatIfChart = (whatIfRes && whatIfRes.kind === 'short') ? (() => {
    const main = whatIfRes.series.map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));

    const datasets = [{
      label: `${whatIf.coin.toUpperCase()} Investment Value (${ccy})`,
      data: main,
      borderColor: '#4bc0c0',
      backgroundColor: 'rgba(75,192,192,0.2)',
      borderWidth: seriesBorder,
      pointRadius: 0,
      tension: 0.25,
      fill: true
    }];

    // CI bands (low/high vectors cover the tail of the series)
    const hasBands = whatIfRes.bands && Array.isArray(whatIfRes.bands.low) && Array.isArray(whatIfRes.bands.high);
    if (hasBands) {
      const lowVals = whatIfRes.bands.low.map(([, v]) => toCcy(v, ccy, fx));
      const highVals = whatIfRes.bands.high.map(([, v]) => toCcy(v, ccy, fx));

      // align with the last N timestamps of the main series
      const tailTs = whatIfRes.series.slice(-lowVals.length).map(([ts]) => ts);

      const lowPoints = tailTs.map((ts, i) => ({ x: ts, y: lowVals[i] }));
      const highPoints = tailTs.map((ts, i) => ({ x: ts, y: highVals[i] }));

      datasets.push({
        label: 'Low (CI)',
        data: lowPoints,
        borderColor: 'rgba(0,0,0,0)',
        backgroundColor: 'rgba(0,0,0,0)',
        pointRadius: 0,
        tension: 0.25,
        fill: false
      });
      datasets.push({
        label: 'High (CI)',
        data: highPoints,
        borderColor: 'rgba(0,0,0,0)',
        backgroundColor: 'rgba(75,192,192,0.12)',
        pointRadius: 0,
        tension: 0.25,
        fill: '-1'
      });
    }

    return { datasets };
  })() : null;

  // ---- Portfolio snapshot numbers for KPI strip (Now / Short / Long)
  const pfNowValueSel = computePortfolioSummary(holdings).value;

  const pfSnapshot = pfProj ? (() => {
    if (pfProj.kind === 'short') {
      // take last central and CI values
      const last = (pfProj.series && pfProj.series.length) ? pfProj.series[pfProj.series.length - 1] : null;
      const lastLow = (pfProj.bands?.low && pfProj.bands.low.length) ? pfProj.bands.low[pfProj.bands.low.length - 1] : null;
      const lastHigh = (pfProj.bands?.high && pfProj.bands.high.length) ? pfProj.bands.high[pfProj.bands.high.length - 1] : null;

      const ts = last ? last[0] : null;
      const v  = last ? toCcy(last[1], ccy, fx) : null;
      const lo = lastLow ? toCcy(lastLow[1], ccy, fx) : null;
      const hi = lastHigh ? toCcy(lastHigh[1], ccy, fx) : null;

      return { kind: 'short', ts, v, lo, hi };
    } else {
      // use P50 (median) and show P10/P90 as band
      const lastP50 = (pfProj.p50 && pfProj.p50.length) ? pfProj.p50[pfProj.p50.length - 1] : null;
      const lastP10 = (pfProj.p10 && pfProj.p10.length) ? pfProj.p10[pfProj.p10.length - 1] : null;
      const lastP90 = (pfProj.p90 && pfProj.p90.length) ? pfProj.p90[pfProj.p90.length - 1] : null;

      const ts = lastP50 ? lastP50[0] : null;
      const v  = lastP50 ? toCcy(lastP50[1], ccy, fx) : null;
      const p10 = lastP10 ? toCcy(lastP10[1], ccy, fx) : null;
      const p90 = lastP90 ? toCcy(lastP90[1], ccy, fx) : null;

      return { kind: 'long', ts, v, p10, p90 };
    }
  })() : null;

  // -----------------------------
  // Portfolio projection chart data (short-term & long-term)
  // -----------------------------
  const pfChart = pfProj ? (() => {
    if (pfProj.kind === 'short') {
      const main = (pfProj.series || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      const low  = (pfProj.bands?.low  || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      const high = (pfProj.bands?.high || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      return {
        datasets: [
          { label: `Portfolio (${ccy})`, data: main, borderColor: '#4bc0c0', backgroundColor: 'rgba(75,192,192,0.2)', borderWidth: seriesBorder, pointRadius: 0, tension: 0.25, fill: true },
          { label: 'Worst-Case', data: low,  borderColor: 'rgba(0,0,0,0)', backgroundColor: 'rgba(0,0,0,0)',            pointRadius: 0, tension: 0.25, fill: false },
          { label: 'Best-Case',  data: high, borderColor: 'rgba(0,0,0,0)', backgroundColor: 'rgba(75,192,192,0.12)',    pointRadius: 0, tension: 0.25, fill: '-1' },
        ]
      };
    } else {
      const p10 = (pfProj.p10 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      const p50 = (pfProj.p50 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      const p90 = (pfProj.p90 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
      return {
        datasets: [
          { label: 'Worst-Case (P10)', data: p10, borderColor: '#ff6b6b', backgroundColor: 'rgba(0,0,0,0)', pointRadius: 0, tension: 0.25, fill: false, borderWidth: seriesBorder },
          { label: 'Most Likely (Median)', data: p50, borderColor: '#4bc0c0', backgroundColor: 'rgba(75,192,192,0.15)', pointRadius: 0, tension: 0.25, fill: false, borderWidth: seriesBorder },
          { label: 'Best-Case (P90)', data: p90, borderColor: '#29d07e', backgroundColor: 'rgba(0,0,0,0)', pointRadius: 0, tension: 0.25, fill: false, borderWidth: seriesBorder },
        ]
      };
    }
  })() : null;

  // (optional) Goal line annotation for the projection chart
  const goalTargetSel = convert(Number(goal.amount || 0), goal.ccy || 'USD', ccy, fx);
  const pfAnnotation = goal.amount ? {
    annotation: {
      annotations: {
        goalLine: {
          type: 'line',
          yMin: goalTargetSel,
          yMax: goalTargetSel,
          borderWidth: 1.5,
          borderDash: [6, 6],
          label: {
            enabled: true,
            content: 'Goal',
            position: 'end'
          }
        }
      }
    }
  } : {};


  const coinMeta = {
    bitcoin: {
      emoji: '₿',
      logo: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
    },
    ethereum: {
      emoji: '⧫',
      logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    },
    dogecoin: {
      emoji: '🐶',
      logo: 'https://assets.coingecko.com/coins/images/5/small/dogecoin.png',
    },
  };

  // -----------------------------
  // 8) UI
  // -----------------------------
  return (
    <div className={darkMode ? 'app dark' : 'app'}>

      {/* Top maker banner */}
      <div className="maker-banner" role="note" aria-label="Made by Saptorshee Nag">
        <span className="mb-pulse" />
        <span className="mb-text">
          Made by <strong>Saptorshee&nbsp;Nag</strong>
        </span>

        {/* Social icons */}
        <div className="mb-links">
          <a
            href="https://www.linkedin.com/in/saptorshee-nag-588294220/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="LinkedIn"
          >
            <i className="fab fa-linkedin-in" />
          </a>
          <a
            href="https://github.com/SaptorsheeNag"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <i className="fab fa-github" />
          </a>
        </div>

        <span className="mb-sparkle">✦</span>
      </div>


      {/* Toast container */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: darkMode ? '#1e1e1e' : '#fff',
            color: darkMode ? '#f5f5f5' : '#111',
            border: darkMode ? '1px solid #2a2a2a' : '1px solid #eee'
          }
        }}
      />

      <header>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={ccy}
            onChange={e => setCcy(e.target.value)}
            title="Display currency"
            style={{ padding: '6px 10px', borderRadius: 8 }}
          >
            {CURRENCIES.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <button onClick={() => setDarkMode(!darkMode)}>
            {darkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
          </button>
        </div>
      </header>

      {/* ===== Hero / Overview ===== */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-left">
            <h1 className="page-title">📊 Live Crypto Prices</h1>
            <div className="hero-badge">
              <span className="pulse" /> Welcome
            </div>

            <h2 className="hero-title">
              Your all-in-one <span className="grad">Crypto Control Center</span>
            </h2>

            <p className="hero-sub">
              Track live prices, compare coins, set smart alerts, simulate
              <strong> DCA</strong> and <strong>what-if</strong> scenarios, and project
              your portfolio — all in one sleek dashboard.
            </p>

            <div className="hero-ctas">
              <button
                className={`cta ${heroActive === 'start' ? 'primary' : 'ghost'}`}
                onClick={() => { setHeroActive('start'); scrollTo('#market-overview'); }}
                title="Jump to Market Overview"
              >
                Let’s get you started
              </button>

              <button
                className={`cta ${heroActive === 'alerts' ? 'primary' : 'ghost'}`}
                onClick={() => { setHeroActive('alerts'); scrollTo('#alerts'); }}
                title="Jump to Price Alerts"
              >
                Set a price alert
              </button>

              <button
                className={`cta ${heroActive === 'whatif' ? 'primary' : 'ghost'}`}
                onClick={() => { setHeroActive('whatif'); scrollTo('#whatif'); }}
                title="Jump to What-If"
              >
                What-If
              </button>

              <button
                className={`cta ${heroActive === 'dca' ? 'primary' : 'ghost'}`}
                onClick={() => { setHeroActive('dca'); scrollTo('#dca'); }}
                title="Jump to DCA"
              >
                DCA
              </button>

              <button
                className={`cta ${heroActive === 'portfolio' ? 'primary' : 'ghost'}`}
                onClick={() => { setHeroActive('portfolio'); scrollTo('#portfolio'); }}
                title="Jump to Portfolio"
              >
                Portfolio
              </button>
            </div>

            <ul className="hero-tags">
              <li>Real-time</li>
              <li>Multi-currency</li>
              <li>Monte-Carlo</li>
              <li>Goals</li>
            </ul>
          </div>

          <div className="hero-right">
            {/* decorative blobs; pure CSS shapes */}
            <div className="blob b1" />
            <div className="blob b2" />
            <div className="blob b3" />
          </div>
        </div>
      </section>


      {loading ? (
        <p className="loading">Loading prices...</p>
      ) : (
        <>
          {/* price chips */}
          <ul className="price-list">
            {Object.entries(prices).map(([coin, data]) => (
              <li
                key={coin}
                className={`price-item ${selectedCoin === coin ? 'active' : ''}`}
                onClick={() => setSelectedCoin(coin)}
                title={`Price: ${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(data?.usd, ccy, fx), ccy)}`}
              >
                <img src={coinMeta[coin]?.logo} alt={coin} className="coin-logo" />
                <span>
                  {coinMeta[coin]?.emoji} <strong>{coin.toUpperCase()}</strong>
                </span>
                : {CCY_SYMBOL[ccy] || ''}{fmt(toCcy(data?.usd, ccy, fx), ccy)}
              </li>
            ))}
          </ul>

          {/* 📈 Market Overview (range buttons + main chart + compare) */}
          <div id="market-overview" className="mv-panel mv-hero">
            <div className="mv-body">
              <h3 className="mv-title">
                <span role="img" aria-label="chart">📊</span> Market Overview <span className="mv-spark" />
              </h3>
              <p className="mv-sub">
                See live price action for your selected coin. Switch between <b>24H</b>, <b>7D</b>, or <b>1M</b>,
                hover the chart to inspect exact values, and use <b>Compare</b> to pit coins head-to-head with
                a %-change view. It’s your quick pulse of the market.
              </p>

              {/* Range buttons */}
              <div className="mv-controls">
                <div className="time-buttons mv-seg">
                  {['1', '7', '30'].map(d => (
                    <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
                      {d === '1' ? '24H' : d === '7' ? '7D' : '1M'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Main price chart */}
              <div className="chart-container mv-main-chart">
                <Line data={chartData} options={chartOptions} />
              </div>

              {/* Compare */}
              <div className="mv-compare">
                <h4 style={{ margin: '12px 0 8px' }}>🆚 Compare</h4>
                <div className="time-buttons" style={{ flexWrap: 'wrap', gap: 8 }}>
                  {['off', 'DOGE vs BTC', 'ETH vs DOGE', 'ETH vs BTC', 'BTC vs ETH vs DOGE'].map(name => (
                    <button
                      key={name}
                      className={compareMode === name ? 'active' : ''}
                      onClick={() => setCompareMode(name)}
                      title={name === 'off' ? 'Hide comparison' : name}
                    >
                      {name === 'off' ? 'Off' : name}
                    </button>
                  ))}
                </div>

                {compareMode !== 'off' && (
                  <div className="chart-container" style={{ marginTop: 12 }}>
                    {compareChartData ? (
                      <Line
                        key={`cmp-${compareMode}-${days}-${activeCoins.join(',')}`}
                        data={compareChartData}
                        options={compareChartOptions}
                        redraw
                      />
                    ) : (
                      <p className="muted">Loading comparison…</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Alerts (MV hero) */}
          <div id="alerts" className="mv-panel mv-hero mv-hero--noTL">
            <h3 className="mv-title">
              <span role="img" aria-label="bell">🔔</span> Price Alerts <span className="mv-spark" />
            </h3>
            <p className="mv-sub">
              Ever wished your computer tapped you on the shoulder at the right price?
              Create rules like <b>“BTC ≥ $70k”</b> and I’ll notify you here
              (and via browser notifications if you’ve allowed them).
            </p>

            <div className="mv-controls">
              <AlertForm
                coins={Object.keys(prices)}
                onAdd={(rule) => addAlertServer(rule)}
                ccy={ccy}
              />
            </div>

            {alerts.length === 0 ? (
              <p className="muted">No alerts yet. Add one above.</p>
            ) : (
              <ul className="alert-list">
                {alerts.map(a => (
                  <li key={a.id}>
                    <strong>{a.coin.toUpperCase()}</strong>&nbsp;
                    {a.op === 'gte' ? '≥' : '≤'} {(CCY_SYMBOL[a.ccy] || '')}{fmt(a.value, a.ccy || 'USD')} {a.ccy || 'USD'}
                    <button className="link danger" onClick={() => removeAlertServer(a.id)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Sentiment + Volatility */}
          {(() => {
            const s = sentiment?.score;
            const label = sentimentLabel(s);
            const vol = volatility?.annualized_vol;

            return (
              <div className="mv-panel mv-hero mv-hero--noTL">
                <h3 className="mv-title">
                  <span role="img" aria-label="brain">🧠</span> Sentiment & Volatility <span className="mv-spark" />
                </h3>
                <p className="mv-sub">
                  Ever wanted a quick vibe check before acting? See headline sentiment for the selected coin and its
                  realized volatility so you know the <b>mood</b> and the <b>risk</b> at a glance.
                </p>

                <div className="sv-grid">
                  {/* Sentiment card */}
                  <div className="sv-card">
                    <div className="sv-title">Social Sentiment</div>
                    <div className="sv-metric" style={{ color: label.color }}>
                      {label.text} {s != null && <span className="sv-note">({s.toFixed(2)})</span>}
                    </div>

                    {sentiment?.items?.length ? (
                      <ul className="sv-list">
                        {sentiment.items.slice(0, 5).map((it, i) => (
                          <li key={i}>
                            <span className={`dot ${it.score > 0.2 ? 'pos' : it.score < -0.2 ? 'neg' : 'neu'}`} />
                            {it.title}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No recent headlines found.</p>
                    )}
                  </div>

                  {/* Volatility card */}
                  <div className="sv-card">
                    <div className="sv-title">Realized Volatility</div>
                    <div className="sv-metric">
                      {typeof vol === 'number' ? `${vol.toFixed(2)}%` : '—'}
                    </div>
                    <div className="sv-sub">Annualized (based on {days === '1' ? '24H' : days === '7' ? '7D' : '30D'} history)</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 📊 What-If Scenario */}
          <div
            id="whatif"
            className={`mv-panel mv-hero ${whatIfRes ? 'mv-hero--blobBL' : 'mv-hero--noBlobs'}`}
          >
            <h3 className="mv-title">
              <span role="img" aria-label="chart">📊</span> What-If Scenario <span className="mv-spark" />
            </h3>
            <p className="mv-sub">
              Ever wondered “what if I bought back then?” Drop a date and amount to backtest instantly.
              <b>Normal (to date)</b> shows history to today, flip to <b>Short-term</b> for a few-months-ahead peek with an uncertainty band,
              or go <b>Long-term</b> for a Monte-Carlo fan of possible paths.
            </p>

            {/* controls row styled like Market Overview */}
            <div className="mv-controls">
              <form className="pf-form" onSubmit={runWhatIf}>
                <select
                  value={whatIf.coin}
                  onChange={e => setWhatIf(w => ({ ...w, coin: e.target.value }))}
                >
                  {Object.keys(prices).map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>

                <input
                  type="number" step="0.01" min="1"
                  placeholder={`Amount (${ccy})`}
                  value={whatIf.amount}
                  onChange={e => setWhatIf(w => ({ ...w, amount: Number(e.target.value) }))}
                />

                <input
                  type="date"
                  value={whatIf.date}
                  onChange={e => setWhatIf(w => ({ ...w, date: e.target.value }))}
                  disabled={whatIfMode === 'long'}
                  title={whatIfMode === 'long' ? 'Disabled in Monte-Carlo mode (invest now)' : 'Backtest start date'}
                />

                {/* Mode toggle: Normal / Short / Long */}
                <div className="mv-seg" style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                  <button
                    type="button"
                    className={!whatIfMode ? 'active' : ''}
                    onClick={() => { setWhatIfMode(null); setWhatIfRes(null); }}
                    title="Backtest from your chosen start date to today"
                  >
                    Normal (to date)
                  </button>

                  <button
                    type="button"
                    className={whatIfMode === 'short' ? 'active' : ''}
                    onClick={() => { setWhatIfMode('short'); setWhatIfRes(null); }}
                    title="Project a few months ahead with bands"
                  >
                    Short-term (≤ 180d)
                  </button>

                  <button
                    type="button"
                    className={whatIfMode === 'long' ? 'active' : ''}
                    onClick={() => { setWhatIfMode('long'); setWhatIfRes(null); }}
                    title="Monte-Carlo fan of outcomes"
                  >
                    Long-term (Monte-Carlo)
                  </button>
                </div>

                <div className="muted" style={{ fontSize: 12 }}>
                  {whatIfMode === 'long'
                    ? 'Monte-Carlo assumes a lump-sum invested now.'
                    : 'Backtest uses your chosen start date.'}
                </div>

                {whatIfMode === 'long' && (
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={whatIfYears}
                    onChange={e => setWhatIfYears(Number(e.target.value))}
                    placeholder="Years"
                    title="Projection horizon (years)"
                  />
                )}

                <button type="submit" disabled={whatIfLoading}>
                  {whatIfLoading ? 'Calculating…' : 'Run What-If'}
                </button>
              </form>
            </div>

            {/* results + chart UNCHANGED below */}
            {whatIfRes && (
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
                  <div><strong>Invested:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(whatIfRes.amount, ccy, fx), ccy)}</div>

                  {whatIfRes.kind === 'short' ? (
                    <>
                      <div><strong>Start Price:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(whatIfRes.start_price, ccy, fx), ccy)}</div>
                      <div><strong>Current Price:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(whatIfRes.current_price, ccy, fx), ccy)}</div>
                      <div><strong>Shares:</strong> {whatIfRes.shares.toFixed(6)}</div>
                      <div><strong>Value Now:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(whatIfRes.current_value, ccy, fx), ccy)}</div>
                      <div className={whatIfRes.roi_pct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                        <strong>ROI:</strong> {whatIfRes.roi_pct.toFixed(2)}%
                      </div>
                      <div><strong>CAGR:</strong> {whatIfRes.cagr_pct != null ? `${whatIfRes.cagr_pct.toFixed(2)}%` : '—'}</div>
                      <div><strong>Max Drawdown:</strong> {whatIfRes.max_drawdown_pct.toFixed(2)}%</div>
                    </>
                  ) : (
                    <>
                      <div><strong>Shares (now):</strong> {whatIfRes.shares.toFixed(6)}</div>
                      <div><strong>Spot Price:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(whatIfRes.current_price, ccy, fx), ccy)}</div>
                      <div><strong>Horizon:</strong> {whatIfRes.years}y</div>
                      <div><strong>Most Likely @ horizon (P50):</strong>{' '}
                        {(() => {
                          const v = whatIfRes.p50?.length ? whatIfRes.p50[whatIfRes.p50.length - 1][1] : null;
                          return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
                        })()}
                      </div>
                      <div><strong>Best-Case (P90):</strong>{' '}
                        {(() => {
                          const v = whatIfRes.p90?.length ? whatIfRes.p90[whatIfRes.p90.length - 1][1] : null;
                          return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
                        })()}
                      </div>
                      <div><strong>Worst-Case (P10):</strong>{' '}
                        {(() => {
                          const v = whatIfRes.p10?.length ? whatIfRes.p10[whatIfRes.p10.length - 1][1] : null;
                          return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
                        })()}
                      </div>
                    </>
                  )}
                </div>

                <div className="chart-container" style={{ marginTop: 12 }}>
                  {(() => {

                    if (whatIfRes.kind === 'long') {
                      const p10 = (whatIfRes.p10 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
                      const p50 = (whatIfRes.p50 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
                      const p90 = (whatIfRes.p90 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));

                      return (
                        <Line
                          data={{
                            datasets: [
                              { label:'Worst-Case (P10)',     data:p10, borderColor:'#ff6b6b', backgroundColor:'rgba(0,0,0,0)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                              { label:'Most Likely (Median)', data:p50, borderColor:'#4bc0c0', backgroundColor:'rgba(75,192,192,0.15)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                              { label:'Best-Case (P90)',      data:p90, borderColor:'#29d07e', backgroundColor:'rgba(0,0,0,0)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                            ]
                          }}
                          options={{
                            responsive:true,
                            interaction:{ mode:'index', intersect:false },
                            elements:{ point:{ radius:0, hitRadius:10, hoverRadius:4 } },
                            plugins:{ legend:{ labels:{ color: darkMode ? '#fff' : '#000' } },
                                      tooltip:{ enabled:true },
                                      decimation:{ enabled:true, algorithm:'lttb', samples:200 } },
                            scales:{
                              x:{ type:'time', time:{ tooltipFormat:'MMM d, yyyy', displayFormats:{ day:'MMM d, yyyy', month:'MMM yyyy', year:'yyyy' } },
                                  ticks:{ color: gx.ticksColor, maxTicksLimit:10, maxRotation:0 }, ...gx.grid },
                              y:{ ticks:{ color: gx.ticksColor, callback:v=>`${CCY_SYMBOL[ccy]||''}${fmt(v,ccy)}` }, ...gx.grid }
                            }
                          }}
                        />
                      );
                    }

                    return whatIfChart ? (
                      <Line
                        data={whatIfChart}
                        options={{
                          responsive: true,
                          interaction: { mode: 'index', intersect: false },
                          elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
                          plugins: {
                            legend: { labels: { color: darkMode ? '#fff' : '#000' } },
                            tooltip: { enabled: true },
                            decimation: { enabled: true, algorithm: 'lttb', samples: 200 },
                          },
                          scales: {
                            x: {
                              type: 'time',
                              time: {
                                tooltipFormat: 'MMM d, yyyy',
                                displayFormats: { day: 'MMM d, yyyy', month: 'MMM yyyy', year: 'yyyy' },
                              },
                              ticks: { color: gx.ticksColor, maxTicksLimit: 10, maxRotation: 0 },
                              ...gx.grid,
                            },
                            y: {
                              ticks: { color: gx.ticksColor, callback: v => `${CCY_SYMBOL[ccy] || ''}${fmt(v, ccy)}` },
                              ...gx.grid,
                            },
                          },
                        }}
                      />
                    ) : null;
                  })()}

                  <div style={{ marginTop: 8, fontSize: '0.85rem', color: darkMode ? '#ccc' : '#333' }}>
                    <p style={{ margin: 0 }}>
                      {whatIfRes.kind === 'long'
                        ? (
                          <>
                            <b>Worst-Case (P10)</b> ≈ pessimistic, <b>Most Likely (Median)</b> is the middle path,
                            and <b>Best-Case (P90)</b> ≈ optimistic.
                          </>
                        )
                        : (
                          <>
                            The shaded area shows likely outcomes. <b>Median</b> is the central path, with
                            <b> Best-Case</b> and <b>Worst-Case</b> bounds.
                          </>
                        )
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>


{/* 📅 DCA Simulator */}
<div
  id="dca"
  className={`mv-panel mv-hero ${dcaRes ? 'mv-hero--blobBL' : 'mv-hero--noBlobs'}`}
>
  <h3 className="mv-title">
    <span role="img" aria-label="calendar">📅</span> DCA Simulator <span className="mv-spark" />
  </h3>
  <p className="mv-sub">
    Ever wanted to see how steady buys stack up? Pick an amount and schedule to backtest.
    <b> Normal (to date)</b> runs to today; <b>Short-term</b> projects the next few months,
    and <b>Long-term</b> runs Monte-Carlo on your plan.
  </p>

  <div className="mv-controls">
    <form className="pf-form" onSubmit={runDCA}>
      <select 
        value={dca.coin} 
        onChange={e => setDca(s => ({ ...s, coin: e.target.value }))}
      >
        {Object.keys(prices).map(c => (
          <option key={c} value={c}>{c.toUpperCase()}</option>
        ))}
      </select>
      
      <input 
        type="number" 
        step="0.01" 
        placeholder={`Per ${dca.freq === 'weekly' ? 'week' : 'month'} (${ccy})`}
        value={dca.amount} 
        onChange={e => setDca(s => ({ ...s, amount: e.target.value }))} 
      />
      
      <input 
        type="date" 
        value={dca.start} 
        onChange={e => setDca(s => ({ ...s, start: e.target.value }))} 
      />
      
      <select 
        value={dca.freq} 
        onChange={e => setDca(s => ({ ...s, freq: e.target.value }))}
      >
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      
      {/* Mode toggle: Normal / Short / Long */}
      <div className="mv-seg" style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
        <button
          type="button"
          className={!dcaMode ? 'active' : ''}
          onClick={() => { setDcaMode(null); setDcaRes(null); }}
          title="Backtest your DCA plan to today"
        >
          Normal (to date)
        </button>

        <button
          type="button"
          className={dcaMode === 'short' ? 'active' : ''}
          onClick={() => { setDcaMode('short'); setDcaRes(null); }}
          title="Project a few months ahead with bands"
        >
          Short-term (≤ 6 months)
        </button>

        <button
          type="button"
          className={dcaMode === 'long' ? 'active' : ''}
          onClick={() => { setDcaMode('long'); setDcaRes(null); }}
          title="Monte-Carlo fan of outcomes"
        >
          Long-term (Monte-Carlo)
        </button>
      </div>


      {dcaMode === 'long' ? (
        <input
          type="number"
          min="1"
          max="20"
          step="1"
          value={dcaYears}
          onChange={e => setDcaYears(Number(e.target.value))}
          placeholder="Years"
        />
      ) : null}

      <button type="submit" disabled={dcaLoading}>
        {dcaLoading ? 'Running…' : 'Run DCA'}
      </button>
    </form>
  </div>

  {/* results + chart UNCHANGED below */}
  {dcaRes && (
    <div style={{ marginTop: 12 }}>
      {dcaRes.kind === 'short' ? (
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div>
            <strong>Invested:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(dcaRes.invested_total, ccy, fx), ccy)}
          </div>
          <div>
            <strong>Shares:</strong> {dcaRes.shares.toFixed(6)}
          </div>
          <div>
            <strong>Value Now:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(dcaRes.current_value, ccy, fx), ccy)}
          </div>
          <div className={dcaRes.roi_pct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
            <strong>ROI:</strong> {dcaRes.roi_pct.toFixed(2)}%
          </div>
          {dcaRes.cagr_pct != null && (
            <div>
              <strong>CAGR:</strong> {dcaRes.cagr_pct.toFixed(2)}%
            </div>
          )}
        </div>
      ) : (
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div>
            <strong>Invested (schedule):</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(dcaRes.invested_total, ccy, fx), ccy)}
          </div>
          <div>
            <strong>Worst-Case (P10):</strong>{' '}
            {(() => {
              const v = dcaRes.p10?.length ? dcaRes.p10[dcaRes.p10.length-1][1] : null;
              return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
            })()}
          </div>
          <div>
            <strong>Most Likely (Median):</strong>{' '}
            {(() => {
              const v = dcaRes.p50?.length ? dcaRes.p50[dcaRes.p50.length-1][1] : null;
              return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
            })()}
          </div>
          <div>
            <strong>Best-Case (P90):</strong>{' '}
            {(() => {
              const v = dcaRes.p90?.length ? dcaRes.p90[dcaRes.p90.length-1][1] : null;
              return v != null ? `${(CCY_SYMBOL[ccy] || '')}${fmt(toCcy(v, ccy, fx), ccy)}` : '—';
            })()}
          </div>
        </div>
      )}

      {dcaRes.kind === 'short' && dcaRes.lump_sum && (
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
          <div>
            <strong>LS Value:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(toCcy(dcaRes.lump_sum.current_value, ccy, fx), ccy)}
          </div>
          <div className={dcaRes.lump_sum.roi_pct >= 0 ? 'pnl-pos' : 'pnl-neg'}>
            <strong>LS ROI:</strong> {dcaRes.lump_sum.roi_pct.toFixed(2)}%
          </div>
        </div>
      )}

      {(Array.isArray(dcaRes?.series) && dcaRes.series.length > 0) || dcaRes?.p50 ? (
        <div className="chart-container" style={{ marginTop: 12 }}>
          {(() => {
            if (dcaRes.kind === 'short') {
              const main = (dcaRes.series || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
              const hasBands = dcaRes?.bands?.low?.length && dcaRes?.bands?.high?.length;

              const datasets = [{
                label: 'Most Likely',
                data: main,
                borderColor: '#4bc0c0',
                backgroundColor: 'rgba(75,192,192,0.2)',
                borderWidth: seriesBorder, pointRadius: 0, tension: 0.25, fill: true,
              }];

              if (hasBands) {
                const lowVals = dcaRes.bands.low.map(([, v]) => toCcy(v, ccy, fx));
                const highVals = dcaRes.bands.high.map(([, v]) => toCcy(v, ccy, fx));
                const tailTs = (dcaRes.series || []).slice(-lowVals.length).map(([ts]) => ts);

                const lowPoints  = tailTs.map((ts, i) => ({ x: ts, y: lowVals[i]  }));
                const highPoints = tailTs.map((ts, i) => ({ x: ts, y: highVals[i] }));

                datasets.push({
                  label: 'Worst-Case',
                  data: lowPoints,
                  borderColor: 'rgba(0,0,0,0)',
                  backgroundColor: 'rgba(0,0,0,0)',
                  pointRadius: 0, tension: 0.25, fill: false,
                });
                datasets.push({
                  label: 'Best-Case',
                  data: highPoints,
                  borderColor: 'rgba(0,0,0,0)',
                  backgroundColor: 'rgba(75,192,192,0.12)',
                  pointRadius: 0, tension: 0.25, fill: '-1',
                });
              }

              return (
                <Line 
                  data={{ datasets }}
                  options={{
                    responsive: true,
                    interaction: { mode: 'index', intersect: false },
                    elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
                    plugins: {
                      legend: { labels: { color: darkMode ? '#fff' : '#000' } },
                      tooltip: { enabled: true },
                      decimation: { enabled: true, algorithm: 'lttb', samples: 200 },
                    },
                    scales: {
                      x: {
                        type: 'time',
                        time: {
                          tooltipFormat: 'MMM d, yyyy',
                          displayFormats: { day: 'MMM d, yyyy', month: 'MMM yyyy', year: 'yyyy' },
                        },
                        ticks: { color: gx.ticksColor, maxTicksLimit: 10, maxRotation: 0 },
                        ...gx.grid,
                      },
                      y: {
                        ticks: { color: gx.ticksColor, callback: v => `${CCY_SYMBOL[ccy] || ''}${fmt(v, ccy)}` },
                        ...gx.grid,
                      },
                    },
                  }} 
                />
              );
            }

            const p10 = (dcaRes.p10 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
            const p50 = (dcaRes.p50 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));
            const p90 = (dcaRes.p90 || []).map(([ts, v]) => ({ x: ts, y: toCcy(v, ccy, fx) }));

            return (
              <Line
                data={{
                  datasets: [
                    { label:'Worst-Case (P10)',     data:p10, borderColor:'#ff6b6b', backgroundColor:'rgba(0,0,0,0)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                    { label:'Most Likely (Median)', data:p50, borderColor:'#4bc0c0', backgroundColor:'rgba(75,192,192,0.15)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                    { label:'Best-Case (P90)',      data:p90, borderColor:'#29d07e', backgroundColor:'rgba(0,0,0,0)', pointRadius:0, tension:0.25, fill:false, borderWidth: seriesBorder },
                  ]
                }}
                options={{
                  responsive:true,
                  interaction:{ mode:'index', intersect:false },
                  elements:{ point:{ radius:0, hitRadius:10, hoverRadius:4 } },
                  plugins:{ legend:{ labels:{ color: darkMode ? '#fff' : '#000' } },
                            tooltip:{ enabled:true },
                            decimation:{ enabled:true, algorithm:'lttb', samples:200 } },
                  scales:{
                    x:{ type:'time', time:{ tooltipFormat:'MMM d, yyyy', displayFormats:{ day:'MMM d, yyyy', month:'MMM yyyy', year:'yyyy' } },
                        ticks:{ color: gx.ticksColor, maxTicksLimit:10, maxRotation:0 }, ...gx.grid },
                    y:{ ticks:{ color: gx.ticksColor, callback:v=>`${CCY_SYMBOL[ccy]||''}${fmt(v,ccy)}` }, ...gx.grid }
                  }
                }}
              />
            );
          })()}

          <div style={{ marginTop: 8, fontSize: '0.85rem', color: darkMode ? '#ccc' : '#333' }}>
            <p style={{ margin: 0 }}>
              {dcaRes.kind === 'long'
                ? (
                  <>
                    <b>Worst-Case (P10)</b> is a pessimistic path, <b>Most Likely (Median)</b> is the middle path,
                    and <b>Best-Case (P90)</b> is optimistic. The median line is your central estimate.
                  </>
                )
                : (
                  <>
                    The shaded area shows the range of realistic outcomes.
                    <b> Median</b> (middle line) is the most likely path,
                    <b> Best-Case</b> (upper bound) if things go very well,
                    and <b>Worst-Case</b> (lower bound) if things go poorly.
                  </>
                )
              }
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )}
</div>

{/* Portfolio (MV hero wrapper so ALL content gets the glow) */}
<div
  id="portfolio"
  className={`mv-panel mv-hero ${pfChart ? 'mv-hero--blobBL' : 'mv-hero--noBlobs'}`}
>
  <h3 className="mv-title">
    <span role="img" aria-label="briefcase">💼</span> Portfolio <span className="mv-spark" />
  </h3>
  <p className="mv-sub">
    Ever wished your whole portfolio had a crystal ball? Track holdings and goals,
    then project the road ahead. <b>Normal</b> shows history to today, <b>Short-term</b> adds a near-term band,
    and <b>Long-term</b> simulates best / median / worst paths.
  </p>

  {/* -- Holdings table & add form -- */}
  <HoldingForm
    coins={Object.keys(prices)}
    onAdd={(h) => addHoldingServer(h)}
    ccy={ccy}
  />

  {holdings.length === 0 ? (
    <p className="muted">No holdings yet. Add one above.</p>
  ) : (
    <table className="pf-table">
      <thead>
        <tr>
          <th>Coin</th>
          <th>Amount</th>
          <th>Buy @</th>
          <th>Current</th>
          <th>Value</th>
          <th>P/L</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {holdings.map(h => {
          const curUsd = px(h.coin);
          const curSel = curUsd != null ? convert(curUsd, 'USD', ccy, fx) : null;
          const buySel = convert(h.buyPrice, h.ccy || 'USD', ccy, fx);
          const valueSel = curSel != null ? h.amount * curSel : null;
          const investedSel = h.amount * buySel;
          const pnlSel = valueSel != null ? valueSel - investedSel : null;
          const pnlPct = pnlSel != null && investedSel > 0 ? (pnlSel / investedSel) * 100 : null;

          return (
            <tr key={h.id}>
              <td>{h.coin.toUpperCase()}</td>
              <td>{h.amount}</td>
              <td>{(CCY_SYMBOL[ccy] || '')}{fmt(buySel, ccy)}</td>
              <td>{curSel != null ? `${CCY_SYMBOL[ccy] || ''}${fmt(curSel, ccy)}` : '—'}</td>
              <td>{valueSel != null ? `${CCY_SYMBOL[ccy] || ''}${fmt(valueSel, ccy)}` : '—'}</td>
              <td className={pnlSel == null ? '' : (pnlSel >= 0 ? 'pnl-pos' : 'pnl-neg')}>
                {pnlSel != null ? (
                  <>
                    {(CCY_SYMBOL[ccy] || '')}{fmt(pnlSel, ccy)}
                    {investedSel > 0 && <> ({pnlPct.toFixed(2)}%)</>}
                  </>
                ) : '—'}
              </td>
              <td>
                <button className="link danger" onClick={() => removeHoldingServer(h.id)}>
                  Remove
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  )}

  {/* -- Summary & Goal -- */}
  {(() => {
    const s = computePortfolioSummary(holdings);
    const goalTargetSel = convert(Number(goal.amount || 0), goal.ccy || 'USD', ccy, fx);
    const prog = goalProgress(s.value, goalTargetSel);

    return (
      <div className="pf-summary">
        <div className="row">
          <div><strong>Invested:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(s.invested, ccy)}</div>
          <div><strong>Value:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(s.value, ccy)}</div>
          <div className={s.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>
            <strong>P/L:</strong> {(CCY_SYMBOL[ccy] || '')}{fmt(s.pnl, ccy)} ({s.pnlPct.toFixed(2)}%)
          </div>
        </div>

        <h4>🎯 Goal</h4>
        <GoalForm goal={goal} onSave={saveGoalServer} ccy={ccy} fx={fx} />

        {goal.amount ? (
          <div className="goal-progress">
            <div className="bar"><div className="fill" style={{ width: `${prog}%` }} /></div>
            <div className="meta">
              <span>Target: {(CCY_SYMBOL[ccy] || '')}{fmt(goalTargetSel, ccy)} {goal.date ? `by ${goal.date}` : ''}</span>
              <span>{prog.toFixed(1)}%</span>
            </div>
          </div>
        ) : (
          <p className="muted">Set a goal to track progress over time.</p>
        )}
      </div>
    );
  })()}

  {/* -- Projection sub-card (no nested mv-panel) -- */}
  <h4 style={{ marginTop: 10 }}>🔮 Portfolio Projection</h4>
  <div className="mv-controls">
    <form className="pf-form" onSubmit={runPortfolioProjection}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Mode toggle: Normal / Short / Long */}
        <div className="mv-seg" style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <button
            type="button"
            className={!pfMode ? 'active' : ''}
            onClick={() => { setPfMode(null); setPfProj(null); }}
            title="Show portfolio value history up to today"
          >
            Normal (to date)
          </button>

          <button
            type="button"
            className={pfMode === 'short' ? 'active' : ''}
            onClick={() => { setPfMode('short'); setPfProj(null); }}
            title="Short-term forecast with bands"
          >
            Short-term (≤ 180d)
          </button>

          <button
            type="button"
            className={pfMode === 'long' ? 'active' : ''}
            onClick={() => { setPfMode('long'); setPfProj(null); }}
            title="Monte-Carlo paths"
          >
            Long-term (Monte-Carlo)
          </button>
        </div>

        {pfMode === 'short' ? (
          <input type="number" min="1" max="180" step="1" value={pfH}
                 onChange={e => setPfH(Number(e.target.value))} placeholder="Horizon (days)" />
        ) : (
          <input type="number" min="1" max="20" step="1" value={pfYears}
                 onChange={e => setPfYears(Number(e.target.value))} placeholder="Years" />
        )}

        <button type="submit" disabled={pfLoading}>
          {pfLoading ? 'Projecting…' : 'Project Portfolio'}
        </button>
      </div>
    </form>
  </div>

  {/* KPI strip + chart (unchanged) */}
  <div className="pf-kpis">
    <div className="kpi">
      <div className="kpi-label">Now</div>
      <div className="kpi-value">{(CCY_SYMBOL[ccy] || '')}{fmt(pfNowValueSel, ccy)}</div>
      <div className="kpi-sub">Current portfolio value</div>
    </div>

    {pfSnapshot?.kind === 'short' && (
      <div className="kpi">
        <div className="kpi-label">Short-term (+{pfH}d)</div>
        <div className="kpi-value">{(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.v ?? 0, ccy)}</div>
        {pfSnapshot.lo != null && pfSnapshot.hi != null && (
          <div className="kpi-sub">
            Worst-Case: {(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.lo, ccy)} ·
            {' '}Best-Case: {(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.hi, ccy)}
          </div>
        )}
      </div>
    )}

    {pfSnapshot?.kind === 'long' && (
      <div className="kpi" title="Worst-Case ≈ 10th percentile · Most Likely = Median · Best-Case ≈ 90th percentile">
        <div className="kpi-label">Long-term ({pfYears}y)</div>
        <div className="kpi-value">{(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.v ?? 0, ccy)}</div>
        {(pfSnapshot.p10 != null && pfSnapshot.p90 != null) && (
          <div className="kpi-sub">
            Worst-Case: {(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.p10, ccy)} ·
            Best-Case: {(CCY_SYMBOL[ccy] || '')}{fmt(pfSnapshot.p90, ccy)}
          </div>
        )}
      </div>
    )}
  </div>

  {pfChart && (
    <div className="chart-container" style={{ marginTop: 12 }}>
      <Line
        data={pfChart}
        options={{
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 4 } },
          plugins: {
            legend: { labels: { color: darkMode ? '#fff' : '#000' } },
            tooltip: { enabled: true },
            decimation: { enabled: true, algorithm: 'lttb', samples: 200 },
            ...(pfAnnotation || {})
          },
          scales: {
            x: { type: 'time',
                 time: { tooltipFormat: 'MMM d, yyyy', displayFormats: { day: 'MMM d, yyyy', month: 'MMM yyyy', year: 'yyyy' } },
                 ticks: { color: (darkMode ? '#fff' : '#000') }, ...gridStyle(darkMode).grid },
            y: { ticks: { color: (darkMode ? '#fff' : '#000'), callback: v => `${CCY_SYMBOL[ccy] || ''}${fmt(v, ccy)}` },
                 ...gridStyle(darkMode).grid },
          },
        }}
      />
      <div style={{ marginTop: 8, fontSize: '0.85rem', color: darkMode ? '#ccc' : '#333' }}>
        <p style={{ margin: 0 }}>
          {pfProj?.kind === 'long'
            ? (<><b>Worst-Case (P10)</b> is pessimistic, <b>Most Likely (Median)</b> is the middle path,
                and <b>Best-Case (P90)</b> is optimistic.</>)
            : (<>The shaded area shows likely outcomes. <b>Median</b> is the central path,
                with <b>Best-Case</b> and <b>Worst-Case</b> bounds.</>)}
        </p>
      </div>
    </div>
  )}
</div>

</>
)}

</div>
);
}

/** Tiny form component that lives in the same file */
function AlertForm({ coins = [], onAdd, ccy }) {
    const [coin, setCoin] = useState(coins[0] || 'bitcoin');
    const [op, setOp] = useState('gte'); // 'gte' or 'lte'
    const [value, setValue] = useState('');

    // keep selected coin valid once prices load
    useEffect(() => {
        if (coins.length && !coins.includes(coin)) setCoin(coins[0]);
    }, [coins]);

    return (
        <form 
            className="alert-form" 
            onSubmit={(e) => {
                e.preventDefault();
                const num = Number(value);
                if (!coin || !['gte', 'lte'].includes(op) || Number.isNaN(num)) return;
                onAdd({ coin, op, value: num, ccy });
                setValue('');
            }}
        >
            <select value={coin} onChange={e => setCoin(e.target.value)}>
                {coins.map(c => (
                    <option key={c} value={c}>{c.toUpperCase()}</option>
                ))}
            </select>

            <select value={op} onChange={e => setOp(e.target.value)}>
                <option value="gte">≥</option>
                <option value="lte">≤</option>
            </select>

            <input 
                type="number" 
                step="0.01" 
                placeholder={`Target price (${ccy})`} 
                value={value} 
                onChange={e => setValue(e.target.value)} 
            />

            <button type="submit">Add Alert</button>
        </form>
    );
}

function HoldingForm({ coins = [], onAdd, ccy }) {
    const [coin, setCoin] = useState(coins[0] || 'bitcoin');
    const [amount, setAmount] = useState('');
    const [buyPrice, setBuyPrice] = useState('');

    useEffect(() => {
        if (coins.length && !coins.includes(coin)) setCoin(coins[0]);
    }, [coins]);

    return (
        <form 
            className="pf-form" 
            onSubmit={(e) => {
                e.preventDefault();
                const amt = Number(amount);
                const buy = Number(buyPrice);
                if (!coin || Number.isNaN(amt) || Number.isNaN(buy)) return;
                onAdd({ coin, amount: amt, buyPrice: buy, ccy });
                setAmount('');
                setBuyPrice('');
            }}
        >
            <select value={coin} onChange={e => setCoin(e.target.value)}>
                {coins.map(c => (
                    <option key={c} value={c}>{c.toUpperCase()}</option>
                ))}
            </select>

            <input 
                type="number" 
                step="0.000001" 
                placeholder="Amount (e.g., 1.5)" 
                value={amount} 
                onChange={e => setAmount(e.target.value)} 
            />

            <input 
                type="number" 
                step="0.01" 
                placeholder={`Buy price (${ccy})`} 
                value={buyPrice} 
                onChange={e => setBuyPrice(e.target.value)} 
            />

            <button type="submit">Add Holding</button>
        </form>
    );
}

function GoalForm({ goal, onSave, ccy, fx }) {
    const [amount, setAmount] = useState(goal.amount || '');
    const [date, setDate] = useState(goal.date || '');

    useEffect(() => {
        const storedCcy = goal.ccy || 'USD';
        const v = goal?.amount != null ? convert(Number(goal.amount || 0), storedCcy, ccy, fx) : '';
        setAmount(v);
    }, [goal, ccy, fx]);

    return (
        <form 
            className="goal-form" 
            onSubmit={(e) => {
                e.preventDefault();
                onSave({ amount: Number(amount || 0), date, ccy });
            }}
        >
            <input 
                type="number" 
                step="0.01" 
                placeholder={`Goal amount (${ccy})`} 
                value={amount} 
                onChange={e => setAmount(e.target.value)} 
            />

            <input 
                type="date" 
                value={date} 
                onChange={e => setDate(e.target.value)} 
            />

            <button type="submit">Save Goal</button>
        </form>
    );
}

export default App;

// Note: The AlertForm component definition was not included in the provided code.