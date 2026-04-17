const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const Database = require('better-sqlite3');

const OBJECT_TYPES = ['radials', 'chains'];
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_REQUEST_BODY = '32kb';
const MAX_EXPERIMENT_NAME_LENGTH = 120;
const MAX_TIMING_MS = 5 * 60 * 1000;
const MAX_INSTRUCTION_TIME_MS = 60 * 60 * 1000;
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const LEGACY_DB_PATH = path.join(__dirname, 'experiment.db');
const DEFAULT_DB_PATH = fs.existsSync(LEGACY_DB_PATH)
  ? LEGACY_DB_PATH
  : path.join(__dirname, 'storage', 'experiment.db');

const config = {
  host: process.env.HOST || DEFAULT_HOST,
  port: parsePort(process.env.PORT, DEFAULT_PORT),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: path.resolve(process.env.DB_PATH || DEFAULT_DB_PATH),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

const isProduction = config.nodeEnv === 'production';
if (isProduction && !config.adminPassword) {
  throw new Error('ADMIN_PASSWORD is required when NODE_ENV=production');
}

const datasetCatalog = loadDatasetCatalog(DATA_DIR);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initializeDatabase();

const app = express();

if (config.trustProxy !== false) {
  app.set('trust proxy', config.trustProxy);
}

app.disable('x-powered-by');
app.use(express.json({ limit: MAX_REQUEST_BODY }));
app.use(setSecurityHeaders);

const sessionCreationLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 30 : 300,
  message: 'Too many token attempts. Please wait before trying again.',
});

const participantActionLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 240 : 2400,
  message: 'Too many participant requests. Please slow down and try again.',
});

const adminLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 120 : 1200,
  message: 'Too many admin requests. Please wait before trying again.',
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    environment: config.nodeEnv,
    datasets: {
      radials: datasetCatalog.radials.length,
      chains: datasetCatalog.chains.length,
    },
  });
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.redirect('/admin.html');
});

