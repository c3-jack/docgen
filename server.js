const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mammoth = require('mammoth');
const initSqlJs = require('sql.js');

const app = express();
const PORT = 3847;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

let db;

// --- DB Setup ---

async function initDb() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'claude-docs.db');
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      save_path TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  saveDb();
}

function saveDb() {
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'claude-docs.db'), buf);
}

// --- Filesystem API ---

app.get('/api/fs/list', (req, res) => {
  const dirPath = req.query.path || process.env.HOME || '/';
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDir: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dirPath, parent: path.dirname(dirPath), items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/fs/read', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  try {
    const ext = path.extname(filePath).toLowerCase();
    let content = '';

    if (ext === '.docx') {
      const result = await mammoth.convertToHtml({ path: filePath });
      content = result.value;
    } else if (ext === '.html' || ext === '.htm') {
      content = fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.txt' || ext === '.md') {
      const text = fs.readFileSync(filePath, 'utf-8');
      content = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text)}</pre>`;
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    res.json({ content, filename: path.basename(filePath), path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fs/save', async (req, res) => {
  const { path: savePath, content, format } = req.body;
  if (!savePath) return res.status(400).json({ error: 'path required' });

  try {
    const ext = path.extname(savePath).toLowerCase();

    if (ext === '.docx' || format === 'docx') {
      const HTMLtoDOCX = require('html-to-docx');
      const docxBuf = await HTMLtoDOCX(content, null, {
        table: { row: { cantSplit: true } },
        footer: true,
      });
      fs.writeFileSync(savePath, Buffer.from(docxBuf));
    } else {
      fs.writeFileSync(savePath, content, 'utf-8');
    }

    res.json({ ok: true, path: savePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Sessions ---

app.get('/api/sessions', (req, res) => {
  const rows = db.exec('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC');
  if (rows.length === 0) return res.json([]);
  res.json(rows[0].values.map(r => ({
    id: r[0], title: r[1], created_at: r[2], updated_at: r[3]
  })));
});

app.post('/api/sessions', (req, res) => {
  const { title } = req.body;
  const id = crypto.randomUUID();
  db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', [id, title || 'New Document']);
  saveDb();
  res.json({ id, title: title || 'New Document' });
});

app.patch('/api/sessions/:id', (req, res) => {
  const { title } = req.body;
  if (title) {
    db.run('UPDATE sessions SET title = ? WHERE id = ?', [title, req.params.id]);
    saveDb();
  }
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  db.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
  db.run('DELETE FROM documents WHERE session_id = ?', [req.params.id]);
  db.run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
  saveDb();
  res.json({ ok: true });
});

// --- Messages ---

app.get('/api/sessions/:id/messages', (req, res) => {
  const rows = db.exec('SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC', [req.params.id]);
  if (rows.length === 0) return res.json([]);
  res.json(rows[0].values.map(r => ({
    id: r[0], role: r[1], content: r[2], created_at: r[3]
  })));
});

app.delete('/api/sessions/:id/messages', (req, res) => {
  db.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
  saveDb();
  res.json({ ok: true });
});

// --- Documents ---

app.get('/api/sessions/:id/document', (req, res) => {
  const rows = db.exec('SELECT id, filename, content, save_path, updated_at FROM documents WHERE session_id = ? LIMIT 1', [req.params.id]);
  if (rows.length === 0 || rows[0].values.length === 0) return res.json(null);
  const r = rows[0].values[0];
  res.json({ id: r[0], filename: r[1], content: r[2], save_path: r[3], updated_at: r[4] });
});

app.put('/api/sessions/:id/document', (req, res) => {
  const { content, filename, save_path } = req.body;
  const sessionId = req.params.id;
  const existing = db.exec('SELECT id FROM documents WHERE session_id = ? LIMIT 1', [sessionId]);

  if (existing.length > 0 && existing[0].values.length > 0) {
    const updates = [];
    const params = [];
    if (content !== undefined) { updates.push('content = ?'); params.push(content); }
    if (filename !== undefined) { updates.push('filename = ?'); params.push(filename); }
    if (save_path !== undefined) { updates.push('save_path = ?'); params.push(save_path); }
    updates.push("updated_at = datetime('now')");
    params.push(sessionId);
    db.run(`UPDATE documents SET ${updates.join(', ')} WHERE session_id = ?`, params);
  } else {
    const docId = crypto.randomUUID();
    db.run(
      'INSERT INTO documents (id, session_id, filename, content, save_path) VALUES (?, ?, ?, ?, ?)',
      [docId, sessionId, filename || 'document.html', content || '', save_path || null]
    );
  }

  // Save version snapshot if content changed
  if (content !== undefined) {
    saveDocVersion(sessionId, content, 'edit');
  }

  db.run("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?", [sessionId]);
  saveDb();
  res.json({ ok: true });
});

// Upload file to session
app.post('/api/sessions/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const sessionId = req.params.id;
    const filename = req.file.originalname;
    const ext = path.extname(filename).toLowerCase();
    let content = '';

    if (ext === '.docx') {
      const result = await mammoth.convertToHtml({ path: req.file.path });
      content = result.value;
    } else if (ext === '.html' || ext === '.htm') {
      content = fs.readFileSync(req.file.path, 'utf-8');
    } else if (ext === '.txt' || ext === '.md') {
      const text = fs.readFileSync(req.file.path, 'utf-8');
      content = `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text)}</pre>`;
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    const docId = crypto.randomUUID();
    db.run('DELETE FROM documents WHERE session_id = ?', [sessionId]);
    db.run(
      'INSERT INTO documents (id, session_id, filename, content) VALUES (?, ?, ?, ?)',
      [docId, sessionId, filename, content]
    );
    db.run("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?", [sessionId]);
    saveDb();
    res.json({ id: docId, filename, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Chat via Claude Code CLI ---

app.post('/api/sessions/:id/chat', async (req, res) => {
  const sessionId = req.params.id;
  const { message } = req.body;

  // Save user message
  db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'user', message]);
  saveDb();

  // Get current document
  const docRows = db.exec('SELECT content, filename FROM documents WHERE session_id = ? LIMIT 1', [sessionId]);
  const currentDoc = docRows.length > 0 && docRows[0].values.length > 0
    ? { content: docRows[0].values[0][0], filename: docRows[0].values[0][1] }
    : null;

  // Build prompt for Claude Code
  let prompt = '';
  const baseInstructions = `You are a powerful document assistant with access to MCP tools including SharePoint, Outlook, Teams, GitHub, Jira, and the local filesystem.

