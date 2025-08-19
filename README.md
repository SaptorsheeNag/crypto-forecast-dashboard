# 🪙 Crypto Forecast Dashboard

A full-stack web application for **monitoring, simulating, and forecasting cryptocurrency price trends in real time**.  
Built with **React (frontend)** and **Flask + SQLite (backend)**, the dashboard integrates **live market data APIs** and presents **interactive, customizable charts** for crypto analysis.

---

## 📖 Overview

The dashboard provides:
- 📊 **Real-time & historical crypto price charts**  
- 💼 **Portfolio management & profit/loss tracking**  
- 💸 **DCA (Dollar-Cost Averaging) simulation** for strategy testing  
- 🔮 **What-If analysis** to forecast potential profits at different buy/sell points  
- 🎨 **User-friendly, responsive UI** that makes crypto tracking simple and insightful  

This project is ideal for **crypto enthusiasts, researchers, and students** exploring finance + web development.  

---

## ✨ Features

### 🔹 **Core Portfolio Features**
- 📊 **Real-time Portfolio Tracker** — Add holdings (BTC, ETH, etc.) and see live market values.  
- 🔐 **Secure Environment Handling** — Uses .env files to manage API keys & secrets.  
- 📂 **SQLite Database** — Lightweight backend storage for holdings, alerts, and configs.  

### 🔹 **Investment Simulations**
- 📈 **Normal Mode (To-Date Performance)**  
  Calculates your **actual portfolio growth** using historical crypto data up to today.  

- 💸 **Dollar Cost Averaging (DCA) Simulator**  
  Simulates buying a fixed amount of crypto **at regular intervals** (weekly, monthly, etc.), showing how consistent investing reduces volatility risk.  

- 🔮 **What-If Calculator**  
  Test scenarios like:  
  "If I bought 1 BTC in Jan 2020 and sold in Nov 2021, how much profit would I have made?"  

- 🎲 **Short-Term Monte Carlo Simulation**  
  Generates **hundreds of possible futures** over the next 30–90 days using random volatility sampling, helping investors visualize short-term risk.  

- 📆 **Long-Term Monte Carlo Simulation**  
  Projects **multi-year outcomes** of your portfolio, incorporating:  
  - Compounding effects  
  - Market swings  
  - Best-case vs. worst-case scenarios  

### 🔹 **User Experience**
- ⚡ **Real-time Crypto Prices** — Powered by the CoinGecko API.  
- 📊 **Dynamic Graphs** — Switch between 24h, 7d, 1M, or custom time ranges.  
- 🎨 **Dark/Light Mode** — Modern, toggle-based UI.  
- 🖼 **Coin Logos, Emojis & Tooltips** — Clean, intuitive visuals.  

---

## 🛠 Tech Stack

### **Frontend (React)**
- React + Chart.js (for interactive charts)  
- Axios (API calls)  
- Styled UI with Dark/Light theme toggle  

### **Backend (Flask)**
- Flask + SQLite  
- REST APIs for fetching live & historical data  
- Migration script (migrate_ccy.py) for schema updates  

---

## 🚀 Getting Started

### 1️⃣ Clone Repository
```bash
git clone https://github.com/SaptorsheeNag/crypto-forecast-dashboard.git
cd crypto-forecast-dashboard
```

### 2️⃣ Backend Setup
```bash
cd backend
python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
python app.py    # runs on http://localhost:5000
```

**Environment (optional)** — create backend/.flaskenv or .env:

```ini
FLASK_ENV=development
PORT=5000
CORS_ORIGINS=http://localhost:3000
```

**Notes:** Uses Flask + SQLite (app.db). Live prices come from CoinGecko (no API key).

### 3️⃣ Frontend Setup
```bash
cd ../frontend
npm install
npm start       # runs on http://localhost:3000
```

**Environment (optional)** — create frontend/.env:

```ini
REACT_APP_API_BASE=http://localhost:5000
```

### 4️⃣ Run Locally
- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:5000

If you changed ports, update REACT_APP_API_BASE.

### 5️⃣ API Endpoints (sample)
| Endpoint | Method | Query/Body | Purpose |
|----------|--------|------------|---------|
| /api/ping | GET | — | Health check |
| /api/price | GET | symbol=btc&range=7d | Live/historical prices |
| /api/portfolio | GET | — | Current portfolio snapshot |
| /api/portfolio | POST | { symbol, qty, price } | Add/update holding |
| /api/dca/simulate | POST | { symbol, amount, freq, startDate } | DCA backtest |
| /api/whatif | POST | { symbol, buyDate, sellDate, amount } | What-If return |
| /api/montecarlo | POST | { symbol, horizon, mode } | Short/Long-term Monte-Carlo |

### 6️⃣ Project Structure
```
crypto-forecast-dashboard/
├─ backend/
│  ├─ app.py
│  ├─ migrate_ccy.py
│  ├─ app.db
│  ├─ requirements.txt
│  ├─ Procfile
│  └─ runtime.txt
├─ frontend/
│  ├─ public/
│  └─ src/
│     ├─ App.js
│     ├─ App.css
│     ├─ index.js
│     └─ ...
├─ .gitignore
└─ README.md
```

### 7️⃣ Deployment

#### Backend → Render
1. New Web Service → Connect this repo.
2. **Root directory:** `backend`
3. **Build command:** `pip install -r requirements.txt`
4. **Start command:** `gunicorn app:app`
5. **Environment:**
   - `PYTHON_VERSION=3.11.9` (optional, matches runtime.txt)
   - `CORS_ORIGINS=https://<your-frontend-domain>`
6. Deploy. Copy the public URL (e.g., https://your-api.onrender.com).

**Note:** SQLite on free Render is ephemeral; use Postgres if you need persistent writes.

#### Frontend → Vercel
1. New Project → Import the repo.
2. **Root directory:** `frontend`
3. **Build command:** `npm run build`
4. **Output directory:** `build`
5. **Env var:** `REACT_APP_API_BASE=https://your-api.onrender.com`
6. Deploy.

### 8️⃣ Troubleshooting
- ⚠️ **CORS errors:** ensure backend sends CORS headers and CORS_ORIGINS includes your frontend domain.
- ❌ **404s from API in production:** confirm REACT_APP_API_BASE is set on Vercel and you rebuilt.
- 🔁 **Port conflicts locally:** stop other apps using 3000/5000 or change ports and update envs.
- 📉 **Empty charts:** check network tab for API errors; CoinGecko may rate-limit briefly.

### 9️⃣ Roadmap
- [ ] Multi-coin allocations & rebalancing
- [ ] Auth + saved portfolios
- [ ] Export results (CSV/PDF)
- [ ] More exchanges & stablecoins
- [ ] Advanced Monte-Carlo (fat tails, regime shifts)

---

## 👤 Author

**Saptorshee Nag**

- **LinkedIn:** [linkedin.com/in/saptorshee-nag-588294220](https://linkedin.com/in/saptorshee-nag-588294220)
- **GitHub:** [github.com/SaptorsheeNag](https://github.com/SaptorsheeNag)





