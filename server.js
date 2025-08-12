// server.js

require('dotenv').config();
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const express     = require('express');
const cors        = require('cors');
const Joi         = require('joi');
const { GoogleSpreadsheet } = require('google-spreadsheet');

/* ===================== Helpers ===================== */

// normaliza cabeçalhos (acentos, espaços, caixa)
function normalizeHeader(h) {
  return String(h)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// escolhe o índice da coluna "inscrição" evitando pegar "status da inscrição", "situação", etc.
function pickInscricaoIndex(normHeads) {
  // candidatos que contêm "inscr"
  const cand = normHeads
    .map((h, i) => ({ h, i }))
    .filter(x => x.h.includes('inscr'));
  if (cand.length === 0) return -1;

  // descarta colunas de status/situação/tipo
  const cleaned = cand.filter(x =>
    !x.h.includes('status') &&
    !x.h.includes('situacao') &&
    !x.h.includes('tipo') &&
    !x.h.includes('categoria')
  );
  if (cleaned.length) return cleaned[0].i;

  // fallback: primeiro candidato
  return cand[0].i;
}

// validação do payload
const schema = Joi.object({
  cpf: Joi.string().pattern(/^\d{11}$/).required()
});

// horário SP
function nowInSaoPauloParts() {
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { y: +parts.year, m: +parts.month, d: +parts.day, H: +parts.hour, M: +parts.minute };
}

// cria Date em UTC “equivalente” à hora de SP (UTC-3) — sem DST atualmente
function spDate(y, m, d, H, M) {
  return new Date(Date.UTC(y, m - 1, d, H + 3, M)); // +3h para alinhar com UTC
}
function currentSpDate() {
  const { y, m, d, H, M } = nowInSaoPauloParts();
  return spDate(y, m, d, H, M);
}

// status da janela do evento
function getWindowStatus() {
  const now = currentSpDate();

  // janelas do evento — ✔️ 12/08 08:30–19:00 e 13/08 08:30–15:00
  const d1Start = spDate(2025, 8, 12, 8, 30), d1End = spDate(2025, 8, 12, 19, 35);
  const d2Start = spDate(2025, 8, 13, 8, 30), d2End = spDate(2025, 8, 13, 15, 0);

  if (now >= d1Start && now <= d1End) return { status: 'open', day: 'Dia1' };
  if (now >= d2Start && now <= d2End) return { status: 'open', day: 'Dia2' };

  if (now < d1Start) {
    return { status: 'before', nextDay: 'Dia1', nextStart: d1Start, label: 'primeiro dia' };
  }
  if (now > d1End && now < d2Start) {
    return { status: 'before', nextDay: 'Dia2', nextStart: d2Start, label: 'segundo dia' };
  }
  if (now > d2End) {
    return { status: 'after' }; // evento encerrado
  }
  return { status: 'unknown' }; // fallback
}

/* ===================== App base ===================== */

const app = express();

// Render fica atrás de proxy reverso — precisa vir ANTES do rate-limit
app.set('trust proxy', 1);

// Security headers + CSP mínima
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
    }
  })
);

// CORS restrito ao seu frontend (permite configurar via env)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://confirmacao-conaprev82.netlify.app';
app.use(cors({ origin: [FRONTEND_ORIGIN] }));

// Parser JSON
app.use(express.json());

// Rate limiter por rota /confirm
const confirmLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minuto
  max: 10,                  // até 10 requisições/minuto por IP
  standardHeaders: true,    // RateLimit-* nos headers
  legacyHeaders: false,     // desativa X-RateLimit-*
  message: { error: 'Muitas requisições. Tente novamente mais tarde.' }
});
app.use('/confirm', confirmLimiter);

// (Opcional) limiter global suave para proteger a cota da service account
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,                 // total do serviço por minuto (ajuste se necessário)
  standardHeaders: true,
  legacyHeaders: false
});
app.use(globalLimiter);

/* ===================== Google Sheets (boot + cache) ===================== */

const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

