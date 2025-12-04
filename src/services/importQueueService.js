const Bull = require('bull');
const redis = require('redis');

// Configurar queue para processamento em background
const importQueue = new Bull('import processing', {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379
    }
});

class ImportQueueManager {
    // Adicionar job à queue
    async addImportJob(uploadData, mapping, categoryMapping, userId) {
        const job = await importQueue.add('process-import', {
            tempPath: uploadData.tempPath,
            mapping,
            categoryMapping,
            userId,
            previewType: uploadData.preview.type
        }, {
            attempts: 3,           // Tentar 3 vezes se falhar
            backoff: 'exponential', // Backoff exponencial
            delay: 2000            // Delay de 2 segundos
        });

        return {
            jobId: job.id,
            status: 'queued',
            message: 'Importação adicionada à fila de processamento'
        };
    }

    // Processar job
    async processImportJob(job) {
        const { tempPath, mapping, categoryMapping, userId, previewType } = job.data;
        
        try {
            // Atualizar progresso
            await job.progress(10);
            
            const results = [];
            const errors = [];
            let processed = 0;
            let total = await this.countFileLines(tempPath);
            
            const BATCH_SIZE = 1000; // Lotes ainda maiores em background
            let currentBatch = [];

            return new Promise((resolve, reject) => {
                fs.createReadStream(tempPath)
                    .pipe(csv())
                    .on('data', async (row) => {
                        try {
                            const transaction = this.mapRowToTransaction(row, mapping, categoryMapping, userId);
                            currentBatch.push(transaction);
                            processed++;
                            
                            // Atualizar progresso a cada 100 linhas
                            if (processed % 100 === 0) {
                                const progress = Math.round((processed / total) * 100);
                                await job.progress(progress);
                            }
                            
                            // Processar lote
                            if (currentBatch.length >= BATCH_SIZE) {
                                await this.processBatchOptimized(currentBatch);
                                results.push(...currentBatch);
                                currentBatch = [];
                            }
                            
                        } catch (error) {
                            errors.push(`Linha ${processed}: ${error.message}`);
                        }
                    })
                    .on('end', async () => {
                        // Processar último lote
                        if (currentBatch.length > 0) {
                            await this.processBatchOptimized(currentBatch);
                            results.push(...currentBatch);
                        }
                        
                        // Finalizar job
                        await job.progress(100);
                        
                        resolve({
                            success: true,
                            imported: results.length,
                            errors: errors.length,
                            errorDetails: errors.slice(0, 10) // Só primeiros 10 erros
                        });
                    })
                    .on('error', (error) => {
                        reject(error);
                    });
            });
            
        } catch (error) {
            throw error;
        } finally {
            // Limpar arquivo temporário
            fs.unlink(tempPath, () => {});
        }
    }

    // Contar linhas do arquivo
    async countFileLines(filePath) {
        return new Promise((resolve) => {
            let lineCount = 0;
            fs.createReadStream(filePath)
                .on('data', (buffer) => {
                    let idx = -1;
                    lineCount--; // Porque loop termina com +1
                    do {
                        idx = buffer.indexOf(10, idx + 1);
                        lineCount++;
                    } while (idx !== -1);
                })
                .on('end', () => {
                    resolve(lineCount);
                });
        });
    }

    // Obter status do job
    async getJobStatus(jobId) {
        const job = await importQueue.getJob(jobId);
        
        if (!job) {
            return { status: 'not_found' };
        }
        
        return {
            id: job.id,
            status: await job.getState(),
            progress: job.progress(),
            data: job.returnvalue,
            failedReason: job.failedReason
        };
    }
}

// Configurar processador da queue
importQueue.process('process-import', 5, async (job) => {
    const manager = new ImportQueueManager();
    return await manager.processImportJob(job);
});

// Eventos da queue
importQueue.on('completed', (job, result) => {
    // Job completed successfully
});

importQueue.on('failed', (job, err) => {
    // Job failed
});

module.exports = ImportQueueManager;
