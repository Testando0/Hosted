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

fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(BOT_DIR);

// Configuração Multer (ZIP)
const storageZip = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot_package.zip')
});
const uploadZip = multer({ storage: storageZip });

// Configuração Multer (Arquivos Avulsos) - Salva temporariamente
const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadFile = multer({ storage: storageFile });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// ----------------------------------------
// --- SEGURANÇA DE ARQUIVOS (CORRIGIDO) ---
// ----------------------------------------

/**
 * Garante que o caminho solicitado (clientPath) está DENTRO da pasta BOT_DIR, 
 * independentemente de ter '..' ou barras extras.
 * @param {string} clientPath - Caminho limpo ou relativo fornecido pelo cliente (ex: '/src/' ou 'index.js')
 * @returns {string} Caminho absoluto seguro.
 */
function getSafeAbsolutePath(clientPath) {
    if (typeof clientPath !== 'string') clientPath = '';
    
    // 1. Resolve o caminho RELATIVO ao BOT_DIR. Isso trata '..' e barras.
    // path.join junta BOT_DIR e clientPath, tratando a diferença de barras.
    const targetPath = path.join(BOT_DIR, clientPath);

    // 2. Resolve o caminho para sua forma final (absoluta e limpa).
    const resolvedPath = path.resolve(targetPath);
    
    // 3. CRÍTICO: Verifica se o resolvedPath ainda está dentro do BOT_DIR.
    // Usamos path.normalize em BOT_DIR para remover a barra final para comparação segura.
    const botDirNormalized = path.normalize(BOT_DIR);
    
    if (!resolvedPath.startsWith(botDirNormalized)) {
        throw new Error("Acesso negado: Tentativa de Path Traversal.");
    }
    
    return resolvedPath;
}

// --- ROTAS DO FILE MANAGER (CORRIGIDAS) ---

// 1. Listar Arquivos
app.get('/files/list', async (req, res) => {
    try {
        const clientPath = req.query.path || '/'; 
        const targetDir = getSafeAbsolutePath(clientPath); 
        
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
app.post('/files/upload', uploadFile.single('file'), async (req, res) => {
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

// --- FUNÇÕES AUXILIARES E DEPLOY ---

// --- SOCKET.IO (LOGIC OFICIAL DO BOT) ---
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

    // 3. NOVO: RECEBE REQUISIÇÃO DE REINÍCIO DO LOG
    socket.on('request-log-history', () => {
        logHistory = []; // Limpa o histórico no servidor
        addLog('info', 'Histórico de log do servidor foi limpo por comando do painel.');
        // Reenvia o histórico (agora limpo) para o cliente que solicitou (e ele recarrega a tela)
        socket.emit('log-history', logHistory); 
    });
});

function getTime() { return new Date().toLocaleTimeString('pt-BR'); }

function addLog(type, text) {
    const logEntry = { type, text, time: getTime() };
    
    if (logHistory.length > 50) logHistory.shift();
    logHistory.push(logEntry);

    // Envia a nova mensagem para todos os clientes conectados
    io.emit('log-message', logEntry);
    
    if(type === 'error' || type === 'warn' || type === 'success') {
        console.log(`[${type.toUpperCase()}] ${text}`);
    }
}

async function killBot() {
    if (currentBotProcess) {
        addLog('warn', 'Encerrando processo anterior...');
        try {
            // Tenta matar o grupo de processos (mais robusto)
            process.kill(-currentBotProcess.pid); 
        } catch (e) {
            try { currentBotProcess.kill(); } catch (err) {}
        }
        currentBotProcess = null;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

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

app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'URL Git vazia.' });

    deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', `Clonando ${repoUrl}...`);
        await simpleGit().clone(repoUrl, BOT_DIR);
    });
    res.json({ success: true });
});

async function deployFlow(startCmd, shouldInstall, fileHandler) {
    try {
        startCmd = String(startCmd).trim();
        if(!startCmd) startCmd = "node index.js";

        await killBot();
        
        addLog('warn', 'Limpando diretório e preparando...');
        await fs.emptyDir(BOT_DIR);
        
        await fileHandler();

        let finalCmd = startCmd;
        
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
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`SERVER ONLINE PORT ${PORT}`); });
