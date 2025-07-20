require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(cors(), express.json());

// Decodifica e parseia o JSON inteiro da conta de serviço
const creds = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_B64, 'base64').toString('utf8')
);
const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function accessSheet() {
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
}

// em DEV sempre escreve na aba "Dia1"
function getSheetNameAndTime() {
  // comente as validações reais e libere esta linha em DEV:
  return 'Dia1';
  // — em produção você reabilita esta lógica:
  /*
  const now = new Date();
  const dia = now.getDate();
  const mes = now.getMonth()+1;
  const ano = now.getFullYear();
  const minutos = now.getHours()*60 + now.getMinutes();
  if (ano === 2025 && mes === 8 && dia === 12 && minutos>=510 && minutos<=1050) return 'Dia1';
  if (ano === 2025 && mes === 8 && dia === 13 && minutos>=510 && minutos<=780) return 'Dia2';
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
    
    // nomes das abas onde buscamos o cadastro
    const perfis = ['Conselheiros', 'CNRPPS', 'Palestrantes', 'Staffs'];
    let inscritoData = null;

    for (const aba of perfis) {
      const perfilSheet = doc.sheetsByTitle[aba];
      await perfilSheet.loadHeaderRow();
      const headers = perfilSheet.headerValues;
      // detecta dinamicamente a coluna de inscrição e a de nome
      const inscrKey = headers.find(h => h.toLowerCase().includes('inscri'));
      const nomeKey   = headers.find(h => h.toLowerCase().includes('nome'));
      const rows = await perfilSheet.getRows();
      const found = rows.find(r =>
        String(r.CPF).replace(/\D/g, '') === cpf
      );
      if (found) {
        inscritoData = {
          inscricao: String(found[inscrKey] || '').trim(),
          nome:      String(found[nomeKey]   || '').trim()
        };
        break;
      }
    }

    if (!inscritoData) {
      return res.status(404).json({ error: 'CPF não inscrito.' });
    }

    // adiciona check-in em 'Dia1' (ou 'Dia2' conforme getSheetNameAndTime)
    const checkinSheet = doc.sheetsByTitle[sheetName];
    // 1) Carrega todas as linhas existentes
    const existingRows = await checkinSheet.getRows();

    // 2) Procura por alguma linha cujo 'NUMERO DE INSCRIÇÃO' coincida
    const foundCheckin = existingRows.find(r =>
      String(r['NUMERO DE INSCRIÇÃO']).trim() === inscritoData.inscricao
    );

    if (foundCheckin) {
      // 3) Se já tiver, retorna mensagem informando data e horário originais
      return res.status(409).json({
        Error: `Inscrição já confirmada em ${foundCheckin['DATA']} às ${foundCheckin['HORÁRIO']}.`
      });
    }

    const now = new Date();
    const data = now.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    });
    const hora = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });


    await checkinSheet.addRow({
      'NUMERO DE INSCRIÇÃO': inscritoData.inscricao,
      'NOME':                inscritoData.nome,
      'DATA':                data,
      'HORÁRIO':             hora
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
    return res.status(500).json({ error: err.message });
  }
});

// health‐check
app.get('/', (_req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
