// index.js
import 'dotenv/config';

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import speech from '@google-cloud/speech';
import multer from 'multer';
import cors from 'cors';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';

// Vertex AI
import { VertexAI } from '@google-cloud/vertexai';

// --- Funções de Log Padronizadas ---
const log = (prefix, message, ...args) =>
  console.log(`[${new Date().toISOString()}] [${prefix}]`, message, ...args);

// --- Configurações iniciais ---
const app = express();
const server = http.createServer(app);

// Socket.io configurado para Cloud Run
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const upload = multer();

// CORS configurado para Cloud Run
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json());

// Health check endpoint para Cloud Run
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    socket: 'enabled',
    timestamp: new Date().toISOString()
  });
});

// WebSocket test endpoint
app.get('/ws-test', (req, res) => {
  res.json({ 
    status: 'ok', 
    socketEnabled: true,
    timestamp: new Date().toISOString()
  });
});

// Handle preflight
app.options('*', cors());

// --- Middleware de Logging de Requisições ---
app.use((req, res, next) => {
  log('HTTP', `Requisição recebida: ${req.method} ${req.url}`);
  next();
});

// --- Clientes ---
const speechClient = new speech.SpeechClient();
const storage = new Storage();
const vertex_ai = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: process.env.GCLOUD_LOCATION,
});

const model = 'gemini-2.0-flash-001';
const generativeModel = vertex_ai.getGenerativeModel({
  model,
  generationConfig: {
    maxOutputTokens: 8192,
    temperature: 0.2,
  },
});

/**
 * Função auxiliar para chamar o Vertex AI e centralizar o logging.
 */
const callVertexAI = async (endpointName, prompt, generationConfig = {}) => {
  log('VertexAI', `Iniciando chamada para o endpoint: ${endpointName}`);
  log(
    'VertexAI',
    `Prompt enviado:\n---INÍCIO DO PROMPT---\n${prompt}\n---FIM DO PROMPT---`
  );

  const request = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { ...generativeModel.generationConfig, ...generationConfig },
  };

  const result = await generativeModel.generateContent(request);
  const generatedText = result.response.candidates[0].content.parts[0].text;

  log('VertexAI', `Resposta recebida do endpoint ${endpointName}`);
  return generatedText.trim();
};

