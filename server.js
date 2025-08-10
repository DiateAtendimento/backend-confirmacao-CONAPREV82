// server.js

require('dotenv').config();
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const express     = require('express');
const cors        = require('cors');
const Joi         = require('joi');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// helper para normalizar cabeçalhos de coluna
function normalizeHeader(h) {
  return String(h)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// esquema de validação do payload
const schema = Joi.object({
  cpf: Joi.string().pattern(/^\d{11}$/).required()
});

const app = express();

/** ✅ Render fica atrás de proxy reverso — isso precisa vir ANTES do rate-limit */
app.set('trust proxy', 1);

// 1) Security headers
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
    }
  })
);

// 2) CORS restrito ao seu frontend
app.use(cors({
  origin: ['https://confirmacao-conaprev82.netlify.app']
}));

// 3) JSON body parser
app.use(express.json());

// 4) Rate limiter para /confirm (compatível IPv6; sem keyGenerator custom)
const confirmLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minuto
  max: 10,                  // até 10 requisições/minuto por IP
  standardHeaders: true,    // RateLimit-* nos headers
  legacyHeaders: false,     // desativa X-RateLimit-*
  message: { error: 'Muitas requisições. Tente novamente mais tarde.' }
});
app.use('/confirm', confirmLimiter);

// 5) Google Sheets
const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

/** ⏰ Data/hora garantidas em America/Sao_Paulo */
function nowInSaoPauloParts() {
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    H: +parts.hour, M: +parts.minute
  };
}

// cria Date em UTC “equivalente” à hora de SP (UTC-3) — sem DST atualmente
function spDate(y, m, d, H, M) {
  return new Date(Date.UTC(y, m - 1, d, H + 3, M)); // +3h para alinhar com UTC
}
function currentSpDate() {
  const { y, m, d, H, M } = nowInSaoPauloParts();
  return spDate(y, m, d, H, M);
}

/** Status das janelas do evento (sem simulação) */
function getWindowStatus() {
  const now = currentSpDate();

  // janelas do evento (12/08 08:30–17:30 e 13/08 08:30–13:00)
  const d1Start = spDate(2025, 8, 12, 8, 30), d1End = spDate(2025, 8, 12, 17, 30);
  const d2Start = spDate(2025, 8, 13, 8, 30), d2End = spDate(2025, 8, 13, 13, 0);

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

// 6) Endpoint de confirmação
app.post('/confirm', async (req, res) => {
  // validação do payload
  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: 'CPF inválido. Use 11 dígitos.' });
  }
  const { cpf } = value;

  try {
    await accessSheet();

    // perfis a checar — primeiro verificamos a inscrição (independente do horário)
    const perfis = [
      'Conselheiros','CNRPPS','Palestrantes','Staffs',
      'Convidados','COPAJURE','Patrocinadores'
    ];

    const matches = [];
    for (const aba of perfis) {
      const ws = doc.sheetsByTitle[aba];
      if (!ws) continue;

      await ws.loadHeaderRow();
      const headers   = ws.headerValues;
      const normHeads = headers.map(normalizeHeader);

      const iCpf   = normHeads.findIndex(h => h === 'cpf');
      const iNome  = normHeads.findIndex(h => h.includes('nome'));
      const iInscr = normHeads.findIndex(h => h.includes('inscricao'));
      if (iCpf < 0 || iNome < 0 || iInscr < 0) {
        throw new Error(`Aba "${aba}" sem colunas obrigatórias: ${headers.join(', ')}`);
      }

      const [cpfKey, nomeKey, inscrKey] = [iCpf, iNome, iInscr].map(i => headers[i]);
      const rows = await ws.getRows({ offset: 0, limit: ws.rowCount });

      const found = rows.find(r => {
        const raw = String(r[cpfKey] || '').trim();
        return raw.replace(/\D/g, '') === cpf;
      });

      if (found) {
        matches.push({
          aba,
          nome:      String(found[nomeKey]  || '').trim(),
          inscricao: String(found[inscrKey] || '').trim()
        });
      }
    }

    // se não achou em nenhuma aba → 404 (mesmo fora do horário)
    if (matches.length === 0) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    // escolhe quem tiver inscrição ou o primeiro
    const best = matches.find(m => m.inscricao) || matches[0];
    const { nome, inscricao } = best;

    // se mesmo assim não tiver inscrição
    if (!inscricao) {
      return res.status(400).json({ error: `Olá ${nome}, você não possui número de inscrição.` });
    }

    // verifica a janela de horário com feedback amigável
    const ws = getWindowStatus();
    if (ws.status === 'before') {
      const { nextStart, nextDay, label } = ws;
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
    if (ws.status === 'after') {
      return res.status(400).json({
        errorCode: 'EVENTO_ENCERRADO',
        message: 'O período de confirmação foi encerrado.'
      });
    }
    if (ws.status !== 'open') {
      return res.status(400).json({ error: 'Fora do horário permitido.' });
    }

    // janela aberta: define a planilha do dia
    const sheetName = ws.day; // 'Dia1' ou 'Dia2'

    // prepara a aba de check-in
    const checkin = doc.sheetsByTitle[sheetName];
    await checkin.loadHeaderRow();
    const chkHeaders = checkin.headerValues;
    const normChk    = chkHeaders.map(normalizeHeader);

    const idx = {
      inscr: normChk.findIndex(h => h.includes('inscricao')),
      nome:  normChk.findIndex(h => h.includes('nome')),
      data:  normChk.findIndex(h => h === 'data'),
      hora:  normChk.findIndex(h => h.includes('horario'))
    };
    if (Object.values(idx).some(i => i < 0)) {
      throw new Error(`Aba "${sheetName}" faltam colunas de check-in obrigatórias`);
    }
    const [chkInscrKey, chkNomeKey, chkDataKey, chkHoraKey]
      = ['inscr', 'nome', 'data', 'hora'].map(k => chkHeaders[idx[k]]);

    // detecta duplicata
    const existing = await checkin.getRows({ offset: 0, limit: checkin.rowCount });
    const dup = existing.find(r =>
      String(r._rawData[idx.inscr] || '').trim() === inscricao
    );
    if (dup) {
      return res.status(409).json({
        message:   `Inscrição já confirmada em ${dup._rawData[idx.data]} às ${dup._rawData[idx.hora]}.`,
        nome, inscricao,
        dia: sheetName,
        data: dup._rawData[idx.data],
        hora: dup._rawData[idx.hora]
      });
    }

    // grava check-in
    const now = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
    });

    await checkin.addRow({
      [chkInscrKey]: inscricao,
      [chkNomeKey]:  nome,
      [chkDataKey]:  data,
      [chkHoraKey]:  hora
    });

    // sucesso
    return res.json({ inscricao, nome, dia: sheetName, data, hora });

  } catch (err) {
    console.error('Erro no /confirm:', err);
    return res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

// health-check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
