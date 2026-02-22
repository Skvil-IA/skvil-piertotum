#!/usr/bin/env node

/**
 * Skvil-Piertotum Broker — Servidor HTTP central
 *
 * Este servidor roda na sua rede e gerencia a comunicação
 * entre múltiplas instâncias do Claude Code via MCP.
 *
 * Uso: node broker.js [porta]
 * Padrão: porta 4800
 */

import express from 'express';
import readline from 'readline';

// ══════════════════════════════════════════════
// Handlers globais de erro
// uncaughtException: loga o stack completo e sai — continuar após
// uma exceção não capturada deixa o processo em estado indefinido.
// Deixe o process manager (systemd, Docker, PM2) reiniciar.
// ══════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Exceção não capturada:\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Promise rejeitada sem handler: ${reason instanceof Error ? reason.stack : reason}`);
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.BROKER_PORT || process.argv[2] || 4800;

// ══════════════════════════════════════════════
// Limites de recursos
// ══════════════════════════════════════════════

const MAX_MESSAGES_PER_AGENT    = 200;
const MAX_AGENTS                = 100;
const MAX_CONTEXT_KEYS          = 1000;
const MAX_CONTEXT_VALUE_SIZE    = 100 * 1024; // 100 KB
const MAX_MESSAGE_CONTENT_SIZE  = 512 * 1024; // 512 KB por mensagem
const STALE_AGENT_THRESHOLD_MS  = 90_000;    // 3 heartbeats perdidos (heartbeat = 30s)

// ══════════════════════════════════════════════
// Estado em memória
// ══════════════════════════════════════════════

const agents        = new Map(); // agentId -> { name, project, path, registeredAt, lastSeen }
const messages      = new Map(); // agentId -> [ { id, from, fromName, content, type, timestamp, read } ]
const sharedContext = new Map(); // key -> { value, setBy, setByName, timestamp }

// ══════════════════════════════════════════════
// Console interativo — intercepta console.log/error/warn
// para não sobrescrever o prompt do readline
// ══════════════════════════════════════════════

let rl = null;
const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

const _rlWrite = (fn, args) => {
  if (rl) process.stdout.write('\r\x1b[K');
  fn(...args);
  if (rl) rl.prompt(true);
};

console.log   = (...args) => _rlWrite(_log, args);
console.error = (...args) => _rlWrite(_error, args);
console.warn  = (...args) => _rlWrite(_warn, args);

// ══════════════════════════════════════════════
// Helper: enfileira mensagem com cap automático
// Usado por todos os paths de envio para garantir
// que o limite de 200 mensagens seja sempre aplicado.
// ══════════════════════════════════════════════

function enqueue(agentId, msg) {
  if (!messages.has(agentId)) messages.set(agentId, []);
  const queue = messages.get(agentId);
  queue.push(msg);
  if (queue.length > MAX_MESSAGES_PER_AGENT) {
    const dropped = queue.length - MAX_MESSAGES_PER_AGENT;
    queue.splice(0, dropped);
    console.log(`  ⚠️  Fila de "${agentId}" cheia — ${dropped} mensagem(ns) antiga(s) descartada(s)`);
  }
}

// ══════════════════════════════════════════════
// Middleware de log
// ══════════════════════════════════════════════

app.use((req, res, next) => {
  // Silencia polling de alta frequência (heartbeats e leitura de mensagens)
  const isPolling =
    (req.method === 'GET'  && req.path.startsWith('/messages/')) ||
    (req.method === 'POST' && req.path.endsWith('/heartbeat'));
  if (!isPolling) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    console.log(`[${ts}] ${req.method} ${req.path}`);
  }
  next();
});

// ══════════════════════════════════════════════
// Rotas: Registro de Agentes
// ══════════════════════════════════════════════

