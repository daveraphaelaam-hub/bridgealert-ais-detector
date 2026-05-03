'use strict';

require('dotenv').config();

const http = require('http');
const WebSocket = require('ws');
const BRIDGES = require('./bridges');
const { BridgeDetector, STATE } = require('./detector');
const { logEvent, testWrite } = require('./sheets');

// ── Environment validation ────────────────────────────────────────────────────
const AIS_API_KEY = process.env.AIS_API_KEY;
if (!AIS_API_KEY) {
  console.error('FATAL: AIS_API_KEY environment variable is not set.');
  process.exit(1);
}

const AIS_URL = 'wss://stream.aisstream.io/v0/stream';

// Bounding box covering all 5 bridges with margin
const BOUNDING_BOX = [[25.6, -80.4], [25.9, -80.1]];

// ── Vessel type cache (populated from StaticDataReport messages) ──────────────
// MMSI → vessel type code
const vesselTypeCache = new Map();

// ── Build one detector per bridge ─────────────────────────────────────────────
const detectors = BRIDGES.map(
  (bridge) =>
    new BridgeDetector(bridge, async (bridge, prevState, newState, vessel, durationMs) => {
      // Only log meaningful transitions (not OPENING→OPEN when there's no sheet record
      // needed for that intermediate step, but let's log all for full audit trail)
      const vesselDesc = vessel
        ? `${vessel.shipName || 'Unknown'} (MMSI ${vessel.mmsi})`
        : 'unknown vessel';

      console.log(
        `[EVENT] ${bridge.name}: ${prevState} → ${newState} | ` +
          `trigger: ${vesselDesc} | duration: ${(durationMs / 60000).toFixed(1)} min`
      );

      try {
        await logEvent(bridge, prevState, newState, durationMs);
      } catch (err) {
        console.error(`[sheets] Unhandled error logging event: ${err.message}`);
      }
    })
);

// ── Periodic tick for timeout detection ───────────────────────────────────────
setInterval(() => {
  for (const detector of detectors) {
    detector.tick();
  }
}, 30 * 1000);

// ── AIS WebSocket connection ───────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectDelayMs = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

function connect() {
  console.log('[AIS] Connecting to AISstream.io...');
  ws = new WebSocket(AIS_URL);

  ws.on('open', () => {
    console.log('[AIS] Connected. Sending subscription...');
    reconnectDelayMs = 5000; // reset backoff on successful connection

    const subscription = {
      APIkey: AIS_API_KEY,
      BoundingBoxes: [BOUNDING_BOX],
      FilterMessageTypes: ['PositionReport', 'StaticDataReport'],
    };
    ws.send(JSON.stringify(subscription));
    console.log('[AIS] Subscribed. Watching bounding box:', JSON.stringify(BOUNDING_BOX));
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('[AIS] Failed to parse message:', err.message);
      return;
    }

    handleMessage(msg);
  });

  ws.on('error', (err) => {
    console.error('[AIS] WebSocket error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.warn(`[AIS] Disconnected. Code: ${code}, Reason: ${reason || 'none'}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[AIS] Reconnecting in ${reconnectDelayMs / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  // Exponential backoff, capped at 60 seconds
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

function handleMessage(msg) {
  const type = msg.MessageType;
  const meta = msg.MetaData;

  if (!meta) return;

  const mmsi = meta.MMSI;
  const shipName = (meta.ShipName || '').trim();
  const lat = parseFloat(meta.latitude);
  const lon = parseFloat(meta.longitude);

  if (isNaN(lat) || isNaN(lon) || !mmsi) return;

  if (type === 'StaticDataReport') {
    // Cache vessel type for later use in approach detection
    const staticData =
      msg.Message?.StaticDataReport?.StaticDataReportA ||
      msg.Message?.StaticDataReport?.StaticDataReportB;
    if (staticData?.Type != null) {
      vesselTypeCache.set(mmsi, staticData.Type);
    }
    return;
  }

  if (type === 'PositionReport') {
    const posReport = msg.Message?.PositionReport;
    if (!posReport) return;

    const sog = posReport.Sog ?? 0;
    const cog = posReport.Cog ?? 0;
    const navStatus = posReport.NavigationalStatus ?? -1;
    const vesselType = vesselTypeCache.get(mmsi) ?? null;

    // Feed the position to every bridge detector
    for (const detector of detectors) {
      detector.update(mmsi, shipName, lat, lon, sog, cog, navStatus, vesselType);
    }
  }
}

// ── Health check HTTP endpoint ─────────────────────────────────────────────────
// Render/Railway use this to verify the service is alive.
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    const status = {
      ok: true,
      uptime: process.uptime(),
      wsState: ws ? ws.readyState : -1,
      sheetId: process.env.GOOGLE_SHEET_ID || 'NOT SET',
      sheetTab: 'Opening Events',
      bridges: detectors.map((d) => ({
        name: d.bridge.name,
        state: d.state,
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else if (req.url === '/test-write' && req.method === 'GET') {
    testWrite()
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Health check endpoint: http://0.0.0.0:${PORT}/health`);
});

// ── Startup ────────────────────────────────────────────────────────────────────
console.log('=== BridgeAlert AIS Detector starting ===');
console.log(`Monitoring ${BRIDGES.length} bridges:`);
for (const b of BRIDGES) {
  console.log(`  • ${b.name} (${b.lat}, ${b.lon})`);
}
console.log('');

connect();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received. Closing...');
  if (ws) ws.close();
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[shutdown] SIGINT received. Closing...');
  if (ws) ws.close();
  server.close();
  process.exit(0);
});
