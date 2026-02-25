const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck IMEDIATO (antes de tudo)
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    memory: dbConnected ? 'PostgreSQL connected' : 'PostgreSQL disconnected',
    timestamp: new Date().toISOString()
  });
});

// Configuração do PostgreSQL
let dbConnected = false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000
});

// Inicialização do banco (não bloqueia o servidor)
async function initDB() {
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
    console.log('✅ Banco de dados conectado');
  } catch (err) {
    console.error('❌ Erro DB (continuando sem cache):', err.message);
    dbConnected = false;
  }
}

// Verificar cache
async function checkExistingDownload(url) {
  if (!dbConnected) return null;
  try {
    const result = await pool.query(
      'SELECT * FROM downloads WHERE url = $1 AND status = $2',
      [url, 'success']
    );
    if (result.rows.length > 0) {
      await pool.query('UPDATE downloads SET last_accessed = CURRENT_TIMESTAMP WHERE id = $1', [result.rows[0].id]);
      return result.rows[0];
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Salvar download
async function saveDownload(url, data) {
  if (!dbConnected) return;
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

// Endpoints
app.post('/igdl', async (req, res) => {
  try {
    const { url, force_refresh = false } = req.body;
    if (!url?.includes('instagram.com')) return res.status(400).json({ error: 'URL inválida' });

    if (!force_refresh && dbConnected) {
      const existing = await checkExistingDownload(url);
      if (existing) {
        return res.json({ success: true, cached: true, data: existing });
      }
    }

    const result = await extractInstagramData(url);
    await saveDownload(url, result);
    
    res.json({ success: true, cached: false, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/history', async (req, res) => {
  if (!dbConnected) return res.json({ error: 'Banco desconectado', downloads: [] });
  const result = await pool.query('SELECT * FROM downloads ORDER BY last_accessed DESC LIMIT 10');
  res.json({ downloads: result.rows });
});

// INICIA SERVIDOR IMEDIATAMENTE
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
  // Tenta conectar no DB depois de iniciar
  initDB();
});
