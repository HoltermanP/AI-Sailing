// Route-uitleg via Anthropic Messages API.

import { config } from "./config.js";
import { log } from "./logger.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `Je bent een ervaren zeilnavigator en weather-router die routes uitlegt aan recreatieve en wedstrijdzeilers.

Je krijgt gestructureerde data van een isochronen-berekening (snelste route gegeven wind, stroming, boot-polaire en verboden zones).

Schrijf in het Nederlands, helder en concreet. Gebruik markdown met deze koppen:
## Overzicht
## Waarom niet rechtdoor?
## Wind en opkruisen
## Stroming en golven
## Motor en bootkeuze
## Risico's en beperkingen

Regels:
- Baseer je uitsluitend op de meegeleverde data; verzin geen havens, waypoints of weersituaties.
- Leg de belangrijkste afwegingen uit: omweg vs. directe lijn, tacks, gunstige/tegen stroming, motorgebruik, zones.
- Noem cijfers waar relevant (afstand, omweg %, reistijd, wind, stroom).
- Wees eerlijk over onzekerheden (synthetische polairen, grid-weer, prototype).
- Maximaal ~450 woorden. Geen inleiding zoals "Natuurlijk" of "Hier is".`;

export function isExplainAvailable() {
  return !!config.anthropicApiKey;
}

export async function explainRoute(context) {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is niet geconfigureerd.");
  }

  const userContent = `Leg de gekozen zeilroute uit en welke afwegingen de router heeft gemaakt.

Route-data (JSON):
${JSON.stringify(context, null, 2)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.anthropicTimeoutMs);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: config.anthropicMaxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || data.error?.type || `Anthropic HTTP ${res.status}`;
      throw new Error(msg);
    }

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) throw new Error("Leeg antwoord van Anthropic.");

    log.info("explain_ok", { model: data.model || config.anthropicModel, tokens: data.usage });
    return {
      text,
      model: data.model || config.anthropicModel,
      usage: data.usage || null,
    };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Route-uitleg duurde te lang (timeout).");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
