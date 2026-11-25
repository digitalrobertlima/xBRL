import { marca } from "./wallet/src/marca.js";
document.getElementById("marca").innerHTML = marca(34);
const d = await fetch("wallet/src/deployments/137.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
document.getElementById("end-brls").textContent = d?.Encaminhador && d.xBRL ? d.xBRL : "aparece aqui depois da implantação";
