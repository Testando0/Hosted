const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');
const { spawn } = require('child_process');

// --- CONFIGURAÇÃO ---
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');
const BOT_DIR = path.join(__dirname, 'user_bot');

// Garante pastas limpas
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(BOT_DIR);

// Configuração Multer para DEPLOY (ZIP)
const storageZip = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot_package.zip')
});
const uploadZip = multer({ storage: storageZip });

// Configuração Multer para ARQUIVOS AVULSOS (File Manager)
const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BOT_DIR),
    filename: (req, file, cb) => cb(null, file.originalname) // Mantém o nome original
});
const uploadFile = multer({ storage: storageFile });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    // systemLog('info', 'Painel C2 Conectado.'); // Comentado para reduzir spam
    socket.on('terminal-input', (cmd) => {
        if (currentBotProcess && !currentBotProcess.killed) {
            try {
                currentBotProcess.stdin.write(cmd + '\n');
                io.emit('log-message', { type: 'input', text: `$ ${cmd}`, time: getTime() });
            } catch (e) {
                io.emit('log-message', { type: 'error', text: 'Erro de I/O.', time: getTime() });
            }
        } else {
            io.emit('log-message', { type: 'error', text: 'Bot offline.', time: getTime() });
        }
    });
});

function getTime() { return new Date().toLocaleTimeString('pt-BR'); }
function systemLog(type, msg) {
    io.emit('log-message', { type, text: msg, time: getTime() });
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- SEGURANÇA DE ARQUIVOS (Anti-Traversal) ---
function getSafePath(target) {
    const resolvedPath = path.resolve(BOT_DIR, target);
    if (!resolvedPath.startsWith(BOT_DIR)) {
        throw new Error("Acesso negado: Tentativa de sair do diretório do bot.");
    }
    return resolvedPath;
}

// --- ROTAS DO FILE MANAGER ---

// 1. Listar Arquivos
app.get('/files/list', async (req, res) => {
    try {
        const files = await fs.readdir(BOT_DIR);
        const fileData = [];

        for (const file of files) {
            const stats = await fs.stat(path.join(BOT_DIR, file));
            fileData.push({
                name: file,
                isDir: stats.isDirectory(),
                size: (stats.size / 1024).toFixed(1) + ' KB'
            });
        }
        
        // Ordena: Pastas primeiro, depois arquivos
        fileData.sort((a, b) => (a.isDir === b.isDir) ? 0 : a.isDir ? -1 : 1);
        
        res.json(fileData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Deletar Arquivo
app.delete('/files/delete', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Nome inválido' });

        const targetPath = getSafePath(name);
        
        // Proteção extra: Não deletar a pasta raiz do bot
        if (targetPath === BOT_DIR) throw new Error("Não é possível deletar a raiz.");

        await fs.remove(targetPath);
        systemLog('warn', `Arquivo deletado via File Manager: ${name}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Upload de Arquivo Único
app.post('/files/upload', uploadFile.single('file'), (req, res) => {
    if (req.file) {
        systemLog('info', `Upload de arquivo recebido: ${req.file.originalname}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
});


// --- ROTAS DE DEPLOY (ZIP / GIT) ---

app.post('/deploy/zip', uploadZip.single('file'), async (req, res) => {
    let { startCommand, installDeps } = req.body;
    startCommand = sanitizeCommand(startCommand);

    if (!req.file) return res.status(400).json({ error: 'Arquivo ZIP faltante.' });

    await runDeploySequence(startCommand, installDeps === 'true', async () => {
        systemLog('info', 'Extraindo ZIP...');
        const zip = new AdmZip(path.join(UPLOAD_DIR, 'bot_package.zip'));
        zip.extractAllTo(BOT_DIR, true);
    });
    res.json({ success: true });
});

app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    startCommand = sanitizeCommand(startCommand);
    
    if (!repoUrl) return res.status(400).json({ error: 'URL Git faltante.' });

    await runDeploySequence(startCommand, installDeps === 'true', async () => {
        systemLog('info', `Clonando: ${repoUrl}`);
        await simpleGit().clone(repoUrl, BOT_DIR);
    });
    res.json({ success: true });
});

// --- HELPERS ---
function sanitizeCommand(cmd) {
    if (!cmd) return "node index.js"; 
    if (Array.isArray(cmd)) return String(cmd[0]).trim();
    return String(cmd).trim();
}

async function runDeploySequence(startCmd, shouldInstall, fileHandler) {
    try {
        if (currentBotProcess) {
            systemLog('warn', 'Parando bot anterior...');
            try { process.kill(-currentBotProcess.pid); } catch (e) { if (e.code !== 'ESRCH') console.log(e); }
            try { currentBotProcess.kill(); } catch(e) {}
            currentBotProcess = null;
        }

        await fs.emptyDir(BOT_DIR);
        await fileHandler();

        let finalCommand = startCmd;
        if (shouldInstall) {
            systemLog('info', 'Instalando dependências...');
            finalCommand = `npm install && ${finalCommand}`;
        }

        startBotProcess(finalCommand);
    } catch (error) {
        systemLog('error', `FALHA DEPLOY: ${error.message}`);
    }
}

function startBotProcess(command) {
    systemLog('success', `Executando: ${command}`);
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    currentBotProcess.stdout.on('data', (data) => io.emit('log-message', { type: 'info', text: data.toString().trim(), time: getTime() }));
    currentBotProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg.includes('npm WARN') && !msg.includes('npm notice')) {
            io.emit('log-message', { type: 'error', text: msg, time: getTime() });
        }
    });
    currentBotProcess.on('close', (code) => systemLog('warn', `Processo saiu: ${code}`));
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`SERVER ONLINE: ${PORT}`); });
