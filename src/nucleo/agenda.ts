/** Cálculos de agendamento. Puros e testáveis, sem I/O. */

export interface RegrasAgenda {
  diasAposLeitura: number;
  reagendarDuplicadaDias: number;
}

function adicionarDias(base: Date, dias: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
}

export function hojeUTC(agora: Date = new Date()): Date {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

/**
 * Próxima consulta após um SUCESSO. Como a API devolve sempre a conta mais recente,
 * consultamos alguns dias depois da "próxima leitura" informada na fatura.
 * Se não houver próxima leitura, cai para ~30 dias após hoje.
 */
export function proximaConsultaAposSucesso(
  proximaLeituraISO: string | null,
  regras: RegrasAgenda,
  agora: Date = new Date(),
): Date {
  if (proximaLeituraISO) {
    const base = new Date(`${proximaLeituraISO}T00:00:00Z`);
    if (!Number.isNaN(base.getTime())) {
      const alvo = adicionarDias(base, regras.diasAposLeitura);
      const amanha = adicionarDias(hojeUTC(agora), 1);
      // Nunca agendar no passado nem para hoje: no mínimo amanhã.
      return alvo.getTime() < amanha.getTime() ? amanha : alvo;
    }
  }
  return adicionarDias(hojeUTC(agora), 30);
}

/** Reagendamento quando veio um mês já capturado (duplicada). */
export function reagendarDuplicada(regras: RegrasAgenda, agora: Date = new Date()): Date {
  return adicionarDias(hojeUTC(agora), regras.reagendarDuplicadaDias);
}

/** Reagendamento curto para um retry de erro transitório que estourou o limite do dia. */
export function reagendarAmanha(agora: Date = new Date()): Date {
  return adicionarDias(hojeUTC(agora), 1);
}