CRITICAL RULES:
- When the user asks for information from SharePoint or any external source, ACTUALLY READ THE FILES. Don't just list links. Download the files, read their contents, and use that information to answer.
- When asked to create or edit a document, return the COMPLETE document HTML inside <updated_document> tags. Use polished, professional HTML with embedded <style> tags for beautiful formatting.
- When asked to research something, use your tools aggressively — search, download, read multiple files, then synthesize.
- Be proactive: if the user says "info on Cargill from SharePoint", search SharePoint, download the most relevant files, read them, and give a substantive summary.
- Don't be lazy. Don't just return file listings when the user wants actual content.

DOCUMENT FORMATTING:
- Create polished, professional documents. Always include a <style> tag with good CSS.
- Default to clean, neutral styling — black text, white background, professional typography.
- Only apply C3 AI branding if the user explicitly asks (e.g. "make it C3 branded", "c3 style", "brand it").
- Prefer HTML output. Only use other formats if explicitly requested.`;

  if (currentDoc) {
    prompt = `${baseInstructions}

The user is editing "${currentDoc.filename}".

Current document (HTML):
<document>
${currentDoc.content}
</document>

When editing, return the COMPLETE updated document inside <updated_document> tags.
Use clean semantic HTML with embedded styles. Preserve unchanged content. If the user just wants to chat (not edit), respond normally without <updated_document> tags.

User: ${message}`;
  } else {
    prompt = `${baseInstructions}

No document is loaded yet. If the user asks you to create a document, put the HTML in <updated_document> tags with embedded <style> for professional formatting.

