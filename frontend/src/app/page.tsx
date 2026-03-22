"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
} from "lightweight-charts";

// ── Configuration ──────────────────────────────────────────────────────────
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

// ── Types ──────────────────────────────────────────────────────────────────
interface PricePoint {
  price: string;
  high_24h: string;
  low_24h: string;
  volume_24h: string;
  price_change_pct: string;
  timestamp: string;
}

interface LatestPrice {
  id: number;
  symbol: string;
  price: string;
  high_24h: string;
  low_24h: string;
  volume_24h: string;
  price_change_pct: string;
  timestamp: string;
}

interface Stats {
  range: string;
  min_price: string;
  max_price: string;
  avg_price: string;
  data_points: number;
  open_price: string;
  close_price: string;
}

interface ChartDatum {
  time: string;
  price: number;
}

interface CandleDatum {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "1d"] as const;
const CHART_VIEWS = ["line", "candlestick", "both"] as const;
type ChartView = (typeof CHART_VIEWS)[number];

// ── Formatting helpers ─────────────────────────────────────────────────────
function fmtPrice(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtVolume(v: string): string {
  const n = parseFloat(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function bucketSeconds(interval: string): number {
  if (interval === "1m") return 60;
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  if (interval === "30m") return 1800;
  if (interval === "1h") return 3600;
  if (interval === "1d") return 86400;
  return 60;
}

function buildCandles(prices: PricePoint[], interval: string): CandleDatum[] {
  const bucket = bucketSeconds(interval);
  const sorted = [...prices].sort(
    (a, b) => Date.parse(a.timestamp + "Z") - Date.parse(b.timestamp + "Z")
  );

  const map = new Map<number, CandleDatum>();

  for (const p of sorted) {
    const t = Math.floor(Date.parse(p.timestamp + "Z") / 1000);
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucket) * bucket;
    const px = parseFloat(p.price);
    if (!Number.isFinite(px)) continue;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, { time: key, open: px, high: px, low: px, close: px });
    } else {
      existing.high = Math.max(existing.high, px);
      existing.low = Math.min(existing.low, px);
      existing.close = px;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ════════════════════════════════════════════════════════════════════════════
// Dashboard page
// ════════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
  const [latest, setLatest] = useState<LatestPrice | null>(null);
  const [rawPrices, setRawPrices] = useState<PricePoint[]>([]);
  const [chartData, setChartData] = useState<ChartDatum[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [range, setRange] = useState<string>("6h");
  const [interval, setIntervalState] = useState<string>("1m");
  const [chartView, setChartView] = useState<ChartView>("candlestick");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // ── Data fetchers ────────────────────────────────────────────────────────
  const fetchLatest = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/latest`);
      if (r.ok) {
        setLatest(await r.json());
        setConnected(true);
        setLastUpdate(new Date());
      }
    } catch {
      setConnected(false);
    }
  }, []);

  const fetchPrices = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/prices?range=${range}`);
      if (r.ok) {
        const body = await r.json();
        const prices: PricePoint[] = body.prices || [];
        setRawPrices(prices);
        setChartData(
          prices.map((p: PricePoint) => ({
            time: new Date(p.timestamp + "Z").toLocaleTimeString(),
            price: parseFloat(p.price),
          }))
        );
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [range]);

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/stats?range=${range}`);
      if (r.ok) setStats(await r.json());
    } catch {
      /* ignore */
    }
  }, [range]);

  // ── Polling effects ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchLatest();
    fetchPrices();
    fetchStats();
    const t1 = setInterval(fetchLatest, 2000);
    const t2 = setInterval(fetchPrices, 5000);
    const t3 = setInterval(fetchStats, 10000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [fetchLatest, fetchPrices, fetchStats]);

  const change = latest ? parseFloat(latest.price_change_pct) : 0;
  const up = change >= 0;
  const candles = useMemo(() => buildCandles(rawPrices, interval), [rawPrices, interval]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#0b0e11] text-white">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#f0b90b] rounded-full flex items-center justify-center font-bold text-black text-sm">
              B
            </div>
            <h1 className="text-xl font-semibold">Binance BTC Monitor</h1>
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded">
              C++ Backend
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`w-2 h-2 rounded-full animate-pulse ${
                connected ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-sm text-gray-400">
              {connected ? "Connected" : "Disconnected"}
            </span>
            {lastUpdate && (
              <span className="text-xs text-gray-600">
                {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* ── Price hero ───────────────────────────────────────────────── */}
        <section>
          <p className="text-gray-400 text-sm mb-1">BTC / USDT</p>
          {latest ? (
            <div className="flex items-end gap-4">
              <span className="text-5xl font-bold tracking-tight">
                {fmtPrice(latest.price)}
              </span>
              <span
                className={`text-lg font-medium ${
                  up ? "text-green-500" : "text-red-500"
                }`}
              >
                {up ? "▲" : "▼"} {up ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            </div>
          ) : (
            <div className="text-4xl font-bold text-gray-700 animate-pulse">
              Waiting for data…
            </div>
          )}
        </section>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex gap-2 flex-wrap">
              <span className="text-gray-500 text-sm flex items-center mr-1">Range:</span>
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    setRange(r);
                    setLoading(true);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    range === r
                      ? "bg-[#f0b90b] text-black"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {r.toUpperCase()}
                </button>
              ))}
            </div>
            
            {(chartView === "candlestick" || chartView === "both") && (
              <div className="flex gap-2 flex-wrap border-l border-gray-800 pl-4">
                <span className="text-gray-500 text-sm flex items-center mr-1">Candle:</span>
                {INTERVALS.map((i) => (
                  <button
                    key={i}
                    onClick={() => setIntervalState(i)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      interval === i
                        ? "bg-[#f0b90b] text-black"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}
                  >
                    {i}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            {CHART_VIEWS.map((view) => (
              <button
                key={view}
                onClick={() => setChartView(view)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  chartView === view
                    ? "bg-[#f0b90b] text-black"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {view === "line"
                  ? "Line"
                  : view === "candlestick"
                  ? "Candlestick"
                  : "Both"}
              </button>
            ))}
          </div>
        </div>

        {(chartView === "line" || chartView === "both") && (
          <div className="bg-[#1e2329] rounded-xl p-6 border border-gray-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium text-gray-300">Line Chart</h2>
              <span className="text-sm text-gray-500">{chartData.length} points</span>
            </div>

            <div className="h-[400px]">
              {loading ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-600">
                  <div className="animate-spin w-8 h-8 border-2 border-[#f0b90b] border-t-transparent rounded-full mb-3" />
                  Loading chart...
                </div>
              ) : chartData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-gray-600">
                  No data yet - the fetcher is collecting prices...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f0b90b" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#f0b90b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2e35" />
                    <XAxis
                      dataKey="time"
                      stroke="#4a5568"
                      fontSize={12}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      stroke="#4a5568"
                      fontSize={12}
                      tickLine={false}
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) => `$${v.toLocaleString()}`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#1a1d23",
                        border: "1px solid #2a2e35",
                        borderRadius: "8px",
                        color: "#fff",
                      }}
                      formatter={(v: number) => [fmtPrice(v), "Price"]}
                      labelFormatter={(l: string) => `Time: ${l}`}
                    />
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke="#f0b90b"
                      strokeWidth={2}
                      fill="url(#grad)"
                      dot={false}
                      animationDuration={300}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {(chartView === "candlestick" || chartView === "both") && (
          <div className="bg-[#1e2329] rounded-xl p-6 border border-gray-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium text-gray-300">Candlestick</h2>
              <span className="text-sm text-gray-500">{candles.length} candles</span>
            </div>
            <div className="h-[420px]">
              <CandlestickPanel loading={loading} candles={candles} interval={interval} />
            </div>
          </div>
        )}

        {/* ── Stats cards ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Stat
            label="24 H High"
            value={latest ? fmtPrice(latest.high_24h) : "—"}
            accent="text-green-400"
          />
          <Stat
            label="24 H Low"
            value={latest ? fmtPrice(latest.low_24h) : "—"}
            accent="text-red-400"
          />
          <Stat
            label="24 H Volume"
            value={latest ? `${fmtVolume(latest.volume_24h)} BTC` : "—"}
            accent="text-blue-400"
          />
          <Stat
            label="Avg Price"
            value={stats ? fmtPrice(stats.avg_price) : "—"}
            accent="text-purple-400"
          />
          <Stat
            label="Data Points"
            value={stats ? stats.data_points.toLocaleString() : "—"}
            accent="text-yellow-400"
          />
          <Stat
            label="Range High"
            value={stats ? fmtPrice(stats.max_price) : "—"}
            accent="text-emerald-400"
          />
        </div>

        {/* ── Architecture overview ────────────────────────────────────── */}
        <div className="bg-[#1e2329] rounded-xl p-6 border border-gray-800">
          <h3 className="text-lg font-medium text-gray-300 mb-4">
            System Architecture
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Arch
              title="Data Fetcher"
              tech="C++ / websocketpp / libpq"
              desc="Consumes Binance WebSocket ticker stream"
              ok
            />
            <Arch
              title="REST API"
              tech="C++ / cpp-httplib"
              desc="Serves JSON on port 8080"
              ok={connected}
            />
            <Arch
              title="Database"
              tech="PostgreSQL 16"
              desc="Stores historical price ticks"
              ok
            />
            <Arch
              title="Dashboard"
              tech="Next.js / React / Recharts"
              desc="Real-time chart & statistics"
              ok
            />
          </div>
        </div>
      </div>
    </main>
  );
}

function CandlestickPanel({
  candles,
  loading,
  interval,
}: {
  candles: CandleDatum[];
  loading: boolean;
  interval: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "#1e2329" },
        textColor: "#8f9cb3",
      },
      grid: {
        vertLines: { color: "#2b3139", style: 1 },
        horzLines: { color: "#2b3139", style: 1 },
      },
      crosshair: {
        mode: 0, // CrosshairMode.Normal -- easier to control
        vertLine: {
          color: "#8f9cb3",
          width: 1,
          style: 3,
          labelBackgroundColor: "#2b3139",
        },
        horzLine: {
          color: "#8f9cb3",
          width: 1,
          style: 3,
          labelBackgroundColor: "#2b3139",
        },
      },
      rightPriceScale: {
        borderColor: "#2b3139",
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
      },
      timeScale: {
        borderColor: "#2b3139",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 12,
        fixLeftEdge: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#0ecb81",
      downColor: "#f6465d",
      borderVisible: false,
      wickUpColor: "#0ecb81",
      wickDownColor: "#f6465d",
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      chart.applyOptions({ width: container.clientWidth });
    };

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // To avoid resetting user zoom/pan when polling, we track initial load
  const [initializedFor, setInitializedFor] = useState<string>("");

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    const data: CandlestickData[] = candles.map((c) => ({
      time: c.time as CandlestickData["time"],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    seriesRef.current.setData(data);

    if (initializedFor !== interval && data.length > 0) {
      chartRef.current.timeScale().fitContent();
      setInitializedFor(interval);
    }
  }, [candles, interval, initializedFor]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 bg-[#1e2329]/70">
          <div className="animate-spin w-8 h-8 border-2 border-[#f0b90b] border-t-transparent rounded-full mb-3" />
          Loading candlestick...
        </div>
      )}
      {!loading && candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 bg-[#1e2329]/70">
          Not enough data yet to form candles.
        </div>
      )}
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────
function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-[#1e2329] rounded-xl p-4 border border-gray-800">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

// ── Architecture card ──────────────────────────────────────────────────────
function Arch({
  title,
  tech,
  desc,
  ok,
}: {
  title: string;
  tech: string;
  desc: string;
  ok: boolean;
}) {
  return (
    <div className="bg-[#0b0e11] rounded-lg p-4 border border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-medium text-sm">{title}</h4>
        <span
          className={`w-2 h-2 rounded-full ${
            ok ? "bg-green-500" : "bg-red-500"
          }`}
        />
      </div>
      <p className="text-xs text-[#f0b90b] mb-1">{tech}</p>
      <p className="text-xs text-gray-500">{desc}</p>
    </div>
  );
}
