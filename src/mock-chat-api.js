import * as http from 'node:http';

export class MockChatApiServer {
  constructor(port = 8080, customGenerator = null) {
    this.port = port;
    this.messages = [];
    this.generatorHandler =
      customGenerator ||
      ((msgs) => {
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.role === 'user') {
          return 'I will inspect the workspace.\n```bash\nGet-ChildItem\n```';
        }
        return 'Task complete.\n```finish\nTask accomplished successfully.\n```';
      });

    this.server = http.createServer(async (req, res) => {
      const url = req.url?.split('?')[0] || '';
      const method = (req.method || 'GET').toUpperCase();

      const sendJson = (statusCode, data) => {
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify(data));
      };

      const readBody = async () => {
        return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            if (!body) return resolve({});
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Invalid JSON payload'));
            }
          });
          req.on('error', reject);
        });
      };

      try {
        if (method === 'POST' && url === '/chat/message') {
          const body = await readBody();
          const incoming = Array.isArray(body)
            ? body
            : Array.isArray(body.messages)
            ? body.messages
            : body.message
            ? [body.message]
            : [];

          if (incoming.length === 0) {
            return sendJson(400, { error: 'No messages provided in body' });
          }

          this.messages.push(...incoming);
          return sendJson(200, {
            success: true,
            receivedCount: incoming.length,
            totalMessages: this.messages.length,
          });
        }

        if (method === 'GET' && url === '/chat/messages') {
          return sendJson(200, {
            messages: [...this.messages],
            count: this.messages.length,
          });
        }

        if (method === 'POST' && url === '/chat/generate') {
          const body = await readBody();
          const temperature = body.temperature ?? 0.2;
          const responseText = await this.generatorHandler(this.messages, temperature);

          this.messages.push({
            role: 'assistant',
            content: responseText,
          });

          return sendJson(200, {
            content: responseText,
            reply: responseText,
            totalMessages: this.messages.length,
          });
        }

        if (method === 'DELETE' && url === '/chat/messages') {
          this.clearMessages();
          return sendJson(200, { success: true, message: 'Messages cleared' });
        }

        return sendJson(404, { error: `Not found: ${method} ${url}` });
      } catch (err) {
        return sendJson(500, { error: err.message });
      }
    });
  }

  setGenerator(handler) {
    this.generatorHandler = handler;
  }

  getMessages() {
    return [...this.messages];
  }

  clearMessages() {
    this.messages = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        resolve(actualPort);
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      try {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
      } catch {}
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPort() {
    return this.port;
  }
}