app.post('/agents/register', (req, res) => {
  const { agentId, name, project, path } = req.body;
  if (!agentId || !name) {
    return res.status(400).json({ error: 'agentId e name são obrigatórios' });
  }

  if (!agents.has(agentId) && agents.size >= MAX_AGENTS) {
    return res.status(429).json({ error: `Limite de ${MAX_AGENTS} agentes atingido` });
  }

  agents.set(agentId, {
    name,
    project: project || 'unknown',
    path: path || '',
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });

  if (!messages.has(agentId)) {
    messages.set(agentId, []);
  }

  console.log(`  ✅ Agente registrado: ${name} (${agentId}) — projeto: ${project || 'N/A'}`);
  res.json({ ok: true, agentId, totalAgents: agents.size });
});

app.get('/agents', (req, res) => {
  const list = [];
  for (const [id, info] of agents) {
    list.push({ agentId: id, ...info });
  }
  res.json({ agents: list });
});

app.post('/agents/:agentId/heartbeat', (req, res) => {
  const agent = agents.get(req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agente não registrado' });
  }
  agent.lastSeen = new Date().toISOString();
  res.json({ ok: true });
});

app.delete('/agents/:agentId', (req, res) => {
  const existed = agents.has(req.params.agentId);
  agents.delete(req.params.agentId);
  messages.delete(req.params.agentId);
  if (existed) {
    console.log(`  ❌ Agente removido: ${req.params.agentId}`);
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// Rotas: Limpeza de mensagens
// ══════════════════════════════════════════════

app.delete('/messages/:agentId', (req, res) => {
  const queue = messages.get(req.params.agentId);
  if (!queue) {
    return res.status(404).json({ error: 'Agente não encontrado' });
  }
  const cleared = queue.length;
  queue.length = 0;
  console.log(`  🗑️  Mensagens limpas: ${req.params.agentId} (${cleared} removida(s))`);
  res.json({ ok: true, cleared });
});

// ══════════════════════════════════════════════
// Rotas: Mensagens diretas
// ══════════════════════════════════════════════

const VALID_MSG_TYPES = new Set(['text', 'code', 'schema', 'endpoint', 'config']);

app.post('/messages/send', (req, res) => {
  const { from, to, content, type } = req.body;
  if (!from || !to || !content) {
    return res.status(400).json({ error: 'from, to e content são obrigatórios' });
  }

  if (!agents.has(from) && from !== 'broker') {
    return res.status(400).json({ error: `Remetente "${from}" não registrado. Registre-se antes de enviar mensagens.` });
  }

  if (!agents.has(to)) {
    return res.status(404).json({ error: `Agente "${to}" não encontrado` });
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_CONTENT_SIZE) {
    return res.status(413).json({ error: `Conteúdo excede o limite de ${MAX_MESSAGE_CONTENT_SIZE / 1024}KB por mensagem` });
  }

  const msgType = VALID_MSG_TYPES.has(type) ? type : 'text';

  const msg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from,
    fromName: agents.get(from)?.name || from,
    content,
    type: msgType,
    timestamp: new Date().toISOString(),
    read: false
  };

  enqueue(to, msg);
  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
  console.log(`  💬 ${msg.fromName} → ${agents.get(to)?.name || to}: ${preview}`);
  res.json({ ok: true, messageId: msg.id });
});

// Broadcast — enviar para todos os agentes (exceto o remetente)
app.post('/messages/broadcast', (req, res) => {
  const { from, content, type } = req.body;
  if (!from || !content) {
    return res.status(400).json({ error: 'from e content são obrigatórios' });
  }

  if (!agents.has(from) && from !== 'broker') {
    return res.status(400).json({ error: `Remetente "${from}" não registrado. Registre-se antes de enviar mensagens.` });
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_MESSAGE_CONTENT_SIZE) {
    return res.status(413).json({ error: `Conteúdo excede o limite de ${MAX_MESSAGE_CONTENT_SIZE / 1024}KB por mensagem` });
  }

  const msgType = VALID_MSG_TYPES.has(type) ? type : 'text';
  let count = 0;

  for (const [agentId] of agents) {
    if (agentId === from) continue;
    enqueue(agentId, {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from,
      fromName: agents.get(from)?.name || from,
      content,
      type: msgType,
      timestamp: new Date().toISOString(),
      read: false
    });
    count++;
  }

  console.log(`  📢 Broadcast de ${agents.get(from)?.name || from} para ${count} agentes`);
  res.json({ ok: true, sentTo: count });
});

// Ler mensagens de um agente
// ?unread=true → apenas não lidas | ?limit=N → máximo N mensagens
// Não marca como lidas — use POST /messages/:agentId/ack para confirmar recebimento.
app.get('/messages/:agentId', (req, res) => {
  const queue = messages.get(req.params.agentId) || [];
  const unreadOnly = req.query.unread === 'true';
  const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit, 10) || 50) : null;

  const filtered = unreadOnly ? queue.filter(m => !m.read) : [...queue];
  const hasMore  = limit !== null && filtered.length > limit;
  const result   = limit !== null ? filtered.slice(0, limit) : filtered;

  res.json({ messages: result, total: result.length, hasMore });
});

