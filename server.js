const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DO BANCO
// ==========================================
let pool = null;
let dbConnected = false;

try {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    console.log('📊 PostgreSQL configurado');
  }
} catch (err) {
  console.error('❌ Erro ao criar pool:', err.message);
}

// ==========================================
// FUNÇÕES DE MEMÓRIA PERSISTENTE
// ==========================================

// 1. MEMÓRIA DE SESSÃO (OpenClaw lembra conversas)
async function saveSession(sessionKey, userId, context, lastMessage) {
  if (!pool) return null;
  try {
    await pool.query(`
      INSERT INTO sessions (session_key, user_id, context, last_message)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_key) 
      DO UPDATE SET 
        context = $3, 
        last_message = $4, 
        updated_at = CURRENT_TIMESTAMP
    `, [sessionKey, userId, JSON.stringify(context), lastMessage]);
    return true;
  } catch (err) {
    console.error('Erro ao salvar sessão:', err.message);
    return null;
  }
}

async function getSession(sessionKey) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE session_key = $1',
      [sessionKey]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Erro ao buscar sessão:', err.message);
    return null;
  }
}

// 2. PREFERÊNCIAS DO USUÁRIO
async function savePreference(userKey, name, value) {
  if (!pool) return null;
  try {
    await pool.query(`
      INSERT INTO user_preferences (user_key, preference_name, preference_value)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_key, preference_name) 
      DO UPDATE SET preference_value = $3, updated_at = CURRENT_TIMESTAMP
    `, [userKey, name, JSON.stringify(value)]);
    return true;
  } catch (err) {
    console.error('Erro ao salvar preferência:', err.message);
    return null;
  }
}

async function getPreference(userKey, name) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT preference_value FROM user_preferences WHERE user_key = $1 AND preference_name = $2',
      [userKey, name]
    );
    return result.rows[0]?.preference_value || null;
  } catch (err) {
    console.error('Erro ao buscar preferência:', err.message);
    return null;
  }
}

