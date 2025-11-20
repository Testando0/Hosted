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
            try {
                currentBotProcess.stdin.write(cmd + '\n');
                io.emit('log-message', { type: 'input', text: `$ ${cmd}`, time: getTime() });
            } catch (e) {
                io.emit('log-message', { type: 'error', text: 'Erro ao enviar comando (Processo morto?)', time: getTime() });
            }
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

    // Executa a sequência
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


// --- LÓGICA CENTRAL DE DEPLOY (CORRIGIDA) ---
async function runDeploySequence(startCmd, shouldInstall, fileHandler) {
    try {
        // 1. Matar processo antigo BLINDADO
        if (currentBotProcess) {
            systemLog('warn', 'Encerrando instância anterior...');
            try {
                // Tenta matar o processo e seus filhos
                process.kill(-currentBotProcess.pid);
            } catch (e) {
                // Se o erro for ESRCH, significa que já estava morto. Ignoramos.
                if (e.code !== 'ESRCH') {
                    systemLog('error', `Erro ao matar processo: ${e.message}`);
                } else {
                    systemLog('info', 'Instância anterior já estava encerrada (Zombie process cleaned).');
                }
            }
            currentBotProcess = null;
        }

        // 2. Limpar diretório
        systemLog('warn', 'Limpando diretório do sistema...');
        await fs.emptyDir(BOT_DIR);

        // 3. Colocar arquivos novos (Zip ou Git)
        await fileHandler();

        // 4. Preparar comando final
        let finalCommand = startCmd;
        
        // Nota: No Windows 'npm' é cmd, no Linux é direto. O Render é Linux.
        if (shouldInstall) {
            systemLog('info', 'Instalando dependências (npm install)... aguarde.');
            finalCommand = `npm install && ${startCmd}`;
        }

        // 5. Iniciar Bot
        startBotProcess(finalCommand);

    } catch (error) {
        systemLog('error', `FALHA CRÍTICA NO DEPLOY: ${error.message}`);
        console.error(error);
    }
}

function startBotProcess(command) {
    systemLog('success', `Inicializando Protocolo: ${command}`);

    // Spawn com shell true
    currentBotProcess = spawn(command, {
        cwd: BOT_DIR,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'] 
    });

    if (currentBotProcess.stdout) {
        currentBotProcess.stdout.on('data', (data) => {
            io.emit('log-message', { type: 'info', text: data.toString().trim(), time: getTime() });
        });
    }

    if (currentBotProcess.stderr) {
        currentBotProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            // Filtra avisos chatos do NPM para não poluir o vermelho
            if(!msg.includes('npm WARN') && !msg.includes('npm notice')) {
                io.emit('log-message', { type: 'error', text: msg, time: getTime() });
            }
        });
    }

    currentBotProcess.on('close', (code) => {
        systemLog('warn', `Processo finalizado. Código: ${code}`);
        // Não definimos null aqui imediatamente para permitir logs finais
    });
}

// Porta do Render
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`RED PROTOCOL STARTED ON PORT ${PORT}`);
});
