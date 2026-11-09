import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";

// Akvorado live traffic monitor for BUSY Bar 1.3.1+.
// The app calls Akvorado Console (not ClickHouse) directly over Wi-Fi.
const APP = manifest.id;
const WHITE = "#F5F8FFFF";
const CYAN = "#00C8FFFF";
const GREEN = "#37E69BFF";
const VIOLET = "#776BFFFF";
const AMBER = "#FFB547FF";
const MUTED = "#667589FF";
const BLACK = "#000000FF";
const SLOTS = 24;

type Settings = {
  url: string;
  filter: string;
  interval: number;
  windowMinutes: number;
  averageSeconds: number;
  autoRotate: boolean;
  switchSeconds: number;
  showTraffic: boolean;
  showDownl: boolean;
  showUpl: boolean;
  showFlows: boolean;
  showPeak: boolean;
};
type Graph = {
  points?: number[][];
  axis?: number[];
  t?: string[];
};
type Series = { current: number; peak: number; samples: number[] };
const DEFAULTS: Settings = {
  url: "http://akvorado.connesi.it:8081",
  filter: "",
  interval: 5,
  windowMinutes: 5,
  averageSeconds: 30,
  autoRotate: true,
  switchSeconds: 5,
  showTraffic: true,
  showDownl: true,
  showUpl: true,
  showFlows: true,
  showPeak: true,
};
let cfg = DEFAULTS;
let traffic: Series | null = null;
let flows: Series | null = null;
let downl: Series | null = null;
let upl: Series | null = null;
const SCREENS = ["TRAFFIC", "DOWNL", "UPL", "FLOWS", "PEAK"];
let error = "Loading";
let view = 0;
let stopped = false;
let fetching = false;
let drawing = false;
let dirty = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let rotationTimer: ReturnType<typeof setInterval> | undefined;
let unbind: (() => void) | undefined;
let lastUpdated = 0;

function report(e: unknown): void {
  console.error(`${APP}: ${e instanceof Error ? e.message : String(e)}`);
}

async function loadSettings(): Promise<Settings> {
  try {
    const data = await device.AppsSettingsGet({ app_id: APP });
    if (data.version !== 1) return DEFAULTS;
    const v = data.values;
    return {
      url: typeof v.url === "string" && /^https?:\/\//.test(v.url) ? v.url.replace(/\/+$/, "") : DEFAULTS.url,
      filter: typeof v.filter === "string" ? v.filter : DEFAULTS.filter,
      interval: typeof v.interval === "number" ? Math.max(5, Math.min(300, v.interval)) : DEFAULTS.interval,
      windowMinutes: typeof v.window_minutes === "number" ? Math.max(2, Math.min(60, v.window_minutes)) : DEFAULTS.windowMinutes,
      averageSeconds: typeof v.average_seconds === "number" ? Math.max(5, Math.min(120, v.average_seconds)) : DEFAULTS.averageSeconds,
      autoRotate: typeof v.auto_rotate === "boolean" ? v.auto_rotate : DEFAULTS.autoRotate,
      switchSeconds: typeof v.switch_seconds === "number" ? Math.max(1, Math.min(120, v.switch_seconds)) : DEFAULTS.switchSeconds,
      showTraffic: typeof v.show_traffic === "boolean" ? v.show_traffic : DEFAULTS.showTraffic,
      showDownl: typeof v.show_downl === "boolean" ? v.show_downl : DEFAULTS.showDownl,
      showUpl: typeof v.show_upl === "boolean" ? v.show_upl : DEFAULTS.showUpl,
      showFlows: typeof v.show_flows === "boolean" ? v.show_flows : DEFAULTS.showFlows,
      showPeak: typeof v.show_peak === "boolean" ? v.show_peak : DEFAULTS.showPeak,
    };
  } catch (e) {
    report(e);
    return DEFAULTS;
  }
}

