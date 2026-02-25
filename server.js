const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck (sempre disponível)
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    db: dbConnected ? 'connected' : 'disconnected',
    service: 'instagram-downloader-memory',
    timestamp: new Date().toISOString()
  });
});

// PostgreSQL setup
let dbConnected = false;
let pool = null;

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ No DATABASE_URL found');
    return;
  }
  
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    // Testa conexão
    await pool.query('SELECT NOW()');
    dbConnected = true;
    console.log('✅ PostgreSQL connected');
    
    // Cria tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS downloads (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        download_url TEXT NOT NULL,
        media_type VARCHAR(10) NOT NULL,
        filename TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database table ready');
    
  } catch (err) {
    console.error('❌ Database error:', err.message);
    dbConnected = false;
  }
}

// Funções de cache
async function getCachedDownload(url) {
  if (!dbConnected || !pool) return null;
  try {
    const result = await pool.query(
      'SELECT * FROM downloads WHERE url = $1',
      [url]
    );
    if (result.rows.length > 0) {
      // Atualiza último acesso
      await pool.query(
        'UPDATE downloads SET last_accessed = CURRENT_TIMESTAMP WHERE id = $1',
        [result.rows[0].id]
      );
      return result.rows[0];
    }
    return null;
  } catch (err) {
    console.error('Cache read error:', err.message);
    return null;
  }
}

async function saveDownload(url, data) {
  if (!dbConnected || !pool) return;
  try {
    await pool.query(`
      INSERT INTO downloads (url, download_url, media_type, filename)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (url) 
      DO UPDATE SET download_url = $2, media_type = $3, filename = $4, last_accessed = CURRENT_TIMESTAMP
    `, [url, data.downloadUrl, data.type, data.filename]);
  } catch (err) {
    console.error('Cache save error:', err.message);
  }
}

// Extrair mídia do Instagram
async function extractInstagramData(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      timeout: 15000
    });
    
    const $ = cheerio.load(response.data);
    let mediaUrl = '';
    let type = 'image';
    let caption = '';
    
    // Procura meta tags
    $('meta').each((i, tag) => {
      const property = $(tag).attr('property');
      const content = $(tag).attr('content');
      
      if (property === 'og:video' || property === 'og:video:secure_url') {
        mediaUrl = content;
        type = 'video';
      } else if (property === 'og:image' && !mediaUrl) {
        mediaUrl = content;
      } else if (property === 'og:description') {
        caption = content;
      }
    });
    
    // Fallback para JSON-LD
    if (!mediaUrl) {
      $('script[type="application/ld+json"]').each((i, tag) => {
        try {
          const json = JSON.parse($(tag).html());
          if (json.video && json.video.contentUrl) {
            mediaUrl = json.video.contentUrl;
            type = 'video';
          } else if (json.image && !mediaUrl) {
            mediaUrl = json.image;
          }
        } catch (e) {}
      });
    }
    
    if (!mediaUrl) {
      throw new Error('Não foi possível extrair a mídia. O post pode ser privado ou não existir.');
    }
    
    return {
      type: type,
      downloadUrl: mediaUrl,
      caption: caption ? caption.substring(0, 200) : null,
      filename: `instagram_${Date.now()}.${type === 'video' ? 'mp4' : 'jpg'}`
    };
    
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error('Post não encontrado (404)');
    }
    throw new Error(`Erro na extração: ${error.message}`);
  }
}

// Endpoint principal
app.post('/igdl', async (req, res) => {
  try {
    const { url, force_refresh = false } = req.body;
    
    if (!url || (!url.includes('instagram.com') && !url.includes('instagr.am'))) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL inválida. Use um link do Instagram.' 
      });
    }

    // Verifica cache primeiro (se não for forçado)
    if (!force_refresh && dbConnected) {
      const cached = await getCachedDownload(url);
      if (cached) {
        return res.json({
          success: true,
          cached: true,
          message: 'Retornado do cache (já baixado anteriormente)',
          data: {
            url: cached.url,
            download_url: cached.download_url,
            type: cached.media_type,
            filename: cached.filename,
            first_downloaded: cached.created_at
          }
        });
      }
    }

    // Faz download novo
    console.log(`🆕 Baixando: ${url}`);
    const result = await extractInstagramData(url);
    
    // Salva no cache
    await saveDownload(url, result);
    
    res.json({
      success: true,
      cached: false,
      message: 'Download realizado com sucesso',
      data: {
        url: url,
        download_url: result.downloadUrl,
        type: result.type,
        filename: result.filename,
        caption: result.caption
      }
    });

  } catch (error) {
    console.error('Erro:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// GET version (para compatibilidade)
app.get('/igdl', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Forneça a URL via query param: ?url=...' });
  }
  req.body = { url, force_refresh: false };
  // Reusa a lógica do POST
  try {
    const cached = await getCachedDownload(url);
    if (cached) {
      return res.json({ success: true, cached: true, data: cached });
    }
    const result = await extractInstagramData(url);
    await saveDownload(url, result);
    res.json({ success: true, cached: false, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Histórico
app.get('/history', async (req, res) => {
  try {
    if (!dbConnected || !pool) {
      return res.json({ 
        success: false,
        error: 'Banco de dados não conectado',
        downloads: [] 
      });
    }
    
    const limit = parseInt(req.query.limit) || 10;
    const result = await pool.query(
      'SELECT url, media_type, filename, download_url, created_at, last_accessed FROM downloads ORDER BY last_accessed DESC LIMIT $1',
      [limit]
    );
    
    res.json({
      success: true,
      total: result.rows.length,
      downloads: result.rows.map(row => ({
        url: row.url,
        type: row.media_type,
        filename: row.filename,
        download_link: row.download_url,
        first_downloaded: row.created_at,
        last_accessed: row.last_accessed
      }))
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message,
      downloads: [] 
    });
  }
});

// Inicia servidor
const PORT = process.env.PORT || 3000;

// Inicia DB em background (não bloqueia)
initDatabase();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API Instagram com Memória rodando na porta ${PORT}`);
  console.log(`📊 Banco: ${dbConnected ? '✅ Conectado' : '⚠️ Desconectado'}`);
});
