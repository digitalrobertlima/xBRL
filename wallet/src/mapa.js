// =====================================================================
// BRLS — Mapa para marcar um ponto EXATO (embarque, destino, entrega, serviço)
// Cada um escreve endereço de um jeito; a coordenada não tem dúvida. A pessoa procura o endereço ou
// toca em "Estou aqui", arrasta o mapa até o pino ficar no lugar certo e confirma.
//
// Sem biblioteca e sem servidor nosso (decisão do dono, 26/11/2026):
//   - imagens do mapa: OpenStreetMap (tile.openstreetmap.org), baixadas com fetch → no APK passam
//     pela ponte da Caixa Forte (Tor), como todo o resto;
//   - busca de endereço: Nominatim (OpenStreetMap), só quando a pessoa toca em "Buscar" (nunca a cada letra).
// O ponto escolhido NUNCA vai para a blockchain: segue cifrado só para quem vai até lá.
// O "Estou aqui" é só ajuda para marcar o ponto; não prova nada (a prova continua sendo o código).
// =====================================================================

const TILE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const NOMINATIM = "https://nominatim.openstreetmap.org";
const T = 256;
const ZMIN = 3;
const ZMAX = 19;
const CHAVE_ULTIMO = "xbrl.mapa.ultimo";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const lim = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Projeção (Web Mercator, em pixels do zoom z) ----------
export const lonParaX = (lon, z) => ((lon + 180) / 360) * T * 2 ** z;
export function latParaY(lat, z) {
  const r = (lim(lat, -85.05112878, 85.05112878) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * T * 2 ** z;
}
export const xParaLon = (x, z) => (x / (T * 2 ** z)) * 360 - 180;
export function yParaLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / (T * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

// ---------- Coordenadas no texto privado ("📍 -19.93821,-43.93412") ----------
export const fmtCoord = (lat, lon) => `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
const RE_COORD = /📍\s*(-?\d{1,2}\.\d{3,7}),\s*(-?\d{1,3}\.\d{3,7})/gu;

/** Todas as coordenadas marcadas num texto. */
export function coordenadasNoTexto(texto) {
  const out = [];
  for (const m of String(texto || "").matchAll(RE_COORD)) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ lat, lon });
  }
  return out;
}

/** Links para abrir o ponto no app de GPS da pessoa. */
export function linksNavegar(lat, lon) {
  const c = fmtCoord(lat, lon);
  return {
    waze: `https://waze.com/ul?ll=${c}&navigate=yes`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${c}`,
    geo: `geo:${c}?q=${c}`,
  };
}

/** Botões "Waze / Google Maps / GPS" para cada coordenada de um texto (HTML pronto). */
export function botoesGps(texto, rotulos = []) {
  return coordenadasNoTexto(texto).map(({ lat, lon }, i) => {
    const l = linksNavegar(lat, lon);
    const c = fmtCoord(lat, lon);
    return `<div class="gps"><span>${esc(rotulos[i] || "📍 Ponto marcado")} <small class="mudo">${esc(c)}</small></span>
      <span class="gps-botoes"><a class="btn sec mini" href="${esc(l.waze)}" target="_blank" rel="noopener" data-gps="${esc(c)}" data-app="waze">Waze</a><a class="btn sec mini" href="${esc(l.google)}" target="_blank" rel="noopener" data-gps="${esc(c)}" data-app="google">Google Maps</a><a class="btn sec mini" href="${esc(l.geo)}" data-gps="${esc(c)}" data-app="geo">GPS do celular</a></span></div>`;
  }).join("");
}

// ---------- Rede (fetch: no APK passa pela ponte da Caixa Forte) ----------
const cacheTiles = new Map(); // url → objectURL (os mais recentes)
async function urlDoTile(url) {
  if (cacheTiles.has(url)) {
    const u = cacheTiles.get(url);
    cacheTiles.delete(url);
    cacheTiles.set(url, u);
    return u;
  }
  const r = await fetch(url, { referrerPolicy: "strict-origin-when-cross-origin" });
  if (!r.ok) throw new Error("tile " + r.status);
  const u = URL.createObjectURL(await r.blob());
  cacheTiles.set(url, u);
  while (cacheTiles.size > 400) {
    const [k, v] = cacheTiles.entries().next().value;
    cacheTiles.delete(k);
    URL.revokeObjectURL(v);
  }
  return u;
}

