import { z } from 'zod';

/**
 * Configuração do Fatureiro, validada a partir de variáveis de ambiente.
 * Falha cedo e com mensagem clara quando algo obrigatório está ausente.
 */

const bool = (padrao: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? padrao : ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase())));

const num = (padrao: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? padrao : Number(v)))
    .pipe(z.number().finite());

const EsquemaEnv = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  INFOSIMPLES_TOKEN: z.string().optional().default(''),
  INFOSIMPLES_ENCRYPTION_KEY: z.string().optional().default(''),
  INFOSIMPLES_TIMEOUT_S: num(600).pipe(z.number().min(15).max(600)),
  INFOSIMPLES_HTTP_TIMEOUT_S: num(620).pipe(z.number().min(16)),

  FATUREIRO_COFRE_CHAVE: z.string().optional().default(''),

  FATUREIRO_TETO_MENSAL_BRL: num(300).pipe(z.number().min(0)),
  FATUREIRO_CONCORRENCIA: num(2).pipe(z.number().int().min(1).max(5)),
  FATUREIRO_MAX_TENTATIVAS_DIA: num(3).pipe(z.number().int().min(1).max(10)),
  FATUREIRO_MAX_TENTATIVAS_CICLO: num(4).pipe(z.number().int().min(1).max(20)),
  FATUREIRO_DIAS_APOS_LEITURA: num(3).pipe(z.number().int().min(0).max(31)),
  FATUREIRO_REAGENDAR_DUPLICADA_DIAS: num(3).pipe(z.number().int().min(1).max(31)),
  FATUREIRO_TAXA_SUCESSO_MINIMA: num(0.5).pipe(z.number().min(0).max(1)),

  ARMAZENAMENTO: z.enum(['local', 's3']).optional().default('local'),
  ARMAZENAMENTO_LOCAL_DIR: z.string().optional().default('./dados/pdfs'),
  S3_BUCKET: z.string().optional().default(''),
  S3_REGION: z.string().optional().default('sa-east-1'),
  S3_ENDPOINT: z.string().optional().default(''),

  ALERTA_WEBHOOK_URL: z.string().optional().default(''),
  LOG_NIVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
});

export type Config = {
  databaseUrl: string;
  infosimples: {
    token: string;
    chaveCriptografia: string;
    timeoutS: number;
    httpTimeoutS: number;
  };
  cofreChave: string;
  lote: {
    tetoMensalBrl: number;
    concorrencia: number;
    maxTentativasDia: number;
    maxTentativasCiclo: number;
    diasAposLeitura: number;
    reagendarDuplicadaDias: number;
    taxaSucessoMinima: number;
  };
  armazenamento: {
    tipo: 'local' | 's3';
    localDir: string;
    s3Bucket: string;
    s3Region: string;
    s3Endpoint: string;
  };
  alertaWebhookUrl: string;
  logNivel: 'debug' | 'info' | 'warn' | 'error';
};

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = EsquemaEnv.safeParse(env);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${problemas}`);
  }
  const e = r.data;
  if (e.INFOSIMPLES_HTTP_TIMEOUT_S <= e.INFOSIMPLES_TIMEOUT_S) {
    throw new Error(
      `INFOSIMPLES_HTTP_TIMEOUT_S (${e.INFOSIMPLES_HTTP_TIMEOUT_S}) deve ser MAIOR que INFOSIMPLES_TIMEOUT_S (${e.INFOSIMPLES_TIMEOUT_S}), ` +
        'senão o cliente HTTP aborta antes de a API poder responder 605.',
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    infosimples: {
      token: e.INFOSIMPLES_TOKEN,
      chaveCriptografia: e.INFOSIMPLES_ENCRYPTION_KEY,
      timeoutS: e.INFOSIMPLES_TIMEOUT_S,
      httpTimeoutS: e.INFOSIMPLES_HTTP_TIMEOUT_S,
    },
    cofreChave: e.FATUREIRO_COFRE_CHAVE,
    lote: {
      tetoMensalBrl: e.FATUREIRO_TETO_MENSAL_BRL,
      concorrencia: e.FATUREIRO_CONCORRENCIA,
      maxTentativasDia: e.FATUREIRO_MAX_TENTATIVAS_DIA,
      maxTentativasCiclo: e.FATUREIRO_MAX_TENTATIVAS_CICLO,
      diasAposLeitura: e.FATUREIRO_DIAS_APOS_LEITURA,
      reagendarDuplicadaDias: e.FATUREIRO_REAGENDAR_DUPLICADA_DIAS,
      taxaSucessoMinima: e.FATUREIRO_TAXA_SUCESSO_MINIMA,
    },
    armazenamento: {
      tipo: e.ARMAZENAMENTO,
      localDir: e.ARMAZENAMENTO_LOCAL_DIR,
      s3Bucket: e.S3_BUCKET,
      s3Region: e.S3_REGION,
      s3Endpoint: e.S3_ENDPOINT,
    },
    alertaWebhookUrl: e.ALERTA_WEBHOOK_URL,
    logNivel: e.LOG_NIVEL,
  };
}
