// Centrale configuratie uit environment-variabelen, met defaults en boot-validatie.
// Er zijn GEEN verplichte secrets (Open-Meteo werkt zonder key); API_KEY is optioneel
// en beschermt het zware /api/route-endpoint alleen als je hem zet.

function num(name, def) {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} moet een getal zijn, kreeg "${v}"`);
  return n;
}

export const config = {
  port: num("PORT", 3000),
  // Forecast-cache (in-memory): hoe lang een opgehaald veld hergebruikt mag worden.
  cacheTtlMs: num("FORECAST_CACHE_TTL_MS", 30 * 60 * 1000), // 30 min
  cacheMaxEntries: num("FORECAST_CACHE_MAX", 50),
  // Rate limiting op /api/route per IP.
  rateMax: num("RATE_LIMIT_MAX", 30),
  rateWindowMs: num("RATE_LIMIT_WINDOW_MS", 60 * 1000),
  // Optionele beveiliging: als gezet, vereist /api/route header "x-api-key".
  apiKey: process.env.API_KEY || null,
  // Solver-plafonds (DoS-bescherming tegen extreem grote gebieden).
  maxRouteNM: num("MAX_ROUTE_NM", 1500),
  logLevel: process.env.LOG_LEVEL || "info",
  // Anthropic — route-uitleg (optioneel; zonder key is /api/explain uitgeschakeld).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
  anthropicMaxTokens: num("ANTHROPIC_MAX_TOKENS", 1200),
  anthropicTimeoutMs: num("ANTHROPIC_TIMEOUT_MS", 45000),
};

// Boot-validatie: faal snel en duidelijk bij onzinnige configuratie.
export function validateConfig() {
  const problems = [];
  if (config.port < 1 || config.port > 65535) problems.push("PORT buiten bereik 1-65535");
  if (config.cacheTtlMs < 0) problems.push("FORECAST_CACHE_TTL_MS mag niet negatief zijn");
  if (config.rateMax < 1) problems.push("RATE_LIMIT_MAX moet >= 1 zijn");
  if (config.anthropicMaxTokens < 256) problems.push("ANTHROPIC_MAX_TOKENS moet >= 256 zijn");
  if (config.anthropicTimeoutMs < 5000) problems.push("ANTHROPIC_TIMEOUT_MS moet >= 5000 zijn");
  if (problems.length) {
    throw new Error("Ongeldige configuratie:\n - " + problems.join("\n - "));
  }
  return config;
}