let ultimaBusca = 0;
async function nominatim(caminho) {
  // Regra de uso do Nominatim: no máximo 1 pedido por segundo.
  const espera = ultimaBusca + 1100 - Date.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaBusca = Date.now();
  const r = await fetch(`${NOMINATIM}${caminho}${caminho.includes("?") ? "&" : "?"}format=jsonv2&addressdetails=1&accept-language=pt-BR`, { referrerPolicy: "strict-origin-when-cross-origin", headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("busca " + r.status);
  return r.json();
}

// "Regional Sede", "Regional Norte"…: região administrativa da prefeitura, não é bairro.
const naoEhBairro = (x) => !x || /^(regional|região|distrito|subprefeitura)\b/i.test(x);

/** Partes do endereço vindas do OpenStreetMap. O bairro de lá nem sempre está certo: a pessoa confere. */
export function partesEndereco(res) {
  const a = res?.address || {};
  const rua = a.road || a.pedestrian || a.footway || a.path || a.square || a.place || "";
  const bairro = [a.suburb, a.neighbourhood, a.quarter, a.hamlet, a.city_district].find((x) => !naoEhBairro(x)) || "";
  const cidade = a.city || a.town || a.village || a.municipality || "";
  const nome = res?.name && res.name !== rua ? res.name : "";
  return { nome, rua, numero: a.house_number || "", bairro, cidade, exibicao: String(res?.display_name || "") };
}

/** Monta "Rua X, 100 – Bairro, Cidade" (e o bairro público "Bairro, Cidade"). */
export function montarEndereco({ nome = "", rua = "", numero = "", bairro = "", cidade = "", exibicao = "" }) {
  const linhaRua = [rua, numero].filter(Boolean).join(", ");
  const local = [bairro, cidade].filter(Boolean).join(", ");
  const endereco = [nome, linhaRua, local].filter(Boolean).join(" – ") || exibicao.split(",").slice(0, 3).join(",");
  return { endereco: endereco.slice(0, 110), bairro: local.slice(0, 40) };
}

/** Endereço curto ("Rua X, 100 – Savassi, Belo Horizonte") e o bairro público ("Savassi, Belo Horizonte"). */
export const resumirEndereco = (res) => ({ ...montarEndereco(partesEndereco(res)), partes: partesEndereco(res) });

export const buscarEndereco = async (q) => (await nominatim(`/search?q=${encodeURIComponent(q)}&limit=6&countrycodes=br`)).map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), ...resumirEndereco(r) }));
export const enderecoDoPonto = async (lat, lon) => resumirEndereco(await nominatim(`/reverse?lat=${lat}&lon=${lon}&zoom=18`));

function lerUltimo() {
  try {
    const u = JSON.parse(localStorage.getItem(CHAVE_ULTIMO) || "null");
    if (u && Number.isFinite(u.lat) && Number.isFinite(u.lon)) return u;
  } catch { /* sem armazenamento */ }
  return null;
}

/**
 * Abre o mapa em tela cheia para a pessoa marcar um ponto.
 * @returns Promise<{ lat, lon, endereco, bairro, complemento } | null>  (null = desistiu)
 */
