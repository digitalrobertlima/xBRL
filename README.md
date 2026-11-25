# xBRL — O Real Soberano & Inconfiscável (Polygon)

**1 xBRL = R$ 1**, lastreado 1:1 em stablecoins de Real (BRZ, BRLA), sem congelamento, sem confisco, sem servidor.

- 🌐 Site: https://digitalrobertlima.github.io/xBRL
- 👛 Carteira PWA: https://digitalrobertlima.github.io/xBRL/wallet/

| Pasta | O que tem |
|---|---|
| `contracts/` | Foundry: `xBRL`, `ReservaBRL`, `EscrowTrabalho`, script de deploy determinístico e 63 testes |
| `wallet/` | Carteira nativa 100% estática (BIP-39 + AES-256-GCM + WebAuthn PRF, tanque de gás, marketplace com códigos/QR de chegada e entrega) |
| `index.html` | Landing page institucional |
| `CLAUDE.md` | Manual técnico fixo: invariantes, endereços, identidade visual, comandos |

```bash
git clone --recursive https://github.com/digitalrobertlima/xBRL && cd xBRL/contracts
forge build && forge test
```

⚠️ Contratos ainda **não auditados** externamente. Software livre, sem garantias. Licença MIT.
