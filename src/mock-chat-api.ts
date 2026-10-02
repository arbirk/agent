import * as http from 'http';
import { ChatMessage } from './types.js';

export type MockGeneratorHandler = (messages: ChatMessage[], temperature?: number) => string | Promise<string>;

export class MockChatApiServer {
  private server: http.Server;
  private messages: ChatMessage[] = [];
  private generatorHandler: MockGeneratorHandler;
  private port: number;

  constructor(
    port: number = 8080,
    customGenerator?: MockGeneratorHandler
  ) {
    this.port = port;
    this.generatorHandler =
      customGenerator ||
      ((msgs) => {
        // Default smart mock response: if initial user message, inspect workspace
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg?.role === 'user') {
          return 'I will inspect the workspace.\n```bash\nGet-ChildItem\n```';
        }
        return 'Task complete.\n```finish\nTask accomplished successfully.\n```';
      });

    this.server = http.createServer(async (req, res) => {
      const url = req.url?.split('?')[0] || '';
      const method = (req.method || 'GET').toUpperCase();

      const sendJson = (statusCode: number, data: any) => {
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Connection': 'close',
        });
        res.end(JSON.stringify(data));
      };

      const readBody = async (): Promise<any> => {
        return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            if (!body) return resolve({});
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error('Invalid JSON payload'));
            }
          });
          req.on('error', reject);
        });
      };

      try {
        // 1. POST /chat/message <- post messages
        if (method === 'POST' && url === '/chat/message') {
          const body = await readBody();
          const incoming: ChatMessage[] = Array.isArray(body)
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

        // 2. GET /chat/messages <- get the messages
        if (method === 'GET' && url === '/chat/messages') {
          return sendJson(200, {
            messages: [...this.messages],
            count: this.messages.length,
          });
        }

        // 3. POST /chat/generate <- trigger generation on the messages
        if (method === 'POST' && url === '/chat/generate') {
          const body = await readBody();
          const temperature = body.temperature ?? 0.2;

          const responseText = await this.generatorHandler(this.messages, temperature);

          // Append generated assistant response to message history
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: responseText,
          };
          this.messages.push(assistantMsg);

          return sendJson(200, {
            content: responseText,
            reply: responseText,
            totalMessages: this.messages.length,
          });
        }

        // 4. DELETE /chat/messages (Utility to clear messages during testing)
        if (method === 'DELETE' && url === '/chat/messages') {
          this.clearMessages();
          return sendJson(200, { success: true, message: 'Messages cleared' });
        }

        return sendJson(404, { error: `Not found: ${method} ${url}` });
      } catch (err: any) {
        return sendJson(500, { error: err.message });
      }
    });
  }

  public setGenerator(handler: MockGeneratorHandler): void {
    this.generatorHandler = handler;
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public clearMessages(): void {
    this.messages = [];
  }

  public start(): Promise<number> {
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

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
      } catch {}
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public getPort(): number {
    return this.port;
  }
}