// 3. AUDITORIA
async function logAction(action, entityType, entityId, userKey, details) {
  if (!pool) return null;
  try {
    await pool.query(`
      INSERT INTO audit_logs (action, entity_type, entity_id, user_key, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [action, entityType, entityId, userKey, JSON.stringify(details)]);
    return true;
  } catch (err) {
    console.error('Erro ao logar:', err.message);
    return null;
  }
}

// 4. DOWNLOADS COM CACHE
async function checkExistingDownload(url) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT * FROM downloads WHERE url = $1 AND status = $2',
      [url, 'success']
    );
    if (result.rows.length > 0) {
      await pool.query(
        'UPDATE downloads SET last_accessed = CURRENT_TIMESTAMP WHERE id = $1',
        [result.rows[0].id]
      );
      await logAction('cache_hit', 'download', result.rows[0].id, 'system', { url });
      return result.rows[0];
    }
  } catch (err) {
    console.error('Erro cache:', err.message);
  }
  return null;
}

async function saveDownload(url, data, metadata = {}) {
  if (!pool) return null;
  try {
    await pool.query(`
      INSERT INTO downloads (url, download_url, media_type, filename, metadata, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (url) DO UPDATE SET 
        download_url = $2, media_type = $3, filename = $4, metadata = $5, 
        status = $6, last_accessed = CURRENT_TIMESTAMP
    `, [url, data.downloadUrl, data.type, data.filename, JSON.stringify(metadata), 'success']);
    
    await logAction('download_saved', 'download', null, 'system', { url, type: data.type });
    return true;
  } catch (err) {
    console.error('Erro ao salvar:', err.message);
    return null;
  }
}

// 5. ANALYTICS
async function getAnalytics(period = '7 days') {
  if (!pool) return null;
  try {
    const downloads = await pool.query(`
      SELECT 
        DATE_TRUNC('day', created_at) as dia,
        media_type,
        COUNT(*) as total
      FROM downloads 
      WHERE created_at > NOW() - INTERVAL '${period}'
      GROUP BY DATE_TRUNC('day', created_at), media_type
      ORDER BY dia DESC
    `);
    
    const topContent = await pool.query(`
      SELECT url, media_type, COUNT(*) as downloads
      FROM downloads 
      WHERE status = 'success'
      GROUP BY url, media_type
      ORDER BY downloads DESC
      LIMIT 10
    `);
    
    return {
      downloads_by_day: downloads.rows,
      top_content: topContent.rows
    };
  } catch (err) {
    console.error('Erro analytics:', err.message);
    return null;
  }
}

// ==========================================
// EXTRATOR DO INSTAGRAM
// ==========================================
async function extractInstagramData(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000
  });
  
  const $ = cheerio.load(response.data);
  let mediaUrl = '', type = 'image';
  
  $('meta').each((i, tag) => {
    const property = $(tag).attr('property');
    const content = $(tag).attr('content');
    if (property === 'og:video') { mediaUrl = content; type = 'video'; }
    else if (property === 'og:image' && !mediaUrl) { mediaUrl = content; }
  });
  
  if (!mediaUrl) throw new Error('Mídia não encontrada');
  
  return {
    type: type,
    downloadUrl: mediaUrl,
    filename: `instagram_${Date.now()}.${type === 'video' ? 'mp4' : 'jpg'}`
  };
}

// ==========================================
// ENDPOINTS
// ==========================================

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    db: pool ? 'connected' : 'disconnected'
  });
});

app.get('/', async (req, res) => {
  const analytics = await getAnalytics('7 days');
  res.json({ 
    status: 'online', 
    memory: 'PostgreSQL persistente',
    analytics: analytics || 'indisponível'
  });
});

// Download com memória
app.post('/igdl', async (req, res) => {
  try {
    const { url, user_key = 'default', force_refresh = false, session_key } = req.body;
    
    if (!url?.includes('instagram.com')) {
      return res.status(400).json({ error: 'URL inválida' });
    }

    // Salva sessão se fornecida
    if (session_key) {
      await saveSession(session_key, user_key, { last_action: 'download' }, url);
    }

    // Verifica cache
    if (!force_refresh) {
      const existing = await checkExistingDownload(url);
      if (existing) {
        return res.json({ 
          success: true, 
          cached: true, 
          message: 'Retornado da memória persistente',
          data: existing 
        });
      }
    }

    // Busca e salva
    const result = await extractInstagramData(url);
    await saveDownload(url, result, { user_key, session_key });
    
    res.json({ 
      success: true, 
      cached: false,
      saved_to_memory: true,
      data: result 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Histórico
app.get('/history', async (req, res) => {
  if (!pool) return res.json({ downloads: [] });
  try {
    const result = await pool.query(
      'SELECT * FROM downloads ORDER BY last_accessed DESC LIMIT 20'
    );
    res.json({ downloads: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics
app.get('/analytics', async (req, res) => {
  const { period = '7 days' } = req.query;
  const analytics = await getAnalytics(period);
  res.json(analytics || { error: 'Analytics indisponível' });
});

// Sessões
app.post('/session', async (req, res) => {
  const { session_key, user_id, context, last_message } = req.body;
  const saved = await saveSession(session_key, user_id, context, last_message);
  res.json({ success: !!saved });
});

app.get('/session/:key', async (req, res) => {
  const session = await getSession(req.params.key);
  res.json(session || { error: 'Sessão não encontrada' });
});

// Preferências
app.post('/preference', async (req, res) => {
  const { user_key = 'default', name, value } = req.body;
  const saved = await savePreference(user_key, name, value);
  res.json({ success: !!saved });
});

app.get('/preference', async (req, res) => {
  const { user_key = 'default', name } = req.query;
  const value = await getPreference(user_key, name);
  res.json({ user_key, name, value });
});

// ==========================================
// INICIALIZAÇÃO
// ==========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API com MEMÓRIA PERSISTENTE rodando na porta ${PORT}`);
  console.log(`💾 PostgreSQL: ${pool ? 'Conectado' : 'Desconectado'}`);
  console.log(`🔧 Endpoints:`);
  console.log(`   POST /igdl         - Download com cache`);
  console.log(`   GET  /history      - Histórico`);
  console.log(`   GET  /analytics    - Estatísticas`);
  console.log(`   POST /session      - Salvar sessão`);
  console.log(`   POST /preference   - Salvar preferência`);
});
