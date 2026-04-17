const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-smoke-'));
  const dbPath = path.join(tempDir, 'smoke.db');

  process.env.NODE_ENV = 'test';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '4010';
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'smoke-test-password';

  const { db, startServer } = require('../server.js');
  const server = startServer();

  try {
    await waitForServer(server);

    const baseUrl = 'http://127.0.0.1:4010';
    const adminAuth = `Basic ${Buffer.from('admin:smoke-test-password').toString('base64')}`;

    const health = await request(baseUrl, 'GET', '/health');
    if (!health.ok) {
      throw new Error('Health check failed');
    }

    await expectStatus(baseUrl, 'GET', '/admin.html', 401);
    await expectStatus(baseUrl, 'GET', '/server.js', 404);
    await expectStatus(baseUrl, 'GET', '/experiment.db', 404);

    const created = await request(baseUrl, 'POST', '/api/experiments', {
      name: 'Smoke Test',
      object_type: 'radials',
      samples_per_question: 2,
      num_questions: 1,
      num_participants: 1,
    }, {
      Authorization: adminAuth,
    });

    if (!created.tokens || created.tokens.length !== 2) {
      throw new Error('Experiment creation did not return the expected tokens');
    }

    const participantToken = created.tokens[0].token;
    const session = await request(baseUrl, 'POST', '/api/sessions', { token: participantToken });
    if (!session.session_key) {
      throw new Error('Session creation did not return a session key');
    }

    await request(
      baseUrl,
      'POST',
      `/api/sessions/${session.session_id}/instruction`,
      { time_ms: 1000 },
      { 'X-Session-Key': session.session_key }
    );

    await request(
      baseUrl,
      'POST',
      `/api/sessions/${session.session_id}/responses`,
      {
        question_index: 0,
        video_page_times: [300, 275],
        video_focus_percentages: [100, 98.25],
        choice_time_ms: 750,
        chosen_answer: 1,
      },
      { 'X-Session-Key': session.session_key }
    );

    await request(
      baseUrl,
      'POST',
      `/api/sessions/${session.session_id}/complete`,
      {},
      { 'X-Session-Key': session.session_key }
    );

    const results = await request(
      baseUrl,
      'GET',
      `/api/experiments/${created.experiment.id}/results`,
      undefined,
      { Authorization: adminAuth }
    );

    if (!results.sessions || results.sessions.length !== 1) {
      throw new Error('Results endpoint did not return the expected session data');
    }

    console.log('Smoke test passed.');
  } finally {
    await closeServer(server);
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function request(baseUrl, method, requestPath, body, extraHeaders = {}) {
  const options = {
    method,
    headers: {
      ...extraHeaders,
    },
  };

  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${requestPath}`, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : (payload?.error || response.statusText);
    throw new Error(`${method} ${requestPath} failed: ${message}`);
  }

  return payload;
}

async function waitForServer(server) {
  if (server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function expectStatus(baseUrl, method, requestPath, expectedStatus) {
  const response = await fetch(`${baseUrl}${requestPath}`, { method });
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${requestPath} returned ${response.status}, expected ${expectedStatus}`
    );
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
