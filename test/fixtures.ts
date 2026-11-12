import type { RespostaInfosimples } from '../src/infosimples/tipos.js';

/** Respostas simuladas da Infosimples, uma por grupo de comportamento. */

export function resposta200Neoenergia(opts: { uc?: string; ano?: number; mes?: number; valor?: number; vencimento?: string; proximaLeitura?: string } = {}): RespostaInfosimples {
  const { uc = '111111111', ano = 2024, mes = 9, valor = 95.37, vencimento = '06/10/2024', proximaLeitura = '10/10/2024' } = opts;
  return {
    code: 200,
    code_message: 'A requisição foi processada com sucesso.',
    errors: [],
    header: {
      api_version: 'v2',
      service: 'contas/neoenergia/download-ocr',
      parameters: { login_cnpj_md5: 'x', login_senha_md5: 'y', uc },
      billable: true,
      price: '0.3',
      elapsed_time_in_milliseconds: 522,
    },
    data_count: 1,
    data: [
      {
        data_vencimento: vencimento,
        nome: 'Exemplo de Nome',
        normalizado_valor: valor,
        uc,
        valor: `R$ ${valor.toFixed(2).replace('.', ',')}`,
        site_receipt: 'https://exemplo/receipt.pdf',
        ocr: [
          {
            mes,
            ano,
            valor: `R$ ${valor.toFixed(2).replace('.', ',')}`,
            normalizado_valor: valor,
            vencimento,
            leitura_data: '12/09/2024',
            leitura_proxima_data: proximaLeitura,
            numero_dias: 34,
            codigo_barras: '123456789012345678901234567890123456789012345678',
            nota_fiscal: { numero_serie: 'Nº 111 Série X', apresentacao_data: '13/09/2024' },
            cliente: { cpf: '123.456.789-01', nome: 'Exemplo de Nome', instalacao: uc },
            consumo: { medidor: '1111111', leitura_atual: '8' },
            energia: { historico_consumo: [{ periodo: 'SET/24', kwh: '100.0' }, { periodo: 'AGO/24', kwh: '0.0' }] },
            composicao_fornecimento: { normalizado_tributos: 20.21, normalizado_energia: 22.27 },
            itens_fatura: [{ descricao: 'Energia', tarifa: '0,307900', valor: '30,79', icms: '7,03' }],
          },
        ],
      },
    ],
    site_receipts: ['https://exemplo/receipt.pdf'],
  };
}

export function resposta200Cpfl(opts: { instalacao?: string; mes?: string; valor?: number } = {}): RespostaInfosimples {
  const { instalacao = '11111111', mes = '2020/07', valor = 77.2 } = opts;
  return {
    code: 200,
    code_message: 'A requisição foi processada com sucesso.',
    errors: [],
    header: { api_version: 'v2', service: 'contas/cpfl/download-ocr', parameters: { email: 'e@e.com', instalacao }, billable: true, price: '0.28', elapsed_time_in_milliseconds: 14531 },
    data_count: 1,
    data: [
      {
        conta_paga: false,
        instalacao,
        mes,
        nome: 'Nome de Exemplo',
        normalizado_valor: valor,
        normalizado_vencimento: '25/08/2025',
        ocr: [
          {
            ano: 2020,
            cliente: { cnpj: '11.111.111/1111-11', nome: 'Nome de Exemplo', instalacao },
            codigo_barras: '111111111111111111111111111111111111111111111111',
            energia: {
              energia_ativa_injetada_te: '',
              normalizado_energia_ativa_injetada_te: 123,
              normalizado_saldo_energia_instalacao: '1',
              bandeiras_tarifarias: 'Verde',
              historico_consumo: [{ periodo: '2020 DEZ', kwh: '790', dias: '31' }],
            },
            leitura_data: '11/12/2020',
            mes: 7,
            normalizado_valor: valor,
            nota_fiscal: { pis: '1,11%', cofins: '3,84%', icms: '18,00' },
            proxima_leitura_data: '10/08/2020',
            valor: valor.toFixed(2).replace('.', ','),
            vencimento: '13/08/2020',
          },
        ],
        valor: '1147,97',
        vencimento: '2020-08-13T00:00:00',
        site_receipt: 'https://exemplo/cpfl.pdf',
      },
    ],
    site_receipts: ['https://exemplo/cpfl.pdf'],
  };
}

/** Resposta de erro genérica para um código. */
export function respostaErro(code: number, erros: string[] = []): RespostaInfosimples {
  return {
    code,
    code_message: `Erro ${code}`,
    errors: erros.length ? erros : [`detalhe interno do erro ${code}`],
    header: { service: 'contas/neoenergia/download-ocr', billable: [606, 607, 608, 611, 612, 619, 620].includes(code), price: [606, 607, 608, 611, 612, 619, 620].includes(code) ? '0.3' : '0', parameters: { uc: '1' } },
    data: [],
    data_count: 0,
    site_receipts: [],
  };
}
