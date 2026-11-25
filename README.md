# xBRL — O Real Soberano & Inconfiscável (Polygon)

**1 xBRL = R$ 1**, lastreado em stablecoins de Real (BRZ, BRLA, BRL1) ou em cripto supercolateralizada (ETH, POL), sem congelamento, sem confisco, sem servidor.

🧪 **Fase beta na Polygon** com limites baixos (reserva até R$ 1.000, cofre até R$ 500 por cripto).

- 🌐 Site: https://digitalrobertlima.github.io/xBRL
- 👛 Carteira PWA: https://digitalrobertlima.github.io/xBRL/wallet/

| Pasta | O que tem |
|---|---|
| `contracts/` | Foundry: `xBRL`, `ReservaBRL`, `CofreCripto`, `EscrowTrabalho`, `Mensageiro`, script de deploy determinístico e 68 testes |
| `wallet/` | Carteira nativa 100% estática (BIP-39 + AES-256-GCM + WebAuthn PRF, tanque de gás, cofre cripto, marketplace com códigos/QR de chegada, entrega e devolução, caução, árbitros e conversa cifrada) |
| `index.html` | Landing page institucional |
| `CLAUDE.md` | Manual técnico fixo: invariantes, endereços, identidade visual, comandos |

```bash
git clone --recursive https://github.com/digitalrobertlima/xBRL && cd xBRL/contracts
forge build && forge test
```

⚠️ Contratos ainda **não auditados** externamente. Software livre, sem garantias. Licença MIT.
