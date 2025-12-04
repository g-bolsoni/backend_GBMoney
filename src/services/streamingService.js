const WebSocket = require('ws');
const { EventEmitter } = require('events');

class StreamingService extends EventEmitter {
    constructor() {
        super();
        this.wss = null;
        this.clients = new Map(); // Map<userId, Set<WebSocket>>
        this.importSessions = new Map(); // Map<uploadId, importData>
    }

    // Inicializar WebSocket Server
    initialize(server) {
        this.wss = new WebSocket.Server({
            server,
            path: '/ws/import-progress'
        });

        this.wss.on('connection', (ws, request) => {
            console.log('Nova conexão WebSocket para import progress');

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleClientMessage(ws, data);
                } catch (error) {
                    console.error('Erro ao processar mensagem WebSocket:', error);
                }
            });

            ws.on('close', () => {
                this.removeClient(ws);
            });

            ws.on('error', (error) => {
                console.error('Erro WebSocket:', error);
                this.removeClient(ws);
            });
        });

        console.log('WebSocket Server inicializado para streaming de importação');
    }

    // Processar mensagens do cliente
    handleClientMessage(ws, data) {
        switch (data.type) {
            case 'subscribe':
                this.subscribeClient(ws, data.userId, data.uploadId);
                break;
            case 'unsubscribe':
                this.unsubscribeClient(ws, data.userId);
                break;
            default:
                console.log('Tipo de mensagem não reconhecido:', data.type);
        }
    }

    // Inscrever cliente para receber updates
    subscribeClient(ws, userId, uploadId) {
        if (!this.clients.has(userId)) {
            this.clients.set(userId, new Set());
        }

        ws.userId = userId;
        ws.uploadId = uploadId;
        this.clients.get(userId).add(ws);

        // Enviar status atual se existe sessão ativa
        if (this.importSessions.has(uploadId)) {
            const session = this.importSessions.get(uploadId);
            ws.send(JSON.stringify({
                type: 'progress',
                uploadId,
                ...session
            }));
        }

        console.log(`Cliente inscrito para user ${userId}, upload ${uploadId}`);
    }

    // Remover cliente
    removeClient(ws) {
        if (ws.userId && this.clients.has(ws.userId)) {
            this.clients.get(ws.userId).delete(ws);

            if (this.clients.get(ws.userId).size === 0) {
                this.clients.delete(ws.userId);
            }
        }
    }

    // Desinscrever cliente
    unsubscribeClient(ws, userId) {
        if (this.clients.has(userId)) {
            this.clients.get(userId).delete(ws);
        }
    }

    // Iniciar sessão de importação
    startImportSession(uploadId, userId, totalRows, filename) {
        const session = {
            uploadId,
            userId,
            filename,
            totalRows,
            processedRows: 0,
            successfulRows: 0,
            errorRows: 0,
            errors: [],
            startTime: new Date(),
            status: 'processing',
            currentBatch: 0,
            progress: 0,
            estimatedTimeRemaining: null,
            processingSpeed: 0
        };

        this.importSessions.set(uploadId, session);

        this.broadcastToUser(userId, {
            type: 'import_started',
            uploadId,
            ...session
        });

        return session;
    }

    // Atualizar progresso da importação
    updateProgress(uploadId, update) {
        const session = this.importSessions.get(uploadId);
        if (!session) return;

        // Atualizar dados da sessão
        Object.assign(session, update);

        // Calcular métricas
        session.progress = Math.round((session.processedRows / session.totalRows) * 100);

        // Calcular velocidade de processamento
        const elapsedTime = (new Date() - session.startTime) / 1000; // segundos
        session.processingSpeed = Math.round(session.processedRows / elapsedTime);

        // Estimar tempo restante
        if (session.processingSpeed > 0) {
            const remainingRows = session.totalRows - session.processedRows;
            session.estimatedTimeRemaining = Math.round(remainingRows / session.processingSpeed);
        }

        // Enviar update para clientes
        this.broadcastToUser(session.userId, {
            type: 'progress',
            uploadId,
            ...session
        });
    }

    // Adicionar erro à sessão
    addError(uploadId, error, rowNumber = null) {
        const session = this.importSessions.get(uploadId);
        if (!session) return;

        session.errorRows++;
        session.errors.push({
            message: error,
            row: rowNumber,
            timestamp: new Date()
        });

        // Limitar número de erros armazenados
        if (session.errors.length > 100) {
            session.errors = session.errors.slice(-100);
        }

        this.updateProgress(uploadId, {});
    }

    // Finalizar sessão de importação
    completeImportSession(uploadId, result) {
        console.log('🏁🏁🏁 completeImportSession INICIADO! 🏁🏁🏁');
        console.log('🆔 UploadId recebido:', uploadId);
        console.log('📊 Resultado recebido:', JSON.stringify(result, null, 2));

        const session = this.importSessions.get(uploadId);
        console.log('📋 Sessão encontrada:', session ? 'SIM' : 'NÃO');

        if (!session) {
            console.log('❌ SESSÃO NÃO ENCONTRADA! Não enviando sinal de conclusão');
            console.log('🔍 Sessões ativas:', Array.from(this.importSessions.keys()));
            return;
        }

        console.log('👤 UserId da sessão:', session.userId);
        console.log('📁 Clientes conectados:', this.clients.has(session.userId) ? 'SIM' : 'NÃO');

        session.status = result.success ? 'completed' : 'failed';
        session.endTime = new Date();
        session.duration = Math.round((session.endTime - session.startTime) / 1000);
        session.result = result;

        const messageToSend = {
            type: 'import_completed',
            uploadId,
            ...session
        };

        console.log('📡 MENSAGEM A SER ENVIADA:', JSON.stringify(messageToSend, null, 2));

        this.broadcastToUser(session.userId, messageToSend);

        console.log('✅ broadcastToUser EXECUTADO - Sinal de conclusão enviado!');

        // Manter sessão por alguns minutos para consulta
        setTimeout(() => {
            this.importSessions.delete(uploadId);
        }, 5 * 60 * 1000); // 5 minutos
    }

    // Enviar mensagem para todos os clientes de um usuário
    broadcastToUser(userId, message) {
        console.log('📡📡📡 broadcastToUser INICIADO! 📡📡📡');
        console.log('👤 UserId:', userId);
        console.log('📧 Mensagem:', JSON.stringify(message, null, 2));

        const userClients = this.clients.get(userId);
        console.log('🔍 Clientes encontrados para o usuário:', userClients ? userClients.size : 0);

        if (!userClients) {
            console.log('❌ NENHUM CLIENTE CONECTADO para o userId:', userId);
            console.log('🔍 Clientes ativos:', Array.from(this.clients.keys()));
            return;
        }

        const messageStr = JSON.stringify(message);
        console.log('📦 Mensagem serializada (tamanho:', messageStr.length, '):', messageStr.substring(0, 200), '...');

        let sentCount = 0;
        userClients.forEach((ws, index) => {
            console.log(`🔌 Cliente ${index}: readyState =`, ws.readyState, '(OPEN =', WebSocket.OPEN, ')');

            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(messageStr);
                    sentCount++;
                    console.log(`✅ Mensagem enviada para cliente ${index} com sucesso!`);
                } catch (error) {
                    console.error(`❌ Erro ao enviar mensagem para cliente ${index}:`, error);
                    this.removeClient(ws);
                }
            } else {
                console.log(`⚠️ Cliente ${index} não está conectado (readyState: ${ws.readyState})`);
            }
        });

        console.log(`📊 RESUMO: ${sentCount} mensagens enviadas de ${userClients.size} clientes`);
    }

    // Enviar mensagem para um upload específico
    broadcastToUpload(uploadId, message) {
        const session = this.importSessions.get(uploadId);
        if (!session) return;

        this.broadcastToUser(session.userId, {
            ...message,
            uploadId
        });
    }

    // Obter status de uma sessão
    getSessionStatus(uploadId) {
        return this.importSessions.get(uploadId);
    }

    // Obter todas as sessões de um usuário
    getUserSessions(userId) {
        const sessions = [];
        for (const [uploadId, session] of this.importSessions) {
            if (session.userId === userId) {
                sessions.push({ uploadId, ...session });
            }
        }
        return sessions;
    }

    // Cleanup de sessões expiradas
    cleanup() {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        for (const [uploadId, session] of this.importSessions) {
            if (session.startTime < oneHourAgo) {
                this.importSessions.delete(uploadId);
            }
        }
    }

    // Server-Sent Events como alternativa ao WebSocket
    createSSEEndpoint(request, reply) {
        const { uploadId } = request.params;
        const userId = request.user_id;

        // Configurar headers para SSE
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        // Função para enviar dados SSE
        const sendSSE = (data) => {
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Enviar status inicial
        const session = this.importSessions.get(uploadId);
        if (session) {
            sendSSE({
                type: 'progress',
                uploadId,
                ...session
            });
        }

        // Listener para updates da sessão
        const updateListener = (message) => {
            if (message.uploadId === uploadId) {
                sendSSE(message);
            }
        };

        // Simular conexão WebSocket usando EventEmitter
        this.on(`user_${userId}`, updateListener);

        // Cleanup quando conexão fechar
        request.raw.on('close', () => {
            this.removeListener(`user_${userId}`, updateListener);
        });

        return reply;
    }
}

module.exports = new StreamingService();
