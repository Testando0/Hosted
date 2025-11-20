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

// Configuração Multer (Arquivos Avulsos) - Destination deve ser dinâmica
// Usamos uma pasta temporária e movemos depois, ou configuramos o BOT_DIR e ajustamos na rota.
// Vamos manter o BOT_DIR e mover no frontend/backend
const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BOT_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadFile = multer({ storage: storageFile });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// --- SEGURANÇA DE ARQUIVOS ---
/**
 * Garante que o caminho solicitado está DENTRO da pasta BOT_DIR.
 * @param {string} targetPath - Caminho relativo fornecido pelo cliente (ex: 'src/config.json' ou '../server.js')
 * @returns {string} Caminho absoluto seguro.
 */
function getSafeAbsolutePath(targetPath) {
    if (typeof targetPath !== 'string') targetPath = '';
    
    // Resolve o caminho, tratando sequências como '..'
    const resolvedPath = path.resolve(BOT_DIR, targetPath);
    
    // ⚠️ CRÍTICO: Verifica se o caminho resolvido começa com a pasta base
    if (!resolvedPath.startsWith(BOT_DIR)) {
        throw new Error("Acesso negado: Tentativa de Path Traversal.");
    }
    return resolvedPath;
}

// --- ROTAS DO FILE MANAGER (ATUALIZADAS) ---

// 1. Listar Arquivos
app.get('/files/list', async (req, res) => {
    try {
        // Recebe o caminho a ser listado (ex: '/src' ou '/')
        const clientPath = req.query.path || '/'; 
        const targetDir = getSafeAbsolutePath(clientPath);
        
        if(!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Diretório não encontrado.' });
        if(!fs.statSync(targetDir).isDirectory()) return res.status(400).json({ error: 'Caminho não é um diretório.' });

        const files = await fs.readdir(targetDir);
        const fileData = [];
        
        for (const file of files) {
            // Cria o caminho absoluto para o stat
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
        
        // Ordena: Pastas primeiro, depois arquivos
        fileData.sort((a, b) => (a.isDir === b.isDir) ? 0 : a.isDir ? -1 : 1);
        
        res.json(fileData);
    } catch (e) {
        addLog('error', `Erro ao listar: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 2. Deletar Arquivo
app.delete('/files/delete', async (req, res) => {
    try {
        // Recebe o nome do arquivo e o caminho atual onde ele está
        const { name, currentPath } = req.body;
        if (!name || !currentPath) return res.status(400).json({ error: 'Caminho ou nome inválido' });

        // Constrói o caminho completo a ser deletado (ex: user_bot/src/index.js)
        const fullPathToDelete = path.join(currentPath, name);
        const targetPath = getSafeAbsolutePath(fullPathToDelete);
        
        // Proteção: Não deletar a pasta raiz do bot
        if (targetPath === BOT_DIR) throw new Error("Não é possível deletar a raiz.");

        await fs.remove(targetPath);
        addLog('warn', `Deletado: ${fullPathToDelete}`);
        res.json({ success: true });
    } catch (e) {
        addLog('error', `Erro ao deletar: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 3. Upload de Arquivo Único (Atualizado para mover para a pasta correta)
app.post('/files/upload', uploadFile.single('file'), async (req, res) => {
    if (!req.file || !req.body.currentPath) {
        await fs.remove(req.file ? req.file.path : ''); // Limpa o arquivo se der erro
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou caminho faltante.' });
    }
    
    try {
        const clientPath = req.body.currentPath; // Caminho de destino (ex: '/src')
        const targetDir = getSafeAbsolutePath(clientPath);

        // O arquivo foi salvo temporariamente em BOT_DIR/nome-original. Agora movemos para a pasta correta.
        const originalFilePath = path.join(BOT_DIR, req.file.originalname);
        const finalFilePath = path.join(targetDir, req.file.originalname);
        
        // Usa fs-extra para mover (substitui se já existir)
        await fs.move(originalFilePath, finalFilePath, { overwrite: true });

        addLog('info', `Upload: ${finalFilePath}`);
        res.json({ success: true });

    } catch (e) {
        addLog('error', `Erro no upload: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// --- FUNÇÕES AUXILIARES E DEPLOY (MANTIDAS) ---

// Código para Socket.IO, Logs (addLog), KillBot, Deploy ZIP/GIT, DeployFlow, StartBot...
// ... (mantenha todo o restante do código do server.js V5.0 aqui)

// --- SOCKET.IO ---
io.on('connection', (socket) => {
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