// ===================================
// --- WebSocket STT com Automação ---
// ===================================
io.on('connection', (socket) => {
  log('WebSocket', `Cliente conectado: ${socket.id} from ${socket.handshake.address}`);

  let recognizeStream = null;
  let recognitionConfig = null;
  let silenceTimer = null;
  let streamRestartTimer = null;
  const silenceTimeoutDuration = 10000; // 10 segundos
  const maxStreamDuration = 290 * 1000; // ~4.8 minutos

  const stopRecognizeStream = () => {
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
      log('WebSocket', `Stream de reconhecimento encerrado para: ${socket.id}`);
    }
    clearTimeout(streamRestartTimer);
    clearTimeout(silenceTimer);
  };

  const startRecognizeStream = () => {
    if (recognizeStream || !recognitionConfig) {
      log(
        'WebSocket',
        `Tentativa de iniciar stream falhou (já iniciado ou sem config) para: ${socket.id}`
      );
      return;
    }
    log(
      'WebSocket',
      `Iniciando/Reiniciando stream de reconhecimento para: ${socket.id}`
    );

    const request = { config: recognitionConfig, interimResults: true };

    recognizeStream = speechClient
      .streamingRecognize(request)
      .on('error', (err) => {
        log('SpeechAPI-ERROR', `Erro no streaming para ${socket.id}:`, err.message);
        socket.emit('error', 'Erro no reconhecimento de fala.');
        stopRecognizeStream();
      })
      .on('data', (data) => {
        const result = data.results[0];
        if (result && result.alternatives[0]) {
          const transcriptData = {
            text: result.alternatives[0].transcript,
            isFinal: result.isFinal,
            timestamp: new Date().toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            }),
            speakerTag:
              result.alternatives[0].words?.[
                result.alternatives[0].words.length - 1
              ]?.speakerTag,
          };
          
          log('WebSocket', `Enviando transcript: ${transcriptData.text.substring(0, 50)}...`);
          socket.emit('transcript-data', transcriptData);
        }
      });

    // reinício automático do stream depois de 4.8 minutos
    streamRestartTimer = setTimeout(() => {
      log(
        'WebSocket',
        `Stream atingiu a duração máxima de ${
          maxStreamDuration / 1000
        }s. Reiniciando para ${socket.id}...`
      );
      stopRecognizeStream();
      startRecognizeStream();
    }, maxStreamDuration);
  };

  const resetSilenceTimer = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      log(
        'WebSocket',
        `Silêncio detectado para ${socket.id}. Reiniciando recognizeStream no servidor.`
      );

      // 🟢 reinicia internamente sem pedir nada ao cliente
      stopRecognizeStream();
      startRecognizeStream();
    }, silenceTimeoutDuration);
  };

  socket.on('start-recording', (config) => {
    log('WebSocket', `Evento 'start-recording' recebido de ${socket.id}`, config);
    recognitionConfig = {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: config.sampleRateHertz || 48000,
      languageCode: config.lang || 'pt-BR',
      alternativeLanguageCodes: ['en-US'], 
      enableAutomaticPunctuation: true,
      diarizationConfig: {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 6,
      },
      model: 'telephony',
      useEnhanced: true,
    };
    stopRecognizeStream();
    startRecognizeStream();
    resetSilenceTimer();
  });

  socket.on('audio-data', (data) => {
    if (recognizeStream && data) {
      recognizeStream.write(data);
      resetSilenceTimer();
    } else if (!recognizeStream) {
      log(
        'WebSocket',
        `Recebido 'audio-data' de ${socket.id}, mas o stream não está pronto. Ignorando chunk.`
      );
    }
  });

  socket.on('force-flush-partial', (partial) => {
    log('WebSocket', `Evento 'force-flush-partial' recebido de ${socket.id}`);
    socket.emit('transcript-data', { ...partial, isFinal: true });
  });

  socket.on('stop-recording', () => {
    log('WebSocket', `Evento 'stop-recording' recebido de ${socket.id}`);
    stopRecognizeStream();
  });

  socket.on('disconnect', (reason) => {
    log('WebSocket', `Cliente desconectado: ${socket.id} - Reason: ${reason}`);
    stopRecognizeStream();
  });
});