// Akvorado v2.3.0 returns points[rowIndex][timeIndex], NOT
// points[timeIndex][rowIndex]. axis[rowIndex] identifies direct (1) vs reverse.
// The final bucket can be empty while collectors/aggregation catch up.
function parseGraph(raw: Graph, averageSeconds: number): Series {
  if (!raw || !Array.isArray(raw.points) || raw.points.length === 0) {
    throw new Error("Invalid graph response: missing points");
  }
  const count = Array.isArray(raw.t) && raw.t.length > 0
    ? raw.t.length
    : Math.max(0, ...raw.points.map((r) => Array.isArray(r) ? r.length : 0));
  if (!count) throw new Error("Invalid graph response: empty series");
  const samples = Array<number>(count).fill(0);
  let rows = 0;
  raw.points.forEach((row, r) => {
    if (!Array.isArray(row) || (raw.axis && raw.axis[r] !== 1)) return;
    rows++;
    for (let i = 0; i < Math.min(count, row.length); i++) {
      const value = Number(row[i]);
      if (Number.isFinite(value) && value > 0) samples[i] += value;
    }
  });
  if (!rows) throw new Error("Invalid graph response: no direct axis");
  // Akvorado often returns one or more incomplete/empty trailing buckets.
  // Anchor the moving average to the most recent populated bucket.
  let lastValid = -1;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i] > 0) { lastValid = i; break; }
  }
  if (lastValid < 0) return { current: 0, peak: 0, samples };
  // Average every completed time bucket in the most recent N seconds. This
  // is independent from the 5-minute historical graph window and is used by
  // both traffic (bps) and flows (fps). Internal/external are summed upstream.
  let first = lastValid;
  if (raw.t && raw.t.length > lastValid) {
    const lastTime = Date.parse(raw.t[lastValid]);
    if (Number.isFinite(lastTime)) {
      const threshold = lastTime - averageSeconds * 1000;
      for (let i = lastValid - 1; i >= 0; i--) {
        const timestamp = Date.parse(raw.t[i]);
        if (!Number.isFinite(timestamp) || timestamp <= threshold) break;
        first = i;
      }
    }
  }
  // Timestamp-free fallback: with 60 points over a 5-minute window, each
  // sample is about 5 seconds wide. Normal responses contain timestamps.
  if (first === lastValid && (!raw.t || raw.t.length <= lastValid)) {
    first = Math.max(0, lastValid - Math.ceil(averageSeconds / 5) + 1);
  }
  let total = 0;
  let valid = 0;
  for (let i = first; i <= lastValid; i++) {
    total += samples[i];
    valid++;
  }
  return {
    current: valid ? total / valid : samples[lastValid],
    peak: Math.max(...samples.slice(0, lastValid + 1)),
    samples: samples.slice(0, lastValid + 1),
  };
}

// A boundary class is selected exactly once per flow. The overall TRAFFIC
// query covers both classes; DOWNL and UPL use their own narrower queries.
// Any user filter is added to each query with AND.
function effectiveFilter(boundary: "both" | "external" | "internal"): string {
  const clause = boundary === "both"
    ? "(InIfBoundary = external OR InIfBoundary = internal)"
    : `(InIfBoundary = ${boundary})`;
  return cfg.filter.trim() ? `(${cfg.filter.trim()}) AND ${clause}` : clause;
}

