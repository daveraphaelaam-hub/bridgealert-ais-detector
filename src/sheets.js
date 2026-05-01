'use strict';

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Opening Events';

// Retry queue for failed writes
const retryQueue = [];
let isRetrying = false;

function getAuth() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) {
    throw new Error('GOOGLE_CREDENTIALS environment variable is not set.');
  }
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM:SS" in UTC.
 */
function formatTimestamp(d) {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Build the row array for the Opening Events sheet.
 *
 * Columns:
 * Timestamp | Bridge Name | FL511 Name | Previous Status | New Status |
 * Duration (min) | Day of Week | Time of Day | County | Source
 */
function buildRow(bridge, prevState, newState, durationMs) {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = days[now.getUTCDay()];

  const hours = now.getUTCHours();
  let timeOfDay;
  if (hours >= 5 && hours < 12) timeOfDay = 'Morning';
  else if (hours >= 12 && hours < 17) timeOfDay = 'Afternoon';
  else if (hours >= 17 && hours < 21) timeOfDay = 'Evening';
  else timeOfDay = 'Night';

  const durationMin = durationMs > 0 ? (durationMs / 60000).toFixed(1) : '';

  return [
    formatTimestamp(now),
    bridge.name,
    bridge.fl511Name,
    prevState,
    newState,
    durationMin,
    dayOfWeek,
    timeOfDay,
    bridge.county,
    'AIS',
  ];
}

/**
 * Append a state-change event to the Google Sheet.
 * If the write fails, the row is queued for retry.
 */
async function logEvent(bridge, prevState, newState, durationMs) {
  const row = buildRow(bridge, prevState, newState, durationMs);
  await appendRow(row);
}

async function appendRow(row) {
  if (!SPREADSHEET_ID) {
    console.warn('[sheets] GOOGLE_SHEET_ID not set — skipping write. Row:', row);
    return;
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    const updatedRange = response.data.updates?.updatedRange || 'unknown range';
    console.log(`[sheets] Row written to: ${updatedRange} | ${row[0]} | ${row[1]} | ${row[3]} → ${row[4]}`);
    return { ok: true, updatedRange };
  } catch (err) {
    console.error(`[sheets] Write failed. Error: ${err.message}`, err.response?.data || '');
    retryQueue.push(row);
    scheduleRetry();
    return { ok: false, error: err.message, detail: err.response?.data };
  }
}

/**
 * Write a single test row and return the result.
 * Used by the /test-write HTTP endpoint to diagnose sheet issues.
 */
async function testWrite() {
  const row = [
    formatTimestamp(new Date()),
    'TEST - BridgeAlert AIS Detector',
    'AIS DETECTED',
    'CLOSED',
    'OPEN',
    '1.0',
    'Thursday',
    'Morning',
    'Miami-Dade',
    'AIS',
  ];
  return appendRow(row);
}

function scheduleRetry() {
  if (isRetrying) return;
  isRetrying = true;
  setTimeout(async () => {
    console.log(`[sheets] Retrying ${retryQueue.length} queued row(s)...`);
    const pending = retryQueue.splice(0);
    for (const row of pending) {
      try {
        await appendRow(row);
      } catch {
        retryQueue.unshift(row); // put it back at front
        console.error('[sheets] Retry failed — will try again in 5 minutes.');
        break;
      }
    }
    isRetrying = false;
    if (retryQueue.length > 0) {
      setTimeout(scheduleRetry, 5 * 60 * 1000);
    }
  }, 30 * 1000);
}

module.exports = { logEvent, testWrite };
