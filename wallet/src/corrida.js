// =====================================================================
// BRLS — Corrida no modelo da 99 (sem contrato novo)
// Uma corrida é um trabalho PRESENCIAL do EscrowTrabalho, com vaga aberta (ou direto para um favorito):
//   1. O passageiro marca embarque e destino no mapa. O app mede a distância PELA RUA (rota.js) e
//      sugere o preço de cada categoria (tarifas editáveis). O passageiro escolhe uma ou várias categorias
//      e pode mudar o preço. O valor fica travado no contrato (anticalote).
//   2. Em público vão só: bairros, o ponto de embarque ARREDONDADO (~1 km, para o motorista ver a distância),
//      a distância e o tempo da viagem, categorias, Expresso e horário agendado.
//   3. Motoristas online veem a distância até o embarque, o valor e o R$/km; aceitam ou fazem contraproposta.
//   4. O endereço exato vai cifrado só ao motorista aprovado. Na viagem, a posição do motorista vai cifrada
//      ao passageiro. No destino, o código paga o motorista.
// O GPS nunca é prova de nada — a prova é o código.
// =====================================================================

/** Categorias (como 99Moto / 99Pop / 99Plus). */
export const VEICULOS = {
  moto: { id: "moto", icone: "🏍️", nome: "Moto", maxPessoas: 1, kmh: 28 },
  pop: { id: "pop", icone: "🚗", nome: "Pop", maxPessoas: 4, kmh: 24 },
  plus: { id: "plus", icone: "🚙", nome: "Plus", maxPessoas: 4, kmh: 24 },
};
const POR_ICONE = { "🏍️": "moto", "🏍": "moto", "🚗": "pop", "🚙": "plus" };
// Compatibilidade com pedidos antigos ("carro")
VEICULOS.carro = VEICULOS.pop;

/** Validade do pedido (o contrato devolve o dinheiro ao passageiro se ninguém fizer a corrida até lá). */
export const VALIDADES_HORAS = [1, 2, 4];

// ---------- Tarifas sugeridas (o passageiro sempre pode mudar o preço) ----------
export const TARIFAS_PADRAO = {
  moto: { base: 3, km: 1.2, min: 0.15 },
  pop: { base: 5, km: 1.8, min: 0.25 },
  plus: { base: 7, km: 2.4, min: 0.35 },
  expresso: 20, // % a mais para ser buscado primeiro
  minimo: 6, // nenhuma sugestão abaixo disso (R$)
};
const CHAVE_TARIFAS = "xbrl.tarifas";

export function tarifas() {
  try {
    const t = JSON.parse(localStorage.getItem(CHAVE_TARIFAS) || "null");
    if (t && t.pop) return { ...TARIFAS_PADRAO, ...t, moto: { ...TARIFAS_PADRAO.moto, ...t.moto }, pop: { ...TARIFAS_PADRAO.pop, ...t.pop }, plus: { ...TARIFAS_PADRAO.plus, ...t.plus } };
  } catch { /* padrão */ }
  return structuredClone(TARIFAS_PADRAO);
}
export function gravarTarifas(t) {
  try { localStorage.setItem(CHAVE_TARIFAS, JSON.stringify(t)); } catch { /* sem armazenamento */ }
}
export const voltarTarifasPadrao = () => { try { localStorage.removeItem(CHAVE_TARIFAS); } catch { /* ok */ } };

/** Preço sugerido (R$, 2 casas) para uma categoria, pela distância e pelo tempo da rota. */
export function precoSugerido(cat, km, minutos, expresso = false, t = tarifas()) {
  const f = t[cat] || t.pop;
  let v = Number(f.base) + Number(f.km) * km + Number(f.min) * minutos;
  if (expresso) v *= 1 + Number(t.expresso || 0) / 100;
  return Math.max(Number(t.minimo || 0), Math.round(v * 2) / 2).toFixed(2); // arredonda de 50 em 50 centavos
}