app.get('/admin.html', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use('/api/experiments', adminLimiter, requireAdmin);

// --------------- Admin API ---------------

app.post('/api/experiments', (req, res) => {
  const name = sanitizeExperimentName(req.body.name);
  const objectType = req.body.object_type;
  const samplesPerQuestion = toInteger(req.body.samples_per_question);
  const numQuestions = toInteger(req.body.num_questions);
  const numParticipants = toInteger(req.body.num_participants);
  const availableObjects = datasetCatalog[objectType];

  if (!availableObjects) {
    return res.status(400).json({ error: 'object_type must be radials or chains' });
  }
  if (!Number.isInteger(samplesPerQuestion) || samplesPerQuestion < 2) {
    return res.status(400).json({ error: 'samples_per_question must be an integer >= 2' });
  }
  if (samplesPerQuestion > availableObjects.length) {
    return res.status(400).json({
      error: `samples_per_question cannot exceed ${availableObjects.length} for ${objectType}`,
    });
  }
  if (!Number.isInteger(numQuestions) || numQuestions < 1 || numQuestions > 100) {
    return res.status(400).json({ error: 'num_questions must be 1-100' });
  }
  if (!Number.isInteger(numParticipants) || numParticipants < 1 || numParticipants > 200) {
    return res.status(400).json({ error: 'num_participants must be 1-200' });
  }

  const insertExperiment = db.prepare(
    'INSERT INTO experiments (name, object_type, samples_per_question, num_questions, num_participants) VALUES (?, ?, ?, ?, ?)'
  );
  const insertQuestion = db.prepare(
    'INSERT INTO questions (experiment_id, question_index, sampled_indices, test_object_index, correct_position) VALUES (?, ?, ?, ?, ?)'
  );
  const insertToken = db.prepare(
    'INSERT INTO tokens (experiment_id, token, pattern_type, participant_number) VALUES (?, ?, ?, ?)'
  );
  const tokenExists = db.prepare('SELECT 1 FROM tokens WHERE token = ?');

  const txn = db.transaction(() => {
    const { lastInsertRowid: experimentId } = insertExperiment.run(
      name,
      objectType,
      samplesPerQuestion,
      numQuestions,
      numParticipants
    );

    for (let questionIndex = 0; questionIndex < numQuestions; questionIndex += 1) {
      const sampled = sampleItems(availableObjects, samplesPerQuestion);
      const correctChoiceIndex = Math.floor(Math.random() * samplesPerQuestion);

      insertQuestion.run(
        experimentId,
        questionIndex,
        JSON.stringify(sampled),
        sampled[correctChoiceIndex],
        correctChoiceIndex + 1
      );
    }

    const issuedTokens = new Set();
    for (let participantNumber = 1; participantNumber <= numParticipants; participantNumber += 1) {
      for (const patternType of ['continuous', 'discontinuous']) {
        let token;
        do {
          token = generateToken();
        } while (issuedTokens.has(token) || tokenExists.get(token));

        issuedTokens.add(token);
        insertToken.run(experimentId, token, patternType, participantNumber);
      }
    }

    return experimentId;
  });

  try {
    const experimentId = txn();
    const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
    const tokens = db.prepare('SELECT * FROM tokens WHERE experiment_id = ?').all(experimentId);
    res.json({ experiment, tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/experiments', (_req, res) => {
  const experiments = db.prepare('SELECT * FROM experiments ORDER BY created_at DESC, id DESC').all();
  const countCompletedSessions = db.prepare(
    'SELECT COUNT(*) AS count FROM sessions WHERE experiment_id = ? AND completed = 1'
  );

  for (const experiment of experiments) {
    experiment.completed_sessions = countCompletedSessions.get(experiment.id).count;
  }

  res.json(experiments);
});

app.get('/api/experiments/:id', (req, res) => {
  const experimentId = toInteger(req.params.id);
  if (!Number.isInteger(experimentId)) {
    return res.status(400).json({ error: 'Experiment id must be an integer' });
  }

  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
  if (!experiment) {
    return res.status(404).json({ error: 'Experiment not found' });
  }

  const tokens = db.prepare(
    'SELECT * FROM tokens WHERE experiment_id = ? ORDER BY participant_number, pattern_type'
  ).all(experiment.id);
  const questions = db.prepare(
    'SELECT * FROM questions WHERE experiment_id = ? ORDER BY question_index'
  ).all(experiment.id);

  res.json({ experiment, tokens, questions });
});

app.get('/api/experiments/:id/results', (req, res) => {
  const experimentId = toInteger(req.params.id);
  if (!Number.isInteger(experimentId)) {
    return res.status(400).json({ error: 'Experiment id must be an integer' });
  }

  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
  if (!experiment) {
    return res.status(404).json({ error: 'Experiment not found' });
  }

  const sessions = db.prepare(
    'SELECT * FROM sessions WHERE experiment_id = ? ORDER BY participant_number, pattern_type, id'
  ).all(experiment.id);
  const getResponses = db.prepare(
    'SELECT * FROM responses WHERE session_id = ? ORDER BY question_index'
  );

  for (const session of sessions) {
    session.responses = getResponses.all(session.id);
  }

  res.json({ experiment, sessions });
});

app.get('/api/experiments/:id/results/csv', (req, res) => {
  const experimentId = toInteger(req.params.id);
  if (!Number.isInteger(experimentId)) {
    return res.status(400).json({ error: 'Experiment id must be an integer' });
  }

  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
  if (!experiment) {
    return res.status(404).json({ error: 'Experiment not found' });
  }

  const sessions = db.prepare(
    'SELECT * FROM sessions WHERE experiment_id = ? ORDER BY participant_number, pattern_type, id'
  ).all(experiment.id);
  const getResponses = db.prepare(
    'SELECT * FROM responses WHERE session_id = ? ORDER BY question_index'
  );

  const rows = [
    [
      'session_id',
      'participant',
      'pattern_type',
      'instruction_time_ms',
      'question',
      'between_video_times',
      'video_focus_pcts',
      'choice_time_ms',
      'chosen',
      'correct',
      'is_correct',
    ],
  ];

  for (const session of sessions) {
    const responses = getResponses.all(session.id);
    for (const response of responses) {
      rows.push([
        session.id,
        session.participant_number,
        session.pattern_type,
        session.instruction_time_ms ?? '',
        response.question_index + 1,
        response.video_page_times ?? '',
        response.video_focus_percentages ?? '',
        response.choice_time_ms ?? '',
        response.chosen_answer ?? '',
        response.correct_answer ?? '',
        response.is_correct ?? '',
      ]);
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=experiment_${experiment.id}_results.csv`
  );
  res.send(rows.map(toCsvRow).join('\n'));
});

app.delete('/api/experiments/:id', (req, res) => {
  const experimentId = toInteger(req.params.id);
  if (!Number.isInteger(experimentId)) {
    return res.status(400).json({ error: 'Experiment id must be an integer' });
  }

  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(experimentId);
  if (!experiment) {
    return res.status(404).json({ error: 'Experiment not found' });
  }

  const txn = db.transaction(() => {
    db.prepare(
      'DELETE FROM responses WHERE session_id IN (SELECT id FROM sessions WHERE experiment_id = ?)'
    ).run(experiment.id);
    db.prepare('DELETE FROM sessions WHERE experiment_id = ?').run(experiment.id);
    db.prepare('DELETE FROM tokens WHERE experiment_id = ?').run(experiment.id);
    db.prepare('DELETE FROM questions WHERE experiment_id = ?').run(experiment.id);
    db.prepare('DELETE FROM experiments WHERE id = ?').run(experiment.id);
  });

  txn();
  res.json({ ok: true });
});

// --------------- Participant API ---------------

app.post('/api/sessions', sessionCreationLimiter, (req, res) => {
  const normalizedToken = normalizeToken(req.body.token);
  if (!normalizedToken) {
    return res.status(400).json({ error: 'A valid access token is required' });
  }

  const tokenRecord = db.prepare('SELECT * FROM tokens WHERE token = ?').get(normalizedToken);
  if (!tokenRecord) {
    return res.status(404).json({ error: 'Invalid token' });
  }

  let session = db.prepare('SELECT * FROM sessions WHERE token_id = ?').get(tokenRecord.id);
  if (session && session.completed) {
    return res.status(410).json({ error: 'This token has already been used to complete a session' });
  }

  if (!session) {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO sessions (token_id, experiment_id, pattern_type, participant_number) VALUES (?, ?, ?, ?)'
    ).run(
      tokenRecord.id,
      tokenRecord.experiment_id,
      tokenRecord.pattern_type,
      tokenRecord.participant_number
    );

    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(lastInsertRowid);
  }

  if (!tokenRecord.used) {
    db.prepare('UPDATE tokens SET used = 1 WHERE id = ?').run(tokenRecord.id);
  }

  const sessionKey = rotateSessionKey(session.id);
  const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(tokenRecord.experiment_id);
  const questions = db.prepare(
    'SELECT question_index, sampled_indices, test_object_index FROM questions WHERE experiment_id = ? ORDER BY question_index'
  ).all(tokenRecord.experiment_id);
  const progress = db.prepare(
    'SELECT COUNT(*) AS questions_completed, COALESCE(SUM(is_correct), 0) AS correct_answers FROM responses WHERE session_id = ?'
  ).get(session.id);

  res.json({
    session_id: session.id,
    session_key: sessionKey,
    experiment: {
      object_type: experiment.object_type,
      samples_per_question: experiment.samples_per_question,
      num_questions: experiment.num_questions,
    },
    pattern_type: tokenRecord.pattern_type,
    questions,
    progress: {
      instruction_done: session.instruction_time_ms != null,
      questions_completed: progress.questions_completed,
      correct_answers: progress.correct_answers,
    },
  });
});

app.post(
  '/api/sessions/:id/instruction',
  participantActionLimiter,
  requireParticipantSession,
  (req, res) => {
    if (req.sessionRecord.completed) {
      return res.status(410).json({ error: 'This session has already been completed' });
    }

    const timeMs = toFiniteNumber(req.body.time_ms);
    if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > MAX_INSTRUCTION_TIME_MS) {
      return res.status(400).json({ error: 'time_ms must be a number between 0 and 3600000' });
    }

    db.prepare('UPDATE sessions SET instruction_time_ms = ? WHERE id = ?').run(
      Math.round(timeMs),
      req.sessionRecord.id
    );

    res.json({ ok: true });
  }
);

app.post(
  '/api/sessions/:id/responses',
  participantActionLimiter,
  requireParticipantSession,
  (req, res) => {
    const session = req.sessionRecord;
    if (session.completed) {
      return res.status(410).json({ error: 'This session has already been completed' });
    }
    if (session.instruction_time_ms == null) {
      return res.status(400).json({ error: 'Instruction phase must be completed before answering' });
    }

    const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(session.experiment_id);
    if (!experiment) {
      return res.status(404).json({ error: 'Experiment not found' });
    }

    const questionIndex = toInteger(req.body.question_index);
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= experiment.num_questions) {
      return res.status(400).json({ error: 'question_index is out of range' });
    }

    const answeredCount = db.prepare(
      'SELECT COUNT(*) AS count FROM responses WHERE session_id = ?'
    ).get(session.id).count;
    if (questionIndex !== answeredCount) {
      return res.status(409).json({
        error: `Responses must be submitted sequentially. Expected question_index ${answeredCount}.`,
      });
    }

    const question = db.prepare(
      'SELECT * FROM questions WHERE experiment_id = ? AND question_index = ?'
    ).get(session.experiment_id, questionIndex);
    if (!question) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const chosenAnswer = toInteger(req.body.chosen_answer);
    if (!Number.isInteger(chosenAnswer) || chosenAnswer < 1 || chosenAnswer > experiment.samples_per_question) {
      return res.status(400).json({ error: 'chosen_answer is out of range' });
    }

    const videoPageTimes = normalizeNumberArray(
      req.body.video_page_times,
      experiment.samples_per_question,
      { min: 0, max: MAX_TIMING_MS, round: true }
    );
    if (!videoPageTimes) {
      return res.status(400).json({
        error: `video_page_times must be an array of ${experiment.samples_per_question} numbers`,
      });
    }

    const videoFocusPercentages = normalizeNumberArray(
      req.body.video_focus_percentages,
      experiment.samples_per_question,
      { min: 0, max: 100, round: false }
    );
    if (!videoFocusPercentages) {
      return res.status(400).json({
        error: `video_focus_percentages must be an array of ${experiment.samples_per_question} numbers`,
      });
    }

    const choiceTimeMs = toFiniteNumber(req.body.choice_time_ms);
    if (!Number.isFinite(choiceTimeMs) || choiceTimeMs < 0 || choiceTimeMs > MAX_TIMING_MS) {
      return res.status(400).json({ error: 'choice_time_ms must be a number between 0 and 300000' });
    }

    const isCorrect = chosenAnswer === question.correct_position ? 1 : 0;

    try {
      db.prepare(
        `INSERT INTO responses (
          session_id,
          question_index,
          video_page_times,
          video_focus_percentages,
          choice_time_ms,
          chosen_answer,
          correct_answer,
          is_correct
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        questionIndex,
        JSON.stringify(videoPageTimes),
        JSON.stringify(videoFocusPercentages),
        Math.round(choiceTimeMs),
        chosenAnswer,
        question.correct_position,
        isCorrect
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'This question already has a saved response' });
      }
      throw error;
    }

    res.json({ is_correct: Boolean(isCorrect), correct_answer: question.correct_position });
  }
);

app.post(
  '/api/sessions/:id/complete',
  participantActionLimiter,
  requireParticipantSession,
  (req, res) => {
    const session = req.sessionRecord;
    if (session.completed) {
      return res.json({ ok: true });
    }

    const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(session.experiment_id);
    if (!experiment) {
      return res.status(404).json({ error: 'Experiment not found' });
    }

    const answeredCount = db.prepare(
      'SELECT COUNT(*) AS count FROM responses WHERE session_id = ?'
    ).get(session.id).count;

    if (answeredCount !== experiment.num_questions) {
      return res.status(400).json({
        error: `Cannot complete session before all ${experiment.num_questions} questions are answered`,
      });
    }

    db.prepare(
      "UPDATE sessions SET completed = 1, completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?"
    ).run(session.id);

    res.json({ ok: true });
  }
);

// --------------- Static files ---------------

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(
  '/data',
  express.static(DATA_DIR, {
    fallthrough: false,
    immutable: isProduction,
    maxAge: isProduction ? '7d' : 0,
  })
);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (error && Number.isInteger(error.status)) {
    const status = error.status;
    const message = status === 404 ? 'Not found' : (error.message || 'Request failed');
    return res.status(status).type('text/plain').send(message);
  }

  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      object_type TEXT NOT NULL,
      samples_per_question INTEGER NOT NULL,
      num_questions INTEGER NOT NULL,
      num_participants INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      question_index INTEGER NOT NULL,
      sampled_indices TEXT NOT NULL,
      test_object_index INTEGER NOT NULL,
      correct_position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      pattern_type TEXT NOT NULL,
      participant_number INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL REFERENCES tokens(id),
      experiment_id INTEGER NOT NULL REFERENCES experiments(id),
      pattern_type TEXT NOT NULL,
      participant_number INTEGER NOT NULL,
      instruction_time_ms REAL,
      started_at TEXT DEFAULT (datetime('now')),
      completed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      question_index INTEGER NOT NULL,
      video_page_times TEXT,
      video_focus_percentages TEXT,
      choice_time_ms REAL,
      chosen_answer INTEGER,
      correct_answer INTEGER,
      is_correct INTEGER
    );
  `);

  ensureColumn('sessions', 'session_key_hash', 'TEXT');
  ensureColumn('sessions', 'completed_at', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_id ON sessions(token_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_session_question_index
      ON responses(session_id, question_index);
  `);
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function loadDatasetCatalog(dataDir) {
  const catalog = {};

  for (const objectType of OBJECT_TYPES) {
    const prefix = objectType === 'radials' ? 'radial' : 'chain';
    const objectRoot = path.join(dataDir, objectType);

    if (!fs.existsSync(objectRoot)) {
      throw new Error(`Missing data directory: ${objectRoot}`);
    }

    const objectIndices = fs.readdirSync(objectRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const match = entry.name.match(new RegExp(`^${prefix}_(\\d{2})$`));
        if (!match) {
          return null;
        }

        const objectIndex = Number.parseInt(match[1], 10);
        const objectDir = path.join(objectRoot, entry.name);
        const requiredFiles = [
          path.join(objectDir, `${prefix}.png`),
          path.join(objectDir, `${prefix}_continuous.mp4`),
          path.join(objectDir, `${prefix}_discontinuous.mp4`),
        ];

        return requiredFiles.every(filePath => fs.existsSync(filePath)) ? objectIndex : null;
      })
      .filter(Number.isInteger)
      .sort((left, right) => left - right);

    if (!objectIndices.length) {
      throw new Error(`No complete ${objectType} dataset entries were found in ${objectRoot}`);
    }

    catalog[objectType] = objectIndices;
  }

  return catalog;
}

