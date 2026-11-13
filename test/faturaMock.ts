/**
 * Fatura Neoenergia/Elektro SIMULADA (HTML), no estilo do layout real, para
 * testar o leitor de PDF e o robô sem dados de cliente. Não é cópia de fatura
 * real: rótulos comuns de conta de energia + bloco de GD (Lei 14.300).
 */

function mod10(bloco: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = bloco.length - 1; i >= 0; i--) {
    let p = Number(bloco[i]) * peso;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    soma += p;
    peso = peso === 2 ? 1 : 2;
  }
  const r = soma % 10;
  return r === 0 ? 0 : 10 - r;
}

/** Linha digitável de arrecadação (segmento 3 = energia), valor efetivo, DVs válidos. */
export function linhaDigitavel(valor: number): string {
  const valor11 = String(Math.round(valor * 100)).padStart(11, '0');
  const sem = '8' + '3' + '6' + valor11 + '0123' + '4567890123456789012345678'; // 43 dígitos (sem DV geral)
  const dvGeral = mod10(sem);
  const cod44 = sem.slice(0, 3) + dvGeral + sem.slice(3);
  const blocos = [0, 1, 2, 3].map((i) => cod44.slice(i * 11, i * 11 + 11));
  return blocos.map((b) => `${b}-${mod10(b)}`).join(' ');
}

export interface DadosMock {
  uc: string;
  mesNome: string; // ex.: OUT/2026
  vencimento: string; // dd/mm/aaaa
  total: string; // ex.: 1.234,56
  totalNumero: number;
  leituraAnterior: string;
  leituraAtual: string;
  proximaLeitura: string;
  dias: number;
  consumo: string;
  injetada: string;
  compensada: string;
  saldo: string;
}

export const MOCK_PADRAO: DadosMock = {
  uc: '12345678',
  mesNome: 'OUT/2026',
  vencimento: '18/11/2026',
  total: '1.234,56',
  totalNumero: 1234.56,
  leituraAnterior: '15/09/2026',
  leituraAtual: '15/10/2026',
  proximaLeitura: '14/11/2026',
  dias: 30,
  consumo: '980',
  injetada: '1.150,00',
  compensada: '930,00',
  saldo: '2.410,50',
};

export function htmlFatura(d: DadosMock = MOCK_PADRAO): string {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<style>
 body{font-family:Arial,Helvetica,sans-serif;font-size:11px;margin:24px}
 table{border-collapse:collapse;width:100%;margin:6px 0}
 td,th{border:1px solid #999;padding:3px 6px;text-align:left}
 .t{font-weight:bold;font-size:13px}
</style></head><body>
<div class="t">NEOENERGIA ELEKTRO</div>
<div>NOTA FISCAL / CONTA DE ENERGIA ELÉTRICA Nº 000.123.456 SÉRIE U</div>
<table>
 <tr><td>Código da Instalação: ${d.uc}</td><td>Mês de Referência: ${d.mesNome}</td><td>Vencimento: ${d.vencimento}</td></tr>
 <tr><td>Classificação: RESIDENCIAL - TRIFASICO</td><td>Total a Pagar: R$ ${d.total}</td><td></td></tr>
</table>
<table>
 <tr><th>Leitura Anterior</th><th>Leitura Atual</th><th>Nº de Dias</th><th>Próxima Leitura</th></tr>
 <tr><td>${d.leituraAnterior}</td><td>${d.leituraAtual}</td><td>${d.dias}</td><td>${d.proximaLeitura}</td></tr>
</table>
<table>
 <tr><td>Consumo Faturado (kWh): ${d.consumo} kWh</td></tr>
</table>
<div class="t">INFORMAÇÕES DE GERAÇÃO DISTRIBUÍDA</div>
<table>
 <tr><td>Energia Injetada: ${d.injetada} kWh</td></tr>
 <tr><td>Energia Compensada: ${d.compensada} kWh</td></tr>
 <tr><td>Saldo de Créditos Atual: ${d.saldo} kWh</td></tr>
</table>
<table>
 <tr><th>Tributo</th><th>Alíquota</th></tr>
 <tr><td>ICMS</td><td>18,00 %</td></tr>
 <tr><td>PIS/PASEP</td><td>1,1200 %</td></tr>
 <tr><td>COFINS</td><td>5,1800 %</td></tr>
 <tr><td>Valor do ICMS: R$ 187,20</td><td></td></tr>
</table>
<div class="t">HISTÓRICO DE CONSUMO</div>
<table>
 <tr><td>OUT/26 980 30</td></tr><tr><td>SET/26 1.020 31</td></tr><tr><td>AGO/26 870 29</td></tr>
</table>
<div>${linhaDigitavel(d.totalNumero)}</div>
</body></html>`;
}
