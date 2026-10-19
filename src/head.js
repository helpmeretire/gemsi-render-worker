// Geocoding & Weather — paid (x402) geocoding, reverse geocoding and weather for AI agents.
// Three routes, each $0.002 USDC on Base per successful call: /geocode (place text -> coordinates + address),
// /reverse (coordinates -> address) and /weather (current conditions + 7-day forecast for coordinates or a place name).
// Data: OpenStreetMap Nominatim (geocoding) and Open-Meteo (weather). No API keys, no rate limits for callers.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "2000"; // $0.002 in USDC (6 decimals), same for every route
const PRICE_USD = "0.002000";
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "Geocoding & Weather";
const DESCRIPTION =
  "Cheap geocoding, reverse geocoding and weather for AI agents, paid per call in USDC on Base via x402: /geocode turns a place name or address into coordinates and a structured address, /reverse turns coordinates into an address, /weather returns current conditions and a 7-day forecast for coordinates or a place name. Data from OpenStreetMap Nominatim (ODbL, attribution required) and Open-Meteo (CC BY 4.0). You are only charged when a result is returned.";

const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";
const UPSTREAM_UA = "NoJunk Geo/1.0 (+https://nojunkcrypto.com; hello@nojunkcrypto.com)"; // Nominatim policy: identify yourself
const TIMEOUT_MS = 6000; // each upstream fetch must finish within this
const GEO_CACHE_TTL_S = 24 * 3600; // Nominatim results cached 24 h (their policy asks for caching; max 1 request/second)
const WEATHER_CACHE_TTL_S = 600; // Open-Meteo forecasts cached 10 min
const MAX_Q_CHARS = 200;
const MAX_LIMIT = 5;
const DEFAULT_LIMIT = 1;
const MIN_ZOOM = 3, MAX_ZOOM = 18, DEFAULT_ZOOM = 18;
const FORECAST_DAYS = 7;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413

const NOMINATIM_SOURCE = "OpenStreetMap Nominatim";
const NOMINATIM_ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL";
const OPEN_METEO_SOURCE = "Open-Meteo";
const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)";

// Free operator probe (/health/data) geocodes this place and fetches one forecast.
const HEALTH_Q = "Sunrise, Florida";
const HEALTH_FALLBACK = { lat: 26.1670, lon: -80.2567 }; // used for the forecast probe if the geocode probe fails

const ROUTES = {
  "/geocode": { name: "geocode" },
  "/reverse": { name: "reverse" },
  "/weather": { name: "weather" },
};

// WMO weather interpretation codes -> plain text
const WMO = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog",
  51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Rain", 63: "Rain", 65: "Rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Snow", 73: "Snow", 75: "Snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Rain showers", 85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};
