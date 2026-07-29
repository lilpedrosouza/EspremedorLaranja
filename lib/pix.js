'use strict';

/**
 * Monta o "copia e cola" do Pix — o BR Code do Banco Central.
 *
 * É o mesmo texto que vira QR Code: o app do banco lê os dois igual. O formato
 * é o EMV®QRCPS, uma sequência de campos "ID + tamanho + valor", terminada por
 * um CRC16 calculado sobre tudo o que veio antes.
 *
 * Referência: Manual do BR Code (BCB) e EMV®QRCPS-MPM.
 */

/** Campo do EMV: id de 2 dígitos + tamanho de 2 dígitos + conteúdo. */
function campo(id, valor) {
  const texto = String(valor);
  return `${id}${String(texto.length).padStart(2, '0')}${texto}`;
}

/**
 * CRC16/CCITT-FALSE — polinômio 0x1021, valor inicial 0xFFFF, sem inversão.
 * É o que o BR Code exige no campo 63.
 */
function crc16(texto) {
  let resultado = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    resultado ^= texto.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      resultado = resultado & 0x8000 ? ((resultado << 1) ^ 0x1021) & 0xffff : (resultado << 1) & 0xffff;
    }
  }
  return resultado.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Tira acento e qualquer caractere fora do ASCII imprimível.
 * Nome e cidade viajam em ASCII; acento quebra a leitura em alguns bancos.
 */
function apenasAscii(texto, limite) {
  return String(texto || '')
    // NFD separa a letra do acento; o filtro seguinte descarta o acento solto
    // junto com todo o resto que não for ASCII imprimível. "José" vira "Jose".
    .normalize('NFD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limite)
    .trim();
}

/**
 * Deixa a chave no formato que o banco espera.
 * CPF e CNPJ vão só com dígitos; telefone ganha +55; e-mail e chave aleatória
 * seguem como estão.
 */
function normalizarChave(bruta) {
  const chave = String(bruta || '').trim();
  if (!chave) return '';
  if (chave.includes('@')) return chave.toLowerCase();

  const digitos = chave.replace(/\D/g, '');
  if (/^\d{11}$/.test(digitos) && /[.\-]/.test(chave)) return digitos; // CPF escrito com pontuação
  if (digitos.length === 11 && !/[.\-]/.test(chave)) return digitos; // CPF sem pontuação
  if (digitos.length === 14) return digitos; // CNPJ
  if (digitos.length === 13 && digitos.startsWith('55')) return `+${digitos}`;
  if (digitos.length === 10 || digitos.length === 12) return `+55${digitos.slice(-11)}`;
  return chave; // chave aleatória (UUID) ou algo que já veio pronto
}

/** Valor com ponto decimal e dois dígitos, como o padrão pede. */
function valorPix(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return numero.toFixed(2);
}

/**
 * Devolve o texto do BR Code.
 *
 * @param {object} dados
 * @param {string} dados.chave     chave Pix do recebedor
 * @param {string} dados.nome      nome do recebedor (até 25 caracteres)
 * @param {string} [dados.cidade]  cidade do recebedor (até 15)
 * @param {number} [dados.valor]   valor em reais; sem ele o pagador digita
 * @param {string} [dados.txid]    identificador; "***" quando não há
 */
function montarBrCode({ chave, nome, cidade, valor, txid } = {}) {
  const chaveLimpa = normalizarChave(chave);
  if (!chaveLimpa) throw new Error('Sem chave Pix configurada.');

  const nomeLimpo = apenasAscii(nome, 25) || 'RECEBEDOR';
  const cidadeLimpa = apenasAscii(cidade, 15) || 'BRASIL';
  const identificador = apenasAscii(txid, 25).replace(/[^A-Za-z0-9]/g, '') || '***';
  const quantia = valorPix(valor);

  const contaDoRecebedor = campo('00', 'br.gov.bcb.pix') + campo('01', chaveLimpa);

  let codigo =
    campo('00', '01') +
    campo('26', contaDoRecebedor) +
    campo('52', '0000') +
    campo('53', '986') +
    (quantia ? campo('54', quantia) : '') +
    campo('58', 'BR') +
    campo('59', nomeLimpo) +
    campo('60', cidadeLimpa) +
    campo('62', campo('05', identificador));

  // O CRC entra por último e cobre inclusive o "6304" do próprio campo.
  codigo += '6304';
  return codigo + crc16(codigo);
}

module.exports = { montarBrCode, crc16, normalizarChave, apenasAscii };
