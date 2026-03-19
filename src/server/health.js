import express from 'express';
import { VELOX } from '../config/constants.js';

const router = express.Router();
const startedAt = Date.now();

router.get('/', (req, res) => {
    const uptimeMs = Date.now() - startedAt;
    const uptimeMins = Math.floor(uptimeMs / 60000);
    const uptimeHrs = Math.floor(uptimeMins / 60);

    res.status(200).json({
        status: 'up',
        service: 'Velox — AI Email Agent',
        version: VELOX.VERSION,
        timestamp: new Date().toISOString(),
        uptime: uptimeHrs > 0 ? `${uptimeHrs}h ${uptimeMins % 60}m` : `${uptimeMins}m`,
    });
});

router.get('/db', async (req, res) => {
    try {
        const { supabase } = await import('../config/supabase.js');
        const { data, error } = await supabase
            .from('health_check')
            .select('timestamp')
            .limit(1)
            .single();

        if (error) throw error;

        res.status(200).json({
            status: 'db_up',
            timestamp: new Date().toISOString(),
            last_check: data.timestamp
        });
    } catch (err) {
        res.status(500).json({
            status: 'db_error',
            error: err.message
        });
    }
});

export default router;
