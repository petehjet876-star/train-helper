// Train + shoot display helper
// -----------------------------------------------------------------------
//   /trains  - next 3 trains St Peters -> Central (TfNSW Trip Planner)
//   /display - the board's main endpoint (event mode or train mode)
//   /debug   - temporary diagnostic (safe to remove later)
//
// Env vars (all set in Railway, never in code):
//   TFNSW_API_KEY, MAPS_API_KEY, HOME_ORIGIN,
//   CALENDAR_IDS, GOOGLE_SERVICE_ACCOUNT

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
// Pennant Hills station (nearest to uni) as coordinates "lng:lat:EPSG:4326"
const UNI_STATION_COORD = "151.0725:-33.7383:EPSG:4326";
const TRIPS_TO_SHOW = 3;
const TZ = "Australia/Sydney";
const TP_BASE = "https://api.transport.nsw.gov.au/v1/tp/trip";

// Event display tuning (minutes / hours)
const LOCATED_LEAD_MIN = 120;
const NAMEONLY_LEAD_MIN = 60;
const GRACE_MIN = 20;
const LOOKAHEAD_HOURS = 6;
const MAX_PLAUSIBLE_DRIVE_MIN = 150;
const DRIVE_BUFFER_MIN = 5; // show leave-by this many minutes earlier (Maps runs a bit optimistic)

// --- Time helpers ---------------------------------------------------------

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

function sydneyDaySeconds() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second);
}

function sydneyDateStr(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

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

// --- Trains ---------------------------------------------------------------

function buildTripUrl(destType, destName, numTrips) {
  const { date, time } = sydneyNowParts();
  const qs = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: "EPSG:4326",
    depArrMacro: "dep",
    itdDate: date,
    itdTime: time,
    type_origin: "any",
    name_origin: ORIGIN,
    type_destination: destType,
    name_destination: destName,
    calcNumberOfTrips: String(numTrips),
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
  const resp = await fetch(buildTripUrl("any", DESTINATION, 10), {
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

// Uni train: St Peters -> Pennant Hills, soonest journey, depart + arrive.
function simplifyUniJourney(journey) {
  const legs = journey.legs || [];
  const transitLegs = legs.filter((l) => l.transportation);
  if (transitLegs.length === 0) return null;

  const firstTransit = transitLegs[0];
  if (!isTrain(firstTransit)) return null;

  const dep = firstTransit.origin || {};
  const depIso = dep.departureTimeEstimated || dep.departureTimePlanned;

  const lastTransit = transitLegs[transitLegs.length - 1];
  const arrDest = lastTransit.destination || {};
  const arrIso = arrDest.arrivalTimeEstimated || arrDest.arrivalTimePlanned;

  if (!depIso || !arrIso) return null;

  return {
    depart_min: minutesFromNow(depIso),
    depart_time: toClock(depIso),
    arrive_time: toClock(arrIso),
  };
}

async function getUniTrain() {
  if (!API_KEY) return null;
  const resp = await fetch(buildTripUrl("coord", UNI_STATION_COORD, 6), {
    headers: { Authorization: `apikey ${API_KEY}` },
  });
  if (!resp.ok) throw new Error(`TfNSW uni ${resp.status}`);
  const data = await resp.json();
  const journeys = data.journeys || [];
  const list = journeys
    .map(simplifyUniJourney)
    .filter((t) => t && t.depart_min >= 0);
  return list[0] || null;
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
          location: (ev.location || "").replace(/\s+/g, " ").trim(),
          allDay: !timed,
          dateStr: timed ? null : (ev.start && ev.start.date) || null,
          startMs: timed ? new Date(ev.start.dateTime).getTime() : null,
        });
      }
    } catch (e) {
      console.error(`Calendar ${id} read failed:`, e.message);
    }
  }

  all.sort((a, b) => (a.startMs || Infinity) - (b.startMs || Infinity));
  return all;
}

