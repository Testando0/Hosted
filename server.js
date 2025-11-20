const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const simpleGit = require('simple-git');
const multer = require('multer'); 
const AdmZip = require('adm-zip'); 

// --- CONFIGURAÇÃO ---
const BOT_DIR = path.join(__dirname, 'user_bot'); 
fs.ensureDirSync(BOT_DIR);

// Configuração do Multer (Upload de arquivos)
const TEMP_UPLOADS_DIR = path.join(__dirname, 'temp_uploads');
fs.ensureDirSync(TEMP_UPLOADS_DIR);
const upload = multer({ dest: TEMP_UPLOADS_DIR });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// --- UTILS & LOGS ---
const getTime = () => new Date().toLocaleTimeString('pt-BR');

function addLog(type, text) {
    const log = { type, text, time: getTime() };
    if (logHistory.length > 100) logHistory.shift();
    io.emit('log-message', log);
    // console.log(`[${type}] ${text}`); // Mantenha para debug local
}

async function killBot() {
    if (currentBotProcess) {
        addLog('warn', 'Parando processo atual...');
        try { 
            // Mata o processo e seus descendentes (detached: true)
            process.kill(-currentBotProcess.pid, 'SIGTERM'); 
        } catch (e) {
            try { currentBotProcess.kill(); } catch (err) {}
        }
        currentBotProcess = null;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function startBot(command) {
    addLog('success', `Iniciando Bot: ${command}`);
    
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR, shell: true, detached: true, stdio: ['pipe', 'pipe', 'pipe']
    });

    currentBotProcess.stdout.on('data', d => addLog('info', d.toString().trim()));
    currentBotProcess.stderr.on('data', d => addLog('error', d.toString().trim()));
    currentBotProcess.on('close', c => addLog('warn', `Bot desligou. Código: ${c}`));
    currentBotProcess.on('error', err => addLog('error', `Erro de execução: ${err.message}`));
}

async function deployDependencies(finalCmd) {
    addLog('info', 'Instalando dependências (npm install)... isso pode demorar.');
    const install = spawn('npm', ['install'], { cwd: BOT_DIR, shell: true });
    
    install.stdout.on('data', d => { if(d.toString().includes('added')) addLog('info', d.toString().trim()); });
    install.stderr.on('data', d => addLog('error', d.toString().trim()));
    
    install.on('close', (code) => {
        if (code === 0) {
            addLog('success', 'Dependências instaladas.');
            startBot(finalCmd);
        } else {
            addLog('error', `Erro no npm install. Código: ${code}. Tentando iniciar mesmo assim...`);
            startBot(finalCmd);
        }
    });
}

// --- DEPLOY LOGIC (GIT/BOTS PRONTOS) ---

async function deployFlow(repoUrl, startCmd, installDeps) {
    try {
        await killBot();
        
        addLog('warn', '--- INICIANDO INSTALAÇÃO DE BOT VIA GIT ---');
        addLog('info', 'Limpando diretório antigo...');
        await fs.emptyDir(BOT_DIR);

        addLog('info', `Clonando repositório: ${repoUrl}`);
        // Clone para o BOT_DIR
        await simpleGit().clone(repoUrl, BOT_DIR); 
        addLog('success', 'Download concluído!');

        let finalCmd = startCmd || "node index.js";
        
        // Tenta descobrir o comando de start se não foi passado (melhoria)
        if (!startCmd && fs.existsSync(path.join(BOT_DIR, 'package.json'))) {
             try {
                 const pkgContent = await fs.readFile(path.join(BOT_DIR, 'package.json'), 'utf8');
                 const pkg = JSON.parse(pkgContent);
                 if (pkg.scripts && pkg.scripts.start) finalCmd = "npm start";
             } catch(e) {
                 addLog('warn', 'Não foi possível ler package.json para comando de start. Usando default.');
             }
        }

        if (installDeps) {
            deployDependencies(finalCmd);
        } else {
            startBot(finalCmd);
        }

    } catch (e) {
        addLog('error', `FALHA CRÍTICA NO DEPLOY: ${e.message}`);
    }
}


// --- ROTAS (API) ---

