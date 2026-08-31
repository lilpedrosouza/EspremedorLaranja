'use strict';

/**
 * O visual das mensagens do Espremedor de Laranja.
 *
 * Só monta texto — não fala com o banco, com HTTP nem com o Brevo, igual a
 * `lib/pix.js`. Recebe o conteúdo já escrito e devolve as duas versões da
 * mensagem, HTML e texto puro, a partir da mesma estrutura: assim não existe o
 * clássico e-mail em que o HTML foi atualizado e o texto puro ficou dizendo
 * outra coisa.
 *
 * E-mail não é página web, e quase tudo que se usa na tela é proibido aqui:
 *
 * - **Tabelas para o leiaute.** O Outlook desenha com o motor do Word, que não
 *   conhece flexbox nem grid. Tabela aninhada é feia e é o que funciona.
 * - **Estilo escrito em cada tag.** Bloco `<style>` some em vários clientes, e
 *   o Gmail o descarta quando a mensagem é encaminhada ou fica grande demais.
 * - **Fonte do sistema.** Fonte da web não carrega; o que não existir na
 *   máquina de quem lê vira Times New Roman.
 * - **Nenhuma imagem.** A laranja do site é um SVG, e o Gmail apaga SVG por
 *   completo. Além disso, imagem costuma vir bloqueada até a pessoa liberar,
 *   então um cabeçalho feito de imagem chega em branco. O emoji 🍊 aparece em
 *   qualquer cliente, não é bloqueado e não pesa nada.
 */

/** As mesmas cores do `publico/estilo.css`, escritas na mão porque CSS não chega aqui. */
const COR = {
  fundo: '#eceef0',
  papel: '#ffffff',
  linha: '#dde0e4',
  tinta: '#1d1f22',
  tintaFraca: '#6b7076',
  casca: '#a8410a'
};

const FONTE = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapar(texto) {
  return String(texto == null ? '' : texto).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * O texto que aparece na lista de mensagens, ao lado do assunto.
 *
 * Os caracteres invisíveis no fim empurram para longe o resto do corpo: sem
 * eles o Gmail completa a prévia com o começo do e-mail, e a lista mostra
 * "Oi, Fulano. Alguém pediu..." em vez do resumo que a gente escolheu.
 */
function preheader(texto) {
  const enchimento = '&#847;&zwnj;&nbsp;'.repeat(60);
  return (
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
    `${escapar(texto)}${enchimento}</div>`
  );
}

/**
 * O botão.
 *
 * Feito de tabela com cor de fundo na célula, e não de `<a>` estilizado: no
 * Outlook o `padding` de um link é ignorado e o botão encolhe até virar um
 * texto sublinhado. A cor vai também no atributo `bgcolor`, que é o que os
 * clientes antigos leem.
 */
function botao({ texto, url }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 22px;">
    <tr>
      <td align="center" bgcolor="${COR.casca}" style="border-radius:8px;">
        <a href="${escapar(url)}" style="display:inline-block;padding:14px 30px;font-family:${FONTE};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;">${escapar(texto)}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Monta a mensagem inteira.
 *
 * @param {object} conteudo
 * @param {string} conteudo.resumo       o que aparece na prévia da caixa de entrada
 * @param {string} conteudo.saudacao     "Oi, Fulano."
 * @param {string[]} conteudo.paragrafos o corpo, um item por parágrafo
 * @param {object} [conteudo.acao]       { texto, url } do botão
 * @param {string} [conteudo.alternativa] a frase que antecede o endereço copiável
 * @param {string[]} [conteudo.rodape]   as linhas miúdas do fim
 */
function montar({ resumo, saudacao, paragrafos = [], acao, alternativa, rodape = [] }) {
  const paragrafoHtml = (texto) =>
    `<p style="margin:0 0 14px;font-family:${FONTE};font-size:15px;line-height:1.6;color:${COR.tinta};">${escapar(texto)}</p>`;

  const rodapeHtml = rodape
    .map(
      (linha) =>
        `<p style="margin:0 0 8px;font-family:${FONTE};font-size:13px;line-height:1.55;color:${COR.tintaFraca};">${escapar(linha)}</p>`
    )
    .join('');

  const alternativaHtml = acao && alternativa
    ? `<p style="margin:0 0 6px;font-family:${FONTE};font-size:13px;line-height:1.55;color:${COR.tintaFraca};">${escapar(alternativa)}</p>
       <p style="margin:0 0 4px;font-family:${FONTE};font-size:13px;line-height:1.5;color:${COR.casca};word-break:break-all;">${escapar(acao.url)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Diz ao cliente que este desenho é claro. Sem isto o Gmail inverte as cores
     sozinho no modo escuro e o cabeçalho laranja sai num tom que não é nosso. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Espremedor de Laranja</title>
</head>
<body style="margin:0;padding:0;background-color:${COR.fundo};">
${preheader(resumo)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COR.fundo};">
  <tr>
    <td align="center" style="padding:30px 12px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;">

        <!-- cabeçalho -->
        <tr>
          <td bgcolor="${COR.casca}" style="background-color:${COR.casca};border-radius:12px 12px 0 0;padding:20px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:10px;font-size:26px;line-height:1;">&#127818;</td>
                <td>
                  <div style="font-family:${FONTE};font-size:19px;font-weight:700;color:#ffffff;line-height:1.2;">Espremedor de Laranja</div>
                  <div style="font-family:${FONTE};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#f0d6c4;padding-top:3px;">pedidos de cápsulas</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- corpo -->
        <tr>
          <td bgcolor="${COR.papel}" style="background-color:${COR.papel};border:1px solid ${COR.linha};border-top:0;border-radius:0 0 12px 12px;padding:30px 28px 26px;">
            <p style="margin:0 0 16px;font-family:${FONTE};font-size:17px;font-weight:600;color:${COR.tinta};">${escapar(saudacao)}</p>
            ${paragrafos.map(paragrafoHtml).join('')}
            ${acao ? botao(acao) : ''}
            ${alternativaHtml}
          </td>
        </tr>

        <!-- rodapé, fora do cartão -->
        <tr>
          <td style="padding:20px 28px 0;">
            ${rodapeHtml}
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;

  // A versão em texto sai da mesma estrutura, e não de uma cópia escrita à mão.
  const texto = [
    'ESPREMEDOR DE LARANJA',
    'pedidos de cápsulas',
    '',
    saudacao,
    '',
    ...paragrafos.flatMap((p) => [p, '']),
    ...(acao ? [`${acao.texto}:`, acao.url, ''] : []),
    ...(rodape.length ? ['--', ...rodape] : [])
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { html, texto };
}

module.exports = { montar, escapar, COR };
