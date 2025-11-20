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

// Configuração Multer
const storageZip = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'bot_package.zip')
});
const uploadZip = multer({ storage: storageZip });

const storageFile = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadFile = multer({ storage: storageFile });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let currentBotProcess = null;
let logHistory = [];

// --- DADOS DE USUÁRIOS E SERVIDORES (SIMULAÇÃO DB) ---
// Em produção, substitua por um banco de dados real (PostgreSQL, MySQL, etc.)
const USERS = {}; 
const SERVERS = {};
let nextPterodactylUserId = 1000;
const PLANS = {
    bronze: { cost: 50, ram: '2GB', cpu: '50%' },
    prata: { cost: 100, ram: '4GB', cpu: '75%' }
};

// --- SEGURANÇA DE ARQUIVOS (MANTIDA E CRÍTICA) ---
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

// -------------------------------------------------------------
// --- ROTAS DA DASHBOARD DO CLIENTE (AUTENTICAÇÃO E NEGÓCIOS) ---
// -------------------------------------------------------------

// Middleware de verificação de Token (SIMULAÇÃO)
function authenticateUser(req, res, next) {
    const userEmail = req.headers['x-user-email'];
    if (userEmail && USERS[userEmail]) {
        req.user = USERS[userEmail];
        req.user.email = userEmail;
        return next();
    }
    // Redireciona usuários não autenticados na Dashboard
    res.status(401).json({ error: 'Não autorizado. Faça login.' });
}

// 1. Registro
app.post('/auth/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    if (USERS[email]) return res.status(409).json({ error: 'Usuário já existe.' });

    USERS[email] = { 
        password: password, 
        coins: 100, 
        pterodactyl_id: nextPterodactylUserId++ 
    };

    // Em produção: API Pterodactyl para criar o usuário lá
    addLog('info', `[AUTH] Novo usuário registrado: ${email} (Ptero ID: ${USERS[email].pterodactyl_id})`);

    res.json({ success: true, message: 'Registro efetuado com sucesso.' });
});

// 2. Login
app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    const user = USERS[email];

    if (user && user.password === password) {
        res.json({ success: true, email: email, message: 'Login bem-sucedido.' });
    } else {
        res.status(401).json({ error: 'Credenciais inválidas.' });
    }
});

// 3. Status do Cliente (Coins e Servidores)
app.get('/client/status', authenticateUser, (req, res) => {
    const userServers = Object.keys(SERVERS)
        .filter(uuid => SERVERS[uuid].user_email === req.user.email)
        .map(uuid => ({ uuid, ...SERVERS[uuid] }));

    res.json({
        coins: req.user.coins,
        plans: PLANS,
        servers: userServers
    });
});

// 4. Criação de Servidor (Compra)
app.post('/client/createServer', authenticateUser, (req, res) => {
    const { plan } = req.body;
    const planDetails = PLANS[plan];

    if (!planDetails) return res.status(400).json({ error: 'Plano inválido.' });
    const cost = planDetails.cost;

    if (req.user.coins < cost) {
        return res.status(400).json({ error: 'Saldo de coins insuficiente.' });
    }
    
    req.user.coins -= cost;

    const newUuid = 'srv-' + Math.random().toString(36).substring(2, 9);
    SERVERS[newUuid] = {
        user_email: req.user.email,
        plan: plan,
        status: 'Instalando',
        pterodactyl_url: `http://pterodactyl.seu_host.com/server/${newUuid}`, // URL de Exemplo
        details: planDetails
    };

    // CRÍTICO: CHAMA A API PTERODACTYL AQUI
    addLog('success', `[NEGÓCIO] Servidor ${newUuid} criado para ${req.user.email} (Plano ${plan}). CHAME A API PTERODACTYL para provisionamento.`);
    
    res.json({ 
        success: true, 
        message: `Servidor ${newUuid} criado. Dedução de ${cost} coins.`,
        server_uuid: newUuid,
        new_coins: req.user.coins
    });
});

// 5. Compra de Coins (Simulação)
app.post('/client/buyCoins', authenticateUser, (req, res) => {
    const { amount } = req.body; 
    const coinAmount = parseInt(amount);

    if (isNaN(coinAmount) || coinAmount <= 0) return res.status(400).json({ error: 'Valor inválido.' });

    // Em produção: INTEGRAÇÃO REAL DE PAGAMENTO
    req.user.coins += coinAmount;
    
    addLog('info', `[NEGÓCIO] ${req.user.email} comprou ${coinAmount} coins.`);
    res.json({ 
        success: true, 
        message: `Adicionado ${coinAmount} coins.`,
        new_coins: req.user.coins
    });
});


// -----------------------------------------------------
// --- ROTAS DO ADMIN (TERMINAL/FILE MANAGER - MANTIDAS) ---
// -----------------------------------------------------

// 1. Listar Arquivos (Mantida)
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

// 2. Deletar Arquivo (Mantida)
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

// 3. Upload de Arquivo Único (Mantida)
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

// 4. Rotas de Deploy (Mantidas)
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


// ------------------------------------
// --- SOCKET.IO E FUNÇÕES AUXILIARES ---
// ------------------------------------

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

    socket.on('request-log-history', () => {
        logHistory = [];
        addLog('info', 'Histórico de log do servidor foi limpo por comando do painel.');
        socket.emit('log-history', logHistory);
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

// Rota para o cliente: Acessível via http://localhost:3000/dashboard.html
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`SERVER ONLINE PORT ${PORT}`); });