// ======================
// --- Batch STT ---
// ======================
app.post('/batch-transcribe', upload.single('file'), async (req, res) => {
  const endpointName = '/batch-transcribe';
  log('API', `Iniciando ${endpointName}`);
  try {
    if (!req.file) {
      log('API-ERROR', `${endpointName} - Nenhum arquivo enviado.`);
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const audioBuffer = req.file.buffer;
    const bucketName = process.env.GCLOUD_BUCKET_NAME;
    const recordingId = uuidv4();
    const filename = `audio-${recordingId}.opus`;
    const gcsUri = `gs://${bucketName}/${filename}`;

    log('GCS', `Fazendo upload de ${filename} para o bucket ${bucketName}`);
    await storage.bucket(bucketName).file(filename).save(audioBuffer, {
      metadata: { contentType: req.file.mimetype },
    });
    log('GCS', `Upload concluído: ${gcsUri}`);

    log('SpeechAPI', `Iniciando 'longRunningRecognize' para ${gcsUri}`);
    const [operation] = await speechClient.longRunningRecognize({
      audio: { uri: gcsUri },
      config: {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'pt-BR',
        alternativeLanguageCodes: ['en-US'],
        enableAutomaticPunctuation: true,
        diarizationConfig: {
          enableSpeakerDiarization: true,
          minSpeakerCount: 2,
          maxSpeakerCount: 6,
        },
      },
    });

    const [response] = await operation.promise();
    log('SpeechAPI', `'longRunningRecognize' concluído para ${gcsUri}`);

    const structuredTranscript = [];
    let currentSegment = null;
    let lastSpeakerTag = null;

    response.results.forEach(result => {
      const alternative = result.alternatives[0];
      const transcriptText = alternative?.transcript?.trim();
      const words = alternative?.words;

      if (!transcriptText || !words || words.length === 0) return;

      const firstWord = words[0];
      const speakerTag = firstWord.speakerTag;

      if (speakerTag !== lastSpeakerTag) {
        currentSegment = {
          text: transcriptText,
          isFinal: true,
          speakerTag: speakerTag,
          timestamp: firstWord.startTime.seconds ? new Date(firstWord.startTime.seconds * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '00:00',
        };
        structuredTranscript.push(currentSegment);
        lastSpeakerTag = speakerTag;
      } else if (currentSegment) {
        currentSegment.text += ' ' + transcriptText;
      }
    });

    log('API', `Transcrição em lote estruturada com ${structuredTranscript.length} segmentos.`);
    res.json({ recordingId, audioUri: gcsUri, batchTranscript: structuredTranscript });

  } catch (err) {
    log('API-ERROR', `Erro em ${endpointName}:`, err);
    res.status(500).json({ error: 'Falha na transcrição em lote.' });
  }
});

// ==========================
// --- Endpoints Vertex AI ---
// ==========================

// --- GERAÇÃO DE TÍTULO ---
app.post('/api/generate-title', async (req, res) => {
  const endpointName = '/api/generate-title';
  try {
    const { context } = req.body;
    if (!context || typeof context !== 'string' || context.trim() === '') {
      return res.status(400).json({ error: 'O campo "context" é obrigatório.' });
    }

    const prompt = `
      Você é um assistente especializado em criar títulos curtos e objetivos para consultas médicas.
      Baseado no contexto abaixo, gere um título conciso (máx. 10 palavras) que resuma o motivo principal da consulta.
      O título deve ser claro, direto e fácil de entender. Não use markdown (como **, #) na resposta.

      Contexto: "${context}"

      Título Gerado:
    `;

    const generatedTitle = await callVertexAI(endpointName, prompt);
    res.status(200).json({ title: generatedTitle });

  } catch (error) {
    log('API-ERROR', `Erro em ${endpointName}:`, error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao gerar o título.' });
  }
});

// --- MELHORAR ANAMNESE ---
app.post('/api/melhorar-anamnese', async (req, res) => {
    const endpointName = '/api/melhorar-anamnese';
    try {
        const { anamnese, prompt } = req.body;

        if (!anamnese || typeof anamnese !== 'string' || anamnese.trim() === '') {
            return res.status(400).json({ error: 'O campo "anamnese" é obrigatório.' });
        }
        if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
            return res.status(400).json({ error: 'O campo "prompt" (instrução) é obrigatório.' });
        }

        const structuredPrompt = `
            ### Persona
            Aja como um assistente médico redator, especialista em criar documentos clínicos claros, objetivos e bem estruturados.

            ### Contexto
            O texto de uma anamnese médica precisa ser refinado com base em uma instrução específica do médico.

            ### Tarefa
            Reescreva o "Texto Original da Anamnese" abaixo, seguindo estritamente a "Instrução do Médico".

            ### Requisitos
            - O formato da resposta DEVE ser um único bloco de texto usando tags HTML simples (<p>, <strong>, <ul>, <li>).
            - O tom deve ser formal, técnico e objetivo.
            - Mantenha TODAS as informações clínicas originais. NÃO omita e NÃO invente dados.
            - Corrija erros gramaticais.

            ### Dados de Entrada
            **Instrução do Médico:**
            """
            ${prompt}
            """

            **Texto Original da Anamnese:**
            """
            ${anamnese}
            """
        `;

        const enhancedAnamnese = await callVertexAI(endpointName, structuredPrompt);
        res.status(200).json({ enhancedAnamnese });

    } catch (error) {
        log('API-ERROR', `Erro em ${endpointName}:`, error);
        res.status(500).json({ error: 'Ocorreu um erro no servidor ao processar a solicitação.' });
    }
});

// --- ROTA DE TRANSCRIÇÃO IA ---
app.post('/api/generate-ia-transcription', async (req, res) => {
  try {
    const { transcription } = req.body;

    if (!transcription || typeof transcription !== 'string' || transcription.trim() === '') {
      return res.status(400).json({
        error: 'O campo "transcription" com o array de transcrições é obrigatório.'
      });
    }

    let allTranscripts;
    try {
      allTranscripts = JSON.parse(transcription);
      if (!Array.isArray(allTranscripts)) throw new Error("Formato inválido.");
    } catch (e) {
      return res.status(400).json({ error: 'O campo "transcription" deve ser um JSON array válido.' });
    }

    const context = allTranscripts.slice(0, -1);
    const newTranscriptToProcess = allTranscripts.slice(-1);

    const contextString = context.length > 0
      ? `
Contexto da Conversa (diálogo anterior):
${JSON.stringify(context.map(t => ({ speaker: t.speaker, text: t.text })), null, 2)}
`
      : "Esta é a primeira fala da conversa.";

    const prompt = `
Você é um assistente de IA especialista em processar transcrições de consultas médicas.

⚙️ Instrução de Idioma:
- Detecte automaticamente o idioma da "Nova Transcrição".
- Se o idioma predominante for **inglês**, todas as respostas e o conteúdo do JSON devem ser **em inglês** (inclusive nomes de campos e tópicos da timeline).
- Caso contrário, use **português** como idioma padrão.
- NÃO traduza o conteúdo da transcrição; apenas mantenha o idioma original da conversa para todo o processamento.

Suas tarefas são:
1. Analisar a "Nova Transcrição", usando o "Contexto da Conversa" para manter a consistência na identificação de "Médico" e "Paciente".
2. Criar e atualizar uma "timeline" (uma lista cronológica) dos principais assuntos discutidos em TODA a conversa (contexto + nova transcrição).
3. Formatar a saída como um objeto JSON contendo a transcrição processada e a timeline de assuntos.

Instruções Detalhadas:
1. Processamento da Transcrição:
   - Corrija erros gramaticais na "Nova Transcrição".
   - Mantenha a consistência dos papéis ("Médico", "Paciente").
   - A transcrição processada deve ser um array de objetos, cada objeto representando uma fala única, com os campos obrigatórios:
     - "speakerTag"
     - "speaker"
     - "text"
     - "timestamp"
     - "isFinal"
   - ATENÇÃO: O campo "isFinal" DEVE SEMPRE ser \`true\` em todos os itens do processedTranscript.
   - Caso o texto esteja vazio ("" ou apenas espaços), não deve ser incluído no processedTranscript.

2. Geração da Timeline de Assuntos:
   - Analise o diálogo completo (contexto + nova transcrição).
   - Identifique os tópicos principais (ex: "Apresentação de sintomas", "Histórico do paciente", "Discussão sobre dor de cabeça", "Diagnóstico inicial", "Prescrição de medicação").
   - A timeline deve ser um array de strings.
   - A cada nova chamada, você deve retornar a timeline completa e atualizada, adicionando novos tópicos conforme eles surgem.

3. Formato de Saída OBRIGATÓRIO:
   - Sua resposta DEVE SER um único objeto JSON, sem nenhum texto ou markdown em volta.
   - O objeto deve ter duas chaves: "processedTranscript" (um array de objetos, cada um representando uma fala) e "timeline" (um array de strings).

---
${contextString}
---
Nova Transcrição para processar:
${JSON.stringify(newTranscriptToProcess, null, 2)}
`;

    const request = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4048,
        temperature: 0.3,
      },
    };

    const result = await generativeModel.generateContent(request);
    let generatedText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!generatedText) {
      throw new Error('Resposta vazia do modelo generativo');
    }
    
    generatedText = generatedText.trim().replace(/^```json\s*|```$/g, "").trim();
    
    let parsedJson;
    try {
      parsedJson = JSON.parse(generatedText);
      if (!parsedJson.processedTranscript || !Array.isArray(parsedJson.timeline)) {
        throw new Error("A resposta da IA não contém os campos 'processedTranscript' e 'timeline'.");
      }
    } catch (err) {
      log('API-ERROR', "Erro ao fazer parse do JSON da IA:", err, generatedText); // Corrigido
      return res.status(500).json({ error: "Falha ao processar resposta da IA. Formato JSON inválido." });
    }

    res.status(200).json({ data: parsedJson });

  } catch (error) {
    log('API-ERROR', 'Erro ao gerar transcrição via Vertex AI:', error); // Corrigido
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao processar a transcrição.' });
  }
});

