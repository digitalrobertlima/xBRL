# BRLS — Real Soberano (Polygon)

**1 BRLS = R$ 1**, lastreado em stablecoins de Real (BRZ, BRLA, BRL1) ou em cripto supercolateralizada (ETH, POL). Sem congelamento, sem confisco, sem servidor. Com marketplace de trabalho: o pagamento fica travado em contrato até o serviço ser cumprido.

- 🌐 Site: https://digitalrobertlima.github.io/xBRL
- 👛 Carteira: https://digitalrobertlima.github.io/xBRL/wallet/
- 🏊 Guia da pool na Uniswap: https://digitalrobertlima.github.io/xBRL/guia-pool.html

| Pasta / arquivo | O que tem |
|---|---|
| `contracts/` | Foundry: `xBRL` (token BRLS), `ReservaBRL`, `CofreCripto`, `EscrowTrabalho`, `Mensageiro`, `Encaminhador` (ações sem gás, ERC-2771), deploy determinístico e 75 testes |
| `wallet/` | Carteira 100% estática: BIP-39 + AES-256-GCM + biometria, tanque e kit de gás, ações sem gás por QR/link, cofre cripto, trabalhos com códigos/QR, caução, árbitros, conversa cifrada, extrato e comprovante em português |
| `index.html`, `site.*`, `guia-pool.*` | Página pública e guia da pool |
| `CLAUDE.md` | Manual técnico fixo: invariantes, endereços, identidade visual, comandos |

```bash
git clone --recursive https://github.com/digitalrobertlima/xBRL && cd xBRL/contracts
forge build && forge test
```

⚠️ Contratos ainda **não auditados** externamente. Software livre, sem garantias. Licença MIT.