// ---------- Descrição pública (vai para a blockchain: nunca o endereço exato) ----------
const limpar = (s, max) => String(s ?? "").replace(/[→·\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const km1 = (v) => Number(v).toFixed(1).replace(".", ",");

/**
 * @param o { categorias: ["pop","moto"], de, para, pessoas, obs, aprox: {lat,lon}, km, min, expresso, agendada (unix) }
 */
export function descricaoCorrida({ categorias, veiculo, de, para, pessoas = 1, obs = "", aprox = null, km = null, min = null, expresso = false, agendada = null }) {
  const cats = (categorias?.length ? categorias : [veiculo || "pop"]).map((c) => VEICULOS[c] || VEICULOS.pop);
  const maxP = Math.max(...cats.map((c) => c.maxPessoas));
  const n = Math.max(1, Math.min(maxP, Number(pessoas) || 1));
  const partes = [`${[...new Set(cats.map((c) => c.icone))].join("")} Corrida: ${limpar(de, 40)} → ${limpar(para, 40)}`];
  if (n > 1) partes.push(`${n} pessoas`);
  if (aprox) partes.push(`📍${Number(aprox.lat).toFixed(2)},${Number(aprox.lon).toFixed(2)}`);
  if (km != null) partes.push(`${km1(km)} km`);
  if (min != null) partes.push(`${Math.round(min)} min`);
  if (expresso) partes.push("⚡ Expresso");
  if (agendada) partes.push(`⏰ ${new Date(agendada * 1000).toISOString().slice(0, 16)}Z`);
  const o = limpar(obs, 60);
  if (o) partes.push(o);
  return partes.join(" · ");
}

/** Lê um pedido de corrida a partir da descrição pública. Devolve null se não for corrida. */
export function lerCorrida(descricao) {
  const d = String(descricao || "").replace(/^📍 [^·]*· /u, "");
  const m = /^((?:🏍️|🏍|🚗|🚙)+) Corrida: (.+?) → (.+?)(?: · (.*))?$/u.exec(d);
  if (!m) return null;
  const categorias = [...new Set([...m[1].matchAll(/🏍️|🏍|🚗|🚙/gu)].map((x) => POR_ICONE[x[0]]))];
  const c = { categorias, veiculo: categorias[0], icone: m[1], de: m[2], para: m[3], pessoas: 1, obs: "", aprox: null, km: null, min: null, expresso: false, agendada: null };
  const resto = [];
  for (const p of (m[4] || "").split(" · ").filter(Boolean)) {
    let x;
    if ((x = /^(\d+) pessoas$/.exec(p))) c.pessoas = Number(x[1]);
    else if ((x = /^📍(-?\d{1,2}\.\d{1,2}),(-?\d{1,3}\.\d{1,2})$/u.exec(p))) c.aprox = { lat: Number(x[1]), lon: Number(x[2]) };
    else if ((x = /^(\d+(?:,\d)?) km$/.exec(p))) c.km = Number(x[1].replace(",", "."));
    else if ((x = /^(\d+) min$/.exec(p))) c.min = Number(x[1]);
    else if (p === "⚡ Expresso") c.expresso = true;
    else if ((x = /^⏰ (\d{4}-\d\d-\d\dT\d\d:\d\d)Z$/u.exec(p))) c.agendada = Math.floor(Date.parse(x[1] + ":00Z") / 1000);
    else resto.push(p);
  }
  c.obs = resto.join(" · ");
  c.nomeCategorias = c.categorias.map((k) => VEICULOS[k].nome).join(" ou ");
  return c;
}

export const ehCorrida = (descricao) => lerCorrida(descricao) !== null;

/** Texto privado (vai cifrado só para o motorista aprovado), com a coordenada exata de cada ponto. */
export function enderecoCorrida(embarque, destino) {
  const linha = (p) => (typeof p === "string" ? limpar(p, 120) : `${limpar([p.endereco, p.complemento].filter(Boolean).join(", ") || "Ponto marcado no mapa", 120)}\n📍 ${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`);
  return `🟢 Embarque: ${linha(embarque)}\n🏁 Destino: ${linha(destino)}`;
}

// ---------- Distância (linha reta; a rota pela rua vem de rota.js) ----------
export function distanciaKm(a, b) {
  const R = 6371;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Contraproposta do motorista (assinada; vai pelo avisador). */
export const PREFIXO_CONTRA = "brlscontra:";

/** Em que passo a corrida está, em palavras simples (para passageiro e motorista). */
export function passoCorrida(t, souPassageiro) {
  if (t.estado === 5) return { n: 0, texto: "Cancelada: o dinheiro voltou para o passageiro." };
  if (t.estado === 4) return { n: 5, texto: "Corrida concluída e paga. ✅" };
  if (t.estado === 3) return { n: 4, texto: souPassageiro ? "Corrida em cancelamento: aguardando o motorista aceitar o acordo." : "O passageiro pediu para cancelar: veja a proposta abaixo." };
  if (t.estado === 0 && !t.pendenteAprovacao) return { n: 1, texto: souPassageiro ? "Procurando motorista… deixe o app aberto." : "Pedido aberto: toque em aceitar para se candidatar." };
  if (t.estado === 0 && t.pendenteAprovacao) return { n: 2, texto: souPassageiro ? "Um motorista quer fazer sua corrida: confira o carro, a placa e a reputação e aprove." : "Você se candidatou: aguarde o passageiro aprovar." };
  if (t.estado === 1 && !t.chegou) return { n: 3, texto: souPassageiro ? "Motorista a caminho. Confira a placa antes de entrar e toque em \"Entrei no veículo\"." : "Vá até o embarque: toque em Waze ou Google Maps abaixo. Peça ao passageiro para confirmar quando entrar." };
  if (t.estado === 1 && t.chegou) return { n: 4, texto: souPassageiro ? "Em viagem. No destino, mostre o código ao motorista (ou toque em pagar)." : "Em viagem. No destino, peça o código ao passageiro para receber." };
  return { n: 4, texto: "Em andamento." };
}