// --- GERAÇÃO DE RESUMO ---
app.post('/api/generate-summary', async (req, res) => {
  const endpointName = '/api/generate-summary';
  try {
    const { transcription } = req.body;
    if (!transcription || !Array.isArray(transcription) || transcription.length === 0) {
      return res.status(400).json({ error: 'O campo "transcription" é obrigatório e deve ser um array.' });
    }

    const formattedTranscription = transcription.map(item => `${item.speakerTag || 'Pessoa'}: ${item.text}`).join('\n');

    const prompt = `
      Você é um assistente de IA focado em transcrições médicas. Sua tarefa é gerar dois resultados claros, sem usar markdown ou introduções.

      1. **Resumo da Transcrição**: Crie um resumo objetivo da consulta.
      2. **Avaliação da Transcrição**:
         - Comente se a transcrição contém informações suficientes e coerentes.
         - Aponte lacunas ou inconsistências.
         - Avalie se faz sentido, no contexto médico, usar IA para gerar resumos desta transcrição.

      A transcrição é a seguinte:
      "${formattedTranscription}"
    `;

    const generatedSummary = await callVertexAI(endpointName, prompt);
    res.status(200).json({ summary: generatedSummary });

  } catch (error) {
    log('API-ERROR', `Erro em ${endpointName}:`, error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao gerar o resumo.' });
  }
});

// --- GERAÇÃO DE ANAMNESE ---
app.post('/api/generate-anamnese', async (req, res) => {
  const endpointName = '/api/generate-anamnese';
  try {
    const { transcription, prompt, documentoSelecionado } = req.body;

    if (!transcription || !Array.isArray(transcription) || transcription.length === 0 || !documentoSelecionado) {
      return res.status(400).json({ error: 'Campos obrigatórios: transcription, documentoSelecionado.' });
    }

    const formattedTranscript = transcription.map(line => `${line.speakerTag}: ${line.text}`).join('\n');

    const fullPrompt = `
      Você é um assistente médico virtual que sumariza conversas clínicas em anamneses estruturadas.
      Sua tarefa é analisar a transcrição de uma consulta e gerar uma anamnese completa.

      Instruções Adicionais:
      ${prompt ? ` - Contexto do Paciente: "${prompt}"` : ''}
      
      O Documento deve conter as seguintes seções obrigatórias:
      ${documentoSelecionado}

      Formate o resultado em um único bloco de texto usando HTML (parágrafos, negrito, listas).

      Transcrição da consulta:
      "${formattedTranscript}"

      Anamnese Gerada (formato HTML):
    `;

    const generatedAnamnese = await callVertexAI(endpointName, fullPrompt);
    res.status(200).json({ anamnese: generatedAnamnese });

  } catch (error) {
    log('API-ERROR', `Erro em ${endpointName}:`, error);
    res.status(500).json({ error: 'Ocorreu um erro no servidor ao gerar a anamnese.' });
  }
});

// --- OBTENÇÃO DE URL DE ÁUDIO ---
app.get('/audio-url/:recordingId', async (req, res) => {
  const endpointName = '/audio-url/:recordingId';
  try {
    const bucketName = process.env.GCLOUD_BUCKET_NAME;
    const { recordingId } = req.params;
    
    // Corrigido: o nome do arquivo deve incluir o prefixo 'audio-' e a extensão '.opus'
    const filename = `audio-${recordingId}.opus`;

    log('GCS', `Buscando URL assinada para ${filename}`);
    const file = storage.bucket(bucketName).file(filename);

    const [exists] = await file.exists();
    if (!exists) {
      log('GCS-ERROR', `Arquivo não encontrado: ${filename}`);
      return res.status(404).json({ error: 'Arquivo de áudio não encontrado.' });
    }

    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutos
    });

    log('GCS', `URL assinada gerada com sucesso.`);
    res.json({ audioUrl: signedUrl });

  } catch (err) {
    log('API-ERROR', `Erro em ${endpointName}:`, err);
    res.status(500).json({ error: 'Falha ao gerar URL de áudio.' });
  }
});