async function graph(units: "l3bps" | "fps", boundary: "both" | "external" | "internal" = "both"): Promise<Series> {
  const end = new Date();
  const start = new Date(end.getTime() - cfg.windowMinutes * 60000);
  const body = {
    start: start.toISOString(), end: end.toISOString(),
    dimensions: [], limit: 1, limitType: "last", filter: effectiveFilter(boundary),
    units, points: 60, bidirectional: false, "previous-period": false,
  };
  const response = await fetch(cfg.url + "/api/v0/console/graph/line", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Akvorado HTTP ${response.status} (${boundary})`);
  return parseGraph((await response.json()) as Graph, cfg.averageSeconds);
}

function enabledViews(): number[] {
  const flags = [cfg.showTraffic, cfg.showDownl, cfg.showUpl, cfg.showFlows, cfg.showPeak];
  const result: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) result.push(i);
  return result;
}

function advanceView(delta: number): void {
  const enabled = enabledViews();
  if (!enabled.length) return;
  let index = enabled.indexOf(view);
  if (index < 0) index = delta > 0 ? -1 : 0;
  view = enabled[((index + delta) % enabled.length + enabled.length) % enabled.length];
}

async function refresh(): Promise<void> {
  if (stopped || fetching) return;
  fetching = true;
  try {
    // Sequential queries reduce peak RAM use on the BusyBar and ClickHouse.
    // A failed secondary query does not prevent displaying total traffic.
    const total = await graph("l3bps", "both");
    traffic = total;
    error = "";
    lastUpdated = Date.now();
    // Only fetch optional series if their screen is enabled. TRAFFIC/PEAK
    // always use their shared combined query, even if TRAFFIC is hidden.
    if (cfg.showDownl) {
      try { downl = await graph("l3bps", "external"); }
      catch (e) { downl = null; report(e); }
    }
    if (cfg.showUpl) {
      try { upl = await graph("l3bps", "internal"); }
      catch (e) { upl = null; report(e); }
    }
    if (cfg.showFlows) {
      try { flows = await graph("fps", "both"); }
      catch (e) { flows = null; report(e); }
    }
  } catch (e) {
    report(e);
    error = e instanceof Error ? e.message : String(e);
    console.error(`${APP}: refresh failed: ${error}`);
  } finally {
    fetching = false;
    if (!stopped) draw();
  }
}

function shortNumber(v: number, units: string): string {
  if (!isFinite(v)) return "--";
  const scales = [{ k: 1e12, p: "T" }, { k: 1e9, p: "G" }, { k: 1e6, p: "M" }, { k: 1e3, p: "k" }];
  for (const s of scales) if (v >= s.k) {
    const n = v / s.k;
    return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$/, "") + s.p + units;
  }
  return String(Math.round(v)) + units;
}

function rect(id: string, x: number, y: number, width: number, height: number, color: string) {
  return { id, type: "rectangle" as const, x, y, width, height,
    fill: "solid" as const, fill_colors: [color], border_width: 0 };
}
function txt(id: string, value: string, x: number, y: number, color: string) {
  return { id, type: "text" as const, text: value, x, y,
    font: "small" as const, color };
}
function frame() {
  const enabled = enabledViews();
  const title = enabled.length ? SCREENS[view] : "SCREENS";
  const data = view === 1 ? downl : view === 2 ? upl : view === 3 ? flows : traffic;
  const current = view === 4 ? traffic?.peak : data?.current;
  const number = current === undefined ? "--" : shortNumber(current, view === 3 ? "/s" : "b/s");
  const color = view === 1 ? GREEN : view === 2 ? VIOLET : view === 3 ? GREEN : view === 4 ? AMBER : WHITE;
  const message = !enabled.length ? "ALL OFF"
    : !traffic ? (error && error !== "Loading" ? error.slice(0, 19) : "Loading")
    : !data ? "NO DATA" : number;
  const elements: Array<any> = [
    rect("bg", 0, 0, 72, 16, BLACK),
    txt("title", title, 0, -1, view === 1 ? GREEN : view === 2 ? VIOLET : MUTED),
    txt("value", message, 35, -1, error && !traffic ? AMBER : color),
  ];
  const values = enabled.length ? (data?.samples || []) : [];
  const max = Math.max(1, ...values);
  for (let i = 0; i < SLOTS; i++) {
    const start = Math.floor(i * values.length / SLOTS);
    const end = Math.max(start + 1, Math.floor((i + 1) * values.length / SLOTS));
    let v = 0;
    for (let j = start; j < end && j < values.length; j++) v = Math.max(v, values[j]);
    const h = v > 0 ? Math.max(1, Math.round((v / max) * 7)) : 0;
    elements.push(rect("bar" + i, i * 3, 16 - Math.max(1, h), 2, Math.max(1, h), h > 0 ? color : BLACK));
  }
  if (traffic && error && enabled.length) elements[1] = txt("title", "STALE", 0, -1, AMBER);
  return elements;
}
function draw(): void {
  if (stopped) return;
  if (drawing) { dirty = true; return; }
  drawing = true;
  dirty = false;
  const done = () => { drawing = false; if (dirty && !stopped) draw(); };
  device.DisplayDraw({ application_name: APP, priority: 40, elements: frame() })
    .then(done, (e: unknown) => { report(e); done(); });
}
function restartRotation(): void {
  if (rotationTimer !== undefined) {
    clearInterval(rotationTimer);
    rotationTimer = undefined;
  }
  if (stopped || !cfg.autoRotate || enabledViews().length <= 1) return;
  rotationTimer = setInterval(() => {
    if (stopped) return;
    advanceView(1);
    draw();
  }, cfg.switchSeconds * 1000);
}
function main(): void {
  draw();
  const stop = () => {
    stopped = true;
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    if (rotationTimer !== undefined) clearInterval(rotationTimer);
    // BUSY runtime terminates when the last listener is removed.
    setTimeout(() => { if (unbind) unbind(); }, 0);
  };
  unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder" && event.delta) {
      advanceView(event.delta);
      // Reset the auto-rotation countdown after a manual selection.
      restartRotation();
      draw();
    } else if ((event.key === "ok" || event.key === "start") && event.action === "short") {
      void refresh();
    } else if (event.key === "back" && event.action === "short") {
      stop();
    }
  });
  void (async () => {
    cfg = await loadSettings();
    if (stopped) return;
    const initial = enabledViews();
    if (initial.length && initial.indexOf(view) < 0) view = initial[0];
    restartRotation();
    draw();
    await refresh();
    if (!stopped) refreshTimer = setInterval(() => { void refresh(); }, cfg.interval * 1000);
  })();
}
main();
