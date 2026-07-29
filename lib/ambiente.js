'use strict';

/**
 * Lê um arquivo .env na raiz do projeto e joga o conteúdo em process.env.
 *
 * Existe para você rodar local com um `node servidor.js` seco, sem precisar
 * exportar variável na mão nem instalar dotenv. Nas hospedagens (Railway) não
 * há .env: as variáveis já vêm prontas no ambiente, e este módulo não faz nada.
 *
 * O que já estiver definido no ambiente ganha do arquivo.
 */

const fs = require('fs');
const path = require('path');

function carregar(arquivo = path.join(__dirname, '..', '.env')) {
  let texto;
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return false;
  }

  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;

    const igual = limpa.indexOf('=');
    if (igual === -1) continue;

    const nome = limpa.slice(0, igual).trim();
    if (!nome || process.env[nome] !== undefined) continue;

    let valor = limpa.slice(igual + 1).trim();
    const aspas = valor[0];
    if ((aspas === '"' || aspas === "'") && valor.endsWith(aspas) && valor.length > 1) {
      valor = valor.slice(1, -1);
    }
    process.env[nome] = valor;
  }
  return true;
}

module.exports = { carregar };
