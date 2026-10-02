import { ChatMessage, AgentConfig } from './types.js';
import { LlmAdapter, OpenAiLlmAdapter, RestChatApiAdapter, enforceSeparate4kMessages } from './llm-adapter.js';
import { getCompressionPrompt } from './prompt.js';

export class LlmClient {
  private adapter: LlmAdapter;
  private config: AgentConfig;

  constructor(config: AgentConfig, customAdapter?: LlmAdapter) {
    this.config = config;
    this.adapter = customAdapter || new OpenAiLlmAdapter(config);
  }

  public getAdapter(): LlmAdapter {
    return this.adapter;
  }

  public setAdapter(adapter: LlmAdapter): void {
    this.adapter = adapter;
  }

  /**
   * Appends an event object as a JSON line to the debug log file
   */
  public logDebug(entry: Record<string, any>): void {
    if (this.adapter instanceof OpenAiLlmAdapter) {
      this.adapter.logDebug(entry);
    }
  }

  /**
   * Performs chat completion without combining distinct system/user messages.
   * Splits harness, AGENTS.md, and current loop messages in separate messages,
   * each enforced at max 4000 tokens.
   */
  public async complete(
    messages: ChatMessage[],
    temperature: number = 0.2
  ): Promise<string> {
    const formatted = enforceSeparate4kMessages(messages, 4000);
    return this.adapter.complete(formatted, temperature);
  }

  /**
   * Prompts the LLM to compress a long conversation history into a concise summary
   */
  public async compressHistory(history: ChatMessage[]): Promise<string> {
    if (this.adapter.compressHistory) {
      return this.adapter.compressHistory(history);
    }

    const summaryMessages: ChatMessage[] = [
      {
        role: 'system',
        content: getCompressionPrompt(),
      },
      {
        role: 'user',
        content:
          `Here is the conversation history to condense:\n\n` +
          history.map((m) => `[${m.role.toUpperCase()}]:\n${m.content}`).join('\n\n---\n\n'),
      },
    ];

    return this.complete(summaryMessages, 0.1);
  }
}