// ACK — marca mensagens específicas como lidas
app.post('/messages/:agentId/ack', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids deve ser um array não-vazio de message IDs' });
  }
  const queue = messages.get(req.params.agentId) || [];
  const idSet  = new Set(ids);
  let acked = 0;
  for (const msg of queue) {
    if (idSet.has(msg.id)) { msg.read = true; acked++; }
  }
  res.json({ ok: true, acked });
});

// ══════════════════════════════════════════════
// Rotas: Contexto Compartilhado
// ══════════════════════════════════════════════

app.post('/context', (req, res) => {
  const { key, value, setBy } = req.body;
  if (!key || value === undefined || value === null) {
    return res.status(400).json({ error: 'key e value são obrigatórios' });
  }

  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONTEXT_VALUE_SIZE) {
    return res.status(413).json({ error: `Valor excede o limite de ${MAX_CONTEXT_VALUE_SIZE / 1024}KB` });
  }

  if (!sharedContext.has(key) && sharedContext.size >= MAX_CONTEXT_KEYS) {
    return res.status(429).json({ error: `Limite de ${MAX_CONTEXT_KEYS} chaves de contexto atingido` });
  }

  sharedContext.set(key, {
    value,
    setBy: setBy || 'unknown',
    setByName: agents.get(setBy)?.name || setBy,
    timestamp: new Date().toISOString()
  });

  console.log(`  📦 Contexto salvo: "${key}" por ${agents.get(setBy)?.name || setBy}`);
  res.json({ ok: true, key });
});

app.get('/context/:key', (req, res) => {
  const ctx = sharedContext.get(req.params.key);
  if (!ctx) {
    return res.status(404).json({ error: `Contexto "${req.params.key}" não encontrado` });
  }
  res.json(ctx);
});

app.get('/context', (req, res) => {
  const keys = [];
  for (const [key, info] of sharedContext) {
    keys.push({ key, setBy: info.setByName, timestamp: info.timestamp });
  }
  res.json({ contexts: keys });
});

