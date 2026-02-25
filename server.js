const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DO BANCO (com fallback)
// ==========================================
let pool = null;
let dbConnected = false;

try {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    console.log('📊 Tentando conectar ao PostgreSQL...');
  } else {
    console.log('⚠️  DATABASE_URL não definida - rodando sem banco');
  }
} catch (err) {
  console.error('❌ Erro ao criar pool:', err.message);
}

// Inicialização do banco (assíncrona, não bloqueia)
async function initDB() {
  if (!pool) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS downloads (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        download_url TEXT,
        media_type VARCHAR(10),
        filename TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    dbConnected = true;
    console.log('✅ Banco de dados conectado e inicializado');
  } catch (err) {
    console.error('❌ Erro DB:', err.message);
    dbConnected = false;
  }
}

// Verificar cache
async function checkExistingDownload(url) {
  if (!dbConnected || !pool) return null;
  
  try {
    const result = await pool.query(
      'SELECT * FROM downloads WHERE url = $1 AND status = $2',
      [url, 'success']
    );
    if (result.rows.length > 0) {
      await pool.query('UPDATE downloads SET last_accessed = CURRENT_TIMESTAMP WHERE id = $1', [result.rows[0].id]);
      return result.rows[0];
    }
  } catch (err) {
    console.error('Erro ao verificar cache:', err.message);
  }
  return null;
}

// Salvar download
async function saveDownload(url, data) {
  if (!dbConnected || !pool) return;
  
  try {
    await pool.query(`
      INSERT INTO downloads (url, download_url, media_type, filename, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (url) DO UPDATE SET 
        download_url = $2, media_type = $3, filename = $4, status = $5, last_accessed = CURRENT_TIMESTAMP
    `, [url, data.downloadUrl, data.type, data.filename, 'success']);
  } catch (err) {
    console.error('Erro ao salvar:', err.message);
  }
}

// Extrair do Instagram
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
// ENDPOINTS (respondem imediatamente!)
// ==========================================

// ✅ HEALTHCHECK - responde IMEDIATAMENTE, sem depender do banco
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    db: dbConnected ? 'connected' : 'connecting'
  });
});

// Status geral
app.get('/', async (req, res) => {
  try {
    if (!dbConnected || !pool) {
      return res.json({ 
        status: 'online', 
        db: 'connecting',
        message: 'API online, banco inicializando...'
      });
    }
    const stats = await pool.query('SELECT COUNT(*) as total FROM downloads WHERE status=$1', ['success']);
    res.json({ 
      status: 'online', 
      memory: 'PostgreSQL', 
      db: 'connected',
      total_downloads: stats.rows[0].total 
    });
  } catch (err) {
    res.json({ 
      status: 'online', 
      db: 'error', 
      error: err.message 
    });
  }
});

// Download com cache
app.post('/igdl', async (req, res) => {
  try {
    const { url, force_refresh = false } = req.body;
    if (!url?.includes('instagram.com')) {
      return res.status(400).json({ error: 'URL inválida' });
    }

    // Só usa cache se banco estiver conectado
    if (!force_refresh && dbConnected) {
      const existing = await checkExistingDownload(url);
      if (existing) {
        return res.json({ success: true, cached: true, data: existing });
      }
    }

    const result = await extractInstagramData(url);
    
    // Só salva se banco estiver conectado
    if (dbConnected) {
      await saveDownload(url, result);
    }
    
    res.json({ 
      success: true, 
      cached: false, 
      db_saved: dbConnected,
      data: result 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Histórico
app.get('/history', async (req, res) => {
  if (!dbConnected || !pool) {
    return res.json({ downloads: [], message: 'Banco ainda inicializando' });
  }
  
  try {
    const result = await pool.query('SELECT * FROM downloads ORDER BY last_accessed DESC LIMIT 10');
    res.json({ downloads: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// INICIALIZAÇÃO (servidor primeiro!)
// ==========================================
const PORT = process.env.PORT || 3000;

// Inicia servidor IMEDIATAMENTE (para healthcheck passar)
app.listen(PORT, () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
  console.log('⏳ Inicializando banco de dados...');
  
  // Depois tenta conectar ao banco (não bloqueia)
  initDB().then(() => {
    if (dbConnected) {
      console.log('✅ Banco pronto!');
    } else {
      console.log('⚠️  Banco indisponível, API funciona sem cache');
    }
  });
});

Commit message: Fix: Adiciona endpoint /health