User: ${message}`;
  }

  // Get conversation context (last 20 messages for context window)
  const msgRows = db.exec(
    'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 20',
    [sessionId]
  );
  const recentContext = msgRows.length > 0
    ? msgRows[0].values.reverse().slice(0, -1).map(r => `${r[0]}: ${r[1]}`).join('\n\n')
    : '';

  if (recentContext) {
    prompt = `Previous conversation:\n${recentContext}\n\n${prompt}`;
  }

  // Stream response via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullResponse = '';

  // Find claude binary
  const claudeBin = process.env.CLAUDE_PATH || '/opt/homebrew/bin/claude';

  try {
    console.log('[chat] spawning claude at:', claudeBin);
    const claude = spawn(claudeBin, [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
    ], {
      env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    console.log('[chat] claude pid:', claude.pid);

    claude.stdin.write(prompt);
    claude.stdin.end();

    let buffer = '';
    let lastSentText = '';

    claude.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Stream text from assistant message events
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                const newText = block.text.slice(lastSentText.length);
                if (newText) {
                  fullResponse = block.text;
                  lastSentText = block.text;
                  res.write(`data: ${JSON.stringify({ type: 'text', content: newText })}\n\n`);
                }
              }
              // Surface tool use to frontend
              if (block.type === 'tool_use') {
                const toolName = (block.name || '').replace(/^mcp__\w+__/, '').replace(/_/g, ' ');
                res.write(`data: ${JSON.stringify({ type: 'tool_use', tool: toolName })}\n\n`);
              }
            }
          }

          // Final result
          if (event.type === 'result' && event.result) {
            if (!fullResponse) {
              fullResponse = event.result;
              res.write(`data: ${JSON.stringify({ type: 'text', content: event.result })}\n\n`);
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    let stderrBuf = '';
    claude.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      console.log('[chat] stderr:', chunk.toString().slice(0, 200));
    });

    claude.on('close', (code, signal) => {
      console.log('[chat] claude closed, code:', code, 'signal:', signal, 'stderr:', stderrBuf.slice(0, 500));
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result && !fullResponse) {
            fullResponse = event.result;
            res.write(`data: ${JSON.stringify({ type: 'text', content: event.result })}\n\n`);
          }
        } catch {}
      }

      if (code !== 0 && !fullResponse) {
        res.write(`data: ${JSON.stringify({ type: 'error', content: stderrBuf || `Claude exited with code ${code}` })}\n\n`);
      }

      // Save assistant message
      if (fullResponse) {
        db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'assistant', fullResponse]);

        // Extract document update
        const docMatch = fullResponse.match(/<updated_document>([\s\S]*?)<\/updated_document>/);
        if (docMatch) {
          const newContent = docMatch[1].trim();
          const existing = db.exec('SELECT id FROM documents WHERE session_id = ? LIMIT 1', [sessionId]);

          if (existing.length > 0 && existing[0].values.length > 0) {
            db.run("UPDATE documents SET content = ?, updated_at = datetime('now') WHERE session_id = ?", [newContent, sessionId]);
            saveDocVersion(sessionId, newContent, 'claude edit');
          } else {
            const docId = crypto.randomUUID();
            db.run(
              'INSERT INTO documents (id, session_id, filename, content) VALUES (?, ?, ?, ?)',
              [docId, sessionId, 'document.html', newContent]
            );
          }
          saveDb();
          res.write(`data: ${JSON.stringify({ type: 'document_update', content: newContent })}\n\n`);
        }

        saveDb();
      }

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    claude.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', content: `Failed to start claude: ${err.message}. Is Claude Code installed?` })}\n\n`);
      res.end();
    });

    // Handle client disconnect — only kill if still running
    let claudeDone = false;
    claude.on('close', () => {
      claudeDone = true;
      console.log('[chat] claude process done');
    });
    req.on('close', () => {
      console.log('[chat] req close event fired, claudeDone:', claudeDone);
      // Don't kill claude — let it finish
    });

  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
    res.end();
  }
});

// --- SharePoint Search ---

