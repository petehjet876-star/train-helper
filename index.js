// Train display helper — St Peters -> Central
// Calls the TfNSW Trip Planner API, returns a tiny JSON payload the
// MatrixPortal can fetch and draw without any heavy parsing.

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---------------------------------------------------------------
const API_KEY = process.env.TFNSW_API_KEY;     // set this in Railway, never in code
const ORIGIN = "204410";                        // St Peters Station
const DESTINATION = "200060";                   // Central Station
const TRIPS_TO_SHOW = 3;                         // how many to return
const TZ = "Australia/Sydney";
const TP_BASE = "https://api.transport.nsw.gov.au/v1/tp/trip";

// --- Helpers --------------------------------------------------------------

// Current date/time in Sydney as the API wants it: YYYYMMDD + HHMM
function sydneyNowParts() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
  };
}

// ISO timestamp -> "HH:MM" clock time in Sydney
function toClock(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Whole minutes from now until the given ISO timestamp
function minutesFromNow(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

// Build the Trip Planner request URL
function buildUrl() {
  const { date, time } = sydneyNowParts();
  const qs = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: "EPSG:4326",
    depArrMacro: "dep",
    itdDate: date,
    itdTime: time,
    type_origin: "any",
    name_origin: ORIGIN,
    type_destination: "any",
    name_destination: DESTINATION,
    calcNumberOfTrips: "6",   // ask for extra; we filter + trim to 3
    TfNSWTR: "true",          // include real-time data
  });
  return `${TP_BASE}?${qs.toString()}`;
}

// Pull the few fields we care about out of one journey
function simplifyJourney(journey) {
  const legs = journey.legs || [];
  if (legs.length === 0) return null;

  // Departure from St Peters = first leg's origin time (prefer real-time)
  const firstOrigin = legs[0].origin || {};
  const depIso =
    firstOrigin.departureTimeEstimated || firstOrigin.departureTimePlanned;

  // Arrival at Central = last leg's destination time (prefer real-time)
  const lastDest = legs[legs.length - 1].destination || {};
  const arrIso =
    lastDest.arrivalTimeEstimated || lastDest.arrivalTimePlanned;

  if (!depIso || !arrIso) return null;

  // Line label (e.g. "T4") from the first transit leg, if present
  const transitLeg = legs.find((l) => l.transportation);
  const line =
    transitLeg?.transportation?.disassembledName ||
    transitLeg?.transportation?.number ||
    "";

  return {
    depart_min: minutesFromNow(depIso),
    central_time: toClock(arrIso),
    line,
  };
}

// --- Routes ---------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "train-helper", route: "/trains" });
});

app.get("/trains", async (_req, res) => {
  if (!API_KEY) {
    return res.json({ trains: [], error: "TFNSW_API_KEY not set" });
  }

  try {
    const resp = await fetch(buildUrl(), {
      headers: { Authorization: `apikey ${API_KEY}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      return res.json({
        trains: [],
        error: `TfNSW ${resp.status}`,
        detail: body.slice(0, 200),
      });
    }

    const data = await resp.json();
    const journeys = data.journeys || [];

    const trains = journeys
      .map(simplifyJourney)
      .filter((t) => t && t.depart_min >= 0)   // drop already-departed
      .slice(0, TRIPS_TO_SHOW);

    const { time } = sydneyNowParts();
    const updated = `${time.slice(0, 2)}:${time.slice(2)}`;

    res.json({ updated, trains });
  } catch (err) {
    res.json({ trains: [], error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`train-helper listening on ${PORT}`);
});
