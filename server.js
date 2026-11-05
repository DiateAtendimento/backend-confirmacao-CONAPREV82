// server.js

require('dotenv').config();
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const express     = require('express');
const cors        = require('cors');
const Joi         = require('joi');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { EVENT_TIME_ZONE, getWindowStatus } = require('./event-schedule');

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
    setInscr: { Dia1: new Set(), Dia2: new Set() },
    pendingInscr: { Dia1: new Set(), Dia2: new Set() }
  }
};

const PERFIS = [
  'Conselheiros','CNRPPS','Palestrantes','Staffs','Convidados','COPAJURE','Apoiadores'
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
      return res.status(404).json({
        error: 'Não encontramos uma inscrição vinculada ao CPF informado. Verifique os dados e tente novamente.'
      });
    }

    const { nome, inscricao } = found;
    if (!inscricao) {
      return res.status(400).json({ error: `Olá ${nome}, você não possui número de inscrição.` });
    }

    // verifica janela do evento
    const requestNow = new Date();
    const win = getWindowStatus(requestNow);
    if (win.status === 'before') {
      const { nextStart, nextDay, label, message } = win;
      const diffMs = nextStart - requestNow;
      const totalMin = Math.max(0, Math.floor(diffMs / 60000));
      const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
      const mm = String(totalMin % 60).padStart(2, '0');

      return res.status(400).json({
        errorCode: 'FORA_HORARIO_AGUARDE',
        nome,
        proximoDia: nextDay,
        labelDia: label,
        iniciaEm: { horas: hh, minutos: mm },
        message
      });
    }
    if (win.status === 'after') {
      return res.status(400).json({
        errorCode: 'EVENTO_ENCERRADO',
        message: win.message
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
    const pending = state.checkin.pendingInscr[sheetName];
    if (set.has(inscricao) || pending.has(inscricao)) {
      return res.status(409).json({
        message: 'Sua presença neste dia já foi registrada.',
        nome, inscricao, dia: sheetName
      });
    }

    // data/hora SP
    const data = requestNow.toLocaleDateString('pt-BR', { timeZone: EVENT_TIME_ZONE });
    const hora = requestNow.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: EVENT_TIME_ZONE
    });

    // reserva a inscrição durante a escrita para impedir dois envios simultâneos
    pending.add(inscricao);
    try {
      // grava check-in (única operação que bate no Sheets por requisição)
      await withRetry(() => chk.ws.addRow({
        [keyInscr]: inscricao,
        [keyNome]:  nome,
        [keyData]:  data,
        [keyHora]:  hora
      }));

      // atualiza cache local para futuras duplicatas
      set.add(inscricao);
    } finally {
      pending.delete(inscricao);
    }

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
