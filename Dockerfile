# 1. IMAGEM BASE: Usa uma imagem Node.js leve e segura.
FROM node:20-slim

# 2. VARIÁVEL DE AMBIENTE: Garante que o NPM não peça confirmação interativa.
ENV NPM_CONFIG_LOGLEVEL=warn

# 3. INSTALAÇÃO DE DEPENDÊNCIAS DO SISTEMA:
# Instala o cliente Git, necessário para a funcionalidade de Deploy por GIT.
RUN apt-get update && \
    apt-get install -y git && \
    rm -rf /var/lib/apt/lists/*

# 4. DIRETÓRIO DE TRABALHO: Define o diretório de trabalho dentro do contêiner.
WORKDIR /app

# 5. INSTALAÇÃO DE DEPENDÊNCIAS DO NODE.JS:
# Copia e instala as dependências para aproveitar o cache do Docker.
COPY package.json package-lock.json ./
RUN npm install

# 6. COPIA O CÓDIGO DO PROJETO: Copia todo o restante do código (server.js, index.html, public/, etc.)
# para o diretório de trabalho /app.
COPY . .

# 7. PORTA: Informa ao Docker que a aplicação escuta na porta 8080 (que é usada no seu server.js para o Koyeb).
EXPOSE 8080

# 8. COMANDO DE INICIALIZAÇÃO: Inicia o servidor Node.js.
CMD ["npm", "start"]