app.post('/api/sharepoint/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const claudeBin = process.env.CLAUDE_PATH || '/opt/homebrew/bin/claude';
  const prompt = `Search SharePoint for files matching "${query}". Use the search-sharepoint-files MCP tool. Return ONLY a JSON array of results, no other text. Each result should have: { "name": "filename", "path": "full path", "site": "site name", "modified": "date", "url": "web url if available" }. If no results, return [].`;

  try {
    const claude = spawn(claudeBin, ['--print', '--output-format', 'json'], {
      env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    let stderr = '';
    claude.stdout.on('data', d => stdout += d.toString());
    claude.stderr.on('data', d => stderr += d.toString());

    claude.on('close', (code) => {
      try {
        const parsed = JSON.parse(stdout);
        const resultText = parsed.result || stdout;
        // Try to extract JSON array from the response
        const arrMatch = resultText.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          res.json({ results: JSON.parse(arrMatch[0]) });
        } else {
          res.json({ results: [], message: resultText });
        }
      } catch {
        res.json({ results: [], message: stdout.substring(0, 500) });
      }
    });

    claude.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sharepoint/download', async (req, res) => {
  const { path: filePath, site } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const claudeBin = process.env.CLAUDE_PATH || '/opt/homebrew/bin/claude';
  const prompt = `Download the SharePoint file at path "${filePath}"${site ? ` from site "${site}"` : ''}. Use the download-sharepoint-file MCP tool. Save it to /tmp/sp-download and return the local file path. Return ONLY the local file path, nothing else.`;

  try {
    const claude = spawn(claudeBin, ['--print', '--output-format', 'json'], {
      env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    claude.stdin.write(prompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', d => stdout += d.toString());

    claude.on('close', async (code) => {
      try {
        const parsed = JSON.parse(stdout);
        const localPath = (parsed.result || '').trim();

        if (localPath && fs.existsSync(localPath)) {
          const ext = path.extname(localPath).toLowerCase();
          let content = '';
          if (ext === '.docx') {
            const result = await mammoth.convertToHtml({ path: localPath });
            content = result.value;
          } else if (ext === '.html' || ext === '.htm') {
            content = fs.readFileSync(localPath, 'utf-8');
          } else {
            content = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(fs.readFileSync(localPath, 'utf-8'))}</pre>`;
          }
          res.json({ content, filename: path.basename(localPath), localPath });
        } else {
          res.json({ error: 'Could not download file', message: parsed.result || stdout });
        }
      } catch {
        res.json({ error: 'Failed to process download', message: stdout.substring(0, 500) });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Document Versions ---

app.get('/api/sessions/:id/versions', (req, res) => {
  const rows = db.exec(
    'SELECT id, label, created_at FROM doc_versions WHERE session_id = ? ORDER BY id DESC LIMIT 50',
    [req.params.id]
  );
  if (rows.length === 0) return res.json([]);
  res.json(rows[0].values.map(r => ({ id: r[0], label: r[1], created_at: r[2] })));
});

app.get('/api/sessions/:id/versions/:versionId', (req, res) => {
  const rows = db.exec(
    'SELECT content FROM doc_versions WHERE id = ? AND session_id = ?',
    [req.params.versionId, req.params.id]
  );
  if (rows.length === 0 || rows[0].values.length === 0) {
    return res.status(404).json({ error: 'Version not found' });
  }
  res.json({ content: rows[0].values[0][0] });
});

// Helper: save a version snapshot
function saveDocVersion(sessionId, content, label) {
  if (!content || content.length < 10) return;
  // Don't save duplicate consecutive versions
  const last = db.exec(
    'SELECT content FROM doc_versions WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    [sessionId]
  );
  if (last.length > 0 && last[0].values.length > 0 && last[0].values[0][0] === content) return;
  db.run(
    'INSERT INTO doc_versions (session_id, content, label) VALUES (?, ?, ?)',
    [sessionId, content, label || null]
  );
  saveDb();
}

// --- Filesystem Search (recursive) ---

app.get('/api/fs/search', (req, res) => {
  const query = req.query.q;
  const dir = req.query.path || process.env.HOME || '/';
  if (!query || query.length < 2) return res.json({ results: [] });

  // Use find command for recursive search
  const { execSync } = require('child_process');
  try {
    const cmd = `find ${JSON.stringify(dir)} -maxdepth 5 -iname "*${query.replace(/[^a-zA-Z0-9._\- ]/g, '')}*" -not -path '*/.*' 2>/dev/null | head -50`;
    const output = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
    const results = output.trim().split('\n').filter(Boolean).map(p => ({
      name: path.basename(p),
      path: p,
      isDir: fs.statSync(p).isDirectory(),
    }));
    res.json({ results });
  } catch (err) {
    res.json({ results: [] });
  }
});

// --- Settings ---

app.get('/api/settings', (req, res) => {
  const rows = db.exec("SELECT value FROM settings WHERE key = 'home_dir'");
  const homeDir = rows.length > 0 ? rows[0].values[0][0] : process.env.HOME;
  res.json({ homeDir });
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  saveDb();
  res.json({ ok: true });
});

// --- Helpers ---

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Start ---

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Claude Docs running at http://localhost:${PORT}`);
    // Auto-open disabled for dev; use launch.command for production
    // import('open').then(mod => mod.default(`http://localhost:${PORT}`));
  });
}

start();
