const express = require('express');
const app = express();

// Responde imediatamente em qualquer rota
app.get('/', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

app.get('/health', (req, res) => {
  res.json({ healthy: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Running on port ${PORT}`);
});
