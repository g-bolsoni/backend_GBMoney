const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const billsModel = require('../models/billsModel');
const billsController = require('./billsController');
const streamingService = require('../services/streamingService');

// Armazenamento temporário em memória (em produção, usar Redis ou similar)
const tempStorage = new Map();

class ImportController {
    constructor() {
        // Bind methods to ensure 'this' context
        this.uploadFile = this.uploadFile.bind(this);
        this.getPreview = this.getPreview.bind(this);
        this.confirmImport = this.confirmImport.bind(this);
        this.processImportWithStreaming = this.processImportWithStreaming.bind(this);
        this.processImport = this.processImport.bind(this);
        this.mapRowToTransaction = this.mapRowToTransaction.bind(this);
        this.saveTransaction = this.saveTransaction.bind(this);
        this.validateTransaction = this.validateTransaction.bind(this);
        this.isValidDataRow = this.isValidDataRow.bind(this);
    }

    // Upload de arquivo e gerar preview (otimizado para arquivos grandes)
    async uploadFile(request, reply) {
        try {
            const data = await request.file();

            if (!data) {
                return reply.status(400).send({
                    error: 'Nenhum arquivo enviado'
                });
            }

            // Validar tamanho do arquivo (máx 50MB)
            const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
            if (data.file.bytesRead > MAX_FILE_SIZE) {
                return reply.status(400).send({
                    error: 'Arquivo muito grande. Máximo permitido: 50MB.'
                });
            }

            // Validar tipo de arquivo
            const allowedTypes = ['.csv'];
            const fileExtension = path.extname(data.filename).toLowerCase();

            if (!allowedTypes.includes(fileExtension)) {
                return reply.status(400).send({
                    error: 'Tipo de arquivo não suportado. Use apenas CSV.'
                });
            }

            // Gerar ID único para o upload
            const uploadId = uuidv4();

            // Salvar arquivo temporário no disco em vez de memória
            const tempPath = path.join(process.cwd(), 'temp', `import_${uploadId}.csv`);
            await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });

            const fileBuffer = await data.toBuffer();
            await fs.promises.writeFile(tempPath, fileBuffer);

            let preview;
            if (fileExtension === '.csv') {
                // Preview apenas das primeiras linhas (não carrega arquivo inteiro)
                preview = await this.parseCSVPreviewOptimized(tempPath, data.filename);
            }

            // Armazenar apenas referência ao arquivo, não o conteúdo
            tempStorage.set(uploadId, {
                filename: data.filename,
                tempPath,
                preview,
                fileSize: fileBuffer.length,
                createdAt: new Date(),
                userId: request.user_id
            });

            // Limpar dados antigos (mais de 1 hora)
            this.cleanupOldUploads();

            // Limpar valores null do mapping para evitar problemas de serialização
            const cleanMapping = {};
            if (preview && preview.mapping) {
                Object.keys(preview.mapping).forEach(key => {
                    if (preview.mapping[key] !== null) {
                        cleanMapping[key] = preview.mapping[key];
                    }
                });
            }

            const cleanPreview = preview ? {
                ...preview,
                mapping: cleanMapping
            } : null;

            const responseData = {
                uploadId,
                preview: cleanPreview,
                fileSize: fileBuffer.length,
                message: 'Arquivo processado com sucesso'
            };

