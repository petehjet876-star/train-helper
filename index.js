// Train + shoot display helper
// -----------------------------------------------------------------------
// Two jobs:
//   1. /trains  - next 3 trains St Peters -> Central (TfNSW Trip Planner)
//   2. /display - the board's main endpoint. Decides each request whether
//                 to show an upcoming shoot ("leave by" times, tolls vs
//                 no-tolls) or fall back to trains.
// The board just fetches /display and draws whatever mode comes back.
//
// Secrets all come from Railway env vars, never from code:
//   TFNSW_API_KEY           - TfNSW Trip Planner key (existing)
//   MAPS_API_KEY            - Google Maps "Routes API" key
//   HOME_ORIGIN            - address to measure drive time from
//   CALENDAR_IDS           - comma-separated Google calendar IDs
//   GOOGLE_SERVICE_ACCOUNT - the whole service-account JSON, pasted in

import express from "express";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---------------------------------------------------------------
const API_KEY = process.env.TFNSW_API_KEY;
const MAPS_KEY = process.env.MAPS_API_KEY;
const HOME_ORIGIN = process.env.HOME_ORIGIN;
const CALENDAR_IDS = (process.env.CALENDAR_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let SERVICE_ACCOUNT = null;
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "null");
} catch (e) {
  console.error("GOOGLE_SERVICE_ACCOUNT is not valid JSON:", e.message);
}

const ORIGIN = "204410"; // St Peters Station (trains)
const DESTINATION = "200060"; // Central Station
const TRIPS_TO_SHOW = 3;
const TZ = "Australia/Sydney";
const TP_BASE = "https://api.transport.nsw.gov.au/v1/tp/trip";

// Event display tuning (all in minutes / hours)
const LOCATED_LEAD_MIN = 120; // show a located shoot this long before leave-by
const NAMEONLY_LEAD_MIN = 60; // show a name-only event this long before start
const GRACE_MIN = 20; // keep showing this long after leave-by/start passes
const LOOKAHEAD_HOURS = 6; // how far ahead to read calendar events
const MAX_PLAUSIBLE_DRIVE_MIN = 150; // don't spend a Routes call on far events

// --- Time helpers ---------------------------------------------------------

// Current date/time in Sydney as the TfNSW API wants it: YYYYMMDD + HHMM
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

// Seconds since Sydney midnight (0-86399), for the board's clock
function sydneyDaySeconds() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second);
}

// Sydney date as YYYY-MM-DD (for matching all-day events to "today")
function sydneyDateStr(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// A Date -> "H:MM" Sydney clock time, no AM/PM (to save panel space)
function toClockDate(d) {
  const s = d.toLocaleTimeString("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  });
  return s.replace(/\s?[AP]M$/i, "");
}

function toClock(iso) {
  return toClockDate(new Date(iso));
}

function minutesFromNow(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

// --- Trains (unchanged logic, just refactored into a function) ------------

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
    calcNumberOfTrips: "10",
    TfNSWTR: "true",
  });
  return `${TP_BASE}?${qs.toString()}`;
}

function isTrain(leg) {
  const t = leg.transportation || {};
  const cls = t.product && t.product.class;
  if (cls === 1) return true;
  if (cls !== undefined) return false;
  const name = (t.disassembledName || t.number || "").toUpperCase();
  return /^T\d/.test(name);
}

function simplifyJourney(journey) {
  const legs = journey.legs || [];
  const transitLegs = legs.filter((l) => l.transportation);
  if (transitLegs.length === 0) return null;

  const firstTransit = transitLegs[0];
  if (!isTrain(firstTransit)) return null;

  const dep = firstTransit.origin || {};
  const depIso = dep.departureTimeEstimated || dep.departureTimePlanned;

  const lastDest = legs[legs.length - 1].destination || {};
  const arrIso = lastDest.arrivalTimeEstimated || lastDest.arrivalTimePlanned;

  if (!depIso || !arrIso) return null;

  const t = firstTransit.transportation || {};
  const line = t.disassembledName || t.number || "";

  return {
    depart_min: minutesFromNow(depIso),
    central_time: toClock(arrIso),
    line,
  };
}

