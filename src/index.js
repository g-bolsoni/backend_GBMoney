// filepath: /home/vane/Documents/contas/contas_api/src/index.js
const fastify = require("fastify")({ logger: true });
const Loaders = require("../database");
const routes = require("./routes");
const { jsonSchemaTransform } = require("fastify-type-provider-zod");

require("dotenv").config();

Loaders.start();

// Configuração do CORS
fastify.register(require("@fastify/cors"), { 
  origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
  credentials: true
});

// Configuração do Multipart para upload de arquivos
fastify.register(require("@fastify/multipart"), {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
});

// Configuração do Swagger
fastify.register(require("@fastify/swagger"), {
  openapi: {
    info: {
      title: "API de Controle Financeiro",
      description: "API para controle financeiro pessoal",
      version: "1.0.0",
    },
    servers: [
      {
        url: "http://localhost:3333",
        description: "Servidor local",
      },
    ],
  },
});

// Configuração do Swagger UI
fastify.register(require("@fastify/swagger-ui"), {
  routePrefix: "/docs", // Define o prefixo da rota para acessar a documentação
  uiConfig: {
    docExpansion: "full", // Expande todas as seções por padrão
    deepLinking: false,
  },
  transform: jsonSchemaTransform,
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

// Registro das rotas
fastify.register(routes);

// Inicialização do servidor
fastify.listen({ port: 3333, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  
  // Inicializar WebSocket para streaming após servidor HTTP estar rodando
  const streamingService = require('./services/streamingService');
  streamingService.initialize(fastify.server);
  
  // Cleanup automático a cada 30 minutos
  setInterval(() => {
    streamingService.cleanup();
  }, 30 * 60 * 1000);
  
  fastify.log.info(`🚀 Servidor rodando em ${address}`);
  fastify.log.info(`📡 WebSocket disponível em ws://localhost:3333/ws/import-progress`);
});
