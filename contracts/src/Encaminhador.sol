// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title Encaminhador — ações sem gás (assinou, qualquer pessoa envia)
/// @notice Quem está sem POL assina a ação no próprio aparelho (não custa nada). Qualquer pessoa — em geral
/// a outra parte do trabalho, lendo um QR — envia essa assinatura à rede e paga o gás. O contrato de destino
/// enxerga quem ASSINOU como autor da ação. Cada assinatura vale uma única vez (nonce), só até o prazo dela,
/// só nesta rede e só para o contrato e a chamada exatos que foram assinados.
/// Implementação auditada da OpenZeppelin (ERC-2771), sem dono e sem nenhuma função administrativa.
contract Encaminhador is ERC2771Forwarder {
    constructor() ERC2771Forwarder("xBRL Encaminhador") {}
}
