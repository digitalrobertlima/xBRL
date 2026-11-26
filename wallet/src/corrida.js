// =====================================================================
// BRLS — Corrida de carro ou moto (sem contrato novo)
// Uma corrida é um trabalho PRESENCIAL do EscrowTrabalho, com vaga aberta:
//   1. O passageiro pede: preço fechado, só o BAIRRO de embarque e de destino ficam públicos.
//      O valor fica travado no contrato. Gera um código de destino (palavras + QR).
//   2. Motoristas com o app aberto veem o pedido e se candidatam; o passageiro vê a reputação e aprova um.
//   3. O endereço exato de embarque e de destino vai só para o motorista aprovado, pela conversa cifrada.
//   4. Ao entrar no veículo, o passageiro confirma o embarque.
//   5. No destino, o passageiro mostra o código: o motorista digita ou lê o QR e recebe na hora.
//      (Ou o passageiro mesmo toca em "pagar agora".)
// Sem servidor: os pedidos aparecem para quem estiver com o app aberto. Embarque e destino são marcados
// no mapa (coordenada exata, mapa.js); o GPS nunca é prova de nada — a prova é o código.
// =====================================================================

export const VEICULOS = {
  carro: { id: "carro", icone: "🚗", nome: "Carro", maxPessoas: 4 },
  moto: { id: "moto", icone: "🏍️", nome: "Moto", maxPessoas: 1 },
};

/** Validade do pedido (o contrato devolve o dinheiro ao passageiro se ninguém fizer a corrida até lá). */
export const VALIDADES_HORAS = [1, 2, 4];

const limpar = (s, max) => String(s ?? "").replace(/[→·\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Texto público do pedido (vai para a blockchain: nunca o endereço exato). */
export function descricaoCorrida({ veiculo, de, para, pessoas = 1, obs = "" }) {
  const v = VEICULOS[veiculo] || VEICULOS.carro;
  const n = Math.max(1, Math.min(v.maxPessoas, Number(pessoas) || 1));
  let txt = `${v.icone} Corrida: ${limpar(de, 40)} → ${limpar(para, 40)}`;
  if (n > 1) txt += ` · ${n} pessoas`;
  const o = limpar(obs, 60);
  if (o) txt += ` · ${o}`;
  return txt;
}

/** Lê um pedido de corrida a partir da descrição pública. Devolve null se não for corrida. */
export function lerCorrida(descricao) {
  const m = /^(🚗|🏍️) Corrida: (.+?) → (.+?)(?: · (\d+) pessoas)?(?: · (.+))?$/u.exec(String(descricao || "").replace(/^📍 [^·]*· /u, ""));
  if (!m) return null;
  const veiculo = m[1] === "🏍️" ? "moto" : "carro";
  return { veiculo, icone: m[1], de: m[2], para: m[3], pessoas: Number(m[4] || 1), obs: m[5] || "" };
}

export const ehCorrida = (descricao) => lerCorrida(descricao) !== null;

/** Texto privado (vai cifrado só para o motorista aprovado), com a coordenada exata de cada ponto. */
export function enderecoCorrida(embarque, destino) {
  const linha = (p) => (typeof p === "string" ? limpar(p, 120) : `${limpar([p.endereco, p.complemento].filter(Boolean).join(", ") || "Ponto marcado no mapa", 120)}\n📍 ${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`);
  return `🟢 Embarque: ${linha(embarque)}\n🏁 Destino: ${linha(destino)}`;
}

/** Em que passo a corrida está, em palavras simples (para passageiro e motorista). */
export function passoCorrida(t, souPassageiro) {
  if (t.estado === 5) return { n: 0, texto: "Cancelada: o dinheiro voltou para o passageiro." };
  if (t.estado === 4) return { n: 5, texto: "Corrida concluída e paga. ✅" };
  if (t.estado === 3) return { n: 4, texto: "Em disputa." };
  if (t.estado === 0 && !t.pendenteAprovacao) return { n: 1, texto: souPassageiro ? "Procurando motorista… deixe o app aberto." : "Pedido aberto: toque em aceitar para se candidatar." };
  if (t.estado === 0 && t.pendenteAprovacao) return { n: 2, texto: souPassageiro ? "Um motorista quer fazer sua corrida: confira a reputação e aprove." : "Você se candidatou: aguarde o passageiro aprovar." };
  if (t.estado === 1 && !t.chegou) return { n: 3, texto: souPassageiro ? "Motorista a caminho. Quando entrar no veículo, toque em \"Entrei no veículo\"." : "Vá até o embarque: toque em Waze ou Google Maps abaixo. Peça ao passageiro para confirmar quando entrar." };
  if (t.estado === 1 && t.chegou) return { n: 4, texto: souPassageiro ? "Em viagem. No destino, mostre o código ao motorista (ou toque em pagar)." : "Em viagem. No destino, peça o código ao passageiro para receber." };
  return { n: 4, texto: "Em andamento." };
}
