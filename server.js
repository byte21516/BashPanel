const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

// Host-Skripte Pfad im Container für Upload/Download
const HOST_SCRIPTS_DIR = path.join(__dirname, 'scripts');
if (!fs.existsSync(HOST_SCRIPTS_DIR)) fs.mkdirSync(HOST_SCRIPTS_DIR, { recursive: true });

app.use(express.json());
app.use('/scripts', express.static(HOST_SCRIPTS_DIR));
app.use(express.static(__dirname));

// SSH-Konfiguration
const HOST_USER = process.env.HOST_USER;
const SSH_KEY_PATH = process.env.SSH_KEY_PATH;

if (!HOST_USER || !SSH_KEY_PATH) {
  console.error("HOST_USER oder SSH_KEY_PATH nicht gesetzt!");
  process.exit(1);
}

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return null;
  const base = path.basename(name).replace(/[^a-zA-Z0-9-_.]/g, '');
  if (!base) return null;
  return base.toLowerCase().endsWith('.sh') ? base : base + '.sh';
}

// list scripts
app.get('/api/scripts', (req, res) => {
  try {
    const files = fs.readdirSync(HOST_SCRIPTS_DIR).filter(f => f.endsWith('.sh'));
    res.json({ scripts: files });
  } catch (e) {
    console.error('list scripts error', e);
    res.status(500).json({ error: 'failed to list scripts' });
  }
});

// upload script
app.post('/api/upload-script', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ success: false, error: 'filename & content required' });

  const safe = sanitizeFilename(filename);
  if (!safe) return res.status(400).json({ success: false, error: 'invalid filename' });

  const dest = path.join(HOST_SCRIPTS_DIR, safe);
  try {
    fs.writeFileSync(dest, content, { mode: 0o755 });
    fs.chmodSync(dest, 0o755);
    res.json({ success: true, script: safe });
  } catch (e) {
    console.error('write script error', e);
    res.status(500).json({ success: false, error: 'failed to write script' });
  }
});

// delete script
app.delete('/api/delete-script', (req, res) => {
  const filename = req.query.filename;
  const safe = sanitizeFilename(filename);
  if (!safe) return res.status(400).json({ success: false, error: 'invalid filename' });

  const fullPath = path.join(HOST_SCRIPTS_DIR, safe);
  try {
    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, error: 'file not found' });
    fs.unlinkSync(fullPath);
    res.json({ success: true, script: safe });
  } catch (e) {
    console.error('delete script error', e);
    res.status(500).json({ success: false, error: 'failed to delete' });
  }
});

const server = require('http').createServer(app);
const io = require('socket.io')(server);
const runs = {};

// run script on host via SSH-Key
app.post('/api/run', (req, res) => {
  const { script, command } = req.body;
  if (!script && !command) return res.status(400).json({ error: 'script or command required' });

  const runId = crypto.randomBytes(6).toString('hex');
  res.json({ runId });

  let sshCmd, args;

  if (script) {
    const safe = sanitizeFilename(script);
    if (!safe) return res.status(400).json({ error: 'invalid script name' });

    sshCmd = 'ssh';
    args = [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      `${HOST_USER}@localhost`,
      `"bash ~/bashpanel-scripts/${safe}"`
    ];
  } else {
    sshCmd = 'ssh';
    args = [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      `${HOST_USER}@localhost`,
      `"${command}"`
    ];
  }

  const child = spawn(sshCmd, args, { shell: true, detached: true });
  runs[runId] = child;

  let buffer = '';
  let socketJoined = false;

  io.once('connection', socket => {
    socket.on('join', id => {
      if (id !== runId) return;
      socket.join(runId);
      socketJoined = true;
      if (buffer) {
        socket.emit('stdout', buffer);
        buffer = '';
      }
    });
  });

  child.stdout.on('data', data => {
    if (socketJoined) io.to(runId).emit('stdout', data.toString());
    else buffer += data.toString();
  });

  child.stderr.on('data', data => {
    if (socketJoined) io.to(runId).emit('stderr', data.toString());
    else buffer += data.toString();
  });

  child.on('close', code => {
    io.to(runId).emit('exit', { code });
    delete runs[runId];
  });
});

// kill process
app.post('/api/kill', (req, res) => {
  const { runId } = req.body;
  if (!runId || !runs[runId]) return res.status(400).json({ error:'invalid runId' });

  try {
    process.kill(-runs[runId].pid, 'SIGINT');
    res.json({ success:true });
  } catch(e) {
    res.status(500).json({ error:e.message });
  }
});

io.on('connection', socket => {
  socket.on('join', runId => socket.join(runId));
});

server.listen(PORT, () => console.log(`BashPanel running on http://localhost:${PORT}`));