function generateToken() {
  const bytes = crypto.randomBytes(8);
  let token = '';

  for (let index = 0; index < 8; index += 1) {
    token += TOKEN_CHARS[bytes[index] % TOKEN_CHARS.length];
  }

  return `${token.slice(0, 4)}-${token.slice(4)}`;
}

function hashSessionKey(sessionKey) {
  return crypto.createHash('sha256').update(sessionKey).digest('hex');
}

function rotateSessionKey(sessionId) {
  const sessionKey = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE sessions SET session_key_hash = ? WHERE id = ?').run(
    hashSessionKey(sessionKey),
    sessionId
  );
  return sessionKey;
}

function shuffle(items) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function sampleItems(items, count) {
  return shuffle(items).slice(0, count);
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTrustProxy(value) {
  if (!value) {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : value;
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeNumberArray(value, expectedLength, options) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    return null;
  }

  const normalized = [];
  for (const item of value) {
    const numericValue = Number(item);
    if (!Number.isFinite(numericValue) || numericValue < options.min || numericValue > options.max) {
      return null;
    }

    normalized.push(options.round ? Math.round(numericValue) : Number(numericValue.toFixed(4)));
  }

  return normalized;
}

function sanitizeExperimentName(value) {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_EXPERIMENT_NAME_LENGTH)
    : '';
}

