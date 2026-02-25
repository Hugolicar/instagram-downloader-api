# Instagram Downloader API com Memória

API para download de Instagram com PostgreSQL (cache inteligente)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/YOUR_TEMPLATE_ID)

## Endpoints

- `POST /igdl` - Baixa post (com cache automático)
- `GET /history` - Histórico de downloads

## Variáveis de Ambiente

O Railway preenche automaticamente:
- `DATABASE_URL` - PostgreSQL
- `PORT` - Porta da aplicação