// estado em memória
const state = {
  ready: false,
  // índice: cpf -> { nome, inscricao, aba }
  indexByCPF: new Map(),
  // cache de checkin por dia
  checkin: {
    Dia1: { ws: null, headers: null, idx: null },
    Dia2: { ws: null, headers: null, idx: null },
    setInscr: { Dia1: new Set(), Dia2: new Set() }
  }
};

const PERFIS = [
  'Conselheiros','CNRPPS','Palestrantes','Staffs','Convidados','COPAJURE','Patrocinadores'
];

async function initSheets() {
  // autentica e carrega metadados — uma vez no boot/refresh
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();

  // (re)monta índice de CPFs
  const newIndex = new Map();

  for (const aba of PERFIS) {
    const ws = doc.sheetsByTitle[aba];
    if (!ws) continue;

    await ws.loadHeaderRow();
    const headers = ws.headerValues || [];
    const norm    = headers.map(normalizeHeader);

    const iCpf   = norm.findIndex(h => h === 'cpf');
    const iNome  = norm.findIndex(h => h.includes('nome'));
    const iInscr = pickInscricaoIndex(norm);
    if (iCpf < 0 || iNome < 0 || iInscr < 0) {
      console.warn(`⚠️ Aba "${aba}" sem colunas obrigatórias. Headers: ${headers.join(', ')}`);
      continue;
    }

    // lê todas as linhas uma vez no boot (conta leitura apenas aqui)
    const rows = await ws.getRows();
    for (const r of rows) {
      const cpf = String(r[headers[iCpf]] || '').replace(/\D/g, '');
      if (!cpf) continue;

      const nome      = String(r[headers[iNome]]  || '').trim();
      const inscricao = String(r[headers[iInscr]] || '').trim();

      if (!newIndex.has(cpf)) {
        // primeira ocorrência
        newIndex.set(cpf, { aba, nome, inscricao });
      } else {
        // já existe — se a existente NÃO tem inscrição e esta tem, sobrescreve
        const cur = newIndex.get(cpf);
        if (!cur.inscricao && inscricao) {
          newIndex.set(cpf, { aba, nome, inscricao });
        }
        // se ambas têm/ambas não têm, mantém a primeira (estável)
      }
    }
  }

  // prepara cache dos checkins (Dia1 e Dia2)
  for (const day of ['Dia1', 'Dia2']) {
    const ws = doc.sheetsByTitle[day];
    if (!ws) continue;

    await ws.loadHeaderRow();
    const headers = ws.headerValues || [];
    const norm    = headers.map(normalizeHeader);

    const iInscr = pickInscricaoIndex(norm);
    const iNome  = norm.findIndex(h => h.includes('nome'));
    const iData  = norm.findIndex(h => h === 'data');
    const iHora  = norm.findIndex(h => h.includes('horario'));

    if ([iInscr, iNome, iData, iHora].some(i => i < 0)) {
      console.warn(`⚠️ Aba "${day}" faltando colunas obrigatórias (inscricao/nome/data/horario).`);
      continue;
    }

    state.checkin[day].ws = ws;
    state.checkin[day].headers = headers;
    state.checkin[day].idx = { iInscr, iNome, iData, iHora };

    // carrega set de inscrições já confirmadas (uma leitura no boot/refresh)
    const rows = await ws.getRows();
    const set = state.checkin.setInscr[day];
    set.clear();
    for (const r of rows) {
      const val = String(r[headers[iInscr]] || '').trim();
      if (val) set.add(val);
    }
  }

  state.indexByCPF = newIndex;
  state.ready = true;
  console.log(`✅ Índices carregados. Registros indexados: ${state.indexByCPF.size}`);
}

// recarrega índices em background a cada N minutos (padrão 10)
const REFRESH_MINUTES = parseInt(process.env.REFRESH_MINUTES || '10', 10);
setInterval(() => {
  initSheets().catch(err => console.error('Erro no refresh dos índices:', err?.message || err));
}, REFRESH_MINUTES * 60 * 1000);

// inicializa no boot
initSheets().catch(err => {
  console.error('Falha ao inicializar planilhas:', err?.message || err);
});

