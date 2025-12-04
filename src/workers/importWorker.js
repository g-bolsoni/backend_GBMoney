const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const csv = require('csv-parser');
const fs = require('fs');

class ImportWorker {
    // Processar importação em worker thread separada
    async processImportInWorker(uploadData, mapping, categoryMapping, userId) {
        return new Promise((resolve, reject) => {
            // Criar worker thread para não bloquear thread principal
            const worker = new Worker(__filename, {
                workerData: {
                    tempPath: uploadData.tempPath,
                    mapping,
                    categoryMapping,
                    userId,
                    previewType: uploadData.preview.type
                }
            });

            worker.on('message', (result) => {
                resolve(result);
            });

            worker.on('error', (error) => {
                reject(error);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker parou com código ${code}`));
                }
            });
        });
    }
}

// Código que roda no worker thread
if (!isMainThread) {
    const { tempPath, mapping, categoryMapping, userId, previewType } = workerData;
    
    async function processFile() {
        const results = [];
        const errors = [];
        const BATCH_SIZE = 500; // Lotes maiores no worker
        let currentBatch = [];
        
        fs.createReadStream(tempPath)
            .pipe(csv())
            .on('data', (row) => {
                try {
                    // Processar linha (sem acessar banco ainda)
                    const transaction = mapRowToTransaction(row, mapping, categoryMapping, userId);
                    currentBatch.push(transaction);
                    
                    if (currentBatch.length >= BATCH_SIZE) {
                        // Enviar lote para thread principal processar
                        parentPort.postMessage({
                            type: 'batch',
                            data: currentBatch
                        });
                        currentBatch = [];
                    }
                } catch (error) {
                    errors.push(error.message);
                }
            })
            .on('end', () => {
                // Enviar último lote
                if (currentBatch.length > 0) {
                    parentPort.postMessage({
                        type: 'batch',
                        data: currentBatch
                    });
                }
                
                parentPort.postMessage({
                    type: 'complete',
                    errors
                });
            });
    }
    
    processFile();
}

module.exports = ImportWorker;
