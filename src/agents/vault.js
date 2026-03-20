import { supabase } from '../config/supabase.js';
import { aiService } from '../services/ai.js';
import { gmailService } from '../services/gmail.js';
import { notificationAgent } from './notification.js';
import { logger } from '../utils/logger.js';
import { helpers } from '../utils/helpers.js';
import crypto from 'crypto';
import sharp from 'sharp';

/**
 * Agent 6 — Document Vault Agent
 * Ingests, analyzes, compresses, and stores documents.
 * Handles metadata extraction and natural language retrieval.
 */
export const vaultAgent = {

    /**
     * Agent 6: Vault — Full Pipeline
     * analyze → dedup → compress → store → index
     */
    async processDocument(file, source, emailContext, userId) {
        try {
            // 1. Analyze
            const analysis = await this.analyzeDocument(file, userId);
            if (!analysis || !analysis.worth_storing) {
                logger.info('Vault', 'Skip', `Not worth storing: ${file.name}`);
                return null;
            }

            // 2. Dedup (isDuplicate)
            const duplicate = await this.isDuplicate(userId, file.buffer);
            if (duplicate) {
                logger.info('Vault', 'Duplicate', `File exists: ${file.name}`);
                return duplicate;
            }

            // 3. Compress
            const processedFile = await this.compressFile(file);

            // 4. Store
            const storagePath = await this.storeFile(userId, processedFile);

            // 5. Index
            const metadata = {
                ...analysis,
                userId,
                file_path: storagePath,
                file_hash: crypto.createHash('md5').update(file.buffer).digest('hex'),
                original_filename: file.name,
                file_type: file.mimeType,
                size_kb: Math.round(processedFile.buffer.length / 1024),
                source,
                email_sender: emailContext?.from || null,
                expires_at: this.calculateExpiry(analysis.importance)
            };

            const storedDoc = await this.indexDocument(userId, metadata);

            // Notify via Level 1 if important
            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                await this.notifyStored(user.telegram_chat_id, analysis, storedDoc);
            }

            return storedDoc;
        } catch (err) {
            logger.error('Vault', 'ProcessError', `Failed ${file.name}`, err);
            return null;
        }
    },

    /**
     * Gemini Vision API call → metadata extraction
     */
    async analyzeDocument(file, userId) {
        const prompt = `
Analyze this document and extract metadata.
Return ONLY valid JSON.
{
    "worth_storing": true/false (receipts, bills, IDs, tickets, official docs),
    "doc_type": "receipt | ticket | invoice | contract | id | passport | certificate | other",
    "vendor": "entity name",
    "amount": "total with currency (or null)",
    "date": "YYYY-MM-DD",
    "expiry_date": "YYYY-MM-DD (or null)",
    "importance": "permanent | 90days | 30days | skip",
    "summary": "1-line summary",
    "search_tags": ["key1", "key2"],
    "extracted_text": "2-3 sentence core text"
}
`;
        const systemInstruction = 'You are a document analysis assistant. Extract metadata from the provided document.';
        const response = await aiService.callAI(prompt, systemInstruction, userId, file);
        return helpers.parseJSON(response, {});
    },

    /**
     * MD5 hash check against vault_metadata.file_hash
     */
    async isDuplicate(userId, fileBuffer) {
        const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
        const { data } = await supabase
            .from('vault_metadata')
            .select('*')
            .eq('user_id', userId)
            .eq('file_hash', hash)
            .maybeSingle();
        return data || null;
    },

    /**
     * sharp for images (max 100KB), text extraction for docs
     */
    async compressFile(file) {
        if (file.mimeType.startsWith('image/')) {
            const compressed = await sharp(file.buffer)
                .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
            return { ...file, buffer: compressed, mimeType: 'image/jpeg' };
        }
        return file;
    },

    /**
     * Upload to Supabase Storage bucket 'vault'
     */
    async storeFile(userId, file) {
        const path = `${userId}/${crypto.randomUUID()}_${file.name}`;
        const { error } = await supabase.storage
            .from('vault')
            .upload(path, file.buffer, { contentType: file.mimeType });
        if (error) throw error;
        return path;
    },

    /**
     * INSERT into vault_metadata
     */
    async indexDocument(userId, metadata) {
        const { data, error } = await supabase
            .from('vault_metadata')
            .insert({
                user_id: userId,
                file_path: metadata.file_path,
                file_hash: metadata.file_hash,
                original_filename: metadata.original_filename,
                file_type: metadata.file_type,
                size_kb: metadata.size_kb,
                doc_type: metadata.doc_type,
                vendor: metadata.vendor,
                amount: metadata.amount,
                doc_date: metadata.date,
                expiry_date: metadata.expiry_date,
                importance: metadata.importance,
                summary: metadata.summary,
                search_tags: metadata.search_tags,
                extracted_text: metadata.extracted_text,
                source: metadata.source,
                email_sender: metadata.email_sender,
                expires_at: metadata.expires_at ? metadata.expires_at.toISOString() : null
            })
            .select()
            .single();
        if (error) throw error;
        return data;
    },

    async findDocument(userId, naturalQuery) {
        const intentPrompt = `Extract search intent from: "${naturalQuery}". Return JSON {doc_type, vendor, date_hint, keywords[]}`;
        const intentRes = await aiService.callAI(intentPrompt, 'You extract search intents.', userId);
        const intent = helpers.parseJSON(intentRes, {});

        let query = supabase.from('vault_metadata').select('*').eq('user_id', userId);
        if (intent.doc_type) query = query.eq('doc_type', intent.doc_type);
        if (intent.vendor) query = query.ilike('vendor', `%${intent.vendor}%`);
        if (intent.keywords?.length) query = query.ilike('summary', `%${intent.keywords[0]}%`);

        const { data, error } = await query.order('doc_date', { ascending: false }).limit(5);
        if (error) {
            logger.error('Vault', 'SearchError', `Failed for query: ${naturalQuery}`, error);
            return { found: false, docs: [], message: 'Search failed. Please try again.' };
        }

        if (!data || data.length === 0) {
            return { found: false, docs: [], message: `No documents found matching _"${naturalQuery}"_.` };
        }

        return { found: true, docs: data, message: 'Found results' };
    },

    /**
     * Fetch file from Supabase Storage
     */
    async getDocument(userId, docId) {
        const { data: meta } = await supabase.from('vault_metadata').select('file_path').eq('id', docId).single();
        if (!meta) return null;

        const { data, error } = await supabase.storage.from('vault').download(meta.file_path);
        if (error) throw error;
        return data;
    },

    /**
     * Share document as email attachment
     */
    async shareDocument(userId, docId, recipientEmail, userEmail) {
        const doc = await this.getDocument(userId, docId);
        const { data: meta } = await supabase.from('vault_metadata').select('*').eq('id', docId).single();

        await gmailService.sendEmail(userId, {
            to: recipientEmail,
            subject: `Shared Document: ${meta.original_filename}`,
            body: `<p>Please find the requested document attached: <b>${meta.summary}</b></p>`,
            attachments: [{
                filename: meta.original_filename,
                content: Buffer.from(await doc.arrayBuffer()),
                contentType: meta.file_type
            }]
        }, userEmail);
        return true;
    },

    calculateExpiry(importance) {
        if (!importance || importance === 'permanent' || importance === 'skip') return null;
        const days = importance === '90days' ? 90 : 30;
        const d = new Date();
        d.setDate(d.getDate() + days);
        return d;
    },

    /**
     * Daily 8am check for expiring docs
     */
    async checkExpiries(userId) {
        const target = new Date();
        target.setDate(target.getDate() + 3);
        const { data } = await supabase
            .from('vault_metadata')
            .select('*')
            .eq('user_id', userId)
            .lte('expires_at', target.toISOString());

        if (data?.length) {
            const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
            if (user?.telegram_chat_id) {
                const list = data.map(d => `- ${d.original_filename} (${d.doc_type})`).join('\n');
                await notificationAgent.notifyBucketA(user.telegram_chat_id, {
                    subject: '⚠️ Document Expiry Warning',
                    snippet: `The following documents expire in 3 days:\n${list}`
                }, ['Vault']);
            }
        }
    },

    async notifyStored(chatId, analysis, _storedDoc) {
        const text = `📎 *Stored — ${analysis.vendor || 'Document'}*\n${analysis.doc_type} · ${analysis.summary}`;
        await notificationAgent.notifyBucketA(chatId, {
            subject: 'New Document Stored',
            snippet: text
        }, ['Vault']);
    }
};
