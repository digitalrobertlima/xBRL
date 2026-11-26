// xBRL — Service Worker
// Estratégia: rede primeiro para os arquivos do próprio site (atualização imediata a cada publicação),
// cache como reserva para funcionar offline. Chamadas a RPCs (outros domínios) nunca são interceptadas.
const VERSAO = "brls-wallet-v3.6.3";
const ARQUIVOS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./src/app.js",
  "./src/config.js",
  "./src/abis.js",
  "./src/keystore.js",
  "./src/gas-tank.js",
  "./src/escrow-client.js",
  "./src/chat.js",
  "./src/semgas.js",
  "./src/rpc.js",
  "./src/externa.js",
  "./src/rede-ponte.js",
  "./src/corrida.js",
  "./src/mapa.js",
  "./src/correio.js",
  "./src/vitrine.js",
  "./src/rota.js",
  "./src/marca.js",
  "./src/comprovante.js",
  "./comprovante.html",
  "./estilo.css",
  "./src/palavras-pt.js",
  "./src/vendor/ethers.umd.min.js",
  "./src/vendor/qrcode.mjs",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // RPCs e links externos: direto na rede
  ev.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((resp) => {
        if (resp.ok && resp.type === "basic") {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html"))),
  );
});

// Toque num aviso (pedido novo, motorista a caminho…): abre ou traz o app para a frente.
self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  ev.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abertas) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  })());
});
