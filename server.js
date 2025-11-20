const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const simpleGit = require('simple-git'); // Necessário para puxar do GitHub

// --- CONFIGURAÇÃO ---
const BOT_DIR = path.join(__dirname, 'user_bot'); 
fs.ensureDirSync(BOT_DIR);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// --- ROTAS ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/files/list', async (req, res) => {
    try {
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
        res.json(fileData);
    } catch (e) { res.json([]); }
});

// ROTA MÁGICA: DEPLOY VIA GIT (Funciona para os Bots Prontos)
app.post('/deploy/git', async (req, res) => {
    let { repoUrl, startCommand, installDeps } = req.body;
    
    if (!repoUrl) return res.status(400).json({ error: 'URL vazia.' });

    // Processo de Deploy em Background
    deployFlow(repoUrl, startCommand, installDeps);
    
    res.json({ success: true, message: "Deploy iniciado. Acompanhe no terminal." });
});

// --- FUNÇÕES DO SISTEMA ---

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

async function deployFlow(repoUrl, startCmd, installDeps) {
    try {
        await killBot();
        
        addLog('warn', '--- INICIANDO INSTALAÇÃO DE BOT PRONTO ---');
        addLog('info', 'Limpando diretório antigo...');
        await fs.emptyDir(BOT_DIR);

        addLog('info', `Clonando repositório: ${repoUrl}`);
        await simpleGit().clone(repoUrl, BOT_DIR);
        addLog('success', 'Download concluído!');

        let finalCmd = startCmd || "node index.js";
        
        // Tenta descobrir o comando de start se não foi passado
        if (!startCmd && fs.existsSync(path.join(BOT_DIR, 'package.json'))) {
             const pkg = require(path.join(BOT_DIR, 'package.json'));
             if (pkg.scripts && pkg.scripts.start) finalCmd = "npm start";
        }

        if (installDeps) {
            addLog('info', 'Instalando dependências (npm install)... isso pode demorar.');
            // Executa npm install
            const install = spawn('npm', ['install'], { cwd: BOT_DIR, shell: true });
            
            install.stdout.on('data', d => { if(d.toString().includes('added')) addLog('info', d.toString().trim()); });
            
            install.on('close', (code) => {
                if (code === 0) {
                    addLog('success', 'Dependências instaladas.');
                    startBot(finalCmd);
                } else {
                    addLog('error', 'Erro no npm install. Tentando iniciar mesmo assim...');
                    startBot(finalCmd);
                }
            });
        } else {
            startBot(finalCmd);
        }

    } catch (e) {
        addLog('error', `FALHA CRÍTICA: ${e.message}`);
    }
}

function startBot(command) {
    addLog('success', `Iniciando Bot: ${command}`);
    
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR, shell: true, detached: true, stdio: ['pipe', 'pipe', 'pipe']
    });

    currentBotProcess.stdout.on('data', d => addLog('info', d.toString().trim()));
    currentBotProcess.stderr.on('data', d => addLog('input', d.toString().trim())); // stderr do node geralmente não é erro fatal
    currentBotProcess.on('close', c => addLog('warn', `Bot desligou. Código: ${c}`));
}

// --- SOCKET & LOGS ---
io.on('connection', s => {
    s.emit('log-history', logHistory);
    s.on('terminal-input', cmd => {
        if (currentBotProcess) currentBotProcess.stdin.write(cmd + '\n');
        else if(cmd === 'start') startBot("npm start"); 
    });
});

function addLog(type, text) {
    const log = { type, text, time: new Date().toLocaleTimeString('pt-BR') };
    if (logHistory.length > 100) logHistory.shift();
    io.emit('log-message', log);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`ONLINE NA PORTA ${PORT}`));
