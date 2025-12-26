# spending-rules-engine

Minimal setup and usage notes.

## Setup
- Install deps: `npm ci` (or `npm install`)
- Create `.env` in the project root with:
  - `OPEN_EXCHANGE_RATES_APP_ID=<your_app_id>`

## Run
- Dev/watch: `npm run dev`
- Tests: `npm test`

The FX client calls the Open Exchange Rates `/api/latest.json` endpoint and converts amounts locally using the returned `rates`.***