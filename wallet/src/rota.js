// =====================================================================
// BRLS — Distância e tempo PELA RUA (para o preço sugerido da corrida)
// Usa o serviço público de rotas do OSRM (decisão do dono, 26/11/2026). Se ele não responder em 8 s,
// o app NÃO para: usa a linha reta × 1,35 (fator médio de ruas urbanas) e avisa que é uma estimativa.
// Só o par de pontos vai ao serviço; no APK passa pela ponte da Caixa Forte (Tor).
// =====================================================================
import { distanciaKm } from "./corrida.js";

export const SERVIDORES_ROTA = ["https://router.project-osrm.org"];
const FATOR_RUA = 1.35;
const KMH_ESTIMADO = 24;

const comPrazo = (p, ms) => Promise.race([p, new Promise((_, n) => setTimeout(() => n(new Error("tempo")), ms))]);

/** Estimativa sem internet: linha reta × fator de ruas. */
export function rotaEstimada(a, b) {
  const km = distanciaKm(a, b) * FATOR_RUA;
  return { km, min: (km / KMH_ESTIMADO) * 60, fonte: "estimativa" };
}

/** { km, min, fonte: "rua" | "estimativa" } — nunca falha. */
export async function rotaPelaRua(a, b) {
  const c = (p) => `${Number(p.lon).toFixed(6)},${Number(p.lat).toFixed(6)}`;
  for (const s of SERVIDORES_ROTA) {
    try {
      const r = await comPrazo(fetch(`${s}/route/v1/driving/${c(a)};${c(b)}?overview=false&alternatives=false&steps=false`, { headers: { accept: "application/json" } }), 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const rota = j?.routes?.[0];
      if (j?.code === "Ok" && rota && Number.isFinite(rota.distance) && rota.distance > 0) {
        return { km: rota.distance / 1000, min: rota.duration / 60, fonte: "rua" };
      }
    } catch { /* próximo / estimativa */ }
  }
  return rotaEstimada(a, b);
}
