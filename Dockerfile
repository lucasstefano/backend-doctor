# Usa Node.js LTS
FROM node:20

# Cria diretório de trabalho
WORKDIR /usr/src/app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala dependências
RUN npm install --omit=dev

# Copia o código para dentro do container
COPY . .

# Expoe a porta que o Express vai usar
EXPOSE 8080

# Define a variável de ambiente da porta (Cloud Run usa 8080)
ENV PORT=8080

# Inicia o servidor
CMD ["node", "server.js"]
