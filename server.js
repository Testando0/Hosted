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

// Garante pastas limpas na inicialização
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(BOT_DIR);

// Configuração Upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot_package.zip')
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;

// --- SOCKET.IO (COMUNICAÇÃO REAL-TIME) ---
io.on('connection', (socket) => {
    systemLog('info', 'Operador conectado ao Painel de Controle [C2].');

    // Recebe comandos do input do site e envia para o Bot (STDIN)
    socket.on('terminal-input', (cmd) => {
        if (currentBotProcess && !currentBotProcess.killed) {
            // Escreve no console do bot
            currentBotProcess.stdin.write(cmd + '\n');
            // Mostra no log do site que você digitou
            io.emit('log-message', { type: 'input', text: `$ ${cmd}`, time: getTime() });
        } else {
            io.emit('log-message', { type: 'error', text: 'Nenhum bot rodando para receber comandos.', time: getTime() });
        }
    });
});

function getTime() { return new Date().toLocaleTimeString('pt-BR'); }

function systemLog(type, msg) {
    io.emit('log-message', { type, text: msg, time: getTime() });
    console.log(`[SYSTEM-${type.toUpperCase()}] ${msg}`);
}

// --- FUNÇÕES DE DEPLOY ---

// Rota 1: Deploy via ZIP
app.post('/deploy/zip', upload.single('file'), async (req, res) => {
    const { startCommand, installDeps } = req.body;
    
    if (!req.file) return res.status(400).json({ error: 'Arquivo ZIP obrigatório.' });

    await runDeploySequence(startCommand, installDeps === 'true', async () => {
        systemLog('info', 'Extraindo pacote ZIP...');
        const zip = new AdmZip(path.join(UPLOAD_DIR, 'bot_package.zip'));
        zip.extractAllTo(BOT_DIR, true);
    });

    res.json({ success: true });
});

// Rota 2: Deploy via GitHub
app.post('/deploy/git', async (req, res) => {
    const { repoUrl, startCommand, installDeps } = req.body;

    if (!repoUrl) return res.status(400).json({ error: 'URL do Git obrigatória.' });

    await runDeploySequence(startCommand, installDeps === 'true', async () => {
        systemLog('info', `Clonando repositório: ${repoUrl}...`);
        await simpleGit().clone(repoUrl, BOT_DIR);
    });

    res.json({ success: true });
});


// Lógica Central de Deploy
async function runDeploySequence(startCmd, shouldInstall, fileHandler) {
    try {
        // 1. Matar processo antigo
        if (currentBotProcess) {
            systemLog('warn', 'Encerrando instância ativa...');
            process.kill(-currentBotProcess.pid); // Mata arvore de processos se possível
            try { currentBotProcess.kill(); } catch(e){}
            currentBotProcess = null;
        }

        // 2. Limpar diretório
        systemLog('warn', 'Limpando diretório do sistema...');
        await fs.emptyDir(BOT_DIR);

        // 3. Colocar arquivos novos (Zip ou Git)
        await fileHandler();

        // 4. Preparar comando final
        let finalCommand = startCmd;
        if (shouldInstall) {
            systemLog('info', 'Configuração de dependências ativada (npm install).');
            finalCommand = `npm install && ${startCmd}`;
        }

        // 5. Iniciar Bot
        startBotProcess(finalCommand);

    } catch (error) {
        systemLog('error', `FALHA CRÍTICA NO DEPLOY: ${error.message}`);
    }
}

function startBotProcess(command) {
    systemLog('success', `Inicializando Protocolo: ${command}`);

    // Spawn com shell true para permitir "&&" e pipes
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'] // Permite input e output
    });

    currentBotProcess.stdout.on('data', (data) => {
        io.emit('log-message', { type: 'info', text: data.toString().trim(), time: getTime() });
    });

    currentBotProcess.stderr.on('data', (data) => {
        io.emit('log-message', { type: 'error', text: data.toString().trim(), time: getTime() });
    });

    currentBotProcess.on('close', (code) => {
        systemLog('warn', `Processo finalizado. Código: ${code}`);
    });
}

// Porta do Render
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`RED PROTOCOL STARTED ON PORT ${PORT}`);
});
