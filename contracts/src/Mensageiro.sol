// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mensageiro — conversa cifrada de ponta a ponta entre as partes de um trabalho, sem servidor
/// @notice A carteira cifra cada mensagem no aparelho (ECDH secp256k1 + AES-256-GCM) separadamente para cada
/// destinatário (e para o próprio remetente), e publica só o texto cifrado aqui, como evento. Ninguém além dos
/// participantes consegue ler — nem o criador da rede. Sem dono, sem moderação, sem armazenamento de texto claro.
contract Mensageiro {
    uint256 public constant MAX_DESTINATARIOS = 6;
    uint256 public constant MAX_BYTES = 4_096;

    /// @notice Chave pública (64 bytes, sem o prefixo 0x04) de quem já se registrou.
    mapping(address => bytes) public chavePublica;

    event ChaveRegistrada(address indexed conta, bytes chave);
    event Mensagem(bytes32 indexed conversa, address indexed de, address[] para, bytes[] cifrados);

    error ChaveInvalida();
    error MensagemInvalida();

    /// @notice Registra a própria chave pública. O contrato confere que ela pertence a quem chama.
    function registrarChave(bytes calldata chave) public {
        if (chave.length != 64 || address(uint160(uint256(keccak256(chave)))) != msg.sender) {
            revert ChaveInvalida();
        }
        chavePublica[msg.sender] = chave;
        emit ChaveRegistrada(msg.sender, chave);
    }

    /// @notice Publica uma mensagem cifrada. `conversa` = keccak256(abi.encode("trabalho", escrow, id)).
    /// Opcionalmente registra a chave do remetente na mesma transação (`chave` vazio = não registra).
    function enviar(
        bytes32 conversa,
        address[] calldata para,
        bytes[] calldata cifrados,
        bytes calldata chave
    ) external {
        if (chave.length != 0) registrarChave(chave);
        uint256 n = para.length;
        if (n == 0 || n > MAX_DESTINATARIOS || cifrados.length != n) revert MensagemInvalida();
        for (uint256 i = 0; i < n; ++i) {
            if (cifrados[i].length == 0 || cifrados[i].length > MAX_BYTES) revert MensagemInvalida();
        }
        emit Mensagem(conversa, msg.sender, para, cifrados);
    }
}