app.delete('/audio/:recordingId', async (req, res) => {
  const endpointName = '/audio/:recordingId';
  try {
    const { recordingId } = req.params;

    if (!recordingId) {
      return res.status(400).json({ error: 'ID de gravação inválido.' });
    }

    const bucketName = process.env.GCLOUD_BUCKET_NAME;
    if (!bucketName) {
        log('API-ERROR', 'A variável de ambiente GCLOUD_BUCKET_NAME não está definida.');
        return res.status(500).json({ error: 'Configuração do servidor incompleta.'});
    }

    // 💡 CORREÇÃO LÓGICA: Montar o nome completo do arquivo
    const filename = `audio-${recordingId}.opus`;
    const file = storage.bucket(bucketName).file(filename);

    const [exists] = await file.exists();
    if (!exists) {
      log('GCS-ERROR', `Arquivo não encontrado no bucket '${bucketName}': ${filename}`);
      return res.status(404).json({ error: 'Arquivo de áudio não encontrado.' });
    }

    await file.delete();
    log('GCS', `Arquivo ${filename} removido do bucket ${bucketName} com sucesso.`);
    res.status(200).json({ message: 'Arquivo de áudio removido com sucesso.' });

  } catch (err) {
    log('API-ERROR', `Erro em ${endpointName}:`, err);
    res.status(500).json({ error: 'Falha interna ao remover arquivo de áudio.' });
  }
});

