'use strict';

/**
 * Atualiza dados/produtos.json com o que está no site da Nescafé Dolce Gusto.
 *
 *   node scripts/atualizar-produtos.js            grava as mudanças
 *   node scripts/atualizar-produtos.js --simular  só mostra o que mudaria
 *
 * O servidor já faz isso sozinho ao subir e a cada 12 horas. Este script serve
 * para rodar na mão ou por agendamento (cron), com o servidor parado ou não.
 */

const fs = require('fs');
const path = require('path');
const catalogo = require('../lib/catalogo-nescafe');

const ARQUIVO = path.join(__dirname, '..', 'dados', 'produtos.json');
const SEMENTE = path.join(__dirname, '..', 'dados-iniciais', 'produtos.json');
const simular = process.argv.includes('--simular');

function ler(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    return null;
  }
}

(async () => {
  const atual = ler(ARQUIVO) || ler(SEMENTE) || [];
  console.log(`Catálogo atual: ${atual.length} itens.`);
  console.log('Lendo o site da Nescafé (API da loja, com a página como reserva) …');

  try {
    const resultado = await catalogo.sincronizar(atual);
    console.log(`Leitura pela estratégia "${resultado.estrategia}": ${resultado.encontrados} produtos.`);
    console.log(`Novos: ${resultado.novos} · Atualizados: ${resultado.atualizados} · Sumiram do site: ${resultado.sumiram}`);
    console.log(`Com imagem: ${resultado.catalogo.filter((p) => p.imagem).length} de ${resultado.catalogo.length}.`);
    if (resultado.leituraParcial) {
      console.log('Atenção: a leitura veio incompleta — nada foi marcado como "saiu do site".');
    }

    if (simular) {
      console.log('\nModo simulação: nada foi gravado.');
      for (const item of resultado.catalogo.slice(0, 10)) {
        console.log(` - ${item.nome} — ${item.preco} — ${item.categoria}`);
      }
      return;
    }

    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.writeFileSync(ARQUIVO, JSON.stringify(resultado.catalogo, null, 2), 'utf8');
    console.log(`\nGravado em ${ARQUIVO}.`);
  } catch (falha) {
    console.error(`\nNão deu para atualizar: ${falha.message}`);
    console.error('O catálogo que já estava salvo continua valendo.');
    process.exitCode = 1;
  }
})();
