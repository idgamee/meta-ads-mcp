// Uso: AB_USER=... AB_PASS=... node scripts/appbarber-relatorio-financeiro.cjs <pasta-saida>
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'https://sistema.appbarber.com.br';
const UNIDADE = 'Unidade São Caetano';
const TIPO_RELATORIO = '36'; // Relatório Detalhado de Movimentações

(async () => {
  const out = process.argv[2] || '.';
  if (!process.env.AB_USER || !process.env.AB_PASS) throw new Error('Defina AB_USER e AB_PASS');

  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dd = n => String(n).padStart(2, '0');
  const mes = `${dd(hoje.getMonth() + 1)}/${hoje.getFullYear()}`;
  const ini = `01/${mes}`;
  const fim = `${dd(hoje.getDate())}/${mes}`;

  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  // O servidor leva ~1 min para responder e o proxy do navegador corta em 30s; buscar pelo Node evita o corte.
  await p.route('**/buscaRelGerencialVendaItens.php*', async route => {
    await route.fulfill({ response: await route.fetch({ timeout: 900000 }) });
  });

  await p.goto(`${BASE}/login.php`, { waitUntil: 'networkidle' });
  await p.getByText('Rejeitar não essenciais').click({ timeout: 5000 }).catch(() => {});
  await p.fill('#login-name', process.env.AB_USER);
  await p.fill('#login-pass', process.env.AB_PASS);
  await p.click('#login-button');
  await p.getByText(UNIDADE).click();
  await p.waitForURL(/index\.php/, { timeout: 30000 });
  await p.waitForLoadState('networkidle');

  await p.goto(`${BASE}/index.php#/relatoriogerencialfinanceiro`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#DataIni', { timeout: 60000 });
  await p.waitForSelector(`#Tipo option[value="${TIPO_RELATORIO}"]`, { state: 'attached', timeout: 60000 });
  await p.evaluate(([a, z]) => {
    for (const [id, v] of [['DataIni', a], ['DataFim', z]]) {
      const e = document.getElementById(id);
      e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, [ini, fim]);
  await p.selectOption('#Tipo', TIPO_RELATORIO);
  await p.waitForTimeout(3000);
  await p.waitForLoadState('networkidle');
  await p.locator('#btnBuscaRelFinanceiro:visible').click();

  const btn = p.locator('.buttons-excel:visible').first();
  await btn.waitFor({ timeout: 120000 });
  const tabela = await btn.getAttribute('aria-controls');
  await p.waitForFunction(id => jQuery('#' + id).DataTable().rows().count() > 0, tabela, { timeout: 900000 });
  const linhas = await p.evaluate(id => jQuery('#' + id).DataTable().rows().count(), tabela);

  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 120000 }),
    p.evaluate(id => jQuery('#' + id).DataTable().button('.buttons-excel').trigger(), tabela),
  ]);
  fs.mkdirSync(out, { recursive: true });
  const arquivo = `${out}/Relatorio_Financeiro_${ini.replace(/\//g, '-')}_a_${fim.replace(/\//g, '-')}.xlsx`;
  await dl.saveAs(arquivo);
  await b.close();
  console.log(JSON.stringify({ arquivo, linhas, periodo: `${ini} a ${fim}` }));

  if (process.env.BREVO_API_KEY) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.EMAIL_FROM, name: 'Relatório AppBarber' },
        to: [{ email: process.env.EMAIL_TO }],
        subject: `Relatório Financeiro São Caetano - ${ini} a ${fim}`,
        textContent: `Segue o Relatório Detalhado de Movimentações (${UNIDADE}) de ${ini} a ${fim}: ${linhas} movimentações.`,
        attachment: [{ name: arquivo.split('/').pop(), content: fs.readFileSync(arquivo).toString('base64') }],
      }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
    console.log('EMAIL ENVIADO para', process.env.EMAIL_TO);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