function normalizeToken(rawToken) {
  const compact = String(rawToken || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);

  if (compact.length !== 8) {
    return '';
  }

  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const fresh = timestamps.filter(timestamp => now - timestamp < windowMs);
      if (fresh.length) {
        hits.set(key, fresh);
      } else {
        hits.delete(key);
      }
    }
  }, windowMs);

  if (typeof cleanup.unref === 'function') {
    cleanup.unref();
  }

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const fresh = (hits.get(key) || []).filter(timestamp => now - timestamp < windowMs);

    fresh.push(now);
    hits.set(key, fresh);

    if (fresh.length > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - fresh[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

function parseBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  if (!config.adminPassword) {
    return next();
  }

  const credentials = parseBasicAuth(req.headers.authorization);
  if (
    credentials &&
    credentials.username === config.adminUsername &&
    constantTimeEqual(credentials.password, config.adminPassword)
  ) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Experiment Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required');
}

function requireParticipantSession(req, res, next) {
  const sessionId = toInteger(req.params.id);
  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: 'Session id must be an integer' });
  }

  const sessionKey = req.get('X-Session-Key');
  if (!sessionKey) {
    return res.status(401).json({ error: 'Session key required' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.session_key_hash || !constantTimeEqual(session.session_key_hash, hashSessionKey(sessionKey))) {
    return res.status(401).json({ error: 'Invalid or expired session key' });
  }

  req.sessionRecord = session;
  next();
}

function setSecurityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
}

function escapeCsvCell(value) {
  const stringValue = value == null ? '' : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsvRow(values) {
  return values.map(escapeCsvCell).join(',');
}

function startServer() {
  const server = app.listen(config.port, config.host, () => {
    const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`Server running at http://${displayHost}:${config.port}`);
    console.log(`Health check:      http://${displayHost}:${config.port}/health`);
    console.log(`Participant page:  http://${displayHost}:${config.port}/`);
    console.log(`Database path:     ${config.dbPath}`);
    if (config.adminPassword) {
      console.log(`Admin panel:       http://${displayHost}:${config.port}/admin.html (HTTP Basic auth)`);
    } else {
      console.log(`Admin panel:       http://${displayHost}:${config.port}/admin.html`);
      console.log('Warning: admin auth is disabled. Set ADMIN_PASSWORD before deploying publicly.');
    }
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  config,
  datasetCatalog,
  db,
  startServer,
};
