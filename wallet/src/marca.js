// =====================================================================
// BRLS — Marca: a "roseta" de cédula (guilhoché) gerada por matemática, sem imagem externa.
// Cada roseta é um epitrocoide desenhado como nas cédulas do Real; o mesmo desenho vira logo,
// fundo da "cédula" de saldo e ícone do app.
// =====================================================================

/** Pontos de um epitrocoide fechado: R raio fixo, r raio do círculo que gira, d distância da caneta. */
function epitrocoide(R, r, d, passos = 720) {
  const pts = [];
  const voltas = r / mdc(R, r);
  const total = Math.PI * 2 * voltas;
  for (let i = 0; i <= passos; i++) {
    const t = (total * i) / passos;
    const x = (R + r) * Math.cos(t) - d * Math.cos(((R + r) / r) * t);
    const y = (R + r) * Math.sin(t) - d * Math.sin(((R + r) / r) * t);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
}
function mdc(a, b) {
  return b ? mdc(b, a % b) : a;
}

/**
 * SVG da roseta.
 * @param tam    tamanho em px (viewBox fixo de 200)
 * @param tracos quantas camadas de linha (3 a 6)
 * @param classe classe CSS extra (ex.: "desenhar" para a animação de entrada)
 * @param centro texto no centro (ex.: "R$"); vazio = sem texto
 */
export function roseta({ tam = 40, tracos = 4, classe = "", centro = "R$", rotulo = "" } = {}) {
  const camadas = [
    [60, 7, 18],
    [56, 8, 24],
    [52, 9, 28],
    [48, 11, 30],
    [64, 5, 14],
    [44, 12, 22],
  ].slice(0, Math.max(3, Math.min(6, tracos)));
  const linhas = camadas
    .map(([R, r, d], i) => `<polyline class="r${i}" points="${epitrocoide(R, r, d)}" fill="none" stroke-width="${(0.9 - i * 0.08).toFixed(2)}"/>`)
    .join("");
  const texto = centro
    ? `<circle r="27" class="miolo"/><text y="1" text-anchor="middle" dominant-baseline="middle" class="cifra">${centro}</text>`
    : "";
  const aria = rotulo ? `role="img" aria-label="${rotulo}"` : `aria-hidden="true"`;
  return `<svg class="roseta ${classe}" width="${tam}" height="${tam}" viewBox="-100 -100 200 200" ${aria}><circle r="96" class="aro"/><circle r="91" class="aro fino"/>${linhas}${texto}</svg>`;
}

/** Logo completo: roseta + palavra. */
export function marca(tam = 32) {
  return `<span class="marca">${roseta({ tam, tracos: 3 })}<span class="palavra">BRLS<small>Real Soberano</small></span></span>`;
}
