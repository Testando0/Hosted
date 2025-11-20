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

// --- CONFIGURAÇÃO DE DIRETÓRIOS ---
const BOT_DIR = path.join(__dirname, 'user_bot'); 
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads'); 

// --- VARIÁVEIS DE ESTADO ---
let currentBotProcess = null;
let logHistory = [];

// --- CONFIGURAÇÃO MULTER ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.ensureDirSync(UPLOAD_DIR); 
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// ----------------------------------------
// --- CONFIGURAÇÃO EXPRESS E ARQUIVOS ---
// ----------------------------------------

// 1. Rota Principal (RAIZ): Serve o index.html que está na RAIZ do projeto.
app.get('/', (req, res) => {
    // __dirname é a pasta raiz onde o server.js está.
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Rota Estática: Serve todos os outros arquivos estáticos (CSS, JS, dashboard.html, etc.)
// que estão DENTRO da pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ----------------------------------------
// --- SEGURANÇA DE ARQUIVOS (MANTIDA) ---
// ----------------------------------------

/**
 * Garante que o caminho solicitado (clientPath) está DENTRO da pasta BOT_DIR.
 * @param {string} clientPath - Caminho relativo fornecido pelo cliente
 * @returns {string} Caminho absoluto seguro.
 */
function getSafeAbsolutePath(clientPath) {
    if (typeof clientPath !== 'string') clientPath = '';
    
    const targetPath = path.join(BOT_DIR, clientPath);
    const resolvedPath = path.resolve(targetPath);
    const botDirNormalized = path.normalize(BOT_DIR);
    
    if (!resolvedPath.startsWith(botDirNormalized)) {
        throw new Error("Acesso negado: Tentativa de Path Traversal.");
    }
    
    return resolvedPath;
}

// ----------------------------------------
// --- FUNÇÕES DE LOG E PROCESSO ---
// ----------------------------------------

function getTime() { return new Date().toLocaleTimeString('pt-BR'); }

function addLog(type, text) {
    const logEntry = { type, text, time: getTime() };
    
    if (logHistory.length > 50) logHistory.shift();
    logHistory.push(logEntry);

    io.emit('log-message', logEntry);
    
    if(type === 'error' || type === 'warn' || type === 'success') {
        console.log(`[${type.toUpperCase()}] ${text}`);
    }
}

async function killBot() {
    if (currentBotProcess) {
        addLog('warn', 'Encerrando processo anterior...');
        try {
            process.kill(-currentBotProcess.pid); 
        } catch (e) {
            try { currentBotProcess.kill(); } catch (err) {}
        }
        currentBotProcess = null;
        await new Promise(resolve => setTimeout(resolve, 1500)); 
    }
}

function startBot(command) {
    addLog('success', `Iniciando Processo: ${command}`);

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
        if (!msg.includes('npm WARN') && !msg.includes('npm notice') && !msg.includes('Cloning into')) {
            addLog('error', msg);
        } else {
            addLog('input', msg);
        }
    });

    currentBotProcess.on('close', (code) => {
        addLog('warn', `Bot desligado. Código de saída: ${code}`);
    });
    
    currentBotProcess.on('error', (err) => {
        addLog('error', `Erro ao iniciar o processo: ${err.message}`);
    });
}

// ----------------------------------------
// --- ROTA DE DEPLOY CENTRAL (CORE) ---
// ----------------------------------------

async function deployFlow(startCmd, shouldInstall, fileHandler) {
    try {
        startCmd = String(startCmd).trim();
        if(!startCmd) startCmd = "node index.js";

        await killBot();
        
        addLog('warn', 'Limpando diretório do bot...');
        await fs.ensureDir(BOT_DIR);
        await fs.emptyDir(BOT_DIR); 
        
        await fileHandler();

        let finalCmd = startCmd;
        
        if (shouldInstall) {
            addLog('info', 'Executando npm install (aguarde)...');
            // Instalação com prefixo no diretório do bot para isolamento
            finalCmd = `npm install --prefix ${BOT_DIR} && ${startCmd}`; 
        }

        startBot(finalCmd);
        
        await fs.emptyDir(UPLOAD_DIR);

    } catch (e) {
        addLog('error', `FALHA NO DEPLOY: ${e.message}`);
    }
}

// ----------------------------------------
// --- ROTAS DE DEPLOY ---
// ----------------------------------------