async function getTrains() {
  if (!API_KEY) return { trains: [], error: "TFNSW_API_KEY not set" };
  const resp = await fetch(buildUrl(), {
    headers: { Authorization: `apikey ${API_KEY}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    return { trains: [], error: `TfNSW ${resp.status}`, detail: body.slice(0, 200) };
  }
  const data = await resp.json();
  const journeys = data.journeys || [];
  const trains = journeys
    .map(simplifyJourney)
    .filter((t) => t && t.depart_min >= 0)
    .slice(0, TRIPS_TO_SHOW);
  return { trains };
}

// --- Calendar -------------------------------------------------------------

function calendarClient() {
  if (!SERVICE_ACCOUNT) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  return google.calendar({ version: "v3", auth });
}

// Pull upcoming events from all configured calendars, merged + sorted.
async function getUpcomingEvents() {
  const cal = calendarClient();
  if (!cal || CALENDAR_IDS.length === 0) return [];

  const now = new Date();
  const timeMax = new Date(now.getTime() + LOOKAHEAD_HOURS * 3600 * 1000);
  const all = [];

  for (const id of CALENDAR_IDS) {
    try {
      const resp = await cal.events.list({
        calendarId: id,
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 10,
      });
      for (const ev of resp.data.items || []) {
        const timed = !!(ev.start && ev.start.dateTime);
        all.push({
          id: ev.id,
          name: ev.summary || "(no title)",
          location: (ev.location || "").trim(),
          allDay: !timed,
          dateStr: timed ? null : (ev.start && ev.start.date) || null,
          startMs: timed ? new Date(ev.start.dateTime).getTime() : null,
        });
      }
    } catch (e) {
      console.error(`Calendar ${id} read failed:`, e.message);
    }
  }

  // Sort timed events by start; all-day events sort last (no startMs).
  all.sort((a, b) => (a.startMs || Infinity) - (b.startMs || Infinity));
  return all;
}

// --- Drive time (Google Routes API) with a small cache --------------------

const routeCache = new Map(); // eventId -> { at, data }
const ROUTE_TTL_MS = 10 * 60 * 1000;

async function callRoutes(destination, avoidTolls, withTolls) {
  const body = {
    origin: { address: HOME_ORIGIN },
    destination: { address: destination },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date(Date.now() + 60000).toISOString(),
    routeModifiers: { avoidTolls },
  };
  if (withTolls) body.extraComputations = ["TOLLS"];

  const fieldMask = withTolls
    ? "routes.duration,routes.travelAdvisory.tollInfo"
    : "routes.duration";

  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": MAPS_KEY,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`Routes ${r.status}: ${(await r.text()).slice(0, 150)}`);
  }
  return r.json();
}

// Returns { driveTolls, driveNoTolls, tollText } in minutes, or null.
async function computeRoute(destination) {
  if (!MAPS_KEY || !HOME_ORIGIN || !destination) return null;

  const tollsResp = await callRoutes(destination, false, true);
  const noTollsResp = await callRoutes(destination, true, false);

  const tollRoute = tollsResp.routes && tollsResp.routes[0];
  const noTollRoute = noTollsResp.routes && noTollsResp.routes[0];
  if (!tollRoute || !noTollRoute) return null;

  const driveTolls = Math.round(parseInt(tollRoute.duration) / 60);
  const driveNoTolls = Math.round(parseInt(noTollRoute.duration) / 60);

  let tollText = "";
  const price =
    tollRoute.travelAdvisory &&
    tollRoute.travelAdvisory.tollInfo &&
    tollRoute.travelAdvisory.tollInfo.estimatedPrice &&
    tollRoute.travelAdvisory.tollInfo.estimatedPrice[0];
  if (price) {
    const amount = parseInt(price.units || "0") + (price.nanos || 0) / 1e9;
    tollText = amount.toFixed(2);
  }

  return { driveTolls, driveNoTolls, tollText };
}

async function routeFor(ev) {
  const cached = routeCache.get(ev.id);
  if (cached && Date.now() - cached.at < ROUTE_TTL_MS) return cached.data;
  const data = await computeRoute(ev.location);
  routeCache.set(ev.id, { at: Date.now(), data });
  return data;
}

// --- Decision cascade -----------------------------------------------------

async function getDisplayPayload() {
  const { time } = sydneyNowParts();
  const base = {
    updated: `${time.slice(0, 2)}:${time.slice(2)}`,
    day_seconds: sydneyDaySeconds(),
  };

  let events = [];
  try {
    events = await getUpcomingEvents();
  } catch (e) {
    console.error("events error:", e.message);
  }

  const now = Date.now();
  const todaySyd = sydneyDateStr(new Date());
  let located = null;
  let nameOnly = null;

  for (const ev of events) {
    // Located, timed event -> try to compute drive time / leave-by
    if (ev.location && !ev.allDay && ev.startMs) {
      const minsToStart = (ev.startMs - now) / 60000;
      let route = null;
      if (minsToStart <= LOCATED_LEAD_MIN + MAX_PLAUSIBLE_DRIVE_MIN) {
        try {
          route = await routeFor(ev);
        } catch (e) {
          console.error("route error:", e.message);
        }
      }

      if (route) {
        const leaveTollsMs = ev.startMs - route.driveTolls * 60000;
        const leaveNoTollsMs = ev.startMs - route.driveNoTolls * 60000;
        const minsToLeave = (leaveTollsMs - now) / 60000;
        if (minsToLeave <= LOCATED_LEAD_MIN && minsToLeave >= -GRACE_MIN) {
          located = {
            name: ev.name,
            has_route: true,
            start_time: toClockDate(new Date(ev.startMs)),
            leave_tolls: toClockDate(new Date(leaveTollsMs)),
            leave_notolls: toClockDate(new Date(leaveNoTollsMs)),
            leave_tolls_min: Math.round((leaveTollsMs - now) / 60000),
            leave_notolls_min: Math.round((leaveNoTollsMs - now) / 60000),
            drive_tolls_min: route.driveTolls,
            drive_notolls_min: route.driveNoTolls,
            toll_cost: route.tollText,
          };
          break; // located always wins - stop looking
        }
      } else if (minsToStart <= NAMEONLY_LEAD_MIN && minsToStart >= -GRACE_MIN) {
        // routing failed -> at least show it as a name-only reminder
        if (!nameOnly) {
          nameOnly = {
            name: ev.name,
            has_route: false,
            start_time: toClockDate(new Date(ev.startMs)),
          };
        }
      }
      continue;
    }

    // All-day event from your own calendars -> name-only, active today
    if (ev.allDay) {
      if (ev.dateStr === todaySyd && !nameOnly) {
        nameOnly = { name: ev.name, has_route: false, start_time: "" };
      }
      continue;
    }

    // Timed, no location -> name-only reminder 60 min before start
    if (ev.startMs) {
      const minsToStart = (ev.startMs - now) / 60000;
      if (minsToStart <= NAMEONLY_LEAD_MIN && minsToStart >= -GRACE_MIN && !nameOnly) {
        nameOnly = {
          name: ev.name,
          has_route: false,
          start_time: toClockDate(new Date(ev.startMs)),
        };
      }
    }
  }

  if (located) return { mode: "event", ...base, event: located };
  if (nameOnly) return { mode: "event", ...base, event: nameOnly };

  const tr = await getTrains();
  return {
    mode: "trains",
    ...base,
    trains: tr.trains,
    ...(tr.error ? { error: tr.error } : {}),
  };
}

// --- Routes ---------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "train-helper", routes: ["/trains", "/display"] });
});

// Kept for testing - pure trains, same shape as before
app.get("/trains", async (_req, res) => {
  try {
    const { time } = sydneyNowParts();
    const tr = await getTrains();
    res.json({
      updated: `${time.slice(0, 2)}:${time.slice(2)}`,
      day_seconds: sydneyDaySeconds(),
      trains: tr.trains,
      ...(tr.error ? { error: tr.error } : {}),
    });
  } catch (err) {
    res.json({ trains: [], error: String(err) });
  }
});

// The board's main endpoint - event mode or train mode
app.get("/display", async (_req, res) => {
  try {
    res.json(await getDisplayPayload());
  } catch (err) {
    // Last-resort fallback so the board always gets something sane
    const { time } = sydneyNowParts();
    res.json({
      mode: "trains",
      updated: `${time.slice(0, 2)}:${time.slice(2)}`,
      day_seconds: sydneyDaySeconds(),
      trains: [],
      error: String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`train-helper listening on ${PORT}`);
});
