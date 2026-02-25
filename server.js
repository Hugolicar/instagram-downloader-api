const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck IMEDIATO (sempre funciona)
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    db: dbConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// PostgreSQL (só carrega se tiver DATABASE_URL)
let dbConnected = false;
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000
    });
    
    // Testa conexão em background (não bloqueia)
    pool.query('SELECT NOW()')
      .then(() => {
        dbConnected = true;
        console.log('✅ DB connected');
        initDB();
      })
      .catch(err => {
        console.log('⚠️ DB not available:', err.message);
      });
      
  } catch (err) {
    console.log('⚠️ PG module error:', err.message);
  }
}

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
    console.log('✅ Table ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

// Endpoints principais
app.post('/igdl', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url?.includes('instagram.com')) {
      return res.status(400).json({ error: 'URL inválida' });
    }

    // Simula download (volta com código real depois)
    res.json({ 
      success: true, 
      message: 'Endpoint funcionando!',
      url: url,
      db_status: dbConnected ? 'com cache' : 'sem cache (DB offline)'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/history', (req, res) => {
  if (!dbConnected) return res.json({ downloads: [], note: 'DB offline' });
  res.json({ downloads: [], note: 'DB conectado - implementar query' });
});

// Inicia servidor IMEDIATAMENTE
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API rodando na porta ${PORT}`);
  console.log(`📊 DB: ${dbConnected ? 'Conectado' : 'Aguardando...'}`);
});
