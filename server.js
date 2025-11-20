const express = require('express');
const app = express();
const http = require('http').createServer(app);
// Socket.io permanece, pois o Koyeb suporta WebSockets
const io = require('socket.io')(http); 
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');
const { spawn } = require('child_process');

// --- CONFIGURAÇÃO DE DIRETÓRIOS ---
// Define a pasta do bot dentro da raiz do projeto.
// No Koyeb, este será o diretório persistente do contêiner.
const BOT_DIR = path.join(__dirname, 'user_bot'); 
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads'); 

// --- VARIÁVEIS DE ESTADO ---
let currentBotProcess = null;
let logHistory = [];

// --- CONFIGURAÇÃO MULTER ---
// Usamos a pasta de uploads temporários (dentro do projeto)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Garante que o UPLOAD_DIR exista antes de salvar
        fs.ensureDirSync(UPLOAD_DIR); 
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

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
        // CRÍTICO: Path Traversal
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
            // Tenta matar o grupo de processos (mais robusto no Linux/Koyeb)
            process.kill(-currentBotProcess.pid); 
        } catch (e) {
            try { currentBotProcess.kill(); } catch (err) {}
        }
        currentBotProcess = null;
        // Tempo para o sistema operacional liberar os recursos
        await new Promise(resolve => setTimeout(resolve, 1500)); 
    }
}

function startBot(command) {
    addLog('success', `Iniciando Processo: ${command}`);

    // Configuração do spawn
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR,
        shell: true,
        // Detached e pipe são essenciais para gerenciar o processo remotamente
        detached: true, 
        stdio: ['pipe', 'pipe', 'pipe'] 
    });
    
    // Logs (stdout)
    currentBotProcess.stdout.on('data', (data) => {
        addLog('info', data.toString().trim());
    });
    
    // Erros (stderr)
    currentBotProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Filtra warnings comuns do npm para o canal "input"
        if (!msg.includes('npm WARN') && !msg.includes('npm notice') && !msg.includes('Cloning into')) {
            addLog('error', msg);
        } else {
            addLog('input', msg);
        }
    });

    // Processo desligado
    currentBotProcess.on('close', (code) => {
        addLog('warn', `Bot desligado. Código de saída: ${code}`);
    });
    
    // Erros de execução (como comando não encontrado)
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
        // Garante que o diretório exista antes de limpá-lo
        await fs.ensureDir(BOT_DIR);
        await fs.emptyDir(BOT_DIR); 
        
        await fileHandler(); // Extrai ZIP ou Clona GIT

        let finalCmd = startCmd;
        
        if (shouldInstall) {
            addLog('info', 'Executando npm install (aguarde)...');
            // O uso do "&&" garante que o bot só inicie se a instalação for bem-sucedida
            finalCmd = `npm install --prefix ${BOT_DIR} && ${startCmd}`; 
        }

        startBot(finalCmd);
        
        // Limpa a pasta de uploads temporários
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
        // Extrai o conteúdo do ZIP para a pasta do bot
        zip.extractAllTo(BOT_DIR, true); 
    });
    
    // O status de sucesso é enviado imediatamente para não travar o cliente
    res.json({ success: true, message: "Deploy iniciado." }); 
});

// Deploy via GIT
app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'URL Git vazia.' });

    await deployFlow(startCommand, installDeps === 'true', async () => {
        addLog('info', `Clonando ${repoUrl}...`);
        // Clona para a pasta BOT_DIR
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
        
        // Garante que o diretório BOT_DIR exista para a primeira chamada
        await fs.ensureDir(BOT_DIR);

        if(!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Diretório não encontrado.' });
        if(!fs.statSync(targetDir).isDirectory()) return res.status(400).json({ error: 'Caminho não é um diretório.' });

        // ... (restante da lógica de listagem) ...
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
// Usamos upload.single('file') definido anteriormente
app.post('/files/upload', upload.single('file'), async (req, res) => {
    if (!req.file || !req.body.currentPath) {
        // Se falhou, limpa o arquivo temporário
        if (req.file) await fs.remove(req.file.path); 
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou caminho faltante.' });
    }
    
    try {
        const clientPath = req.body.currentPath;
        const targetDir = getSafeAbsolutePath(clientPath);

        const originalFilePath = path.join(UPLOAD_DIR, req.file.originalname);
        const finalFilePath = path.join(targetDir, req.file.originalname);
        
        // Move do temp_uploads para a pasta final dentro do user_bot
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
                // Escreve o comando no STDIN do processo do bot
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
        logHistory = []; // Limpa o histórico no servidor
        addLog('info', 'Histórico de log do servidor foi limpo por comando do painel.');
        // Reenvia o histórico (agora limpo) para o cliente que solicitou
        socket.emit('log-history', logHistory); 
    });
});

// ----------------------------------------
// --- INICIALIZAÇÃO DO SERVIDOR ---
// ----------------------------------------

// COYEB ESPERA QUE O SERVIDOR ESCUTE NA PORTA 8080 (OU process.env.PORT)
const PORT = process.env.PORT || 8080;
http.listen(PORT, () => { 
    console.log(`🚀 Servidor Online em http://localhost:${PORT}`); 
    console.log('Ambiente configurado para Koyeb/Serviços Persistentes.');
});
