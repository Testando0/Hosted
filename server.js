const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

// --- CONFIGURAÇÕES ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BOT_DIR = path.join(__dirname, 'user_bot');

// Garante que as pastas existem
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(BOT_DIR)) fs.mkdirSync(BOT_DIR);

// Configuração do Multer (Upload)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot.zip')
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Variável global para controlar o processo do bot do usuário
let currentBotProcess = null;

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    systemLog('info', 'Painel de Controle conectado.');
});

function systemLog(type, msg) {
    const time = new Date().toLocaleTimeString('pt-BR');
    io.emit('log-message', { type, text: msg, time });
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- ROTA DE UPLOAD E DEPLOY ---
app.post('/upload', upload.single('botFile'), (req, res) => {
    const startCommand = req.body.startCommand; // Ex: "node index.js"

    if (!req.file || !startCommand) {
        return res.status(400).json({ error: 'Arquivo ou comando faltando.' });
    }

    systemLog('warn', '>>> INICIANDO PROTOCOLO DE DEPLOY <<<');
    
    try {
        // 1. Matar processo anterior se existir
        if (currentBotProcess) {
            systemLog('info', 'Encerrando bot anterior...');
            currentBotProcess.kill();
            currentBotProcess = null;
        }

        // 2. Limpar pasta antiga
        // (Simplificado: assumindo que extrairemos por cima ou deletamos arquivos manuais se tiver fs-extra)
        
        // 3. Extrair o ZIP
        systemLog('info', 'Extraindo arquivos...');
        const zip = new AdmZip(path.join(UPLOAD_DIR, 'bot.zip'));
        zip.extractAllTo(BOT_DIR, true); // true = overwrite
        systemLog('success', 'Arquivos extraídos com sucesso.');

        // 4. Iniciar o Bot
        startUserBot(startCommand);

        res.json({ success: true });

    } catch (err) {
        systemLog('error', 'Falha no deploy: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- FUNÇÃO PARA RODAR O BOT DO USUÁRIO ---
function startUserBot(fullCommand) {
    systemLog('info', `Executando comando: ${fullCommand}`);

    // Separa "node index.js" em comando="node" e args=["index.js"]
    const parts = fullCommand.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    // Spawna o processo na pasta do bot
    currentBotProcess = spawn(cmd, args, {
        cwd: BOT_DIR,
        shell: true // Permite comandos compostos e variáveis de ambiente
    });

    // Escuta o que o bot "fala" (console.log)
    currentBotProcess.stdout.on('data', (data) => {
        // Envia para o terminal web como texto branco/padrão
        io.emit('log-message', { type: 'info', text: data.toString().trim(), time: new Date().toLocaleTimeString('pt-BR') });
    });

    // Escuta erros do bot
    currentBotProcess.stderr.on('data', (data) => {
        io.emit('log-message', { type: 'error', text: data.toString().trim(), time: new Date().toLocaleTimeString('pt-BR') });
    });

    currentBotProcess.on('close', (code) => {
        systemLog('warn', `Processo do bot encerrado com código: ${code}`);
        currentBotProcess = null;
    });
}

// --- SERVIDOR WEB ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`C2 SERVER ONLINE: PORT ${PORT}`);
});