            // Serialização manual para evitar problemas do Fastify
            return reply
                .type('application/json')
                .send(JSON.stringify(responseData));

        } catch (error) {
            return reply.status(500).send({
                error: 'Erro interno do servidor'
            });
        }
    }

    // Gerar preview do CSV
    async parseCSVPreview(content, filename) {
        return new Promise((resolve, reject) => {
            const results = [];
            let headers = [];
            let rowCount = 0;

            // Detectar tipo de importação baseado no nome do arquivo
            const importType = this.detectImportType(filename, content);

            // Preprocessar conteúdo para GBMoney CSV
            let processedContent = content;
            if (importType === 'gbmoney_csv') {
                processedContent = this.preprocessGBMoneyCSV(content);
            }

            const stream = require('stream');
            const readable = new stream.Readable();
            readable.push(processedContent);
            readable.push(null);

            readable
                .pipe(csv({
                    separator: this.detectSeparator(processedContent),
                    skipEmptyLines: true
                }))
                .on('headers', (headerList) => {
                    headers = headerList;
                })
                .on('data', (data) => {
                    // Filtrar linhas vazias ou inválidas
                    if (this.isValidDataRow(data, importType)) {
                        rowCount++;
                        // Pegar apenas as primeiras 5 linhas para preview
                        if (results.length < 5) {
                            results.push(data);
                        }
                    }
                })
                .on('end', () => {
                    resolve({
                        type: importType,
                        headers,
                        sample: results,
                        totalRows: rowCount,
                        mapping: this.generateColumnMapping(headers, importType)
                    });
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    // Detectar tipo de importação (CSV genérico, Nubank ou GBMoney)
    detectImportType(filename, content) {
        const lowerFilename = filename.toLowerCase();
        const lowerContent = content.toLowerCase();

        // Verificar se é arquivo GBMoney (baseado na estrutura)
        if (lowerContent.includes('descrição,categoria,data,forma de pagamento') ||
            lowerContent.includes('a receber')) {
            return 'gbmoney_csv';
        }

        // Verificar se é Nubank
        if (lowerFilename.includes('nubank') ||
            lowerContent.includes('nubank') ||
            lowerContent.includes('nu pagamentos')) {
            return 'nubank';
        }

        return 'generic_csv';
    }

    // Detectar separador do CSV
    detectSeparator(content) {
        const firstLine = content.split('\n')[0];

        const separators = [',', ';', '\t'];
        let maxCount = 0;
        let detectedSeparator = ',';

        for (const sep of separators) {
            const count = (firstLine.match(new RegExp(`\\${sep}`, 'g')) || []).length;
            if (count > maxCount) {
                maxCount = count;
                detectedSeparator = sep;
            }
        }

        return detectedSeparator;
    }

    // Preprocessar CSV do GBMoney (remover linhas de cabeçalho e seções)
    preprocessGBMoneyCSV(content) {
        const lines = content.split('\n');
        const processedLines = [];
        let foundDataHeader = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Procurar pela linha de cabeçalho dos dados (apenas a parte esquerda)
            if (line.includes('Descrição,Categoria,Data,Forma de Pagamento')) {
                foundDataHeader = true;
                // Extrair apenas os primeiros 8 campos (seção de despesas)
                const headerParts = line.split(',');
                const cleanHeader = headerParts.slice(0, 8).join(',');
                processedLines.push(cleanHeader);
                continue;
            }

            // Após encontrar o cabeçalho, processar apenas linhas válidas de dados
            if (foundDataHeader) {
                // Parar se encontrar seção de receitas ou totais
                if (line.includes('A receber') || line.includes('Total') || line.includes('Valores base')) {
                    break;
                }

                // Verificar se a linha tem dados válidos na primeira coluna
                if (line && !line.startsWith(',,,')) {
                    const parts = line.split(',');
                    // Pegar apenas os primeiros 8 campos e verificar se há uma descrição
                    if (parts[0] && parts[0].trim() !== '') {
                        const cleanLine = parts.slice(0, 8).join(',');
                        processedLines.push(cleanLine);
                    }
                }
            }
        }

        return processedLines.join('\n');
    }

    // Verificar se é uma linha válida de dados
    isValidDataRow(data, type) {
        if (type === 'gbmoney_csv') {
            // Verificar se tem os campos essenciais preenchidos
            return data['Descrição'] &&
                   data['Categoria'] &&
                   data['Data'] &&
                   data['Valor'] &&
                   data['Valor'] !== '' &&
                   !data['Descrição'].includes('Total') &&
                   !data['Descrição'].includes('Valores base');
        }

        // Para outros tipos, verificar campos genéricos
        const values = Object.values(data);
        return values.some(value => value && value.trim() !== '');
    }

    // Gerar mapeamento de colunas baseado no tipo
    generateColumnMapping(headers, type) {
        const mapping = {
            date: null,
            description: null,
            amount: null,
            category: null,
            payment_type: null,
            installments: null,
            repeat: null,
            fixed: null
        };

        if (type === 'gbmoney_csv') {
            // Mapeamento específico para GBMoney CSV
            mapping.date = 'Data';
            mapping.description = 'Descrição';
            mapping.amount = 'Valor';
            mapping.category = 'Categoria';
            mapping.payment_type = 'Forma de Pagamento';
            mapping.installments = 'Parcelas';
            mapping.repeat = 'Repete';
            mapping.fixed = 'Fixa';
        } else if (type === 'nubank') {
            // Mapeamento específico para Nubank (usa nomes exatos das colunas)
            mapping.date = 'date';
            mapping.description = 'title';
            mapping.amount = 'amount';
            mapping.category = this.findColumn(headers, ['categoria', 'category']) || null;
            // Campos padrão para Nubank (não existem no CSV)
            mapping.payment_type = null;
            mapping.installments = null;
            mapping.repeat = null;
            mapping.fixed = null;
        } else {
            // Mapeamento genérico
            mapping.date = this.findColumn(headers, ['data', 'date', 'dt']);
            mapping.description = this.findColumn(headers, ['descrição', 'description', 'desc', 'historico']);
            mapping.amount = this.findColumn(headers, ['valor', 'amount', 'value', 'vlr']);
            mapping.category = this.findColumn(headers, ['categoria', 'category', 'cat']);
        }

        return mapping;
    }

    // Encontrar coluna por nomes similares
    findColumn(headers, possibleNames) {
        for (const header of headers) {
            for (const name of possibleNames) {
                if (header.toLowerCase().includes(name.toLowerCase())) {
                    return header;
                }
            }
        }
        return null;
    }

    // Obter preview de upload existente
    async getPreview(request, reply) {
        const { uploadId } = request.params;

        const uploadData = tempStorage.get(uploadId);

        if (!uploadData) {
            return reply.status(404).send({
                error: 'Upload não encontrado ou expirado'
            });
        }

        if (uploadData.userId !== request.user_id) {
            return reply.status(403).send({
                error: 'Não autorizado'
            });
        }

        return reply.send({
            uploadId,
            preview: uploadData.preview,
            filename: uploadData.filename
        });
    }

    // Confirmar importação com streaming
    async confirmImport(request, reply) {
        console.log('🔥🔥🔥 CONFIRMIMPORT FOI CHAMADO! 🔥🔥🔥');
        console.log('🔥 Timestamp:', new Date().toISOString());
        console.log('🔥 Request params:', request.params);
        console.log('🔥 Request body:', request.body);

        const { uploadId } = request.params;
        let { mapping, categoryMapping } = request.body;

        const uploadData = tempStorage.get(uploadId);

        if (!uploadData) {
            return reply.status(404).send({
                error: 'Upload não encontrado ou expirado'
            });
        }

        if (uploadData.userId !== request.user_id) {
            return reply.status(403).send({
                error: 'Não autorizado'
            });
        }

        // Garantir que mapping existe com valores padrão
        if (!mapping || typeof mapping !== 'object') {
            mapping = uploadData.preview?.mapping || {
                date: 'Data',
                description: 'Descrição',
                amount: 'Valor',
                category: 'Categoria',
                payment_type: 'Forma de Pagamento',
                installments: 'Parcelas',
                repeat: 'Repete',
                fixed: 'Fixa'
            };
        }

        // Garantir que categoryMapping existe
        if (!categoryMapping || typeof categoryMapping !== 'object') {
            categoryMapping = {};
        }

        console.log('✅ Validações passaram, iniciando processamento...');
        console.log('📊 Mapping final:', mapping);
        console.log('🏷️ Category mapping final:', categoryMapping);

        try {
            // Iniciar sessão de streaming
            console.log('🚀 Iniciando sessão de streaming...');
            const session = streamingService.startImportSession(
                uploadId,
                request.user_id,
                uploadData.preview.totalRows,
                uploadData.filename
            );
            console.log('✅ Sessão criada:', session?.uploadId);

            // Processar importação em background com streaming
            console.log('🚀 CHAMANDO processImportWithStreaming para uploadId:', uploadId);
            console.log('📦 Dados do upload:', {
                filename: uploadData.filename,
                contentLength: uploadData.content?.length,
                previewType: uploadData.preview?.type
            });

            console.log('------------------------------');
            console.log('👤 User ID para importação:', request.user_id);
            console.log('------------------------------');

            this.processImportWithStreaming(uploadData, mapping, categoryMapping, request.user_id, uploadId)
                .then(result => {
                    console.log('✅✅✅ processImportWithStreaming CONCLUÍDO COM SUCESSO! ✅✅✅');
                    console.log('📊 RESULTADO RECEBIDO:', JSON.stringify(result, null, 2));
                    console.log('🔔 AGORA VAMOS CHAMAR completeImportSession...');
                    console.log('🆔 UploadId:', uploadId);
                    console.log('📦 Dados do resultado:', result);

                    try {
                        streamingService.completeImportSession(uploadId, result);
                        console.log('🎉🎉🎉 completeImportSession EXECUTADO COM SUCESSO! 🎉🎉🎉');
                    } catch (completeError) {
                        console.error('❌ ERRO ao chamar completeImportSession:', completeError);
                    }
                })
                .catch(error => {
                    console.error('❌❌❌ ERRO GRAVE na processImportWithStreaming! ❌❌❌');
                    console.error('❌ Erro:', error);
                    console.error('❌ Stack trace completo:', error.stack);
                    console.log('🔔 CHAMANDO completeImportSession com ERRO:', error.message);

                    try {
                        streamingService.completeImportSession(uploadId, {
                            success: false,
                            error: error.message
                        });
                        console.log('📡 completeImportSession para ERRO executado com sucesso');
                    } catch (completeError) {
                        console.error('❌ ERRO ao chamar completeImportSession para erro:', completeError);
                    }
                });

            // Retornar imediatamente com confirmação de início
            return reply.send({
                success: true,
                message: 'Importação iniciada. Acompanhe o progresso em tempo real.',
                uploadId,
                sessionId: session.uploadId
            });

        } catch (error) {
            console.error('Erro na importação:', error);
            return reply.status(500).send({
                error: 'Erro ao processar importação'
            });
        }
    }

    // Processar importação completa
    async processImport(uploadData, mapping, categoryMapping, userId) {
        return new Promise(async (resolve, reject) => {
            const results = [];
            const errors = [];
            let processedCount = 0;

            // Preprocessar conteúdo se for GBMoney CSV
            let processedContent = uploadData.content;
            if (uploadData.preview.type === 'gbmoney_csv') {
                processedContent = this.preprocessGBMoneyCSV(uploadData.content);
            }

            const stream = require('stream');
            const readable = new stream.Readable();
            readable.push(processedContent);
            readable.push(null);

            readable
                .pipe(csv({
                    separator: this.detectSeparator(processedContent),
                    skipEmptyLines: true
                }))
                .on('data', async (row) => {
                    try {
                        // Verificar se é uma linha válida
                        console.log('🔍 Processando linha:', JSON.stringify(row));
                        console.log('🔍 Tipo da importação:', uploadData.preview.type);
                        console.log('🔍 Mapping usado:', JSON.stringify(mapping));

                        if (this.isValidDataRow(row, uploadData.preview.type)) {
                            console.log('✅ Linha válida, criando transação...');
                            const transaction = this.mapRowToTransaction(row, mapping, categoryMapping, userId);
                            console.log('📋 Transação criada:', JSON.stringify(transaction));

                            if (this.validateTransaction(transaction)) {
                                console.log('✅ Transação válida, salvando no banco...');
                                // Salvar no banco de dados
                                const saved = await this.saveTransaction(transaction);
                                results.push(saved);
                                processedCount++;
                                console.log('💾 Transação salva com sucesso:', saved.id);
                            } else {
                                console.log('❌ Transação inválida:', JSON.stringify(transaction));
                                errors.push(`Linha ${processedCount + 1}: Dados inválidos - ${transaction.bill_name}`);
                            }
                        } else {
                            console.log('❌ Linha inválida ou vazia');
                        }

                    } catch (error) {
                        console.error('Erro processando linha:', error);
                        errors.push(`Linha ${processedCount + 1}: ${error.message}`);
                    }
                })
                .on('end', () => {
                    resolve({
                        success: true,
                        imported: results.length,
                        errors: errors.length,
                        errorDetails: errors,
                        message: `${results.length} transações importadas com sucesso`
                    });
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    // Mapear linha do CSV para transação
    mapRowToTransaction(row, mapping, categoryMapping, userId) {
        console.log(userId, '👤 Mapeando transação para o usuário');
        const mongoose = require('mongoose');

        // Converter userId para ObjectId válido se necessário
        let validUserId;
        try {
            // Tentar criar ObjectId se userId é uma string válida de ObjectId
            if (mongoose.Types.ObjectId.isValid(userId)) {
                validUserId = new mongoose.Types.ObjectId(userId);
            } else {
                // Se não for válido, criar um ObjectId de teste baseado na string
                validUserId = new mongoose.Types.ObjectId();
                console.log('⚠️ User ID inválido, criando ObjectId de teste:', validUserId);
            }
        } catch (error) {
            // Fallback: criar um ObjectId novo
            validUserId = new mongoose.Types.ObjectId();
            console.log('⚠️ Erro ao converter userId, criando ObjectId de teste:', validUserId);
        }

        const transaction = {
            user_id: validUserId,
            buy_date: this.parseDate(row[mapping.date]),
            bill_name: row[mapping.description] || '',
            bill_value: this.parseAmount(row[mapping.amount]),
            bill_category: this.mapCategory(row[mapping.category] || '', categoryMapping),
            bill_type: this.determineTypeGBMoney(row, mapping),
            payment_type: mapping.payment_type ? (row[mapping.payment_type] || 'Importado') : 'Nubank',
            repeat: mapping.repeat ? this.parseBoolean(row[mapping.repeat]) : false,
            installments: mapping.installments ? (row[mapping.installments] || '1/1') : '1/1',
            fixed: mapping.fixed ? this.parseBoolean(row[mapping.fixed]) : false
        };

        console.log('🆔 UserID convertido de', userId, 'para', validUserId);
        return transaction;
    }

    // Salvar transação no banco de dados usando billsController
    async saveTransaction(transaction) {
        try {
            const saved = await billsController.createBillData(transaction);
            return saved;
        } catch (error) {
            throw new Error(`Erro ao salvar transação: ${error.message}`);
        }
    }

    // Parse de data (incluindo formatos GBMoney)
    parseDate(dateStr) {
        if (!dateStr) return null;

        const cleanDate = dateStr.trim();

        // Formato GBMoney: D/M/YY ou DD/MM/YY
        if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(cleanDate)) {
            const [day, month, year] = cleanDate.split('/');
            // Assumir que anos de 2 dígitos são 20XX
            const fullYear = parseInt(year) + 2000;
            const parsedDate = new Date(fullYear, parseInt(month) - 1, parseInt(day));
            console.log('📅 ParseDate GBMoney:', dateStr, '->', parsedDate.toISOString());
            return parsedDate;
        }

        // Formato padrão: DD/MM/YYYY
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cleanDate)) {
            const [day, month, year] = cleanDate.split('/');
            const parsedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
            console.log('📅 ParseDate Padrão:', dateStr, '->', parsedDate.toISOString());
            return parsedDate;
        }

        // Formato ISO: YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
            const parsedDate = new Date(cleanDate);
            console.log('📅 ParseDate ISO:', dateStr, '->', parsedDate.toISOString());
            return parsedDate;
        }

        // Formato americano: MM/DD/YYYY
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cleanDate)) {
            const [month, day, year] = cleanDate.split('/');
            return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        }

        throw new Error(`Formato de data inválido: ${dateStr}`);
    }

    // Parse de valor monetário (incluindo formato brasileiro)
    parseAmount(amountStr) {
        if (!amountStr) return 0;

        // Remover aspas se houver (formato CSV)
        let cleaned = amountStr.toString().replace(/"/g, '');

        // Remover R$ e espaços
        cleaned = cleaned.replace(/R\$\s*/g, '');

        // Tratar formato brasileiro: 1.234,56
        // Se há tanto ponto quanto vírgula, ponto é separador de milhares
        if (cleaned.includes('.') && cleaned.includes(',')) {
            cleaned = cleaned.replace(/\./g, ''); // Remove pontos (separador de milhares)
            cleaned = cleaned.replace(',', '.'); // Vírgula vira ponto decimal
        } else if (cleaned.includes(',') && !cleaned.includes('.')) {
            // Apenas vírgula = separador decimal brasileiro
            cleaned = cleaned.replace(',', '.');
        }
        // Se apenas ponto, pode ser decimal ou milhares - assumir decimal se <= 3 dígitos após ponto

        // Remover espaços restantes
        cleaned = cleaned.trim();

        const amount = parseFloat(cleaned);

        if (isNaN(amount)) {
            throw new Error(`Valor inválido: ${amountStr}`);
        }

        return Math.abs(amount); // Sempre positivo, o tipo é determinado pela função de tipo
    }

    // Parse de valores booleanos do GBMoney
    parseBoolean(boolStr) {
        if (!boolStr) return false;
        const lower = boolStr.toLowerCase().trim();
        return lower === 'sim' || lower === 'yes' || lower === 'true' || lower === '1';
    }

    // Determinar tipo específico para GBMoney (todas são despesas por padrão)
    determineTypeGBMoney(row, mapping) {
        // Para Nubank e outros CSVs, verificar se o valor original era negativo
        const originalAmount = row[mapping.amount];
        if (originalAmount && originalAmount.toString().startsWith('-')) {
            return 'expense'; // Valor negativo = despesa
        }

        // Verificar palavras-chave na descrição
        const description = (row[mapping.description] || '').toLowerCase();
        if (description.includes('pagamento recebido') ||
            description.includes('pix recebido') ||
            description.includes('ted recebido') ||
            description.includes('depósito')) {
            return 'income';
        }

        // Padrão para GBMoney é despesa
        return 'expense';
    }

    // Mapear categoria
    mapCategory(categoryStr, categoryMapping) {
        if (!categoryStr) return null;

        const mapped = categoryMapping && categoryMapping[categoryStr];
        return mapped || categoryStr;
    }

    // Determinar tipo (receita ou despesa)
    determineType(row, mapping) {
        // Se há coluna específica para tipo
        if (mapping.type && row[mapping.type]) {
            const typeValue = row[mapping.type].toLowerCase();
            if (typeValue.includes('receita') || typeValue.includes('credit')) {
                return 'income';
            }
            return 'expense';
        }

        // Se não há coluna de tipo, verificar pelo valor (negativo = despesa)
        const amount = row[mapping.amount];
        if (amount && amount.toString().includes('-')) {
            return 'expense';
        }

        // Padrão: despesa
        return 'expense';
    }

    // Validar transação
    validateTransaction(transaction) {
        return transaction.buy_date &&
               transaction.bill_name &&
               transaction.bill_name.trim() !== '' &&
               !isNaN(transaction.bill_value) &&
               transaction.bill_value !== null &&
               ['income', 'expense'].includes(transaction.bill_type);
    }

    // Preview otimizado - lê apenas primeiras linhas
    async parseCSVPreviewOptimized(filePath, filename) {
        return new Promise((resolve, reject) => {
            const results = [];
            let headers = [];
            let rowCount = 0;
            let linesProcessed = 0;
            const MAX_PREVIEW_LINES = 200; // Limitar preview a 200 linhas

            // Detectar tipo lendo apenas início do arquivo
            const sampleContent = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).substring(0, 2000);
            const importType = this.detectImportType(filename, sampleContent);

            let processedContent = null;
            if (importType === 'gbmoney_csv') {
                // Para GBMoney, preprocessar apenas as primeiras linhas
                const firstChunk = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).split('\n').slice(0, 50).join('\n');
                processedContent = this.preprocessGBMoneyCSV(firstChunk);
            }

            const stream = processedContent ?
                require('stream').Readable.from([processedContent]) :
                fs.createReadStream(filePath);

            stream
                .pipe(csv({
                    separator: this.detectSeparator(processedContent || sampleContent),
                    skipEmptyLines: true
                }))
                .on('headers', (headerList) => {
                    headers = headerList;
                })
                .on('data', (data) => {
                    linesProcessed++;

                    // Parar após ler linhas suficientes para preview
                    if (linesProcessed > MAX_PREVIEW_LINES) {
                        this.destroy();
                        return;
                    }

                    if (this.isValidDataRow(data, importType)) {
                        rowCount++;
                        if (results.length < 5) {
                            results.push(data);
                        }
                    }
                })
                .on('end', () => {
                    const previewResult = {
                        type: importType,
                        headers,
                        sample: results,
                        totalRows: rowCount,
                        isLargeFile: linesProcessed >= MAX_PREVIEW_LINES,
                        mapping: this.generateColumnMapping(headers, importType)
                    };
                    console.log('📊 Preview final:', previewResult);
                    resolve(previewResult);
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    // Processar importação com streaming em tempo real
    async processImportWithStreaming(uploadData, mapping, categoryMapping, userId, uploadId) {
        console.log('🚀 Iniciando processImportWithStreaming');
        console.log('📊 UploadData:', JSON.stringify({
            type: uploadData.preview?.type,
            totalRows: uploadData.preview?.totalRows,
            filename: uploadData.filename
        }));
        console.log('🗺️ Mapping:', JSON.stringify(mapping));
        console.log('👤 User ID:', userId);
        console.log('🆔 Upload ID:', uploadId);

        const { Transform } = require('stream');
        const { pipeline } = require('stream/promises');

        try {
            const results = [];
            const errors = [];
            let processedCount = 0;
            let successfulCount = 0;
            let errorCount = 0;
            const BATCH_SIZE = 100; // Lotes menores para updates mais frequentes
            const UPDATE_FREQUENCY = 50; // Enviar update a cada 50 linhas
            let currentBatch = [];

            // Transform stream com streaming de progresso
            const self = this; // Capturar referência para o contexto da classe
            const processTransform = new Transform({
                objectMode: true,
                highWaterMark: 50,

                transform(row, encoding, callback) {
                    try {
                        processedCount++;
                        console.log('🔍 PROCESSANDO LINHA', processedCount, ':', JSON.stringify(row));

                        const isValidRow = self.isValidDataRow(row, uploadData.preview.type);
                        console.log('✅ Linha válida?', isValidRow);

                        if (isValidRow) {
                            const transaction = self.mapRowToTransaction(row, mapping, categoryMapping, userId);
                            console.log('📋 TRANSAÇÃO CRIADA:', JSON.stringify(transaction));

                            const isValidTransaction = self.validateTransaction(transaction);
                            console.log('✅ Transação válida?', isValidTransaction);

                            if (isValidTransaction) {
                                currentBatch.push(transaction);
                                console.log('📦 Adicionada ao lote. Tamanho atual:', currentBatch.length);

                                // Processar lote quando atingir tamanho
                                if (currentBatch.length >= BATCH_SIZE) {
                                    console.log('🚀 PROCESSANDO LOTE de', currentBatch.length, 'transações');
                                    self.processBatchStreamingAsync(currentBatch, results, uploadId)
                                        .then(batchResults => {
                                            console.log('✅ LOTE PROCESSADO:', batchResults);
                                            successfulCount += batchResults.success;
                                            errorCount += batchResults.errors;
                                            currentBatch.length = 0;

                                            // Atualizar progresso
                                            streamingService.updateProgress(uploadId, {
                                                processedRows: processedCount,
                                                successfulRows: successfulCount,
                                                errorRows: errorCount,
                                                currentBatch: Math.floor(processedCount / BATCH_SIZE)
                                            });

                                            callback();
                                        })
                                        .catch(callback);
                                } else {
                                    // Atualizar progresso periodicamente mesmo sem lote completo
                                    if (processedCount % UPDATE_FREQUENCY === 0) {
                                        streamingService.updateProgress(uploadId, {
                                            processedRows: processedCount,
                                            successfulRows: successfulCount,
                                            errorRows: errorCount
                                        });
                                    }
                                    callback();
                                }
                            } else {
                                console.log('❌ TRANSAÇÃO INVÁLIDA - incrementando errorCount');
                                errorCount++;
                                streamingService.addError(uploadId, 'Dados da transação inválidos', processedCount);
                                callback();
                            }
                        } else {
                            console.log('❌ LINHA INVÁLIDA - pulando');
                            // Linha inválida, mas não é erro crítico (cabeçalho)
                            callback();
                        }
                    } catch (error) {
                        console.log('💥 ERRO no processamento da linha:', error.message);
                        errorCount++;
                        streamingService.addError(uploadId, error.message, processedCount);
                        callback(); // Continuar processamento
                    }
                }
            });

            // Criar stream de entrada
            let inputStream = fs.createReadStream(uploadData.tempPath, {
                highWaterMark: 32 * 1024 // 32KB chunks para responsividade
            });

            // Preprocessar se necessário
            if (uploadData.preview.type === 'gbmoney_csv') {
                const self = this; // Capturar referência para o contexto da classe
                const preprocessTransform = new Transform({
                    transform(chunk, encoding, callback) {
                        try {
                            const processed = self.preprocessGBMoneyCSV(chunk.toString());
                            callback(null, processed);
                        } catch (error) {
                            callback(error);
                        }
                    }
                });

                inputStream = inputStream.pipe(preprocessTransform);
            }

            // Pipeline com streaming
            await pipeline(
                inputStream,
                csv({
                    separator: this.detectSeparator(uploadData.preview.type === 'gbmoney_csv' ? ',' : ','),
                    skipEmptyLines: true
                }),
                processTransform
            );

            // Processar último lote
            if (currentBatch.length > 0) {
                console.log('🔚 PROCESSANDO ÚLTIMO LOTE de', currentBatch.length, 'transações');
                const batchResults = await this.processBatchStreamingAsync(currentBatch, results, uploadId);
                console.log('✅ ÚLTIMO LOTE PROCESSADO:', batchResults);
                successfulCount += batchResults.success;
                errorCount += batchResults.errors;
            } else {
                console.log('⚠️ NENHUM LOTE FINAL PARA PROCESSAR - currentBatch vazio');
            }

            // Update final
            streamingService.updateProgress(uploadId, {
                processedRows: processedCount,
                successfulRows: successfulCount,
                errorRows: errorCount,
                status: 'finalizing'
            });

            console.log('🎉 IMPORTAÇÃO CONCLUÍDA! Retornando resultado final...');
            console.log('📊 ESTATÍSTICAS FINAIS:', {
                successfulCount,
                errorCount,
                processedCount
            });

            const finalResult = {
                success: true,
                imported: successfulCount,
                errors: errorCount,
                total: processedCount,
                message: `${successfulCount} transações importadas com sucesso de ${processedCount} processadas`
            };

            console.log('📦 RESULTADO FINAL A SER RETORNADO:', finalResult);

            // Limpar arquivo temporário
            fs.unlink(uploadData.tempPath, () => {});

            // Limpar dados temporários
            tempStorage.delete(uploadId);

            console.log('🚀 RETORNANDO RESULTADO FINAL DA processImportWithStreaming');
            return finalResult;

        } catch (error) {
            // Limpar arquivos em caso de erro
            fs.unlink(uploadData.tempPath, () => {});
            tempStorage.delete(uploadId);
            throw error;
        }
    }

    // Processar lote com feedback de streaming
    async processBatchStreamingAsync(batch, results, uploadId) {
        console.log('💾 INICIANDO PROCESSAMENTO DO LOTE de', batch.length, 'transações');
        console.log('💾 Primeira transação do lote:', JSON.stringify(batch[0]));

        // Testar conexão do banco
        const mongoose = require('mongoose');
        console.log('🔌 Estado da conexão MongoDB:', mongoose.connection.readyState);
        console.log('🔌 Nome do banco:', mongoose.connection.name);
        console.log('🔌 Host:', mongoose.connection.host);

        // FUNÇÃO TEMPORÁRIA: Limpar todos os registros (descomente se quiser usar)
        // console.log('🗑️ Limpando collection bills...');
        // await billsModel.deleteMany({});
        // console.log('✅ Collection bills limpa!');

        let successCount = 0;
        let errorCount = 0;        try {
            // Tentar inserção em massa primeiro (mais eficiente)
            try {
                console.log('💾 Tentando inserção em massa...');
                console.log('💾 Conectado ao MongoDB?', billsModel.db.readyState === 1 ? 'SIM' : 'NÃO');
                console.log('💾 Nome da collection:', billsModel.collection.name);

                const saved = await billsModel.insertMany(batch, { ordered: false });
                console.log('✅ INSERÇÃO EM MASSA SUCESSO! Salvou', saved.length, 'transações');
                console.log('✅ IDs das transações salvas:', saved.map(doc => doc._id));

                // Verificar se foram realmente salvas
                const count = await billsModel.countDocuments({});
                console.log('📊 Total de documentos na collection bills:', count);

                results.push(...saved);
                successCount = saved.length;

                // Se houve menos sucessos que o esperado, algumas falharam
                if (successCount < batch.length) {
                    console.log('⚠️ Algumas transações falharam na inserção em massa');
                    errorCount = batch.length - successCount;
                }

            } catch (bulkError) {
                console.log('❌ INSERÇÃO EM MASSA FALHOU:', bulkError.message);
                console.log('❌ Detalhes do erro:', bulkError);
                console.log('🔄 Tentando inserção individual usando billsController...');

                // Fallback: inserir individualmente usando billsController
                const promises = batch.map(async (transaction, index) => {
                    try {
                        console.log(`💾 Salvando transação individual ${index + 1}:`, JSON.stringify(transaction));
                        const saved = await billsController.createBillData(transaction);
                        console.log(`✅ Transação ${index + 1} salva com sucesso:`, saved._id);
                        return { success: true, data: saved };
                    } catch (error) {
                        console.log(`❌ ERRO ao salvar transação ${index + 1}:`, error.message);
                        console.log(`❌ Detalhes do erro da transação ${index + 1}:`, error);
                        streamingService.addError(uploadId, `Erro ao salvar transação ${index + 1}: ${error.message}`);
                        return { success: false, error };
                    }
                });

                const settled = await Promise.allSettled(promises);
                console.log('🔍 Resultados das inserções individuais:', settled.length, 'processadas');

                settled.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        if (result.value.success) {
                            results.push(result.value.data);
                            successCount++;
                            console.log(`✅ Transação ${index + 1} foi salva com sucesso`);
                        } else {
                            errorCount++;
                            console.log(`❌ Transação ${index + 1} falhou:`, result.value.error?.message);
                        }
                    } else {
                        errorCount++;
                        console.log(`❌ Transação ${index + 1} rejeitada:`, result.reason?.message);
                        streamingService.addError(uploadId, `Erro não tratado na transação ${index + 1}: ${result.reason?.message || 'Erro desconhecido'}`);
                    }
                });
            }

        } catch (error) {
            console.error('💥 ERRO CRÍTICO no processamento de lote:', error);
            console.error('💥 Stack trace:', error.stack);
            errorCount = batch.length;
            streamingService.addError(uploadId, `Erro crítico no lote: ${error.message}`);
        }

        console.log('📊 RESULTADO DO LOTE: sucesso =', successCount, ', erros =', errorCount);
        return { success: successCount, errors: errorCount };
    }

    // Processar lote de forma assíncrona (não bloquear) - método legado
    async processBatchAsync(batch, results) {
        try {
            // Usar Promise.allSettled para não falhar se uma transação der erro
            const promises = batch.map(transaction =>
                billsModel.create(transaction).catch(error => ({ error }))
            );

            const settled = await Promise.allSettled(promises);

            settled.forEach(result => {
                if (result.status === 'fulfilled' && !result.value.error) {
                    results.push(result.value);
                }
            });

        } catch (error) {
            console.error('Erro no lote assíncrono:', error);
            // Tentar inserção em massa como fallback
            try {
                const saved = await billsModel.insertMany(batch, { ordered: false });
                results.push(...saved);
            } catch (insertError) {
                console.error('Erro na inserção em massa:', insertError);
            }
        }
    }

    // Processar lote de transações
    async processBatch(batch, results) {
        try {
            const saved = await billsModel.insertMany(batch, { ordered: false });
            results.push(...saved);
        } catch (error) {
            console.error('Erro ao salvar lote:', error);
            // Tentar salvar individualmente em caso de erro
            for (const transaction of batch) {
                try {
                    const saved = await billsModel.create(transaction);
                    results.push(saved);
                } catch (individualError) {
                    console.error('Erro individual:', individualError);
                }
            }
        }
    }

    // Limpar uploads antigos (agora remove arquivos do disco também)
    cleanupOldUploads() {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        for (const [key, value] of tempStorage.entries()) {
            if (value.createdAt < oneHourAgo) {
                // Remover arquivo temporário do disco
                if (value.tempPath && fs.existsSync(value.tempPath)) {
                    fs.unlink(value.tempPath, (err) => {
                        if (err) console.error('Erro ao remover arquivo temporário:', err);
                    });
                }
                tempStorage.delete(key);
            }
        }
    }
}

module.exports = new ImportController();