// ROTA DEPLOY VIA GIT (Usada pelos BOTS PRONTOS e GIT CUSTOM)
app.post('/deploy/git', (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    
    if (!repoUrl) return res.status(400).json({ error: 'URL vazia.' });

    // Processo de Deploy em Background
    deployFlow(repoUrl, startCommand, installDeps);
    
    res.json({ success: true, message: "Deploy iniciado. Acompanhe no terminal." });
});


// ROTA DEPLOY VIA ZIP
app.post('/deploy/zip', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    // Note que installDeps e startCommand vêm como strings do formData
    const { startCommand, installDeps } = req.body;
    const zipPath = req.file.path;

    try {
        await killBot();
        addLog('warn', '--- INICIANDO INSTALAÇÃO DE BOT VIA ZIP ---');
        addLog('info', 'Limpando diretório antigo...');
        await fs.emptyDir(BOT_DIR);
        
        const zip = new AdmZip(zipPath);
        // Descompacta todos os arquivos para BOT_DIR
        zip.extractAllTo(BOT_DIR, true);
        addLog('success', 'Descompactação concluída!');

        await fs.remove(zipPath); // Limpa o arquivo ZIP temporário
        
        const finalCmd = startCommand || "node index.js";
        const doInstall = installDeps === 'true' || installDeps === true; // Verifica string ou booleano

        if (doInstall) {
             deployDependencies(finalCmd);
        } else {
            startBot(finalCmd);
        }
        
        res.json({ success: true, message: "Deploy ZIP iniciado. Acompanhe no terminal." });

    } catch (e) {
        // Garantir que o temp file seja removido em caso de erro na descompactação
        await fs.remove(zipPath).catch(() => {});
        addLog('error', `FALHA CRÍTICA NO DEPLOY ZIP: ${e.message}`);
        res.status(500).json({ error: `Erro no deploy ZIP: ${e.message}` });
    }
});


// ROTA PARA LISTAR ARQUIVOS (Suporte a Navegação)
app.get('/files/list', async (req, res) => {
    const requestedPath = req.query.path || '/';
    // Normalização e segurança do caminho
    const relativePath = path.normalize(requestedPath.replace(/^\/|\/$/g, ''));
    const absolutePath = path.join(BOT_DIR, relativePath === '.' ? '' : relativePath);
    
    if (!absolutePath.startsWith(BOT_DIR)) {
        return res.status(400).json({ error: 'Caminho inválido ou fora do diretório do bot.' });
    }

    try {
        const files = await fs.readdir(absolutePath);
        const fileData = [];
        for (const file of files) {
            try {
                const stats = await fs.stat(path.join(absolutePath, file));
                fileData.push({
                    name: file,
                    isDir: stats.isDirectory(),
                    size: (stats.size / 1024).toFixed(1) + ' KB'
                });
            } catch(e) {}
        }
        res.json(fileData);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});


// ROTA PARA UPLOAD DE ARQUIVO ÚNICO
app.post('/files/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    
    const { currentPath } = req.body;
    const destDir = path.join(BOT_DIR, path.normalize(currentPath));
    const destPath = path.join(destDir, req.file.originalname);
    
    try {
        await fs.ensureDir(destDir);
        await fs.move(req.file.path, destPath, { overwrite: true });
        res.json({ success: true });
    } catch (e) {
        await fs.remove(req.file.path).catch(() => {});
        res.status(500).json({ error: e.message });
    }
});

// ROTA PARA DELETAR ARQUIVO/PASTA
app.delete('/files/delete', async (req, res) => {
    const { name, currentPath } = req.body;
    
    const absolutePath = path.join(BOT_DIR, path.normalize(currentPath), name);
    
    if (!absolutePath.startsWith(BOT_DIR)) {
        return res.status(400).json({ error: 'Tentativa de deletar fora do diretório do bot.' });
    }

    try {
        await fs.remove(absolutePath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- SOCKET & LOGS ---
io.on('connection', s => {
    s.emit('log-history', logHistory);
    s.on('request-log-history', () => s.emit('log-history', logHistory)); 
    
    s.on('terminal-input', cmd => {
        if (currentBotProcess) currentBotProcess.stdin.write(cmd + '\n');
        else if(cmd.toLowerCase() === 'start') startBot("npm start"); 
        else addLog('warn', 'Nenhum bot rodando. Use "start" para iniciar um bot instalado.');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`ONLINE NA PORTA ${PORT}`));