// Is this event at uni? (matches the Excelsia address)
function isUni(location) {
  return /cityview|excelsia/i.test(location || "");
}

// --- Drive time (Google Routes API) with a small cache --------------------

const routeCache = new Map();
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
        const uni = isUni(ev.location);
        // leave-by times, with the 5-min buffer baked in
        const leaveTollsMs = ev.startMs - (route.driveTolls + DRIVE_BUFFER_MIN) * 60000;
        const leaveNoTollsMs = ev.startMs - (route.driveNoTolls + DRIVE_BUFFER_MIN) * 60000;
        // window reference: no-tolls for uni (drive option shown), tolls otherwise
        const refLeaveMs = uni ? leaveNoTollsMs : leaveTollsMs;
        const minsToLeave = (refLeaveMs - now) / 60000;

        if (minsToLeave <= LOCATED_LEAD_MIN && minsToLeave >= -GRACE_MIN) {
          if (uni) {
            let train = null;
            try {
              train = await getUniTrain();
            } catch (e) {
              console.error("uni train error:", e.message);
            }
            located = {
              name: ev.name,
              has_route: true,
              is_uni: true,
              start_time: toClockDate(new Date(ev.startMs)),
              leave_notolls: toClockDate(new Date(leaveNoTollsMs)),
              leave_notolls_min: Math.round((leaveNoTollsMs - now) / 60000),
              drive_notolls_min: route.driveNoTolls,
            };
            if (train) {
              located.train_depart = train.depart_time;
              located.train_arrive = train.arrive_time;
              located.train_depart_min = train.depart_min;
            }
          } else {
            located = {
              name: ev.name,
              has_route: true,
              is_uni: false,
              start_time: toClockDate(new Date(ev.startMs)),
              leave_tolls: toClockDate(new Date(leaveTollsMs)),
              leave_notolls: toClockDate(new Date(leaveNoTollsMs)),
              leave_tolls_min: Math.round((leaveTollsMs - now) / 60000),
              leave_notolls_min: Math.round((leaveNoTollsMs - now) / 60000),
              drive_tolls_min: route.driveTolls,
              drive_notolls_min: route.driveNoTolls,
              toll_cost: route.tollText,
            };
          }
          break;
        }
      } else if (minsToStart <= NAMEONLY_LEAD_MIN && minsToStart >= -GRACE_MIN) {
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

    if (ev.allDay) {
      if (ev.dateStr === todaySyd && !nameOnly) {
        nameOnly = { name: ev.name, has_route: false, start_time: "" };
      }
      continue;
    }

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
  res.json({ ok: true, service: "train-helper", routes: ["/trains", "/display", "/debug"] });
});

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

app.get("/display", async (_req, res) => {
  try {
    res.json(await getDisplayPayload());
  } catch (err) {
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

// Temporary diagnostic - safe to delete once everything works.
app.get("/debug", async (_req, res) => {
  const out = {
    has_service_account: !!SERVICE_ACCOUNT,
    has_maps_key: !!MAPS_KEY,
    has_home_origin: !!HOME_ORIGIN,
    calendars_configured: CALENDAR_IDS.length,
    calendar_ids: CALENDAR_IDS,
  };
  try {
    const events = await getUpcomingEvents();
    out.events_found = events.length;
    out.events = events.map((e) => ({
      name: e.name,
      location: e.location,
      is_uni: isUni(e.location),
      allDay: e.allDay,
      start: e.startMs ? new Date(e.startMs).toISOString() : e.dateStr,
    }));
  } catch (err) {
    out.error = String(err);
  }
  res.json(out);
});

// Uni train test endpoint - hit /uni-test to check the Pennant Hills lookup.
app.get("/uni-test", async (_req, res) => {
  try {
    const train = await getUniTrain();
    res.json({ train });
  } catch (err) {
    res.json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`train-helper listening on ${PORT}`);
});
