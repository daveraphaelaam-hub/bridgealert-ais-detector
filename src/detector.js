'use strict';

const { distanceMeters, bearingDegrees, headingDifference } = require('./geo');
const config = require('../config/bridges.json');

// ── Tunable constants (loaded from config/bridges.json) ─────────────────────
const APPROACH_RADIUS_METERS = config.APPROACH_RADIUS_METERS;         // 804m (~0.5mi)
const NEAR_BRIDGE_RADIUS_METERS = config.NEAR_BRIDGE_RADIUS_METERS;   // 100m  — "passed"
const CLOSING_RADIUS_METERS = config.CLOSING_RADIUS_METERS;           // 483m (~0.3mi)
const MIN_APPROACH_SPEED_KNOTS = config.MIN_APPROACH_SPEED_KNOTS;     // 2 kts
const HEADING_TOLERANCE_DEGREES = config.HEADING_TOLERANCE_DEGREES;   // 45°
const POST_PASS_CLOSE_MS = config.POST_PASS_CLOSE_MINUTES * 60 * 1000;
const OPENING_TIMEOUT_MS = config.OPENING_TIMEOUT_MINUTES * 60 * 1000;
const SLOW_HIGH = config.SLOW_APPROACH_SPEED_HIGH_KNOTS;              // 5 kts
const SLOW_LOW = config.SLOW_APPROACH_SPEED_LOW_KNOTS;                // 2 kts
const SLOW_RADIUS = config.SLOW_APPROACH_SPEED_NEAR_METERS;           // 482m (~0.3mi)