app.delete('/context/:key', (req, res) => {
  sharedContext.delete(req.params.key);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// Rota: Status geral
// ══════════════════════════════════════════════

app.get('/status', (req, res) => {
  const agentList = [];
  for (const [id, info] of agents) {
    const unread = (messages.get(id) || []).filter(m => !m.read).length;
    agentList.push({ agentId: id, ...info, unreadMessages: unread });
  }

  res.json({
    broker: 'skvil-piertotum',
    uptime: process.uptime(),
    agents: agentList,
    totalAgents: agents.size,
    totalContextKeys: sharedContext.size
  });
});

// ══════════════════════════════════════════════
// 404 catch-all — retorna JSON em vez de HTML
// ══════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ══════════════════════════════════════════════
// Console interativo do operador
// ══════════════════════════════════════════════

function pushToAgent(agentId, content, type = 'text') {
  enqueue(agentId, {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    from: 'broker',
    fromName: 'Operador',
    content,
    type,
    timestamp: new Date().toISOString(),
    read: false
  });
}

function startConsole() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('broker> ');
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // /help
    if (input === '/help') {
      _log('  Comandos disponíveis:');
      _log('    /agents          — lista agentes conectados');
      _log('    /help            — esta ajuda');
      _log('    @<id> <mensagem> — envia para um agente específico');
      _log('    <mensagem>       — broadcast para todos os agentes');
      rl.prompt();
      return;
    }

    // /agents
    if (input === '/agents') {
      if (agents.size === 0) {
        _log('  Nenhum agente conectado.');
      } else {
        for (const [id, info] of agents) {
          _log(`  • ${info.name} (${id}) — ${info.project}`);
        }
      }
      rl.prompt();
      return;
    }

    // @agentId mensagem
    if (input.startsWith('@')) {
      const spaceIdx = input.indexOf(' ');
      if (spaceIdx === -1) {
        _log('  Uso: @<id> <mensagem>');
        rl.prompt();
        return;
      }
      const targetId = input.slice(1, spaceIdx);
      const content = input.slice(spaceIdx + 1).trim();
      if (!content) {
        _log('  Mensagem vazia.');
        rl.prompt();
        return;
      }
      if (!agents.has(targetId)) {
        _log(`  ❌ Agente "${targetId}" não encontrado. Use /agents para listar.`);
        rl.prompt();
        return;
      }
      pushToAgent(targetId, content);
      _log(`  💬 Operador → ${agents.get(targetId).name}: ${content}`);
      rl.prompt();
      return;
    }

    // broadcast
    if (agents.size === 0) {
      _log('  ⚠️  Nenhum agente conectado.');
      rl.prompt();
      return;
    }
    for (const [agentId] of agents) {
      pushToAgent(agentId, input);
    }
    _log(`  📢 Operador → ${agents.size} agente(s): ${input}`);
    rl.prompt();
  });

  rl.on('close', () => {
    _log('\n  Broker encerrado.');
    process.exit(0);
  });
}

// ══════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  🤖 Skvil-Piertotum Broker — Rodando!`);
  console.log(`  Endereço : http://0.0.0.0:${PORT}`);
  console.log(`  Status   : http://localhost:${PORT}/status`);
  console.log(`  Configure: BROKER_URL=http://<seu-ip>:${PORT}`);
  console.log('');
  console.log(`  Digite uma mensagem e pressione Enter para fazer broadcast.`);
  console.log(`  Use @<id> <mensagem> para falar com um agente específico.`);
  console.log(`  /agents lista os conectados. /help para ajuda completa.`);
  console.log('');

  // Reaper de agentes zumbis — remove agentes que pararam de enviar heartbeat
  setInterval(() => {
    const now = Date.now();
    for (const [id, info] of agents) {
      if (now - new Date(info.lastSeen).getTime() > STALE_AGENT_THRESHOLD_MS) {
        agents.delete(id);
        messages.delete(id);
        console.log(`  🕒 Agente removido por inatividade: ${info.name} (${id})`);
      }
    }
  }, 30_000);

  startConsole();
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    _error(`[ERRO] Porta ${PORT} já está em uso. Tente outra: node broker.js 5000`);
  } else if (err.code === 'EACCES') {
    _error(`[ERRO] Sem permissão para usar a porta ${PORT}.`);
  } else {
    _error(`[ERRO] Falha ao iniciar o servidor: ${err.message}`);
  }
  process.exit(1);
});

// ══════════════════════════════════════════════
// Shutdown gracioso (SIGTERM / SIGINT)
// ══════════════════════════════════════════════

const shutdown = () => {
  _log('\n  🛑 Broker encerrando...');
  if (rl) rl.close();
  httpServer.close(() => {
    _log('  Broker encerrado.');
    process.exit(0);
  });
  // Força saída se o servidor não fechar em 5s (conexões keep-alive pendentes)
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