/* =============== Util: retry com backoff p/ escrita =============== */

async function withRetry(fn, tries = 3, baseMs = 300) {
  try {
    return await fn();
  } catch (e) {
    const status = e?.response?.status || e?.code;
    if (tries > 1 && (status === 429 || status === 'ECONNRESET' || status === 'ETIMEDOUT')) {
      const wait = baseMs * Math.pow(2, 3 - tries); // 300ms, 600ms, 1200ms
      await new Promise(r => setTimeout(r, wait));
      return withRetry(fn, tries - 1, baseMs);
    }
    throw e;
  }
}

/* ===================== Rotas ===================== */

// health-check
app.get('/', (_req, res) => res.send('OK'));

// confirmação
app.post('/confirm', async (req, res) => {
  // valida payload
  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: 'CPF inválido. Use 11 dígitos.' });
  }
  const { cpf } = value;

  // garante boot
  if (!state.ready) {
    return res.status(503).json({ error: 'Serviço iniciando. Tente novamente em instantes.' });
  }

  try {
    // busca no índice em memória
    const found = state.indexByCPF.get(cpf);
    if (!found) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    const { nome, inscricao } = found;
    if (!inscricao) {
      return res.status(400).json({ error: `Olá ${nome}, você não possui número de inscrição.` });
    }

    // verifica janela do evento
    const win = getWindowStatus();
    if (win.status === 'before') {
      const { nextStart, nextDay, label } = win;
      const now = currentSpDate();
      const diffMs = nextStart - now;
      const totalMin = Math.max(0, Math.floor(diffMs / 60000));
      const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
      const mm = String(totalMin % 60).padStart(2, '0');

      return res.status(400).json({
        errorCode: 'FORA_HORARIO_AGUARDE',
        nome,
        proximoDia: nextDay,
        labelDia: label,
        iniciaEm: { horas: hh, minutos: mm },
        message: `${nome}, faltam ${hh}h${mm} para o início do ${label} do CONAPREV 2025. Aguarde que já vamos liberar o sistema para a confirmação da sua presença no Evento! 🚀`
      });
    }
    if (win.status === 'after') {
      return res.status(400).json({
        errorCode: 'EVENTO_ENCERRADO',
        message: 'O período de confirmação foi encerrado.'
      });
    }
    if (win.status !== 'open') {
      return res.status(400).json({ error: 'Fora do horário permitido.' });
    }

    // janela aberta — define planilha do dia
    const sheetName = win.day; // 'Dia1' ou 'Dia2'
    const chk = state.checkin[sheetName];

    if (!chk?.ws || !chk?.headers || !chk?.idx) {
      return res.status(500).json({ error: `Configuração da aba "${sheetName}" incompleta.` });
    }

    const { iInscr, iNome, iData, iHora } = chk.idx;
    const keyInscr = chk.headers[iInscr];
    const keyNome  = chk.headers[iNome];
    const keyData  = chk.headers[iData];
    const keyHora  = chk.headers[iHora];

    // duplicata sem reler a planilha
    const set = state.checkin.setInscr[sheetName];
    if (set.has(inscricao)) {
      return res.status(409).json({
        message: 'Inscrição já confirmada anteriormente.',
        nome, inscricao, dia: sheetName
      });
    }

    // data/hora SP
    const now = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    // grava check-in (única operação que bate no Sheets por requisição)
    await withRetry(() => chk.ws.addRow({
      [keyInscr]: inscricao,
      [keyNome]:  nome,
      [keyData]:  data,
      [keyHora]:  hora
    }));

    // atualiza cache local para futuras duplicatas
    set.add(inscricao);

    // sucesso
    return res.json({ inscricao, nome, dia: sheetName, data, hora });

  } catch (err) {
    console.error('Erro no /confirm:', err);
    const status = err?.response?.status;
    if (status === 429) {
      return res.status(503).json({ error: 'Serviço momentaneamente ocupado. Tente novamente.' });
    }
    return res.status(500).json({ error: err?.message || 'Erro interno.' });
  }
});

/* ===================== Start ===================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