// AIS vessel type codes that require drawbridge openings (commercial traffic).
// Exclude 36 (sailing) and 37 (pleasure/recreational).
const COMMERCIAL_TYPES = new Set([
  // Fishing: 30–35, 38–39
  30, 31, 32, 33, 34, 35, 38, 39,
  // Special craft: 50–59 (pilot, SAR, tug, port tender, etc.)
  50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
  // Passenger: 60–69
  60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  // Cargo: 70–79
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
  // Tanker: 80–89
  80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  // Other: 90–99
  90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// Bridge states
const STATE = {
  CLOSED: 'CLOSED',
  OPENING: 'OPENING',
  OPEN: 'OPEN',
};

class BridgeDetector {
  /**
   * @param {object} bridge  - Bridge definition from bridges.js
   * @param {function} onStateChange - Called when bridge state changes:
   *   onStateChange(bridge, prevState, newState, triggerVessel, durationMs)
   */
  constructor(bridge, onStateChange) {
    this.bridge = bridge;
    this.onStateChange = onStateChange;

    this.state = STATE.CLOSED;
    this.stateEnteredAt = Date.now();
    this.triggerVessel = null;   // MMSI that caused the current opening
    this.lastVesselNearAt = null; // last time any vessel was within CLOSING_RADIUS

    // Map of MMSI → vessel tracking record
    this.vessels = new Map();
  }

  /**
   * Process a position report for this bridge.
   * Called by the main detector loop for every AIS position message.
   *
   * @param {number} mmsi
   * @param {string} shipName
   * @param {number} lat
   * @param {number} lon
   * @param {number} sog  - Speed over ground (knots)
   * @param {number} cog  - Course over ground (degrees)
   * @param {number} navStatus
   * @param {number|null} vesselType  - From static data, or null if unknown
   */
  update(mmsi, shipName, lat, lon, sog, cog, navStatus, vesselType) {
    const now = Date.now();
    const dist = distanceMeters(lat, lon, this.bridge.lat, this.bridge.lon);

    // ── Track vessel record ────────────────────────────────────────────────
    let vessel = this.vessels.get(mmsi);
    if (!vessel) {
      vessel = {
        mmsi,
        shipName,
        vesselType,
        prevSog: null,
        firstSeenAt: now,
        closestDist: dist,
        hasPassed: false,
        passedAt: null,
      };
      this.vessels.set(mmsi, vessel);
    }

    const prevSog = vessel.prevSog;
    vessel.prevSog = sog;
    vessel.shipName = shipName;
    if (vesselType !== null) vessel.vesselType = vesselType;
    vessel.closestDist = Math.min(vessel.closestDist, dist);

    // ── Update "last vessel near" timestamp (for closing rule) ────────────
    if (dist <= CLOSING_RADIUS_METERS) {
      this.lastVesselNearAt = now;
    }

    // ── Detect if vessel has passed the bridge ─────────────────────────────
    if (!vessel.hasPassed && dist <= NEAR_BRIDGE_RADIUS_METERS) {
      vessel.hasPassed = true;
      vessel.passedAt = now;

      if (this.state === STATE.OPENING && this.triggerVessel === mmsi) {
        this._transition(STATE.OPEN, vessel);
      }
    }

    // ── Rule 4: Check for closing from OPEN state ─────────────────────────
    if (this.state === STATE.OPEN) {
      const triggerDist = this.triggerVessel === mmsi ? dist : null;
      this._checkClosing(now, triggerDist);
    }

    // ── Only process approach/opening rules when CLOSED ───────────────────
    if (this.state !== STATE.CLOSED) return;

    // ── Rule 1: Approach detection ─────────────────────────────────────────
    if (dist > APPROACH_RADIUS_METERS) {
      this.vessels.delete(mmsi); // out of range, stop tracking
      return;
    }

    if (!this._isApproaching(lat, lon, sog, cog, navStatus)) return;

    // ── Rule 2: Opening inference ──────────────────────────────────────────
    const isCommercial = vessel.vesselType !== null && COMMERCIAL_TYPES.has(vessel.vesselType);
    const isSlowing =
      dist <= SLOW_RADIUS &&
      prevSog !== null &&
      prevSog > SLOW_HIGH &&
      sog >= SLOW_LOW &&
      sog <= SLOW_HIGH;

    if (isCommercial || isSlowing) {
      this.triggerVessel = mmsi;
      this._transition(STATE.OPENING, vessel);
    }
  }

  /**
   * Periodic tick — called every 30 seconds to handle timeouts.
   */
  tick() {
    const now = Date.now();

    if (this.state === STATE.OPENING) {
      // Timeout: if vessel never passed within timeout window, reset
      if (now - this.stateEnteredAt > OPENING_TIMEOUT_MS) {
        console.log(
          `[${this.bridge.name}] OPENING timeout — no vessel passed. Resetting to CLOSED.`
        );
        this._forceClose('timeout');
      }
    }

    if (this.state === STATE.OPEN) {
      this._checkClosing(now, null);
    }
  }

  /**
   * Rule 4: Check whether the bridge should close.
   * @param {number} now          - Current timestamp ms
   * @param {number|null} triggerCurrentDist - Current distance of trigger vessel (if available)
   */
  _checkClosing(now, triggerCurrentDist) {
    const timeSinceVesselNear =
      this.lastVesselNearAt ? now - this.lastVesselNearAt : Infinity;

    const nothingNearby = timeSinceVesselNear >= POST_PASS_CLOSE_MS;

    // Trigger vessel moved >0.5 miles (804m) past the bridge
    const triggerVesselGone =
      triggerCurrentDist !== null &&
      triggerCurrentDist > APPROACH_RADIUS_METERS;

    if (nothingNearby || triggerVesselGone) {
      this._forceClose(nothingNearby ? 'no_vessels_nearby' : 'trigger_vessel_departed');
    }
  }

  _isApproaching(lat, lon, sog, cog, navStatus) {
    if (sog < MIN_APPROACH_SPEED_KNOTS) return false;
    if (navStatus !== 0 && navStatus !== 8) return false;

    const bearingToBridge = bearingDegrees(lat, lon, this.bridge.lat, this.bridge.lon);
    const diff = headingDifference(cog, bearingToBridge);
    return diff <= HEADING_TOLERANCE_DEGREES;
  }

  _transition(newState, vessel) {
    const prevState = this.state;
    const durationMs = Date.now() - this.stateEnteredAt;

    this.state = newState;
    this.stateEnteredAt = Date.now();

    console.log(
      `[${this.bridge.name}] ${prevState} → ${newState} | ` +
        `vessel: ${vessel.shipName || vessel.mmsi} (MMSI ${vessel.mmsi}) | ` +
        `type: ${vessel.vesselType ?? 'unknown'} | ` +
        `prev duration: ${Math.round(durationMs / 1000)}s`
    );

    this.onStateChange(this.bridge, prevState, newState, vessel, durationMs);
  }

  _forceClose(reason) {
    if (this.state === STATE.CLOSED) return;

    const prevState = this.state;
    const durationMs = Date.now() - this.stateEnteredAt;
    const vessel = this.triggerVessel
      ? this.vessels.get(this.triggerVessel)
      : null;

    this.state = STATE.CLOSED;
    this.stateEnteredAt = Date.now();
    this.triggerVessel = null;
    this.vessels.clear();
    this.lastVesselNearAt = null;

    console.log(
      `[${this.bridge.name}] ${prevState} → CLOSED | reason: ${reason} | ` +
        `duration: ${Math.round(durationMs / 1000)}s`
    );

    this.onStateChange(this.bridge, prevState, STATE.CLOSED, vessel, durationMs);
  }
}

module.exports = { BridgeDetector, STATE };