app.post("/api/upload-documento", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }

    const bucketName = process.env.GCLOUD_BUCKET_DOC;
    const bucket = storage.bucket(bucketName);
    const gcsFileName = `${Date.now()}_${req.file.originalname}`;
    const file = bucket.file(gcsFileName);

    await file.save(req.file.buffer, {
      contentType: req.file.mimetype,
      resumable: false,
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${gcsFileName}`;
    res.json({ url: publicUrl });
  } catch (error) {
    log('API-ERROR', "Erro ao enviar arquivo:", error); // Corrigido
    res.status(500).json({ error: "Erro ao enviar arquivo." });
  }
});

app.post("/api/process-and-summarize-documents", upload.array("documentos", 5), async (req, res) => {
  const endpointName = "/api/process-and-summarize-documents";
  log('API', `Iniciando ${endpointName}`);

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Nenhum documento enviado." });
  }

  try {
    const summaryPromises = req.files.map(async (file) => {
      log('VertexAI', `Processando arquivo: ${file.originalname} (${file.mimetype})`);

      const fileBuffer = file.buffer;
      const mimeType = file.mimetype;

      const promptParts = [];
      let promptText = "";

      const supportedImage = mimeType.startsWith('image/');
      const supportedDoc = ['application/pdf', 'text/plain', 'text/markdown'].includes(mimeType);

      if (supportedImage) {
        promptText = "Você é um assistente médico. Descreva esta imagem de forma objetiva, focando em detalhes que possam ser clinicamente relevantes. Se for um exame, descreva os achados. Se for um documento, extraia o texto e resuma-o.";
      } else if (supportedDoc) {
        promptText = "Você é um assistente médico. Resuma o conteúdo deste documento, extraindo as informações mais importantes como diagnósticos, tratamentos, resultados de exames e histórico do paciente.";
      } else {
        log('VertexAI', `Tipo de arquivo não suportado para resumo: ${mimeType}`);
        return {
          fileName: file.originalname,
          summary: [`Resumo não gerado para '${file.originalname}' - tipo de arquivo não suportado`],
        };
      }

      promptParts.push({ text: promptText });
      promptParts.push({
        inlineData: {
          mimeType: mimeType,
          data: fileBuffer.toString('base64'),
        },
      });

      const request = {
        contents: [{ role: 'user', parts: promptParts }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.3,
        },
      };

      const result = await generativeModel.generateContent(request);
      const summaryText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (summaryText) {
        return {
          fileName: file.originalname,
          summary: summaryText.trim(),
        };
      }

      return {
        fileName: file.originalname,
        summary: [`Não foi possível gerar um resumo para '${file.originalname}'`],
      };
    });

    const summaries = await Promise.all(summaryPromises);

    log('API', `Resumos gerados com sucesso para ${endpointName}`);
    res.status(200).json({ summaries });
  } catch (error) {
    log('API-ERROR', `Erro em ${endpointName}:`, error);
    res.status(500).json({
      error: "Ocorreu um erro no servidor ao processar os documentos.",
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const {comando, history } = req.body;
    if (!history || !Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: 'O campo "history" é obrigatório.' });
    }

    const systemPrompt = `
      Você é uma IA médica, assistente de consultas. Sua saída deve ser EXCLUSIVAMENTE um JSON válido.
      Nunca adicione explicações, comentários ou texto fora do JSON.
      Você deve analisar o histórico da conversa e o último comando do usuário para determinar a resposta.

      Se o último comando for uma transcrição de áudio:
      - Gere um resumo clínico curto da transcrição.
      - Crie um título conciso (até 10 palavras) para a consulta.
      - A saída deve ser um JSON com a estrutura:
        {
          "mensagem": "resumo clínico aqui",
          "titulo": "título da consulta aqui",
          "mode": "BIGTIME"
        }

      Se o último comando for uma solicitação de anamnese, ou documento, como "Gera uma Anamnese" ou "Gere Documento":
      - Analise toda a conversa anterior.
      - Gere uma anamnese/documento completa sempre em formato HTML (usando parágrafos, negrito, listas).
      - A saída deve ser um JSON com a estrutura:
        {
          "html": "anamnese/documento completa em HTML aqui",
           "titulo": "título para o documento aqui",
          "mode": "HTML"
        }

      Para qualquer outro comando ou pergunta do usuário:
      - Responda de forma normal e útil para a conversa.
      - A saída deve ser um JSON com a estrutura:
        {
          "mensagem": "sua resposta normal aqui, pense bem antes de responder, analise o contexto geral",
          "mode": "CHATIME"
        }
    `;

    const formattedHistory = history.map(msg => ({
      role: msg.from === "user" ? "user" : "model",
      parts: [{ text: `${comando} - ${msg.text}` }]
    }));

    const previousMessages = formattedHistory.slice(0, -1);
    const lastUserMessage = formattedHistory[formattedHistory.length - 1].parts[0].text;

    // Alterado para gemini-2.5-flash para melhor performance/custo em chat, 
    // ou mantido o pro se for estritamente necessário para raciocínio complexo. 
    // Mantenho o 'pro' por ser a sua escolha original:
    const model = "gemini-2.5-pro"; 
    const generativeModel = vertex_ai.getGenerativeModel({
      model,
      generationConfig: { maxOutputTokens: 4048, temperature: 0.2 }
    });

    const chat = generativeModel.startChat({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      history: previousMessages
    });

    const result = await chat.sendMessage(lastUserMessage);
    const responseText = result.response.candidates[0].content.parts[0].text;

    try {
      // Limpeza e tentativa de parse do JSON.
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch && jsonMatch[0]) {
        const responseObject = JSON.parse(jsonMatch[0]);
        res.json(responseObject);
      } else {
        log('API-WARN', "A resposta da IA não continha um JSON válido."); // Corrigido
        res.status(500).json({ mensagem: "Erro: formato de resposta da IA inválido." });
      }
    } catch (error) {
      log('API-ERROR', "Erro ao fazer parse do JSON da IA:", error); // Corrigido
      res.status(500).json({ mensagem: "Erro interno no servidor." });
    }

  } catch (error) {
    log('API-ERROR', "Erro ao processar a requisição de chat.", error); // Corrigido
    res.status(500).json({ error: "Erro ao processar a requisição de chat." });
  }
});

// --- Iniciar Servidor ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  log('Server', `🚀 Servidor rodando na porta ${PORT}`);
  log('Server', `🔌 WebSockets habilitados para Cloud Run`);
  log('Server', `🌐 Health check disponível em /health`);
});