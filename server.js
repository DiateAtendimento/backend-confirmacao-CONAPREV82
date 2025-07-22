// server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// helper para normalizar cabeçalhos de coluna
function normalizeHeader(h) {
  return h
    .normalize('NFD')                    // separa acentos
    .replace(/[\u0300-\u036f]/g, '')     // remove acentos
    .replace(/\s+/g, ' ')                // espaços únicos
    .trim()                              // tira espaços nas pontas
    .toLowerCase();
}

const app = express();
app.use(cors(), express.json());

const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// em DEV sempre 'Dia1'
function getSheetNameAndTime() {
  return 'Dia1';
  /*
  // Em produção:
  const now = new Date();
  const d = now.getDate(), m = now.getMonth()+1, y = now.getFullYear();
  const minutes = now.getHours()*60 + now.getMinutes();
  if (y===2025 && m===8 && d===12 && minutes>=510 && minutes<=1050) return 'Dia1';
  if (y===2025 && m===8 && d===13 && minutes>=510 && minutes<=780) return 'Dia2';
  throw new Error('HORARIO_INVALIDO');
  */
}

app.post('/confirm', async (req, res) => {
  const { cpf } = req.body;
  if (!cpf || !/^\d{11}$/.test(cpf)) {
    return res.status(400).json({ error: 'CPF inválido. Use 11 dígitos.' });
  }

  let sheetName;
  try {
    sheetName = getSheetNameAndTime();
  } catch {
    return res.status(400).json({ error: 'Fora do horário permitido.' });
  }

  try {
    await accessSheet();

    // 1) Buscar cadastro em qualquer perfil
    const perfis = [
      'Conselheiros','CNRPPS','Palestrantes','Staffs',
      'Convidados','COPAJURE','Patrocinadores'
    ];
    let inscritoData = null;

    for (const aba of perfis) {
      const ws = doc.sheetsByTitle[aba];
      await ws.loadHeaderRow();
      const headers   = ws.headerValues;
      const normHeads = headers.map(normalizeHeader);

      // encontra índices das colunas CPF, Nome e Inscrição
      const iCpf   = normHeads.findIndex(h => h === 'cpf');
      const iNome  = normHeads.findIndex(h => h.includes('nome'));
      const iInscr = normHeads.findIndex(h => h.includes('inscricao'));
      if (iCpf < 0 || iNome < 0 || iInscr < 0) {
        throw new Error(`Aba "${aba}" sem colunas CPF, Nome ou Inscrição: ${headers.join(', ')}`);
      }

      // deriva as chaves tal como estão no spreadsheet
      const cpfKey   = headers[iCpf];
      const nomeKey  = headers[iNome];
      const inscrKey = headers[iInscr];

      // carrega **todas** as linhas da aba, evitando o limite padrão de 1000
      const totalRows = ws.rowCount;
      const rows = await ws.getRows({ offset: 0, limit: totalRows });

      // debug: quantas linhas vieram e qual CPF estamos buscando
      console.log(
        `[DEBUG] aba="${aba}" → carregou ${rows.length} linhas; procurando CPF="${cpf}"`
      );

      // busca o registro, logando cada valor lido
      const found = rows.find(r => {
        const rawCpf  = String(r[cpfKey] || '').trim();
        const cleaned = rawCpf.replace(/\D/g, '');
        console.log(
          `[DEBUG] aba="${aba}" → rawCpf="${rawCpf}", cleaned="${cleaned}"`
        );
        return cleaned === cpf;
      });

      // debug geral do resultado
      console.log(
        `[DEBUG] aba="${aba}"`,
        `cpfKey="${cpfKey}"`,
        `nomeKey="${nomeKey}"`,
        `inscrKey="${inscrKey}"`,
        `foundCpf="${found ? found[cpfKey] : 'não encontrado'}"`
      );

      if (found) {
        inscritoData = {
          nome:      String(found[nomeKey]  || '').trim(),
          inscricao: String(found[inscrKey] || '').trim()
        };
        break;
      }
    }


    if (!inscritoData) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    // 2) Impedir sem número de inscrição
    if (!inscritoData.inscricao) {
      return res.status(400).json({
        error: `Olá ${inscritoData.nome}, você não possui número de inscrição.`
      });
    }

    // 3) Preparar check-in sheet
    const checkin = doc.sheetsByTitle[sheetName];
    await checkin.loadHeaderRow();
    const chkHeaders = checkin.headerValues;
    const normChk    = chkHeaders.map(normalizeHeader);
    const iChkInscr = normChk.findIndex(h => h.includes('inscricao'));
    const iChkNome  = normChk.findIndex(h => h.includes('nome'));
    const iChkData  = normChk.findIndex(h => h === 'data');
    const iChkHora  = normChk.findIndex(h => h.includes('horario'));
    if ([iChkInscr,iChkNome,iChkData,iChkHora].some(i => i<0)) {
      throw new Error(`Aba "${sheetName}" faltam colunas de check-in obrigatórias`);
    }
    const chkInscrKey = chkHeaders[iChkInscr];
    const chkNomeKey  = chkHeaders[iChkNome];
    const chkDataKey  = chkHeaders[iChkData];
    const chkHoraKey  = chkHeaders[iChkHora];

    // 4) Verificar duplicata via _rawData e índices já calculados
    const existing = await checkin.getRows();
    const dup = existing.find(r =>
      String(r._rawData[iChkInscr] || '').trim() === inscritoData.inscricao
    );
    if (dup) {
      return res.status(409).json({
        message:   `Inscrição já confirmada em ${dup._rawData[iChkData]} às ${dup._rawData[iChkHora]}.`,
        nome:      inscritoData.nome,
        inscricao: inscritoData.inscricao,
        dia:       sheetName,
        data:      dup._rawData[iChkData],
        hora:      dup._rawData[iChkHora],
      });
    }

    // 5) Gravar check-in
    const now  = new Date();
    const data = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });

    await checkin.addRow({
      [chkInscrKey]: inscritoData.inscricao,
      [chkNomeKey]:  inscritoData.nome,
      [chkDataKey]:  data,
      [chkHoraKey]:  hora
    });

    return res.json({
      inscricao: inscritoData.inscricao,
      nome:      inscritoData.nome,
      dia:       sheetName,
      data,
      hora
    });

  } catch (err) {
    console.error('Erro no /confirm:', err);
    const msg = err.message || 'Erro interno. Tente novamente.';
    return res.status(500).json({ error: msg });
  }
});

// health-check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
