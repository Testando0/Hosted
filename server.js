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

// Configuração Multer
const storageZip = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot_package.zip')
});
const uploadZip = multer({ storage: storageZip });

const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BOT_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadFile = multer({ storage: storageFile });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = []; // Buffer para guardar logs recentes

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    // Envia histórico recente ao conectar (útil para mobile que recarrega)
    socket.emit('log-history', logHistory);

    socket.on('terminal-input', (cmd) => {
        if (currentBotProcess && !currentBotProcess.killed) {
            try {
                currentBotProcess.stdin.write(cmd + '\n');
                addLog('input', `$ ${cmd}`);
            } catch (e) {
                addLog('error', 'Erro ao enviar comando: Processo não responde.');
            }
        } else {
            addLog('error', 'O Bot está OFFLINE. Inicie o deploy.');
        }
    });
});

function getTime() { return new Date().toLocaleTimeString('pt-BR'); }

// Função central de logs com histórico
function addLog(type, text) {
    const logEntry = { type, text, time: getTime() };
    
    // Guarda os últimos 50 logs
    if (logHistory.length > 50) logHistory.shift();
    logHistory.push(logEntry);

    // Envia para todos conectados
    io.emit('log-message', logEntry);
    
    // Console do servidor (Render logs)
    if(type === 'error' || type === 'warn' || type === 'success') {
        console.log(`[${type.toUpperCase()}] ${text}`);
    }
}

// --- GERENCIAMENTO DE PROCESSOS (CORREÇÃO CRÍTICA) ---
async function killBot() {
    if (currentBotProcess) {
        addLog('warn', 'Encerrando processo anterior...');
        try {
            // Tenta matar o grupo de processos (PID negativo)
            // Só funciona se spawned com detached: true
            process.kill(-currentBotProcess.pid);
        } catch (e) {
            // Se der erro, tenta kill normal
            try { currentBotProcess.kill(); } catch (err) {}
        }
        currentBotProcess = null;
        // Pequeno delay para garantir liberação de porta
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// --- ROTAS ---

// Listar Arquivos
app.get('/files/list', async (req, res) => {
    try {
        if(!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR);
        const files = await fs.readdir(BOT_DIR);
        const fileData = [];
        for (const file of files) {
            try {
                const stats = await fs.stat(path.join(BOT_DIR, file));
                fileData.push({
                    name: file,
                    isDir: stats.isDirectory(),
                    size: (stats.size / 1024).toFixed(1) + ' KB'
                });
            } catch(e) {}
        }
        fileData.sort((a, b) => (a.isDir === b.isDir) ? 0 : a.isDir ? -1 : 1);
        res.json(fileData);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletar Arquivo
app.delete('/files/delete', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Nome inválido' });
        const target = path.join(BOT_DIR, name);
        if (!target.startsWith(BOT_DIR)) throw new Error("Acesso negado."); // Security check
        
        await fs.remove(target);
        addLog('warn', `Arquivo deletado: ${name}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload Arquivo Único
app.post('/files/upload', uploadFile.single('file'), (req, res) => {
    if (req.file) {
        addLog('info', `Arquivo recebido: ${req.file.originalname}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Erro no upload.' });
    }
});

// Deploy ZIP
app.post('/deploy/zip', uploadZip.single('file'), async (req, res) => {
    let { startCommand, installDeps } = req.body;
    
    if (!req.file) return res.status(400).json({ error: 'ZIP não enviado.' });

    deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', 'Extraindo ZIP...');
        const zip = new AdmZip(path.join(UPLOAD_DIR, 'bot_package.zip'));
        zip.extractAllTo(BOT_DIR, true);
    });
    res.json({ success: true });
});

// Deploy Git
app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'URL Git vazia.' });

    deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', `Clonando ${repoUrl}...`);
        await simpleGit().clone(repoUrl, BOT_DIR);
    });
    res.json({ success: true });
});

// --- FLUXO DE DEPLOY E START ---
async function deployFlow(startCmd, shouldInstall, fileHandler) {
    try {
        startCmd = String(startCmd).trim(); // Força string
        if(!startCmd) startCmd = "node index.js";

        await killBot(); // Mata o antigo
        
        addLog('warn', 'Limpando diretório e preparando...');
        await fs.emptyDir(BOT_DIR);
        
        await fileHandler(); // Extrai ou Clona

        let finalCmd = startCmd;
        
        // Se pedir install, concatenamos com &&
        // Isso garante que o start só roda se o install der certo
        if (shouldInstall) {
            addLog('info', 'Executando npm install (aguarde)...');
            finalCmd = `npm install && ${startCmd}`;
        }

        startBot(finalCmd);

    } catch (e) {
        addLog('error', `FALHA NO DEPLOY: ${e.message}`);
    }
}

function startBot(command) {
    addLog('success', `Iniciando Processo: ${command}`);

    // ATENÇÃO: detached: true é essencial para conseguir matar o processo depois
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR,
        shell: true,
        detached: true, 
        stdio: ['pipe', 'pipe', 'pipe']
    });

    currentBotProcess.stdout.on('data', (data) => {
        addLog('info', data.toString().trim());
    });

    currentBotProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Ignora warnings irrelevantes
        if (!msg.includes('npm WARN') && !msg.includes('npm notice') && !msg.includes('Cloning into')) {
            addLog('error', msg);
        } else {
            addLog('input', msg); // Mostra warnings como cinza/input
        }
    });

    currentBotProcess.on('close', (code) => {
        addLog('warn', `Bot desligado. Código de saída: ${code}`);
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`SERVER ONLINE PORT ${PORT}`); });