// Deploy via ZIP
app.post('/deploy/zip', upload.single('file'), async (req, res) => {
    let { startCommand, installDeps } = req.body;
    if (!req.file) return res.status(400).json({ error: 'ZIP não enviado.' });
    
    const zipFilePath = path.join(UPLOAD_DIR, req.file.originalname);

    await deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', 'Extraindo ZIP...');
        const zip = new AdmZip(zipFilePath);
        zip.extractAllTo(BOT_DIR, true); 
    });
    
    res.json({ success: true, message: "Deploy iniciado." }); 
});

// Deploy via GIT
app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'URL Git vazia.' });

    await deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', `Clonando ${repoUrl}...`);
        await simpleGit().clone(repoUrl, BOT_DIR); 
    });
    
    res.json({ success: true, message: "Deploy Git iniciado." });
});

// ----------------------------------------
// --- ROTAS DO FILE MANAGER ---
// ----------------------------------------

// 1. Listar Arquivos
app.get('/files/list', async (req, res) => {
    try {
        const clientPath = req.query.path || '/'; 
        const targetDir = getSafeAbsolutePath(clientPath); 
        
        await fs.ensureDir(BOT_DIR);

        if(!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Diretório não encontrado.' });
        if(!fs.statSync(targetDir).isDirectory()) return res.status(400).json({ error: 'Caminho não é um diretório.' });

        const files = await fs.readdir(targetDir);
        const fileData = [];
        
        for (const file of files) {
            const filePath = path.join(targetDir, file);
            
            try {
                const stats = await fs.stat(filePath);
                fileData.push({
                    name: file,
                    isDir: stats.isDirectory(),
                    size: (stats.size / 1024).toFixed(1) + ' KB'
                });
            } catch(e) {}
        }
        
        fileData.sort((a, b) => (a.isDir === b.isDir) ? 0 : a.isDir ? -1 : 1);
        
        res.json(fileData);
    } catch (e) {
        const message = e.message.includes("Path Traversal") ? e.message : `Erro interno: ${e.message}`;
        addLog('error', `Erro ao listar: ${message}`);
        res.status(500).json({ error: message });
    }
});

// 2. Deletar Arquivo
app.delete('/files/delete', async (req, res) => {
    try {
        const { name, currentPath } = req.body;
        if (!name || !currentPath) return res.status(400).json({ error: 'Caminho ou nome inválido' });

        const clientPathToDelete = path.join(currentPath, name);
        const targetPath = getSafeAbsolutePath(clientPathToDelete);
        
        if (targetPath === path.resolve(BOT_DIR)) {
            throw new Error("Não é possível deletar a raiz do diretório do bot.");
        }

        await fs.remove(targetPath);
        addLog('warn', `Deletado: ${path.join(currentPath, name)}`);
        res.json({ success: true });
    } catch (e) {
        const message = e.message.includes("Path Traversal") ? e.message : `Erro ao deletar: ${e.message}`;
        addLog('error', message);
        res.status(500).json({ error: message });
    }
});

// 3. Upload de Arquivo Único
app.post('/files/upload', upload.single('file'), async (req, res) => {
    if (!req.file || !req.body.currentPath) {
        if (req.file) await fs.remove(req.file.path); 
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou caminho faltante.' });
    }
    
    try {
        const clientPath = req.body.currentPath;
        const targetDir = getSafeAbsolutePath(clientPath);

        const originalFilePath = path.join(UPLOAD_DIR, req.file.originalname);
        const finalFilePath = path.join(targetDir, req.file.originalname);
        
        await fs.move(originalFilePath, finalFilePath, { overwrite: true });

        addLog('info', `Upload para: ${clientPath}${req.file.originalname}`);
        res.json({ success: true });

    } catch (e) {
        if (req.file) await fs.remove(req.file.path); 
        const message = e.message.includes("Path Traversal") ? e.message : `Erro no upload: ${e.message}`;
        addLog('error', message);
        res.status(500).json({ error: message });
    }
});


// ----------------------------------------
// --- SOCKET.IO ---
// ----------------------------------------

io.on('connection', (socket) => {
    // 1. Envia o histórico ao conectar
    socket.emit('log-history', logHistory);

    // 2. RECEBE COMANDO DO TERMINAL
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

    // 3. RECEBE REQUISIÇÃO DE REINÍCIO DO LOG
    socket.on('request-log-history', () => {
        logHistory = []; 
        addLog('info', 'Histórico de log do servidor foi limpo por comando do painel.');
        socket.emit('log-history', logHistory); 
    });
});

// ----------------------------------------
// --- INICIALIZAÇÃO DO SERVIDOR ---
// ----------------------------------------

// Ajuste para Koyeb: usa process.env.PORT ou 8080
const PORT = process.env.PORT || 8080;
http.listen(PORT, () => { 
    console.log(`🚀 Servidor Online em http://localhost:${PORT}`); 
});