export function escolherPonto({ titulo = "📍 Marque o ponto exato", inicial = null, dica = "" } = {}) {
  return new Promise((resolver) => {
    const ult = inicial || lerUltimo();
    const st = { lat: ult?.lat ?? -15.79, lon: ult?.lon ?? -47.88, z: inicial ? 17 : ult ? 15 : 4, info: inicial ? { endereco: inicial.endereco, bairro: inicial.bairro, partes: inicial.partes } : null };
    const raiz = document.createElement("div");
    raiz.className = "mapa-folha";
    raiz.setAttribute("role", "dialog");
    raiz.setAttribute("aria-modal", "true");
    raiz.setAttribute("aria-label", titulo);
    raiz.innerHTML = `
      <div class="mapa-topo"><button class="mapa-voltar" type="button" aria-label="Voltar sem marcar">←</button><b>${esc(titulo)}</b></div>
      <form class="mapa-busca" autocomplete="off"><input type="search" enterkeyhint="search" placeholder="Rua e número, bairro, cidade" aria-label="Procurar endereço"><button class="btn prim mini" type="submit">Buscar</button></form>
      <div class="mapa-resultados" hidden></div>
      <div class="mapa-area" tabindex="0" aria-label="Mapa: arraste para mover, use + e − para aproximar">
        <div class="mapa-camada"></div>
        <div class="mapa-pino" aria-hidden="true"><svg viewBox="0 0 32 44" width="36" height="50"><path d="M16 1C8 1 2 7 2 15c0 10 14 27 14 27s14-17 14-27C30 7 24 1 16 1z" fill="#F2B807" stroke="#061710" stroke-width="2"/><circle cx="16" cy="15" r="5" fill="#061710"/></svg></div>
        <div class="mapa-zoom"><button type="button" data-z="1" aria-label="Aproximar">+</button><button type="button" data-z="-1" aria-label="Afastar">−</button></div>
        <button type="button" class="mapa-aqui">◎ Estou aqui</button>
        <small class="mapa-credito">© OpenStreetMap</small>
      </div>
      <div class="mapa-base">
        <p class="mapa-end" aria-live="polite">${dica ? esc(dica) : "Arraste o mapa até a ponta do pino ficar no lugar exato."}</p>
        <div class="mapa-campos">
          <input class="mapa-num" maxlength="10" inputmode="numeric" placeholder="Número" aria-label="Número" value="${esc(inicial?.partes?.numero || "")}">
          <input class="mapa-bairro" maxlength="34" placeholder="Bairro (confira)" aria-label="Bairro" value="${esc(inicial?.partes?.bairro || "")}">
        </div>
        <input class="mapa-compl" maxlength="60" placeholder="Complemento ou referência (opcional)" value="${esc(inicial?.complemento || "")}">
        <button class="btn prim mapa-ok" type="button">Confirmar este ponto</button>
      </div>`;
    document.body.appendChild(raiz);
    document.body.classList.add("com-mapa");
    const $ = (s) => raiz.querySelector(s);
    const area = $(".mapa-area");
    const camada = $(".mapa-camada");
    const linhaEnd = $(".mapa-end");
    const imgs = new Map();
    let escala = 1;
    let quadro = 0;

    function desenhar() {
      quadro = 0;
      const W = area.clientWidth;
      const H = area.clientHeight;
      const cx = lonParaX(st.lon, st.z);
      const cy = latParaY(st.lat, st.z);
      const x0 = cx - W / 2;
      const y0 = cy - H / 2;
      const n = 2 ** st.z;
      const vivos = new Set();
      for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + H) / T); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + W) / T); tx++) {
          const xx = ((tx % n) + n) % n;
          const chave = `${st.z}/${tx}/${ty}`;
          vivos.add(chave);
          let im = imgs.get(chave);
          if (!im) {
            im = document.createElement("img");
            im.alt = "";
            im.draggable = false;
            imgs.set(chave, im);
            camada.appendChild(im);
            urlDoTile(TILE(st.z, xx, ty)).then((u) => { im.src = u; }).catch(() => im.classList.add("falhou"));
          }
          im.style.transform = `translate(${Math.round(tx * T - x0)}px, ${Math.round(ty * T - y0)}px)`;
        }
      }
      for (const [k, im] of imgs) if (!vivos.has(k)) { im.remove(); imgs.delete(k); }
      camada.style.transform = escala === 1 ? "" : `scale(${escala})`;
    }
    const pedirDesenho = () => { if (!quadro) quadro = requestAnimationFrame(desenhar); };

    // Endereço do ponto do pino (com calma: só depois que o mapa para de mexer)
    let tEnd = 0;
    let pedidoEnd = 0;
    function endDepois() {
      clearTimeout(tEnd);
      st.info = null;
      linhaEnd.textContent = "Procurando o endereço deste ponto…";
      tEnd = setTimeout(async () => {
        const meu = ++pedidoEnd;
        try {
          const info = await enderecoDoPonto(st.lat.toFixed(6), st.lon.toFixed(6));
          if (meu !== pedidoEnd) return;
          st.info = info;
          linhaEnd.textContent = info.endereco || "Ponto marcado (sem nome de rua aqui).";
          preencher(info.partes);
        } catch {
          if (meu === pedidoEnd) linhaEnd.textContent = "Ponto marcado. (Não deu para achar o nome da rua agora, mas a coordenada é exata.)";
        }
      }, 900);
    }
    const mover = (lat, lon, z = st.z) => {
      st.lat = lim(lat, -85, 85);
      st.lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      st.z = lim(Math.round(z), ZMIN, ZMAX);
      pedirDesenho();
      endDepois();
    };
    const zoom = (d) => mover(st.lat, st.lon, st.z + d);
    // Número e bairro: vêm do mapa, mas quem manda é a pessoa (o bairro do mapa às vezes está errado)
    const campoNum = $(".mapa-num");
    const campoBairro = $(".mapa-bairro");
    for (const c of [campoNum, campoBairro]) c.addEventListener("input", () => (c.dataset.mexeu = "1"));
    const preencher = (p) => {
      if (!p) return;
      if (!campoNum.dataset.mexeu && p.numero) campoNum.value = p.numero;
      if (!campoBairro.dataset.mexeu) campoBairro.value = p.bairro || "";
    };

    // Arrastar e pinçar
    const dedos = new Map();
    let pinca = null;
    area.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // botões sobre o mapa (+, −, Estou aqui) recebem o toque normalmente
      area.setPointerCapture(e.pointerId);
      dedos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (dedos.size === 2) {
        const [a, b] = [...dedos.values()];
        pinca = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      }
    });
    area.addEventListener("pointermove", (e) => {
      const ant = dedos.get(e.pointerId);
      if (!ant) return;
      const agora = { x: e.clientX, y: e.clientY };
      dedos.set(e.pointerId, agora);
      if (dedos.size === 1 && !pinca) {
        const cx = lonParaX(st.lon, st.z) - (agora.x - ant.x);
        const cy = latParaY(st.lat, st.z) - (agora.y - ant.y);
        st.lon = xParaLon(cx, st.z);
        st.lat = lim(yParaLat(cy, st.z), -85, 85);
        clearTimeout(tEnd);
        linhaEnd.textContent = "Solte quando o pino estiver no lugar.";
        pedirDesenho();
      } else if (dedos.size === 2 && pinca) {
        const [a, b] = [...dedos.values()];
        escala = lim((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinca.d0, 0.25, 4);
        pedirDesenho();
      }
    });
    const soltar = (e) => {
      if (!dedos.delete(e.pointerId)) return;
      if (pinca && dedos.size < 2) {
        const d = Math.round(Math.log2(escala));
        escala = 1;
        pinca = null;
        dedos.clear();
        mover(st.lat, st.lon, st.z + d);
        return;
      }
      if (!dedos.size) endDepois();
    };
    area.addEventListener("pointerup", soltar);
    area.addEventListener("pointercancel", soltar);
    area.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) zoom(1); });
    area.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    area.addEventListener("keydown", (e) => {
      const passo = 80;
      const k = { ArrowLeft: [-passo, 0], ArrowRight: [passo, 0], ArrowUp: [0, -passo], ArrowDown: [0, passo] }[e.key];
      if (k) {
        e.preventDefault();
        mover(yParaLat(latParaY(st.lat, st.z) + k[1], st.z), xParaLon(lonParaX(st.lon, st.z) + k[0], st.z));
      } else if (e.key === "+" || e.key === "=") zoom(1);
      else if (e.key === "-") zoom(-1);
    });
    raiz.querySelectorAll("[data-z]").forEach((b) => b.addEventListener("click", () => zoom(Number(b.dataset.z))));

    // Estou aqui (localização do próprio aparelho; nada sai do celular)
    $(".mapa-aqui").addEventListener("click", () => {
      if (!navigator.geolocation) { linhaEnd.textContent = "Este aparelho não informa a localização aqui. Procure o endereço ou arraste o mapa."; return; }
      linhaEnd.textContent = "Pegando sua localização…";
      navigator.geolocation.getCurrentPosition(
        (p) => mover(p.coords.latitude, p.coords.longitude, 18),
        () => { linhaEnd.textContent = "Não deu para pegar sua localização. Procure o endereço acima ou arraste o mapa até o ponto."; },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
      );
    });

    // Busca (só ao tocar em Buscar)
    const caixaRes = $(".mapa-resultados");
    $(".mapa-busca").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $(".mapa-busca input").value.trim();
      if (q.length < 3) return;
      caixaRes.hidden = false;
      caixaRes.innerHTML = `<p class="mudo">Procurando…</p>`;
      try {
        const res = await buscarEndereco(q);
        caixaRes.innerHTML = res.length
          ? res.map((r, i) => `<button type="button" data-i="${i}">📍 ${esc(r.endereco)}</button>`).join("") + `<p class="mudo">Toque no certo e ajuste o pino arrastando o mapa.</p>`
          : `<p class="mudo">Não achei. Tente com o nome da cidade (ex.: "Rua da Bahia 1000, Belo Horizonte") ou arraste o mapa até o ponto.</p>`;
        // O número digitado na busca vale mais que o do mapa
        const numBusca = /\b(\d{1,5})\b(?!.*\d)/.exec(q)?.[1] || "";
        caixaRes.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => {
          const r = res[Number(b.dataset.i)];
          caixaRes.hidden = true;
          if (numBusca && !campoNum.dataset.mexeu) { campoNum.value = numBusca; campoNum.dataset.mexeu = "1"; }
          mover(r.lat, r.lon, 18);
        }));
      } catch {
        caixaRes.innerHTML = `<p class="mudo">A busca não respondeu agora. Arraste o mapa até o ponto ou tente de novo.</p>`;
      }
    });

    const fechar = (valor) => {
      clearTimeout(tEnd);
      removeEventListener("resize", pedirDesenho);
      removeEventListener("keydown", aoTeclar);
      raiz.remove();
      document.body.classList.remove("com-mapa");
      resolver(valor);
    };
    const aoTeclar = (e) => { if (e.key === "Escape") fechar(null); };
    addEventListener("keydown", aoTeclar);
    addEventListener("resize", pedirDesenho);
    $(".mapa-voltar").addEventListener("click", () => fechar(null));
    $(".mapa-ok").addEventListener("click", () => {
      if (st.z < 14) { linhaEnd.textContent = "Aproxime mais o mapa (+) para marcar o ponto exato."; return; }
      const lat = Number(st.lat.toFixed(5));
      const lon = Number(st.lon.toFixed(5));
      try { localStorage.setItem(CHAVE_ULTIMO, JSON.stringify({ lat, lon })); } catch { /* sem armazenamento */ }
      const partes = { ...(st.info?.partes || {}), numero: campoNum.value.trim(), bairro: campoBairro.value.trim() };
      const m = montarEndereco(partes);
      fechar({ lat, lon, endereco: m.endereco || st.info?.endereco || "", bairro: m.bairro, partes, complemento: $(".mapa-compl").value.trim().slice(0, 60) });
    });

    pedirDesenho();
    if (inicial) linhaEnd.textContent = inicial.endereco || "Ponto marcado.";
    else if (!ult) linhaEnd.textContent = dica || "Toque em \"Estou aqui\" ou procure o endereço acima.";
    else endDepois();
  });
}

/** Texto de um ponto para a mensagem cifrada: "Rua X, 100 – Bairro · apto 3\n📍 lat,lon". */
export function textoDoPonto(p) {
  const nome = [p.endereco, p.complemento].filter(Boolean).join(" · ") || "Ponto marcado no mapa";
  return `${nome}\n📍 ${fmtCoord(p.lat, p.lon)}`;
}
