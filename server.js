const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const simpleGit = require('simple-git');
const multer = require('multer'); // Para uploads de arquivos
const AdmZip = require('adm-zip'); // Para descompactar ZIP

// --- CONFIGURAÇÃO ---
const BOT_DIR = path.join(__dirname, 'user_bot'); 
fs.ensureDirSync(BOT_DIR);
const upload = multer({ dest: path.join(__dirname, 'temp_uploads') }); // Pasta temporária para uploads

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// --- UTILS ---
const getTime = () => new Date().toLocaleTimeString('pt-BR');

function addLog(type, text) {
    const log = { type, text, time: getTime() };
    if (logHistory.length > 100) logHistory.shift();
    io.emit('log-message', log);
    console.log(`[${type}] ${text}`);
}

async function killBot() {
    if (currentBotProcess) {
        addLog('warn', 'Parando processo atual...');
        try { process.kill(-currentBotProcess.pid); } catch (e) {
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
    currentBotProcess.stderr.on('data', d => addLog('input', d.toString().trim()));
    currentBotProcess.on('close', c => addLog('warn', `Bot desligou. Código: ${c}`));
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
        // Usa o BOT_DIR como diretório de destino
        await simpleGit().clone(repoUrl, BOT_DIR); 
        addLog('success', 'Download concluído!');

        let finalCmd = startCmd || "node index.js";
        
        // Tenta descobrir o comando de start se não foi passado
        if (!startCmd && fs.existsSync(path.join(BOT_DIR, 'package.json'))) {
             const pkg = require(path.join(BOT_DIR, 'package.json'));
             if (pkg.scripts && pkg.scripts.start) finalCmd = "npm start";
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

// ROTA DE DEPLOY VIA GIT (Usada pelos BOTS PRONTOS e GIT CUSTOM)
app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    
    if (!repoUrl) return res.status(400).json({ error: 'URL vazia.' });

    // Processo de Deploy em Background
    deployFlow(repoUrl, startCommand, installDeps);
    
    res.json({ success: true, message: "Deploy iniciado. Acompanhe no terminal." });
});


// ROTA DE DEPLOY VIA ZIP (Implementada para que o HTML funcione, mas REMOVIDA do menu)
app.post('/deploy/zip', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const { startCommand, installDeps } = req.body;
    const zipPath = req.file.path;

    try {
        await killBot();
        addLog('warn', '--- INICIANDO INSTALAÇÃO DE BOT VIA ZIP ---');
        addLog('info', 'Limpando diretório antigo...');
        await fs.emptyDir(BOT_DIR);
        
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(BOT_DIR, true);
        addLog('success', 'Descompactação concluída!');

        await fs.remove(zipPath); // Limpa o arquivo ZIP temporário
        
        const finalCmd = startCommand || "node index.js";

        if (installDeps === 'true') {
             deployDependencies(finalCmd);
        } else {
            startBot(finalCmd);
        }
        
        res.json({ success: true, message: "Deploy ZIP iniciado. Acompanhe no terminal." });

    } catch (e) {
        addLog('error', `FALHA CRÍTICA NO DEPLOY ZIP: ${e.message}`);
        res.status(500).json({ error: `Erro no deploy: ${e.message}` });
    }
});


// ROTA PARA LISTAR ARQUIVOS (Suporte a Navegação)
app.get('/files/list', async (req, res) => {
    // Sanitize path: Remove '..' e garante que o caminho seja interno
    const requestedPath = req.query.path || '/';
    const relativePath = path.normalize(requestedPath.replace(/^\/|\/$/g, ''));
    
    // Constrói o caminho absoluto seguro
    const absolutePath = path.join(BOT_DIR, relativePath === '.' ? '' : relativePath);
    
    // Garante que o usuário não saia do BOT_DIR (segurança)
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
    const destPath = path.join(BOT_DIR, path.normalize(currentPath), req.file.originalname);
    
    try {
        // Move o arquivo temporário para o destino final
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
    // Permite que o frontend peça o histórico novamente (usado para o botão 'REINICIAR')
    s.on('request-log-history', () => s.emit('log-history', logHistory)); 
    
    s.on('terminal-input', cmd => {
        if (currentBotProcess) currentBotProcess.stdin.write(cmd + '\n');
        else if(cmd === 'start') startBot("npm start"); 
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`ONLINE NA PORTA ${PORT}`));
