# Train Display Helper

Tiny Node service for the LED matrix train display. It calls the TfNSW Trip
Planner API for **St Peters (204410) → Central (200060)**, and serves a small
JSON payload the MatrixPortal can fetch directly.

## What it returns

`GET /trains`

```json
{
  "updated": "10:57",
  "trains": [
    { "depart_min": 4,  "central_time": "11:09", "line": "T4" },
    { "depart_min": 12, "central_time": "11:17", "line": "T4" },
    { "depart_min": 19, "central_time": "11:24", "line": "T8" }
  ]
}
```

- `depart_min` — whole minutes until it leaves St Peters (real-time where available)
- `central_time` — clock time it reaches Central, Sydney time
- `line` — line label (bonus; the board can ignore it)

`GET /` is a health check.

## Deploy on Railway

1. Push these files to a GitHub repo (or drag the folder into a new Railway project).
2. In Railway, create a new project from the repo. It auto-detects Node and runs `npm start`.
3. Add an environment variable:
   - **Key:** `TFNSW_API_KEY`
   - **Value:** your TfNSW Open Data API key
4. Deploy. Railway gives you a public URL like `https://train-helper-production.up.railway.app`.
5. Test it: open `https://<your-url>/trains` in a browser — you should see the JSON above.

## Notes

- The API key lives only in Railway's environment variables, never in the code.
- Polling every 30–60s from the board is far under the 60,000-calls/day Bronze quota.
- To change how many trains show, edit `TRIPS_TO_SHOW` in `index.js`.
